import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  advisorReportHash,
  autopilotEligibilityRecordHash,
  pipelineResultHash,
} from "../../../src/autopilot/autopilot-eligibility.js";
import { CandidatePromoter } from "../../../src/autopilot/candidate-promoter.js";
import type { WorkflowBranchManager } from "../../../src/autopilot/branch-manager.js";
import type { WorkflowStore } from "../../../src/autopilot/workflow-store.js";
import { freezeCandidate } from "../../../src/git/candidate-tree.js";
import { git, type GitResult } from "../../../src/git/git-exec.js";
import { getPlatformServices } from "../../../src/platform/select-platform.js";
import type { ArtifactStore } from "../../../src/runtime/artifact-store.js";
import { reviewSnapshotHash } from "../../../src/runtime/review-snapshot.js";

const temporaryPaths: string[] = [];
const originalPluginData = process.env.CLAUDE_PLUGIN_DATA;
const AMBIENT_GIT_ENVIRONMENT = /^(?:GIT_CONFIG_.*|GIT_(?:DIR|WORK_TREE|COMMON_DIR|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|CEILING_DIRECTORIES|DISCOVERY_ACROSS_FILESYSTEM|NAMESPACE))$/;
let previousAmbientGitEnvironment = new Map<string, string>();

beforeEach(async () => {
  // Isolate ambient Git configuration exactly as branch-manager.test.ts and
  // autopilot-e2e.test.ts do. This is the only suite proving exact-tree
  // promotion against real Git, so a contributor's or CI's global config
  // (includeIf, commit templates, ambient GIT_CONFIG_COUNT) must not leak into
  // the very guarantee under test.
  previousAmbientGitEnvironment = new Map(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => AMBIENT_GIT_ENVIRONMENT.test(entry[0])
        && entry[1] !== undefined,
    ),
  );
  for (const key of previousAmbientGitEnvironment.keys()) delete process.env[key];
  const configRoot = await mkdtemp(path.join(tmpdir(), "candidate-promoter-gitconfig-"));
  temporaryPaths.push(configRoot);
  const globalConfig = path.join(configRoot, "global.gitconfig");
  const systemConfig = path.join(configRoot, "system.gitconfig");
  await writeFile(globalConfig, "");
  await writeFile(systemConfig, "");
  process.env.GIT_CONFIG_GLOBAL = globalConfig;
  process.env.GIT_CONFIG_SYSTEM = systemConfig;
  process.env.GIT_CONFIG_NOSYSTEM = "1";
});

afterEach(async () => {
  if (originalPluginData === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
  else process.env.CLAUDE_PLUGIN_DATA = originalPluginData;
  for (const key of Object.keys(process.env)) {
    if (AMBIENT_GIT_ENVIRONMENT.test(key)) delete process.env[key];
  }
  for (const [key, value] of previousAmbientGitEnvironment) process.env[key] = value;
  await Promise.all(temporaryPaths.splice(0).map(entry =>
    rm(entry, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })));
});

async function runGit(cwd: string, args: string[]): Promise<string> {
  const result = await git(cwd, args);
  expect(result.exitCode, result.stderr).toBe(0);
  return result.stdout.trim();
}

describe("CandidatePromoter real repository", () => {
  it("installs and journals an exact-tree commit before deleting its anchor", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "candidate-promoter-"));
    temporaryPaths.push(root);
    process.env.CLAUDE_PLUGIN_DATA = path.join(root, "state");
    const checkout = path.join(root, "repo");
    const candidateWorktree = path.join(root, "candidate");
    await mkdir(checkout);
    await runGit(checkout, ["init", "-q"]);
    await runGit(checkout, ["config", "user.name", "Runtime Test"]);
    await runGit(checkout, ["config", "user.email", "runtime@example.invalid"]);
    await writeFile(path.join(checkout, "a.txt"), "base\n");
    await runGit(checkout, ["add", "a.txt"]);
    await runGit(checkout, ["commit", "-q", "-m", "base"]);
    const baseOid = await runGit(checkout, ["rev-parse", "HEAD"]);
    const workflowId = "workflow-real-promotion";
    const runId = "run-real-promotion";
    const workflowRef = `refs/heads/autopilot/${workflowId}`;
    await runGit(checkout, ["switch", "-q", "-c", `autopilot/${workflowId}`]);
    await runGit(checkout, [
      "worktree", "add", "--detach", "-q", candidateWorktree, baseOid,
    ]);
    await writeFile(path.join(candidateWorktree, "a.txt"), "candidate\n");
    const frozen = await freezeCandidate({
      repoRoot: checkout,
      worktreePath: candidateWorktree,
      baseCommitOid: baseOid,
      runId,
      writeAllowlist: ["**"],
      forbiddenScope: [],
    });
    expect(frozen.ok).toBe(true);
    if (!frozen.ok) throw new Error(frozen.reason);
    const artifact = frozen.artifact;

    const pipelineResult = {
      runId,
      status: "decision-ready",
      finalCandidateCommit: artifact.candidateCommitOid,
      marker: "real-pipeline",
    };
    const snapshot = {
      runId,
      baseCommitOid: artifact.baseCommitOid,
      candidateCommitOid: artifact.candidateCommitOid,
      candidateTreeOid: artifact.candidateTreeOid,
      manifestHash: artifact.manifestHash,
      patch: artifact.patch,
      changedPaths: artifact.changedPaths,
      evidence: {},
      executedVerification: [],
    };
    const advisor = { verdict: "approve", marker: "real-advisor" };
    const eligibility = {
      recordVersion: "1" as const,
      policyVersion: "1" as const,
      runId,
      eligible: true,
      reasons: [],
      baseCommitOid: artifact.baseCommitOid,
      candidateCommitOid: artifact.candidateCommitOid,
      candidateTreeOid: artifact.candidateTreeOid,
      candidateManifestHash: artifact.manifestHash,
      reviewSnapshotHash: reviewSnapshotHash(snapshot),
      pipelineResultHash: pipelineResultHash(pipelineResult as never),
      advisorReportHash: advisorReportHash(advisor as never),
      evaluatedAt: "2026-07-20T12:00:00.000Z",
    };
    const eligibilityHash = autopilotEligibilityRecordHash(eligibility);
    const platformServices = getPlatformServices();
    const canonical = await platformServices.canonicalizePath(checkout);
    const repositoryIdentity = canonical.gitCommonDir ?? canonical.canonical;
    const workflow = {
      revision: 4,
      workflowId,
      phase: "promoting-task",
      worktreePath: checkout,
      workflowRef,
      repositoryIdentity,
      currentTaskIndex: 0,
      tasks: [{
        id: "task-1",
        runId,
        candidateManifestHash: artifact.manifestHash,
        eligibilityHash,
      }],
    };
    let completion: null | { completion: { commitOid: string }; failure: null } = null;
    let decision: null | {
      decisionVersion: "2";
      decision: "accepted";
      authority: "autopilot-policy";
      candidateManifestHash: string;
      evidenceHash: string;
      policyVersion: "1";
      recordedAt: string;
    } = null;
    const events: string[] = [];
    const workflowStore = {
      read: vi.fn().mockResolvedValue(workflow),
      beginIntent: vi.fn().mockImplementation(async () => ({ completion })),
      withLockedState: vi.fn().mockImplementation(async (
        _revision: number,
        operation: (state: typeof workflow) => Promise<unknown>,
      ) => operation(workflow)),
      completeIntent: vi.fn().mockImplementation(async (args: {
        completion: { commitOid: string };
      }) => {
        completion = { completion: args.completion, failure: null };
        events.push("journal-complete");
        return { completion };
      }),
    };
    const artifactStore = {
      readResult: vi.fn().mockResolvedValue({
        runId, status: "verified-candidate", candidate: artifact,
      }),
      readManifest: vi.fn().mockResolvedValue({
        runId,
        repoRoot: checkout,
        baseCommitOid: baseOid,
        candidateManifestHash: artifact.manifestHash,
      }),
      readPipelineArtifact: vi.fn().mockResolvedValue(pipelineResult),
      readReviewSnapshot: vi.fn().mockResolvedValue(snapshot),
      readAdvisorReport: vi.fn().mockResolvedValue(advisor),
      readAutopilotEligibility: vi.fn().mockResolvedValue(eligibility),
      readCandidateDecision: vi.fn().mockImplementation(async () => decision),
      writeAutopilotDecision: vi.fn().mockImplementation(async () => {
        decision = {
          decisionVersion: "2",
          decision: "accepted",
          authority: "autopilot-policy",
          candidateManifestHash: artifact.manifestHash,
          evidenceHash: eligibilityHash,
          policyVersion: "1",
          recordedAt: "2026-07-20T12:01:00.000Z",
        };
      }),
    };
    const branchManager = {
      load: vi.fn().mockResolvedValue({
        workflowId,
        worktreePath: checkout,
        branchRef: workflowRef,
        repositoryIdentity,
      }),
      revalidateUnderLock: vi.fn().mockImplementation(async (
        _identity: unknown,
        expectedHead: string,
        lock: { repositoryIdentity: string },
      ) => {
        const head = await git(checkout, ["rev-parse", "--verify", "HEAD"]);
        const status = await git(checkout, ["status", "--porcelain=v1", "-z"]);
        return lock.repositoryIdentity === repositoryIdentity
          && head.exitCode === 0 && head.stdout.trim() === expectedHead
          && status.exitCode === 0 && status.stdout === ""
          ? { ok: true }
          : { ok: false, classification: "dirty-worktree" };
      }),
      revalidateForStagedPromotionUnderLock: vi.fn().mockImplementation(async (
        _identity: unknown,
        expectedHead: string,
        lock: { repositoryIdentity: string },
      ) => {
        const head = await git(checkout, ["rev-parse", "--verify", "HEAD"]);
        return lock.repositoryIdentity === repositoryIdentity
          && head.exitCode === 0 && head.stdout.trim() === expectedHead
          ? { ok: true }
          : { ok: false, classification: "repository-identity-changed" };
      }),
    };
    // Forward the full signature. This suite exists to prove exact-tree
    // promotion against real Git, so dropping `options` would mean the env,
    // stdin, and timeout under test are not the production ones — and a change
    // that moved the commit message to stdin would pass here and fail in
    // production.
    const observedGit = vi.fn(async (
      cwd: string,
      args: string[],
      options?: Parameters<typeof git>[2],
    ): Promise<GitResult> => {
      if (args[0] === "update-ref" && args.includes("-d")) events.push("anchor-delete");
      return git(cwd, args, options);
    });
    const promoter = new CandidatePromoter({
      git: observedGit,
      platformServices,
      workflowStore: () => workflowStore as unknown as WorkflowStore,
      artifactStore: () => artifactStore as unknown as ArtifactStore,
      branchManager: branchManager as unknown as WorkflowBranchManager,
      now: () => "2026-07-20T12:01:00.000Z",
    });
    const message = "feat(runtime): promote exact real candidate";

    const promoted = await promoter.promote({
      workflowId,
      runId,
      workflowCheckoutPath: checkout,
      expectedHead: baseOid,
      expectedArtifactHash: artifact.manifestHash,
      commitMessage: message,
    });

    expect(promoted.status).toBe("committed");
    if (promoted.status !== "committed") throw new Error(promoted.classification);
    expect(await runGit(checkout, ["rev-parse", `${promoted.commitOid}^{tree}`]))
      .toBe(artifact.candidateTreeOid);
    expect(await runGit(checkout, ["rev-parse", `${promoted.commitOid}^`])).toBe(baseOid);
    expect(await runGit(checkout, ["log", "-1", "--format=%B", promoted.commitOid]))
      .toBe(message);
    expect(await runGit(checkout, ["status", "--porcelain=v1"])).toBe("");
    expect((await git(checkout, [
      "rev-parse", "--verify", "--quiet", artifact.anchorRef,
    ])).exitCode).toBe(1);
    expect(events).toEqual(["journal-complete", "anchor-delete"]);
    expect(observedGit).toHaveBeenCalledWith(checkout, [
      "update-ref", "--no-deref", workflowRef, promoted.commitOid, baseOid,
    ]);
  });
});
