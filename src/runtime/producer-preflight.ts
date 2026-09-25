import path from "node:path";
import { WorktreeManager } from "./worktree-manager.js";
import type { CheckoutLock, PlatformServices } from "../platform/platform-services.js";
import type { DelegationSpec } from "../protocol/delegation-spec.js";
import type {
  CapabilityReport,
  ProducerAdapter,
} from "../producers/producer-adapter.js";
import { producerRuntime, type ProducerLaunchResult } from "../producers/producer-runtime.js";
import { RuntimeError } from "../util/errors.js";
import { boundedRedactedDiagnostic } from "./redaction.js";
import { readStableRegularFile } from "../util/stable-file.js";
import { linkPrimaryDependencies } from "../verify/dependency-link.js";

/**
 * A Producer that cannot resolve the project toolchain cannot verify its own
 * work, and discovers that only after burning the whole attempt window. Probe
 * the executables the spec's verification commands name, inside the Producer's
 * own shell and sandbox, before spending that window.
 *
 * Deliberate limits:
 * - This proves resolution, not configuration. A toolchain that resolves but
 *   cannot load its own config (a `tsc` that finds no `@types`) still passes
 *   here; independent verification remains the backstop for that class.
 * - The Producer is untrusted, so its report is never evidence. The runtime
 *   reads the probe file it wrote rather than believing a summary, and a green
 *   preflight grants the candidate nothing.
 * - Only an unambiguous miss blocks. A false positive costs an entire
 *   delegation, so anything softer proceeds and is recorded as inconclusive.
 */
export interface ProducerPreflightResult {
  status: "ok" | "environment-defect" | "inconclusive";
  reason: string | null;
  missing: string[];
  probe: string | null;
  cleanupFailure?: string;
}

export const PREFLIGHT_PROBE_FILE = "claude-architect-preflight.txt";
const PREFLIGHT_TIMEOUT_MS = 180_000;
const PREFLIGHT_OUTPUT_LIMIT = 256 * 1024;
const PROBE_FILE_LIMIT = 64 * 1024;
const PROBE_EVIDENCE_LIMIT = 16 * 1024;
const SAFE_EXECUTABLE = /^[A-Za-z0-9._+-]+$/u;

export function preflightExecutables(spec: DelegationSpec): string[] {
  const names = new Set<string>();
  for (const command of spec.verification) {
    // A path-qualified or oddly named executable is not shell-safe to inline in
    // the probe; independent verification still covers it.
    if (SAFE_EXECUTABLE.test(command.executable)) names.add(command.executable);
  }
  return [...names].sort();
}

export function preflightProbeCommand(executables: string[]): string {
  const loop = executables.map(name =>
    `printf '%s ' ${name}; command -v ${name} || printf 'MISSING\\n'`).join("; ");
  return `{ ${loop}; } > ${PREFLIGHT_PROBE_FILE} 2>&1`;
}

function probeSpec(
  spec: DelegationSpec,
  executables: string[],
  options: { forceLowReasoning?: boolean } = {},
): DelegationSpec {
  const forceLowReasoning = options.forceLowReasoning ?? true;
  return {
    ...spec,
    objective: [
      "This is an environment probe, not an implementation task.",
      "Run exactly this one shell command and then stop:",
      preflightProbeCommand(executables),
      `Do not edit any file other than ${PREFLIGHT_PROBE_FILE}.`,
    ].join("\n"),
    context: "The runtime reads the probe file directly; no summary is needed.",
    writeAllowlist: [PREFLIGHT_PROBE_FILE],
    successCriteria: [`${PREFLIGHT_PROBE_FILE} exists and names every executable.`],
    ...(forceLowReasoning
      ? { producerOverrides: { ...spec.producerOverrides, reasoningEffort: "low" } }
      : {}),
  };
}

export function redactedProbeEvidence(contents: string): string {
  return boundedRedactedDiagnostic(contents, PROBE_EVIDENCE_LIMIT);
}

export function readProbe(contents: string, executables: string[]): string[] {
  const resolved = new Set<string>();
  for (const line of contents.split(/\r?\n/u)) {
    const match = /^([A-Za-z0-9._+-]+)\s+(.*)$/u.exec(line.trim());
    if (match === null) continue;
    const [, name, location] = match;
    if (location !== undefined && location.length > 0 && location !== "MISSING") {
      resolved.add(name!);
    }
  }
  return executables.filter(name => !resolved.has(name));
}

export interface ProducerPreflightArgs {
  adapter: ProducerAdapter;
  capabilityReport: CapabilityReport;
  spec: DelegationSpec;
  repoRoot: string;
  baseCommitOid: string;
  runId: string;
  ps: PlatformServices;
  tempHome: string | null;
  abortSignal?: AbortSignal;
  borrowedCheckoutLease?: CheckoutLock;
  worktreeManager?: Pick<WorktreeManager, "create">;
}

export async function runProducerPreflight(
  args: ProducerPreflightArgs,
): Promise<ProducerPreflightResult> {
  const executables = preflightExecutables(args.spec);
  if (executables.length === 0 || args.capabilityReport.resolvedExecutable === null) {
    return { status: "inconclusive", reason: "no probeable executables", missing: [], probe: null };
  }

  const manager = args.worktreeManager
    ?? new WorktreeManager(args.repoRoot, `${args.runId}-preflight`, args.ps, {
      ...(args.borrowedCheckoutLease === undefined
        ? {}
        : { borrowedCheckoutLease: args.borrowedCheckoutLease }),
    });
  const worktree = await manager.create(args.baseCommitOid);
  let probeError: unknown;
  let probeOutcome: ProducerPreflightResult | undefined;
  const complete = (outcome: ProducerPreflightResult) => {
    probeOutcome = outcome;
    return outcome;
  };
  try {
    await linkPrimaryDependencies(args.repoRoot, worktree.path);
    let launchResult: ProducerLaunchResult;
    try {
      launchResult = await producerRuntime.launch({
        adapter: args.adapter,
        producerId: args.capabilityReport.producerId,
        spec: probeSpec(args.spec, executables),
        worktreePath: worktree.path,
        intent: "edit",
        ps: args.ps,
        runId: args.runId,
        tempHome: args.tempHome,
        timeoutMs: PREFLIGHT_TIMEOUT_MS,
        maxOutputBytes: PREFLIGHT_OUTPUT_LIMIT,
        capabilityReport: args.capabilityReport,
        ...(args.abortSignal === undefined ? {} : { abortSignal: args.abortSignal }),
      });
    } catch {
      // Some adapters (e.g. Pythinker) reject ANY reasoningEffort override outright, so a
      // real caller request is never silently substituted. The "low" value forced above is a
      // synthetic speed optimization for this probe, not a real request, so retry without it
      // instead of letting every run on such an adapter degrade to "inconclusive". A rejection
      // unrelated to reasoningEffort (e.g. an invalid model override) reproduces identically
      // here and still surfaces below.
      launchResult = await producerRuntime.launch({
        adapter: args.adapter,
        producerId: args.capabilityReport.producerId,
        spec: probeSpec(args.spec, executables, { forceLowReasoning: false }),
        worktreePath: worktree.path,
        intent: "edit",
        ps: args.ps,
        runId: args.runId,
        tempHome: args.tempHome,
        timeoutMs: PREFLIGHT_TIMEOUT_MS,
        maxOutputBytes: PREFLIGHT_OUTPUT_LIMIT,
        capabilityReport: args.capabilityReport,
        ...(args.abortSignal === undefined ? {} : { abortSignal: args.abortSignal }),
      });
    }

    try {
      if (launchResult.exit.cancelled) {
        return complete({ status: "inconclusive", reason: "cancelled", missing: [], probe: null });
      }
    } finally {
      launchResult.builtEnvironment.secretRegistration.dispose();
    }

    let contents: string;
    try {
      const probeBytes = await readStableRegularFile(
        path.join(worktree.path, PREFLIGHT_PROBE_FILE),
        BigInt(PROBE_FILE_LIMIT),
      );
      if (probeBytes === null) throw new RuntimeError("the Producer probe file is not stable");
      contents = probeBytes.toString("utf8");
    } catch (error) {
      probeError = error;
      return complete({
        status: "inconclusive",
        reason: "the Producer did not write the probe file",
        missing: [],
        probe: null,
      });
    }

    const missing = readProbe(contents, executables);
    const safeProbe = redactedProbeEvidence(contents);
    return complete(missing.length === 0
      ? { status: "ok", reason: null, missing: [], probe: safeProbe }
      : {
        status: "environment-defect",
        reason: `the Producer shell cannot resolve: ${missing.join(", ")}`,
        missing,
        probe: safeProbe,
      });
  } catch (error) {
    probeError = error;
    // An unusable probe must never become a new terminal failure mode.
    return complete({
      status: "inconclusive",
      reason: "the probe could not run",
      missing: [],
      probe: null,
    });
  } finally {
    try {
      await worktree.cleanup();
    } catch (cleanupError) {
      if (probeOutcome?.reason === "cancelled") {
        probeOutcome.cleanupFailure = boundedRedactedDiagnostic(
          cleanupError,
          PROBE_EVIDENCE_LIMIT,
        );
      } else {
        const primaryError = probeError ?? (probeOutcome !== undefined && probeOutcome.status !== "ok"
          ? new RuntimeError(`producer preflight ${probeOutcome.status}: ${probeOutcome.reason ?? "unknown"}`)
          : undefined);
        if (primaryError === undefined) throw cleanupError;
        throw new AggregateError(
          [primaryError, cleanupError],
          "producer preflight failed and its managed worktree cleanup also failed",
        );
      }
    }
  }
}
