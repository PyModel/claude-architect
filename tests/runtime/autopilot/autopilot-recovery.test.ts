import {
  lstat,
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
import type { AutopilotPhase, AutopilotWorkflowState } from "../../../src/autopilot/types.js";
import { WorkflowStore } from "../../../src/autopilot/workflow-store.js";
import { git } from "../../../src/git/git-exec.js";
import { getPlatformServices } from "../../../src/platform/select-platform.js";
import { recoverStaleRuns } from "../../../src/runtime/recovery-manager.js";
import {
  autopilotOwnershipPath,
  makeBootstrapOwnerDead,
  makeLeaseDead,
} from "../pipeline/autopilot-fixtures.js";

interface Fixture {
  root: string;
  repository: string;
  remote: string;
  branchManager: WorkflowBranchManager;
  branch: WorkflowBranchIdentity;
  store: WorkflowStore;
}

type ByteSnapshot = Array<{ name: string; bytes: string }>;

const temporaryPaths: string[] = [];
const savedEnvironment = new Map<string, string | undefined>();
let workflowSequence = 0;

const GIT_ENVIRONMENT_KEYS = [
  "GIT_CONFIG_GLOBAL",
  "GIT_CONFIG_SYSTEM",
  "GIT_CONFIG_NOSYSTEM",
] as const;
const CURRENT_PROCESS_TOKEN = "autopilot-recovery-current-process";

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), prefix)));
  temporaryPaths.push(directory);
  return directory;
}

async function runGit(cwd: string, args: string[]): Promise<string> {
  const result = await git(cwd, args, {
    env: {
      GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL!,
      GIT_CONFIG_SYSTEM: process.env.GIT_CONFIG_SYSTEM!,
      GIT_CONFIG_NOSYSTEM: "1",
    },
  });
  expect(result.exitCode, result.stderr).toBe(0);
  return result.stdout.trim();
}

function localTransport(remote: string): RemoteTransport {
  return {
    fetch: (cwd, _url, sourceRef, destinationRef) => git(cwd, [
      "fetch", "--no-tags", "--no-write-fetch-head", remote,
      `${sourceRef}:${destinationRef}`,
    ], {
      env: {
        GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL!,
        GIT_CONFIG_SYSTEM: process.env.GIT_CONFIG_SYSTEM!,
        GIT_CONFIG_NOSYSTEM: "1",
      },
    }),
    listHeads: cwd => git(cwd, ["ls-remote", "--heads", remote], {
      env: {
        GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL!,
        GIT_CONFIG_SYSTEM: process.env.GIT_CONFIG_SYSTEM!,
        GIT_CONFIG_NOSYSTEM: "1",
      },
    }),
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
    autopilotSpecHash: "2".repeat(64),
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

async function createFixture(options: { createState?: boolean } = {}): Promise<Fixture> {
  workflowSequence += 1;
  const root = await temporaryDirectory(`ca-autopilot-recovery-${workflowSequence}-`);
  const repository = path.join(root, "primary checkout");
  const remote = path.join(root, "remote.git");
  await mkdir(repository);
  await mkdir(remote);
  await runGit(repository, ["init", "-q", "-b", "main"]);
  await runGit(repository, ["config", "--local", "user.name", "Autopilot Recovery Test"]);
  await runGit(repository, ["config", "--local", "user.email", "recovery@example.invalid"]);
  await writeFile(path.join(repository, "tracked.txt"), "base\n");
  await runGit(repository, ["add", "-A"]);
  await runGit(repository, ["commit", "-q", "-m", "base"]);
  await runGit(remote, ["init", "--bare", "-q"]);
  await runGit(repository, ["push", remote, "refs/heads/main:refs/heads/main"]);
  await runGit(repository, [
    "config", "remote.origin.url", "https://github.com/example/project.git",
  ]);
  const workflowId = `workflow-recovery-${workflowSequence.toString().padStart(3, "0")}`;
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
    checkoutPath: await realpath(repository),
    workflowId,
    topic: "autopilot-recovery",
    remote: "origin",
    baseBranch: "main",
  });
  const store = new WorkflowStore(workflowId, {
    stateDirectory: process.env.CLAUDE_PLUGIN_DATA,
    now: () => "2026-07-21T18:01:00.000Z",
    getProcessStartToken: async pid => pid === process.pid ? CURRENT_PROCESS_TOKEN : null,
  });
  if (options.createState !== false) {
    await store.create(initialState(branch));
    await store.acquireLease();
    await store.beginIntent({
      expectedRevision: 0,
      operation: "record-workflow-spec",
      idempotencyKey: "workflow-spec",
    });
    await store.completeIntent({
      expectedRevision: 0,
      idempotencyKey: "workflow-spec",
      completion: { spec: { version: "test" }, branch },
    });
  }
  return { root, repository, remote, branchManager, branch, store };
}

async function advanceToCleaningUp(store: WorkflowStore): Promise<AutopilotWorkflowState> {
  const phases: AutopilotPhase[] = [
    "running-task",
    "promoting-task",
    "final-review",
    "cleaning-up",
  ];
  let state = await store.read();
  for (const phase of phases) {
    state = await store.transition({ expectedRevision: state.revision, to: phase });
  }
  return await store.update({
    expectedRevision: state.revision,
    update(draft) {
      draft.finalGate = {
        reportRef: "reports/final.json",
        reportHash: "3".repeat(64),
        headCommitOid: draft.baseCommitOid,
        eligibilityHash: "4".repeat(64),
      };
    },
  });
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

async function recoveryDependencies() {
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

beforeEach(async () => {
  workflowSequence = 0;
  for (const key of ["CLAUDE_PLUGIN_DATA", "CLAUDE_ARCHITECT_STATE_DIR", "NODE_ENV", ...GIT_ENVIRONMENT_KEYS]) {
    savedEnvironment.set(key, process.env[key]);
  }
  const stateRoot = await temporaryDirectory("ca-autopilot-recovery-state-");
  const globalConfig = path.join(stateRoot, "global.gitconfig");
  const systemConfig = path.join(stateRoot, "system.gitconfig");
  await writeFile(globalConfig, "");
  await writeFile(systemConfig, "");
  process.env.CLAUDE_PLUGIN_DATA = stateRoot;
  delete process.env.CLAUDE_ARCHITECT_STATE_DIR;
  process.env.NODE_ENV = "test";
  process.env.GIT_CONFIG_GLOBAL = globalConfig;
  process.env.GIT_CONFIG_SYSTEM = systemConfig;
  process.env.GIT_CONFIG_NOSYSTEM = "1";
});

afterEach(async () => {
  for (const [key, value] of savedEnvironment) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  savedEnvironment.clear();
  await Promise.all(temporaryPaths.splice(0).map(directory =>
    rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })));
});

describe("autopilot startup recovery", () => {
  it("preserves a workflow byte-for-byte when an owner is live", async () => {
    const fixture = await createFixture();
    const before = await snapshot(fixture.store.workflowDirectory);

    const result = await recoverStaleRuns(await recoveryDependencies());

    expect(result.workflows).toEqual([{
      workflowId: fixture.branch.workflowId,
      disposition: "live-preserve",
    }]);
    expect(await snapshot(fixture.store.workflowDirectory)).toEqual(before);
  });

  it("preserves a live workflow worktree before ownership publication", async () => {
    const fixture = await createFixture();
    await rm(autopilotOwnershipPath(
      fixture.branch.workflowId,
      process.env.CLAUDE_PLUGIN_DATA!,
    ));

    const result = await recoverStaleRuns(await recoveryDependencies());

    expect(result.workflows).toEqual([{
      workflowId: fixture.branch.workflowId,
      disposition: "live-preserve",
    }]);
    await expect(lstat(fixture.branch.worktreePath)).resolves.toBeDefined();
  });

  it("isolates an oversized workflow ownership record as a bounded issue", async () => {
    const fixture = await createFixture();
    const ownershipPath = autopilotOwnershipPath(
      fixture.branch.workflowId,
      process.env.CLAUDE_PLUGIN_DATA!,
    );
    await writeFile(ownershipPath, "x".repeat(8_000_001));

    const result = await recoverStaleRuns(await recoveryDependencies());

    expect(result.worktreeSweepIssues).toEqual(expect.arrayContaining([
      expect.objectContaining({ worktreePath: ownershipPath }),
    ]));
    await expect(lstat(fixture.branch.worktreePath)).resolves.toBeDefined();
  });

  it("reports resume for a non-terminal workflow with dead owners and is byte-idempotent", async () => {
    const fixture = await createFixture();
    await makeBootstrapOwnerDead(fixture);
    await makeLeaseDead(fixture.store);

    const first = await recoverStaleRuns(await recoveryDependencies());
    const afterFirst = await snapshot(fixture.store.workflowDirectory);
    const second = await recoverStaleRuns(await recoveryDependencies());

    expect(first.workflows).toEqual([{
      workflowId: fixture.branch.workflowId,
      disposition: "resume",
    }]);
    expect(second.workflows).toEqual(first.workflows);
    expect(await snapshot(fixture.store.workflowDirectory)).toEqual(afterFirst);
  });

  // git prints worktree paths in its own format, which is forward-slashed on
  // Windows while the recorded identity is Node-canonical. When recovery
  // compared those bytes directly it never found the registration, so every
  // healthy workflow on Windows was downgraded to human-decision-required.
  it("resumes when git reports the worktree path in a non-normalized form", async () => {
    const fixture = await createFixture();
    await makeBootstrapOwnerDead(fixture);
    await makeLeaseDead(fixture.store);
    const dependencies = await recoveryDependencies();
    const denormalizing: typeof git = async (cwd, args, options) => {
      const result = await dependencies.git(cwd, args, options);
      if (args[0] !== "worktree" || args[1] !== "list") return result;
      return {
        ...result,
        stdout: result.stdout.split("\0").map(field => field.startsWith("worktree ")
          ? `${field}${path.sep}.`
          : field).join("\0"),
      };
    };

    const result = await recoverStaleRuns({ ...dependencies, git: denormalizing });

    expect(result.workflows).toEqual([{
      workflowId: fixture.branch.workflowId,
      disposition: "resume",
    }]);
  });

  it("hands an abandoned cleanup to the controller without acting on it", async () => {
    const fixture = await createFixture();
    const cleaning = await advanceToCleaningUp(fixture.store);
    await fixture.store.beginIntent({
      expectedRevision: cleaning.revision,
      operation: "cleanup-workflow-branch",
      idempotencyKey: `cleanup:${fixture.branch.baseCommitOid}`,
      expectedIdentities: { headCommitOid: fixture.branch.baseCommitOid },
    });
    await expect(fixture.branchManager.cleanup(
      fixture.branch,
      fixture.branch.baseCommitOid,
      { retainBranch: true },
    ))
      .resolves.toEqual({ ok: true, worktreeRemoved: true, refsRemoved: true });
    await makeLeaseDead(fixture.store);
    const before = await snapshot(fixture.store.workflowDirectory);

    const first = await recoverStaleRuns(await recoveryDependencies());
    const second = await recoverStaleRuns(await recoveryDependencies());

    // Finishing cleanup is the controller's resume; recovery only classifies,
    // so it writes nothing and answers the same way every time.
    expect(first.workflows).toEqual([{
      workflowId: fixture.branch.workflowId,
      disposition: "resume",
    }]);
    expect(second.workflows).toEqual(first.workflows);
    expect(await snapshot(fixture.store.workflowDirectory)).toEqual(before);
    await expect(fixture.store.read()).resolves.toMatchObject({ phase: "cleaning-up" });
  });

  it("refuses to hand off a cleanup whose recorded branch belongs to another workflow", async () => {
    const fixture = await createFixture();
    await advanceToCleaningUp(fixture.store);
    await makeBootstrapOwnerDead(fixture);
    await makeLeaseDead(fixture.store);
    const ownership = autopilotOwnershipPath(fixture.branch.workflowId, process.env.CLAUDE_PLUGIN_DATA!);
    const record = JSON.parse(await readFile(ownership, "utf8")) as {
      branch: string;
      branchRef: string;
    };
    record.branch = "feat/another-workflow";
    record.branchRef = "refs/heads/feat/another-workflow";
    await writeFile(ownership, `${JSON.stringify(record)}\n`);

    const result = await recoverStaleRuns(await recoveryDependencies());

    expect(result.workflows).toEqual([{
      workflowId: fixture.branch.workflowId,
      disposition: "human-decision-required",
    }]);
  });

  it("disposes a dead bootstrap orphan and converges byte-idempotently", async () => {
    const fixture = await createFixture({ createState: false });
    await makeBootstrapOwnerDead(fixture);

    const first = await recoverStaleRuns(await recoveryDependencies());
    const afterFirst = await snapshot(process.env.CLAUDE_PLUGIN_DATA!);
    const second = await recoverStaleRuns(await recoveryDependencies());

    expect(first.workflows).toEqual([{
      workflowId: fixture.branch.workflowId,
      disposition: "dispose",
    }]);
    await expect(lstat(fixture.branch.worktreePath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(autopilotOwnershipPath(
      fixture.branch.workflowId,
      process.env.CLAUDE_PLUGIN_DATA!,
    )))
      .rejects.toMatchObject({ code: "ENOENT" });
    expect(second.workflows).toBeUndefined();
    expect(await snapshot(process.env.CLAUDE_PLUGIN_DATA!)).toEqual(afterFirst);
  });

  it("fails closed when a non-terminal workflow has no lease", async () => {
    const fixture = await createFixture();
    await makeBootstrapOwnerDead(fixture);
    await fixture.store.releaseLease();

    const result = await recoverStaleRuns(await recoveryDependencies());

    expect(result.workflows).toEqual([{
      workflowId: fixture.branch.workflowId,
      disposition: "human-decision-required",
    }]);
  });

  it("fails closed when owner liveness is ambiguous", async () => {
    const fixture = await createFixture();
    await makeBootstrapOwnerDead(fixture);
    await writeFile(fixture.store.ownerPath, `${JSON.stringify({
      workflowId: fixture.store.workflowId,
      pid: process.pid,
      processToken: null,
      acquiredAt: "2026-07-21T17:00:00.000Z",
    })}\n`);

    const result = await recoverStaleRuns(await recoveryDependencies());

    expect(result.workflows).toEqual([{
      workflowId: fixture.branch.workflowId,
      disposition: "human-decision-required",
    }]);
  });
});
