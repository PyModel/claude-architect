import {
  AutopilotController,
  AutopilotControllerError,
  type AutopilotControllerEvent,
  type AutopilotStatusResult,
} from "../autopilot/autopilot-controller.js";
import { WorkflowBranchManager } from "../autopilot/branch-manager.js";
import { CandidatePromoter } from "../autopilot/candidate-promoter.js";
import { FinalBranchReviewer } from "../autopilot/final-branch-reviewer.js";
import { WorkflowStore } from "../autopilot/workflow-store.js";
import { git as runGit } from "../git/git-exec.js";
import { applyCandidateTree as applyTree } from "../integrate/controlled-integrator.js";
import type { CheckoutLock, PlatformServices } from "../platform/platform-services.js";
import { getPlatformServices } from "../platform/select-platform.js";
import {
  runPipeline as executePipeline,
  type PipelineDependencies,
  type PipelineResult,
} from "../pipeline/pipeline-runtime.js";
import { registry } from "../producers/producer-registry.js";
import type { AttemptResult, CandidateArtifact } from "../protocol/attempt-result.js";
import {
  INTEGRABLE_DECISION_AUTHORITIES,
  type CandidateDecision,
  type CandidateDecisionV2,
  type HumanCandidateDecisionV2,
} from "../protocol/candidate-decision.js";
import type { PipelineGateCleared } from "../protocol/pipeline-gate-cleared.js";
import type { DelegationSpec } from "../protocol/delegation-spec.js";
import { checkVersionCompat } from "../protocol/schema-loader.js";
import { specSha256 } from "../protocol/spec-hash.js";
import { validateAutopilotSpec, validateSpec } from "../protocol/spec-validator.js";
import {
  DELEGATION_SPEC_VERSION,
  PROTOCOL_VERSION,
} from "../protocol/versions.js";
import {
  ArtifactStore,
  type DecisionProvenance,
  type PipelineActiveMarker,
  type RunDecisionValue,
} from "../runtime/artifact-store.js";
import {
  runAttempt as executeAttempt,
  type AttemptRuntimeDependencies,
} from "../runtime/attempt-runtime.js";
import {
  createReviewSnapshot,
  reviewSnapshotHash,
  type ReviewSnapshot,
} from "../runtime/review-snapshot.js";
import type { RunManifest } from "../runtime/run-manifest.js";
import {
  readRunDecisionSnapshot,
  runDecision,
  type RunDecisionSnapshot,
} from "../runtime/run-decision.js";
import { PlatformSafety } from "../platform/platform-safety.js";
import { redact } from "../runtime/redaction.js";
import { NestedDelegationError, RuntimeError } from "../util/errors.js";
import { logger } from "../util/logger.js";
import { AcceptanceVerifier } from "../verify/acceptance-verifier.js";
import { runAdvisorStage } from "../pipeline/advisor-stage.js";
import {
  allowlistSufficiencyDiagnostic,
  checkAllowlistSufficiency,
} from "./allowlist-sufficiency.js";
import { checkLiveBundle, liveBundleDiagnostic } from "./live-bundle.js";
import { boundIgnoredPathEvidence, withRepoLock } from "./serialize.js";

export type RunDecision = CandidateDecision;

export type HumanDecisionRecord = Omit<
  HumanCandidateDecisionV2,
  "decisionVersion" | "authority"
>;

export interface ToolArtifactStore {
  readResult(): Promise<AttemptResult | null>;
  readManifest(): Promise<RunManifest | null>;
  /**
   * Required, not optional, for the same reason as `readRunStartSpecSha256`
   * below: when these could be omitted, `sharedReviewSnapshot` would no-op the
   * write, read nothing back, and return the in-memory snapshot — and the
   * decision record then claimed an `evidenceHash` for bytes that were never
   * persisted, which no later audit could re-verify.
   */
  writeReviewSnapshot(snapshot: ReviewSnapshot): Promise<void>;
  readReviewSnapshot(): Promise<ReviewSnapshot | null>;
  writeHumanDecision(record: HumanDecisionRecord): Promise<void>;
  /** Persist a decision whose authority the lifecycle already resolved. */
  writeCandidateDecisionRecord(record: CandidateDecisionV2): Promise<void>;
  readCandidateDecision(): Promise<RunDecision | null>;
  readPipelineGateCleared?(): Promise<PipelineGateCleared | null>;
  readPipelineActiveMarker(): Promise<PipelineActiveMarker | null>;
  /**
   * The spec hash recorded when the run started. Required, not optional: a store
   * that cannot answer must say so explicitly, because a caller asking to verify
   * a run id against a spec must never be told "verified" by omission.
   */
  readRunStartSpecSha256(): Promise<string | null>;
}

export interface ToolDependencies {
  ps?: PlatformServices;
  storeFactory?: (runId: string) => ToolArtifactStore;
  git?: typeof runGit;
  runAttempt?: typeof executeAttempt;
  runPipeline?: typeof executePipeline;
  applyCandidateTree?: typeof applyTree;
  attemptDependencies?: AttemptRuntimeDependencies;
  skillProtocolVersion?: string;
  now?: () => Date;
  /** Host progress reporting for long-running delegate calls. */
  onProgress?: (message: string) => void;
  /**
   * Cancellation from the caller. Every layer below already honors an
   * AbortSignal; without this the MCP boundary supplied none, so a cancelled
   * request left the Producer tree running and the pipeline advancing.
   */
  abortSignal?: AbortSignal;
  checkLiveBundle?: typeof checkLiveBundle;
  checkAllowlistSufficiency?: typeof checkAllowlistSufficiency;
  /**
   * How a decision reaching `decideCandidate` was obtained. The MCP server sets
   * this to `human-elicitation` only when it prompted a person itself, and to
   * `policy-autonomous` when the autonomous authority cleared the candidate
   * without a prompt; anything else is recorded as caller-asserted so the trust
   * gap stays visible.
   */
  decisionProvenance?: DecisionProvenance;
  /**
   * Resolve provenance from the advisory loaded under the same repository and
   * checkout lock that guards the decision write. The MCP server owns human
   * elicitation; keeping this callback inside the locked lifecycle prevents a
   * stale unlocked advisory from authorizing autonomous acceptance.
   */
  decisionProvenanceResolver?: (args: {
    runId: string;
    decision: RunDecisionValue;
    advisory: DecisionAdvisory;
    /** The already-loaded archive, so the resolver never re-reads it. */
    snapshot: RunDecisionSnapshot;
  }) => Promise<DecisionProvenance>;
  /** Injectable controller seam for hermetic MCP protocol tests. */
  autopilotControllerFactory?: (context: {
    onProgress?: (message: string) => void;
    abortSignal?: AbortSignal;
  }) => Pick<AutopilotController, "start" | "status" | "resume">;
}

export interface ToolErrorResult {
  ok: false;
  error: string;
  diagnostic: string;
}

interface ArchivedRun {
  store: ToolArtifactStore;
  result: AttemptResult;
  manifest: RunManifest;
  repoRoot: string;
  lockKey: string;
  /**
   * The one decision snapshot this run was loaded from. Every consumer on the
   * decide path reads it instead of re-reading the archive: `loadArchivedRun`,
   * the provenance resolver, and the decision write used to perform three
   * independent five-file reads of the same immutable archive.
   */
  snapshot: RunDecisionSnapshot;
}

function services(deps: ToolDependencies): PlatformServices {
  return deps.ps ?? getPlatformServices();
}

/**
 * Delegating against this repository runs the published server bundle, not the
 * checkout under edit, so a committed fix can look like it did nothing. Advisory
 * only — a staleness probe must never fail a delegation.
 */
async function warnOnStaleLiveBundle(
  checkoutPath: string,
  deps: ToolDependencies,
): Promise<void> {
  try {
    const diagnostic = liveBundleDiagnostic(
      await (deps.checkLiveBundle ?? checkLiveBundle)(checkoutPath),
    );
    if (diagnostic === null) return;
    logger.warn(diagnostic);
    deps.onProgress?.(diagnostic);
  } catch {
    // An unreadable manifest or bundle is not a delegation failure.
  }
}

/**
 * Spec-authoring feedback, not a gate: name the tracked files that consume the
 * write allowlist but sit outside it, so a contract change does not surface as
 * hand-fixing at integration time.
 */
async function warnOnAllowlistConsumers(
  checkoutPath: string,
  spec: DelegationSpec,
  deps: ToolDependencies,
): Promise<void> {
  try {
    const diagnostic = allowlistSufficiencyDiagnostic(
      await (deps.checkAllowlistSufficiency ?? checkAllowlistSufficiency)(checkoutPath, spec),
    );
    if (diagnostic === null) return;
    logger.warn(diagnostic);
    deps.onProgress?.(diagnostic);
  } catch {
    // Advisory analysis must never fail a delegation.
  }
}

function storeFor(runId: string, deps: ToolDependencies): ToolArtifactStore {
  return (deps.storeFactory ?? (id => new ArtifactStore(id)))(runId);
}

function runtimeError(message: string, error: string): RuntimeError {
  return new RuntimeError(message, { toolError: error });
}

function errorResult(error: unknown): ToolErrorResult {
  const classified = error instanceof AggregateError && error.errors.length > 0
    ? error.errors[0]
    : error;
  const code = classified instanceof RuntimeError && typeof classified.detail?.toolError === "string"
    ? classified.detail.toolError
    : "runtime-error";
  const diagnostic = error instanceof Error ? error.message : String(error);
  return { ok: false, error: code, diagnostic: redact(diagnostic) };
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw runtimeError("autopilot request was cancelled", "cancelled");
}

function createAutopilotController(deps: ToolDependencies): Pick<
  AutopilotController,
  "start" | "status" | "resume"
> {
  const context = {
    ...(deps.onProgress === undefined ? {} : { onProgress: deps.onProgress }),
    ...(deps.abortSignal === undefined ? {} : { abortSignal: deps.abortSignal }),
  };
  if (deps.autopilotControllerFactory !== undefined) {
    return deps.autopilotControllerFactory(context);
  }

  const ps = services(deps);
  const branchManager = new WorkflowBranchManager({ platformServices: ps });
  const workflowStore = (workflowId: string) => new WorkflowStore(workflowId);
  const configured = deps.attemptDependencies ?? { verifier: new AcceptanceVerifier() };
  const attemptDependencies: AttemptRuntimeDependencies = {
    ...configured,
    ps,
    verifier: configured.verifier ?? new AcceptanceVerifier(),
    ...(deps.abortSignal === undefined ? {} : { abortSignal: deps.abortSignal }),
    ...(deps.onProgress === undefined ? {} : { onPhase: deps.onProgress }),
  };
  const pipelineDependencies: PipelineDependencies = {
    ...attemptDependencies,
    registry,
    ...(deps.runAttempt === undefined ? {} : { runAttempt: deps.runAttempt }),
  };

  return new AutopilotController({
    workflowLock: {
      runExclusive: (workflowId, operation) => withRepoLock(`autopilot:${workflowId}`, operation),
    },
    workflowStore,
    repositoryIdentity: async checkoutPath => {
      const canonical = await ps.canonicalizePath(checkoutPath);
      return canonical.gitCommonDir ?? canonical.canonical;
    },
    branchManager,
    pipelineRunner: {
      run: (checkoutPath, spec) => (deps.runPipeline ?? executePipeline)(
        checkoutPath,
        spec,
        pipelineDependencies,
      ),
    },
    reviewSnapshotter: {
      async create({ branch, pipelineResult }) {
        const store = new ArtifactStore(pipelineResult.runId);
        const snapshot = await createReviewSnapshot({
          runId: pipelineResult.runId,
          repoRoot: branch.worktreePath,
          repositoryIdentity: branch.repositoryIdentity,
          store,
          platformServices: ps,
          git: deps.git ?? runGit,
        });
        await store.writeReviewSnapshot(snapshot);
        return snapshot;
      },
    },
    eligibilityEvaluator: {
      async evaluate({ branch, task, pipelineResult, reviewSnapshot }) {
        const result = await runAdvisorStage({
          runId: pipelineResult.runId,
          spec: task.delegation,
          worktreePath: branch.worktreePath,
          deps: pipelineDependencies,
          evaluatedAt: (deps.now ?? (() => new Date()))().toISOString(),
          pipelineResult,
          reviewSnapshot,
        });
        return result.eligibility;
      },
    },
    promoter: new CandidatePromoter({
      platformServices: ps,
      branchManager,
      workflowStore,
    }),
    finalBranchReviewer: new FinalBranchReviewer({
      platformServices: ps,
      branchManager,
      workflowStore,
    }),
    ...(deps.abortSignal === undefined ? {} : { abortSignal: deps.abortSignal }),
    emit: (event: AutopilotControllerEvent) => deps.onProgress?.(event),
  });
}

function autopilotErrorResult(error: unknown): ToolErrorResult {
  const classification = error instanceof AutopilotControllerError
    ? error.classification
    : error instanceof RuntimeError && typeof error.detail?.classification === "string"
      ? error.detail.classification
      : undefined;
  if (classification === undefined) return errorResult(error);
  const diagnostic = error instanceof Error ? error.message : String(error);
  return { ok: false, error: classification, diagnostic: redact(diagnostic) };
}

export async function handleAutopilotStart(
  checkoutPath: string,
  input: unknown,
  deps: ToolDependencies = {},
): Promise<
  | { ok: true; result: AutopilotStatusResult }
  | { ok: false; error: "invalid-spec"; validationErrors: Array<{ path: string; message: string }> }
  | ToolErrorResult
> {
  const validation = validateAutopilotSpec(input);
  if (!validation.ok) {
    return { ok: false, error: "invalid-spec", validationErrors: validation.errors };
  }
  try {
    throwIfAborted(deps.abortSignal);
    const controller = createAutopilotController(deps);
    const started = await controller.start(checkoutPath, validation.spec);
    throwIfAborted(deps.abortSignal);
    return {
      ok: true,
      result: await controller.status(checkoutPath, started.workflowId),
    };
  } catch (error) {
    return autopilotErrorResult(error);
  }
}

export async function handleAutopilotStatus(
  checkoutPath: string,
  workflowId: string,
  deps: ToolDependencies = {},
): Promise<{ ok: true; result: AutopilotStatusResult } | ToolErrorResult> {
  try {
    throwIfAborted(deps.abortSignal);
    return {
      ok: true,
      result: await createAutopilotController(deps).status(checkoutPath, workflowId),
    };
  } catch (error) {
    return autopilotErrorResult(error);
  }
}

export async function handleAutopilotResume(
  checkoutPath: string,
  workflowId: string,
  deps: ToolDependencies = {},
): Promise<{ ok: true; result: AutopilotStatusResult } | ToolErrorResult> {
  try {
    throwIfAborted(deps.abortSignal);
    const controller = createAutopilotController(deps);
    await controller.resume(checkoutPath, workflowId);
    throwIfAborted(deps.abortSignal);
    return {
      ok: true,
      result: await controller.status(checkoutPath, workflowId),
    };
  } catch (error) {
    return autopilotErrorResult(error);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function loadArchivedRun(runId: string, deps: ToolDependencies): Promise<ArchivedRun> {
  const store = storeFor(runId, deps);
  const snapshot = await readRunDecisionSnapshot(runId, { store });
  const result = snapshot.result;
  const manifest = snapshot.manifest;
  if (result === null || manifest === null) {
    throw runtimeError("archived run was not found", "run-not-found");
  }
  if (snapshot.coherenceErrors.length > 0) {
    throw runtimeError(snapshot.coherenceErrors[0]!, "archive-inconsistent");
  }
  const canonical = await services(deps).canonicalizePath(manifest.repoRoot);
  if (canonical.canonical !== manifest.repoRoot) {
    throw runtimeError("archived repository root changed identity", "archive-inconsistent");
  }
  return {
    store,
    result,
    manifest,
    repoRoot: canonical.canonical,
    lockKey: canonical.gitCommonDir ?? canonical.canonical,
    snapshot,
  };
}

function requireCandidate(run: ArchivedRun): CandidateArtifact {
  if (run.result.candidate === null) {
    throw runtimeError("archived run has no candidate", "candidate-not-found");
  }
  return run.result.candidate;
}

function requireVerifiedCandidate(run: ArchivedRun): CandidateArtifact {
  if (run.result.status !== "verified-candidate" || run.result.failure !== null) {
    throw runtimeError(
      "candidate did not complete independent verification",
      "candidate-not-verified",
    );
  }
  return requireCandidate(run);
}

function requireMatchingRepository(
  run: ArchivedRun,
  callerKey: string,
): void {
  if (callerKey !== run.lockKey) {
    throw runtimeError(
      "candidate run belongs to a different repository than the supplied checkoutPath",
      "run-checkout-mismatch",
    );
  }
}

async function withCurrentArchivedRun<T>(
  checkoutPath: string,
  runId: string,
  deps: ToolDependencies,
  fn: (run: ArchivedRun, lock: CheckoutLock, ps: PlatformServices) => Promise<T>,
  preserveResultOnReleaseFailure?: (result: T) => T,
): Promise<T> {
  const ps = services(deps);
  const safety = new PlatformSafety(ps);
  const canonical = await ps.canonicalizePath(checkoutPath);
  const callerKey = canonical.gitCommonDir ?? canonical.canonical;
  return withRepoLock(callerKey, async () => {
    let actionResult: { ok: true; result: T } | null = null;
    try {
      return await safety.withCheckoutLease(canonical.canonical, async (lock) => {
        if (lock.repositoryIdentity !== callerKey) {
          throw runtimeError(
            "supplied checkout repository identity changed before checkout lease acquisition",
            "run-checkout-mismatch",
          );
        }
        const run = await loadArchivedRun(runId, deps);
        requireMatchingRepository(run, lock.repositoryIdentity);
        const result = await fn(run, lock, ps);
        actionResult = { ok: true, result };
        return result;
      }, { runId });
    } catch (error) {
      if (actionResult !== null && preserveResultOnReleaseFailure !== undefined) {
        return preserveResultOnReleaseFailure((actionResult as { ok: true; result: T }).result);
      }
      throw error;
    }
  });
}


async function requireInactivePipeline(run: ArchivedRun, runId: string): Promise<void> {
  if (await run.store.readPipelineActiveMarker() !== null) {
    throw runtimeError(
      "the delegation pipeline for this run is still active",
      "pipeline-active",
    );
  }
}

/**
 * Reject producer ids that name no shipped adapter.
 *
 * The schema types `producerPreferences` as plain strings, so an agent name such
 * as `codex-implementer` used to validate cleanly and only fail at routing time
 * as `unavailable / no-eligible-producer` — a diagnostic that reads as "Codex is
 * not installed" rather than "that is not a producer id". It also bypassed the
 * documented spec-repair loop, which exists precisely so a malformed spec is
 * corrected without ever touching a Producer. The registry is the single source
 * of truth for the id set; do not restate it as a literal here.
 */
function unknownProducerErrors(
  preferences: readonly string[],
): Array<{ path: string; message: string }> {
  const known = registry.all().map(adapter => adapter.producerId);
  return preferences.flatMap((producerId, index) =>
    known.includes(producerId)
      ? []
      : [{
        path: `#/producerPreferences/${index}`,
        message: `unknown producer id ${JSON.stringify(producerId)}; expected one of ${
          known.map(id => JSON.stringify(id)).join(", ")}`,
      }]);
}

function schemaCompatibility(input: unknown): { ok: true } | { ok: false; diagnostic: string } {
  if (isRecord(input)
    && input.specVersion !== undefined
    && input.specVersion !== DELEGATION_SPEC_VERSION) {
    return {
      ok: false,
      diagnostic: "delegation spec version mismatch: request declares "
        + `${String(input.specVersion)}, runtime expects ${DELEGATION_SPEC_VERSION}`,
    };
  }
  return { ok: true };
}

type SpecValidationFailure =
  | {
    ok: false;
    error: "invalid-specification";
    validationErrors: Array<{ path: string; message: string }>;
  }
  | { ok: false; diagnostic: string };

function validateDelegationSpecInput(
  input: unknown,
  deps: ToolDependencies,
): { ok: true; spec: DelegationSpec; specSha256: string } | SpecValidationFailure {
  const protocol = checkVersionCompat(deps.skillProtocolVersion ?? PROTOCOL_VERSION);
  if (!protocol.ok) return { ok: false, diagnostic: protocol.diagnostic! };
  // Schemaless MCP clients (spec is z.unknown → empty JSON schema) may serialize the
  // nested spec object as a JSON string; accept that encoding before validation.
  if (typeof input === "string") {
    try {
      input = JSON.parse(input) as unknown;
    } catch {
      return {
        ok: false,
        error: "invalid-specification",
        validationErrors: [{ path: "#", message: "string spec is not valid JSON" }],
      };
    }
  }
  const schema = schemaCompatibility(input);
  if (!schema.ok) return schema;
  const validation = validateSpec(input);
  if (!validation.ok) {
    return {
      ok: false,
      error: "invalid-specification",
      validationErrors: validation.errors,
    };
  }
  const producerErrors = unknownProducerErrors(validation.spec.producerPreferences);
  if (producerErrors.length > 0) {
    return { ok: false, error: "invalid-specification", validationErrors: producerErrors };
  }
  return {
    ok: true,
    spec: validation.spec,
    specSha256: specSha256(validation.spec),
  };
}

/**
 * Validate and identify a spec without touching a checkout or starting a
 * Producer. The digest comes from the runtime's canonical wire algorithm, so a
 * host does not have to reimplement that contract before dispatching a lane.
 */
export async function handleValidateDelegationSpec(
  input: unknown,
  deps: ToolDependencies = {},
): Promise<{ ok: true; specSha256: string } | SpecValidationFailure> {
  const validation = validateDelegationSpecInput(input, deps);
  if (!validation.ok) return validation;
  return { ok: true, specSha256: validation.specSha256 };
}

function requireExpectedSpecIdentity(
  actualSpecSha256: string,
  expectedSpecSha256: string | undefined,
): ToolErrorResult | null {
  if (expectedSpecSha256 === undefined) return null;
  if (!/^[0-9a-f]{64}$/u.test(expectedSpecSha256)) {
    return {
      ok: false,
      error: "spec-identity-unverifiable",
      diagnostic: "expectedSpecSha256 is not a sha-256 digest",
    };
  }
  if (actualSpecSha256 !== expectedSpecSha256) {
    return {
      ok: false,
      error: "spec-identity-mismatch",
      diagnostic: "the validated Delegation Spec does not match expectedSpecSha256",
    };
  }
  return null;
}


/**
 * The bounded envelope a delegation lane actually reports.
 *
 * A lane is a courier: its contract is correlation fields, and it is granted no
 * filesystem tools by design. A full result can exceed the host's inline-response
 * limit, at which point the host offloads it to a file the lane cannot open — so
 * the lane produced no report and its controller re-dispatched, duplicating the
 * entire attempt. Returning only what the lane reports removes the offload
 * without widening the lane's trust surface. Full evidence stays archived and
 * reaches the architect through `reviewCandidate`.
 */
export interface LaneEnvelope {
  runId: string;
  status: AttemptResult["status"];
  producerId: string | null;
  manifestHash: string | null;
  failure: AttemptResult["failure"];
  durationMs: number;
}

function laneEnvelope(result: AttemptResult): LaneEnvelope {
  return {
    runId: result.runId,
    status: result.status,
    producerId: result.producerId,
    manifestHash: result.candidate?.manifestHash ?? null,
    failure: result.failure,
    durationMs: result.durationMs,
  };
}

export async function handleDelegate(
  checkoutPath: string,
  input: unknown,
  deps: ToolDependencies = {},
  responseMode: "full" | "lane" = "full",
  expectedSpecSha256?: string,
): Promise<
  | { ok: true; result: AttemptResult | LaneEnvelope }
  | {
    ok: false;
    error: "invalid-specification";
    validationErrors: Array<{ path: string; message: string }>;
  }
  | { ok: false; diagnostic: string }
  | { ok: false; error: "nested-delegation-denied" }
  | ToolErrorResult
> {
  const validation = validateDelegationSpecInput(input, deps);
  if (!validation.ok) return validation;
  const identityError = requireExpectedSpecIdentity(
    validation.specSha256,
    expectedSpecSha256,
  );
  if (identityError !== null) return identityError;

  try {
    const ps = services(deps);
    const canonical = await ps.canonicalizePath(checkoutPath);
    await warnOnStaleLiveBundle(canonical.canonical, deps);
    await warnOnAllowlistConsumers(canonical.canonical, validation.spec, deps);
    const key = canonical.gitCommonDir ?? canonical.canonical;
    return await withRepoLock(key, async () => {
      const configured = deps.attemptDependencies ?? { verifier: new AcceptanceVerifier() };
      const attemptDependencies: AttemptRuntimeDependencies = {
        ...configured,
        ps,
        verifier: configured.verifier ?? new AcceptanceVerifier(),
        ...(deps.onProgress === undefined ? {} : { onPhase: deps.onProgress }),
        ...(deps.abortSignal === undefined ? {} : { abortSignal: deps.abortSignal }),
      };
      const result = await (deps.runAttempt ?? executeAttempt)(
        canonical.canonical,
        validation.spec,
        attemptDependencies,
      );
      return {
        ok: true,
        result: responseMode === "lane" ? laneEnvelope(result) : boundIgnoredPathEvidence(result),
      };
    });
  } catch (error) {
    if (error instanceof NestedDelegationError) {
      return { ok: false, error: "nested-delegation-denied" };
    }
    return errorResult(error);
  }
}

export async function handleDelegatePipeline(
  checkoutPath: string,
  input: unknown,
  deps: ToolDependencies = {},
  responseMode: "full" | "lane" = "full",
  expectedSpecSha256?: string,
): Promise<
  | { ok: true; result: PipelineResult | LaneEnvelope }
  | {
    ok: false;
    error: "invalid-specification";
    validationErrors: Array<{ path: string; message: string }>;
  }
  | { ok: false; diagnostic: string }
  | { ok: false; error: "nested-delegation-denied" }
  | ToolErrorResult
> {
  const validation = validateDelegationSpecInput(input, deps);
  if (!validation.ok) return validation;
  const identityError = requireExpectedSpecIdentity(
    validation.specSha256,
    expectedSpecSha256,
  );
  if (identityError !== null) return identityError;

  try {
    const ps = services(deps);
    const canonical = await ps.canonicalizePath(checkoutPath);
    await warnOnStaleLiveBundle(canonical.canonical, deps);
    await warnOnAllowlistConsumers(canonical.canonical, validation.spec, deps);
    const key = canonical.gitCommonDir ?? canonical.canonical;
    return await withRepoLock(key, async () => {
      const configured = deps.attemptDependencies ?? { verifier: new AcceptanceVerifier() };
      const attemptDependencies: AttemptRuntimeDependencies = {
        ...configured,
        ps,
        verifier: configured.verifier ?? new AcceptanceVerifier(),
        ...(deps.onProgress === undefined ? {} : { onPhase: deps.onProgress }),
        ...(deps.abortSignal === undefined ? {} : { abortSignal: deps.abortSignal }),
      };
      const pipelineDependencies: PipelineDependencies = {
        ...attemptDependencies,
        registry,
        ...(deps.runAttempt === undefined ? {} : { runAttempt: deps.runAttempt }),
      };
      const pipelineResult = await (deps.runPipeline ?? executePipeline)(
        canonical.canonical,
        validation.spec,
        pipelineDependencies,
      );
      // The bound reads `value.evidence`; a pipeline's lives one level deeper,
      // so this path returned a repository-sized ignored-path list untouched.
      if (responseMode === "lane") {
        return { ok: true, result: laneEnvelope(pipelineResult.attempt) };
      }
      return {
        ok: true,
        result: { ...pipelineResult, attempt: boundIgnoredPathEvidence(pipelineResult.attempt) },
      };
    });
  } catch (error) {
    if (error instanceof NestedDelegationError) {
      return { ok: false, error: "nested-delegation-denied" };
    }
    return errorResult(error);
  }
}

/**
 * Prove a reported run id belongs to the spec the caller dispatched.
 *
 * A delegation lane reports its own `runId` and echoes back the `specSha256` it
 * was handed, so both are claims by the party whose work is under review. A lane
 * naming a nonexistent run already fails here; the dangerous case is one naming
 * a *different real* run — an earlier green attempt — which returns a clean
 * candidate for work nobody asked for. `specSha256` was persisted at run start
 * for exactly this comparison, and until now nothing performed it.
 *
 * Fails closed: a caller that asked for verification and cannot get it is told
 * so, never told "verified" by omission.
 */
async function requireSpecCorrespondence(
  run: ArchivedRun,
  runId: string,
  expectedSpecSha256: string | undefined,
): Promise<void> {
  if (expectedSpecSha256 === undefined) return;
  if (!/^[0-9a-f]{64}$/u.test(expectedSpecSha256)) {
    throw runtimeError("expectedSpecSha256 is not a sha-256 digest", "run-spec-unverifiable");
  }
  const recorded = await run.store.readRunStartSpecSha256();
  if (recorded === null) {
    throw runtimeError(
      "this run recorded no spec hash, so it cannot be matched to the dispatched spec",
      "run-spec-unverifiable",
    );
  }
  if (recorded !== expectedSpecSha256) {
    throw runtimeError(
      "this run was started from a different spec than the one supplied",
      "run-spec-mismatch",
    );
  }
}

function requireMatchingSnapshotBytes(
  regenerated: ReviewSnapshot,
  persisted: ReviewSnapshot,
): void {
  // Deliberately byte-strict, not hash-equal: the persisted snapshot must be
  // the exact bytes this runtime wrote, so a key-order difference means
  // something rewrote the archive even though the canonical hash still matches.
  // `reviewSnapshotHash(persisted)` is called for its validation side effect.
  reviewSnapshotHash(persisted);
  if (JSON.stringify(persisted) !== JSON.stringify(regenerated)) {
    throw runtimeError(
      "persisted review snapshot does not match the regenerated snapshot",
      "archive-inconsistent",
    );
  }
}

async function sharedReviewSnapshot(
  run: ArchivedRun,
  deps: ToolDependencies,
  allowMissingAnchor = false,
): Promise<ReviewSnapshot> {
  const regenerated = await createReviewSnapshot({
    runId: run.result.runId,
    repoRoot: run.repoRoot,
    repositoryIdentity: run.lockKey,
    store: run.store,
    platformServices: services(deps),
    git: deps.git ?? runGit,
    allowMissingAnchor,
  });
  const persisted = await run.store.readReviewSnapshot();
  if (persisted !== null) {
    requireMatchingSnapshotBytes(regenerated, persisted);
    return persisted;
  }

  await run.store.writeReviewSnapshot(regenerated);
  const newlyPersisted = await run.store.readReviewSnapshot();
  if (newlyPersisted === null) {
    // The snapshot is what a decision's evidenceHash binds to. If it did not
    // survive the write, fail closed rather than hashing bytes that only ever
    // existed in memory.
    throw runtimeError(
      "review snapshot could not be persisted",
      "archive-inconsistent",
    );
  }
  requireMatchingSnapshotBytes(regenerated, newlyPersisted);
  return newlyPersisted;
}

/**
 * Map how the runtime obtained a decision onto the authority recorded with it.
 *
 * The caller never supplies this. An absent provenance means no layer claimed to
 * have confirmed a human, which is exactly `caller-asserted` — the value that
 * fails the integration gate — so the default is the safe one.
 */
function decisionAuthorityFor(
  provenance: DecisionProvenance | undefined,
): CandidateDecisionV2["authority"] {
  switch (provenance) {
    case "human-elicitation": return "human";
    case "policy-autonomous": return "policy-autonomous";
    default: return "caller-asserted";
  }
}

/**
 * Compare an archived decision with one being attempted, authority included.
 *
 * Authority is part of identity, not metadata: re-recording the same verdict
 * under a different authority is a different claim about who decided, and
 * silently treating it as idempotent would let a caller-asserted decision
 * inherit a human one's standing.
 */
function isIdenticalDecision(
  existing: CandidateDecision,
  attempted: CandidateDecisionV2,
): boolean {
  return existing.decisionVersion === "2"
    && existing.authority === attempted.authority
    && existing.decision === attempted.decision
    && existing.candidateManifestHash === attempted.candidateManifestHash
    && existing.evidenceHash === attempted.evidenceHash
    && existing.policyVersion === attempted.policyVersion;
}

async function deleteRejectedCandidateAnchor(
  run: ArchivedRun,
  candidate: CandidateArtifact,
  deps: ToolDependencies,
  allowAlreadyAbsent = false,
): Promise<void> {
  const git = deps.git ?? runGit;
  if (allowAlreadyAbsent) {
    const current = await git(run.repoRoot, [
      "show-ref",
      "--verify",
      "--hash",
      candidate.anchorRef,
    ]);
    if (current.exitCode === 1 && current.stdout.trim().length === 0) return;
    if (current.exitCode !== 0 || current.stdout.trim() !== candidate.candidateCommitOid) {
      throw runtimeError("rejected candidate anchor changed identity", "anchor-delete-failed");
    }
  }
  const deleted = await git(run.repoRoot, [
    "update-ref",
    "--no-deref",
    "-d",
    candidate.anchorRef,
    candidate.candidateCommitOid,
  ]);
  if (deleted.exitCode !== 0) {
    throw runtimeError("failed to delete rejected candidate anchor", "anchor-delete-failed");
  }
}

export async function handleReviewCandidate(
  checkoutPath: string,
  runId: string,
  deps: ToolDependencies = {},
  expectedSpecSha256?: string,
): Promise<ReviewSnapshot | ToolErrorResult> {
  try {
    return await withCurrentArchivedRun(checkoutPath, runId, deps, async run => {
      await requireInactivePipeline(run, runId);
      await requireSpecCorrespondence(run, runId, expectedSpecSha256);
      return sharedReviewSnapshot(run, deps);
    });
  } catch (error) {
    return errorResult(error);
  }
}

/**
 * Reads the pipeline gate's verdict for a run so the human confirming a
 * decision sees it. Advisory and read-only; the authoritative checks run under
 * the repository lock in `handleDecideCandidate`.
 *
 * A read failure is reported, never swallowed. Returning "no warnings" because
 * the archive could not be read would present an unknown candidate as a clean
 * one at exactly the moment that matters.
 */
export interface DecisionAdvisory {
  /** Why a person must decide; empty when the runtime proved everything it can. */
  warnings: string[];
  /** `verdictFor` would accept this candidate under the autonomous authority. */
  verifiedClean: boolean;
  /**
   * The archive could not be read, so nothing about this candidate is known.
   * Distinct from "verified false" — an unreadable archive refuses rather than
   * presenting an unknown candidate as a clean one.
   */
  unreadable: boolean;
}

/** The advisory is the acceptance rule's own verdict; there is no second rule. */
function decisionAdvisoryForRun(run: ArchivedRun): DecisionAdvisory {
  const verdict = runDecision.verdictFor(run.snapshot, "autonomous");
  return verdict.state === "accepted"
    ? { warnings: [], verifiedClean: true, unreadable: false }
    : { warnings: verdict.reasons, verifiedClean: false, unreadable: false };
}

export async function readDecisionAdvisory(
  runId: string,
  deps: ToolDependencies = {},
): Promise<DecisionAdvisory> {
  let run: ArchivedRun;
  try { run = await loadArchivedRun(runId, deps); }
  catch (error) {
    return {
      warnings: [`the pipeline gate outcome for this run could not be read: ${
        redact(error instanceof Error ? error.message : String(error))}`],
      verifiedClean: false,
      unreadable: true,
    };
  }
  return decisionAdvisoryForRun(run);
}

export async function handleDecideCandidate(
  checkoutPath: string,
  runId: string,
  decision: RunDecisionValue,
  expectedArtifactHash: string,
  deps: ToolDependencies = {},
): Promise<{ recorded: true } | ToolErrorResult> {
  try {
    return await withCurrentArchivedRun(checkoutPath, runId, deps, async run => {
      await requireInactivePipeline(run, runId);
      const decisionProvenance = deps.decisionProvenanceResolver === undefined
        ? deps.decisionProvenance
        : await deps.decisionProvenanceResolver({
          runId,
          decision,
          advisory: decisionAdvisoryForRun(run),
          snapshot: run.snapshot,
        });
      const candidate = decision === "accepted"
        ? requireVerifiedCandidate(run)
        : requireCandidate(run);
      if (expectedArtifactHash !== run.manifest.candidateManifestHash) {
        throw runtimeError(
          "expected artifact hash does not match archived candidate manifest hash",
          "artifact-hash-mismatch",
        );
      }
      // The authority is derived from how the runtime obtained the decision, not
      // supplied by the caller. `caller-asserted` is still recorded rather than
      // refused: the decision happened and the archive should say so, and
      // INTEGRABLE_DECISION_AUTHORITIES is what keeps it from being spent.
      const authority = decisionAuthorityFor(decisionProvenance);
      // Only the policy authorities are accept-only: a policy that could reject
      // or request revision on its own could bury work nobody reviewed. A
      // caller-asserted decision may carry any value — a caller can reject, and
      // refusing to record that would lose the rejection entirely.
      if (authority === "policy-autonomous" && decision !== "accepted") {
        throw runtimeError(
          `a ${authority} authority may only accept, never ${decision}`,
          "decision-authority-refused",
        );
      }
      const existing = run.snapshot.decision;
      const reviewSnapshot = await sharedReviewSnapshot(
        run,
        deps,
        existing !== null && decision === "rejected",
      );
      const record = {
        decisionVersion: "2",
        authority,
        decision,
        candidateManifestHash: candidate.manifestHash,
        evidenceHash: reviewSnapshotHash(reviewSnapshot),
        policyVersion: "1",
        recordedAt: (deps.now ?? (() => new Date()))().toISOString(),
      } as CandidateDecisionV2;
      if (existing !== null) {
        if (!isIdenticalDecision(existing, record)) {
          throw runtimeError(
            `candidate decision conflict: recorded ${existing.decision}, attempted ${decision}`,
            "decision-conflict",
          );
        }
        if (decision === "rejected") {
          await deleteRejectedCandidateAnchor(run, candidate, deps, true);
        }
        return { recorded: true };
      }
      await run.store.writeCandidateDecisionRecord(record);
      if (decision === "rejected") {
        await deleteRejectedCandidateAnchor(run, candidate, deps);
      }
      return { recorded: true };
    });
  } catch (error) {
    return errorResult(error);
  }
}

export async function handleIntegrateCandidate(
  checkoutPath: string,
  runId: string,
  expectedArtifactHash: string,
  deps: ToolDependencies = {},
): Promise<{ integration: "applied" | "conflicted" | "aborted"; detail: string } | ToolErrorResult> {
  try {
    return await withCurrentArchivedRun(checkoutPath, runId, deps, async (run, lock, ps) => {
      await requireInactivePipeline(run, runId);
      const decision = await run.store.readCandidateDecision();
      if (decision?.decision !== "accepted") {
        return { integration: "aborted", detail: "no-accepted-decision" };
      }
      const artifact = requireVerifiedCandidate(run);
      // Provenance is recorded, not required to be human here. Under the
      // autonomous decision authority a verified, unwarned candidate is accepted
      // as `policy-autonomous`; demanding a human at integration would make that
      // acceptance unspendable and reintroduce the prompt the authority exists
      // to remove. `caller-asserted` and `unknown` are still refused: they mean
      // the runtime does not know how the decision was reached, which is a
      // different thing from knowing it was policy.
      //
      // This reads the shared list rather than naming authorities inline, so a
      // future authority cannot be added to the union and silently left
      // unspendable — the failure mode this gate has already produced once.
      if (!(INTEGRABLE_DECISION_AUTHORITIES as readonly string[]).includes(decision.authority)) {
        return { integration: "aborted", detail: "accepted-decision-not-confirmed" };
      }
      // An acceptance is a judgement about one specific candidate, so it is
      // spent only on the artifact it names. A legacy record that names none
      // says nothing about which bytes were accepted and is refused too.
      if (decision.candidateManifestHash !== expectedArtifactHash) {
        return { integration: "aborted", detail: "decision-artifact-mismatch" };
      }
      return (deps.applyCandidateTree ?? applyTree)({
        repoRoot: run.repoRoot,
        artifact,
        expectedArtifactHash,
        borrowedCheckoutLock: lock,
        platformServices: ps,
      });
    }, result => ({
      ...result,
      detail: `${result.detail}; checkout lock release failed`,
    }));
  } catch (error) {
    return errorResult(error);
  }
}
