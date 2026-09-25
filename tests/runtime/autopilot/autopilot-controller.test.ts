import { describe, expect, it, vi } from "vitest";
import {
  AutopilotController,
  type AutopilotControllerDependencies,
  type WorkflowStorePort,
} from "../../../src/autopilot/autopilot-controller.js";
import {
  canonicalArtifactHash,
  type AutopilotEligibilityRecord,
} from "../../../src/autopilot/autopilot-eligibility.js";
import type { WorkflowBranchIdentity } from "../../../src/autopilot/branch-manager.js";
import type { AutopilotWorkflowState } from "../../../src/autopilot/types.js";
import type { PipelineResult } from "../../../src/pipeline/pipeline-runtime.js";
import type { AutopilotSpec } from "../../../src/protocol/autopilot-spec.js";
import type { ReviewSnapshot } from "../../../src/runtime/review-snapshot.js";

const REPOSITORY = "/repo";
const WORKFLOW_ID = "12345678-1234-4123-8123-123456789abc";
const BASE = "1".repeat(40);
const FIRST_COMMIT = "2".repeat(40);
const FIRST_TREE = "3".repeat(40);
const SECOND_COMMIT = "4".repeat(40);
const SECOND_TREE = "5".repeat(40);
const FIRST_MANIFEST = "a".repeat(64);
const SECOND_MANIFEST = "b".repeat(64);
const NOW = "2026-07-21T12:00:00.000Z";

function verification() {
  return [{
    id: "typecheck",
    executable: "npx",
    args: ["tsc", "--noEmit"],
    cwd: ".",
    timeoutMs: 120_000,
    network: "denied" as const,
    expectedExitCodes: [0],
  }];
}

function delegation(objective: string) {
  return {
    specVersion: "1" as const,
    objective,
    context: "Repository contracts are authoritative.",
    writeAllowlist: ["src/**", "tests/**"],
    forbiddenScope: [".git/**"],
    successCriteria: ["The named behavior is covered."],
    verification: verification(),
    executionMode: "edit" as const,
    timeoutMs: 600_000,
    producerPreferences: ["codex"],
    expectedOutput: "candidate-patch" as const,
  };
}

function validSpec(): AutopilotSpec {
  return {
    specVersion: "2",
    topic: "delegation-autopilot",
    base: { remote: "origin", branch: "main" },
    tasks: [
      {
        id: "contracts",
        commitMessage: "feat(runtime): add autopilot contracts",
        delegation: delegation("Add contracts"),
      },
      {
        id: "controller",
        commitMessage: "feat(runtime): add autopilot controller",
        delegation: delegation("Add controller"),
      },
    ],
    finalSuccessCriteria: ["The complete branch passes every release gate."],
    finalVerification: verification(),
  };
}

const branch: WorkflowBranchIdentity = {
  ownershipVersion: "1",
  workflowId: WORKFLOW_ID,
  checkoutPath: REPOSITORY,
  gitCommonDir: `${REPOSITORY}/.git`,
  repositoryIdentity: `${REPOSITORY}/.git`,
  worktreePath: "/state/worktrees/autopilot",
  worktreeGitDir: "/repo/.git/worktrees/autopilot",
  branch: "feat/delegation-autopilot-12345678",
  branchRef: "refs/heads/feat/delegation-autopilot-12345678",
  baseRef: `refs/claude-architect/autopilot/${WORKFLOW_ID}/base`,
  baseBranch: "main",
  baseCommitOid: BASE,
  remote: "origin",
  remoteUrl: "https://github.com/openai/claude-architect.git",
  ownerRepo: "openai/claude-architect",
};

function pipelineResult(args: {
  runId: string;
  base: string;
  commit: string;
  tree: string;
  manifest: string;
  status?: PipelineResult["status"];
  requiresHumanDecision?: boolean;
}): PipelineResult {
  return {
    runId: args.runId,
    status: args.status ?? "decision-ready",
    gate: { requiresHumanDecision: args.requiresHumanDecision ?? false },
    attempt: {
      candidate: {
        baseCommitOid: args.base,
        candidateCommitOid: args.commit,
        candidateTreeOid: args.tree,
        manifestHash: args.manifest,
        anchorRef: `refs/claude-architect/candidates/${args.runId}`,
        changedPaths: [],
        patch: "",
      },
    },
  } as unknown as PipelineResult;
}

function snapshotFor(result: PipelineResult): ReviewSnapshot {
  const candidate = result.attempt.candidate!;
  return {
    runId: result.runId,
    baseCommitOid: candidate.baseCommitOid,
    candidateCommitOid: candidate.candidateCommitOid,
    candidateTreeOid: candidate.candidateTreeOid,
    manifestHash: candidate.manifestHash,
    patch: "",
    changedPaths: [],
    evidence: {},
    executedVerification: [],
  };
}

function eligibilityFor(
  result: PipelineResult,
  eligible = true,
): AutopilotEligibilityRecord {
  const candidate = result.attempt.candidate!;
  return {
    recordVersion: "1",
    policyVersion: "1",
    runId: result.runId,
    eligible,
    reasons: eligible ? [] : ["advisor reported a major risk"],
    baseCommitOid: candidate.baseCommitOid,
    candidateCommitOid: candidate.candidateCommitOid,
    candidateTreeOid: candidate.candidateTreeOid,
    candidateManifestHash: candidate.manifestHash,
    reviewSnapshotHash: "c".repeat(64),
    pipelineResultHash: "d".repeat(64),
    advisorReportHash: "e".repeat(64),
    evaluatedAt: NOW,
  };
}

function resumedState(
  phase: "running-task" | "cleaning-up" | "ready-for-human-review",
): AutopilotWorkflowState {
  const reviewed = phase === "cleaning-up" || phase === "ready-for-human-review";
  const terminal = phase === "ready-for-human-review";
  return {
    stateVersion: "2",
    workflowId: WORKFLOW_ID,
    repositoryIdentity: branch.repositoryIdentity,
    baseCommitOid: BASE,
    workflowRef: branch.branchRef,
    worktreePath: branch.worktreePath,
    autopilotSpecHash: canonicalArtifactHash(validSpec()),
    revision: reviewed ? 8 : 3,
    phase,
    currentTaskIndex: reviewed ? 2 : 1,
    tasks: [{
      id: "contracts",
      runId: "run-contracts",
      candidateManifestHash: FIRST_MANIFEST,
      eligibilityHash: "6".repeat(64),
      promotionCommitOid: FIRST_COMMIT,
      status: "promoted",
    }, {
      id: "controller",
      runId: reviewed ? "run-controller" : null,
      candidateManifestHash: reviewed ? SECOND_MANIFEST : null,
      eligibilityHash: reviewed ? "7".repeat(64) : null,
      promotionCommitOid: reviewed ? SECOND_COMMIT : null,
      status: reviewed ? "promoted" : "running",
    }],
    intentJournal: {
      ref: "journal.ndjson",
      entryCount: 2,
      lastEntryHash: "8".repeat(64),
    },
    finalGate: reviewed ? {
      reportRef: "final-branch-report.json",
      reportHash: "9".repeat(64),
      headCommitOid: SECOND_COMMIT,
      eligibilityHash: "9".repeat(64),
    } : null,
    branch: branch.branch,
    cleanup: terminal ? {
      status: "succeeded",
      worktreeRemoved: true,
      lockReleased: true,
      error: null,
      completedAt: NOW,
    } : null,
    terminal: terminal ? {
      classification: "ready-for-human-review",
      reason: null,
      evidenceRefs: ["final-branch-report.json"],
      completedAt: NOW,
    } : null,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

class MemoryWorkflowStore implements WorkflowStorePort {
  state: AutopilotWorkflowState | null = null;
  readonly operations: string[];
  private recordedSpec: unknown = validSpec();
  private recordedBranch: WorkflowBranchIdentity | null = branch;
  private readonly intents = new Map<string, {
    operation: string;
    completion: unknown | null;
  }>();
  createError: Error | null = null;
  acquireLeaseError: Error | null = null;
  adoptLeaseError: Error | null = null;
  releaseLeaseError: Error | null = null;
  beginIntentError: Error | null = null;

  constructor(operations: string[]) {
    this.operations = operations;
    this.intents.set("workflow-spec", {
      operation: "record-workflow-spec",
      completion: {
        spec: structuredClone(this.recordedSpec),
        branch: structuredClone(this.recordedBranch),
      },
    });
  }

  seedCleanupIntent(headCommitOid: string, completed = false): void {
    this.intents.set(`cleanup:${headCommitOid}`, {
      operation: "cleanup-workflow-branch",
      completion: completed ? { worktreeRemoved: true, refsRemoved: true } : null,
    });
  }

  async create(initialState: AutopilotWorkflowState): Promise<AutopilotWorkflowState> {
    this.operations.push("persist:preflighting");
    if (this.createError !== null) throw this.createError;
    this.state = structuredClone(initialState);
    return structuredClone(this.state);
  }

  async acquireLease() {
    this.operations.push("lease:acquire");
    if (this.acquireLeaseError !== null) throw this.acquireLeaseError;
    return {} as Awaited<ReturnType<WorkflowStorePort["acquireLease"]>>;
  }

  async adoptLease() {
    this.operations.push("lease:adopt");
    if (this.adoptLeaseError !== null) throw this.adoptLeaseError;
    return {} as Awaited<ReturnType<WorkflowStorePort["adoptLease"]>>;
  }

  async releaseLease(): Promise<void> {
    this.operations.push("lease:release");
    if (this.releaseLeaseError !== null) throw this.releaseLeaseError;
  }

  async read(): Promise<AutopilotWorkflowState> {
    if (this.state === null) throw new Error("state not created");
    this.operations.push("read:state");
    return structuredClone(this.state);
  }

  async readIntentJournal() {
    this.operations.push("read:journal");
    return {
      entries: [],
      tornTail: false,
      intents: [...this.intents].map(([idempotencyKey, intent]) => ({
        intent: { operation: intent.operation, idempotencyKey },
        completion: intent.completion === null
          ? null
          : { completion: structuredClone(intent.completion) },
      })),
    } as unknown as Awaited<ReturnType<WorkflowStorePort["readIntentJournal"]>>;
  }

  async beginIntent(args: Parameters<WorkflowStorePort["beginIntent"]>[0]) {
    this.operations.push(`persist:intent:${args.idempotencyKey}`);
    if (this.beginIntentError !== null) throw this.beginIntentError;
    if (!this.intents.has(args.idempotencyKey)) {
      this.intents.set(args.idempotencyKey, {
        operation: args.operation,
        completion: null,
      });
    }
    return {} as Awaited<ReturnType<WorkflowStorePort["beginIntent"]>>;
  }

  async completeIntent(args: Parameters<WorkflowStorePort["completeIntent"]>[0]) {
    this.operations.push(`persist:completion:${args.idempotencyKey}`);
    const intent = this.intents.get(args.idempotencyKey);
    if (intent === undefined) throw new Error("intent not created");
    intent.completion = structuredClone(args.completion ?? null);
    if (args.idempotencyKey === "workflow-spec") {
      const completion = args.completion as {
        spec: unknown;
        branch?: WorkflowBranchIdentity;
      };
      this.recordedSpec = completion.spec;
      this.recordedBranch = completion.branch ?? null;
    }
    return {} as Awaited<ReturnType<WorkflowStorePort["completeIntent"]>>;
  }

  // The real store is compare-and-swap: it rejects a write whose
  // expectedRevision no longer matches. Ignoring it here meant every
  // state-mismatch guard in the controller was untested, and a regression that
  // transitioned from a stale snapshot would have stayed green.
  private assertExpectedRevision(expectedRevision: number | undefined): void {
    if (this.state === null) throw new Error("state not created");
    if (expectedRevision !== undefined && expectedRevision !== this.state.revision) {
      throw Object.assign(new Error("workflow revision conflict"), {
        classification: "workflow-revision-conflict",
      });
    }
  }

  async transition(args: Parameters<WorkflowStorePort["transition"]>[0]) {
    if (this.state === null) throw new Error("state not created");
    this.assertExpectedRevision(args.expectedRevision);
    this.operations.push(`persist:${args.to}`);
    const next = structuredClone(this.state);
    if (args.patch !== undefined) Object.assign(next, structuredClone(args.patch));
    args.update?.(next);
    next.phase = args.to;
    next.revision += 1;
    next.updatedAt = NOW;
    this.state = next;
    return structuredClone(next);
  }

  async update(args: Parameters<WorkflowStorePort["update"]>[0]) {
    if (this.state === null) throw new Error("state not created");
    this.assertExpectedRevision(args.expectedRevision);
    this.operations.push("persist:update");
    const next = structuredClone(this.state);
    if (args.patch !== undefined) Object.assign(next, structuredClone(args.patch));
    args.update?.(next);
    next.revision += 1;
    next.updatedAt = NOW;
    this.state = next;
    return structuredClone(next);
  }
}

function harness(overrides: {
  branchError?: Error & { classification?: string };
  branchIdentity?: WorkflowBranchIdentity;
  storeCreateError?: Error;
  storeAcquireLeaseError?: Error;
  storeAdoptLeaseError?: Error;
  storeReleaseLeaseError?: Error;
  beginIntentError?: Error;
  pipelineError?: Error & { classification?: string };
  snapshotError?: Error & { classification?: string };
  eligibilityError?: Error & { classification?: string };
  promotionError?: Error & { classification?: string };
  finalReviewError?: Error & { classification?: string };
  firstPipeline?: PipelineResult;
  snapshotMismatch?: boolean;
  eligibilityRed?: boolean;
  firstPromotion?: { status: "rejected"; classification: "apply-conflict" };
  finalReport?: {
    workflowId?: string;
    headCommitOid?: string;
    eligible?: boolean;
    reasons?: string[];
    status?: "ready-for-human-review" | "human-decision-required";
  };
  cleanup?: { ok: true; worktreeRemoved: boolean; refsRemoved: boolean }
    | { ok: false; classification: "cleanup-failed" };
  branchLoadMissing?: boolean;
  revalidation?: { ok: false; classification: "head-changed" };
  now?: () => string;
  lockReleaseError?: Error;
  decisionAuthority?: "autonomous" | "human";
  identityMissing?: boolean;
} = {}) {
  const events: string[] = [];
  const operations: string[] = [];
  const store = new MemoryWorkflowStore(operations);
  store.createError = overrides.storeCreateError ?? null;
  store.acquireLeaseError = overrides.storeAcquireLeaseError ?? null;
  store.adoptLeaseError = overrides.storeAdoptLeaseError ?? null;
  store.releaseLeaseError = overrides.storeReleaseLeaseError ?? null;
  store.beginIntentError = overrides.beginIntentError ?? null;
  const results = [
    overrides.firstPipeline ?? pipelineResult({
      runId: "run-contracts",
      base: BASE,
      commit: FIRST_COMMIT,
      tree: FIRST_TREE,
      manifest: FIRST_MANIFEST,
    }),
    pipelineResult({
      runId: "run-controller",
      base: FIRST_COMMIT,
      commit: SECOND_COMMIT,
      tree: SECOND_TREE,
      manifest: SECOND_MANIFEST,
    }),
  ];
  let pipelineIndex = 0;
  let promotionIndex = 0;

  const workflowId = vi.fn(() => WORKFLOW_ID);
  const lock = vi.fn(async (_workflowId: string, operation: () => Promise<unknown>) => {
    operations.push("lock");
    try {
      return await operation();
    } finally {
      operations.push("lock:released");
      if (overrides.lockReleaseError !== undefined) throw overrides.lockReleaseError;
    }
  });
  const createBranch = vi.fn(async () => {
    operations.push("side-effect:create-branch");
    if (overrides.branchError !== undefined) throw overrides.branchError;
    return overrides.branchIdentity ?? branch;
  });
  const runPipeline = vi.fn(async () => {
    operations.push(`side-effect:task:${pipelineIndex}`);
    if (overrides.pipelineError !== undefined) throw overrides.pipelineError;
    return results[pipelineIndex++]!;
  });
  const createSnapshot = vi.fn(async ({ pipelineResult: result }: {
    pipelineResult: PipelineResult;
  }) => {
    operations.push("side-effect:snapshot");
    if (overrides.snapshotError !== undefined) throw overrides.snapshotError;
    const snapshot = snapshotFor(result);
    if (overrides.snapshotMismatch === true) snapshot.manifestHash = "f".repeat(64);
    return snapshot;
  });
  const evaluate = vi.fn(async ({ pipelineResult: result }: {
    pipelineResult: PipelineResult;
  }) => {
    operations.push("side-effect:eligibility");
    if (overrides.eligibilityError !== undefined) throw overrides.eligibilityError;
    return eligibilityFor(result, !(overrides.eligibilityRed === true && pipelineIndex === 1));
  });
  const promote = vi.fn(async (request: { expectedHead: string }) => {
    operations.push(`side-effect:promote:${promotionIndex}`);
    if (overrides.promotionError !== undefined) throw overrides.promotionError;
    if (promotionIndex++ === 0 && overrides.firstPromotion !== undefined) {
      return overrides.firstPromotion;
    }
    return {
      status: "committed" as const,
      commitOid: request.expectedHead === BASE ? FIRST_COMMIT : SECOND_COMMIT,
    };
  });
  const finalReview = vi.fn(async () => {
    operations.push("side-effect:final-review");
    if (overrides.finalReviewError !== undefined) throw overrides.finalReviewError;
    return {
      reportVersion: "2" as const,
      workflowId: overrides.finalReport?.workflowId ?? WORKFLOW_ID,
      baseCommitOid: BASE,
      headCommitOid: overrides.finalReport?.headCommitOid ?? SECOND_COMMIT,
      branchArtifactHash: "6".repeat(64),
      verificationHash: "7".repeat(64),
      reviewHashes: ["8".repeat(64)],
      advisorHash: "9".repeat(64),
      taskEvidenceHashes: ["a".repeat(64), "b".repeat(64)],
      eligible: overrides.finalReport?.eligible ?? true,
      reasons: overrides.finalReport?.reasons ?? [],
      status: overrides.finalReport?.status ?? "ready-for-human-review",
      evaluatedAt: NOW,
    };
  });
  const cleanup = vi.fn(async () => {
    operations.push("side-effect:cleanup");
    return overrides.cleanup ?? { ok: true as const, worktreeRemoved: true, refsRemoved: true };
  });
  const loadBranch = vi.fn(async () => overrides.branchLoadMissing ? null : branch);
  const revalidate = vi.fn(async () => overrides.revalidation ?? ({ ok: true as const }));
  const repositoryIdentity = vi.fn(async () => branch.repositoryIdentity);

  const dependencies = {
    workflowId,
    now: overrides.now ?? (() => NOW),
    workflowLock: { runExclusive: lock },
    workflowStore: vi.fn(() => store),
    repositoryIdentity,
    branchManager: { create: createBranch, load: loadBranch, revalidate, cleanup },
    pipelineRunner: { run: runPipeline },
    reviewSnapshotter: { create: createSnapshot },
    eligibilityEvaluator: { evaluate },
    promoter: { promote },
    finalBranchReviewer: { review: finalReview },
    emit: (event: string) => { events.push(event); },
    decisionAuthority: () => overrides.decisionAuthority ?? "autonomous",
    commitIdentityAvailable: async () => overrides.identityMissing !== true,
  } as unknown as AutopilotControllerDependencies;

  return {
    controller: new AutopilotController(dependencies),
    events,
    operations,
    store,
    spies: {
      workflowId,
      lock,
      createBranch,
      runPipeline,
      createSnapshot,
      evaluate,
      promote,
      finalReview,
      cleanup,
      loadBranch,
      revalidate,
      repositoryIdentity,
      workflowStore: dependencies.workflowStore,
    },
  };
}

describe("AutopilotController start-through-hand-off", () => {
  it("promotes every task, final-reviews the branch, and hands it off without publishing", async () => {
    const run = harness();

    const result = await run.controller.start(REPOSITORY, validSpec());

    expect(result).toMatchObject({
      status: "ready-for-human-review",
      phase: "ready-for-human-review",
      currentTaskIndex: 2,
      headCommitOid: SECOND_COMMIT,
      branch: branch.branch,
      finalGate: { headCommitOid: SECOND_COMMIT },
      cleanup: { status: "succeeded", worktreeRemoved: true, lockReleased: true },
      terminal: { classification: "ready-for-human-review" },
    });
    expect(result).not.toHaveProperty("pullRequest");
    expect(result).not.toHaveProperty("shipping");
    expect(result.tasks.map(task => task.status)).toEqual(["promoted", "promoted"]);
    expect(run.events).toEqual([
      "preflight",
      "task:contracts",
      "promote:contracts",
      "task:controller",
      "promote:controller",
      "final-review",
      "cleanup",
      "ready",
    ]);
    expect(run.spies.promote.mock.calls[0]![0]).toMatchObject({ expectedHead: BASE });
    expect(run.spies.promote.mock.calls[1]![0]).toMatchObject({ expectedHead: FIRST_COMMIT });
    expect(run.spies.finalReview).toHaveBeenCalledWith(expect.objectContaining({
      workflowId: WORKFLOW_ID,
      expectedRevision: 5,
      checkoutPath: branch.worktreePath,
    }));
    // The reviewed branch is the hand-off, so cleanup must keep it.
    expect(run.spies.cleanup).toHaveBeenCalledWith(branch, SECOND_COMMIT, { retainBranch: true });

    expect(run.operations.indexOf("persist:running-task"))
      .toBeLessThan(run.operations.indexOf("side-effect:task:0"));
    expect(run.operations.indexOf("persist:promoting-task"))
      .toBeLessThan(run.operations.indexOf("side-effect:promote:0"));
    expect(run.operations.indexOf("side-effect:promote:0"))
      .toBeLessThan(run.operations.lastIndexOf("persist:running-task"));
    expect(run.operations.indexOf("side-effect:promote:1"))
      .toBeLessThan(run.operations.indexOf("persist:final-review"));
    expect(run.operations.indexOf("side-effect:final-review"))
      .toBeLessThan(run.operations.indexOf("persist:cleaning-up"));
    expect(run.operations.indexOf("persist:cleaning-up"))
      .toBeLessThan(run.operations.indexOf("side-effect:cleanup"));
    expect(run.operations.indexOf("side-effect:cleanup"))
      .toBeLessThan(run.operations.indexOf("lock:released"));
    expect(run.operations.indexOf("lock:released"))
      .toBeLessThan(run.operations.indexOf("persist:ready-for-human-review"));
  });

  it("rejects an invalid spec before invoking any collaborator", async () => {
    const run = harness();

    await expect(run.controller.start(REPOSITORY, {})).rejects.toMatchObject({
      classification: "invalid-spec",
      detail: { classification: "invalid-spec" },
    });

    for (const spy of Object.values(run.spies)) expect(spy).not.toHaveBeenCalled();
    expect(run.operations).toEqual([]);
  });

  it("refuses to start under the human decision authority before any side effect", async () => {
    const run = harness({ decisionAuthority: "human" });

    await expect(run.controller.start(REPOSITORY, validSpec())).rejects.toMatchObject({
      classification: "decision-authority-human",
    });

    expect(run.operations).toEqual([]);
    expect(run.spies.createBranch).not.toHaveBeenCalled();
  });

  it("refuses to start without a Git identity before any side effect", async () => {
    const run = harness({ identityMissing: true });

    await expect(run.controller.start(REPOSITORY, validSpec())).rejects.toMatchObject({
      classification: "git-identity-missing",
    });
    expect(run.operations).toEqual([]);
  });

  it("refuses to resume an active workflow under the human decision authority", async () => {
    const run = harness({ decisionAuthority: "human" });
    const state = resumedState("running-task");
    run.store.state = structuredClone(state);

    await expect(run.controller.resume(REPOSITORY, WORKFLOW_ID)).rejects.toMatchObject({
      classification: "decision-authority-human",
    });

    expect(run.store.state).toEqual(state);
    expect(run.operations).toEqual(["lock", "read:state", "lock:released"]);
    expect(run.spies.runPipeline).not.toHaveBeenCalled();
  });

  it("finishes an already-promoted workflow under the human decision authority", async () => {
    const run = harness({ decisionAuthority: "human" });
    run.store.state = resumedState("cleaning-up");

    await expect(run.controller.resume(REPOSITORY, WORKFLOW_ID)).resolves.toMatchObject({
      phase: "ready-for-human-review",
    });
    expect(run.spies.promote).not.toHaveBeenCalled();
  });

  it("halts on branch creation failure before persistence or a Producer", async () => {
    const error = Object.assign(new Error("branch failed"), {
      classification: "workflow-branch-create-failed",
    });
    const run = harness({ branchError: error });

    await expect(run.controller.start(REPOSITORY, validSpec())).rejects.toMatchObject({
      classification: "workflow-branch-create-failed",
    });

    expect(run.operations).toEqual([
      "lock",
      "side-effect:create-branch",
      "lock:released",
    ]);
    expect(run.spies.runPipeline).not.toHaveBeenCalled();
  });

  it("compensates an exact created branch when bootstrap persistence fails", async () => {
    const run = harness({ storeCreateError: new Error("state unavailable") });

    await expect(run.controller.start(REPOSITORY, validSpec())).rejects
      .toThrow("state unavailable");

    expect(run.spies.cleanup).toHaveBeenCalledWith(branch, BASE);
    expect(run.spies.runPipeline).not.toHaveBeenCalled();
    expect(run.spies.finalReview).not.toHaveBeenCalled();
  });

  it("halts a failed pipeline without snapshotting or promoting", async () => {
    const run = harness({
      firstPipeline: pipelineResult({
        runId: "run-contracts",
        base: BASE,
        commit: FIRST_COMMIT,
        tree: FIRST_TREE,
        manifest: FIRST_MANIFEST,
        status: "failed",
      }),
    });

    await expect(run.controller.start(REPOSITORY, validSpec())).rejects.toMatchObject({
      classification: "pipeline-failed",
    });

    expect(run.spies.runPipeline).toHaveBeenCalledTimes(1);
    expect(run.spies.createSnapshot).not.toHaveBeenCalled();
    expect(run.spies.promote).not.toHaveBeenCalled();
    expect(run.store.state).toMatchObject({ phase: "failed" });
    expect(run.store.state?.tasks[0]?.status).toBe("halted");
    expect(run.store.state?.tasks[1]?.status).toBe("pending");
  });

  it("halts when the pipeline requires a human decision", async () => {
    const run = harness({
      firstPipeline: pipelineResult({
        runId: "run-contracts",
        base: BASE,
        commit: FIRST_COMMIT,
        tree: FIRST_TREE,
        manifest: FIRST_MANIFEST,
        status: "human-decision-required",
        requiresHumanDecision: true,
      }),
    });

    await expect(run.controller.start(REPOSITORY, validSpec())).rejects.toMatchObject({
      classification: "human-decision-required",
    });

    expect(run.spies.runPipeline).toHaveBeenCalledTimes(1);
    expect(run.spies.createSnapshot).not.toHaveBeenCalled();
    expect(run.spies.promote).not.toHaveBeenCalled();
  });

  it("halts on red eligibility without invoking promotion", async () => {
    const run = harness({ eligibilityRed: true });

    await expect(run.controller.start(REPOSITORY, validSpec())).rejects.toMatchObject({
      classification: "eligibility-red",
    });

    expect(run.spies.runPipeline).toHaveBeenCalledTimes(1);
    expect(run.spies.evaluate).toHaveBeenCalledTimes(1);
    expect(run.spies.promote).not.toHaveBeenCalled();
  });

  it("halts on actual candidate evidence mismatch without evaluating later work", async () => {
    const run = harness({ snapshotMismatch: true });

    await expect(run.controller.start(REPOSITORY, validSpec())).rejects.toMatchObject({
      classification: "candidate-evidence-mismatch",
    });

    expect(run.spies.evaluate).not.toHaveBeenCalled();
    expect(run.spies.promote).not.toHaveBeenCalled();
    expect(run.spies.finalReview).not.toHaveBeenCalled();
  });

  it.each([
    ["producer-ineligible", "pipeline"],
    ["platform-ineligible", "pipeline"],
    ["review-red", "snapshot"],
    ["candidate-hash-mismatch", "snapshot"],
    ["advisor-red", "eligibility"],
    ["promotion-aborted", "promotion"],
    ["final-review-red", "final-review"],
  ] as const)(
    "halts on %s and invokes no operation after the first red transition",
    async (classification, stage) => {
      const error = Object.assign(new Error(classification), { classification });
      const run = harness({
        pipelineError: stage === "pipeline" ? error : undefined,
        snapshotError: stage === "snapshot" ? error : undefined,
        eligibilityError: stage === "eligibility" ? error : undefined,
        promotionError: stage === "promotion" ? error : undefined,
        finalReviewError: stage === "final-review" ? error : undefined,
      });

      await expect(run.controller.start(REPOSITORY, validSpec())).rejects.toMatchObject({
        classification,
      });

      const orderedCollaborators = [
        "pipeline",
        "snapshot",
        "eligibility",
        "promotion",
        "final-review",
        "cleanup",
      ] as const;
      const operationPrefix: Record<(typeof orderedCollaborators)[number], string> = {
        pipeline: "side-effect:task:",
        snapshot: "side-effect:snapshot",
        eligibility: "side-effect:eligibility",
        promotion: "side-effect:promote:",
        "final-review": "side-effect:final-review",
        cleanup: "side-effect:cleanup",
      };
      const redIndex = orderedCollaborators.indexOf(stage);
      for (const later of orderedCollaborators.slice(redIndex + 1)) {
        expect(
          run.operations.some(operation => operation.startsWith(operationPrefix[later])),
          `${later} ran after ${classification}`,
        ).toBe(false);
      }
    },
  );

  it("records cancellation and invokes no later operation", async () => {
    const cancelled = Object.assign(new Error("cancelled"), { classification: "cancelled" });
    const run = harness({ pipelineError: cancelled });

    await expect(run.controller.start(REPOSITORY, validSpec())).rejects.toMatchObject({
      classification: "cancelled",
    });

    expect(run.store.state).toMatchObject({
      phase: "cancelled",
      terminal: { classification: "cancelled", reason: "cancelled" },
    });
    expect(run.spies.createSnapshot).not.toHaveBeenCalled();
    expect(run.spies.promote).not.toHaveBeenCalled();
    expect(run.spies.finalReview).not.toHaveBeenCalled();
  });

  it("halts on promotion conflict without starting the next task", async () => {
    const run = harness({
      firstPromotion: { status: "rejected", classification: "apply-conflict" },
    });

    await expect(run.controller.start(REPOSITORY, validSpec())).rejects.toMatchObject({
      classification: "apply-conflict",
    });

    expect(run.spies.promote).toHaveBeenCalledTimes(1);
    expect(run.spies.runPipeline).toHaveBeenCalledTimes(1);
    expect(run.events).toEqual(["preflight", "task:contracts", "promote:contracts"]);
  });

  it("halts on a human-decision-required final report before cleanup", async () => {
    const run = harness({
      finalReport: {
        eligible: false,
        reasons: ["final verification failed"],
        status: "human-decision-required",
      },
    });

    await expect(run.controller.start(REPOSITORY, validSpec())).rejects.toMatchObject({
      classification: "human-decision-required",
    });

    expect(run.store.state).toMatchObject({
      phase: "human-decision-required",
      finalGate: { headCommitOid: SECOND_COMMIT },
    });
    expect(run.spies.cleanup).not.toHaveBeenCalled();
  });

  it("halts on a final report for a stale head before cleanup", async () => {
    const run = harness({ finalReport: { headCommitOid: FIRST_COMMIT } });

    await expect(run.controller.start(REPOSITORY, validSpec())).rejects.toMatchObject({
      classification: "stale-final-review",
    });

    expect(run.spies.cleanup).not.toHaveBeenCalled();
  });

  it("records cleanup failure and cannot produce the success terminal", async () => {
    const run = harness({ cleanup: { ok: false, classification: "cleanup-failed" } });

    await expect(run.controller.start(REPOSITORY, validSpec())).rejects.toMatchObject({
      classification: "cleanup-failed",
    });

    expect(run.spies.cleanup).toHaveBeenCalledTimes(1);
    expect(run.store.state).toMatchObject({
      phase: "failed",
      cleanup: {
        status: "failed",
        worktreeRemoved: false,
        lockReleased: true,
        error: "cleanup-failed",
      },
      terminal: { classification: "failed", reason: "cleanup-failed" },
    });
    expect(run.events).not.toContain("ready");
    expect(run.operations.indexOf("lock:released"))
      .toBeLessThan(run.operations.indexOf("persist:failed"));
  });

  it("rejects partial cleanup proof and cannot produce the success terminal", async () => {
    const run = harness({
      cleanup: { ok: true, worktreeRemoved: true, refsRemoved: false },
    });

    await expect(run.controller.start(REPOSITORY, validSpec())).rejects.toMatchObject({
      classification: "cleanup-failed",
    });

    expect(run.store.state).toMatchObject({
      phase: "failed",
      cleanup: { status: "failed", worktreeRemoved: true, lockReleased: true },
    });
    expect(run.events).not.toContain("ready");
  });

  it("records workflow-lock release failure after cleanup and cannot report success", async () => {
    const run = harness({ lockReleaseError: new Error("release failed") });

    await expect(run.controller.start(REPOSITORY, validSpec())).rejects.toMatchObject({
      classification: "workflow-lock-release-failed",
    });

    expect(run.store.state).toMatchObject({
      phase: "failed",
      cleanup: { status: "failed", lockReleased: false },
      terminal: { reason: "workflow-lock-release-failed" },
    });
    expect(run.events).not.toContain("ready");
  });

  it("returns redacted status using only read-only collaborators", async () => {
    const run = harness();
    run.store.state = resumedState("cleaning-up");

    const result = await run.controller.status(REPOSITORY, WORKFLOW_ID);

    expect(result).toMatchObject({
      workflowId: WORKFLOW_ID,
      repositoryIdentity: "[redacted]",
      worktreePath: "[redacted]",
      branch: branch.branch,
    });
    expect(run.operations).toEqual(["read:state"]);
    expect(run.spies.lock).not.toHaveBeenCalled();
    expect(run.spies.revalidate).not.toHaveBeenCalled();
    expect(run.spies.runPipeline).not.toHaveBeenCalled();
    expect(run.spies.cleanup).not.toHaveBeenCalled();
  });

  it("fails status identity validation without reading branch ownership or mutating", async () => {
    const run = harness();
    const state = resumedState("running-task");
    run.store.state = structuredClone(state);
    run.spies.repositoryIdentity.mockResolvedValue("/other/.git");

    await expect(run.controller.status(REPOSITORY, WORKFLOW_ID)).rejects.toMatchObject({
      classification: "repository-identity-mismatch",
    });

    expect(run.store.state).toEqual(state);
    expect(run.operations).toEqual(["read:state"]);
    expect(run.spies.loadBranch).not.toHaveBeenCalled();
    expect(run.spies.lock).not.toHaveBeenCalled();
  });

  it("resumes a workflow mid-task from the proven current head", async () => {
    const run = harness({
      firstPipeline: pipelineResult({
        runId: "run-controller",
        base: FIRST_COMMIT,
        commit: SECOND_COMMIT,
        tree: SECOND_TREE,
        manifest: SECOND_MANIFEST,
      }),
    });
    run.store.state = resumedState("running-task");

    const result = await run.controller.resume(REPOSITORY, WORKFLOW_ID);

    expect(result).toMatchObject({
      phase: "ready-for-human-review",
      currentTaskIndex: 2,
      branch: branch.branch,
    });
    expect(run.spies.runPipeline).toHaveBeenCalledTimes(1);
    expect(run.spies.promote).toHaveBeenCalledWith(expect.objectContaining({
      expectedHead: FIRST_COMMIT,
      runId: "run-controller",
    }));
    expect(run.spies.finalReview).toHaveBeenCalledTimes(1);
  });

  it("replays a promoting-task intent without rejecting an already-advanced head", async () => {
    const run = harness();
    const state = resumedState("running-task");
    state.phase = "promoting-task";
    state.tasks[1]!.runId = "run-controller";
    state.tasks[1]!.candidateManifestHash = SECOND_MANIFEST;
    state.tasks[1]!.eligibilityHash = "7".repeat(64);
    run.store.state = state;

    const result = await run.controller.resume(REPOSITORY, WORKFLOW_ID);

    expect(result).toMatchObject({ phase: "ready-for-human-review" });
    expect(run.spies.revalidate).not.toHaveBeenCalled();
    expect(run.spies.runPipeline).not.toHaveBeenCalled();
    expect(run.spies.promote).toHaveBeenCalledWith(expect.objectContaining({
      expectedHead: FIRST_COMMIT,
      runId: "run-controller",
    }));
  });

  it("fails closed when incomplete cleanup cannot be reproven", async () => {
    const run = harness({
      branchLoadMissing: true,
      cleanup: { ok: false, classification: "cleanup-failed" },
    });
    const state = resumedState("cleaning-up");
    run.store.state = state;
    run.store.seedCleanupIntent(SECOND_COMMIT);

    await expect(run.controller.resume(REPOSITORY, WORKFLOW_ID)).rejects.toMatchObject({
      classification: "cleanup-failed",
    });

    expect(run.spies.revalidate).not.toHaveBeenCalled();
    expect(run.spies.cleanup).toHaveBeenCalledWith(branch, SECOND_COMMIT, { retainBranch: true });
  });

  it("reuses durable cleanup proof without repeating cleanup", async () => {
    const run = harness({ branchLoadMissing: true });
    const state = resumedState("cleaning-up");
    run.store.state = state;
    run.store.seedCleanupIntent(SECOND_COMMIT, true);

    const result = await run.controller.resume(REPOSITORY, WORKFLOW_ID);

    expect(result).toMatchObject({ phase: "ready-for-human-review" });
    expect(run.spies.cleanup).not.toHaveBeenCalled();
  });

  it("returns an existing terminal result without new workflow side effects", async () => {
    const run = harness();
    const terminal = resumedState("ready-for-human-review");
    run.store.state = terminal;

    const result = await run.controller.resume(REPOSITORY, WORKFLOW_ID);

    expect(result).toEqual(terminal);
    expect(run.operations).toEqual(["lock", "read:state", "lock:released"]);
    expect(run.spies.loadBranch).not.toHaveBeenCalled();
    expect(run.spies.runPipeline).not.toHaveBeenCalled();
    expect(run.spies.cleanup).not.toHaveBeenCalled();
  });

  it("fails closed on resume repository identity mismatch without mutation", async () => {
    const run = harness();
    const state = resumedState("running-task");
    run.store.state = structuredClone(state);
    run.spies.repositoryIdentity.mockResolvedValue("/other/.git");

    await expect(run.controller.resume(REPOSITORY, WORKFLOW_ID)).rejects.toMatchObject({
      classification: "repository-identity-mismatch",
    });

    expect(run.store.state).toEqual(state);
    expect(run.operations).toEqual(["lock", "read:state", "lock:released"]);
    expect(run.spies.loadBranch).not.toHaveBeenCalled();
    expect(run.spies.runPipeline).not.toHaveBeenCalled();
  });
});

describe("AutopilotController workflow leases", () => {
  it("acquires immediately after workflow creation and releases after ready persistence", async () => {
    const run = harness();

    await run.controller.start(REPOSITORY, validSpec());

    const created = run.operations.indexOf("persist:preflighting");
    const acquired = run.operations.indexOf("lease:acquire");
    const terminal = run.operations.indexOf("persist:ready-for-human-review");
    const released = run.operations.indexOf("lease:release");
    expect(acquired).toBe(created + 1);
    expect(terminal).toBeLessThan(released);
    expect(run.operations.filter(operation => operation === "lease:release")).toHaveLength(1);
  });

  it("adopts the prior dead owner's lease before resuming and releases after terminal persistence", async () => {
    const run = harness({
      firstPipeline: pipelineResult({
        runId: "run-controller",
        base: FIRST_COMMIT,
        commit: SECOND_COMMIT,
        tree: SECOND_TREE,
        manifest: SECOND_MANIFEST,
      }),
    });
    run.store.state = resumedState("running-task");

    await run.controller.resume(REPOSITORY, WORKFLOW_ID);

    expect(run.operations.indexOf("lease:adopt"))
      .toBeLessThan(run.operations.indexOf("read:journal"));
    expect(run.operations.indexOf("persist:ready-for-human-review"))
      .toBeLessThan(run.operations.indexOf("lease:release"));
  });

  it("refuses to resume when the recorded lease owner is still alive", async () => {
    const leaseConflict = Object.assign(new Error("workflow owner is still active"), {
      classification: "workflow-lease-conflict",
    });
    const run = harness({ storeAdoptLeaseError: leaseConflict });
    const state = resumedState("running-task");
    run.store.state = structuredClone(state);

    await expect(run.controller.resume(REPOSITORY, WORKFLOW_ID)).rejects.toBe(leaseConflict);

    expect(run.store.state).toEqual(state);
    expect(run.operations).toEqual([
      "lock",
      "read:state",
      "lease:adopt",
      "lock:released",
    ]);
    expect(run.spies.loadBranch).not.toHaveBeenCalled();
    expect(run.spies.runPipeline).not.toHaveBeenCalled();
  });

  it("releases only after a halt transition is durably persisted", async () => {
    const run = harness({
      firstPipeline: pipelineResult({
        runId: "run-contracts",
        base: BASE,
        commit: FIRST_COMMIT,
        tree: FIRST_TREE,
        manifest: FIRST_MANIFEST,
        status: "failed",
      }),
    });

    await expect(run.controller.start(REPOSITORY, validSpec())).rejects.toMatchObject({
      classification: "pipeline-failed",
    });

    expect(run.operations.indexOf("persist:failed"))
      .toBeLessThan(run.operations.indexOf("lease:release"));
  });

  it("releases only after persisting a finish-cleanup failure", async () => {
    const run = harness({ lockReleaseError: new Error("release failed") });

    await expect(run.controller.start(REPOSITORY, validSpec())).rejects.toMatchObject({
      classification: "workflow-lock-release-failed",
    });

    expect(run.operations.indexOf("persist:failed"))
      .toBeLessThan(run.operations.indexOf("lease:release"));
  });

  it("persists bootstrap failure before releasing its acquired lease", async () => {
    const bootstrapError = Object.assign(new Error("journal unavailable"), {
      classification: "workflow-journal-persistence-failed",
    });
    const run = harness({ beginIntentError: bootstrapError });

    await expect(run.controller.start(REPOSITORY, validSpec())).rejects.toBe(bootstrapError);

    expect(run.store.state).toMatchObject({
      phase: "failed",
      terminal: {
        classification: "failed",
        reason: "workflow-journal-persistence-failed",
      },
    });
    expect(run.operations.indexOf("persist:failed"))
      .toBeLessThan(run.operations.indexOf("lease:release"));
    expect(run.spies.cleanup).toHaveBeenCalledWith(branch, BASE);
  });
});
