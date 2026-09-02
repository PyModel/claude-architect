import { createHash, randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { freezeCandidate } from "../git/candidate-tree.js";
import { git } from "../git/git-exec.js";
import { checkPreconditions } from "../git/repo-preconditions.js";
import { WorktreeManager } from "./worktree-manager.js";
import { PlatformSafety } from "../platform/platform-safety.js";
import type {
  CheckoutLock,
  PlatformServices,
  SupervisedExit,
} from "../platform/platform-services.js";
import { supervise } from "../platform/process-supervisor.js";
import { selectSandboxBackend } from "../platform/sandbox/backends.js";
import { getPlatformServices } from "../platform/select-platform.js";
import type {
  AttemptResult,
  CandidateArtifact,
  CommandOutcome,
  FailureClassification,
  FailureSignals,
} from "../protocol/attempt-result.js";
import { classifyFailure } from "../protocol/attempt-result.js";
import type { DelegationSpec } from "../protocol/delegation-spec.js";
import { specSha256 } from "../protocol/spec-hash.js";
import { probeAll } from "../producers/capability-probe.js";
import {
  detectEnvironmentType,
  type CapabilityReport,
  type ProducerAdapter,
  type ProducerConfigurationProfile,
  type ProducerInvocation,
} from "../producers/producer-adapter.js";
import {
  ProducerRegistry,
  registry,
} from "../producers/producer-registry.js";
import { ProducerRuntime, producerRuntime } from "../producers/producer-runtime.js";
import { route } from "../producers/routing-policy.js";
import { NestedDelegationError, RuntimeError } from "../util/errors.js";
import { logger } from "../util/logger.js";
import { verifyBaseline } from "../verify/baseline-verifier.js";
import { ArtifactStore } from "./artifact-store.js";
import {
  buildEnvironment,
  registerSensitiveEnvironment,
  type BuiltEnvironment,
  type EnvProvenance,
} from "./environment-policy.js";
import { runProducerPreflight } from "./producer-preflight.js";
import { redact, redactValues } from "./redaction.js";
import {
  collectReproducibilityInputs,
  type ReproducibilityInputs,
} from "./reproducibility.js";
import {
  buildRunManifest,
  type PackagedVerifierInput,
  type RepositoryInstructionInput,
} from "./run-manifest.js";
import {
  initializeRunStart,
  parentDeathWatchdogInvocation,
  type RunStartContext,
  type RunStartRecord,
  withRunStartPidRecording,
} from "./run-start.js";
import {
  writeRunStatusSafely,
  type RunStatus,
  type RunStatusPhase,
} from "./run-status.js";

const MAX_PRODUCER_OUTPUT_BYTES = 1_000_000;
const MAX_SNAPSHOT_DIFF_BYTES = 100_000;

// Best-effort salvage evidence for attempts that end without a frozen candidate
// (timeout, cancellation) while producer work already sits in the worktree. The
// worktree is deleted at cleanup, so a bounded, redacted status+diff snapshot is
// the only trace of finished-but-discarded work. `-N` marks untracked files
// intent-to-add so new files appear in the diff; the worktree is disposable.
async function captureWorktreeSnapshot(
  worktreePath: string,
): Promise<{ status: string; diff: string; truncated: boolean }> {
  await git(worktreePath, ["add", "-A", "-N"]);
  const [status, diff] = await Promise.all([
    git(worktreePath, ["status", "--porcelain=v1", "--untracked-files=all"]),
    git(worktreePath, ["-c", "core.quotepath=false", "diff", "--no-color", "--no-ext-diff"]),
  ]);
  const rawDiff = diff.exitCode === 0 ? diff.stdout : "";
  const bytes = Buffer.from(rawDiff);
  const truncated = bytes.length > MAX_SNAPSHOT_DIFF_BYTES;
  return {
    status: redact(status.exitCode === 0 ? status.stdout : ""),
    diff: redact(truncated ? bytes.subarray(0, MAX_SNAPSHOT_DIFF_BYTES).toString("utf8") : rawDiff),
    truncated,
  };
}

export interface AcceptanceVerificationResult {
  ok: boolean;
  failures: string[];
  evidence: Record<string, unknown>;
  commandOutcomes: CommandOutcome[];
}

export interface AcceptanceVerificationArgs {
  repoRoot: string;
  worktreePath: string;
  baseCommitOid: string;
  artifact: CandidateArtifact;
  spec: DelegationSpec;
  ps: PlatformServices;
  artifactStore: ArtifactStore;
  borrowedCheckoutLease?: CheckoutLock;
}

export interface AcceptanceVerifierLike {
  verify(args: AcceptanceVerificationArgs): Promise<AcceptanceVerificationResult>;
}

export interface AttemptRuntimeDependencies {
  verifier: AcceptanceVerifierLike;
  baselineVerifier?: typeof verifyBaseline;
  /** false disables the Producer environment probe; a function replaces it. */
  producerPreflight?: typeof runProducerPreflight | false;
  ps?: PlatformServices;
  producerRegistry?: ProducerRegistry;
  runId?: () => string;
  now?: () => number;
  env?: Record<string, string | undefined>;
  abortSignal?: AbortSignal;
  repositoryInstructions?: RepositoryInstructionInput[];
  packagedVerifier?: PackagedVerifierInput;
  reproducibilityCollector?: (
    repoRoot: string,
    baseCommitOid: string,
  ) => Promise<ReproducibilityInputs>;
  /** Trusted runtime handoff; never derived from the delegation specification. */
  borrowedCheckoutLease?: CheckoutLock;
  onRunStart?: (context: RunStartContext) => void | Promise<void>;
  /** Host progress reporting only; failures never affect the attempt. */
  onPhase?: (phase: string) => void | Promise<void>;
  /**
   * Identity of the spec the *caller* dispatched, when that differs from the
   * spec this attempt received. Slicing rewrites the spec before the attempt
   * runs, so hashing the received spec recorded an identity the caller never
   * held and `reviewCandidate`'s correspondence check could never match.
   */
  dispatchedSpecSha256?: string;
  /** Trusted pipeline-owned status context; never derived from Producer input. */
  runStatus?: {
    mode: RunStatus["mode"];
    sliceIndex: number | null;
    sliceCount: number | null;
    pipelineManaged: boolean;
  };
}

interface TerminalContext {
  store: ArtifactStore;
  spec: DelegationSpec;
  runId: string;
  startedAtMs: number;
  now: () => number;
  repoRoot: string;
  baseCommitOid: string;
  signals: FailureSignals;
  report: CapabilityReport | null;
  profile: ProducerConfigurationProfile | null;
  invocation: ProducerInvocation | null;
  environment: EnvProvenance;
  temporaryHomeApplied: boolean;
  producerSummary: string | null;
  candidate: CandidateArtifact | null;
  commandOutcomes: CommandOutcome[];
  unresolvedIssues: string[];
  evidence: Record<string, unknown>;
  producerLog: string;
  repositoryInstructions: RepositoryInstructionInput[];
  packagedVerifier: PackagedVerifierInput;
  probeCacheHits?: number;
}

// Host-facing progress only. Durability belongs to `emitStatus`, which writes
// the typed RunStatus the statusline and recovery read; this callback is a
// courtesy to the caller and must never affect the attempt.
async function reportPhase(deps: AttemptRuntimeDependencies, phase: string): Promise<void> {
  try { await deps.onPhase?.(phase); } catch { /* progress reporting must never affect the attempt */ }
}

function hasEnvironmentMarker(environment: Record<string, string | undefined>): boolean {
  return environment.CLAUDE_ARCHITECT_DELEGATED !== undefined;
}

function hasFailureSignal(signals: FailureSignals): boolean {
  return Object.values(signals).some(Boolean);
}

function statusForFailure(
  failure: FailureClassification | null,
): AttemptResult["status"] {
  if (failure === null) return "verified-candidate";
  if (failure === "unavailable" || failure === "authentication-required") return "unavailable";
  if (failure === "cancelled") return "cancelled";
  return "failed";
}

function summaryForFailure(failure: FailureClassification | null): string {
  switch (failure) {
    case null: return "candidate produced and independently verified";
    case "unavailable": return "no eligible producer is available";
    case "authentication-required": return "producer authentication is required";
    case "spawn-failure": return "producer process could not be started";
    case "cancelled": return "delegation attempt was cancelled";
    case "timeout": return "producer process exceeded the attempt timeout";
    case "sandbox-violation": return "producer changes violated the authorized write boundary";
    case "invalid-output": return "producer output did not match the adapter contract";
    case "producer-failure": return "producer process reported failure";
    case "verification-failure": return "candidate did not pass independent verification";
    case "invalid-specification": return "delegation specification is invalid";
    case "environment-defect": return "the execution environment did not pass its preconditions";
  }
}

function producerLog(exit: SupervisedExit | null): string {
  if (exit === null) return "No producer process was started.\n";
  return [
    "[stdout]",
    exit.stdout,
    "[stderr]",
    exit.stderr,
    "",
  ].join("\n");
}

function preCancelledExit(): SupervisedExit {
  return {
    exitCode: null,
    signal: null,
    timedOut: false,
    cancelled: true,
    stdout: "",
    stderr: "",
    truncated: { stdout: false, stderr: false },
  };
}


async function archiveTerminal(context: TerminalContext): Promise<AttemptResult> {
  const verificationSecretRegistrations: Array<{ dispose(): void }> = [];
  try {
    for (const command of context.spec.verification) {
      verificationSecretRegistrations.push(registerSensitiveEnvironment(command.environment ?? {}));
    }

    const failure = classifyFailure(context.signals);
    const logsRef = await context.store.writeLog("producer", context.producerLog);
    const result: AttemptResult = {
      resultVersion: "1",
      runId: context.runId,
      status: statusForFailure(failure),
      failure,
      summary: summaryForFailure(failure),
      producerSummary: context.producerSummary === null ? null : redact(context.producerSummary),
      candidate: context.candidate === null
        ? null
        : {
          ...context.candidate,
          changedPaths: context.candidate.changedPaths.map(change => ({ ...change })),
          patch: redact(context.candidate.patch),
        },
      requestedVerification: redactValues(context.spec.verification),
      executedVerification: redactValues(context.commandOutcomes),
      unresolvedIssues: context.unresolvedIssues.map(redact),
      evidence: redactValues(context.evidence),
      logsRef,
      producerId: context.report?.producerId ?? null,
      producerVersion: context.report?.version ?? null,
      producerModel: context.spec.producerOverrides?.model ?? null,
      durationMs: Math.max(0, context.now() - context.startedAtMs),
      sessionId: null,
    };
    const manifest = buildRunManifest({
      runId: context.runId,
      repoRoot: context.repoRoot,
      baseCommitOid: context.baseCommitOid,
      candidateManifestHash: context.candidate?.manifestHash ?? null,
      producer: {
        id: context.report?.producerId ?? null,
        version: context.report?.version ?? null,
        model: context.spec.producerOverrides?.model ?? null,
      },
      effectivePolicy: {
        ...(context.profile === null
          ? { routingFailure: failure }
          : {
            configurationProfile: context.profile,
            temporaryHomeApplied: context.temporaryHomeApplied,
          }),
        verificationPolicy: context.evidence.verificationPolicy ?? [],
      },
      repositoryInstructions: context.repositoryInstructions,
      prompt: context.invocation?.stdin ?? `${context.spec.objective}\n${context.spec.context}`,
      executionPolicy: {
        timeoutMs: context.spec.timeoutMs,
        network: context.invocation?.network ?? "not-started",
        writeAllowlist: context.spec.writeAllowlist,
        forbiddenScope: context.spec.forbiddenScope,
        probeCacheHits: context.probeCacheHits ?? 0,
      },
      environment: context.environment,
      packagedVerifier: context.packagedVerifier,
    });
    await context.store.writeManifest(manifest);
    await context.store.writeResult(result);
    return result;
  } finally {
    for (const registration of verificationSecretRegistrations) registration.dispose();
  }
}

async function cleanupAttemptResources(args: {
  builtEnvironment: BuiltEnvironment | null;
  worktree: { cleanup(): Promise<void> } | null;
  tempHome: string | null;
  lock: CheckoutLock | null;
}): Promise<unknown | null> {
  const failures: unknown[] = [];
  try {
    args.builtEnvironment?.secretRegistration.dispose();
  } catch (error) {
    failures.push(error);
  }
  if (args.worktree !== null) {
    try {
      await args.worktree.cleanup();
    } catch (error) {
      failures.push(error);
    }
  }
  if (args.tempHome !== null) {
    try {
      await rm(args.tempHome, { recursive: true, force: true });
    } catch (error) {
      failures.push(error);
    }
  }
  if (args.lock !== null) {
    try {
      await args.lock.release();
    } catch (error) {
      failures.push(error);
    }
  }
  return failures[0] ?? null;
}

export async function runAttempt(
  checkoutPath: string,
  spec: DelegationSpec,
  deps: AttemptRuntimeDependencies,
): Promise<AttemptResult> {
  if (hasEnvironmentMarker(deps.env ?? process.env)) throw new NestedDelegationError();

  const ps = deps.ps ?? getPlatformServices();
  const safety = new PlatformSafety(ps);
  const producerRegistry = deps.producerRegistry ?? registry;
  const now = deps.now ?? Date.now;
  const startedAtMs = now();
  const runId = (deps.runId ?? randomUUID)();
  const store = new ArtifactStore(runId);
  const inferredSlices = Array.isArray((spec as { slices?: unknown }).slices)
    ? (spec as { slices: unknown[] }).slices.length
    : 0;
  const statusContext = deps.runStatus ?? {
    mode: inferredSlices > 0 ? "sliced" as const : "single" as const,
    sliceIndex: inferredSlices > 0 ? 1 : null,
    sliceCount: inferredSlices > 0 ? inferredSlices : null,
    pipelineManaged: false,
  };
  const startedAt = new Date(startedAtMs).toISOString();
  const emitStatus = async (
    phase: RunStatusPhase,
    fields: Partial<Pick<RunStatus, "role" | "producerId" | "detail">> = {},
  ): Promise<void> => {
    await writeRunStatusSafely(store, {
      statusVersion: "1",
      runId,
      mode: statusContext.mode,
      phase,
      sliceIndex: statusContext.sliceIndex,
      sliceCount: statusContext.sliceCount,
      round: null,
      role: fields.role ?? null,
      producerId: fields.producerId ?? null,
      startedAt,
      updatedAt: new Date(now()).toISOString(),
      detail: fields.detail ?? null,
    });
  };
  const runtime = deps.producerRegistry !== undefined
    ? new ProducerRuntime(deps.producerRegistry)
    : producerRuntime;
  const archiveWithStatus = async (context: TerminalContext): Promise<AttemptResult> => {
    // Positive provenance for the decision gate: a plain `delegate` run never
    // enters a pipeline gate, so autonomy over its candidate must key on this
    // recorded marker, never on the mere absence of pipeline evidence.
    const effectiveContext: TerminalContext = {
      ...context,
      probeCacheHits: context.probeCacheHits ?? runtime.probeCacheHits,
    };
    const result = await archiveTerminal(statusContext.pipelineManaged
      ? effectiveContext
      : { ...effectiveContext, evidence: { ...context.evidence, plainDelegate: true } });
    if (!statusContext.pipelineManaged) {
      await emitStatus(result.status === "verified-candidate" ? "done" : "failed", {
        producerId: result.producerId,
        detail: result.summary,
      });
    }
    return result;
  };
  const canonical = await ps.canonicalizePath(checkoutPath);
  const repositoryIdentity = canonical.gitCommonDir ?? canonical.canonical;
  const runWithLease = async (lock: CheckoutLock, ownership: "borrowed" | "owned"): Promise<AttemptResult> => {
    let worktree: { path: string; cleanup(): Promise<void> } | null = null;
    let tempHome: string | null = null;
    let builtEnvironment: BuiltEnvironment | null = null;
    let primaryError: unknown;
    let archivedResult: AttemptResult | null = null;
    try {

    if (lock.repositoryIdentity !== repositoryIdentity) {
      throw new RuntimeError(`${ownership} checkout lease repository identity mismatch`);
    }
    const preconditions = await checkPreconditions(canonical.canonical, {
      writeAllowlist: spec.writeAllowlist,
    });
    if (!preconditions.ok) {
      const detailSuffix = preconditions.detail === undefined
        ? ""
        : `: ${preconditions.detail.join(", ")}`;
      throw new RuntimeError(
        `repository precondition failed (${preconditions.reason})${detailSuffix}`,
        { reason: preconditions.reason, detail: preconditions.detail ?? [] },
      );
    }

    // Correlation must exist before any long phase can be interrupted. This
    // record used to be written after baseline verification and Producer
    // selection, so a run killed during either left log files with nothing
    // naming the run, its lock, or its spec.
    const runStart: RunStartRecord = {
      runId,
      lockKey: lock.key,
      canonicalCommonDir: preconditions.gitCommonDir,
      pid: null,
      processToken: null,
      startedAt,
      specSha256: deps.dispatchedSpecSha256 ?? specSha256(spec),
    };
    const runStartContext = await initializeRunStart(store, runStart);
    await deps.onRunStart?.(runStartContext);
    if (!statusContext.pipelineManaged) await emitStatus("preflight");

    const collected = deps.repositoryInstructions !== undefined
      && deps.packagedVerifier !== undefined
      ? null
      : await (deps.reproducibilityCollector ?? collectReproducibilityInputs)(
        canonical.canonical,
        preconditions.baseCommitOid,
      );
    const repositoryInstructions = deps.repositoryInstructions
      ?? collected!.repositoryInstructions;
    const packagedVerifier = deps.packagedVerifier ?? collected!.packagedVerifier;

  const executionMode = (spec as { executionMode: string }).executionMode;
  let baselineEvidence: Record<string, unknown> = { baseline: "skipped — read-only spec" };
  if (!statusContext.pipelineManaged) {
    await emitStatus("baseline-verify", {
      detail: executionMode === "edit" ? null : "skipped for read-only execution",
    });
  }
  if (executionMode === "edit") {
    await reportPhase(deps, "verifying baseline");
    let baseline;
    try {
      baseline = await (deps.baselineVerifier ?? verifyBaseline)({
        repoRoot: canonical.canonical,
        headCommitOid: preconditions.baseCommitOid,
        commands: spec.verification,
        ps,
        runId,
        store,
        borrowedCheckoutLease: lock,
        ...(deps.abortSignal === undefined ? {} : { abortSignal: deps.abortSignal }),
      });
    } catch (error) {
      if (!deps.abortSignal?.aborted) throw error;
      return archiveWithStatus({
        store, spec, runId, startedAtMs, now,
        repoRoot: canonical.canonical, baseCommitOid: preconditions.baseCommitOid,
        signals: { cancelled: true }, report: null, profile: null, invocation: null,
        environment: [], temporaryHomeApplied: false, producerSummary: null,
        candidate: null, commandOutcomes: [], unresolvedIssues: ["cancelled"],
        evidence: { baseline: "cancelled" }, producerLog: producerLog(null),
        repositoryInstructions, packagedVerifier,
      });
    }
    baselineEvidence = { baseline };
    // Cancellation that fired while the baseline ran but let it return without
    // throwing is honored by the existing pre-producer-spawn abort check, which
    // archives run-start first; no separate early return is needed here.
    const baselineFailed = baseline.commands.some(command => !command.ok);
    if (baselineFailed) {
      return archiveWithStatus({
        store, spec, runId, startedAtMs, now,
        repoRoot: canonical.canonical, baseCommitOid: preconditions.baseCommitOid,
        signals: { "environment-defect": true }, report: null, profile: null, invocation: null,
        environment: [], temporaryHomeApplied: false, producerSummary: null,
        candidate: null, commandOutcomes: [], unresolvedIssues: ["baseline-verification-failed"],
        evidence: baselineEvidence, producerLog: producerLog(null),
        repositoryInstructions, packagedVerifier,
      });
    }
  }

  await reportPhase(deps, "probing producers");
  const reports = await runtime.probeAll({
    ps,
    os: ps.os,
    arch: process.arch,
    environmentType: detectEnvironmentType(),
  }, undefined, producerRegistry);
  const routing = route(spec.producerPreferences, reports);
  if (routing.producerId === null) {
    const signals: FailureSignals = routing.reason === "authentication-required"
      ? { "authentication-required": true }
      : { unavailable: true };
    return archiveWithStatus({
      store,
      spec,
      runId,
      startedAtMs,
      now,
      repoRoot: canonical.canonical,
      baseCommitOid: preconditions.baseCommitOid,
      signals,
      report: null,
      profile: null,
      invocation: null,
      environment: [],
      temporaryHomeApplied: false,
      producerSummary: null,
      candidate: null,
      commandOutcomes: [],
      unresolvedIssues: [
        routing.reason,
        ...routing.considered.map(candidate =>
          `producer ${candidate.producerId}: ${candidate.outcome}${candidate.detail === null ? "" : ` (${candidate.detail})`}`),
      ],
      evidence: { ...baselineEvidence, routing: routing.reason, considered: routing.considered, reports },
      producerLog: producerLog(null),
      repositoryInstructions,
      packagedVerifier,
    });
  }

  const adapter: ProducerAdapter | undefined = producerRegistry.get(routing.producerId);
  const report = reports.find(candidate => candidate.producerId === routing.producerId) ?? null;
  if (adapter === undefined || report?.resolvedExecutable === null || report === null) {
    return archiveWithStatus({
      store,
      spec,
      runId,
      startedAtMs,
      now,
      repoRoot: canonical.canonical,
      baseCommitOid: preconditions.baseCommitOid,
      signals: { unavailable: true },
      report,
      profile: null,
      invocation: null,
      environment: [],
      temporaryHomeApplied: false,
      producerSummary: null,
      candidate: null,
      commandOutcomes: [],
      unresolvedIssues: ["selected-producer-contract-invalid"],
      evidence: { ...baselineEvidence, routing: "selected-producer-contract-invalid" },
      producerLog: producerLog(null),
      repositoryInstructions,
      packagedVerifier,
    });
  }

    worktree = await new WorktreeManager(canonical.canonical, runId, ps, {
      borrowedCheckoutLease: lock,
    }).create(preconditions.baseCommitOid);
    const profile = adapter.configurationProfile();
    const launchPlan = await runtime.planLaunch({
      producerId: report.producerId,
      adapter,
      spec,
      worktreePath: worktree.path,
      intent: spec.executionMode === "edit" ? "edit" : "read-only",
      ps,
      runId,
      capabilityReport: report,
    });
    tempHome = launchPlan.tempHome;
    builtEnvironment = launchPlan.builtEnvironment;
    let invocation = launchPlan.invocation;
    let confinement: string | null = launchPlan.confinementBackend;

    if (spec.executionMode === "edit") {
      const selection = selectSandboxBackend(report);
      if (selection.backend === null) {
        return await archiveWithStatus({
          store,
          spec,
          runId,
          startedAtMs,
          now,
          repoRoot: canonical.canonical,
          baseCommitOid: preconditions.baseCommitOid,
          signals: { unavailable: true },
          report,
          profile,
          invocation,
          environment: [],
          temporaryHomeApplied: tempHome !== null,
          producerSummary: null,
          candidate: null,
          commandOutcomes: [],
          unresolvedIssues: [selection.reason],
          evidence: { routing: selection.reason },
          producerLog: producerLog(null),
          repositoryInstructions,
          packagedVerifier,
        });
      }
    }
    if (spec.executionMode === "edit" && deps.producerPreflight !== false) {
      // A second preflight, not a regression to the first: this one launches the
      // Producer to probe its environment and can run for minutes, so it needs a
      // durable status of its own. The detail is what tells the two apart.
      if (!statusContext.pipelineManaged) {
        await emitStatus("preflight", {
          producerId: report.producerId,
          detail: "probing producer environment",
        });
      }
      await reportPhase(deps, "probing producer environment");
      const preflight = await (typeof deps.producerPreflight === "function"
        ? deps.producerPreflight
        : runProducerPreflight)({
        adapter,
        capabilityReport: report,
        spec,
        repoRoot: canonical.canonical,
        baseCommitOid: preconditions.baseCommitOid,
        runId,
        ps,
        tempHome,
        borrowedCheckoutLease: lock,
        ...(deps.abortSignal === undefined ? {} : { abortSignal: deps.abortSignal }),
      });
      baselineEvidence = { ...baselineEvidence, producerPreflight: preflight };
      if (preflight.status === "environment-defect") {
        return await archiveWithStatus({
          store,
          spec,
          runId,
          startedAtMs,
          now,
          repoRoot: canonical.canonical,
          baseCommitOid: preconditions.baseCommitOid,
          signals: { "environment-defect": true },
          report,
          profile,
          invocation,
          environment: [],
          temporaryHomeApplied: tempHome !== null,
          producerSummary: null,
          candidate: null,
          commandOutcomes: [],
          unresolvedIssues: ["producer-preflight-failed", preflight.reason ?? ""],
          evidence: baselineEvidence,
          producerLog: producerLog(null),
          repositoryInstructions,
          packagedVerifier,
        });
      }
    }
    if (!statusContext.pipelineManaged) {
      await emitStatus("implementing", { producerId: report.producerId });
    }
    await reportPhase(deps, "producer running");
    const launchResult = await runtime.launch({
      producerId: report.producerId,
      adapter,
      spec,
      worktreePath: worktree.path,
      intent: spec.executionMode === "edit" ? "edit" : "read-only",
      ps,
      runId,
      tempHome,
      abortSignal: deps.abortSignal,
      timeoutMs: spec.timeoutMs,
      runStartContext,
      capabilityReport: report,
      plan: launchPlan,
    });
    invocation = launchResult.invocation;
    builtEnvironment = launchResult.builtEnvironment;
    const exit = launchResult.exit;
    confinement = launchResult.confinementBackend;

    const signals: FailureSignals = {};
    let producerSummary: string | null = null;
    let candidate: CandidateArtifact | null = null;
    let commandOutcomes: CommandOutcome[] = [];
    let unresolvedIssues: string[] = [];
    let evidence: Record<string, unknown> = confinement === null
      ? baselineEvidence
      : { ...baselineEvidence, confinement };
    if (exit.spawnError !== undefined) signals["spawn-failure"] = true;
    if (exit.cancelled) signals.cancelled = true;
    if (exit.timedOut) signals.timeout = true;

    if (!hasFailureSignal(signals)) {
      producerSummary = launchResult.producerSummary;
      if (!launchResult.ok) signals["invalid-output"] = true;
      if (exit.exitCode !== 0) signals["producer-failure"] = true;
    }

    if (!hasFailureSignal(signals)) {
      if (!statusContext.pipelineManaged) {
        await emitStatus("freezing", { producerId: report.producerId });
      }
      await reportPhase(deps, "freezing candidate");
      const frozen = await freezeCandidate({
        repoRoot: canonical.canonical,
        worktreePath: worktree.path,
        baseCommitOid: preconditions.baseCommitOid,
        runId,
        writeAllowlist: spec.writeAllowlist,
        forbiddenScope: spec.forbiddenScope,
      });
      if (!frozen.ok) {
        if (frozen.reason === "empty-candidate") signals["verification-failure"] = true;
        else signals["sandbox-violation"] = true;
        unresolvedIssues = [frozen.reason];
        evidence = {
          ...evidence,
          freezeReject: frozen.reason,
          ...(frozen.paths === undefined ? {} : { freezeRejectPaths: frozen.paths }),
        };
      } else {
        candidate = frozen.artifact;
        evidence = { ...evidence, ...frozen.evidence };
        try {
          if (!statusContext.pipelineManaged) {
            await emitStatus("verifying", { producerId: report.producerId });
          }
          await reportPhase(deps, "verifying candidate");
          const verification = await deps.verifier.verify({
            repoRoot: canonical.canonical,
            worktreePath: worktree.path,
            baseCommitOid: preconditions.baseCommitOid,
            artifact: frozen.artifact,
            spec,
            ps,
            artifactStore: store,
            borrowedCheckoutLease: lock,
          });
          commandOutcomes = verification.commandOutcomes;
          unresolvedIssues = verification.failures;
          evidence = { ...evidence, ...verification.evidence };
          if (!verification.ok) signals["verification-failure"] = true;
        } catch {
          signals["verification-failure"] = true;
          unresolvedIssues = ["verifier-error"];
          evidence = { ...evidence, verifierError: true };
        }
      }
    }

    if (!hasFailureSignal(signals) && candidate === null) {
      signals["verification-failure"] = true;
      unresolvedIssues.push("missing-candidate");
    }

    if (candidate === null && worktree !== null && (signals.timeout === true || signals.cancelled === true)) {
      try {
        evidence = { ...evidence, worktreeSnapshot: await captureWorktreeSnapshot(worktree.path) };
      } catch (snapshotError) {
        evidence = {
          ...evidence,
          worktreeSnapshotError: snapshotError instanceof Error ? snapshotError.message : String(snapshotError),
        };
      }
    }

    await reportPhase(deps, "archiving result");
    archivedResult = await archiveWithStatus({
      store,
      spec,
      runId,
      startedAtMs,
      now,
      repoRoot: canonical.canonical,
      baseCommitOid: preconditions.baseCommitOid,
      signals,
      report,
      profile,
      invocation,
      environment: builtEnvironment.provenance,
      temporaryHomeApplied: tempHome !== null,
      producerSummary,
      candidate,
      commandOutcomes,
      unresolvedIssues,
      evidence,
      producerLog: producerLog(exit),
      repositoryInstructions,
      packagedVerifier,
    });
    // archiveWithStatus already recorded the terminal RunStatus; this is the
    // host-facing echo of it.
    await reportPhase(deps, `finished: ${archivedResult.status}`);
    return archivedResult;
  } catch (error) {
    primaryError = error;
    // Guarded like every other status site: for a pipeline-managed run the
    // pipeline owns the terminal status and writes `failed` itself, and writing
    // it here too resets round/role from this thinner context.
    if (!statusContext.pipelineManaged) {
      await emitStatus("failed", {
        detail: error instanceof Error ? error.message : "attempt failed unexpectedly",
      });
    }
    throw error;
  } finally {
    const cleanupError = await cleanupAttemptResources({
      builtEnvironment,
      worktree,
      tempHome,
      lock: null,
    });
    if (cleanupError !== null) {
      const detail = redact(
        cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
      );
      logger.warn("attempt resources could not be cleaned up", { error: detail });
      if (archivedResult !== null) {
        // The attempt reached a terminal result; a failure to tidy up afterwards
        // must be recorded, not substituted for that outcome. The caller holds
        // this exact object, so amending it in place keeps what it sees honest,
        // and the durable record goes beside the archive rather than rewriting
        // it — terminal artifacts are immutable by design.
        archivedResult.evidence = { ...archivedResult.evidence, cleanupFailure: detail };
        archivedResult.unresolvedIssues = [
          ...archivedResult.unresolvedIssues,
          "attempt-cleanup-failed",
        ];
        try {
          await store.writeLog("cleanup-failure", `${detail}\n`);
        } catch (writeError) {
          // The in-memory result already carries the failure; a second write
          // error must not replace the outcome either — but it must be visible.
          logger.warn("cleanup failure could not be archived", {
            error: redact(writeError instanceof Error ? writeError.message : String(writeError)),
          });
        }
      } else if (primaryError === undefined) {
        throw cleanupError;
      }
    }
  }
};



  if (deps.borrowedCheckoutLease !== undefined && deps.borrowedCheckoutLease !== null) {
    return await runWithLease(deps.borrowedCheckoutLease, "borrowed");
  }
  return await safety.withCheckoutLease(canonical.canonical, async (acquiredLock) => {
    return await runWithLease(acquiredLock, "owned");
  }, { runId });
}

