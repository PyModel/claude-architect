import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, open, readFile, rm } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import {
  computeChangedPathManifest,
  parseRawDiff,
} from "../git/changed-path-manifest.js";
import { git, type GitResult } from "../git/git-exec.js";
import { syncDirectoryMetadata } from "../platform/durable-directory.js";
import { globMatches } from "../util/glob.js";
import { WorktreeManager } from "../runtime/worktree-manager.js";
import { PlatformSafety } from "../platform/platform-safety.js";
import { assertNoPendingWorktreeRemovalForRepository } from "../runtime/worktree-removal-manifest.js";
import type { CheckoutLock, PlatformServices } from "../platform/platform-services.js";
import { getPlatformServices } from "../platform/select-platform.js";
import type { AcceptanceVerifyResult } from "../verify/acceptance-verifier.js";
import { AcceptanceVerifier } from "../verify/acceptance-verifier.js";
import {
  recomputeManifest,
  type StructuralFailure,
  type StructuralVerifyArgs,
  type StructuralVerifyResult,
} from "../verify/structural-verifier.js";
import type { CandidateArtifact, ChangedPath } from "../protocol/attempt-result.js";
import type { AutopilotSpec } from "../protocol/autopilot-spec.js";
import type { DelegationSpec } from "../protocol/delegation-spec.js";
import { loadSchemas } from "../protocol/schema-loader.js";
import {
  registry as defaultRegistry,
  type ProducerRegistry,
} from "../producers/producer-registry.js";
import { ArtifactStore } from "../runtime/artifact-store.js";
import { redact, redactRecord } from "../runtime/redaction.js";
import type { AdvisorReport, ReviewReport } from "../pipeline/report-types.js";
import type { PipelineResult } from "../pipeline/pipeline-runtime.js";
import type { RolePackage } from "../pipeline/role-prompts.js";
import {
  runRole,
  type RoleRunArgs,
  type RoleRunResult,
} from "../pipeline/role-runner.js";
import { extractJson } from "../pipeline/structured-output.js";
import { RuntimeError } from "../util/errors.js";
import {
  autopilotEligibilityRecordHash,
  canonicalArtifactHash,
} from "./autopilot-eligibility.js";
import {
  WorkflowBranchManager,
  type WorkflowBranchIdentity,
} from "./branch-manager.js";
import type { AutopilotTaskState, AutopilotWorkflowState } from "./types.js";
import { WorkflowStore } from "./workflow-store.js";

const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const NO_FOLLOW = constants.O_NOFOLLOW ?? 0;
const MAX_FINAL_BRANCH_ARTIFACT_BYTES = 64 * 1024 * 1024;
const MAX_TASK_EVIDENCE_REFS = 4_096;
// The reference COUNT was bounded but the total bytes were not, and every frozen
// byte is held in memory, written into one artifact file, and then serialized
// into three model-backed role prompts. A run with large logs could exhaust
// memory and blow the Producer input budget, so bound the aggregate and fail
// closed rather than producing an artifact nothing can consume.
const MAX_TASK_EVIDENCE_BYTES = 8 * 1024 * 1024;
const REQUIRED_TASK_EVIDENCE_REFS = [
  "decision.json",
  "manifest.json",
  "pipeline/pipeline-result.json",
  "pipeline/post-pipeline-autopilot.json",
  "result.json",
  "review-snapshot.json",
] as const;
export const FINAL_BRANCH_ARTIFACT_REF = "final-branch-artifact.json";
export const FINAL_BRANCH_REPORT_REF = "final-branch-report.json";
export const FINAL_VERIFICATION_REF = "final-verification.json";
export const FINAL_CORRECTNESS_REVIEW_REF = "final-review-correctness.json";
export const FINAL_SYSTEMS_REVIEW_REF = "final-review-systems.json";
export const FINAL_ADVISOR_REF = "final-advisor.json";

export interface FinalBranchReport {
  reportVersion: "1";
  workflowId: string;
  baseCommitOid: string;
  headCommitOid: string;
  branchArtifactHash: string;
  verificationHash: string;
  reviewHashes: string[];
  advisorHash: string;
  taskEvidenceHashes: string[];
  eligible: boolean;
  reasons: string[];
  status: "ready-to-ship" | "human-decision-required";
  evaluatedAt: string;
}

export interface FinalBranchTaskEvidence {
  taskId: string;
  runId: string;
  candidateManifestHash: string;
  promotionCommitOid: string;
  evidenceRefs: string[];
}

export interface FrozenTaskEvidenceArtifact {
  reference: string;
  sha256: string;
  content: string;
}

export interface FrozenFinalBranchTaskEvidence extends FinalBranchTaskEvidence {
  evidence: FrozenTaskEvidenceArtifact[];
}

export interface CumulativeBranchArtifact {
  artifactVersion: "1";
  workflowId: string;
  baseCommitOid: string;
  headCommitOid: string;
  headTreeOid: string;
  manifestHash: string;
  changedPaths: ChangedPath[];
  patch: string;
  taskEvidence: FrozenFinalBranchTaskEvidence[];
  branchArtifactHash: string;
}

export type FinalBranchReviewClassification =
  | "workflow-state-mismatch"
  | "missing-task-evidence"
  | "git-command-failed"
  | "head-changed"
  | "artifact-persistence-failed";

export class FinalBranchReviewError extends RuntimeError {
  constructor(
    readonly classification: FinalBranchReviewClassification,
    message: string = classification,
  ) {
    super(message, { classification });
    this.name = "FinalBranchReviewError";
  }
}

export interface FreezeCumulativeBranchArtifactRequest {
  workflowId: string;
  expectedRevision: number;
  taskEvidence: FinalBranchTaskEvidence[];
}

export interface HeadBoundPhaseRequest<T> {
  checkoutPath: string;
  expectedHead: string;
  expectedTree?: string;
  phase: string;
  execute: () => Promise<T>;
  git?: typeof git;
}

export interface FinalBranchReviewerDependencies {
  git?: typeof git;
  branchManager?: WorkflowBranchManager;
  workflowStore?: (workflowId: string) => WorkflowStore;
  acceptanceVerifier?: Pick<AcceptanceVerifier, "verify">;
  roleRunner?: (args: RoleRunArgs) => Promise<RoleRunResult>;
  platformServices?: PlatformServices;
  producerRegistry?: ProducerRegistry;
  artifactStore?: (workflowId: string) => Pick<ArtifactStore, "writeLog">;
  evidenceStore?: (
    runId: string,
  ) => Pick<ArtifactStore, "readEvidence" | "listEvidenceReferences">;
  taskEvidenceValidator?: (
    task: AutopilotTaskState,
    evidence: FinalBranchTaskEvidence,
    context: TaskEvidenceValidationContext,
  ) => Promise<void>;
  materialize?: (request: {
    checkoutPath: string;
    workflowId: string;
    headCommitOid: string;
    platformServices: PlatformServices;
    borrowedCheckoutLease: CheckoutLock;
  }) => Promise<{ path: string; cleanup(): Promise<void> }>;
  now?: () => string;
}

export interface RunFinalBranchReviewRequest {
  artifact: CumulativeBranchArtifact;
  autopilotSpec: AutopilotSpec;
  checkoutPath: string;
}

export interface FinalBranchReviewRequest extends FreezeCumulativeBranchArtifactRequest {
  autopilotSpec: AutopilotSpec;
  checkoutPath: string;
}

export interface TaskEvidenceValidationContext {
  checkoutPath: string;
  expectedParentCommitOid: string;
  git: typeof git;
}

type UnhashedCumulativeBranchArtifact = Omit<CumulativeBranchArtifact, "branchArtifactHash">;
type StructuredFinalRole = "reviewer-correctness" | "reviewer-systems" | "advisor";

const schemas = loadSchemas();

function succeeded(result: GitResult): boolean {
  return result.exitCode === 0
    && result.truncated?.stdout !== true
    && result.truncated?.stderr !== true;
}

function fail(
  classification: FinalBranchReviewClassification,
  message?: string,
): never {
  throw new FinalBranchReviewError(classification, message);
}

async function checkedGit(
  runGit: typeof git,
  cwd: string,
  args: string[],
): Promise<string> {
  const result = await runGit(cwd, args);
  if (!succeeded(result)) fail("git-command-failed", `git ${args[0] ?? "command"} failed`);
  return result.stdout;
}

function normalizedEvidenceRefs(
  references: string[],
  allowEmpty = false,
  maximum = 128,
): string[] {
  if (!Array.isArray(references) || references.length > maximum) {
    fail("missing-task-evidence", "task evidence references are invalid");
  }
  const unique = new Set<string>();
  for (const reference of references) {
    if (typeof reference !== "string"
      || reference.length < 1
      || reference.length > 1024
      || path.posix.isAbsolute(reference)
      || reference.includes("\\")
      || reference.split("/").some(component => component === "" || component === "." || component === "..")
      || /[\0\r\n]/u.test(reference)) {
      fail("missing-task-evidence", "task evidence reference is invalid");
    }
    unique.add(reference);
  }
  if (!allowEmpty && unique.size === 0) {
    fail("missing-task-evidence", "task evidence references are missing");
  }
  return [...unique].sort();
}

async function validateArchivedTaskEvidence(
  task: AutopilotTaskState,
  evidence: FinalBranchTaskEvidence,
  context: TaskEvidenceValidationContext,
): Promise<void> {
  const store = new ArtifactStore(evidence.runId);
  let result;
  let manifest;
  let pipelineResult;
  let snapshot;
  let advisor;
  let eligibility;
  let decision;
  try {
    [result, manifest, pipelineResult, snapshot, advisor, eligibility, decision] = await Promise.all([
      store.readResult(evidence.runId),
      store.readManifest(evidence.runId),
      store.readPipelineArtifact<PipelineResult>(evidence.runId, "pipeline-result"),
      store.readReviewSnapshot(evidence.runId),
      store.readAdvisorReport(evidence.runId),
      store.readAutopilotEligibility(evidence.runId),
      store.readCandidateDecision(evidence.runId),
    ]);
  } catch {
    fail("missing-task-evidence", `task evidence archive is invalid: ${task.id}`);
  }
  const candidate = result?.candidate ?? null;
  const [promotionParent, promotionTree] = await Promise.all([
    context.git(context.checkoutPath, [
      "rev-parse", "--verify", `${evidence.promotionCommitOid}^`,
    ]),
    context.git(context.checkoutPath, [
      "rev-parse", "--verify", `${evidence.promotionCommitOid}^{tree}`,
    ]),
  ]);
  if (result === null
    || manifest === null
    || pipelineResult === null
    || snapshot === null
    || advisor === null
    || eligibility === null
    || decision === null
    || candidate === null
    || result.status !== "verified-candidate"
    || result.runId !== evidence.runId
    || manifest.runId !== evidence.runId
    || manifest.baseCommitOid !== context.expectedParentCommitOid
    || pipelineResult.runId !== evidence.runId
    || candidate.baseCommitOid !== context.expectedParentCommitOid
    || candidate.manifestHash !== evidence.candidateManifestHash
    || manifest.candidateManifestHash !== evidence.candidateManifestHash
    || pipelineResult.finalCandidateCommit !== candidate.candidateCommitOid
    || eligibility.runId !== evidence.runId
    || eligibility.baseCommitOid !== context.expectedParentCommitOid
    || eligibility.candidateCommitOid !== candidate.candidateCommitOid
    || eligibility.candidateTreeOid !== candidate.candidateTreeOid
    || eligibility.candidateManifestHash !== evidence.candidateManifestHash
    || !eligibility.eligible
    || eligibility.reasons.length !== 0
    || task.eligibilityHash === null
    || autopilotEligibilityRecordHash(eligibility) !== task.eligibilityHash
    || decision.decisionVersion !== "2"
    || decision.authority !== "autopilot-policy"
    || decision.decision !== "accepted"
    || decision.candidateManifestHash !== evidence.candidateManifestHash
    || decision.evidenceHash !== task.eligibilityHash
    || !succeeded(promotionParent)
    || promotionParent.stdout.trim() !== context.expectedParentCommitOid
    || !succeeded(promotionTree)
    || promotionTree.stdout.trim() !== candidate.candidateTreeOid) {
    fail("missing-task-evidence", `task evidence identities do not match: ${task.id}`);
  }
}

function requirePromotedTask(task: AutopilotTaskState): {
  runId: string;
  candidateManifestHash: string;
  promotionCommitOid: string;
} {
  if (task.status !== "promoted"
    || task.runId === null
    || task.candidateManifestHash === null
    || !SHA256.test(task.candidateManifestHash)
    || task.promotionCommitOid === null
    || !OBJECT_ID.test(task.promotionCommitOid)) {
    fail("workflow-state-mismatch", `task ${task.id} is not durably promoted`);
  }
  return {
    runId: task.runId,
    candidateManifestHash: task.candidateManifestHash,
    promotionCommitOid: task.promotionCommitOid,
  };
}

function normalizeTaskEvidence(
  state: AutopilotWorkflowState,
  supplied: FinalBranchTaskEvidence[],
): FinalBranchTaskEvidence[] {
  if (!Array.isArray(supplied) || supplied.length !== state.tasks.length) {
    fail("missing-task-evidence", "cumulative task evidence is incomplete");
  }
  const suppliedById = new Map<string, FinalBranchTaskEvidence>();
  for (const evidence of supplied) {
    if (suppliedById.has(evidence.taskId)) {
      fail("missing-task-evidence", "cumulative task evidence contains duplicate tasks");
    }
    suppliedById.set(evidence.taskId, evidence);
  }
  return state.tasks.map(task => {
    const identity = requirePromotedTask(task);
    const evidence = suppliedById.get(task.id);
    if (evidence === undefined
      || evidence.runId !== identity.runId
      || evidence.candidateManifestHash !== identity.candidateManifestHash
      || evidence.promotionCommitOid !== identity.promotionCommitOid) {
      fail("missing-task-evidence", `task evidence does not match ${task.id}`);
    }
    return {
      taskId: task.id,
      ...identity,
      evidenceRefs: normalizedEvidenceRefs(evidence.evidenceRefs),
    };
  });
}

function evidenceHash(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

async function freezeTaskEvidence(
  evidence: FinalBranchTaskEvidence[],
  evidenceStore: (
    runId: string,
  ) => Pick<ArtifactStore, "readEvidence" | "listEvidenceReferences">,
): Promise<FrozenFinalBranchTaskEvidence[]> {
  return await Promise.all(evidence.map(async task => {
    const store = evidenceStore(task.runId);
    let archivedReferences: string[];
    try {
      archivedReferences = normalizedEvidenceRefs(
        await store.listEvidenceReferences(),
        false,
        MAX_TASK_EVIDENCE_REFS,
      );
    } catch {
      fail("missing-task-evidence", `task evidence archive is unavailable: ${task.taskId}`);
    }
    if (REQUIRED_TASK_EVIDENCE_REFS.some(reference =>
      !archivedReferences.includes(reference))
      || task.evidenceRefs.some(reference => !archivedReferences.includes(reference))) {
      fail("missing-task-evidence", `task evidence archive is incomplete: ${task.taskId}`);
    }
    let frozenBytes = 0;
    const frozen = await Promise.all(archivedReferences.map(async reference => {
      let content: string | null;
      try {
        content = await store.readEvidence(reference);
      } catch {
        fail("missing-task-evidence", `task evidence is unavailable: ${task.taskId}/${reference}`);
      }
      if (content === null) {
        fail("missing-task-evidence", `task evidence is missing: ${task.taskId}/${reference}`);
      }
      frozenBytes += Buffer.byteLength(content, "utf8");
      if (frozenBytes > MAX_TASK_EVIDENCE_BYTES) {
        fail(
          "missing-task-evidence",
          `task evidence exceeds the supported size: ${task.taskId}`,
        );
      }
      return { reference, sha256: evidenceHash(content), content };
    }));
    let finalReferences: string[];
    try {
      finalReferences = normalizedEvidenceRefs(
        await store.listEvidenceReferences(),
        false,
        MAX_TASK_EVIDENCE_REFS,
      );
    } catch {
      fail("missing-task-evidence", `task evidence archive is unavailable: ${task.taskId}`);
    }
    if (JSON.stringify(finalReferences) !== JSON.stringify(archivedReferences)) {
      fail("missing-task-evidence", `task evidence archive changed: ${task.taskId}`);
    }
    return { ...task, evidenceRefs: archivedReferences, evidence: frozen };
  }));
}

async function assertTaskEvidenceCurrent(
  artifact: CumulativeBranchArtifact,
  evidenceStore: (
    runId: string,
  ) => Pick<ArtifactStore, "readEvidence" | "listEvidenceReferences">,
): Promise<void> {
  for (const task of artifact.taskEvidence) {
    const store = evidenceStore(task.runId);
    let archivedReferences: string[];
    try {
      archivedReferences = normalizedEvidenceRefs(
        await store.listEvidenceReferences(),
        false,
        MAX_TASK_EVIDENCE_REFS,
      );
    } catch {
      fail("missing-task-evidence", `task evidence archive is unavailable: ${task.taskId}`);
    }
    if (task.evidence.length !== task.evidenceRefs.length
      || JSON.stringify(archivedReferences) !== JSON.stringify(task.evidenceRefs)
      || task.evidence.some((item, index) => item.reference !== task.evidenceRefs[index])) {
      fail("missing-task-evidence", "frozen task evidence index is inconsistent");
    }
    for (const item of task.evidence) {
      let content: string | null;
      try {
        content = await store.readEvidence(item.reference);
      } catch {
        fail("missing-task-evidence", `task evidence is unavailable: ${task.taskId}/${item.reference}`);
      }
      if (content === null
        || evidenceHash(content) !== item.sha256
        || content !== item.content) {
        fail("missing-task-evidence", `task evidence changed: ${task.taskId}/${item.reference}`);
      }
    }
  }
}

async function provePromotionChain(
  runGit: typeof git,
  checkoutPath: string,
  baseCommitOid: string,
  headCommitOid: string,
  taskEvidence: FinalBranchTaskEvidence[],
): Promise<void> {
  let expectedParent = baseCommitOid;
  for (const task of taskEvidence) {
    const commit = await runGit(checkoutPath, [
      "rev-parse", "--verify", `${task.promotionCommitOid}^{commit}`,
    ]);
    const parent = await runGit(checkoutPath, [
      "rev-parse", "--verify", `${task.promotionCommitOid}^`,
    ]);
    if (!succeeded(commit)
      || commit.stdout.trim() !== task.promotionCommitOid
      || !succeeded(parent)
      || parent.stdout.trim() !== expectedParent) {
      fail("workflow-state-mismatch", `task promotion is not in branch order: ${task.taskId}`);
    }
    expectedParent = task.promotionCommitOid;
  }
  if (expectedParent !== headCommitOid) {
    fail("workflow-state-mismatch", "final branch head is not the last task promotion");
  }
}

function branchIdentityMatchesState(
  identity: WorkflowBranchIdentity,
  state: AutopilotWorkflowState,
): boolean {
  return identity.workflowId === state.workflowId
    && identity.repositoryIdentity === state.repositoryIdentity
    && identity.worktreePath === state.worktreePath
    && identity.branchRef === state.workflowRef
    && identity.baseCommitOid === state.baseCommitOid;
}

async function revalidateBranchIdentity(
  branchManager: WorkflowBranchManager,
  identity: WorkflowBranchIdentity,
  expectedHead: string,
  borrowedCheckoutLock?: CheckoutLock,
): Promise<void> {
  const result = borrowedCheckoutLock === undefined
    ? await branchManager.revalidate(identity, expectedHead)
    : await branchManager.revalidateUnderLock(identity, expectedHead, borrowedCheckoutLock);
  if (!result.ok) {
    fail(
      result.classification === "head-changed" ? "head-changed" : "workflow-state-mismatch",
      `final branch revalidation failed: ${result.classification}`,
    );
  }
}

export function branchArtifactHashOf(artifact: UnhashedCumulativeBranchArtifact): string {
  return canonicalArtifactHash(artifact);
}

export async function revalidateHead(
  checkoutPath: string,
  expectedHead: string,
  runGit: typeof git = git,
  expectedTree?: string,
): Promise<void> {
  if (!OBJECT_ID.test(expectedHead)) {
    fail("workflow-state-mismatch", "expected final branch head is invalid");
  }
  const result = await runGit(checkoutPath, ["rev-parse", "--verify", "HEAD^{commit}"]);
  if (!succeeded(result)) fail("git-command-failed", "failed to revalidate final branch head");
  if (result.stdout.trim() !== expectedHead) {
    fail("head-changed", "final branch head changed");
  }
  const tree = await runGit(checkoutPath, ["rev-parse", "--verify", "HEAD^{tree}"]);
  if (!succeeded(tree)) fail("git-command-failed", "failed to revalidate final branch tree");
  if (expectedTree !== undefined && tree.stdout.trim() !== expectedTree) {
    fail("head-changed", "final branch tree changed");
  }
  const status = await runGit(checkoutPath, [
    "status", "--porcelain=v1", "-z", "--untracked-files=all",
  ]);
  if (!succeeded(status)) fail("git-command-failed", "failed to revalidate final branch status");
  if (status.stdout !== "") fail("head-changed", "final branch checkout is dirty");
}

/** Run one later verification or role phase only while the frozen head remains exact. */
export async function withHeadRevalidation<T>(request: HeadBoundPhaseRequest<T>): Promise<T> {
  if (request.phase.trim().length === 0) {
    fail("workflow-state-mismatch", "head-bound phase name is missing");
  }
  const runGit = request.git ?? git;
  await revalidateHead(
    request.checkoutPath,
    request.expectedHead,
    runGit,
    request.expectedTree,
  );
  let primaryError: unknown;
  try {
    return await request.execute();
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    try {
      await revalidateHead(
        request.checkoutPath,
        request.expectedHead,
        runGit,
        request.expectedTree,
      );
    } catch (revalidationError) {
      if (primaryError === undefined) throw revalidationError;
      throw new AggregateError(
        [primaryError, revalidationError],
        `${request.phase} failed and the final branch head also changed`,
      );
    }
  }
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort();
}

function finalPathAllowed(
  pathname: string,
  writeAllowlist: string[],
  forbiddenScope: string[],
  opaqueDirectory: boolean,
): boolean {
  const candidates = opaqueDirectory ? [pathname, `${pathname}/`] : [pathname];
  return writeAllowlist.some(pattern => candidates.some(candidate => globMatches(pattern, candidate)))
    && !forbiddenScope.some(pattern =>
      candidates.some(candidate => globMatches(pattern, candidate, true)));
}

/** Structural proof adapted to a linear, multi-commit base-to-head artifact. */
async function structuralVerifyFinalBranch(
  args: StructuralVerifyArgs,
  runGit: typeof git = git,
): Promise<StructuralVerifyResult> {
  const failures = new Set<StructuralFailure>();
  const [manifest, baseTree, sourceHead, materializedHead, candidateTree, sourceStatus, materializedStatus] =
    await Promise.all([
      recomputeManifest(args),
      checkedGit(runGit, args.repoRoot, ["rev-parse", "--verify", `${args.baseCommitOid}^{tree}`]),
      checkedGit(runGit, args.repoRoot, ["rev-parse", "--verify", "HEAD^{commit}"]),
      checkedGit(runGit, args.worktreePath, ["rev-parse", "--verify", "HEAD^{commit}"]),
      checkedGit(runGit, args.repoRoot, [
        "rev-parse", "--verify", `${args.artifact.candidateCommitOid}^{tree}`,
      ]),
      checkedGit(runGit, args.repoRoot, [
        "status", "--porcelain=v1", "-z", "--untracked-files=all",
      ]),
      checkedGit(runGit, args.worktreePath, [
        "status", "--porcelain=v1", "-z", "--untracked-files=all",
      ]),
    ]);
  const ancestry = await runGit(args.repoRoot, [
    "merge-base", "--is-ancestor", args.baseCommitOid, args.artifact.candidateCommitOid,
  ]);

  if (args.artifact.baseCommitOid !== args.baseCommitOid) failures.add("artifact-base-mismatch");
  if (sourceHead.trim() !== args.artifact.candidateCommitOid
    || materializedHead.trim() !== args.artifact.candidateCommitOid
    || candidateTree.trim() !== args.artifact.candidateTreeOid
    || ancestry.exitCode !== 0
    || ancestry.truncated?.stdout === true
    || ancestry.truncated?.stderr === true
    || sourceStatus !== ""
    || materializedStatus !== "") {
    failures.add("artifact-divergence");
  }
  if (JSON.stringify(args.artifact.changedPaths) !== JSON.stringify(manifest.changedPaths)
    || args.artifact.manifestHash !== manifest.manifestHash) {
    failures.add("manifest-divergence");
  }
  if (manifest.changedPaths.some(change => !finalPathAllowed(
    change.path,
    args.writeAllowlist,
    args.forbiddenScope,
    change.mode === "160000",
  ))) {
    failures.add("out-of-scope-write");
  }
  if (manifest.rawDiff.some(entry =>
    [entry.oldMode, entry.newMode].some(mode => mode === "120000" || mode === "160000"))) {
    failures.add("modified-symlink");
  }
  if (manifest.changedPaths.length === 0
    || args.artifact.candidateTreeOid === baseTree.trim()) {
    failures.add("empty-candidate");
  }
  return {
    ok: failures.size === 0,
    failures: [...failures],
    manifestHash: manifest.manifestHash,
  };
}

function finalDelegationSpec(spec: AutopilotSpec): DelegationSpec {
  const template = spec.tasks[0]?.delegation;
  if (template === undefined) {
    fail("workflow-state-mismatch", "final review requires at least one task delegation");
  }
  const allowedTestDeletions = uniqueSorted(spec.tasks.flatMap(task =>
    task.delegation.allowedTestDeletions ?? []));
  const finalSpec: DelegationSpec = {
    ...structuredClone(template),
    objective: [
      `[autopilot final branch] ${spec.topic}`,
      ...spec.tasks.map(task => `[${task.id}] ${task.delegation.objective}`),
    ].join("\n"),
    context: "",
    successCriteria: [
      ...spec.tasks.flatMap(task => task.delegation.successCriteria.map(criterion =>
        `[${task.id}] ${criterion}`)),
      ...spec.finalSuccessCriteria.map(criterion => `[final] ${criterion}`),
    ],
    verification: structuredClone(spec.finalVerification),
    writeAllowlist: uniqueSorted(spec.tasks.flatMap(task => task.delegation.writeAllowlist)),
    forbiddenScope: uniqueSorted(spec.tasks.flatMap(task => task.delegation.forbiddenScope)),
    ...(allowedTestDeletions.length === 0 ? {} : { allowedTestDeletions }),
    review: {
      ...(template.review ?? { maxRounds: 1 }),
      reviewers: ["correctness", "systems"],
      maxRounds: 1,
    },
  };
  delete finalSpec.slices;
  delete finalSpec.implementation;
  return finalSpec;
}

function candidateArtifactOf(artifact: CumulativeBranchArtifact): CandidateArtifact {
  return {
    baseCommitOid: artifact.baseCommitOid,
    candidateTreeOid: artifact.headTreeOid,
    candidateCommitOid: artifact.headCommitOid,
    anchorRef: "",
    manifestHash: artifact.manifestHash,
    changedPaths: structuredClone(artifact.changedPaths),
    patch: artifact.patch,
  };
}

function errorDiagnostic(error: unknown): string {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return redact(message).slice(0, 2_000);
}

function failedVerification(reason: string): AcceptanceVerifyResult {
  return {
    ok: false,
    failures: [reason],
    evidence: { finalReviewFailure: reason },
    commandOutcomes: [],
  };
}

function failedReview(role: "correctness" | "systems", reason: string): ReviewReport {
  return {
    reportVersion: "1",
    verdict: "request-changes",
    findings: [],
    coverageGaps: [`The fresh ${role} review is unavailable: ${reason}`],
  };
}

function failedAdvisor(reason: string): AdvisorReport {
  return {
    reportVersion: "1",
    verdict: "human-decision-required",
    rationale: `The fresh final advisor is unavailable: ${reason}`,
    risks: [],
    coverageGaps: ["Fresh advisor coverage is unavailable."],
  };
}

function parseRoleReport<T>(
  result: RoleRunResult,
  validate: (value: unknown) => boolean,
): T | null {
  if (!result.ok) return null;
  const json = extractJson(result.rawOutput);
  if (json === null) return null;
  const value: unknown = JSON.parse(json);
  return validate(value) ? value as T : null;
}

function addReason(reasons: string[], reason: string): void {
  if (!reasons.includes(reason)) reasons.push(reason);
}

function reviewReasons(
  role: "correctness" | "systems",
  report: ReviewReport,
  reasons: string[],
): void {
  if (report.verdict !== "approve") addReason(reasons, `${role} review requested changes`);
  if (report.findings.some(finding => finding.severity === "blocker" || finding.severity === "major")) {
    addReason(reasons, `${role} review reported blocking findings`);
  }
  if (report.coverageGaps.length > 0) addReason(reasons, `${role} review reported coverage gaps`);
}

function advisorReasons(report: AdvisorReport, reasons: string[]): void {
  if (report.verdict !== "approve") addReason(reasons, "advisor requires a human decision");
  if (report.coverageGaps.length > 0) addReason(reasons, "advisor reported coverage gaps");
  if (report.risks.some(risk => risk.severity === "blocker" || risk.severity === "major")) {
    addReason(reasons, "advisor reported blocking risks");
  }
}

function verificationReasons(
  verification: AcceptanceVerifyResult,
  spec: DelegationSpec,
  platformServices: PlatformServices,
  reasons: string[],
): void {
  if (!verification.ok) {
    if (verification.failures.length === 0) addReason(reasons, "final verification failed");
    for (const failure of verification.failures) {
      addReason(reasons, `final verification failed: ${failure}`);
    }
  } else if (verification.failures.length > 0) {
    addReason(reasons, "final verification result is internally inconsistent");
  }

  const applicable = spec.verification.filter(command =>
    (command.platform?.os === undefined || command.platform.os.includes(platformServices.os))
    && (command.platform?.arch === undefined || command.platform.arch.includes(process.arch)));
  const commandsById = new Map(applicable.map(command => [command.id, command]));
  const outcomesById = new Map(verification.commandOutcomes.map(outcome => [outcome.id, outcome]));
  if (verification.commandOutcomes.length === 0) {
    addReason(reasons, "final verification had zero applicable commands");
  }
  if (commandsById.size !== applicable.length
    || outcomesById.size !== verification.commandOutcomes.length
    || verification.commandOutcomes.length !== applicable.length) {
    addReason(reasons, "final verification command evidence is incomplete");
  }
  for (const outcome of verification.commandOutcomes) {
    const command = commandsById.get(outcome.id);
    if (command === undefined
      || outcome.timedOut
      || outcome.exitCode === null
      || !command.expectedExitCodes.includes(outcome.exitCode)) {
      addReason(reasons, `final verification command was not green: ${outcome.id}`);
    }
  }
}

function freezePackage<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const nested of Object.values(value as Record<string, unknown>)) freezePackage(nested);
    Object.freeze(value);
  }
  return value;
}

async function persistImmutableJson(
  workflowDirectory: string,
  reference: string,
  value: unknown,
): Promise<void> {
  const destination = path.join(workflowDirectory, reference);
  const temporary = path.join(workflowDirectory, `.${reference}.${randomUUID()}.tmp`);
  const serialized = `${JSON.stringify(value, null, 2)}\n`;
  let handle: FileHandle | undefined;
  let temporaryExists = false;
  try {
    handle = await open(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NO_FOLLOW,
      0o600,
    );
    temporaryExists = true;
    await handle.writeFile(serialized, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    try {
      await link(temporary, destination);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const metadata = await lstat(destination);
      if (!metadata.isFile()
        || metadata.isSymbolicLink()
        || metadata.nlink !== 1
        || await readFile(destination, "utf8") !== serialized) {
        fail("artifact-persistence-failed", `a different ${reference} already exists`);
      }
    }
    await rm(temporary);
    temporaryExists = false;
    await syncDirectoryMetadata(workflowDirectory);
    if (await readFile(destination, "utf8") !== serialized) {
      fail("artifact-persistence-failed", `${reference} was not durably persisted`);
    }
  } catch (error) {
    if (error instanceof FinalBranchReviewError) throw error;
    fail("artifact-persistence-failed", `failed to persist ${reference}`);
  } finally {
    await handle?.close();
    if (temporaryExists) await rm(temporary, { force: true });
  }
}

async function persistFrozenArtifact(
  workflowDirectory: string,
  artifact: CumulativeBranchArtifact,
): Promise<void> {
  const destination = path.join(workflowDirectory, FINAL_BRANCH_ARTIFACT_REF);
  const temporary = path.join(
    workflowDirectory,
    `.${FINAL_BRANCH_ARTIFACT_REF}.${randomUUID()}.tmp`,
  );
  const serialized = `${JSON.stringify(artifact, null, 2)}\n`;
  let handle: FileHandle | undefined;
  let temporaryExists = false;
  try {
    handle = await open(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NO_FOLLOW,
      0o600,
    );
    temporaryExists = true;
    await handle.writeFile(serialized, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    try {
      await link(temporary, destination);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const metadata = await lstat(destination);
      if (!metadata.isFile()
        || metadata.isSymbolicLink()
        || metadata.nlink !== 1
        || await readFile(destination, "utf8") !== serialized) {
        fail("artifact-persistence-failed", "a different final branch artifact already exists");
      }
    }
    await rm(temporary);
    temporaryExists = false;
    await syncDirectoryMetadata(workflowDirectory);
    const persisted = JSON.parse(await readFile(destination, "utf8")) as CumulativeBranchArtifact;
    const { branchArtifactHash, ...unhashed } = persisted;
    if (branchArtifactHash !== artifact.branchArtifactHash
      || branchArtifactHashOf(unhashed) !== artifact.branchArtifactHash) {
      fail("artifact-persistence-failed", "final branch artifact was not durably persisted");
    }
  } catch (error) {
    if (error instanceof FinalBranchReviewError) throw error;
    fail("artifact-persistence-failed", "failed to persist final branch artifact");
  } finally {
    await handle?.close();
    if (temporaryExists) await rm(temporary, { force: true });
  }
}

async function assertPersistedArtifact(
  workflowDirectory: string,
  artifact: CumulativeBranchArtifact,
): Promise<void> {
  let handle: FileHandle | undefined;
  try {
    const destination = path.join(workflowDirectory, FINAL_BRANCH_ARTIFACT_REF);
    // Open once and check THAT handle: `lstat` followed by `readFile` resolves
    // the name twice, so a swap between the two calls would be read as durable
    // evidence. The read is bounded for the same reason it is elsewhere.
    handle = await open(destination, constants.O_RDONLY | NO_FOLLOW);
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.nlink !== 1
      || metadata.size > MAX_FINAL_BRANCH_ARTIFACT_BYTES) {
      fail("artifact-persistence-failed", "final branch artifact is not a safe regular file");
    }
    const persisted = JSON.parse(await handle.readFile("utf8")) as CumulativeBranchArtifact;
    const { branchArtifactHash, ...unhashed } = persisted;
    if (branchArtifactHash !== artifact.branchArtifactHash
      || branchArtifactHashOf(unhashed) !== artifact.branchArtifactHash
      || canonicalArtifactHash(persisted) !== canonicalArtifactHash(artifact)) {
      fail("artifact-persistence-failed", "final branch artifact does not match durable evidence");
    }
  } catch (error) {
    if (error instanceof FinalBranchReviewError) throw error;
    fail("artifact-persistence-failed", "final branch artifact is unavailable");
  } finally {
    await handle?.close();
  }
}

export class FinalBranchReviewer {
  private readonly runGit: typeof git;
  private readonly branchManager: WorkflowBranchManager;
  private readonly workflowStore: (workflowId: string) => WorkflowStore;
  private readonly acceptanceVerifier: Pick<AcceptanceVerifier, "verify">;
  private readonly roleRunner: (args: RoleRunArgs) => Promise<RoleRunResult>;
  private readonly platformServices: PlatformServices;
  private readonly producerRegistry: ProducerRegistry;
  private readonly artifactStore: (workflowId: string) => Pick<ArtifactStore, "writeLog">;
  private readonly evidenceStore: (
    runId: string,
  ) => Pick<ArtifactStore, "readEvidence" | "listEvidenceReferences">;
  private readonly taskEvidenceValidator: NonNullable<
    FinalBranchReviewerDependencies["taskEvidenceValidator"]
  >;
  private readonly materialize: NonNullable<FinalBranchReviewerDependencies["materialize"]>;
  private readonly now: () => string;

  constructor(dependencies: FinalBranchReviewerDependencies = {}) {
    this.runGit = dependencies.git ?? git;
    this.branchManager = dependencies.branchManager ?? new WorkflowBranchManager();
    this.workflowStore = dependencies.workflowStore ?? (workflowId => new WorkflowStore(workflowId));
    this.acceptanceVerifier = dependencies.acceptanceVerifier ?? new AcceptanceVerifier({
      structural: async args => await structuralVerifyFinalBranch(args, this.runGit),
    });
    this.roleRunner = dependencies.roleRunner ?? runRole;
    this.platformServices = dependencies.platformServices ?? getPlatformServices();

    this.producerRegistry = dependencies.producerRegistry ?? defaultRegistry;
    this.artifactStore = dependencies.artifactStore ?? (workflowId =>
      new ArtifactStore(`final-${canonicalArtifactHash(workflowId).slice(0, 24)}`));
    this.evidenceStore = dependencies.evidenceStore ?? (runId => new ArtifactStore(runId));
    this.taskEvidenceValidator = dependencies.taskEvidenceValidator ?? validateArchivedTaskEvidence;
    this.materialize = dependencies.materialize ?? (async request => {
      const workflowHash = createHash("sha256").update(request.workflowId).digest("hex");
      const manager = new WorktreeManager(
        request.checkoutPath,
        `workflow-${workflowHash.slice(0, 32)}-final`,
        request.platformServices,
        { borrowedCheckoutLease: request.borrowedCheckoutLease },
      );
      return await manager.create(request.headCommitOid);
    });
    this.now = dependencies.now ?? (() => new Date().toISOString());
  }

  /** Freeze and durably publish the cumulative artifact before any model-backed phase may run. */
  async freezeCumulativeArtifact(
    request: FreezeCumulativeBranchArtifactRequest,
  ): Promise<CumulativeBranchArtifact> {
    const store = this.workflowStore(request.workflowId);
    return await store.withLockedState(request.expectedRevision, async state => {
      if (state.workflowId !== request.workflowId
        || state.phase !== "final-review"
        || !OBJECT_ID.test(state.baseCommitOid)) {
        fail("workflow-state-mismatch", "workflow is not ready for final branch review");
      }
      let branchIdentity: WorkflowBranchIdentity | null;
      try {
        branchIdentity = await this.branchManager.load(request.workflowId);
      } catch {
        fail("workflow-state-mismatch", "final branch ownership is unavailable");
      }
      if (branchIdentity === null) {
        fail("workflow-state-mismatch", "final branch ownership is unavailable");
      }
      if (!branchIdentityMatchesState(branchIdentity, state)) {
        fail("workflow-state-mismatch", "final branch ownership does not match workflow state");
      }
      const normalizedTaskEvidence = normalizeTaskEvidence(state, request.taskEvidence);
      const headCommitOid = (await checkedGit(
        this.runGit,
        state.worktreePath,
        ["rev-parse", "--verify", "HEAD^{commit}"],
      )).trim();
      if (!OBJECT_ID.test(headCommitOid)) fail("git-command-failed", "final branch head is invalid");
      await revalidateBranchIdentity(this.branchManager, branchIdentity, headCommitOid);
      await provePromotionChain(
        this.runGit,
        state.worktreePath,
        state.baseCommitOid,
        headCommitOid,
        normalizedTaskEvidence,
      );
      let expectedParentCommitOid = state.baseCommitOid;
      for (let index = 0; index < normalizedTaskEvidence.length; index += 1) {
        const evidence = normalizedTaskEvidence[index]!;
        await this.taskEvidenceValidator(state.tasks[index]!, evidence, {
          checkoutPath: state.worktreePath,
          expectedParentCommitOid,
          git: this.runGit,
        });
        expectedParentCommitOid = evidence.promotionCommitOid;
      }
      const taskEvidence = await freezeTaskEvidence(
        normalizedTaskEvidence,
        this.evidenceStore,
      );
      const headTreeOid = (await checkedGit(
        this.runGit,
        state.worktreePath,
        ["rev-parse", "--verify", `${headCommitOid}^{tree}`],
      )).trim();
      if (!OBJECT_ID.test(headTreeOid)) fail("git-command-failed", "final branch tree is invalid");

      const rawDiff = parseRawDiff(await checkedGit(this.runGit, state.worktreePath, [
        "diff-tree", "-r", "--no-commit-id", "--no-renames", "--raw", "-z",
        state.baseCommitOid, headTreeOid,
      ]));
      const [nameStatusOutput, treeOutput, patch] = await Promise.all([
        checkedGit(this.runGit, state.worktreePath, [
          "diff-tree", "-r", "--no-commit-id", "--no-renames", "--name-status", "-z",
          state.baseCommitOid, headTreeOid,
        ]),
        checkedGit(this.runGit, state.worktreePath, ["ls-tree", "-r", "-z", headTreeOid]),
        checkedGit(this.runGit, state.worktreePath, [
          "diff", "--no-ext-diff", "--no-textconv", "--binary", "--full-index",
          state.baseCommitOid, headTreeOid,
        ]),
      ]);
      const manifest = computeChangedPathManifest({ rawDiff, nameStatusOutput, treeOutput });
      await revalidateHead(state.worktreePath, headCommitOid, this.runGit, headTreeOid);
      await revalidateBranchIdentity(this.branchManager, branchIdentity, headCommitOid);

      const unhashed: UnhashedCumulativeBranchArtifact = {
        artifactVersion: "1",
        workflowId: state.workflowId,
        baseCommitOid: state.baseCommitOid,
        headCommitOid,
        headTreeOid,
        manifestHash: manifest.manifestHash,
        changedPaths: manifest.changedPaths,
        patch,
        taskEvidence,
      };
      const artifact: CumulativeBranchArtifact = {
        ...unhashed,
        branchArtifactHash: branchArtifactHashOf(unhashed),
      };
      await assertTaskEvidenceCurrent(artifact, this.evidenceStore);
      await persistFrozenArtifact(store.workflowDirectory, artifact);
      return structuredClone(artifact);
    });
  }

  private async withCheckoutLease<T>(
    checkoutPath: string,
    phase: string,
    execute: (lease: CheckoutLock) => Promise<T>,
  ): Promise<T> {
    const safety = new PlatformSafety(this.platformServices);
    try {
      return await safety.withCheckoutLease(checkoutPath, execute);
    } catch (error) {
      if (error instanceof Error && error.message === "checkout Git common directory could not be resolved") {
        fail("workflow-state-mismatch", "final review checkout is not a repository");
      }
      throw error;
    }
  }


  async runHeadBoundPhase<T>(
    artifact: CumulativeBranchArtifact,
    phase: string,
    execute: () => Promise<T>,
    checkoutPath: string,
  ): Promise<T> {
    return await this.withCheckoutLease(
      checkoutPath,
      phase,
      async lease => await this.runHeadBoundPhaseCore(
        artifact,
        phase,
        execute,
        checkoutPath,
        lease,
      ),
    );
  }

  private async runHeadBoundPhaseCore<T>(
    artifact: CumulativeBranchArtifact,
    phase: string,
    execute: () => Promise<T>,
    checkoutPath: string,
    checkoutLease: CheckoutLock,
  ): Promise<T> {
    const store = this.workflowStore(artifact.workflowId);
    const state = await store.read();
    let branchIdentity: WorkflowBranchIdentity | null;
    try {
      branchIdentity = await this.branchManager.load(artifact.workflowId);
    } catch {
      fail("workflow-state-mismatch", "final branch ownership is unavailable");
    }
    if (branchIdentity === null
      || !branchIdentityMatchesState(branchIdentity, state)
      || state.baseCommitOid !== artifact.baseCommitOid) {
      fail("workflow-state-mismatch", "final branch ownership does not match frozen evidence");
    }
    await assertPersistedArtifact(store.workflowDirectory, artifact);
    await assertTaskEvidenceCurrent(artifact, this.evidenceStore);
    await revalidateBranchIdentity(
      this.branchManager,
      branchIdentity,
      artifact.headCommitOid,
      checkoutLease,
    );
    let result: T | undefined;
    let completed = false;
    let phaseError: unknown;
    try {
      result = await withHeadRevalidation({
        checkoutPath,
        expectedHead: artifact.headCommitOid,
        expectedTree: artifact.headTreeOid,
        phase,
        execute: async () => {
          let primaryError: unknown;
          try {
            return await execute();
          } catch (error) {
            primaryError = error;
            throw error;
          } finally {
            try {
              await assertPersistedArtifact(store.workflowDirectory, artifact);
              await assertTaskEvidenceCurrent(artifact, this.evidenceStore);
            } catch (evidenceError) {
              if (primaryError === undefined) throw evidenceError;
              throw new AggregateError(
                [primaryError, evidenceError],
                `${phase} failed and its frozen evidence also changed`,
              );
            }
          }
        },
        git: this.runGit,
      });
      completed = true;
    } catch (error) {
      phaseError = error;
    }
    try {
      await revalidateBranchIdentity(
        this.branchManager,
        branchIdentity,
        artifact.headCommitOid,
        checkoutLease,
      );
    } catch (revalidationError) {
      if (phaseError === undefined) throw revalidationError;
      if (phaseError instanceof FinalBranchReviewError
        && revalidationError instanceof FinalBranchReviewError
        && phaseError.classification === revalidationError.classification) {
        throw phaseError;
      }
      throw new AggregateError(
        [phaseError, revalidationError],
        `${phase} failed and final branch identity also changed`,
      );
    }
    if (phaseError !== undefined) throw phaseError;
    if (!completed) fail("workflow-state-mismatch", `${phase} did not complete`);
    return result as T;
  }

  private async runFreshMaterializedPhase<T>(
    artifact: CumulativeBranchArtifact,
    sourceCheckoutPath: string,
    phase: string,
    execute: (materializedPath: string) => Promise<T>,
    checkoutLease?: CheckoutLock,
  ): Promise<T> {
    const runWithLease = async (lease: CheckoutLock) => {
      await assertNoPendingWorktreeRemovalForRepository(lease.repositoryIdentity);
      return await this.runHeadBoundPhaseCore(artifact, phase, async () => {
        let materialization: { path: string; cleanup(): Promise<void> } | null = null;
        let phaseError: unknown;
        try {
          materialization = await this.materialize({
            checkoutPath: sourceCheckoutPath,
            workflowId: artifact.workflowId,
            headCommitOid: artifact.headCommitOid,
            platformServices: this.platformServices,
            borrowedCheckoutLease: lease,
          });
          const detached = await this.runGit(materialization.path, [
            "symbolic-ref", "--quiet", "HEAD",
          ]);
          if (detached.exitCode !== 1
            || detached.truncated?.stdout === true
            || detached.truncated?.stderr === true) {
            fail("workflow-state-mismatch", "final review materialization is not detached");
          }
          return await withHeadRevalidation({
            checkoutPath: materialization.path,
            expectedHead: artifact.headCommitOid,
            expectedTree: artifact.headTreeOid,
            phase: `${phase} materialization`,
            execute: async () => await execute(materialization!.path),
            git: this.runGit,
          });
        } catch (error) {
          phaseError = error;
          throw error;
        } finally {
          if (materialization !== null) {
            try {
              await materialization.cleanup();
            } catch (cleanupError) {
              if (phaseError === undefined) {
                throw new Error(
                  `${phase} materialization cleanup failed: ${errorDiagnostic(cleanupError)}`,
                );
              }
              throw new AggregateError(
                [phaseError, cleanupError],
                `${phase} failed and its materialization cleanup also failed: ${errorDiagnostic(cleanupError)}`,
              );
            }
          }
        }
      }, sourceCheckoutPath, lease);
    };
    return checkoutLease === undefined
      ? await this.withCheckoutLease(sourceCheckoutPath, phase, runWithLease)
      : await runWithLease(checkoutLease);
  }

  /** Freeze the whole branch, then execute the complete cumulative gate. */
  async review(request: FinalBranchReviewRequest): Promise<FinalBranchReport> {
    const artifact = await this.freezeCumulativeArtifact({
      workflowId: request.workflowId,
      expectedRevision: request.expectedRevision,
      taskEvidence: request.taskEvidence,
    });
    return await this.runFinalReview({
      artifact,
      autopilotSpec: request.autopilotSpec,
      checkoutPath: request.checkoutPath,
    });
  }

  /** Execute the final, whole-branch gate from one immutable cumulative artifact. */
  async runFinalReview(request: RunFinalBranchReviewRequest): Promise<FinalBranchReport> {
    return await this.withCheckoutLease(
      request.checkoutPath,
      "final-review",
      async checkoutLease => await this.runFinalReviewCore(request, checkoutLease),
    );
  }

  private async runFinalReviewCore(
    request: RunFinalBranchReviewRequest,
    checkoutLease: CheckoutLock,
  ): Promise<FinalBranchReport> {
    const { artifact } = request;
    const store = this.workflowStore(artifact.workflowId);
    await assertPersistedArtifact(store.workflowDirectory, artifact);
    const state = await store.read();
    if (state.phase !== "final-review"
      || state.baseCommitOid !== artifact.baseCommitOid
      || state.tasks.length !== request.autopilotSpec.tasks.length
      || state.tasks.some((task, index) => task.id !== request.autopilotSpec.tasks[index]?.id)
      || canonicalArtifactHash(request.autopilotSpec) !== state.autopilotSpecHash) {
      fail("workflow-state-mismatch", "final review specification does not match workflow state");
    }
    const spec = finalDelegationSpec(request.autopilotSpec);
    const reasons: string[] = [];
    let verification = failedVerification("final verification did not run");
    let correctness = failedReview("correctness", "the phase did not run");
    let systems = failedReview("systems", "the phase did not run");
    let advisor = failedAdvisor("the phase did not run");
    const roleRunId = `final-${canonicalArtifactHash(artifact.workflowId).slice(0, 24)}`;

    try {
      verification = redactRecord(await this.runFreshMaterializedPhase(
        artifact,
        request.checkoutPath,
        "final-verification",
        async materializedPath => await this.acceptanceVerifier.verify({
            repoRoot: request.checkoutPath,
            worktreePath: materializedPath,
            baseCommitOid: artifact.baseCommitOid,
            artifact: candidateArtifactOf(artifact),
            spec,
            ps: this.platformServices,
            artifactStore: this.artifactStore(artifact.workflowId),
            borrowedCheckoutLease: checkoutLease,
            verificationId: () => `${roleRunId}-verification`,
            logNamePrefix: "final-verification",
          }),
        checkoutLease,
      )) as unknown as AcceptanceVerifyResult;
    } catch (error) {
      verification = failedVerification(`final verification execution failed: ${errorDiagnostic(error)}`);
    }
    verificationReasons(verification, spec, this.platformServices, reasons);

    const frozenEvidence = freezePackage({
      autopilotSpec: structuredClone(request.autopilotSpec),
      artifact: structuredClone(artifact),
      verification: structuredClone(verification),
      taskEvidence: structuredClone(artifact.taskEvidence),
    });
    const pkg = freezePackage<RolePackage>({
      spec,
      baselineCommit: artifact.baseCommitOid,
      candidateCommit: artifact.headCommitOid,
      candidateDiff: artifact.patch,
      testEvidence: JSON.stringify(frozenEvidence),
      advisorEvidence: frozenEvidence,
    });
    const runStructuredFinalRole = async <T>(
      role: StructuredFinalRole,
      validate: (value: unknown) => boolean,
    ): Promise<T | null> => {
      const result = await this.runFreshMaterializedPhase(
        artifact,
        request.checkoutPath,
        role,
        async materializedPath => await this.roleRunner({
            role,
            baseSpec: spec,
            pkg,
            worktreePath: materializedPath,
            ps: this.platformServices,
            registry: this.producerRegistry,
            runId: roleRunId,
          }),
        checkoutLease,
      );
      return parseRoleReport<T>(result, validate);
    };

    try {
      correctness = redactRecord(await runStructuredFinalRole<ReviewReport>(
          "reviewer-correctness",
          value => schemas.reviewReport(value),
        ) ?? failedReview("correctness", "the role failed or returned invalid output")) as ReviewReport;
    } catch (error) {
      correctness = failedReview("correctness", errorDiagnostic(error));
    }
    reviewReasons("correctness", correctness, reasons);

    try {
      systems = redactRecord(await runStructuredFinalRole<ReviewReport>(
          "reviewer-systems",
          value => schemas.reviewReport(value),
        ) ?? failedReview("systems", "the role failed or returned invalid output")) as ReviewReport;
    } catch (error) {
      systems = failedReview("systems", errorDiagnostic(error));
    }
    reviewReasons("systems", systems, reasons);

    try {
      advisor = redactRecord(await runStructuredFinalRole<AdvisorReport>(
          "advisor",
          value => schemas.advisorReport(value),
        ) ?? failedAdvisor("the role failed or returned invalid output")) as AdvisorReport;
    } catch (error) {
      advisor = failedAdvisor(errorDiagnostic(error));
    }
    advisorReasons(advisor, reasons);

    const reviewReports = [correctness, systems];
    const report: FinalBranchReport = {
      reportVersion: "1",
      workflowId: artifact.workflowId,
      baseCommitOid: artifact.baseCommitOid,
      headCommitOid: artifact.headCommitOid,
      branchArtifactHash: artifact.branchArtifactHash,
      verificationHash: canonicalArtifactHash(verification),
      reviewHashes: reviewReports.map(review => canonicalArtifactHash(review)),
      advisorHash: canonicalArtifactHash(advisor),
      taskEvidenceHashes: artifact.taskEvidence.map(evidence => canonicalArtifactHash(evidence)),
      eligible: reasons.length === 0,
      reasons,
      status: reasons.length === 0 ? "ready-to-ship" : "human-decision-required",
      evaluatedAt: this.now(),
    };
    await this.runHeadBoundPhaseCore(
      artifact,
      "final-evidence-publication",
      async () => {
        await persistImmutableJson(store.workflowDirectory, FINAL_VERIFICATION_REF, verification);
        await persistImmutableJson(
          store.workflowDirectory,
          FINAL_CORRECTNESS_REVIEW_REF,
          correctness,
        );
        await persistImmutableJson(store.workflowDirectory, FINAL_SYSTEMS_REVIEW_REF, systems);
        await persistImmutableJson(store.workflowDirectory, FINAL_ADVISOR_REF, advisor);
      },
      request.checkoutPath,
      checkoutLease,
    );
    await this.runHeadBoundPhaseCore(
      artifact,
      "final-report-publication",
      async () => await persistImmutableJson(
        store.workflowDirectory,
        FINAL_BRANCH_REPORT_REF,
        report,
      ),
      request.checkoutPath,
      checkoutLease,
    );
    return structuredClone(report);
  }
}
