import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import path from "node:path";
import { WorktreeManager } from "../runtime/worktree-manager.js";
import type { CheckoutLock, PlatformServices } from "../platform/platform-services.js";
import { getPlatformServices } from "../platform/select-platform.js";
import type { VerificationCommand } from "../protocol/delegation-spec.js";
import { appliesToPlatform, executeCommand, resolveCommandCwd, scanCommandMutations } from "./project-verifier.js";
import { linkPrimaryDependencies, type DependencyLink } from "./dependency-link.js";
import type { ArtifactStore } from "../runtime/artifact-store.js";
import { boundedRedactedDiagnostic } from "../runtime/redaction.js";
import { logger } from "../util/logger.js";
import { isMissing } from "../util/errors.js";

export interface BaselineCommandResult {
  id: string;
  exitCode: number | null;
  ok: boolean;
  /** Archived output, so a baseline failure can be diagnosed without a rerun. */
  stdoutRef?: string;
  stderrRef?: string;
  classification?: "no-tests-collected";
  mutation?: { records: string[]; headChanged: boolean };
}

export interface BaselineReport {
  baselineCommitOid: string;
  commands: BaselineCommandResult[];
  dependencyLink: DependencyLink;
  /**
   * Set when the disposable verification worktree could not be torn down
   * *after* baseline verification already produced this terminal
   * classification (observed with a large `node_modules` tree exceeding the
   * removal timeout). This is a secondary environment-cleanup defect and
   * must never replace or suppress `commands`/`dependencyLink` — see the
   * caller in `verifyBaseline()`.
   */
  cleanupIssue?: string;
}

export interface BaselineVerifyArgs {
  repoRoot: string;
  headCommitOid: string;
  commands: VerificationCommand[];
  ps?: PlatformServices;
  arch?: string;
  now?: () => number;
  runId?: string;
  verificationId?: () => string;
  abortSignal?: AbortSignal;
  borrowedCheckoutLease?: CheckoutLock;
  /** When present, each command's output is archived for post-hoc diagnosis. */
  store?: Pick<ArtifactStore, "writeLog">;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw new DOMException("Baseline verification was cancelled", "AbortError");
}

function executableName(value: string): string {
  return basename(value).toLowerCase().replace(/\.(?:cmd|exe|mjs|cjs|js)$/u, "");
}

/**
 * Resolves the first positional argument AND where it sits. Callers need the
 * index to keep scanning after it: `args.indexOf(value)` finds the first token
 * equal to that string, which may be an option's VALUE earlier in the array
 * (`npm --registry run run`), and slicing from there reads the wrong argument.
 */
function firstPositional(args: string[]): { value: string; index: number } | undefined {
  const optionsWithValues = new Set([
    "--call", "--conditions", "--eval", "--import", "--loader", "--package", "--registry",
    "--require", "-c", "-e", "-p", "-r",
  ]);
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === "--") {
      const value = args[index + 1];
      return value === undefined ? undefined : { value, index: index + 1 };
    }
    if (optionsWithValues.has(argument)) {
      index += 1;
      continue;
    }
    if (!argument.startsWith("-")) return { value: argument, index };
  }
  return undefined;
}

function firstPositionalArgument(args: string[]): string | undefined {
  return firstPositional(args)?.value;
}

function nodeEntrypointInvokesVitest(value: string | undefined): boolean {
  if (value === undefined) return false;
  const normalized = value.replace(/\\/gu, "/");
  return /(?:^|\/)node_modules\/(?:\.pnpm\/[^/]+\/node_modules\/)?vitest\/vitest\.(?:cjs|js|mjs)$/iu
    .test(normalized);
}

function packageManagerScriptName(tokens: string[], executableIndex: number): string | undefined {
  const args = tokens.slice(executableIndex + 1);
  const invocation = firstPositional(args);
  if (invocation === undefined || ["exec", "dlx"].includes(invocation.value)) return undefined;
  return ["run", "run-script"].includes(invocation.value)
    ? firstPositionalArgument(args.slice(invocation.index + 1))
    : invocation.value;
}

function shellCommandInvokesVitest(
  command: string,
  scripts: Record<string, unknown>,
  visitedScripts: Set<string>,
): boolean {
  return command.split(/(?:&&|\|\||[;|])/u).some(segment => {
    const tokens = segment.trim().split(/\s+/u).map(token => token.replace(/^["']|["']$/gu, ""));
    let index = 0;
    if (tokens[index] === "env" || tokens[index] === "cross-env") index += 1;
    while (/^[A-Za-z_][A-Za-z0-9_]*=/u.test(tokens[index] ?? "")) index += 1;
    const executable = executableName(tokens[index] ?? "");
    if (executable === "vitest") return true;
    if (executable === "node" || executable === "bun") {
      return nodeEntrypointInvokesVitest(firstPositionalArgument(tokens.slice(index + 1)));
    }
    if (executable === "npx" || executable === "bunx") {
      return executableName(firstPositionalArgument(tokens.slice(index + 1)) ?? "") === "vitest";
    }
    if (["npm", "pnpm", "yarn"].includes(executable)) {
      const args = tokens.slice(index + 1);
      const invocation = firstPositional(args);
      if (["exec", "dlx"].includes(invocation?.value ?? "")) {
        return executableName(firstPositionalArgument(args.slice(invocation!.index + 1)) ?? "")
          === "vitest";
      }
      const scriptName = packageManagerScriptName(tokens, index);
      if (scriptName === undefined || visitedScripts.has(scriptName)) return false;
      const script = scripts[scriptName];
      if (typeof script !== "string") return executable === "yarn" && scriptName === "vitest";
      const nextVisited = new Set(visitedScripts).add(scriptName);
      return shellCommandInvokesVitest(script, scripts, nextVisited);
    }
    return false;
  });
}

async function packageScriptInvokesVitest(cwd: string, scriptName: string): Promise<boolean> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path.join(cwd, "package.json"), "utf8"));
    if (parsed === null || typeof parsed !== "object" || !("scripts" in parsed)) return false;
    const scripts = parsed.scripts;
    if (scripts === null || typeof scripts !== "object") return false;
    const script = (scripts as Record<string, unknown>)[scriptName];
    return typeof script === "string"
      && shellCommandInvokesVitest(
        script,
        scripts as Record<string, unknown>,
        new Set([scriptName]),
      );
  } catch (error) {
    // Only "this repository has no package.json" is a legitimate negative.
    // A parse error, a permission denial, or anything else is ambiguity, and
    // resolving it to `false` would let a command that collected zero tests
    // pass as a valid baseline proof.
    if (isMissing(error)) return false;
    throw error;
  }
}

async function isVitestCommand(command: VerificationCommand, cwd: string): Promise<boolean> {
  if (executableName(command.executable) === "vitest") return true;

  const launcher = executableName(command.executable);
  if (launcher === "node" || launcher === "bun") {
    return nodeEntrypointInvokesVitest(firstPositionalArgument(command.args));
  }
  if (launcher === "npx" || launcher === "bunx") {
    return executableName(firstPositionalArgument(command.args) ?? "") === "vitest";
  }
  if (launcher === "npm" || launcher === "pnpm" || launcher === "yarn") {
    const invocation = firstPositional(command.args);
    if (invocation === undefined) return false;
    if (["exec", "dlx"].includes(invocation.value)) {
      return executableName(
        firstPositionalArgument(command.args.slice(invocation.index + 1)) ?? "",
      ) === "vitest";
    }
    const scriptName = ["run", "run-script"].includes(invocation.value)
      ? firstPositionalArgument(command.args.slice(invocation.index + 1))
      : invocation.value;
    return scriptName !== undefined && packageScriptInvokesVitest(cwd, scriptName);
  }
  return false;
}

async function reportsNoTestFiles(
  command: VerificationCommand,
  cwd: string,
  executed: Awaited<ReturnType<typeof executeCommand>>,
): Promise<boolean> {
  if (!await isVitestCommand(command, cwd)) return false;
  const outputs = executed.outputLogs.map(log =>
    log.text.replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, ""));
  const candidates = [...outputs, outputs.join("")];
  const suiteCounts = candidates.flatMap(output => {
    try {
      const report: unknown = JSON.parse(output);
      return report !== null
        && typeof report === "object"
        && "numTotalTestSuites" in report
        && typeof report.numTotalTestSuites === "number"
        ? [report.numTotalTestSuites]
        : [];
    } catch {
      return [];
    }
  });
  if (suiteCounts.some(count => count > 0)) return false;
  if (suiteCounts.some(count => count === 0)) return true;

  const aggregate = outputs.join("");
  if (/\bTest Files\s+\d+\s+(?:passed|failed|skipped|todo)\b/iu.test(aggregate)) {
    return false;
  }
  return /\bNo test files found\b/iu.test(aggregate)
    || /\bTest Files\s+no tests\b/iu.test(aggregate);
}

export async function verifyBaseline(args: BaselineVerifyArgs): Promise<BaselineReport> {
  throwIfAborted(args.abortSignal);
  const ps = args.ps ?? getPlatformServices();
  const arch = args.arch ?? process.arch;
  const now = args.now ?? Date.now;
  const manager = new WorktreeManager(
    args.repoRoot,
    // A runId gives recovery a deterministic, reclaimable name; without one
    // (only unit callers), fall back to a unique id so repeated same-commit
    // fixtures cannot collide on a shared worktrees root.
    `baseline-${args.runId ?? args.verificationId?.() ?? randomUUID()}`,
    ps,
    args.borrowedCheckoutLease === undefined
      ? {}
      : { borrowedCheckoutLease: args.borrowedCheckoutLease },
  );
  const materialized = await manager.create(args.headCommitOid);
  let report: BaselineReport;
  try {
    const dependencyLink = await linkPrimaryDependencies(args.repoRoot, materialized.path);
    const commands: BaselineCommandResult[] = [];
    for (let index = 0; index < args.commands.length; index += 1) {
      throwIfAborted(args.abortSignal);
      const command = args.commands[index]!;
      if (!appliesToPlatform(command, ps.os, arch).applies) {
        commands.push({ id: command.id, exitCode: null, ok: true });
        continue;
      }
      const cwd = await resolveCommandCwd(materialized.path, command.cwd, ps.os);
      if (cwd === null) {
        commands.push({ id: command.id, exitCode: null, ok: false });
        continue;
      }
      const executed = await executeCommand({
        command,
        index,
        cwd,
        ps,
        now,
        logNamePrefix: "baseline-verification",
        ...(args.abortSignal === undefined ? {} : { abortSignal: args.abortSignal }),
      });
      // A baseline failure with no retained output is undiagnosable without
      // rerunning the whole attempt, which is how a mistyped guard command cost
      // a full run. Archive first, then judge.
      const outputRefs: { stdoutRef?: string; stderrRef?: string } = {};
      if (args.store !== undefined) {
        for (const log of executed.outputLogs) {
          const ref = await args.store.writeLog(log.name, log.text);
          if (log.name.endsWith("stdout")) outputRefs.stdoutRef = ref;
          if (log.name.endsWith("stderr")) outputRefs.stderrRef = ref;
        }
      }
      throwIfAborted(args.abortSignal);
      const mutation = await scanCommandMutations({
        worktreePath: materialized.path,
        expectedHeadCommitOid: args.headCommitOid,
        dependencyLink,
        ...(command.allowedMutations === undefined
          ? {}
          : { allowedMutations: command.allowedMutations }),
      });
      const noTestsCollected = await reportsNoTestFiles(command, cwd, executed);
      commands.push({
        id: executed.outcome.id,
        exitCode: executed.outcome.exitCode,
        ...outputRefs,
        // `expectBaselineFailure` declares that this command runs at clean HEAD
        // and reports failure. Both halves are load-bearing. A command that
        // never delivered a verdict — unresolvable executable, timeout,
        // cancellation, death by signal — proves nothing about the baseline,
        // and excusing those voided the environment-defect gate for every
        // command carrying the flag. A command that *passes* contradicts the
        // declaration outright: the spec claims it cannot pass by design, so a
        // green run means the command does not prove what the spec says it
        // proves, and the fail-before/pass-after evidence is void either way.
        // When the spec names the codes that constitute the intended failure,
        // demand one of them. Otherwise any completed non-zero exit satisfies the
        // flag, so a missing test file proves the same thing as a test that ran
        // and asserted false — which is not a RED proof at all.
        ok: (command.expectBaselineFailure === true
          ? executed.failed
            && executed.terminal === "exited"
            && (command.baselineFailureExitCodes === undefined
              || (executed.outcome.exitCode !== null
                && command.baselineFailureExitCodes.includes(executed.outcome.exitCode)))
          : !executed.failed)
          && !mutation.mutated
          // A run that collected no tests is the case the comment above names:
          // it cannot distinguish "the assertion failed" from "nothing ran", so
          // it is not a RED proof, and it is not a GREEN one either.
          && !noTestsCollected,
        ...(noTestsCollected ? { classification: "no-tests-collected" as const } : {}),
        ...(mutation.mutated
          ? { mutation: { records: mutation.records, headChanged: mutation.headChanged } }
          : {}),
      });
      throwIfAborted(args.abortSignal);
    }
    report = { baselineCommitOid: args.headCommitOid, commands, dependencyLink };
  } catch (primaryError) {
    try {
      await materialized.cleanup();
    } catch (cleanupError) {
      throw new AggregateError(
        [primaryError, cleanupError],
        "baseline verification failed and its worktree could not be cleaned up",
      );
    }
    throw primaryError;
  }

  // Baseline verification already produced its terminal classification above —
  // including any failing commands, which are the load-bearing diagnostic
  // record for the run. A worktree-teardown failure past this point (observed
  // with a large disposable worktree exceeding the removal timeout) is a
  // secondary environment-cleanup defect. It must never overwrite or suppress
  // that classification: previously, throwing here discarded the fully
  // computed report, so the caller surfaced only "quarantined directory
  // contents could not be removed" with no result.json and no record of the
  // actual baseline outcome. Record it alongside the report instead, mirroring
  // how attempt-runtime.ts records a post-archival attempt-worktree cleanup
  // failure without replacing the attempt's own outcome.
  try {
    await materialized.cleanup();
  } catch (cleanupError) {
    const diagnostic = boundedRedactedDiagnostic(cleanupError, 2_000);
    logger.warn("baseline verification worktree cleanup failed after producing a result", {
      runId: args.runId,
      error: diagnostic,
    });
    if (args.store !== undefined) {
      try {
        await args.store.writeLog("baseline-cleanup-failure", `${diagnostic}\n`);
      } catch (writeError) {
        // The report already carries the failure; a second write error must
        // not replace it either — but it must still be visible.
        logger.warn("baseline cleanup failure could not be archived", {
          error: boundedRedactedDiagnostic(writeError, 2_000),
        });
      }
    }
    report = { ...report, cleanupIssue: diagnostic };
  }
  return report;
}
