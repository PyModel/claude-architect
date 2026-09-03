import path from "node:path";
import { git, type GitExecOptions, type GitResult } from "../git/git-exec.js";
import { WorktreeManager, cleanupWorktree } from "../runtime/worktree-manager.js";
import { PlatformSafety } from "../platform/platform-safety.js";
import type { ProducerRuntime } from "../producers/producer-runtime.js";
import type { RunDecision } from "../runtime/run-decision.js";
import type { CheckoutLock, PlatformServices } from "../platform/platform-services.js";
import { getPlatformServices } from "../platform/select-platform.js";
import type {
  CandidateArtifact,
  AttemptResult,
  CommandOutcome,
  FailureClassification,
} from "../protocol/attempt-result.js";
import type { PipelineGateCleared } from "../protocol/pipeline-gate-cleared.js";
import {
  resolveImplementationConfig,
  resolveReviewConfig,
  resolveSliceConcurrency,
  resolveSlices,
  type DelegationSpec,
  type ReviewerKind,
} from "../protocol/delegation-spec.js";
import { specSha256 } from "../protocol/spec-hash.js";
import { loadSchemas } from "../protocol/schema-loader.js";
import type { ProducerRegistry } from "../producers/producer-registry.js";
import {
  runAttempt as defaultRunAttempt,
  type AttemptRuntimeDependencies,
} from "../runtime/attempt-runtime.js";
import {
  ArtifactStore,
  type PipelineActiveMarker,
} from "../runtime/artifact-store.js";
import { redact, redactRecord } from "../runtime/redaction.js";
import { logger } from "../util/logger.js";
import type { RunStartContext } from "../runtime/run-start.js";
import {
  transitionRunStatusSafely,
  writeRunStatusSafely,
} from "../runtime/run-status.js";
import { RuntimeError } from "../util/errors.js";
import {
  recomputeManifest,
} from "../verify/structural-verifier.js";
import { consolidate, detectNonConvergence, type ConsolidationResult } from "./consolidator.js";
import { evaluateGates, type GateResult, type IncrementOutcome } from "./gates.js";
import type {
  FixReport,
  IncrementReport,
  ReviewReport,
  VerificationReport,
} from "./report-types.js";
import type { RolePackage } from "./role-prompts.js";
import type { RoleRunArgs, RoleRunResult } from "./role-runner.js";
import {
  SliceRunner,
  SliceExecutionError,
  findSliceExecutionError,
  scopeSpecToSlice,
  cleanupTemporarySliceRefs,
  sliceTestEvidence,
  testEvidence,
  runSliceReview,
  type PipelineSlice,
  type SlicePhaseResult,
  type TemporarySliceRef,
  type ReviewConfig,
} from "./slice-runner.js";
import {
  verifyCandidate,
  detectWeakenedTests,
} from "./candidate-verifier.js";
import {
  importPromotedObjects,
  validateCandidateProvenance,
  validateFixProvenance,
  privateObjectReadOptions,
} from "./candidate-provenance.js";
import {
  runIncrement,
  runReviews,
  runFix,
} from "./pipeline-roles.js";
import {
  createRunContext,
  type RunContext,
} from "./run-context.js";
import {
  resolveLinkedWorktreeWritableRoots,
  type LinkedWorktreeGitAccess,
} from "./git-writable-roots.js";
import { runAdvisorStage as bundledAdvisorStage } from "./advisor-stage.js";

export {
  scopeSpecToSlice,
  runIncrement,
  runReviews,
  verifyCandidate,
  detectWeakenedTests,
  SliceRunner,
  type ReviewConfig,
};

export interface PipelineRound {
  round: number;
  reviews: { reviewer: string; report: ReviewReport }[];
  consolidated: ConsolidationResult;
  fix: FixReport | null;
  roleLogRefs: string[];
}

export interface PipelineIncrement {
  increment: number;
  report: IncrementReport;
  roleLogRefs: string[];
}

export interface PipelineResult {
  runId: string;
  status: "decision-ready" | "human-decision-required" | "failed";
  attempt: AttemptResult;
  increments: PipelineIncrement[];
  slices: PipelineSlice[];
  haltedSliceIndex: number | null;
  rounds: PipelineRound[];
  verification: PipelineVerificationReport | null;
  gate: GateResult;
  finalCandidateCommit: string;
  failure?: FailureClassification | null;
  pipelineGateCleared?: PipelineGateCleared | null;
}

export interface PipelineVerificationEvidence {
  failures: string[];
  acceptance: Record<string, unknown>;
  commandOutcomes: CommandOutcome[];
  authorizedTestDeletions?: string[];
}

export interface PipelineVerificationReport extends VerificationReport {
  evidence: PipelineVerificationEvidence;
}

export interface PipelineDependencies extends AttemptRuntimeDependencies {
  registry: ProducerRegistry;
  roleRunner?: (args: RoleRunArgs) => Promise<RoleRunResult>;
  // SliceRunner seams. Every production caller omits them so the runner binds
  // its own singletons; a test supplies one to observe a single subsystem
  // without standing up the rest.
  producerRuntime?: ProducerRuntime | undefined;
  runDecision?: RunDecision | undefined;
  platformSafety?: PlatformSafety | undefined;
  runRole?: ((args: RoleRunArgs) => Promise<RoleRunResult>) | undefined;
  runAttempt?: (
    checkoutPath: string,
    spec: DelegationSpec,
    deps: AttemptRuntimeDependencies,
  ) => Promise<AttemptResult>;
}

const schemas = loadSchemas();
const CANDIDATE_REF_PREFIX = "refs/claude-architect/candidates/";



function gitFailure(action: string, result: GitResult): RuntimeError {
  const diagnostic = (result.stderr || result.stdout).trim().slice(0, 2_000);
  return new RuntimeError(`${action} failed${diagnostic ? `: ${diagnostic}` : ""}`);
}

async function checkedGit(
  cwd: string,
  args: string[],
  options?: GitExecOptions,
): Promise<string> {
  const result = await git(cwd, args, options);
  if (result.exitCode !== 0) throw gitFailure(`git ${args[0] ?? "command"}`, result);
  return result.stdout;
}



function failedResult(
  attempt: AttemptResult,
  rounds: PipelineRound[],
  finalCandidateCommit: string,
  reason: string,
  failure: FailureClassification = "producer-failure",
  increments: PipelineIncrement[] = [],
  slices: PipelineSlice[] = [],
  haltedSliceIndex: number | null = null,
): PipelineResult {
  return {
    runId: attempt.runId,
    status: "failed",
    attempt,
    increments,
    slices,
    haltedSliceIndex,
    rounds,
    verification: null,
    gate: {
      decisionReady: false,
      requiresHumanDecision: false,
      reasons: [reason],
    },
    finalCandidateCommit,
    failure,
  };
}

const MAX_PROGRESS_NOTES_LENGTH = 8_000;
const PROGRESS_TRUNCATION_NOTE = "\n\n[progress notes truncated]";

export function composeProgressNotes(
  previous: IncrementReport | { producerSummary: string | null; summary: string },
): string {
  const summary = "producerSummary" in previous
    ? previous.producerSummary ?? previous.summary
    : previous.summary;
  const nextSteps = "nextSteps" in previous ? previous.nextSteps : undefined;
  const rendered = redact([
    `Summary:\n${summary}`,
    ...(nextSteps === undefined ? [] : [`Next steps:\n${nextSteps}`]),
  ].join("\n\n"));
  if (rendered.length <= MAX_PROGRESS_NOTES_LENGTH) return rendered;
  return `${rendered.slice(
    0,
    MAX_PROGRESS_NOTES_LENGTH - PROGRESS_TRUNCATION_NOTE.length,
  )}${PROGRESS_TRUNCATION_NOTE}`;
}


function attemptLogRefs(attempt: AttemptResult): string[] {
  return [...new Set([
    attempt.logsRef,
    ...attempt.executedVerification.flatMap(outcome => [outcome.stdoutRef, outcome.stderrRef]),
  ])];
}

class SlicedFailureArchiveError extends RuntimeError {
  constructor(readonly cause: unknown) {
    super(cause instanceof Error ? cause.message : "sliced failure archival failed");
    this.name = "SlicedFailureArchiveError";
  }
}


function containsSlicedFailureArchiveError(error: unknown): boolean {
  if (error instanceof SlicedFailureArchiveError) return true;
  if (!(error instanceof AggregateError)) return false;
  return error.errors.some(containsSlicedFailureArchiveError);
}

function failedAttemptStatus(failure: FailureClassification): AttemptResult["status"] {
  if (failure === "unavailable" || failure === "authentication-required") return "unavailable";
  if (failure === "cancelled") return "cancelled";
  return "failed";
}

async function archiveSlicedFailure(args: {
  checkoutPath: string;
  attempt: AttemptResult;
  failure: FailureClassification;
  reason: string;
  store: ArtifactStore;
}): Promise<AttemptResult> {
  try {
    const manifest = await args.store.readManifest();
    if (manifest === null) {
      throw new RuntimeError("run manifest is missing while archiving sliced failure");
    }
    const retainCandidate = args.failure === "verification-failure";
    if (!retainCandidate && args.attempt.candidate !== null) {
      const candidate = args.attempt.candidate;
      const expectedRef = `${CANDIDATE_REF_PREFIX}${args.attempt.runId}`;
      if (candidate.anchorRef !== expectedRef) {
        throw new RuntimeError("sliced candidate anchor does not match run id");
      }
      const deleted = await git(args.checkoutPath, [
        "update-ref",
        "--no-deref",
        "-d",
        candidate.anchorRef,
        candidate.candidateCommitOid,
      ]);
      if (deleted.exitCode !== 0) throw gitFailure("delete sliced candidate anchor", deleted);
    }
    const failedAttempt: AttemptResult = {
      ...args.attempt,
      status: failedAttemptStatus(args.failure),
      failure: args.failure,
      summary: args.reason,
      candidate: retainCandidate ? args.attempt.candidate : null,
      unresolvedIssues: [...args.attempt.unresolvedIssues, args.reason],
      evidence: {
        ...args.attempt.evidence,
        pipelineFailure: { failure: args.failure, reason: args.reason },
      },
    };
    await args.store.promoteTerminalArtifacts({ result: failedAttempt, manifest });
    return failedAttempt;
  } catch (error) {
    if (error instanceof SlicedFailureArchiveError) throw error;
    throw new SlicedFailureArchiveError(error);
  }
}

async function archiveSliceExecutionError(args: {
  checkoutPath: string;
  error: unknown;
  attempt: AttemptResult;
  store: ArtifactStore;
}): Promise<{ sliceError: SliceExecutionError; failedAttempt: AttemptResult }> {
  const sliceError = findSliceExecutionError(args.error);
  if (sliceError === null) throw args.error;
  try {
    return {
      sliceError,
      failedAttempt: await archiveSlicedFailure({
        checkoutPath: args.checkoutPath,
        attempt: args.attempt,
        failure: sliceError.failure,
        reason: sliceError.message,
        store: args.store,
      }),
    };
  } catch (archiveError) {
    throw new AggregateError(
      [args.error, archiveError],
      "sliced pipeline failed and its attempt result could not be archived",
    );
  }
}

async function candidateArtifact(args: {
  worktreePath: string;
  baselineCommit: string;
  candidateCommit: string;
  anchorRef: string;
  diffText: string;
}): Promise<CandidateArtifact> {
  const artifact: CandidateArtifact = {
    baseCommitOid: args.baselineCommit,
    candidateTreeOid: (await checkedGit(
      args.worktreePath,
      ["rev-parse", `${args.candidateCommit}^{tree}`],
    )).trim(),
    candidateCommitOid: args.candidateCommit,
    anchorRef: args.anchorRef,
    manifestHash: "",
    changedPaths: [],
    patch: args.diffText,
  };
  const canonical = await recomputeManifest({
    worktreePath: args.worktreePath,
    baseCommitOid: args.baselineCommit,
    artifact,
  });
  if (canonical.manifestHash === null) {
    throw new RuntimeError("final candidate paths collide under case folding");
  }
  return {
    ...artifact,
    changedPaths: canonical.changedPaths,
    manifestHash: canonical.manifestHash,
  };
}

async function promoteFinalCandidate(args: {
  checkoutPath: string;
  attempt: AttemptResult;
  initialCandidate: CandidateArtifact;
  baselineCommit: string;
  candidateCommit: string;
  store: ArtifactStore;
  privateObjectAccess?: LinkedWorktreeGitAccess;
}): Promise<{ attempt: AttemptResult; candidateCommit: string } | null> {
  let canonicalCommit: string;
  try {
    const objectReadOptions = args.privateObjectAccess === undefined
      ? undefined
      : privateObjectReadOptions(args.privateObjectAccess);
    const finalTree = (await checkedGit(
      args.checkoutPath,
      ["rev-parse", `${args.candidateCommit}^{tree}`],
      objectReadOptions,
    )).trim();
    canonicalCommit = (await checkedGit(args.checkoutPath, [
      "commit-tree",
      finalTree,
      "-p",
      args.baselineCommit,
      "-m",
      `candidate ${args.attempt.runId}`,
    ], objectReadOptions)).trim();
    if (args.privateObjectAccess !== undefined) {
      await importPromotedObjects({
        checkoutPath: args.checkoutPath,
        baselineCommit: args.baselineCommit,
        promotedCommit: canonicalCommit,
        access: args.privateObjectAccess,
      });
    }
  } catch {
    return null;
  }
  await checkedGit(args.checkoutPath, [
    "update-ref",
    args.initialCandidate.anchorRef,
    canonicalCommit,
    args.initialCandidate.candidateCommitOid,
  ]);
  const diffText = await checkedGit(
    args.checkoutPath,
    ["diff", `${args.baselineCommit}..${canonicalCommit}`],
  );
  const candidate = await candidateArtifact({
    worktreePath: args.checkoutPath,
    baselineCommit: args.baselineCommit,
    candidateCommit: canonicalCommit,
    anchorRef: args.initialCandidate.anchorRef,
    diffText,
  });
  const manifest = await args.store.readManifest();
  if (manifest === null) throw new RuntimeError("run manifest is missing during promotion");
  const finalAttempt = { ...args.attempt, candidate };
  await args.store.promoteTerminalArtifacts({
    result: finalAttempt,
    manifest: { ...manifest, candidateManifestHash: candidate.manifestHash },
  });
  return { attempt: finalAttempt, candidateCommit: canonicalCommit };
}



export async function runPipeline(
  checkoutPath: string,
  spec: DelegationSpec,
  deps: PipelineDependencies,
): Promise<PipelineResult> {
  const ps = deps.ps ?? getPlatformServices();
  const canonical = await ps.canonicalizePath(checkoutPath);
  const safety = new PlatformSafety(ps);
  return await safety.withCheckoutLease(canonical.canonical, async (lock) => {
    const guardedDependencies: PipelineDependencies = {
      ...deps,
      ps,
      borrowedCheckoutLease: lock,
    };
    const result = await runPipelineWithLease(
      checkoutPath,
      spec,
      guardedDependencies,
      ps,
      lock,
    );
    await transitionRunStatusSafely(
      new ArtifactStore(result.runId),
      result.runId,
      result.status === "failed" ? "failed" : "done",
      {
        round: null,
        role: null,
        producerId: result.attempt.producerId,
        detail: result.status,
      },
    );
    return result;
  });
}


// The packaged single-file runtime must retain every trusted pipeline stage,
// including the separately invoked post-pipeline advisor entrypoint.
Object.defineProperty(runPipeline, "advisorStage", {
  value: bundledAdvisorStage,
  enumerable: false,
  configurable: false,
  writable: false,
});

/**
 * Everything a pipeline run accumulates once its initial attempt has verified.
 * One explicit value travels through the phase functions below, so no phase
 * reads or writes another phase's closure, and `finally` sees the same facts
 * the phases left behind.
 */
interface PipelineRunState {
  readonly attempt: AttemptResult;
  readonly initialCandidate: CandidateArtifact;
  readonly baselineCommit: string;
  readonly sliced: boolean;
  readonly rounds: PipelineRound[];
  readonly increments: PipelineIncrement[];
  finalAttempt: AttemptResult;
  currentCandidateCommit: string;
  pipelineSlices: PipelineSlice[];
  incrementOutcome: IncrementOutcome | undefined;
  gitObjectAccess: LinkedWorktreeGitAccess | null;
  frozenTestEvidence: string;
  authoritySafeToRelease: boolean;
}

type PhaseOutcome =
  | { state: "continue" }
  | { state: "terminal"; result: PipelineResult };

const CONTINUE: PhaseOutcome = { state: "continue" };

function terminal(result: PipelineResult): PhaseOutcome {
  return { state: "terminal", result };
}

/** A failure recorded against the initial attempt at the current candidate. */
function failedAtCurrentCandidate(
  state: PipelineRunState,
  reason: string,
  failure: FailureClassification,
): PipelineResult {
  return failedResult(
    state.attempt,
    state.rounds,
    state.currentCandidateCommit,
    reason,
    failure,
    state.increments,
    state.pipelineSlices,
  );
}

async function archivePipelineFailure(
  context: RunContext,
  state: PipelineRunState,
  args: {
    reason: string;
    failure: FailureClassification;
    slices?: PipelineSlice[];
    haltedSliceIndex?: number | null;
  },
): Promise<PipelineResult> {
  const failedAttempt = state.sliced
    ? await archiveSlicedFailure({
      checkoutPath: context.checkoutPath,
      attempt: state.attempt,
      failure: args.failure,
      reason: args.reason,
      store: context.store,
    })
    : state.attempt;
  if (state.sliced) state.authoritySafeToRelease = true;
  state.finalAttempt = failedAttempt;
  return failedResult(
    failedAttempt,
    state.rounds,
    state.currentCandidateCommit,
    args.reason,
    args.failure,
    state.increments,
    args.slices ?? state.pipelineSlices,
    args.haltedSliceIndex ?? null,
  );
}

/**
 * A role that cannot produce parseable structured output is an orchestration
 * failure, not a verdict on the candidate. Discarding independently verified
 * bytes for it forces a full re-dispatch of work that already passed — the
 * single most expensive recurring loss in the delegation loop. Promote and
 * re-verify what exists; present it for the human decision the pipeline could
 * not complete itself. Only a candidate that fails verification is discarded.
 */
async function salvagePipelineFailure(
  context: RunContext,
  deps: PipelineDependencies,
  state: PipelineRunState,
  args: { reason: string; failure: FailureClassification },
): Promise<PipelineResult> {
  const { checkoutPath, spec, store } = context;
  const fallback = async (): Promise<PipelineResult> => archivePipelineFailure(context, state, args);
  if (state.finalAttempt.candidate === null) return await fallback();

  let salvagedAttempt = state.finalAttempt;
  let salvagedCommit = state.currentCandidateCommit;
  if (salvagedCommit !== state.finalAttempt.candidate.candidateCommitOid) {
    const promoted = await promoteFinalCandidate({
      checkoutPath,
      attempt: state.finalAttempt,
      initialCandidate: state.finalAttempt.candidate,
      baselineCommit: state.baselineCommit,
      candidateCommit: salvagedCommit,
      store,
      ...(state.gitObjectAccess === null
        ? {}
        : { privateObjectAccess: state.gitObjectAccess }),
    });
    if (promoted === null) return await fallback();
    salvagedAttempt = promoted.attempt;
    salvagedCommit = promoted.candidateCommit;
  }
  if (state.sliced) state.authoritySafeToRelease = true;

  let verified;
  try {
    verified = await verifyCandidate({
      checkoutPath,
      spec,
      deps,
      attempt: salvagedAttempt,
      baselineCommit: state.baselineCommit,
      candidateCommit: salvagedCommit,
      store,
      namespace: "salvage",
    });
  } catch {
    return await fallback();
  }
  const manifestForArchive = await store.readManifest();
  if (manifestForArchive === null) return await fallback();
  if (!verified.verification.pass) {
    // The freshest evidence says these bytes do not verify. Record that where
    // the accept gate reads it, or the archived run keeps advertising the
    // stale verified-candidate status and stays acceptable. The bytes are
    // retained; only their acceptability is withdrawn.
    const demoted: AttemptResult = {
      ...salvagedAttempt,
      status: "failed",
      failure: "verification-failure",
      summary: args.reason,
      unresolvedIssues: [
        ...salvagedAttempt.unresolvedIssues,
        args.reason,
        "salvage re-verification failed",
      ],
      evidence: {
        ...salvagedAttempt.evidence,
        pipelineFailure: { failure: args.failure, reason: args.reason },
      },
    };
    await store.promoteTerminalArtifacts({ result: demoted, manifest: manifestForArchive });
    state.finalAttempt = demoted;
    await store.writePipelineArtifact("verification", verified.verification);
    const failed = failedResult(
      demoted,
      state.rounds,
      salvagedCommit,
      args.reason,
      args.failure,
      state.increments,
      state.pipelineSlices,
    );
    await store.writePipelineArtifact("pipeline-result", failed);
    return failed;
  }

  // A human reading the archived run later must be able to see that the
  // pipeline never reviewed this candidate. Record that durably in the
  // result the accept path reads, not only in the transient gate.
  salvagedAttempt = {
    ...salvagedAttempt,
    evidence: {
      ...salvagedAttempt.evidence,
      pipelineReviewIncomplete: { failure: args.failure, reason: args.reason },
    },
  };
  await store.promoteTerminalArtifacts({
    result: salvagedAttempt,
    manifest: manifestForArchive,
  });

  state.finalAttempt = salvagedAttempt;
  await store.writePipelineArtifact("verification", verified.verification);
  const salvaged: PipelineResult = {
    runId: state.attempt.runId,
    status: "human-decision-required",
    attempt: salvagedAttempt,
    increments: state.increments,
    slices: state.pipelineSlices,
    haltedSliceIndex: null,
    rounds: state.rounds,
    verification: verified.verification,
    gate: {
      decisionReady: false,
      requiresHumanDecision: true,
      reasons: [
        args.reason,
        "the candidate passed independent verification; the pipeline could not"
        + " complete its own review, so the whole-branch review is the human's",
      ],
    },
    finalCandidateCommit: salvagedCommit,
    failure: null,
  };
  await store.writePipelineArtifact("pipeline-result", salvaged);
  return salvaged;
}

/**
 * A slice wave that halted before every slice landed. With nothing past the
 * baseline there is no partial branch to offer, so the halt is a failure;
 * otherwise the advanced slices are promoted to a frozen candidate and the
 * halt is handed to the human. Review rounds are skipped; final verification
 * runs so the human sees an honest report on the exact partial branch.
 */
async function resolveHaltedSlicePhase(
  context: RunContext,
  deps: PipelineDependencies,
  state: PipelineRunState,
  phase: SlicePhaseResult,
): Promise<PipelineResult> {
  const { checkoutPath, spec, store } = context;
  const halted = phase.slices.at(-1);
  const reason = `slice phase halted at slice ${phase.haltedSliceIndex}: ${halted?.reasons.join("; ") ?? "objective gate failed"}`;
  const archiveHalt = async (
    haltReason: string,
    failure: FailureClassification,
  ): Promise<PipelineResult> => {
    const failed = await archivePipelineFailure(context, state, {
      reason: haltReason,
      failure,
      slices: phase.slices,
      haltedSliceIndex: phase.haltedSliceIndex,
    });
    await store.writePipelineArtifact("pipeline-result", failed);
    return failed;
  };
  if (state.currentCandidateCommit === state.baselineCommit) {
    return await archiveHalt(reason, "verification-failure");
  }
  const promoted = await promoteFinalCandidate({
    checkoutPath,
    attempt: state.attempt,
    initialCandidate: state.initialCandidate,
    baselineCommit: state.baselineCommit,
    candidateCommit: state.currentCandidateCommit,
    store,
  });
  if (promoted === null) {
    return await archiveHalt(
      "partial halt candidate could not be promoted from the git object store",
      "sandbox-violation",
    );
  }
  state.finalAttempt = promoted.attempt;
  state.currentCandidateCommit = promoted.candidateCommit;
  state.authoritySafeToRelease = true;
  await context.notePhase("partial halt verification");
  const verified = await verifyCandidate({
    checkoutPath,
    spec,
    deps,
    attempt: state.finalAttempt,
    baselineCommit: state.baselineCommit,
    candidateCommit: state.currentCandidateCommit,
    store,
    namespace: "final",
  });
  await store.writePipelineArtifact("verification", verified.verification);
  const haltResult: PipelineResult = {
    runId: state.attempt.runId,
    status: "human-decision-required",
    attempt: state.finalAttempt,
    increments: state.increments,
    slices: phase.slices,
    haltedSliceIndex: phase.haltedSliceIndex,
    rounds: state.rounds,
    verification: verified.verification,
    gate: {
      decisionReady: false,
      requiresHumanDecision: true,
      reasons: [reason],
    },
    finalCandidateCommit: state.currentCandidateCommit,
    failure: null,
  };
  await store.writePipelineArtifact("pipeline-result", haltResult);
  return haltResult;
}

/** Increments two through `maxIncrements`, each continuing the previous candidate. */
async function runIncrementPhase(
  context: RunContext,
  deps: PipelineDependencies,
  state: PipelineRunState,
  worktreePath: string,
  maxIncrements: number,
): Promise<PhaseOutcome> {
  const { checkoutPath, spec, store } = context;
  try {
    state.gitObjectAccess = await resolveLinkedWorktreeWritableRoots(worktreePath);
  } catch {
    return terminal(failedAtCurrentCandidate(
      state,
      "increment git object isolation could not be established",
      "sandbox-violation",
    ));
  }
  const gitObjectAccess = state.gitObjectAccess;
  const privateObjects = privateObjectReadOptions(gitObjectAccess);

  try {
    for (let increment = 2; increment <= maxIncrements; increment += 1) {
      // A cancellation that lands between Producer runs must stop the
      // pipeline here. Otherwise the loop keeps launching Producers even
      // though the caller has already given up on the run.
      if (deps.abortSignal?.aborted === true) {
        return terminal(failedAtCurrentCandidate(
          state,
          `cancelled before increment ${increment}`,
          "cancelled",
        ));
      }
      await context.notePhase(`increment ${increment}/${maxIncrements}`);
      const previousCandidateCommit = state.currentCandidateCommit;
      const diffText = await checkedGit(worktreePath, [
        "diff",
        `${state.baselineCommit}..${state.currentCandidateCommit}`,
      ], privateObjects);
      const incrementRun = await runIncrement({
        spec,
        pkg: {
          spec,
          baselineCommit: state.baselineCommit,
          candidateCommit: state.currentCandidateCommit,
          candidateDiff: diffText,
          testEvidence: state.frozenTestEvidence,
          progress: composeProgressNotes(state.increments.at(-1)?.report ?? state.attempt),
        },
        worktreePath,
        deps,
        runId: state.attempt.runId,
        increment,
        store,
        gitObjectAccess,
        ...(context.runStart === undefined ? {} : { runStart: context.runStart }),
      });
      if (!incrementRun.ok) {
        return terminal(failedAtCurrentCandidate(
          state,
          `increment phase did not produce valid structured output (see ${incrementRun.failedRoleLogRef})`,
          incrementRun.failure,
        ));
      }

      const report = redactRecord(incrementRun.report);
      await store.writePipelineArtifact(`increment-${increment}`, report);
      const provenanceFailure = await validateCandidateProvenance({
        worktreePath,
        previousCandidateCommit,
        candidateCommit: report.candidateCommit,
        gitObjectAccess,
      });
      if (provenanceFailure !== null) {
        return terminal(failedAtCurrentCandidate(
          state,
          provenanceFailure.reason,
          provenanceFailure.failure,
        ));
      }

      const [previousTree, candidateTree] = await Promise.all([
        checkedGit(worktreePath, ["rev-parse", `${previousCandidateCommit}^{tree}`], privateObjects),
        checkedGit(worktreePath, ["rev-parse", `${report.candidateCommit}^{tree}`], privateObjects),
      ]);
      const progressed = previousTree.trim() !== candidateTree.trim();
      if (report.candidateCommit !== previousCandidateCommit) {
        try {
          await importPromotedObjects({
            checkoutPath,
            baselineCommit: previousCandidateCommit,
            promotedCommit: report.candidateCommit,
            access: gitObjectAccess,
          });
        } catch {
          return terminal(failedAtCurrentCandidate(
            state,
            "increment objects could not be imported into the shared git object store",
            "sandbox-violation",
          ));
        }
      }
      state.currentCandidateCommit = report.candidateCommit;
      state.increments.push({
        increment,
        report,
        roleLogRefs: incrementRun.roleLogRefs,
      });

      if (report.status === "complete") {
        state.incrementOutcome = "complete";
        break;
      }
      if (report.status === "blocked") {
        state.incrementOutcome = "blocked";
        break;
      }
      if (!progressed) {
        state.incrementOutcome = "stalled";
        break;
      }
    }
    state.incrementOutcome ??= "budget-exhausted";
  } catch {
    return terminal(failedAtCurrentCandidate(
      state,
      "increment phase failed unexpectedly",
      "producer-failure",
    ));
  }
  return CONTINUE;
}

/** Review rounds over the whole candidate branch, each followed by a fix when findings block. */
async function runReviewRounds(
  context: RunContext,
  deps: PipelineDependencies,
  state: PipelineRunState,
  worktreePath: string,
  reviewers: ReviewerKind[],
  maxRounds: number,
): Promise<PhaseOutcome> {
  const { spec, store } = context;
  for (let round = 1; round <= maxRounds; round += 1) {
    if (deps.abortSignal?.aborted === true) {
      return terminal(failedAtCurrentCandidate(
        state,
        `cancelled before review round ${round}`,
        "cancelled",
      ));
    }
    await context.notePhase(`review round ${round}/${maxRounds}`);
    const diffText = await checkedGit(worktreePath, [
      "diff",
      `${state.baselineCommit}..${state.currentCandidateCommit}`,
    ], state.gitObjectAccess === null ? undefined : privateObjectReadOptions(state.gitObjectAccess));
    const pkg: RolePackage = {
      spec,
      baselineCommit: state.baselineCommit,
      candidateCommit: state.currentCandidateCommit,
      candidateDiff: diffText,
      testEvidence: state.frozenTestEvidence,
    };
    const reviewRun = await runReviews({
      reviewers,
      spec,
      pkg,
      worktreePath,
      deps,
      runId: state.attempt.runId,
      round,
      store,
      onReviewer: role => context.emitStatus("reviewing", { round, role }),
    });
    if (!reviewRun.ok) {
      return terminal(await salvagePipelineFailure(context, deps, state, {
        reason: `review phase did not produce valid structured output (see ${reviewRun.failedRoleLogRef})`,
        failure: "producer-failure",
      }));
    }

    const reviews = reviewRun.reviews.map(review => ({
      reviewer: review.reviewer,
      report: review.report,
    }));
    const consolidated = consolidate(reviews);
    await Promise.all(reviewRun.reviews.map(review => store.writePipelineArtifact(
      `round-${round}-review-${review.reviewer}`,
      review.report,
    )));
    await store.writePipelineArtifact(`round-${round}-consolidated`, consolidated);

    const blocking = consolidated.findings.some(
      finding => finding.severity === "blocker" || finding.severity === "major",
    );
    const approved = reviewRun.reviews.every(review => review.report.verdict === "approve");
    // Record the round as soon as its reviews are consolidated. A later fix
    // failure must not erase review work that is already on disk; the entry
    // is completed in place once a fix lands.
    const roundRecord: PipelineRound = {
      round,
      reviews,
      consolidated,
      fix: null,
      roleLogRefs: reviewRun.roleLogRefs,
    };
    state.rounds.push(roundRecord);
    if (!blocking && approved) break;

    try {
      state.gitObjectAccess ??= await resolveLinkedWorktreeWritableRoots(worktreePath);
    } catch {
      return terminal(await archivePipelineFailure(context, state, {
        reason: "fixer git object isolation could not be established",
        failure: "sandbox-violation",
      }));
    }

    await context.emitStatus("fixing", { round, role: "fixer" });
    await context.notePhase(`round ${round}: applying fixes`);
    const fixRun = await runFix({
      spec,
      pkg: { ...pkg, findings: consolidated.findings },
      worktreePath,
      deps,
      runId: state.attempt.runId,
      round,
      store,
      gitObjectAccess: state.gitObjectAccess,
      ...(context.runStart === undefined ? {} : { runStart: context.runStart }),
    });
    if (!fixRun.ok) {
      // The fix never landed, so the bytes here are the last reviewed
      // candidate — salvage them rather than losing the whole round.
      return terminal(await salvagePipelineFailure(context, deps, state, {
        reason: `fix phase did not produce valid structured output (see ${fixRun.failedRoleLogRef})`,
        failure: fixRun.failure,
      }));
    }
    const { fix } = fixRun;
    await store.writePipelineArtifact(`round-${round}-fix`, fix);
    const provenanceFailure = await validateFixProvenance({
      worktreePath,
      previousCandidateCommit: state.currentCandidateCommit,
      fix,
      gitObjectAccess: state.gitObjectAccess,
    });
    if (provenanceFailure !== null) {
      return terminal(await archivePipelineFailure(context, state, {
        reason: provenanceFailure.reason,
        failure: provenanceFailure.failure,
      }));
    }
    state.currentCandidateCommit = fix.candidateCommit;
    roundRecord.fix = fix;
    roundRecord.roleLogRefs = [...reviewRun.roleLogRefs, ...fixRun.roleLogRefs];
  }
  return CONTINUE;
}

/** Re-anchor the reviewed branch as the run's candidate when a fix or slice moved it. */
async function promoteReviewedCandidate(
  context: RunContext,
  state: PipelineRunState,
): Promise<PhaseOutcome> {
  if (state.currentCandidateCommit === state.initialCandidate.candidateCommitOid) return CONTINUE;
  if (state.gitObjectAccess === null && !state.sliced) {
    return terminal(failedAtCurrentCandidate(
      state,
      "fixer git object isolation state is missing during promotion",
      "sandbox-violation",
    ));
  }
  const promoted = await promoteFinalCandidate({
    checkoutPath: context.checkoutPath,
    attempt: state.attempt,
    initialCandidate: state.initialCandidate,
    baselineCommit: state.baselineCommit,
    candidateCommit: state.currentCandidateCommit,
    store: context.store,
    ...(state.gitObjectAccess === null ? {} : { privateObjectAccess: state.gitObjectAccess }),
  });
  if (promoted === null) {
    return terminal(await archivePipelineFailure(context, state, {
      reason: state.sliced
        ? "sliced candidate could not be promoted from the shared git object store"
        : "fixer objects could not be imported into the shared git object store",
      failure: "sandbox-violation",
    }));
  }
  state.finalAttempt = promoted.attempt;
  state.currentCandidateCommit = promoted.candidateCommit;
  return CONTINUE;
}

/** Final verification, the objective gate, and the durable record of its verdict. */
async function finalizePipelineGate(
  context: RunContext,
  deps: PipelineDependencies,
  state: PipelineRunState,
  maxRounds: number,
): Promise<PipelineResult> {
  const { checkoutPath, spec, store } = context;
  await context.emitStatus("verifying");
  await context.notePhase("final verification");
  const verified = await verifyCandidate({
    checkoutPath,
    spec,
    deps,
    attempt: state.finalAttempt,
    baselineCommit: state.baselineCommit,
    candidateCommit: state.currentCandidateCommit,
    store,
    ...(state.sliced ? { namespace: "final" } : {}),
  });
  await store.writePipelineArtifact("verification", verified.verification);
  const lastRound = state.rounds.at(-1);
  await context.emitStatus("gating");
  await context.notePhase("evaluating gate");
  const gate = evaluateGates({
    findings: lastRound?.consolidated.findings ?? [],
    dispositions: lastRound?.fix?.dispositions ?? [],
    verification: verified.verification,
    roundsUsed: state.rounds.length,
    maxRounds,
    finalRoundReviewed: (lastRound?.fix ?? null) === null,
    artifactsValid: true,
    baselineDrift: verified.baselineDrift,
    // Computed over the whole round history, not one round's prose.
    nonConvergence: detectNonConvergence(state.rounds.map(round => ({
      round: round.round,
      findings: round.consolidated.findings,
      fixAttempted: round.fix !== null,
    }))),
    ...(state.incrementOutcome === undefined ? {} : { incrementOutcome: state.incrementOutcome }),
  });
  // A refusing gate lived only in the pipeline-result artifact, which the
  // accept path never reads: it loads the archived attempt, sees
  // verified-candidate with no failure, and offers the candidate as clean.
  // `archiveSlicedFailure` already records incompleteness in evidence for
  // exactly this reason; a gate that completed and said no needs the same
  // durability, or "blocking findings survived" is invisible at decision time.
  const manifestForArchive = await store.readManifest();
  if (manifestForArchive === null) {
    if (!gate.decisionReady) {
      throw new RuntimeError(
        "pipeline gate refused the candidate and the refusal could not be archived",
        { reasons: gate.reasons },
      );
    }
    throw new RuntimeError(
      "pipeline gate cleared the candidate and the clearance could not be archived",
      {
        candidateCommitOid: state.currentCandidateCommit,
        requiresHumanDecision: gate.requiresHumanDecision,
      },
    );
  }
  if (!gate.decisionReady) {
    state.finalAttempt = {
      ...state.finalAttempt,
      evidence: {
        ...state.finalAttempt.evidence,
        pipelineGateRefused: {
          reasons: gate.reasons,
          requiresHumanDecision: gate.requiresHumanDecision,
        },
      },
    };
  }
  // One clearance record, built once. Constructing it a second time for the
  // returned result gave the archive and the caller two different `clearedAt`
  // values for the same clearance, which no reader of only one could detect.
  const gateClearedRecord: PipelineGateCleared | null = !gate.decisionReady ? null : {
    clearedVersion: "1",
    candidateCommitOid: state.currentCandidateCommit,
    requiresHumanDecision: gate.requiresHumanDecision,
    clearedAt: new Date().toISOString(),
  };
  if (gateClearedRecord !== null) {
    state.finalAttempt = {
      ...state.finalAttempt,
      evidence: {
        ...state.finalAttempt.evidence,
        pipelineGateCleared: {
          candidateCommitOid: state.currentCandidateCommit,
          requiresHumanDecision: gate.requiresHumanDecision,
        },
      },
    };
    await store.writePipelineGateCleared(gateClearedRecord);
  }
  await store.promoteTerminalArtifacts({
    result: state.finalAttempt,
    manifest: manifestForArchive,
  });
  const result: PipelineResult = {
    runId: state.attempt.runId,
    status: gate.decisionReady ? "decision-ready" : "human-decision-required",
    attempt: state.finalAttempt,
    increments: state.increments,
    slices: state.pipelineSlices,
    haltedSliceIndex: null,
    rounds: state.rounds,
    verification: verified.verification,
    gate,
    finalCandidateCommit: state.currentCandidateCommit,
    failure: null,
    pipelineGateCleared: gateClearedRecord,
  };
  await store.writePipelineArtifact("pipeline-result", result);
  // The terminal done/failed status is written by `runPipeline` while it still
  // holds the lease, before `finally` releases it, so it is not repeated here.
  await context.notePhase(`finished: ${result.status}`);
  state.authoritySafeToRelease = true;
  return result;
}

async function runPipelineWithLease(
  checkoutPath: string,
  spec: DelegationSpec,
  deps: PipelineDependencies,
  ps: PlatformServices,
  borrowedCheckoutLease: CheckoutLock,
): Promise<PipelineResult> {
  const runAttemptFn = deps.runAttempt ?? defaultRunAttempt;
  const slices = resolveSlices(spec);
  const sliced = slices.length > 0;
  const sliceCount = sliced ? slices.length : null;
  const initialSpec = sliced ? scopeSpecToSlice(spec, slices[0]!) : spec;
  const activeOwner: PipelineActiveMarker = {
    pid: process.pid,
    processToken: await ps.getProcessStartToken(process.pid).catch(() => null),
    startedAt: new Date().toISOString(),
    sliced,
  };
  // Until the attempt reports its run id there is no store to write status
  // to; these two fields bridge the attempt's callbacks to the run context
  // that is built once the id is known.
  let statusStore: ArtifactStore | null = null;
  let statusRunId: string | null = null;
  let runStart: RunStartContext | undefined;
  let slicedMarkerEstablished = false;
  const inheritedOnRunStart = deps.onRunStart;
  const inheritedOnPhase = deps.onPhase;
  const attempt = await runAttemptFn(checkoutPath, initialSpec, {
    ...deps,
    // The run's identity is the spec the caller dispatched. scopeSpecToSlice
    // rewrites the spec for slice one, so hashing what the attempt receives
    // would record an identity no caller ever held.
    dispatchedSpecSha256: specSha256(spec),
    borrowedCheckoutLease,
    runStatus: {
      mode: sliced ? "sliced" : "single",
      sliceIndex: sliced ? 1 : null,
      sliceCount,
      pipelineManaged: true,
    },
    async onPhase(phase) {
      const mapped = phase === "producer running"
        ? "implementing"
        : phase === "freezing candidate"
          ? "freezing"
          : phase === "verifying candidate"
            ? "verifying"
            : null;
      if (mapped !== null && statusStore !== null && statusRunId !== null) {
        await transitionRunStatusSafely(statusStore, statusRunId, mapped, {
          sliceIndex: sliced ? 1 : null,
          sliceCount,
          round: null,
          role: null,
          producerId: null,
          detail: null,
        });
      }
      try { await inheritedOnPhase?.(phase); } catch { /* host progress is advisory */ }
    },
    async onRunStart(context) {
      runStart = context;
      statusRunId = context.record.runId;
      statusStore = new ArtifactStore(context.record.runId);
      if (sliced) {
        await statusStore.writePipelineActiveMarker(activeOwner);
        slicedMarkerEstablished = true;
      }
      await writeRunStatusSafely(statusStore, {
        statusVersion: "1",
        runId: context.record.runId,
        mode: sliced ? "sliced" : "single",
        phase: "preflight",
        sliceIndex: sliced ? 1 : null,
        sliceCount,
        round: null,
        role: null,
        producerId: null,
        startedAt: context.record.startedAt,
        updatedAt: new Date().toISOString(),
        detail: null,
      });
      await transitionRunStatusSafely(statusStore, context.record.runId, "baseline-verify", {
        sliceIndex: sliced ? 1 : null,
        sliceCount,
        round: null,
        role: null,
        producerId: null,
        detail: spec.executionMode === "edit" ? null : "skipped for read-only execution",
      });
      await inheritedOnRunStart?.(context);
    },
  });
  const store = new ArtifactStore(attempt.runId);
  await store.writePipelineArtifact("delegation-spec", spec);
  // Run-scoped facts travel as one value from here down, so no phase reaches
  // back into this function's closure for them.
  const context: RunContext = createRunContext({
    runId: attempt.runId,
    checkoutPath,
    spec,
    store,
    ps,
    borrowedCheckoutLease,
    ...(runStart === undefined ? {} : { runStart }),
    ...(inheritedOnPhase === undefined ? {} : { onPhase: inheritedOnPhase }),
    sliceCount,
    // Once the slice wave is over, status lines describe the whole branch;
    // the last slice index is the honest position for them.
    sliceIndex: sliceCount,
  });
  if (attempt.status !== "verified-candidate" || attempt.candidate === null) {
    if (slicedMarkerEstablished) await store.clearPipelineActiveMarker();
    // Propagate the attempt's own classification (e.g. verification-failure for a
    // base-changed candidate, timeout, sandbox-violation) instead of flattening
    // every non-verified implement phase to producer-failure. A blameless base
    // movement is then triageable from `failure` alone, not only structural evidence.
    return failedResult(
      attempt,
      [],
      "",
      "implement phase did not produce a verified candidate",
      attempt.failure ?? "producer-failure",
    );
  }

  if (!sliced) await store.writePipelineActiveMarker(activeOwner);
  const temporarySliceRefs: TemporarySliceRef[] = [];
  const state: PipelineRunState = {
    attempt,
    initialCandidate: attempt.candidate,
    baselineCommit: attempt.candidate.baseCommitOid,
    sliced,
    rounds: [],
    increments: [],
    finalAttempt: attempt,
    currentCandidateCommit: attempt.candidate.candidateCommitOid,
    pipelineSlices: [],
    incrementOutcome: undefined,
    gitObjectAccess: null,
    frozenTestEvidence: testEvidence(attempt),
    authoritySafeToRelease: !sliced,
  };
  let pipelinePrimaryError: unknown;
  try {
    const reviewConfig = resolveReviewConfig(spec);
    const { reviewers, maxRounds } = reviewConfig;
    const maxIncrements = sliced ? 1 : resolveImplementationConfig(spec).maxIncrements;
    const failSliceExecution = async (
      error: unknown,
      completedSlices: PipelineSlice[],
    ): Promise<PipelineResult> => {
      const archived = await archiveSliceExecutionError({ checkoutPath, error, attempt, store });
      state.authoritySafeToRelease = true;
      state.finalAttempt = archived.failedAttempt;
      if (error !== archived.sliceError) throw error;
      const failed = failedResult(
        archived.failedAttempt,
        state.rounds,
        completedSlices.at(-1)?.candidateCommit ?? state.baselineCommit,
        archived.sliceError.message,
        archived.sliceError.failure,
        state.increments,
        completedSlices,
      );
      await store.writePipelineArtifact("pipeline-result", failed);
      return failed;
    };

    if (sliced) {
      const initialNamespace = "slice-1-attempt-0";
      await context.emitStatus("verifying", { sliceIndex: 1 });
      const initialVerification = await verifyCandidate({
        checkoutPath,
        spec: initialSpec,
        deps,
        attempt,
        baselineCommit: state.baselineCommit,
        candidateCommit: state.currentCandidateCommit,
        store,
        namespace: initialNamespace,
      });
      let initialPerSliceReview: ConsolidationResult | null = null;
      const initialRoleLogRefs = attemptLogRefs(attempt);
      if (reviewConfig.perSlice === true) {
        let reviewed;
        try {
          reviewed = await runSliceReview({
            checkoutPath,
            spec: initialSpec,
            deps,
            runId: attempt.runId,
            baselineCommit: state.baselineCommit,
            candidateCommit: state.currentCandidateCommit,
            namespace: initialNamespace,
            reviewers,
            verification: initialVerification.verification,
            store,
            borrowedCheckoutLease,
          });
        } catch (error) {
          return await failSliceExecution(error, []);
        }
        initialPerSliceReview = reviewed.review;
        initialRoleLogRefs.push(...reviewed.roleLogRefs);
      }

      const completedSlices: PipelineSlice[] = [];
      let phase: SlicePhaseResult;
      try {
        const sliceRunner = new SliceRunner({
          producerRuntime: deps.producerRuntime,
          runDecision: deps.runDecision,
          platformSafety: deps.platformSafety,
          ps,
          runRole: deps.runRole,
          roleRunner: deps.roleRunner,
        });
        phase = await sliceRunner.run({
          context,
          slices,
          baselineCommit: state.baselineCommit,
          attempt,
          budgets: { maxRounds },
          concurrency: resolveSliceConcurrency(spec),
          initialAttempt: {
            candidateCommit: state.currentCandidateCommit,
            verification: initialVerification.verification,
            perSliceReview: initialPerSliceReview,
            roleLogRefs: initialRoleLogRefs,
          },
          reviewConfig,
          reviewers,
          registry: deps.registry,
          abortSignal: deps.abortSignal,
          onSlice: async slice => {
            completedSlices.push(slice);
          },
        });
      } catch (error) {
        return await failSliceExecution(error, completedSlices);
      }
      state.pipelineSlices = phase.slices;
      // The runner hands its refs over rather than dropping them: the final
      // review round still resolves them, and this function's `finally` is the
      // single place they are deleted.
      temporarySliceRefs.push(...(phase.temporarySliceRefs ?? []));
      state.currentCandidateCommit = phase.finalCandidateCommit;
      if (phase.haltedSliceIndex !== null) {
        return await resolveHaltedSlicePhase(context, deps, state, phase);
      }
      state.frozenTestEvidence = sliceTestEvidence(phase.slices);
    }

    const candidateWorktree = await new WorktreeManager(
      checkoutPath,
      sliced ? `${attempt.runId}-composed-review` : `${attempt.runId}-pipeline`,
      ps,
      deps.borrowedCheckoutLease === undefined
        ? {}
        : { borrowedCheckoutLease: deps.borrowedCheckoutLease },
    ).create(state.currentCandidateCommit);
    try {
      if (maxIncrements > 1) {
        const outcome = await runIncrementPhase(context, deps, state, candidateWorktree.path, maxIncrements);
        if (outcome.state === "terminal") return outcome.result;
      }
      const reviewed = await runReviewRounds(context, deps, state, candidateWorktree.path, reviewers, maxRounds);
      if (reviewed.state === "terminal") return reviewed.result;
      const promoted = await promoteReviewedCandidate(context, state);
      if (promoted.state === "terminal") return promoted.result;
    } finally {
      const cleanupError = await cleanupWorktree(candidateWorktree);
      if (cleanupError !== null) {
        logger.warn("pipeline round worktree could not be cleaned up", {
          error: redact(cleanupError instanceof Error ? cleanupError.message : String(cleanupError)),
        });
      }
    }

    return await finalizePipelineGate(context, deps, state, maxRounds);
  } catch (error) {
    let terminalError = error;
    if (sliced
      && state.finalAttempt.status === "verified-candidate"
      && !containsSlicedFailureArchiveError(error)) {
      try {
        state.finalAttempt = await archiveSlicedFailure({
          checkoutPath,
          attempt: state.finalAttempt,
          failure: "verification-failure",
          reason: "sliced pipeline terminated before completing trusted gates",
          store,
        });
        state.authoritySafeToRelease = true;
      } catch (archiveError) {
        terminalError = new AggregateError(
          [error, archiveError],
          "sliced pipeline failed and its attempt result could not be archived",
        );
      }
    }
    await context.emitStatus("failed", {
      detail: terminalError instanceof Error ? terminalError.message : "pipeline failed unexpectedly",
    });
    pipelinePrimaryError = terminalError;
    throw terminalError;
  } finally {
    const cleanupErrors = await cleanupTemporarySliceRefs(checkoutPath, temporarySliceRefs);
    if (cleanupErrors.length > 0
      && sliced
      && state.finalAttempt.status === "verified-candidate"
      && !containsSlicedFailureArchiveError(pipelinePrimaryError)) {
      try {
        state.finalAttempt = await archiveSlicedFailure({
          checkoutPath,
          attempt: state.finalAttempt,
          failure: "verification-failure",
          reason: "temporary slice ref cleanup did not complete",
          store,
        });
        state.authoritySafeToRelease = true;
      } catch (archiveError) {
        cleanupErrors.push(archiveError);
      }
    }
    if (cleanupErrors.length === 0 && state.authoritySafeToRelease) {
      try {
        await store.clearPipelineActiveMarker();
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
    }
    if (cleanupErrors.length > 0) {
      const errors = pipelinePrimaryError === undefined
        ? cleanupErrors
        : [pipelinePrimaryError, ...cleanupErrors];
      if (errors.length === 1) throw errors[0];
      throw new AggregateError(errors, "pipeline failed or its terminal cleanup was incomplete");
    }
  }
}
