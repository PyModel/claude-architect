import { describe, expect, it, vi } from "vitest";
import {
  CandidatePromoter,
  type PromotionRequest,
} from "../../../src/autopilot/candidate-promoter.js";
import {
  advisorReportHash,
  autopilotEligibilityRecordHash,
  pipelineResultHash,
} from "../../../src/autopilot/autopilot-eligibility.js";
import { manifestHashOf } from "../../../src/git/changed-path-manifest.js";
import { reviewSnapshotHash } from "../../../src/runtime/review-snapshot.js";
import type { WorkflowBranchManager } from "../../../src/autopilot/branch-manager.js";
import type { WorkflowStore } from "../../../src/autopilot/workflow-store.js";
import type { ArtifactStore } from "../../../src/runtime/artifact-store.js";
import type { PlatformServices } from "../../../src/platform/platform-services.js";
import type { GitResult } from "../../../src/git/git-exec.js";
import { RuntimeError } from "../../../src/util/errors.js";
import { logger } from "../../../src/util/logger.js";

const baseOid = "a".repeat(40);
const candidateOid = "b".repeat(40);
const treeOid = "c".repeat(40);
const commitOid = "d".repeat(40);
const changedPaths = [{
  path: "a.txt",
  changeType: "modified" as const,
  mode: "100644",
  contentHash: "e".repeat(64),
}];
const manifestHash = manifestHashOf(changedPaths);
const workflowId = "workflow-12345678";
const runId = "run-promotion";
const checkout = "/repo/workflow";
const workflowRef = "refs/heads/autopilot/workflow-12345678";
const anchorRef = `refs/claude-architect/candidates/${runId}`;
const message = "feat(runtime): promote exact candidate";

function ok(stdout = ""): GitResult {
  return { exitCode: 0, stdout, stderr: "" };
}

function fixture(options: {
  eligibilityReadFails?: boolean;
  eligible?: boolean;
  beginCrashOnce?: boolean;
  crashAfterStageOnce?: boolean;
  crashAfterCommitTreeOnce?: boolean;
  completionCrashOnce?: "before-durable" | "after-durable";
  anchorDeleteFailsOnce?: boolean;
  lockReleaseFailsOnce?: boolean;
  pipelineMismatch?: boolean;
  reviewMismatch?: boolean;
  advisorMismatch?: boolean;
  untrackedDrift?: boolean;
  workflowDrift?: boolean;
  repositoryIdentityDrift?: boolean;
  missingBranchIdentity?: boolean;
  checkoutLocked?: boolean;
  mergeCommitParents?: boolean;
  identityMissing?: boolean;
  stageConflicts?: boolean;
  decisionAuthority?: "autonomous" | "human";
} = {}) {
  const events: string[] = [];
  const artifact = {
    baseCommitOid: baseOid,
    candidateCommitOid: candidateOid,
    candidateTreeOid: treeOid,
    anchorRef,
    manifestHash,
    changedPaths,
    patch: "patch",
  };
  const pipelineResult = { status: "decision-ready", marker: "pipeline" };
  const reviewSnapshot = {
    runId,
    baseCommitOid: baseOid,
    candidateCommitOid: candidateOid,
    candidateTreeOid: treeOid,
    manifestHash,
    patch: "patch",
    changedPaths,
    evidence: {},
    executedVerification: [],
  };
  const advisor = { verdict: "approve", marker: "advisor" };
  const eligibility = {
    recordVersion: "1" as const,
    policyVersion: "1" as const,
    runId,
    eligible: options.eligible ?? true,
    reasons: options.eligible === false ? ["advisor reported coverage gaps"] : [],
    baseCommitOid: baseOid,
    candidateCommitOid: candidateOid,
    candidateTreeOid: treeOid,
    candidateManifestHash: manifestHash,
    reviewSnapshotHash: reviewSnapshotHash(reviewSnapshot),
    pipelineResultHash: pipelineResultHash(pipelineResult as never),
    advisorReportHash: advisorReportHash(advisor as never),
    evaluatedAt: "2026-07-20T12:00:00.000Z",
  };
  const eligibilityHash = autopilotEligibilityRecordHash(eligibility);
  let decision: null | {
    decisionVersion: "2";
    decision: "accepted";
    authority: "autopilot-policy";
    candidateManifestHash: string;
    evidenceHash: string;
    policyVersion: "1";
    recordedAt: string;
  } = null;
  const workflow = {
    revision: 7,
    workflowId,
    phase: "promoting-task",
    worktreePath: checkout,
    workflowRef,
    repositoryIdentity: "/repo/.git",
    currentTaskIndex: 0,
    tasks: [{
      id: "task-1",
      runId,
      candidateManifestHash: manifestHash,
      eligibilityHash,
    }],
  };
  let journalCompletion: null | {
    completion: unknown;
    failure: unknown;
  } = null;
  let beginCrash = options.beginCrashOnce ?? false;
  let durableIntentIdentities: unknown = null;
  let completionCrash = options.completionCrashOnce;
  const workflowStore = {
    read: vi.fn().mockResolvedValue(workflow),
    withLockedState: vi.fn().mockImplementation(async (
      _revision: number,
      operation: (state: typeof workflow) => Promise<unknown>,
    ) => operation(options.workflowDrift ? { ...workflow, phase: "final-review" } : workflow)),
    beginIntent: vi.fn().mockImplementation(async (args: { expectedIdentities: unknown }) => {
      if (durableIntentIdentities !== null
        && JSON.stringify(durableIntentIdentities) !== JSON.stringify(args.expectedIdentities)) {
        throw new Error("workflow intent conflict");
      }
      durableIntentIdentities = args.expectedIdentities;
      if (beginCrash) {
        beginCrash = false;
        throw new Error("crashed after durable intent append");
      }
      return { completion: journalCompletion };
    }),
    completeIntent: vi.fn().mockImplementation(async (args: {
      completion?: unknown;
      failure?: unknown;
    }) => {
      if (completionCrash === "before-durable") {
        completionCrash = undefined;
        throw new Error("crashed before durable completion append");
      }
      journalCompletion = {
        completion: args.completion ?? null,
        failure: args.failure ?? null,
      };
      events.push("journal-complete");
      if (completionCrash === "after-durable") {
        completionCrash = undefined;
        throw new Error("crashed after durable completion append");
      }
      return { completion: journalCompletion };
    }),
  };
  const artifactStore = {
    readResult: vi.fn().mockResolvedValue({ runId, status: "verified-candidate", candidate: artifact }),
    readManifest: vi.fn().mockResolvedValue({
      runId, repoRoot: checkout, baseCommitOid: baseOid, candidateManifestHash: manifestHash,
    }),
    readPipelineArtifact: vi.fn().mockResolvedValue(options.pipelineMismatch
      ? { ...pipelineResult, marker: "substituted" }
      : pipelineResult),
    readReviewSnapshot: vi.fn().mockResolvedValue(options.reviewMismatch
      ? { ...reviewSnapshot, patch: "substituted" }
      : reviewSnapshot),
    readAdvisorReport: vi.fn().mockResolvedValue(options.advisorMismatch
      ? { ...advisor, marker: "substituted" }
      : advisor),
    readAutopilotEligibility: options.eligibilityReadFails
      ? vi.fn().mockRejectedValue(new Error("hash mismatch"))
      : vi.fn().mockResolvedValue(eligibility),
    readCandidateDecision: vi.fn().mockImplementation(async () => decision),
    writeAutopilotDecision: vi.fn().mockImplementation(async () => {
      decision = {
        decisionVersion: "2",
        decision: "accepted",
        authority: "autopilot-policy",
        candidateManifestHash: manifestHash,
        evidenceHash: eligibilityHash,
        policyVersion: "1",
        recordedAt: "2026-07-20T12:01:00.000Z",
      };
    }),
  };
  let head = baseOid;
  let indexTree = options.untrackedDrift || options.repositoryIdentityDrift ? treeOid : baseOid;
  let anchorExists = true;
  let anchorDeleteFails = options.anchorDeleteFailsOnce ?? false;
  let crashAfterCommitTree = options.crashAfterCommitTreeOnce ?? false;
  const runGit = vi.fn(async (_cwd: string, args: string[]): Promise<GitResult> => {
    if (args[0] === "rev-parse" && args[2] === "HEAD") return ok(`${head}\n`);
    if (args[0] === "rev-parse" && args.at(-1) === anchorRef) {
      return anchorExists
        ? ok(`${candidateOid}\n`)
        : { exitCode: 1, stdout: "", stderr: "" };
    }
    if (args[0] === "rev-parse" && args[2]?.endsWith("^{tree}")) return ok(`${treeOid}\n`);
    if (args[0] === "rev-parse" && args[2]?.endsWith("^")) return ok(`${baseOid}\n`);
    if (args[0] === "rev-list" && args[1] === "--parents") {
      // A real single-parent commit prints "<commit> <parent>"; the merge case
      // prints a second parent, which promotion must refuse.
      return ok(options.mergeCommitParents
        ? `${args.at(-1)} ${baseOid} ${treeOid}\n`
        : `${args.at(-1)} ${baseOid}\n`);
    }
    if (args[0] === "log") return ok(`${message}\n`);
    if (args[0] === "write-tree") return ok(`${indexTree}\n`);
    if (args[0] === "symbolic-ref") return ok(`${workflowRef}\n`);
    if (args[0] === "var") {
      return options.identityMissing
        ? { exitCode: 128, stdout: "", stderr: "fatal: unable to auto-detect email address" }
        : ok("Jo Doe <jo@example.invalid> 1780000000 +0200\n");
    }
    if (args[0] === "commit-tree") {
      if (crashAfterCommitTree) {
        crashAfterCommitTree = false;
        throw new Error("crashed after deterministic commit creation");
      }
      return ok(`${commitOid}\n`);
    }
    if (args[0] === "update-ref" && args.includes("-d")) {
      if (anchorDeleteFails) {
        anchorDeleteFails = false;
        return { exitCode: 1, stdout: "", stderr: "simulated crash" };
      }
      anchorExists = false;
      events.push("anchor-delete");
      return ok();
    }
    if (args[0] === "update-ref") {
      head = commitOid;
      return ok();
    }
    if (args[0] === "diff") return ok();
    if (args[0] === "status") {
      const stagedStatus = head === commitOid ? "" : indexTree === treeOid ? "M  a.txt\0" : "";
      return ok(options.untrackedDrift ? `${stagedStatus}?? surprise.txt\0` : stagedStatus);
    }
    if (args[0] === "show-ref") {
      if (args.at(-1) === workflowRef) return ok(`${head} ${workflowRef}\n`);
    }
    return ok();
  });
  const branchManager = {
    load: vi.fn().mockResolvedValue(options.missingBranchIdentity ? null : {
      workflowId, worktreePath: checkout, branchRef: workflowRef,
      repositoryIdentity: "/repo/.git",
    }),
    revalidateUnderLock: vi.fn().mockImplementation(async () => options.untrackedDrift
      ? { ok: false, classification: "dirty-worktree" }
      : { ok: true }),
    revalidateForStagedPromotionUnderLock: vi.fn().mockImplementation(async (
      _identity: unknown,
      _expectedHead: string,
      lock: { repositoryIdentity: string },
    ) => lock.repositoryIdentity === "/repo/.git"
      ? { ok: true }
      : { ok: false, classification: "repository-identity-changed" }),
  };
  let lockReleaseFails = options.lockReleaseFailsOnce ?? false;
  const platformServices = {
    acquireCheckoutLock: options.checkoutLocked
      ? vi.fn().mockRejectedValue(new RuntimeError("checkout is locked: /repo", { key: "checkout", classification: "lock-contended" }))
      : vi.fn().mockResolvedValue({
      key: "checkout",
      repositoryIdentity: options.repositoryIdentityDrift ? "/other/.git" : "/repo/.git",
      release: vi.fn(async () => {
        if (lockReleaseFails) {
          lockReleaseFails = false;
          throw new Error("crashed after anchor deletion");
        }
      }),
    }),
  };
  let crashAfterStage = options.crashAfterStageOnce ?? false;
  const stageCandidate = vi.fn().mockImplementation(async () => {
    indexTree = treeOid;
    if (crashAfterStage) {
      crashAfterStage = false;
      throw new Error("crashed after staging candidate bytes");
    }
    if (options.stageConflicts) {
      return { integration: "conflicted" as const, detail: "candidate tree conflicted" };
    }
    return {
      integration: "applied" as const, detail: "candidate tree applied",
    };
  });
  const promoter = new CandidatePromoter({
    git: runGit,
    workflowStore: () => workflowStore as unknown as WorkflowStore,
    artifactStore: () => artifactStore as unknown as ArtifactStore,
    branchManager: branchManager as unknown as WorkflowBranchManager,
    platformServices: platformServices as unknown as PlatformServices,
    stageCandidate,
    now: () => "2026-07-20T12:01:00.000Z",
    decisionAuthority: () => options.decisionAuthority ?? "autonomous",
  });
  const request: PromotionRequest = {
    workflowId, runId, workflowCheckoutPath: checkout, expectedHead: baseOid,
    expectedArtifactHash: manifestHash, commitMessage: message,
  };
  return {
    promoter, request, events, workflowStore, artifactStore, stageCandidate, runGit, branchManager,
  };
}

describe("CandidatePromoter", () => {
  it("commits the exact eligible tree and deletes the anchor only after completion", async () => {
    const f = fixture();

    await expect(f.promoter.promote(f.request)).resolves.toEqual({
      status: "committed", commitOid,
    });
    expect(f.events).toEqual(["journal-complete", "anchor-delete"]);
    expect(f.artifactStore.writeAutopilotDecision).toHaveBeenCalledOnce();
    expect(f.stageCandidate).toHaveBeenCalledOnce();
  });

  // The caller-supplied hash and head are what stop a promoter from committing
  // bytes the decision never covered, and every other case in this file passes
  // matching values -- so a regression that dropped either comparison would
  // have left the whole suite green.
  it("refuses a promotion whose expected artifact hash does not match", async () => {
    const f = fixture();

    await expect(f.promoter.promote({
      ...f.request,
      expectedArtifactHash: `${"0".repeat(63)}1`,
    })).resolves.toMatchObject({ status: "rejected" });
  });

  it("refuses a promotion whose expected head does not match", async () => {
    const f = fixture();

    await expect(f.promoter.promote({
      ...f.request,
      expectedHead: `${"0".repeat(39)}1`,
    })).resolves.toMatchObject({ status: "rejected" });
  });

  // `<commit>^` walks the FIRST parent only, so a merge whose first parent is
  // the expected head, whose tree matches, and whose message matches would pass
  // a first-parent check. Promotion must pin the parent count instead.
  it("refuses a promotion commit that has more than one parent", async () => {
    const f = fixture({ mergeCommitParents: true });

    await expect(f.promoter.promote(f.request)).resolves.toEqual({
      status: "rejected", classification: "commit-proof-failed",
    });
    expect(f.runGit.mock.calls.filter(([, args]) =>
      args[0] === "update-ref" && !args.includes("-d"))).toHaveLength(0);
    expect(f.runGit.mock.calls.filter(([, args]) =>
      args[0] === "update-ref" && args.includes("-d"))).toHaveLength(0);
  });

  it("commits the promotion under the user's identity, never the runtime's", async () => {
    const f = fixture();

    await expect(f.promoter.promote(f.request)).resolves.toEqual({
      status: "committed", commitOid,
    });

    const identityReads = f.runGit.mock.calls.filter(([, args]) => args[0] === "var");
    expect(identityReads.map(([, args, options]) => [args, options])).toEqual([
      [["var", "GIT_AUTHOR_IDENT"], { userIdentity: true }],
      [["var", "GIT_COMMITTER_IDENT"], { userIdentity: true }],
    ]);
    const commitTree = f.runGit.mock.calls.find(([, args]) => args[0] === "commit-tree");
    expect(commitTree?.[2]).toEqual({
      env: {
        GIT_AUTHOR_NAME: "Jo Doe",
        GIT_AUTHOR_EMAIL: "jo@example.invalid",
        GIT_AUTHOR_DATE: "1780000000 +0200",
        GIT_COMMITTER_NAME: "Jo Doe",
        GIT_COMMITTER_EMAIL: "jo@example.invalid",
        GIT_COMMITTER_DATE: "1780000000 +0200",
      },
    });
  });

  it("records no acceptance under the human decision authority", async () => {
    const f = fixture({ decisionAuthority: "human" });

    await expect(f.promoter.promote(f.request)).resolves.toEqual({
      status: "rejected", classification: "human-decision-required",
    });
    expect(f.stageCandidate).not.toHaveBeenCalled();
    expect(f.artifactStore.writeAutopilotDecision).not.toHaveBeenCalled();
    expect(f.runGit).not.toHaveBeenCalled();
  });

  it("records the acceptance only after the exact bytes are staged", async () => {
    const conflicted = fixture({ stageConflicts: true });
    await expect(conflicted.promoter.promote(conflicted.request)).resolves.toEqual({
      status: "rejected", classification: "human-decision-required",
    });
    expect(conflicted.stageCandidate).toHaveBeenCalledOnce();
    expect(conflicted.artifactStore.writeAutopilotDecision).not.toHaveBeenCalled();

    const applied = fixture();
    await applied.promoter.promote(applied.request);
    expect(applied.stageCandidate.mock.invocationCallOrder[0]!)
      .toBeLessThan(applied.artifactStore.writeAutopilotDecision.mock.invocationCallOrder[0]!);
  });

  it("refuses to promote without a configured Git identity", async () => {
    const f = fixture({ identityMissing: true });

    await expect(f.promoter.promote(f.request)).resolves.toEqual({
      status: "rejected", classification: "git-identity-missing",
    });
    expect(f.runGit.mock.calls.filter(([, args]) => args[0] === "commit-tree")).toHaveLength(0);
  });

  it("recovers an intent whose durable append crashed before promotion began", async () => {
    const f = fixture({ beginCrashOnce: true });

    await expect(f.promoter.promote(f.request)).resolves.toEqual({
      status: "rejected", classification: "journal-failed",
    });
    await expect(f.promoter.promote(f.request)).resolves.toEqual({
      status: "committed", commitOid,
    });

    expect(f.stageCandidate).toHaveBeenCalledOnce();
    expect(f.runGit.mock.calls.filter(([, args]) => args[0] === "commit-tree")).toHaveLength(1);
    expect(f.events).toEqual(["journal-complete", "anchor-delete"]);
  });

  it("recovers byte-identical staged state without staging or committing twice", async () => {
    const f = fixture({ crashAfterStageOnce: true });

    await expect(f.promoter.promote(f.request)).rejects.toThrow(
      "crashed after staging candidate bytes",
    );
    await expect(f.promoter.promote(f.request)).resolves.toEqual({
      status: "committed", commitOid,
    });

    expect(f.stageCandidate).toHaveBeenCalledOnce();
    expect(f.runGit.mock.calls.filter(([, args]) => args[0] === "commit-tree")).toHaveLength(1);
    expect(f.events).toEqual(["journal-complete", "anchor-delete"]);
  });

  it("recreates the same deterministic commit after a commit-tree crash", async () => {
    const f = fixture({ crashAfterCommitTreeOnce: true });

    await expect(f.promoter.promote(f.request)).rejects.toThrow(
      "crashed after deterministic commit creation",
    );
    await expect(f.promoter.promote(f.request)).resolves.toEqual({
      status: "committed", commitOid,
    });

    const commitTreeCalls = f.runGit.mock.calls.filter(([, args]) => args[0] === "commit-tree");
    expect(commitTreeCalls).toHaveLength(2);
    expect(commitTreeCalls[0]?.[1]).toEqual(commitTreeCalls[1]?.[1]);
    expect(f.events).toEqual(["journal-complete", "anchor-delete"]);
  });

  it.each([
    ["before", "before-durable", 2],
    ["after", "after-durable", 1],
  ] as const)(
    "recovers when completion journaling crashes %s its durable append",
    async (_label, completionCrashOnce, expectedCompletionCalls) => {
      const f = fixture({ completionCrashOnce });

      await expect(f.promoter.promote(f.request)).resolves.toEqual({
        status: "rejected", classification: "journal-failed",
      });
      await expect(f.promoter.promote(f.request)).resolves.toEqual({
        status: "committed", commitOid,
      });

      expect(f.workflowStore.completeIntent).toHaveBeenCalledTimes(expectedCompletionCalls);
      expect(f.stageCandidate).toHaveBeenCalledOnce();
      expect(f.runGit.mock.calls.filter(([, args]) => args[0] === "commit-tree")).toHaveLength(1);
      expect(f.runGit.mock.calls.filter(([, args]) =>
        args[0] === "update-ref" && !args.includes("-d"))).toHaveLength(1);
      expect(f.events).toEqual(["journal-complete", "anchor-delete"]);
    },
  );

  it("recovers a completed journal when anchor cleanup did not finish", async () => {
    const f = fixture({ anchorDeleteFailsOnce: true });

    await expect(f.promoter.promote(f.request)).resolves.toEqual({
      status: "rejected", classification: "anchor-deletion-failed",
    });
    await expect(f.promoter.promote(f.request)).resolves.toEqual({
      status: "committed", commitOid,
    });

    expect(f.workflowStore.completeIntent).toHaveBeenCalledOnce();
    expect(f.runGit.mock.calls.filter(([, args]) => args[0] === "commit-tree")).toHaveLength(1);
    expect(f.events).toEqual(["journal-complete", "anchor-delete"]);
  });

  it("recovers after anchor cleanup when the checkout lock release crashes", async () => {
    const f = fixture({ lockReleaseFailsOnce: true });
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});

    await expect(f.promoter.promote(f.request)).resolves.toEqual({
      status: "committed", commitOid,
    });
    await expect(f.promoter.promote(f.request)).resolves.toEqual({
      status: "committed", commitOid,
    });

    expect(f.workflowStore.completeIntent).toHaveBeenCalledOnce();
    expect(f.runGit.mock.calls.filter(([, args]) => args[0] === "commit-tree")).toHaveLength(1);
    expect(f.events).toEqual(["journal-complete", "anchor-delete"]);
    expect(warn).toHaveBeenCalledWith(
      "checkout lock release failed after candidate promotion",
      expect.objectContaining({
        event: "checkout-lock-release-failed",
        workflowId,
        reason: expect.stringContaining("crashed after anchor deletion"),
      }),
    );
  });

  it("fails closed when a journaled commit no longer proves the workflow branch", async () => {
    const f = fixture({ completionCrashOnce: "after-durable" });
    await expect(f.promoter.promote(f.request)).resolves.toEqual({
      status: "rejected", classification: "journal-failed",
    });
    f.branchManager.revalidateUnderLock.mockResolvedValueOnce({
      ok: false, classification: "branch-changed",
    });

    await expect(f.promoter.promote(f.request)).resolves.toEqual({
      status: "rejected", classification: "human-decision-required",
    });
    expect(f.events).toEqual(["journal-complete"]);
  });

  it.each([
    ["hash-mismatched durable evidence", { eligibilityReadFails: true }, "evidence-mismatch"],
    ["red durable eligibility", { eligible: false }, "eligibility-red"],
    ["substituted pipeline result", { pipelineMismatch: true }, "evidence-mismatch"],
    ["substituted review snapshot", { reviewMismatch: true }, "evidence-mismatch"],
    ["substituted advisor report", { advisorMismatch: true }, "evidence-mismatch"],
  ] as const)("rejects %s without staging", async (_label, options, classification) => {
    const f = fixture(options);

    await expect(f.promoter.promote(f.request)).resolves.toEqual({
      status: "rejected", classification,
    });
    expect(f.stageCandidate).not.toHaveBeenCalled();
  });

  it("requires a human decision for staged recovery with untracked bytes", async () => {
    const f = fixture({ untrackedDrift: true });

    await expect(f.promoter.promote(f.request)).resolves.toEqual({
      status: "rejected", classification: "human-decision-required",
    });

    expect(f.stageCandidate).not.toHaveBeenCalled();
    expect(f.artifactStore.writeAutopilotDecision).not.toHaveBeenCalled();
    expect(f.workflowStore.completeIntent).not.toHaveBeenCalled();
    expect(f.runGit.mock.calls.filter(([, args]) => args[0] === "commit-tree")).toHaveLength(0);
    expect(f.runGit.mock.calls.filter(([, args]) =>
      args[0] === "update-ref" && !args.includes("-d"))).toHaveLength(0);
  });

  it("rejects staged recovery on repository identity drift before mutation", async () => {
    const f = fixture({ repositoryIdentityDrift: true });

    await expect(f.promoter.promote(f.request)).resolves.toEqual({
      status: "rejected", classification: "human-decision-required",
    });

    expect(f.artifactStore.writeAutopilotDecision).not.toHaveBeenCalled();
    expect(f.stageCandidate).not.toHaveBeenCalled();
    expect(f.runGit.mock.calls.filter(([, args]) => args[0] === "commit-tree")).toHaveLength(0);
    expect(f.runGit.mock.calls.filter(([, args]) => args[0] === "update-ref")).toHaveLength(0);
  });

  it("does not accept a candidate before branch identity is available", async () => {
    const f = fixture({ missingBranchIdentity: true });

    await expect(f.promoter.promote(f.request)).resolves.toEqual({
      status: "rejected", classification: "branch-identity-changed",
    });
    expect(f.artifactStore.writeAutopilotDecision).not.toHaveBeenCalled();
  });

  it("reports checkout contention as busy, not as a branch identity change", async () => {
    const f = fixture({ checkoutLocked: true });

    await expect(f.promoter.promote(f.request)).resolves.toEqual({
      status: "rejected", classification: "checkout-busy",
    });
    expect(f.stageCandidate).not.toHaveBeenCalled();
    expect(f.artifactStore.writeAutopilotDecision).not.toHaveBeenCalled();
  });

  it("revalidates workflow authorization under its writer lease", async () => {
    const f = fixture({ workflowDrift: true });

    await expect(f.promoter.promote(f.request)).resolves.toEqual({
      status: "rejected", classification: "human-decision-required",
    });
    expect(f.stageCandidate).not.toHaveBeenCalled();
    expect(f.workflowStore.completeIntent).not.toHaveBeenCalled();
    expect(f.artifactStore.writeAutopilotDecision).not.toHaveBeenCalled();
  });

  it("updates the direct workflow ref with an expected old value", async () => {
    const f = fixture();
    await expect(f.promoter.promote(f.request)).resolves.toEqual({
      status: "committed", commitOid,
    });

    expect(f.runGit).toHaveBeenCalledWith(checkout, [
      "update-ref", "--no-deref", workflowRef, commitOid, baseOid,
    ]);
  });

  it("binds retries to the original commit message", async () => {
    const f = fixture({ beginCrashOnce: true });
    await expect(f.promoter.promote(f.request)).resolves.toEqual({
      status: "rejected", classification: "journal-failed",
    });

    await expect(f.promoter.promote({
      ...f.request,
      commitMessage: "feat(runtime): different safe message",
    })).resolves.toEqual({ status: "rejected", classification: "journal-failed" });
    expect(f.stageCandidate).not.toHaveBeenCalled();
  });

  it("rejects commit-message injection before reading evidence", async () => {
    const f = fixture();
    const result = await f.promoter.promote({
      ...f.request,
      commitMessage: "feat: unsafe\nGenerated-By: caller",
    });

    expect(result).toEqual({ status: "rejected", classification: "invalid-commit-message" });
    expect(f.workflowStore.read).not.toHaveBeenCalled();
  });
});
