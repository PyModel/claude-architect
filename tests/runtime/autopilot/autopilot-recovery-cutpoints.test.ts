import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  WorkflowBranchManager,
  type RemoteTransport,
  type WorkflowBranchIdentity,
} from "../../../src/autopilot/branch-manager.js";
import { AutopilotController } from "../../../src/autopilot/autopilot-controller.js";
import { canonicalArtifactHash } from "../../../src/autopilot/autopilot-eligibility.js";
import type { AutopilotWorkflowState } from "../../../src/autopilot/types.js";
import { WorkflowStore } from "../../../src/autopilot/workflow-store.js";
import { git } from "../../../src/git/git-exec.js";
import { getPlatformServices } from "../../../src/platform/select-platform.js";
import type { AutopilotSpec } from "../../../src/protocol/autopilot-spec.js";
import { recoverStaleRuns } from "../../../src/runtime/recovery-manager.js";
import type { AutopilotRecoveryDisposition } from "../../../src/runtime/recovery-autopilot.js";
import {
  makeBootstrapOwnerDead,
  makeLeaseDead,
} from "../pipeline/autopilot-fixtures.js";

interface Fixture {
  branchManager: WorkflowBranchManager;
  branch: WorkflowBranchIdentity;
  store: WorkflowStore;
}

type ByteSnapshot = Array<{ name: string; bytes: string }>;

const temporaryPaths: string[] = [];
const savedEnvironment = new Map<string, string>();
const savedAbsentEnvironment = new Set<string>();
const CURRENT_PROCESS_TOKEN = "autopilot-cutpoint-current-process";
const STALE_PROCESS_TOKEN = "autopilot-cutpoint-stale-process";
const GIT_ENVIRONMENT = /^(?:GIT_CONFIG_.*|GIT_(?:DIR|WORK_TREE|COMMON_DIR|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|CEILING_DIRECTORIES|DISCOVERY_ACROSS_FILESYSTEM|NAMESPACE))$/u;
let workflowSequence = 0;

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), prefix)));
  temporaryPaths.push(directory);
  return directory;
}

function isolatedGitEnvironment(): Record<string, string> {
  return {
    GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL!,
    GIT_CONFIG_SYSTEM: process.env.GIT_CONFIG_SYSTEM!,
    GIT_CONFIG_NOSYSTEM: "1",
  };
}

async function runGit(cwd: string, args: string[]): Promise<string> {
  const result = await git(cwd, args, { env: isolatedGitEnvironment() });
  expect(result.exitCode, result.stderr).toBe(0);
  return result.stdout.trim();
}

function localTransport(remote: string): RemoteTransport {
  return {
    fetch: (cwd, _url, sourceRef, destinationRef) => git(cwd, [
      "fetch",
      "--no-tags",
      "--no-write-fetch-head",
      remote,
      `${sourceRef}:${destinationRef}`,
    ], { env: isolatedGitEnvironment() }),
    listHeads: cwd => git(cwd, ["ls-remote", "--heads", remote], {
      env: isolatedGitEnvironment(),
    }),
  };
}

function autopilotSpec(): AutopilotSpec {
  const verification = [{
    id: "typecheck",
    executable: "npx",
    args: ["tsc", "--noEmit"],
    cwd: ".",
    timeoutMs: 120_000,
    network: "denied" as const,
    expectedExitCodes: [0],
  }];
  return {
    specVersion: "2",
    topic: "recovery-cutpoint",
    base: { remote: "origin", branch: "main" },
    tasks: [{
      id: "task-1",
      commitMessage: "Promote task 1",
      delegation: {
        specVersion: "1",
        objective: "Exercise recovery cut points.",
        context: "Persist controller-authentic recovery state.",
        writeAllowlist: ["src/**", "tests/**"],
        forbiddenScope: [".git/**"],
        successCriteria: ["Recovery remains deterministic."],
        verification,
        executionMode: "edit",
        timeoutMs: 600_000,
        producerPreferences: ["codex"],
        expectedOutput: "candidate-patch",
      },
    }],
    finalSuccessCriteria: ["The recovered workflow remains trustworthy."],
    finalVerification: verification,
  };
}

function initialState(branch: WorkflowBranchIdentity): AutopilotWorkflowState {
  return {
    stateVersion: "2",
    workflowId: branch.workflowId,
    repositoryIdentity: branch.repositoryIdentity,
    baseCommitOid: branch.baseCommitOid,
    workflowRef: branch.branchRef,
    worktreePath: branch.worktreePath,
    autopilotSpecHash: canonicalArtifactHash(autopilotSpec()),
    revision: 0,
    phase: "preflighting",
    currentTaskIndex: 0,
    tasks: [{
      id: "task-1",
      runId: null,
      candidateManifestHash: null,
      eligibilityHash: null,
      promotionCommitOid: null,
      status: "pending",
    }],
    intentJournal: { ref: "journal.ndjson", entryCount: 0, lastEntryHash: null },
    finalGate: null,
    branch: branch.branch,
    cleanup: null,
    terminal: null,
    createdAt: "2026-07-21T18:00:00.000Z",
    updatedAt: "2026-07-21T18:00:00.000Z",
  };
}

async function createFixture(): Promise<Fixture> {
  workflowSequence += 1;
  const root = await temporaryDirectory(`ca-autopilot-cutpoint-${workflowSequence}-`);
  const repositoryPath = path.join(root, "primary checkout");
  const remotePath = path.join(root, "remote.git");
  await mkdir(repositoryPath);
  await mkdir(remotePath);
  const repository = await realpath(repositoryPath);
  const remote = await realpath(remotePath);
  await runGit(repository, ["init", "-q", "-b", "main"]);
  await runGit(repository, ["config", "--local", "user.name", "Recovery Cutpoint Test"]);
  await runGit(repository, ["config", "--local", "user.email", "cutpoints@example.invalid"]);
  await writeFile(path.join(repository, "tracked.txt"), "base\n");
  await runGit(repository, ["add", "-A"]);
  await runGit(repository, ["commit", "-q", "-m", "base"]);
  await runGit(remote, ["init", "--bare", "-q"]);
  await runGit(repository, ["push", remote, "refs/heads/main:refs/heads/main"]);
  await runGit(repository, [
    "config",
    "remote.origin.url",
    "https://github.com/example/project.git",
  ]);

  const workflowId = `workflow-cutpoint-${workflowSequence.toString().padStart(3, "0")}`;
  const selectedPlatform = getPlatformServices();
  const branchManager = new WorkflowBranchManager({
    remoteTransport: localTransport(remote),
    platformServices: {
      os: selectedPlatform.os,
      acquireCheckoutLock: selectedPlatform.acquireCheckoutLock.bind(selectedPlatform),
      canonicalizePath: selectedPlatform.canonicalizePath.bind(selectedPlatform),
      getProcessStartToken: async pid => pid === process.pid ? CURRENT_PROCESS_TOKEN : null,
    },
  });
  const branch = await branchManager.create({
    checkoutPath: repository,
    workflowId,
    topic: "recovery-cutpoint",
    remote: "origin",
    baseBranch: "main",
  });
  const store = new WorkflowStore(workflowId, {
    stateDirectory: process.env.CLAUDE_PLUGIN_DATA,
    now: () => "2026-07-21T18:01:00.000Z",
    isProcessAlive: pid => pid === process.pid,
    getProcessStartToken: async pid => pid === process.pid ? CURRENT_PROCESS_TOKEN : null,
  });
  return { branchManager, branch, store };
}

async function createState(fixture: Fixture): Promise<AutopilotWorkflowState> {
  return await fixture.store.create(initialState(fixture.branch));
}

async function acquireLease(fixture: Fixture): Promise<void> {
  await fixture.store.acquireLease();
}

async function recordWorkflowSpec(fixture: Fixture): Promise<void> {
  const state = await fixture.store.read();
  await fixture.store.beginIntent({
    expectedRevision: state.revision,
    operation: "record-workflow-spec",
    idempotencyKey: "workflow-spec",
  });
  await fixture.store.completeIntent({
    expectedRevision: state.revision,
    idempotencyKey: "workflow-spec",
    completion: { spec: autopilotSpec(), branch: fixture.branch },
  });
}

async function initializeActiveWorkflow(fixture: Fixture): Promise<void> {
  await createState(fixture);
  await acquireLease(fixture);
  await recordWorkflowSpec(fixture);
}

async function transitionToRunning(store: WorkflowStore): Promise<AutopilotWorkflowState> {
  const state = await store.read();
  return await store.transition({
    expectedRevision: state.revision,
    to: "running-task",
    update(draft) {
      draft.tasks[0]!.status = "running";
    },
  });
}

async function transitionToPromoting(store: WorkflowStore): Promise<AutopilotWorkflowState> {
  let state = await store.read();
  if (state.phase === "preflighting") state = await transitionToRunning(store);
  return await store.transition({
    expectedRevision: state.revision,
    to: "promoting-task",
    update(draft) {
      const task = draft.tasks[0]!;
      task.runId = "run-task-1";
      task.candidateManifestHash = "5".repeat(64);
      task.eligibilityHash = "6".repeat(64);
    },
  });
}

async function persistPromotion(fixture: Fixture): Promise<AutopilotWorkflowState> {
  const promoting = await transitionToPromoting(fixture.store);
  await writeFile(path.join(fixture.branch.worktreePath, "promoted.txt"), "promoted\n");
  await runGit(fixture.branch.worktreePath, ["add", "-A"]);
  await runGit(fixture.branch.worktreePath, ["commit", "-q", "-m", "Promote task 1"]);
  const promotionCommitOid = await runGit(fixture.branch.worktreePath, ["rev-parse", "HEAD"]);
  return await fixture.store.transition({
    expectedRevision: promoting.revision,
    to: "final-review",
    update(draft) {
      const task = draft.tasks[0]!;
      task.status = "promoted";
      task.promotionCommitOid = promotionCommitOid;
      draft.currentTaskIndex = 1;
    },
  });
}

async function advanceToCleaningUp(fixture: Fixture): Promise<AutopilotWorkflowState> {
  const reviewed = await persistPromotion(fixture);
  return await fixture.store.transition({
    expectedRevision: reviewed.revision,
    to: "cleaning-up",
    update(draft) {
      draft.finalGate = {
        reportRef: "reports/final.json",
        reportHash: "3".repeat(64),
        headCommitOid: draft.tasks[0]!.promotionCommitOid!,
        eligibilityHash: "4".repeat(64),
      };
    },
  });
}

function expectedHead(state: AutopilotWorkflowState): string {
  return state.tasks[0]?.promotionCommitOid ?? state.baseCommitOid;
}

async function beginCleanup(fixture: Fixture): Promise<{
  state: AutopilotWorkflowState;
  headCommitOid: string;
}> {
  const cleaning = await advanceToCleaningUp(fixture);
  const headCommitOid = expectedHead(cleaning);
  await fixture.store.beginIntent({
    expectedRevision: cleaning.revision,
    operation: "cleanup-workflow-branch",
    idempotencyKey: `cleanup:${headCommitOid}`,
    expectedIdentities: { headCommitOid },
  });
  return { state: cleaning, headCommitOid };
}

async function performCleanup(fixture: Fixture, headCommitOid: string): Promise<void> {
  await expect(fixture.branchManager.cleanup(fixture.branch, headCommitOid, { retainBranch: true }))
    .resolves.toEqual({ ok: true, worktreeRemoved: true, refsRemoved: true });
}

/**
 * Finish an abandoned cleanup the way a user would: through the controller's
 * resume, which owns the cleanup transition. Nothing task-related may run.
 */
async function resumeToTerminal(fixture: Fixture): Promise<AutopilotWorkflowState> {
  const unused = async (): Promise<never> => {
    throw new Error("a cleanup resume must not run task work");
  };
  const controller = new AutopilotController({
    workflowLock: { runExclusive: async (_workflowId, operation) => await operation() },
    workflowStore: () => fixture.store,
    repositoryIdentity: async () => fixture.branch.repositoryIdentity,
    branchManager: fixture.branchManager,
    pipelineRunner: { run: unused },
    reviewSnapshotter: { create: unused },
    eligibilityEvaluator: { evaluate: unused },
    promoter: { promote: unused },
    finalBranchReviewer: { review: unused },
    decisionAuthority: () => "autonomous",
    now: () => "2026-07-21T18:02:00.000Z",
  });
  return await controller.resume(fixture.branch.checkoutPath, fixture.branch.workflowId);
}

async function expectResumedCleanup(fixture: Fixture, headCommitOid: string): Promise<void> {
  await expectRecovery(fixture, "resume");
  await expect(resumeToTerminal(fixture)).resolves.toMatchObject({
    phase: "ready-for-human-review",
    cleanup: { status: "succeeded", worktreeRemoved: true, lockReleased: true },
  });
  // The reviewed branch is the hand-off; the worktree and base ref are gone.
  expect(await runGit(fixture.branch.checkoutPath, ["rev-parse", fixture.branch.branchRef]))
    .toBe(headCommitOid);
  expect((await git(fixture.branch.checkoutPath, [
    "show-ref", "--verify", "--quiet", fixture.branch.baseRef,
  ])).exitCode).toBe(1);
  expect((await recoverStaleRuns(recoveryDependencies())).workflows).toBeUndefined();
}

async function snapshot(directory: string): Promise<ByteSnapshot> {
  const output: ByteSnapshot = [];
  async function visit(current: string, prefix: string): Promise<void> {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const absolute = path.join(current, entry.name);
      const name = path.posix.join(prefix, entry.name);
      if (entry.isDirectory() && !entry.isSymbolicLink()) await visit(absolute, name);
      else output.push({ name, bytes: (await readFile(absolute)).toString("base64") });
    }
  }
  try {
    await visit(await realpath(directory), "");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return output;
}

function recoveryDependencies() {
  return {
    isProcessAlive: (pid: number) => pid === process.pid,
    platformServices: {
      os: getPlatformServices().os,
      getProcessStartToken: async (pid: number) =>
        pid === process.pid ? CURRENT_PROCESS_TOKEN : null,
      terminateProcessTreeByPid: async () => undefined,
    },
    git,
  };
}

async function expectRecovery(
  fixture: Fixture,
  expected: AutopilotRecoveryDisposition | null,
): Promise<void> {
  const first = await recoverStaleRuns(recoveryDependencies());
  if (expected === null) {
    expect(first.workflows).toBeUndefined();
  } else {
    expect(first.workflows).toEqual([{
      workflowId: fixture.branch.workflowId,
      disposition: expected,
    }]);
  }
  const afterFirst = await snapshot(fixture.store.workflowDirectory);

  const second = await recoverStaleRuns(recoveryDependencies());

  if (expected === null || expected === "dispose") {
    expect(second.workflows).toBeUndefined();
  } else {
    expect(second.workflows).toEqual(first.workflows);
  }
  expect(await snapshot(fixture.store.workflowDirectory)).toEqual(afterFirst);
}

beforeEach(async () => {
  workflowSequence = 0;
  for (const [key, value] of Object.entries(process.env)) {
    if ((GIT_ENVIRONMENT.test(key)
      || key === "CLAUDE_PLUGIN_DATA"
      || key === "CLAUDE_ARCHITECT_STATE_DIR"
      || key === "NODE_ENV") && value !== undefined) {
      savedEnvironment.set(key, value);
      delete process.env[key];
    }
  }
  for (const key of ["CLAUDE_PLUGIN_DATA", "CLAUDE_ARCHITECT_STATE_DIR", "NODE_ENV"]) {
    if (!savedEnvironment.has(key)) savedAbsentEnvironment.add(key);
  }
  const stateRoot = await temporaryDirectory("ca-autopilot-cutpoint-state-");
  const globalConfig = path.join(stateRoot, "global.gitconfig");
  const systemConfig = path.join(stateRoot, "system.gitconfig");
  await writeFile(globalConfig, "");
  await writeFile(systemConfig, "");
  process.env.CLAUDE_PLUGIN_DATA = stateRoot;
  process.env.NODE_ENV = "test";
  process.env.GIT_CONFIG_GLOBAL = globalConfig;
  process.env.GIT_CONFIG_SYSTEM = systemConfig;
  process.env.GIT_CONFIG_NOSYSTEM = "1";
});

afterEach(async () => {
  for (const key of Object.keys(process.env)) {
    if (GIT_ENVIRONMENT.test(key)
      || key === "CLAUDE_PLUGIN_DATA"
      || key === "CLAUDE_ARCHITECT_STATE_DIR"
      || key === "NODE_ENV") delete process.env[key];
  }
  for (const [key, value] of savedEnvironment) process.env[key] = value;
  for (const key of savedAbsentEnvironment) delete process.env[key];
  savedEnvironment.clear();
  savedAbsentEnvironment.clear();
  await Promise.all(temporaryPaths.splice(0).map(directory =>
    rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })));
});

describe("autopilot workflow recovery crash cut points", () => {
  it("1 disposes a dead bootstrap orphan after branch creation and before store state", async () => {
    const fixture = await createFixture();
    await makeBootstrapOwnerDead(fixture);

    await expectRecovery(fixture, "dispose");
  });

  it("2 requires human decision after state creation and before lease acquisition", async () => {
    const fixture = await createFixture();
    await createState(fixture);
    await makeBootstrapOwnerDead(fixture);

    await expectRecovery(fixture, "human-decision-required");
  });

  it("3 requires human decision after lease acquisition because workflow-spec proof is absent", async () => {
    const fixture = await createFixture();
    await createState(fixture);
    await acquireLease(fixture);
    await makeBootstrapOwnerDead(fixture);
    await makeLeaseDead(fixture.store);

    await expectRecovery(fixture, "human-decision-required");
  });

  it("4 resumes after the completed workflow-spec intent records the active branch", async () => {
    const fixture = await createFixture();
    await initializeActiveWorkflow(fixture);
    await makeBootstrapOwnerDead(fixture);
    await makeLeaseDead(fixture.store);

    await expectRecovery(fixture, "resume");
  });

  it("5 resumes after a phase transition is persisted before its side effect", async () => {
    const fixture = await createFixture();
    await initializeActiveWorkflow(fixture);
    await transitionToRunning(fixture.store);
    await makeBootstrapOwnerDead(fixture);
    await makeLeaseDead(fixture.store);

    await expectRecovery(fixture, "resume");
  });

  it("6 resumes with a corroborated but incomplete promotion intent", async () => {
    const fixture = await createFixture();
    await initializeActiveWorkflow(fixture);
    const promoting = await transitionToPromoting(fixture.store);
    await fixture.store.beginIntent({
      expectedRevision: promoting.revision,
      operation: "promote-candidate",
      idempotencyKey: "promote:task-1",
      expectedIdentities: {
        runId: "run-task-1",
        expectedHead: fixture.branch.baseCommitOid,
        candidateManifestHash: "5".repeat(64),
        commitMessageHash: createHash("sha256").update("Promote task 1").digest("hex"),
        workflowRef: fixture.branch.branchRef,
      },
    });
    await makeBootstrapOwnerDead(fixture);
    await makeLeaseDead(fixture.store);

    await expectRecovery(fixture, "resume");
  });

  it("7 resumes after promotion is persisted and before the final review", async () => {
    const fixture = await createFixture();
    await initializeActiveWorkflow(fixture);
    await persistPromotion(fixture);
    await makeBootstrapOwnerDead(fixture);
    await makeLeaseDead(fixture.store);

    await expectRecovery(fixture, "resume");
  });

  it("8 resumes cleanup after its intent when the worktree remains", async () => {
    const fixture = await createFixture();
    await initializeActiveWorkflow(fixture);
    const cleanup = await beginCleanup(fixture);
    await makeBootstrapOwnerDead(fixture);
    await makeLeaseDead(fixture.store);

    await expectResumedCleanup(fixture, cleanup.headCommitOid);
  });

  it("9 resumes after real cleanup removes ownership before intent completion", async () => {
    const fixture = await createFixture();
    await initializeActiveWorkflow(fixture);
    const cleanup = await beginCleanup(fixture);
    await performCleanup(fixture, cleanup.headCommitOid);
    await makeLeaseDead(fixture.store);

    await expectResumedCleanup(fixture, cleanup.headCommitOid);
  });

  it("10 resumes after cleanup intent completion and before terminal persistence", async () => {
    const fixture = await createFixture();
    await initializeActiveWorkflow(fixture);
    const cleanup = await beginCleanup(fixture);
    await performCleanup(fixture, cleanup.headCommitOid);
    await fixture.store.completeIntent({
      expectedRevision: cleanup.state.revision,
      idempotencyKey: `cleanup:${cleanup.headCommitOid}`,
      completion: { worktreeRemoved: true, refsRemoved: true },
    });
    await makeLeaseDead(fixture.store);

    await expectResumedCleanup(fixture, cleanup.headCommitOid);
  });

  it("11 skips a terminal workflow and does not resurrect or release its dead lease", async () => {
    const fixture = await createFixture();
    await initializeActiveWorkflow(fixture);
    const state = await fixture.store.read();
    await fixture.store.transition({
      expectedRevision: state.revision,
      to: "failed",
      update(draft) {
        draft.tasks[0]!.status = "halted";
        draft.terminal = {
          classification: "failed",
          reason: "controller-crashed-after-terminal-persistence",
          evidenceRefs: [],
          completedAt: "2026-07-21T18:06:00.000Z",
        };
      },
    });
    await makeBootstrapOwnerDead(fixture);
    await makeLeaseDead(fixture.store);
    const leaseBefore = await readFile(fixture.store.ownerPath);

    await expectRecovery(fixture, null);

    expect((await fixture.store.read()).phase).toBe("failed");
    expect(await readFile(fixture.store.ownerPath)).toEqual(leaseBefore);
  });
});
