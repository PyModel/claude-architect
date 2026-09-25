import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { SANDBOX_BACKENDS } from "../platform/sandbox/backends.js";
import { seatbeltArgv } from "../platform/sandbox/seatbelt.js";
import { gitChecked as checkedGit } from "../git/checked-git.js";
import path from "node:path";
import { WorktreeManager } from "../runtime/worktree-manager.js";
import type {
  CheckoutLock,
  PlatformServices,
  ResolvedExecutable,
  SupervisedExit,
} from "../platform/platform-services.js";
import { supervise } from "../platform/process-supervisor.js";
import { getPlatformServices } from "../platform/select-platform.js";
import { canonicalizeForScope } from "../platform/windows-platform-services.js";
import { normalizeWindowsEnv } from "../platform/windows-env.js";
import type { CandidateArtifact, CommandOutcome } from "../protocol/attempt-result.js";
import type { VerificationCommand } from "../protocol/delegation-spec.js";
import { registerSensitiveEnvironment, WIN32_ESSENTIAL_ENV } from "../runtime/environment-policy.js";
import { redact } from "../runtime/redaction.js";
import { linkPrimaryDependencies, type DependencyLink } from "./dependency-link.js";

const MAX_COMMAND_OUTPUT_BYTES = 1_000_000;
const POSIX_ESSENTIAL_ENV = [
  "HOME",
  "PATH",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
  "XDG_RUNTIME_DIR",
] as const;

export interface ProjectVerifyArgs {
  repoRoot: string;
  artifact: CandidateArtifact;
  commands: VerificationCommand[];
  ps?: PlatformServices;
  arch?: string;
  now?: () => number;
  runId?: string;
  verificationId?: () => string;
  logNamePrefix?: string;
  borrowedCheckoutLease?: CheckoutLock;
}

/**
 * Verification executes Producer-authored code (tests, package scripts), so it
 * runs under the same OS confinement as the Producer wherever the runtime owns
 * a backend. `null` means no backend exists here; the evidence then records
 * `confinement: "none"` and the decision policy refuses autonomous acceptance.
 */
export interface VerificationConfinement {
  backend: "macos-seatbelt";
  worktreePath: string;
  scratchDir: string;
}

export type VerificationConfinementBackend = VerificationConfinement["backend"] | "none";

export function verificationConfinementBackend(
  os: PlatformServices["os"],
  arch: string,
): VerificationConfinement["backend"] | null {
  const platform = SANDBOX_BACKENDS.find(backend => backend.id === "macos-seatbelt")
    ?.platforms.find(candidate =>
      candidate.os === os
      && candidate.environmentType === "native"
      && (candidate.arch === undefined || candidate.arch === arch));
  return platform === undefined || platform.state === "unsupported" ? null : "macos-seatbelt";
}

export interface ProjectCommandEvidence {
  id: string;
  confinement: VerificationConfinementBackend;
  networkPolicy: "unenforced";
  requestedNetwork: VerificationCommand["network"];
  skipped: boolean;
  skipReason?: "platform-os" | "platform-arch";
  resolvedFrom?: string | null;
  truncated?: { stdout: boolean; stderr: boolean };
  spawnError?: boolean;
}

export interface ProjectOutputLog {
  name: string;
  text: string;
}

export interface ProjectVerifyResult {
  commandOutcomes: CommandOutcome[];
  mutated: boolean;
  failures: string[];
  evidence: { commands: ProjectCommandEvidence[]; dependencyLink: DependencyLink };
  outputLogs: ProjectOutputLog[];
}

/**
 * How the command process ended, independent of whether the exit code was
 * acceptable. Only `exited` means the command actually ran to completion and
 * reported a status of its own; every other value means the result carries no
 * information about the code under test.
 */
export type CommandTermination =
  | "exited"
  | "timeout"
  | "cancelled"
  | "signal"
  | "spawn-error";

export interface ExecutedCommand {
  outcome: CommandOutcome;
  evidence: ProjectCommandEvidence;
  outputLogs: ProjectOutputLog[];
  failed: boolean;
  terminal: CommandTermination;
}



function defineEnvironmentValue(environment: Record<string, string>, name: string, value: string): void {
  Object.defineProperty(environment, name, {
    value,
    writable: true,
    enumerable: true,
    configurable: true,
  });
}

function commandEnvironment(
  command: VerificationCommand,
  os: PlatformServices["os"],
): Record<string, string> {
  const environment = Object.create(null) as Record<string, string>;
  const platformEnvironment = os === "win32" ? normalizeWindowsEnv(process.env) : process.env;
  const platformNames = os === "win32" ? WIN32_ESSENTIAL_ENV : POSIX_ESSENTIAL_ENV;
  for (const name of platformNames) {
    const value = platformEnvironment[name];
    if (value !== undefined) defineEnvironmentValue(environment, name, value);
  }
  for (const [name, value] of Object.entries(command.environment ?? {})) {
    defineEnvironmentValue(environment, name, value);
  }
  defineEnvironmentValue(environment, "CLAUDE_ARCHITECT_DELEGATED", "1");
  return environment;
}

export function isWithinScope(
  root: string,
  candidate: string,
  os: PlatformServices["os"],
): boolean {
  if (os === "win32") return canonicalizeForScope(candidate, root);
  const relative = path.posix.relative(root, candidate);
  return relative === ""
    || (!path.posix.isAbsolute(relative) && relative !== ".." && !relative.startsWith("../"));
}

export async function resolveCommandCwd(
  worktreePath: string,
  commandCwd: string,
  os: PlatformServices["os"],
): Promise<string | null> {
  if (path.isAbsolute(commandCwd)) return null;
  const lexical = path.resolve(worktreePath, commandCwd);
  if (!isWithinScope(worktreePath, lexical, os)) return null;
  try {
    const [canonicalRoot, canonicalCwd] = await Promise.all([
      realpath(worktreePath),
      realpath(lexical),
    ]);
    return isWithinScope(canonicalRoot, canonicalCwd, os) ? canonicalCwd : null;
  } catch {
    return null;
  }
}

export function appliesToPlatform(
  command: VerificationCommand,
  os: PlatformServices["os"],
  arch: string,
): { applies: true } | { applies: false; reason: "platform-os" | "platform-arch" } {
  if (command.platform?.os !== undefined && !command.platform.os.includes(os)) {
    return { applies: false, reason: "platform-os" };
  }
  if (command.platform?.arch !== undefined && !command.platform.arch.includes(arch)) {
    return { applies: false, reason: "platform-arch" };
  }
  return { applies: true };
}

function logName(
  index: number,
  stream: "stdout" | "stderr",
  prefix = "verification",
): string {
  return `${prefix}-${index}-${stream}`;
}

function logRef(name: string): string {
  return `logs/${name}.log`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function boundText(text: string): { text: string; truncated: boolean } {
  const bytes = Buffer.from(text);
  if (bytes.length <= MAX_COMMAND_OUTPUT_BYTES) return { text, truncated: false };
  let end = MAX_COMMAND_OUTPUT_BYTES;
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end -= 1;
  return { text: bytes.subarray(0, end).toString("utf8"), truncated: true };
}

export async function executeCommand(args: {
  command: VerificationCommand;
  index: number;
  cwd: string;
  ps: PlatformServices;
  now: () => number;
  abortSignal?: AbortSignal;
  logNamePrefix?: string;
  confinement?: VerificationConfinement | null;
}): Promise<ExecutedCommand> {
  const { command, index, cwd, ps, now } = args;
  const registration = registerSensitiveEnvironment(command.environment ?? {});
  const stdoutName = logName(index, "stdout", args.logNamePrefix);
  const stderrName = logName(index, "stderr", args.logNamePrefix);
  const startedAt = now();
  let executable: ResolvedExecutable | null = null;
  let exit: SupervisedExit | null = null;
  let failureText = "";
  try {
    const environment = commandEnvironment(command, ps.os);
    executable = await ps.resolveExecutable({
      name: command.executable,
      ...(path.isAbsolute(command.executable) ? { explicitPath: command.executable } : {}),
      searchPath: environment.PATH ?? environment.Path ?? "",
    });
    let spawned = { executable, args: command.args };
    if (args.confinement) {
      defineEnvironmentValue(environment, "TMPDIR", args.confinement.scratchDir);
      const confined = seatbeltArgv(args.confinement, [
        executable.command,
        ...executable.prefixArgs,
        ...command.args,
      ]);
      spawned = {
        executable: {
          kind: "native",
          command: confined.command,
          prefixArgs: [],
          resolvedFrom: `seatbelt:${executable.resolvedFrom}`,
        },
        args: confined.args,
      };
    }
    exit = await supervise(ps, {
      executable: spawned.executable,
      args: spawned.args,
      cwd,
      env: environment,
      timeoutMs: command.timeoutMs,
      maxOutputBytes: MAX_COMMAND_OUTPUT_BYTES,
    }, args.abortSignal === undefined ? {} : { onCancel: args.abortSignal });
  } catch (error) {
    failureText = errorMessage(error);
  }

  try {
    const actualArgs = [...(executable?.prefixArgs ?? []), ...command.args].map(redact);
    const stdout = boundText(redact(exit?.stdout ?? ""));
    const stderr = boundText(redact(exit === null
      ? failureText
      : [exit.stderr, exit.spawnError === undefined ? "" : errorMessage(exit.spawnError)]
        .filter(Boolean)
        .join("\n")));
    const exitCode = exit?.exitCode ?? null;
    // Resolution or supervision threw, so no process ever reported a status.
    const terminal: CommandTermination = exit === null || exit.spawnError !== undefined
      ? "spawn-error"
      : exit.cancelled === true
        ? "cancelled"
        : exit.timedOut === true
          ? "timeout"
          : exit.exitCode === null
            ? "signal"
            : "exited";
    const failed = terminal !== "exited"
      || exitCode === null
      || !command.expectedExitCodes.includes(exitCode);
    return {
      outcome: {
        id: redact(command.id),
        executable: redact(executable?.command ?? command.executable),
        args: actualArgs,
        exitCode,
        timedOut: exit?.timedOut ?? false,
        durationMs: Math.max(0, now() - startedAt),
        stdoutRef: logRef(stdoutName),
        stderrRef: logRef(stderrName),
      },
      evidence: {
        id: redact(command.id),
        confinement: args.confinement?.backend ?? "none",
        networkPolicy: "unenforced",
        requestedNetwork: command.network,
        skipped: false,
        resolvedFrom: executable === null ? null : redact(executable.resolvedFrom),
        truncated: {
          stdout: (exit?.truncated.stdout ?? false) || stdout.truncated,
          stderr: (exit?.truncated.stderr ?? false) || stderr.truncated,
        },
        spawnError: exit?.spawnError !== undefined,
      },
      outputLogs: [
        { name: stdoutName, text: stdout.text },
        { name: stderrName, text: stderr.text },
      ],
      failed,
      terminal,
    };
  } finally {
    registration.dispose();
  }
}

export async function scanCommandMutations(args: {
  worktreePath: string;
  expectedHeadCommitOid: string;
  dependencyLink: DependencyLink;
  allowedMutations?: VerificationCommand["allowedMutations"];
}): Promise<{ mutated: boolean; records: string[]; headChanged: boolean }> {
  const [status, currentHead, indexEntries] = await Promise.all([
    checkedGit(args.worktreePath, [
      "status",
      "--porcelain=v2",
      "-z",
      "--untracked-files=all",
      "--ignored=matching",
      "--ignore-submodules=none",
    ]),
    checkedGit(args.worktreePath, ["rev-parse", "--verify", "HEAD"]),
    checkedGit(args.worktreePath, ["ls-files", "-v", "-z"]),
  ]);
  const statusRecords = status.split("\0").filter(record =>
    record.length > 0
    && !(args.dependencyLink === "inherited" && /^[?!] node_modules\/?$/.test(record)));
  const hiddenIndexRecords = indexEntries.split("\0")
    .filter(record => /^(?:S|[a-z]) /.test(record))
    .map(record => `index ${record}`);
  const records = [...statusRecords, ...hiddenIndexRecords];
  // Verification runs in a DISPOSABLE worktree that is deleted after the scan.
  // Writes to git-ignored paths (build caches, .venv, __pycache__, .pytest_cache)
  // cannot reach the frozen candidate tree — integration applies the candidate
  // commit, never the worktree's ignored files — and cannot escape to the primary
  // checkout, so they are not verification-invalidating mutations. They are exempt
  // by default. `allowedMutations: "none"` opts into strict scanning for commands
  // that must be proven to write nothing at all.
  const disallowedRecords = args.allowedMutations === "none"
    ? records
    : records.filter(record => !record.startsWith("! "));
  const headChanged = currentHead.trim() !== args.expectedHeadCommitOid;
  return { mutated: disallowedRecords.length > 0 || headChanged, records: disallowedRecords, headChanged };
}

function skippedEvidence(
  command: VerificationCommand,
  reason: "platform-os" | "platform-arch",
): ProjectCommandEvidence {
  const registration = registerSensitiveEnvironment(command.environment ?? {});
  try {
    return {
      id: redact(command.id),
      confinement: "none",
      networkPolicy: "unenforced",
      requestedNetwork: command.network,
      skipped: true,
      skipReason: reason,
    };
  } finally {
    registration.dispose();
  }
}

export async function projectVerify(args: ProjectVerifyArgs): Promise<ProjectVerifyResult> {
  const ps = args.ps ?? getPlatformServices();
  const arch = args.arch ?? process.arch;
  const now = args.now ?? Date.now;
  const anchorPrefix = "refs/claude-architect/candidates/";
  const artifactRunId = args.artifact.anchorRef.startsWith(anchorPrefix)
    ? args.artifact.anchorRef.slice(anchorPrefix.length)
    : args.artifact.candidateCommitOid;
  const verificationId = args.runId ?? args.verificationId?.() ?? artifactRunId;
  const manager = new WorktreeManager(
    args.repoRoot,
    `verify-${verificationId}`,
    ps,
    args.borrowedCheckoutLease === undefined
      ? {}
      : { borrowedCheckoutLease: args.borrowedCheckoutLease },
  );
  const materialized = await manager.create(args.artifact.candidateCommitOid);
  const backend = verificationConfinementBackend(ps.os, arch);
  let scratchDir: string | null = null;
  let primaryError: unknown;
  try {
    scratchDir = backend === null
      ? null
      : await mkdtemp(path.join(tmpdir(), "claude-architect-verify-"));
    const confinement: VerificationConfinement | null = backend === null || scratchDir === null
      ? null
      : { backend, worktreePath: materialized.path, scratchDir };
    const dependencyLink = await linkPrimaryDependencies(args.repoRoot, materialized.path);
    const materializedTree = (await checkedGit(
      materialized.path,
      ["rev-parse", "HEAD^{tree}"],
    )).trim();
    if (materializedTree !== args.artifact.candidateTreeOid) {
      return {
        commandOutcomes: [],
        mutated: false,
        failures: ["candidate-materialization-mismatch"],
        evidence: { commands: [], dependencyLink },
        outputLogs: [],
      };
    }

    const commandOutcomes: CommandOutcome[] = [];
    const failures: string[] = [];
    const commandEvidence: ProjectCommandEvidence[] = [];
    const outputLogs: ProjectOutputLog[] = [];
    let mutated = false;

    for (let index = 0; index < args.commands.length; index += 1) {
      const command = args.commands[index]!;
      const applicability = appliesToPlatform(command, ps.os, arch);
      if (!applicability.applies) {
        commandEvidence.push(skippedEvidence(command, applicability.reason));
        continue;
      }
      const cwd = await resolveCommandCwd(materialized.path, command.cwd, ps.os);
      if (cwd === null) {
        const registration = registerSensitiveEnvironment(command.environment ?? {});
        try {
          failures.push(`invalid-command-cwd:${redact(command.id)}`);
          commandEvidence.push({
            id: redact(command.id),
            confinement: "none",
            networkPolicy: "unenforced",
            requestedNetwork: command.network,
            skipped: false,
          });
        } finally {
          registration.dispose();
        }
        continue;
      }

      const executed = await executeCommand({
        command,
        index,
        cwd,
        ps,
        now,
        confinement,
        ...(args.logNamePrefix === undefined ? {} : { logNamePrefix: args.logNamePrefix }),
      });
      commandOutcomes.push(executed.outcome);
      commandEvidence.push(executed.evidence);
      outputLogs.push(...executed.outputLogs);
      if (executed.failed) failures.push(`command-failed:${executed.outcome.id}`);

      const mutation = await scanCommandMutations({
        worktreePath: materialized.path,
        expectedHeadCommitOid: args.artifact.candidateCommitOid,
        dependencyLink,
        ...(command.allowedMutations === undefined
          ? {}
          : { allowedMutations: command.allowedMutations }),
      });
      if (mutation.mutated) {
        mutated = true;
        failures.push("verification-mutated");
        break;
      }
    }

    return {
      commandOutcomes,
      mutated,
      failures,
      evidence: { commands: commandEvidence, dependencyLink },
      outputLogs,
    };
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    if (scratchDir !== null) await rm(scratchDir, { recursive: true, force: true });
    try {
      await materialized.cleanup();
    } catch (cleanupError) {
      if (primaryError === undefined) throw cleanupError;
      throw new AggregateError(
        [primaryError, cleanupError],
        "project verification failed and its worktree could not be cleaned up",
      );
    }
  }
}
