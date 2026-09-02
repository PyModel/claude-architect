import path from "node:path";
import { git, type GitExecOptions, type GitResult } from "../git/git-exec.js";
import { WorktreeManager } from "../runtime/worktree-manager.js";
import { PlatformSafety } from "../platform/platform-safety.js";
import type { CheckoutLock, PlatformServices } from "../platform/platform-services.js";
import { getPlatformServices } from "../platform/select-platform.js";
import type {
  CandidateArtifact,
  AttemptResult,
  CommandOutcome,
  FailureClassification,
} from "../protocol/attempt-result.js";
import {
  resolveImplementationConfig,
  resolveReviewConfig,
  resolveSliceConcurrency,
  resolveSlices,
  type DelegationSpec,
  type ReviewerKind,
  type Slice,
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
  type RunStatus,
  type RunStatusPhase,
} from "../runtime/run-status.js";
import { RuntimeError } from "../util/errors.js";
import { globMatches } from "../util/glob.js";
import { AcceptanceVerifier } from "../verify/acceptance-verifier.js";
import {
  recomputeManifest,
  structuralVerify,
  type StructuralFailure,
} from "../verify/structural-verifier.js";
import { consolidate, detectNonConvergence, type ConsolidationResult } from "./consolidator.js";
import { evaluateGates, type GateResult, type IncrementOutcome } from "./gates.js";
import { composeSliceOntoHead } from "./slice-composer.js";
import type {
  FixReport,
  IncrementReport,
  ReviewReport,
  VerificationReport,
} from "./report-types.js";
import type { PipelineRole, RolePackage } from "./role-prompts.js";
import {
  runSlicePhase,
  type PipelineSlice,
  type SliceAttemptEvidence,
} from "./slice-runner.js";
import {
  runRole as defaultRunRole,
  type RoleRunArgs,
  type RoleRunResult,
} from "./role-runner.js";
import { parseStructuredReport } from "./structured-output.js";
import {
  resolveLinkedWorktreeWritableRoots,
  type LinkedWorktreeGitAccess,
} from "./git-writable-roots.js";
import { runAdvisorStage as bundledAdvisorStage } from "./advisor-stage.js";

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
  runAttempt?: (
    checkoutPath: string,
    spec: DelegationSpec,
    deps: AttemptRuntimeDependencies,
  ) => Promise<AttemptResult>;
}

interface ParsedReview {
  reviewer: ReviewerKind;
  report: ReviewReport;
}

type ReviewRunResult =
  | { ok: true; reviews: ParsedReview[]; roleLogRefs: string[] }
  | { ok: false; failedRoleLogRef: string; roleLogRefs: string[] };

type FixRunResult =
  | { ok: true; fix: FixReport; roleLogRefs: string[] }
  | {
    ok: false;
    failure: FailureClassification;
    failedRoleLogRef: string;
    roleLogRefs: string[];
  };

export type StructuredRoleRunResult<T> =
  | { ok: true; report: T; roleLogRefs: string[] }
  | {
    ok: false;
    failure: FailureClassification;
    failedRoleLogRef: string;
    roleLogRefs: string[];
  };

const schemas = loadSchemas();
// `base-changed` used to be ignored here because it fired on shared-checkout
// drift that a slice cannot control — but that also suppressed the same code's
// legitimate half, an artifact not matching its own base. Drift is no longer a
// failure at all, so only the genuinely slice-specific exemption remains.
const IGNORED_STRUCTURAL_FAILURES = new Set<StructuralFailure>([
  "artifact-divergence",
]);
const CANDIDATE_REF_PREFIX = "refs/claude-architect/candidates/";
const SLICE_REF_PREFIX = "refs/claude-architect/slices/";

interface TemporarySliceRef {
  ref: string;
  oid: string;
}


/**
 * Bounded, human-readable summary of earlier slice attempts for the next
 * implementer. Carries the routing reason and the failing verification command
 * ids — enough to avoid repeating the approach — without replaying whole logs.
 */
function describePriorAttempts(
  attempts: readonly SliceAttemptEvidence[],
): string {
  return attempts.map(entry => {
    const failed = (entry.verification?.commandResults ?? [])
      .filter(command => !command.ok)
      .map(command => `${command.id} (exit ${String(command.exitCode)})`);
    const blocking = (entry.perSliceReview?.findings ?? [])
      .filter(finding => finding.severity === "blocker" || finding.severity === "major")
      .map(finding => `${finding.severity} at ${finding.location}: ${finding.claim}`);
    return [
      `attempt ${entry.attempt} -> ${entry.route}`,
      `  reasons: ${entry.reasons.join("; ") || "(none recorded)"}`,
      ...(failed.length === 0 ? [] : [`  failing verification: ${failed.join(", ")}`]),
      ...(blocking.length === 0 ? [] : [`  blocking findings:\n    ${blocking.join("\n    ")}`]),
    ].join("\n");
  }).join("\n\n");
}

export function scopeSpecToSlice(spec: DelegationSpec, slice: Slice): DelegationSpec {
  const scoped = structuredClone({ ...spec, ...slice });
  delete scoped.slices;
  return scoped;
}

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

function temporarySliceRef(runId: string, index: number, attempt: number): string {
  return `${SLICE_REF_PREFIX}${runId}/slice-${index}-attempt-${attempt}`;
}

async function createTemporarySliceRef(
  checkoutPath: string,
  temporaryRef: TemporarySliceRef,
): Promise<void> {
  const result = await git(checkoutPath, [
    "update-ref",
    "--no-deref",
    temporaryRef.ref,
    temporaryRef.oid,
    "0".repeat(temporaryRef.oid.length),
  ]);
  if (result.exitCode !== 0) throw gitFailure("create temporary slice ref", result);
}

async function cleanupTemporarySliceRefs(
  checkoutPath: string,
  temporaryRefs: TemporarySliceRef[],
): Promise<unknown[]> {
  const errors: unknown[] = [];
  for (const temporaryRef of [...temporaryRefs].reverse()) {
    try {
      const result = await git(checkoutPath, [
        "update-ref",
        "--no-deref",
        "-d",
        temporaryRef.ref,
        temporaryRef.oid,
      ]);
      if (result.exitCode !== 0) {
        errors.push(gitFailure("delete temporary slice ref", result));
      }
    } catch (error) {
      errors.push(error);
    }
  }
  return errors;
}

function privateObjectReadOptions(access: LinkedWorktreeGitAccess): GitExecOptions {
  return {
    env: { GIT_ALTERNATE_OBJECT_DIRECTORIES: access.privateObjectsDir },
  };
}

async function importPromotedObjects(args: {
  checkoutPath: string;
  baselineCommit: string;
  promotedCommit: string;
  access: LinkedWorktreeGitAccess;
}): Promise<void> {
  const privateObjects = privateObjectReadOptions(args.access);
  const packPrefix = path.join(args.access.sharedObjectsDir, "pack", "pack");
  await checkedGit(
    args.checkoutPath,
    ["pack-objects", "--revs", packPrefix],
    {
      ...privateObjects,
      stdin: `${args.promotedCommit}\n^${args.baselineCommit}\n`,
    },
  );

  await checkedGit(args.checkoutPath, ["cat-file", "-e", `${args.promotedCommit}^{commit}`]);
  await checkedGit(args.checkoutPath, ["rev-parse", `${args.promotedCommit}^{tree}`]);
  await checkedGit(args.checkoutPath, [
    "rev-list",
    "--objects",
    args.promotedCommit,
    "--not",
    args.baselineCommit,
  ]);
}

function roleArgs(args: {
  role: PipelineRole;
  spec: DelegationSpec;
  pkg: RolePackage;
  worktreePath: string;
  deps: PipelineDependencies;
  runId: string;
  runStart?: RunStartContext;
  gitObjectAccess?: LinkedWorktreeGitAccess;
}): RoleRunArgs {
  const ps = args.deps.ps ?? getPlatformServices();
  return {
    role: args.role,
    baseSpec: args.spec,
    pkg: args.pkg,
    worktreePath: args.worktreePath,
    ps,
    registry: args.deps.registry,
    runId: args.runId,
    ...(args.runStart === undefined ? {} : { runStart: args.runStart }),
    ...(args.gitObjectAccess === undefined ? {} : { gitObjectAccess: args.gitObjectAccess }),
    ...(args.deps.env === undefined ? {} : { env: args.deps.env }),
    ...(args.deps.abortSignal === undefined ? {} : { abortSignal: args.deps.abortSignal }),
  };
}

async function runArchivedRole(
  runner: (args: RoleRunArgs) => Promise<RoleRunResult>,
  args: RoleRunArgs,
  store: Pick<ArtifactStore, "writeLog">,
  logName: string,
): Promise<{ result: RoleRunResult; logRef: string }> {
  const result = await runner(args);
  const output = result.rawOutput === ""
    ? `role produced no stdout; failure: ${result.failure ?? "none"}\n`
    : result.archiveSafeRawOutput ?? result.rawOutput;
  const logRef = await store.writeLog(logName, output);
  return { result, logRef };
}

export async function runStructuredRole<T>(args: {
  role: PipelineRole;
  schema: Parameters<typeof parseStructuredReport>[1];
  logName: string;
  spec: DelegationSpec;
  pkg: RolePackage;
  worktreePath: string;
  deps: PipelineDependencies;
  runId: string;
  store: Pick<ArtifactStore, "writeLog">;
  runStart?: RunStartContext;
  gitObjectAccess?: LinkedWorktreeGitAccess;
}): Promise<StructuredRoleRunResult<T>> {
  const runner = args.deps.roleRunner ?? defaultRunRole;
  const callArgs = roleArgs({
    role: args.role,
    spec: args.spec,
    pkg: args.pkg,
    worktreePath: args.worktreePath,
    deps: args.deps,
    runId: args.runId,
    ...(args.runStart === undefined ? {} : { runStart: args.runStart }),
    ...(args.gitObjectAccess === undefined ? {} : { gitObjectAccess: args.gitObjectAccess }),
  });
  const initial = await runArchivedRole(runner, callArgs, args.store, args.logName);
  const roleLogRefs = [initial.logRef];
  if (!initial.result.ok) {
    return {
      ok: false,
      failure: initial.result.failure ?? "producer-failure",
      failedRoleLogRef: initial.logRef,
      roleLogRefs,
    };
  }
  const outcome = await parseStructuredReport<T>(
    initial.result.rawOutput,
    args.schema,
    async validationErrors => {
      // Re-running with the identical arguments is a blind retry: the Producer
      // cannot see why its reply was rejected, so it reproduces the defect and
      // the round is spent for nothing. Carry the errors into the retry.
      const repair = await runArchivedRole(
        runner,
        { ...callArgs, pkg: { ...callArgs.pkg, outputRepair: validationErrors } },
        args.store,
        `${args.logName}-repair`,
      );
      roleLogRefs.push(repair.logRef);
      return repair.result.ok ? repair.result.rawOutput : "";
    },
  );
  return outcome.ok
    ? { ok: true, report: outcome.value, roleLogRefs }
    : {
      ok: false,
      failure: "invalid-output",
      failedRoleLogRef: initial.logRef,
      roleLogRefs,
    };
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

function testEvidence(attempt: AttemptResult): string {
  return JSON.stringify(attempt.executedVerification.map(outcome => ({
    id: outcome.id,
    exitCode: outcome.exitCode,
    timedOut: outcome.timedOut,
  })));
}

function attemptLogRefs(attempt: AttemptResult): string[] {
  return [...new Set([
    attempt.logsRef,
    ...attempt.executedVerification.flatMap(outcome => [outcome.stdoutRef, outcome.stderrRef]),
  ])];
}

function verificationTestEvidence(verification: VerificationReport): Record<string, unknown> {
  return {
    pass: verification.pass,
    commandResults: verification.commandResults.map(command => ({ ...command })),
    workspaceClean: verification.workspaceClean,
    testsDeleted: verification.testsDeleted,
    testsSkipped: verification.testsSkipped,
    scopeViolations: [...verification.scopeViolations],
  };
}

function sliceTestEvidence(slices: PipelineSlice[]): string {
  return JSON.stringify(slices.map(slice => ({
    sliceIndex: slice.index,
    verification: slice.verification === null
      ? null
      : verificationTestEvidence(slice.verification),
    attempts: slice.attempts.map(attempt => ({
      attempt: attempt.attempt,
      verification: attempt.verification === null
        ? null
        : verificationTestEvidence(attempt.verification),
    })),
  })));
}

class SliceExecutionError extends RuntimeError {
  constructor(message: string, readonly failure: FailureClassification) {
    super(message);
    this.name = "SliceExecutionError";
  }
}

class SlicedFailureArchiveError extends RuntimeError {
  constructor(readonly cause: unknown) {
    super(cause instanceof Error ? cause.message : "sliced failure archival failed");
    this.name = "SlicedFailureArchiveError";
  }
}

function findSliceExecutionError(error: unknown): SliceExecutionError | null {
  if (error instanceof SliceExecutionError) return error;
  if (!(error instanceof AggregateError)) return null;
  for (const nested of error.errors) {
    const found = findSliceExecutionError(nested);
    if (found !== null) return found;
  }
  return null;
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
    const manifest = await args.store.readManifest(args.attempt.runId);
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

/**
 * Removal itself retries and falls back inside WorktreeManager. What matters
 * here is the disposition: a worktree that still cannot be removed is reported,
 * never substituted for the outcome of the work it held. The Producer's process
 * tree is already terminated by `supervise` before this runs.
 */
async function cleanupWorktree(
  worktree: { path: string; cleanup(): Promise<void> },
): Promise<unknown | null> {
  try {
    await worktree.cleanup();
    return null;
  } catch (error) {
    return error;
  }
}

/**
 * `git worktree add` mutates shared repository state, so concurrent slices are
 * given their worktrees one at a time even though their Producers then run in
 * parallel. Creation is a fraction of a slice's runtime; a lock collision costs
 * the whole attempt.
 */
let worktreeCreation: Promise<unknown> = Promise.resolve();

function createWorktreeSerially(
  manager: WorktreeManager,
  commit: string,
): Promise<{ path: string; cleanup(): Promise<void> }> {
  const created = worktreeCreation
    .catch(() => {})
    .then(async () => manager.create(commit));
  worktreeCreation = created.catch(() => {});
  return created;
}

async function withManagedWorktree<T>(args: {
  manager: WorktreeManager;
  commit: string;
  cleanupFailureMessage: string;
  run: (worktreePath: string) => Promise<T>;
  onCleanupFailure?: (error: unknown) => void;
}): Promise<T> {
  const worktree = await createWorktreeSerially(args.manager, args.commit);
  try {
    return await args.run(worktree.path);
  } finally {
    // A cleanup failure must stay visible without erasing the primary outcome.
    // Replacing a graceful slice timeout with a hard runtime error loses the
    // whole slice result and the salvage that goes with it.
    const cleanupError = await cleanupWorktree(worktree);
    if (cleanupError !== null) {
      logger.warn(args.cleanupFailureMessage, {
        error: redact(cleanupError instanceof Error ? cleanupError.message : String(cleanupError)),
      });
      args.onCleanupFailure?.(cleanupError);
    }
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
  const manifest = await args.store.readManifest(args.attempt.runId);
  if (manifest === null) throw new RuntimeError("run manifest is missing during promotion");
  const finalAttempt = { ...args.attempt, candidate };
  await args.store.promoteTerminalArtifacts({
    result: finalAttempt,
    manifest: { ...manifest, candidateManifestHash: candidate.manifestHash },
  });
  return { attempt: finalAttempt, candidateCommit: canonicalCommit };
}

interface WeakenedTestEvidence {
  testsDeleted: number;
  testsSkipped: number;
  authorizedTestDeletions: string[];
}

function analyzeWeakenedTests(
  diff: string,
  allowedTestDeletions: string[] = [],
  deletedPaths?: string[],
): WeakenedTestEvidence {
  let testsDeleted = 0;
  let testsSkipped = 0;
  const authorizedTestDeletions: string[] = [];
  let currentFileIsTest = false;
  let currentPath: string | null = null;
  for (const line of diff.split("\n")) {
    if (deletedPaths === undefined && /^deleted file mode/.test(line)) {
      if (currentFileIsTest && currentPath !== null) {
        const deletedPath = currentPath;
        if (allowedTestDeletions.some(pattern => globMatches(pattern, deletedPath))) {
          authorizedTestDeletions.push(deletedPath);
        } else {
          testsDeleted++;
        }
      }
    }
    const diffHeader = /^diff --git a\/(\S+) b\/\S+$/.exec(line);
    if (diffHeader !== null) {
      currentPath = diffHeader[1] ?? null;
      currentFileIsTest = currentPath !== null
        && /(^|\/)tests?\/|\.test\.|\.spec\./.test(currentPath);
    } else if (/^diff --git /.test(line)) {
      currentPath = null;
      currentFileIsTest = /(^|\/)tests?\/|\.test\.|\.spec\./.test(line);
    }
    if (currentFileIsTest && /^\+.*\b(it|test|describe)\.(skip|todo)\(/.test(line)) testsSkipped++;
    if (currentFileIsTest && /^\+.*\bxit\(|^\+.*\bxdescribe\(/.test(line)) testsSkipped++;
  }
  for (const deletedPath of deletedPaths ?? []) {
    if (!/(^|\/)tests?\/|\.test\.|\.spec\./.test(deletedPath)) continue;
    if (allowedTestDeletions.some(pattern => globMatches(pattern, deletedPath))) {
      authorizedTestDeletions.push(deletedPath);
    } else {
      testsDeleted++;
    }
  }
  return { testsDeleted, testsSkipped, authorizedTestDeletions };
}

export function detectWeakenedTests(
  diff: string,
  allowedTestDeletions: string[] = [],
  deletedPaths?: string[],
): { testsDeleted: number; testsSkipped: number } {
  const { testsDeleted, testsSkipped } = analyzeWeakenedTests(
    diff,
    allowedTestDeletions,
    deletedPaths,
  );
  return { testsDeleted, testsSkipped };
}

function parseDeletedPaths(nameStatus: string): string[] {
  const fields = nameStatus.split("\0");
  const deletedPaths: string[] = [];
  for (let index = 0; index < fields.length; index += 1) {
    const entry = fields[index] ?? "";
    if (entry === "D") {
      const pathname = fields[index + 1];
      if (pathname !== undefined && pathname !== "") deletedPaths.push(pathname);
      index += 1;
      continue;
    }
    const separator = entry.indexOf("\t");
    if (separator >= 0 && entry.slice(0, separator) === "D") {
      deletedPaths.push(entry.slice(separator + 1));
    }
  }
  return deletedPaths;
}

export async function runReviews(args: {
  reviewers: ReviewerKind[];
  spec: DelegationSpec;
  pkg: RolePackage;
  worktreePath: string;
  deps: PipelineDependencies;
  runId: string;
  round: number;
  store: ArtifactStore;
  logNameNamespace?: string;
  onReviewer?: (role: `reviewer-${ReviewerKind}`) => Promise<void>;
}): Promise<ReviewRunResult> {
  const logNameNamespace = args.logNameNamespace === undefined
    ? ""
    : `${args.logNameNamespace}-`;
  const outcomes = await Promise.all(args.reviewers.map(async reviewer => {
    const role = `reviewer-${reviewer}` as const;
    await args.onReviewer?.(role);
    const outcome = await runStructuredRole<ReviewReport>({
      role,
      schema: schemas.reviewReport,
      logName: `role-${role}-${logNameNamespace}round${args.round}`,
      spec: args.spec,
      pkg: args.pkg,
      worktreePath: args.worktreePath,
      deps: args.deps,
      runId: args.runId,
      store: args.store,
    });
    return {
      review: outcome.ok ? { reviewer, report: outcome.report } : null,
      initialLogRef: outcome.ok ? null : outcome.failedRoleLogRef,
      roleLogRefs: outcome.roleLogRefs,
    };
  }));
  const roleLogRefs = outcomes.flatMap(outcome => outcome.roleLogRefs);
  const reviews = outcomes.map(outcome => outcome.review);
  if (reviews.every((review): review is ParsedReview => review !== null)) {
    return { ok: true, reviews, roleLogRefs };
  }
  const failed = outcomes.find(outcome => outcome.review === null);
  if (failed?.initialLogRef === null || failed === undefined) {
    throw new Error("unreachable invalid review state");
  }
  return { ok: false, failedRoleLogRef: failed.initialLogRef, roleLogRefs };
}

async function runSliceReview(args: {
  checkoutPath: string;
  spec: DelegationSpec;
  deps: PipelineDependencies;
  runId: string;
  baselineCommit: string;
  candidateCommit: string;
  namespace: string;
  reviewers: ReviewerKind[];
  verification: PipelineVerificationReport;
  store: ArtifactStore;
}): Promise<{ review: ConsolidationResult; roleLogRefs: string[] }> {
  const ps = args.deps.ps ?? getPlatformServices();
  return withManagedWorktree({
    manager: new WorktreeManager(
      args.checkoutPath,
      `${args.runId}-${args.namespace}-review`,
      ps,
      args.deps.borrowedCheckoutLease === undefined
        ? {}
        : { borrowedCheckoutLease: args.deps.borrowedCheckoutLease },
    ),
    commit: args.candidateCommit,
    cleanupFailureMessage: "slice review failed and its worktree could not be cleaned up",
    run: async worktreePath => {
      const diffText = await checkedGit(worktreePath, [
        "diff",
        `${args.baselineCommit}..${args.candidateCommit}`,
      ]);
      const reviewRun = await runReviews({
        reviewers: args.reviewers,
        spec: args.spec,
        pkg: {
          spec: args.spec,
          baselineCommit: args.baselineCommit,
          candidateCommit: args.candidateCommit,
          candidateDiff: diffText,
          testEvidence: JSON.stringify(verificationTestEvidence(args.verification)),
        },
        worktreePath,
        deps: args.deps,
        runId: args.runId,
        round: 1,
        store: args.store,
        logNameNamespace: args.namespace,
      });
      if (!reviewRun.ok) {
        throw new SliceExecutionError(
          `slice review did not produce valid structured output (see ${reviewRun.failedRoleLogRef})`,
          "producer-failure",
        );
      }
      return {
        review: consolidate(reviewRun.reviews.map(review => ({
          reviewer: review.reviewer,
          report: review.report,
        }))),
        roleLogRefs: reviewRun.roleLogRefs,
      };
    },
  });
}

async function runFix(args: {
  spec: DelegationSpec;
  pkg: RolePackage;
  worktreePath: string;
  deps: PipelineDependencies;
  runId: string;
  round: number;
  store: ArtifactStore;
  gitObjectAccess: LinkedWorktreeGitAccess;
  runStart?: RunStartContext;
}): Promise<FixRunResult> {
  const outcome = await runStructuredRole<FixReport>({
    role: "fixer",
    schema: schemas.fixReport,
    logName: `role-fixer-round${args.round}`,
    spec: args.spec,
    pkg: args.pkg,
    worktreePath: args.worktreePath,
    deps: args.deps,
    runId: args.runId,
    store: args.store,
    ...(args.runStart === undefined ? {} : { runStart: args.runStart }),
    gitObjectAccess: args.gitObjectAccess,
  });
  return outcome.ok
    ? { ok: true, fix: outcome.report, roleLogRefs: outcome.roleLogRefs }
    : outcome;
}

export async function runIncrement(args: {
  spec: DelegationSpec;
  pkg: RolePackage;
  worktreePath: string;
  deps: PipelineDependencies;
  runId: string;
  increment: number;
  store: ArtifactStore;
  gitObjectAccess: LinkedWorktreeGitAccess;
  runStart?: RunStartContext;
  logNameNamespace?: string;
}): Promise<StructuredRoleRunResult<IncrementReport>> {
  const logNameNamespace = args.logNameNamespace === undefined
    ? ""
    : `${args.logNameNamespace}-`;
  return runStructuredRole<IncrementReport>({
    role: "implementer",
    schema: schemas.incrementReport,
    logName: `role-implementer-${logNameNamespace}increment${args.increment}`,
    spec: args.spec,
    pkg: args.pkg,
    worktreePath: args.worktreePath,
    deps: args.deps,
    runId: args.runId,
    store: args.store,
    ...(args.runStart === undefined ? {} : { runStart: args.runStart }),
    gitObjectAccess: args.gitObjectAccess,
  });
}

interface CandidateProvenanceFailure {
  failure: FailureClassification;
  reason: string;
}

async function validateCandidateProvenance(args: {
  worktreePath: string;
  previousCandidateCommit: string;
  candidateCommit: string;
  gitObjectAccess: LinkedWorktreeGitAccess;
  phaseLabel?: string;
}): Promise<CandidateProvenanceFailure | null> {
  const phaseLabel = args.phaseLabel ?? "fix phase";
  const privateObjects = privateObjectReadOptions(args.gitObjectAccess);
  const candidateObject = await git(args.worktreePath, [
    "cat-file",
    "-e",
    `${args.candidateCommit}^{commit}`,
  ], privateObjects);
  if (candidateObject.exitCode !== 0) {
    return {
      failure: "producer-failure",
      reason: `${phaseLabel} reported a missing candidate commit`,
    };
  }

  const head = await git(
    args.worktreePath,
    ["rev-parse", "--verify", "HEAD^{commit}"],
    privateObjects,
  );
  if (head.exitCode !== 0 || head.stdout.trim() !== args.candidateCommit) {
    return {
      failure: "producer-failure",
      reason: `${phaseLabel} reported a candidate commit that does not match its worktree HEAD`,
    };
  }

  const candidateAncestry = await git(args.worktreePath, [
    "merge-base",
    "--is-ancestor",
    args.previousCandidateCommit,
    args.candidateCommit,
  ], privateObjects);
  if (candidateAncestry.exitCode !== 0) {
    return {
      failure: "sandbox-violation",
      reason: `${phaseLabel} candidate commit is not descended from the reviewed candidate`,
    };
  }

  const worktreeStatus = await git(args.worktreePath, [
    "status",
    "--porcelain",
    "--untracked-files=all",
  ], privateObjects);
  if (worktreeStatus.exitCode !== 0) {
    return {
      failure: "sandbox-violation",
      reason: `${phaseLabel} candidate worktree cleanliness could not be verified`,
    };
  }
  if (worktreeStatus.stdout.length > 0) {
    return {
      failure: "sandbox-violation",
      reason: `${phaseLabel} candidate worktree contains uncommitted state`,
    };
  }

  return null;
}

async function validateFixProvenance(args: {
  worktreePath: string;
  previousCandidateCommit: string;
  fix: FixReport;
  gitObjectAccess: LinkedWorktreeGitAccess;
}): Promise<CandidateProvenanceFailure | null> {
  const provenanceFailure = await validateCandidateProvenance({
    worktreePath: args.worktreePath,
    previousCandidateCommit: args.previousCandidateCommit,
    candidateCommit: args.fix.candidateCommit,
    gitObjectAccess: args.gitObjectAccess,
  });
  if (provenanceFailure !== null) return provenanceFailure;

  const privateObjects = privateObjectReadOptions(args.gitObjectAccess);
  const dispositionCommits = new Set(args.fix.dispositions.flatMap(disposition =>
    disposition.commit === undefined ? [] : [disposition.commit]));
  for (const dispositionCommit of dispositionCommits) {
    const object = await git(args.worktreePath, [
      "cat-file",
      "-e",
      `${dispositionCommit}^{commit}`,
    ], privateObjects);
    if (object.exitCode !== 0) {
      return {
        failure: "producer-failure",
        reason: "fix phase disposition reported a missing commit object",
      };
    }
    const [afterPrevious, beforeCandidate] = await Promise.all([
      git(args.worktreePath, [
        "merge-base",
        "--is-ancestor",
        args.previousCandidateCommit,
        dispositionCommit,
      ], privateObjects),
      git(args.worktreePath, [
        "merge-base",
        "--is-ancestor",
        dispositionCommit,
        args.fix.candidateCommit,
      ], privateObjects),
    ]);
    if (afterPrevious.exitCode !== 0 || beforeCandidate.exitCode !== 0) {
      return {
        failure: "producer-failure",
        reason: "fix phase disposition commit is outside the produced candidate lineage",
      };
    }
  }
  return null;
}

export async function verifyCandidate(args: {
  checkoutPath: string;
  spec: DelegationSpec;
  deps: PipelineDependencies;
  attempt: AttemptResult;
  baselineCommit: string;
  candidateCommit: string;
  store: ArtifactStore;
  namespace?: string;
}): Promise<{ verification: PipelineVerificationReport; baselineDrift: boolean }> {
  const ps = args.deps.ps ?? getPlatformServices();
  const namespace = args.namespace === undefined ? "" : `${args.namespace}-`;
  const manager = new WorktreeManager(
    args.checkoutPath,
    `${args.attempt.runId}-${namespace}verify`,
    ps,
    args.deps.borrowedCheckoutLease === undefined
      ? {}
      : { borrowedCheckoutLease: args.deps.borrowedCheckoutLease },
  );
  const fresh = await manager.create(args.candidateCommit);
  try {
    const [diffText, nameOnly, nameStatus, status, ancestry] = await Promise.all([
      checkedGit(fresh.path, ["diff", `${args.baselineCommit}..${args.candidateCommit}`]),
      checkedGit(fresh.path, [
        "diff",
        "--name-only",
        `${args.baselineCommit}..${args.candidateCommit}`,
      ]),
      checkedGit(fresh.path, [
        "diff",
        "--name-status",
        "--no-renames",
        "-z",
        `${args.baselineCommit}..${args.candidateCommit}`,
      ]),
      checkedGit(fresh.path, ["status", "--porcelain"]),
      git(fresh.path, [
        "merge-base",
        "--is-ancestor",
        args.baselineCommit,
        args.candidateCommit,
      ]),
    ]);
    const artifact = await candidateArtifact({
      worktreePath: fresh.path,
      baselineCommit: args.baselineCommit,
      candidateCommit: args.candidateCommit,
      anchorRef: args.attempt.candidate?.anchorRef ?? "",
      diffText,
    });
    const verifier = new AcceptanceVerifier({
      structural: async structuralArgs => {
        const result = await structuralVerify(structuralArgs);
        const failures = result.failures.filter(
          failure => !IGNORED_STRUCTURAL_FAILURES.has(failure),
        );
        return { ...result, ok: failures.length === 0, failures };
      },
    });
    const acceptance = await verifier.verify({
      repoRoot: args.checkoutPath,
      worktreePath: fresh.path,
      baseCommitOid: args.baselineCommit,
      artifact,
      spec: args.spec,
      ps,
      artifactStore: args.store,
      ...(args.deps.borrowedCheckoutLease === undefined
        ? {}
        : { borrowedCheckoutLease: args.deps.borrowedCheckoutLease }),
      verificationId: () => `${args.attempt.runId}-${namespace}pipeline`,
      logNamePrefix: `${namespace}pipeline-verification`,
    });
    const changedPaths = nameOnly.split("\n").map(line => line.trim()).filter(Boolean);
    const scopeViolations = changedPaths.filter(pathname =>
      !args.spec.writeAllowlist.some(pattern => globMatches(pattern, pathname))
      || args.spec.forbiddenScope.some(pattern => globMatches(pattern, pathname)));
    const weakened = analyzeWeakenedTests(
      diffText,
      args.spec.allowedTestDeletions,
      parseDeletedPaths(nameStatus),
    );
    const workspaceClean = status === "";
    const verificationCommands = new Map(
      args.spec.verification.map(command => [command.id, command]),
    );
    return {
      verification: {
        reportVersion: "1",
        pass: acceptance.ok
          && workspaceClean
          && scopeViolations.length === 0,
        commandResults: acceptance.commandOutcomes.map(command => ({
          id: command.id,
          exitCode: command.exitCode ?? -1,
          ok: command.exitCode !== null
            && !command.timedOut
            && (verificationCommands.get(command.id)?.expectedExitCodes.includes(
              command.exitCode,
            ) ?? false),
        })),
        workspaceClean,
        testsDeleted: weakened.testsDeleted,
        testsSkipped: weakened.testsSkipped,
        scopeViolations,
        evidence: {
          failures: [...acceptance.failures],
          acceptance: acceptance.evidence,
          commandOutcomes: acceptance.commandOutcomes.map(outcome => ({
            ...outcome,
            args: [...outcome.args],
          })),
          ...(args.spec.allowedTestDeletions === undefined
            ? {}
            : { authorizedTestDeletions: [...weakened.authorizedTestDeletions] }),
        },
      },
      baselineDrift: ancestry.exitCode !== 0,
    };
  } finally {
    const cleanupError = await cleanupWorktree(fresh);
    if (cleanupError !== null) {
      logger.warn("pipeline verification worktree could not be cleaned up", {
        error: redact(cleanupError instanceof Error ? cleanupError.message : String(cleanupError)),
      });
    }
  }
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

async function runPipelineWithLease(
  checkoutPath: string,
  spec: DelegationSpec,
  deps: PipelineDependencies,
  ps: PlatformServices,
  borrowedCheckoutLease: CheckoutLock,
): Promise<PipelineResult> {
  const runAttemptFn = deps.runAttempt ?? defaultRunAttempt;
  const slices = resolveSlices(spec);
  const initialSpec = slices.length === 0 ? spec : scopeSpecToSlice(spec, slices[0]!);
  const activeOwner: PipelineActiveMarker = {
    pid: process.pid,
    processToken: await ps.getProcessStartToken(process.pid).catch(() => null),
    startedAt: new Date().toISOString(),
    sliced: slices.length > 0,
  };
  let statusStore: ArtifactStore | null = null;
  let statusRunId: string | null = null;
  const emitPipelineStatus = async (
    phase: RunStatusPhase,
    fields: Partial<Pick<
      RunStatus,
      "sliceIndex" | "sliceCount" | "round" | "role" | "producerId" | "detail"
    >> = {},
  ): Promise<void> => {
    if (statusStore === null || statusRunId === null) return;
    await transitionRunStatusSafely(statusStore, statusRunId, phase, {
      sliceIndex: fields.sliceIndex ?? (slices.length > 0 ? slices.length : null),
      sliceCount: fields.sliceCount ?? (slices.length > 0 ? slices.length : null),
      round: fields.round ?? null,
      role: fields.role ?? null,
      producerId: fields.producerId ?? null,
      detail: fields.detail ?? null,
    });
  };
  const notePhase = async (phase: string): Promise<void> => {
    // Best-effort progress; must never affect pipeline control flow.
    try { await deps.onPhase?.(phase); } catch { /* progress reporting is advisory */ }
  };
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
      mode: slices.length > 0 ? "sliced" : "single",
      sliceIndex: slices.length > 0 ? 1 : null,
      sliceCount: slices.length > 0 ? slices.length : null,
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
      if (mapped !== null) {
        await emitPipelineStatus(mapped, {
          sliceIndex: slices.length > 0 ? 1 : null,
        });
      }
      try { await inheritedOnPhase?.(phase); } catch { /* host progress is advisory */ }
    },
    async onRunStart(context) {
      runStart = context;
      statusRunId = context.record.runId;
      statusStore = new ArtifactStore(context.record.runId);
      if (slices.length > 0) {
        await statusStore.writePipelineActiveMarker(activeOwner);
        slicedMarkerEstablished = true;
      }
      await writeRunStatusSafely(statusStore, {
        statusVersion: "1",
        runId: context.record.runId,
        mode: slices.length > 0 ? "sliced" : "single",
        phase: "preflight",
        sliceIndex: slices.length > 0 ? 1 : null,
        sliceCount: slices.length > 0 ? slices.length : null,
        round: null,
        role: null,
        producerId: null,
        startedAt: context.record.startedAt,
        updatedAt: new Date().toISOString(),
        detail: null,
      });
      await emitPipelineStatus("baseline-verify", {
        sliceIndex: slices.length > 0 ? 1 : null,
        detail: spec.executionMode === "edit" ? null : "skipped for read-only execution",
      });
      await inheritedOnRunStart?.(context);
    },
  });
  const store = new ArtifactStore(attempt.runId);
  await store.writePipelineArtifact("delegation-spec", spec);
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

  if (slices.length === 0) await store.writePipelineActiveMarker(activeOwner);
  const temporarySliceRefs: TemporarySliceRef[] = [];
  let finalAttempt = attempt;
  let authoritySafeToRelease = slices.length === 0;
  let pipelinePrimaryError: unknown;
  try {
    const reviewConfig = resolveReviewConfig(spec);
    const { reviewers, maxRounds } = reviewConfig;
    const maxIncrements = slices.length === 0
      ? resolveImplementationConfig(spec).maxIncrements
      : 1;
    const increments: PipelineIncrement[] = [];
    let incrementOutcome: IncrementOutcome | undefined;
    const rounds: PipelineRound[] = [];
    const baselineCommit = attempt.candidate.baseCommitOid;
    let currentCandidateCommit = attempt.candidate.candidateCommitOid;
    let frozenTestEvidence = testEvidence(attempt);
    let pipelineSlices: PipelineSlice[] = [];
    const archivePipelineFailure = async (args: {
      finalCandidateCommit: string;
      reason: string;
      failure: FailureClassification;
      slices?: PipelineSlice[];
      haltedSliceIndex?: number | null;
    }): Promise<PipelineResult> => {
      const failedAttempt = slices.length === 0
        ? attempt
        : await archiveSlicedFailure({
          checkoutPath,
          attempt,
          failure: args.failure,
          reason: args.reason,
          store,
        });
      if (slices.length > 0) authoritySafeToRelease = true;
      finalAttempt = failedAttempt;
      return failedResult(
        failedAttempt,
        rounds,
        args.finalCandidateCommit,
        args.reason,
        args.failure,
        increments,
        args.slices ?? pipelineSlices,
        args.haltedSliceIndex ?? null,
      );
    };

    /**
     * A role that cannot produce parseable structured output is an orchestration
     * failure, not a verdict on the candidate. Discarding independently verified
     * bytes for it forces a full re-dispatch of work that already passed — the
     * single most expensive recurring loss in the delegation loop. Promote and
     * re-verify what exists; present it for the human decision the pipeline could
     * not complete itself. Only a candidate that fails verification is discarded.
     */
    const salvagePipelineFailure = async (args: {
      finalCandidateCommit: string;
      reason: string;
      failure: FailureClassification;
      gitObjectAccess: LinkedWorktreeGitAccess | null;
    }): Promise<PipelineResult> => {
      const fallback = async (): Promise<PipelineResult> => archivePipelineFailure({
        finalCandidateCommit: args.finalCandidateCommit,
        reason: args.reason,
        failure: args.failure,
      });
      if (finalAttempt.candidate === null) return await fallback();

      let salvagedAttempt = finalAttempt;
      let salvagedCommit = args.finalCandidateCommit;
      if (salvagedCommit !== finalAttempt.candidate.candidateCommitOid) {
        const promoted = await promoteFinalCandidate({
          checkoutPath,
          attempt: finalAttempt,
          initialCandidate: finalAttempt.candidate,
          baselineCommit,
          candidateCommit: salvagedCommit,
          store,
          ...(args.gitObjectAccess === null
            ? {}
            : { privateObjectAccess: args.gitObjectAccess }),
        });
        if (promoted === null) return await fallback();
        salvagedAttempt = promoted.attempt;
        salvagedCommit = promoted.candidateCommit;
      }
      if (slices.length > 0) authoritySafeToRelease = true;

      let verified;
      try {
        verified = await verifyCandidate({
          checkoutPath,
          spec,
          deps,
          attempt: salvagedAttempt,
          baselineCommit,
          candidateCommit: salvagedCommit,
          store,
          namespace: "salvage",
        });
      } catch {
        return await fallback();
      }
      const manifestForArchive = await store.readManifest(attempt.runId);
      if (!verified.verification.pass) {
        // The freshest evidence says these bytes do not verify. Record that where
        // the accept gate reads it, or the archived run keeps advertising the
        // stale verified-candidate status and stays acceptable. The bytes are
        // retained; only their acceptability is withdrawn.
        if (manifestForArchive === null) return await fallback();
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
        if (slices.length > 0) authoritySafeToRelease = true;
        finalAttempt = demoted;
        await store.writePipelineArtifact("verification", verified.verification);
        const failed = failedResult(
          demoted,
          rounds,
          salvagedCommit,
          args.reason,
          args.failure,
          increments,
          pipelineSlices,
        );
        await store.writePipelineArtifact("pipeline-result", failed);
        return failed;
      }

      // A human reading the archived run later must be able to see that the
      // pipeline never reviewed this candidate. Record that durably in the
      // result the accept path reads, not only in the transient gate.
      if (manifestForArchive === null) return await fallback();
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

      finalAttempt = salvagedAttempt;
      await store.writePipelineArtifact("verification", verified.verification);
      const salvaged: PipelineResult = {
        runId: attempt.runId,
        status: "human-decision-required",
        attempt: salvagedAttempt,
        increments,
        slices: pipelineSlices,
        haltedSliceIndex: null,
        rounds,
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
    };

    if (slices.length > 0) {
      const initialNamespace = "slice-1-attempt-0";
      await emitPipelineStatus("verifying", { sliceIndex: 1 });
      const initialVerification = await verifyCandidate({
        checkoutPath,
        spec: initialSpec,
        deps,
        attempt,
        baselineCommit,
        candidateCommit: currentCandidateCommit,
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
            baselineCommit,
            candidateCommit: currentCandidateCommit,
            namespace: initialNamespace,
            reviewers,
            verification: initialVerification.verification,
            store,
          });
        } catch (error) {
          const archived = await archiveSliceExecutionError({
            checkoutPath,
            error,
            attempt,
            store,
          });
          authoritySafeToRelease = true;
          finalAttempt = archived.failedAttempt;
          if (error !== archived.sliceError) throw error;
          const failed = failedResult(
            archived.failedAttempt,
            rounds,
            baselineCommit,
            archived.sliceError.message,
            archived.sliceError.failure,
            increments,
          );
          await store.writePipelineArtifact("pipeline-result", failed);
          return failed;
        }
        initialPerSliceReview = reviewed.review;
        initialRoleLogRefs.push(...reviewed.roleLogRefs);
      }

      const completedSlices: PipelineSlice[] = [];
      let phase: Awaited<ReturnType<typeof runSlicePhase>>;
      try {
        phase = await runSlicePhase(slices, baselineCommit, {
          maxRounds,
          concurrency: resolveSliceConcurrency(spec),
          composeSlice: async composeArgs => composeSliceOntoHead({
            checkoutPath,
            runId: attempt.runId,
            ...composeArgs,
          }),
          initialAttempt: {
            candidateCommit: currentCandidateCommit,
            verification: initialVerification.verification,
            perSliceReview: initialPerSliceReview,
            roleLogRefs: initialRoleLogRefs,
          },
          runSlice: async (slice, index, base, sliceAttempt, priorAttempts) => {
            const namespace = `slice-${index}-attempt-${sliceAttempt}`;
            const scopedSpec = scopeSpecToSlice(spec, slice);
            return withManagedWorktree({
              manager: new WorktreeManager(
                checkoutPath,
                `${attempt.runId}-${namespace}`,
                ps,
                deps.borrowedCheckoutLease === undefined
                  ? {}
                  : { borrowedCheckoutLease: deps.borrowedCheckoutLease },
              ),
              commit: base,
              cleanupFailureMessage:
                "slice implementation failed and its worktree could not be cleaned up",
              run: async worktreePath => {
                let gitObjectAccess: LinkedWorktreeGitAccess;
                try {
                  gitObjectAccess = await resolveLinkedWorktreeWritableRoots(worktreePath);
                } catch {
                  throw new SliceExecutionError(
                    "slice implementer git object isolation could not be established",
                    "sandbox-violation",
                  );
                }
                await emitPipelineStatus("implementing", {
                  sliceIndex: index,
                  role: "implementer",
                });
                const incrementRun = await runIncrement({
                  spec: scopedSpec,
                  pkg: {
                    spec: scopedSpec,
                    baselineCommit: base,
                    candidateCommit: base,
                    candidateDiff: "",
                    testEvidence: completedSlices.length === 0
                      ? testEvidence(attempt)
                      : sliceTestEvidence(completedSlices),
                    // A repair that cannot see why the last attempt was rejected
                    // reproduces it. Bounded and redacted like any prompt data.
                    ...(priorAttempts === undefined || priorAttempts.length === 0
                      ? {}
                      : { priorAttempts: describePriorAttempts(priorAttempts) }),
                  },
                  worktreePath,
                  deps,
                  runId: attempt.runId,
                  increment: sliceAttempt + 1,
                  store,
                  gitObjectAccess,
                  ...(runStart === undefined ? {} : { runStart }),
                  logNameNamespace: namespace,
                });
                if (!incrementRun.ok) {
                  throw new SliceExecutionError(
                    `slice implementer did not produce valid structured output (see ${incrementRun.failedRoleLogRef})`,
                    incrementRun.failure,
                  );
                }

                await emitPipelineStatus("freezing", {
                  sliceIndex: index,
                  role: "implementer",
                });
                const candidateCommit = incrementRun.report.candidateCommit;
                const provenanceFailure = await validateCandidateProvenance({
                  worktreePath,
                  previousCandidateCommit: base,
                  candidateCommit,
                  gitObjectAccess,
                  phaseLabel: "slice implementer",
                });
                if (provenanceFailure !== null) {
                  throw new SliceExecutionError(
                    provenanceFailure.reason,
                    provenanceFailure.failure,
                  );
                }
                if (candidateCommit !== base) {
                  try {
                    await importPromotedObjects({
                      checkoutPath,
                      baselineCommit: base,
                      promotedCommit: candidateCommit,
                      access: gitObjectAccess,
                    });
                  } catch {
                    throw new SliceExecutionError(
                      "slice candidate objects could not be imported into the shared git object store",
                      "sandbox-violation",
                    );
                  }
                  const temporaryRef = {
                    ref: temporarySliceRef(attempt.runId, index, sliceAttempt),
                    oid: candidateCommit,
                  };
                  try {
                    await createTemporarySliceRef(checkoutPath, temporaryRef);
                  } catch {
                    throw new SliceExecutionError(
                      "slice candidate temporary ref could not be established",
                      "sandbox-violation",
                    );
                  }
                  temporarySliceRefs.push(temporaryRef);
                }

                await emitPipelineStatus("verifying", { sliceIndex: index });
                const verified = await verifyCandidate({
                  checkoutPath,
                  spec: scopedSpec,
                  deps,
                  attempt,
                  baselineCommit: base,
                  candidateCommit,
                  store,
                  namespace,
                });
                let perSliceReview: ConsolidationResult | null = null;
                const roleLogRefs = [...incrementRun.roleLogRefs];
                if (reviewConfig.perSlice === true) {
                  const reviewed = await runSliceReview({
                    checkoutPath,
                    spec: scopedSpec,
                    deps,
                    runId: attempt.runId,
                    baselineCommit: base,
                    candidateCommit,
                    namespace,
                    reviewers,
                    verification: verified.verification,
                    store,
                  });
                  perSliceReview = reviewed.review;
                  roleLogRefs.push(...reviewed.roleLogRefs);
                }
                return {
                  candidateCommit,
                  verification: verified.verification,
                  perSliceReview,
                  roleLogRefs,
                };
              },
            });
          },
          onAttempt: evidence => store.writePipelineArtifact(
            `slice-${evidence.sliceIndex}-attempt-${evidence.attempt}`,
            evidence,
          ),
          onSlice: async slice => {
            await store.writePipelineArtifact(`slice-${slice.index}`, slice);
            completedSlices.push(structuredClone(slice));
          },
        });
      } catch (error) {
        const archived = await archiveSliceExecutionError({
          checkoutPath,
          error,
          attempt,
          store,
        });
        authoritySafeToRelease = true;
        finalAttempt = archived.failedAttempt;
        if (error !== archived.sliceError) throw error;
        const failed = failedResult(
          archived.failedAttempt,
          rounds,
          completedSlices.at(-1)?.candidateCommit ?? baselineCommit,
          archived.sliceError.message,
          archived.sliceError.failure,
          increments,
          completedSlices,
        );
        await store.writePipelineArtifact("pipeline-result", failed);
        return failed;
      }
      pipelineSlices = phase.slices;
      currentCandidateCommit = phase.finalCandidateCommit;
      if (phase.haltedSliceIndex !== null) {
        const halted = phase.slices.at(-1);
        const reason = `slice phase halted at slice ${phase.haltedSliceIndex}: ${halted?.reasons.join("; ") ?? "objective gate failed"}`;
        if (currentCandidateCommit === baselineCommit) {
          // No slice advanced past the baseline, so there is no partial branch
          // for the human to accept. Retain the slice evidence and report the
          // halt as a failure.
          const failedAttempt = await archiveSlicedFailure({
            checkoutPath,
            attempt,
            failure: "verification-failure",
            reason,
            store,
          });
          authoritySafeToRelease = true;
          finalAttempt = failedAttempt;
          const failed = failedResult(
            failedAttempt,
            rounds,
            currentCandidateCommit,
            reason,
            "verification-failure",
            increments,
            phase.slices,
            phase.haltedSliceIndex,
          );
          await store.writePipelineArtifact("pipeline-result", failed);
          return failed;
        }
        // At least one slice advanced. Promote the partial branch (the advanced
        // slices) to a frozen, acceptable candidate and hand the halt to the
        // human — the design routes a mid-run halt to human-decision-required so
        // the human can accept, reject, or revise the partial branch. The failed
        // slice's attempts stay in `slices` as evidence. Review rounds are
        // skipped; final verification runs so the human sees an honest report on
        // the exact partial branch.
        const promoted = await promoteFinalCandidate({
          checkoutPath,
          attempt,
          initialCandidate: attempt.candidate,
          baselineCommit,
          candidateCommit: currentCandidateCommit,
          store,
        });
        if (promoted === null) {
          const promotionReason = "partial halt candidate could not be promoted from the git object store";
          const failedAttempt = await archiveSlicedFailure({
            checkoutPath,
            attempt,
            failure: "sandbox-violation",
            reason: promotionReason,
            store,
          });
          authoritySafeToRelease = true;
          finalAttempt = failedAttempt;
          const failed = failedResult(
            failedAttempt,
            rounds,
            currentCandidateCommit,
            promotionReason,
            "sandbox-violation",
            increments,
            phase.slices,
            phase.haltedSliceIndex,
          );
          await store.writePipelineArtifact("pipeline-result", failed);
          return failed;
        }
        finalAttempt = promoted.attempt;
        currentCandidateCommit = promoted.candidateCommit;
        authoritySafeToRelease = true;
        await notePhase("partial halt verification");
        const verified = await verifyCandidate({
          checkoutPath,
          spec,
          deps,
          attempt: finalAttempt,
          baselineCommit,
          candidateCommit: currentCandidateCommit,
          store,
          namespace: "final",
        });
        await store.writePipelineArtifact("verification", verified.verification);
        const haltResult: PipelineResult = {
          runId: attempt.runId,
          status: "human-decision-required",
          attempt: finalAttempt,
          increments,
          slices: phase.slices,
          haltedSliceIndex: phase.haltedSliceIndex,
          rounds,
          verification: verified.verification,
          gate: {
            decisionReady: false,
            requiresHumanDecision: true,
            reasons: [reason],
          },
          finalCandidateCommit: currentCandidateCommit,
          failure: null,
        };
        await store.writePipelineArtifact("pipeline-result", haltResult);
        return haltResult;
      }
      frozenTestEvidence = sliceTestEvidence(phase.slices);
    }

    const candidateWorktree = await new WorktreeManager(
      checkoutPath,
      slices.length === 0 ? `${attempt.runId}-pipeline` : `${attempt.runId}-composed-review`,
      ps,
      deps.borrowedCheckoutLease === undefined
        ? {}
        : { borrowedCheckoutLease: deps.borrowedCheckoutLease },
    ).create(currentCandidateCommit);
    let gitObjectAccess: LinkedWorktreeGitAccess | null = null;
    try {
      if (maxIncrements > 1) {
        try {
          gitObjectAccess = await resolveLinkedWorktreeWritableRoots(candidateWorktree.path);
        } catch {
          return failedResult(
            attempt,
            rounds,
            currentCandidateCommit,
            "increment git object isolation could not be established",
            "sandbox-violation",
            increments,
            pipelineSlices,
          );
        }

        try {
          for (let increment = 2; increment <= maxIncrements; increment += 1) {
            // A cancellation that lands between Producer runs must stop the
            // pipeline here. Otherwise the loop keeps launching Producers even
            // though the caller has already given up on the run.
            if (deps.abortSignal?.aborted === true) {
              return failedResult(
                attempt,
                rounds,
                currentCandidateCommit,
                `cancelled before increment ${increment}`,
                "cancelled",
                increments,
                pipelineSlices,
              );
            }
            await notePhase(`increment ${increment}/${maxIncrements}`);
            const previousCandidateCommit = currentCandidateCommit;
            const diffText = await checkedGit(candidateWorktree.path, [
              "diff",
              `${baselineCommit}..${currentCandidateCommit}`,
            ], privateObjectReadOptions(gitObjectAccess));
            const incrementRun = await runIncrement({
              spec,
              pkg: {
                spec,
                baselineCommit,
                candidateCommit: currentCandidateCommit,
                candidateDiff: diffText,
                testEvidence: frozenTestEvidence,
                progress: composeProgressNotes(increments.at(-1)?.report ?? attempt),
              },
              worktreePath: candidateWorktree.path,
              deps,
              runId: attempt.runId,
              increment,
              store,
              gitObjectAccess,
              ...(runStart === undefined ? {} : { runStart }),
            });
            if (!incrementRun.ok) {
              return failedResult(
                attempt,
                rounds,
                currentCandidateCommit,
                `increment phase did not produce valid structured output (see ${incrementRun.failedRoleLogRef})`,
                incrementRun.failure,
                increments,
                pipelineSlices,
              );
            }

            const report = redactRecord(incrementRun.report);
            await store.writePipelineArtifact(`increment-${increment}`, report);
            const provenanceFailure = await validateCandidateProvenance({
              worktreePath: candidateWorktree.path,
              previousCandidateCommit,
              candidateCommit: report.candidateCommit,
              gitObjectAccess,
            });
            if (provenanceFailure !== null) {
              return failedResult(
                attempt,
                rounds,
                currentCandidateCommit,
                provenanceFailure.reason,
                provenanceFailure.failure,
                increments,
                pipelineSlices,
              );
            }

            const privateObjects = privateObjectReadOptions(gitObjectAccess);
            const [previousTree, candidateTree] = await Promise.all([
              checkedGit(
                candidateWorktree.path,
                ["rev-parse", `${previousCandidateCommit}^{tree}`],
                privateObjects,
              ),
              checkedGit(
                candidateWorktree.path,
                ["rev-parse", `${report.candidateCommit}^{tree}`],
                privateObjects,
              ),
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
                return failedResult(
                  attempt,
                  rounds,
                  currentCandidateCommit,
                  "increment objects could not be imported into the shared git object store",
                  "sandbox-violation",
                  increments,
                  pipelineSlices,
                );
              }
            }
            currentCandidateCommit = report.candidateCommit;
            increments.push({
              increment,
              report,
              roleLogRefs: incrementRun.roleLogRefs,
            });

            if (report.status === "complete") {
              incrementOutcome = "complete";
              break;
            }
            if (report.status === "blocked") {
              incrementOutcome = "blocked";
              break;
            }
            if (!progressed) {
              incrementOutcome = "stalled";
              break;
            }
          }
          incrementOutcome ??= "budget-exhausted";
        } catch {
          return failedResult(
            attempt,
            rounds,
            currentCandidateCommit,
            "increment phase failed unexpectedly",
            "producer-failure",
            increments,
            pipelineSlices,
          );
        }
      }

      for (let round = 1; round <= maxRounds; round += 1) {
        if (deps.abortSignal?.aborted === true) {
          return failedResult(
            attempt,
            rounds,
            currentCandidateCommit,
            `cancelled before review round ${round}`,
            "cancelled",
            increments,
            pipelineSlices,
          );
        }
        await notePhase(`review round ${round}/${maxRounds}`);
        const diffText = await checkedGit(candidateWorktree.path, [
          "diff",
          `${baselineCommit}..${currentCandidateCommit}`,
        ], gitObjectAccess === null ? undefined : privateObjectReadOptions(gitObjectAccess));
        const pkg: RolePackage = {
          spec,
          baselineCommit,
          candidateCommit: currentCandidateCommit,
          candidateDiff: diffText,
          testEvidence: frozenTestEvidence,
        };
        const reviewRun = await runReviews({
          reviewers,
          spec,
          pkg,
          worktreePath: candidateWorktree.path,
          deps,
          runId: attempt.runId,
          round,
          store,
          onReviewer: role => emitPipelineStatus("reviewing", {
            round,
            role,
          }),
        });
        if (!reviewRun.ok) {
          const reason = `review phase did not produce valid structured output (see ${reviewRun.failedRoleLogRef})`;
          return await salvagePipelineFailure({
            finalCandidateCommit: currentCandidateCommit,
            reason,
            failure: "producer-failure",
            gitObjectAccess,
          });
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
        rounds.push(roundRecord);
        if (!blocking && approved) break;

        try {
          gitObjectAccess ??= await resolveLinkedWorktreeWritableRoots(candidateWorktree.path);
        } catch {
          return await archivePipelineFailure({
            finalCandidateCommit: currentCandidateCommit,
            reason: "fixer git object isolation could not be established",
            failure: "sandbox-violation",
          });
        }

        await emitPipelineStatus("fixing", { round, role: "fixer" });
        await notePhase(`round ${round}: applying fixes`);
        const fixRun = await runFix({
          spec,
          pkg: { ...pkg, findings: consolidated.findings },
          worktreePath: candidateWorktree.path,
          deps,
          runId: attempt.runId,
          round,
          store,
          gitObjectAccess,
          ...(runStart === undefined ? {} : { runStart }),
        });
        if (!fixRun.ok) {
          // The fix never landed, so the bytes here are the last reviewed
          // candidate — salvage them rather than losing the whole round.
          return await salvagePipelineFailure({
            finalCandidateCommit: currentCandidateCommit,
            reason: `fix phase did not produce valid structured output (see ${fixRun.failedRoleLogRef})`,
            failure: fixRun.failure,
            gitObjectAccess,
          });
        }
        const { fix } = fixRun;
        await store.writePipelineArtifact(`round-${round}-fix`, fix);
        const provenanceFailure = await validateFixProvenance({
          worktreePath: candidateWorktree.path,
          previousCandidateCommit: currentCandidateCommit,
          fix,
          gitObjectAccess,
        });
        if (provenanceFailure !== null) {
          return await archivePipelineFailure({
            finalCandidateCommit: currentCandidateCommit,
            reason: provenanceFailure.reason,
            failure: provenanceFailure.failure,
          });
        }
        currentCandidateCommit = fix.candidateCommit;
        roundRecord.fix = fix;
        roundRecord.roleLogRefs = [...reviewRun.roleLogRefs, ...fixRun.roleLogRefs];
      }

      if (currentCandidateCommit !== attempt.candidate.candidateCommitOid) {
        if (gitObjectAccess === null && slices.length === 0) {
          return failedResult(
            attempt,
            rounds,
            currentCandidateCommit,
            "fixer git object isolation state is missing during promotion",
            "sandbox-violation",
            increments,
            pipelineSlices,
          );
        }
        const promoted = await promoteFinalCandidate({
          checkoutPath,
          attempt,
          initialCandidate: attempt.candidate,
          baselineCommit,
          candidateCommit: currentCandidateCommit,
          store,
          ...(gitObjectAccess === null ? {} : { privateObjectAccess: gitObjectAccess }),
        });
        if (promoted === null) {
          return await archivePipelineFailure({
            finalCandidateCommit: currentCandidateCommit,
            reason: slices.length === 0
              ? "fixer objects could not be imported into the shared git object store"
              : "sliced candidate could not be promoted from the shared git object store",
            failure: "sandbox-violation",
          });
        }
        finalAttempt = promoted.attempt;
        currentCandidateCommit = promoted.candidateCommit;
      }
    } finally {
      const cleanupError = await cleanupWorktree(candidateWorktree);
      if (cleanupError !== null) {
        logger.warn("pipeline round worktree could not be cleaned up", {
          error: redact(cleanupError instanceof Error ? cleanupError.message : String(cleanupError)),
        });
      }
    }

    await emitPipelineStatus("verifying");
    await notePhase("final verification");
    const verified = await verifyCandidate({
      checkoutPath,
      spec,
      deps,
      attempt: finalAttempt,
      baselineCommit,
      candidateCommit: currentCandidateCommit,
      store,
      ...(slices.length === 0 ? {} : { namespace: "final" }),
    });
    await store.writePipelineArtifact("verification", verified.verification);
    const lastRound = rounds.at(-1);
    await emitPipelineStatus("gating");
    await notePhase("evaluating gate");
    const gate = evaluateGates({
      findings: lastRound?.consolidated.findings ?? [],
      dispositions: lastRound?.fix?.dispositions ?? [],
      verification: verified.verification,
      roundsUsed: rounds.length,
      maxRounds,
      finalRoundReviewed: (lastRound?.fix ?? null) === null,
      artifactsValid: true,
      baselineDrift: verified.baselineDrift,
      // Computed over the whole round history, not one round's prose.
      nonConvergence: detectNonConvergence(rounds.map(round => ({
        round: round.round,
        findings: round.consolidated.findings,
        fixAttempted: round.fix !== null,
      }))),
      ...(incrementOutcome === undefined ? {} : { incrementOutcome }),
    });
    // A refusing gate lived only in the pipeline-result artifact, which the
    // accept path never reads: it loads the archived attempt, sees
    // verified-candidate with no failure, and offers the candidate as clean.
    // `archiveSlicedFailure` already records incompleteness in evidence for
    // exactly this reason; a gate that completed and said no needs the same
    // durability, or "blocking findings survived" is invisible at decision time.
    const manifestForArchive = await store.readManifest(attempt.runId);
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
          candidateCommitOid: currentCandidateCommit,
          requiresHumanDecision: gate.requiresHumanDecision,
        },
      );
    }
    if (!gate.decisionReady) {
      finalAttempt = {
        ...finalAttempt,
        evidence: {
          ...finalAttempt.evidence,
          pipelineGateRefused: {
            reasons: gate.reasons,
            requiresHumanDecision: gate.requiresHumanDecision,
          },
        },
      };
    } else {
      finalAttempt = {
        ...finalAttempt,
        evidence: {
          ...finalAttempt.evidence,
          pipelineGateCleared: {
            candidateCommitOid: currentCandidateCommit,
            requiresHumanDecision: gate.requiresHumanDecision,
          },
        },
      };
    }
    await store.promoteTerminalArtifacts({
      result: finalAttempt,
      manifest: manifestForArchive,
    });
    const result: PipelineResult = {
      runId: attempt.runId,
      status: gate.decisionReady ? "decision-ready" : "human-decision-required",
      attempt: finalAttempt,
      increments,
      slices: pipelineSlices,
      haltedSliceIndex: null,
      rounds,
      verification: verified.verification,
      gate,
      finalCandidateCommit: currentCandidateCommit,
      failure: null,
    };
    await store.writePipelineArtifact("pipeline-result", result);
    // The terminal done/failed status is written by `runPipeline` while it still
    // holds the lease, before `finally` releases it, so it is not repeated here.
    await notePhase(`finished: ${result.status}`);
    authoritySafeToRelease = true;
    return result;
  } catch (error) {
    let terminalError = error;
    if (slices.length > 0
      && finalAttempt.status === "verified-candidate"
      && !containsSlicedFailureArchiveError(error)) {
      try {
        finalAttempt = await archiveSlicedFailure({
          checkoutPath,
          attempt: finalAttempt,
          failure: "verification-failure",
          reason: "sliced pipeline terminated before completing trusted gates",
          store,
        });
        authoritySafeToRelease = true;
      } catch (archiveError) {
        terminalError = new AggregateError(
          [error, archiveError],
          "sliced pipeline failed and its attempt result could not be archived",
        );
      }
    }
    await emitPipelineStatus("failed", {
      detail: terminalError instanceof Error ? terminalError.message : "pipeline failed unexpectedly",
    });
    pipelinePrimaryError = terminalError;
    throw terminalError;
  } finally {
    const cleanupErrors = await cleanupTemporarySliceRefs(checkoutPath, temporarySliceRefs);
    if (cleanupErrors.length > 0
      && slices.length > 0
      && finalAttempt.status === "verified-candidate"
      && !containsSlicedFailureArchiveError(pipelinePrimaryError)) {
      try {
        finalAttempt = await archiveSlicedFailure({
          checkoutPath,
          attempt: finalAttempt,
          failure: "verification-failure",
          reason: "temporary slice ref cleanup did not complete",
          store,
        });
        authoritySafeToRelease = true;
      } catch (archiveError) {
        cleanupErrors.push(archiveError);
      }
    }
    if (cleanupErrors.length === 0 && authoritySafeToRelease) {
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
