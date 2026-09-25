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
import { canonicalArtifactHash } from "../../../src/autopilot/autopilot-eligibility.js";
import {
  WorkflowBranchManager,
  type RemoteTransport,
  type WorkflowBranchIdentity,
} from "../../../src/autopilot/branch-manager.js";
import type { AutopilotWorkflowState } from "../../../src/autopilot/types.js";
import { WorkflowStore } from "../../../src/autopilot/workflow-store.js";
import { git, type GitResult } from "../../../src/git/git-exec.js";
import { doctor } from "../../../src/mcp/doctor.js";
import type { PlatformServices } from "../../../src/platform/platform-services.js";
import { getPlatformServices } from "../../../src/platform/select-platform.js";
import type { AutopilotSpec } from "../../../src/protocol/autopilot-spec.js";

interface Fixture {
  repository: string;
  branchManager: WorkflowBranchManager;
  branch: WorkflowBranchIdentity;
  store: WorkflowStore;
}

type ByteSnapshot = Array<{ name: string; bytes: string }>;

const CURRENT_PROCESS_TOKEN = "autopilot-doctor-current-process";
const STALE_PROCESS_TOKEN = "autopilot-doctor-stale-process";
const temporaryPaths: string[] = [];
const savedEnvironment = new Map<string, string | undefined>();
const GIT_ENVIRONMENT_KEYS = [
  "GIT_CONFIG_GLOBAL",
  "GIT_CONFIG_SYSTEM",
  "GIT_CONFIG_NOSYSTEM",
] as const;
let workflowSequence = 0;

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), prefix)));
  temporaryPaths.push(directory);
  return directory;
}

function gitEnvironment(): Record<string, string> {
  return {
    GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL!,
    GIT_CONFIG_SYSTEM: process.env.GIT_CONFIG_SYSTEM!,
    GIT_CONFIG_NOSYSTEM: "1",
  };
}

async function runGit(cwd: string, args: string[]): Promise<string> {
  const result = await git(cwd, args, { env: gitEnvironment() });
  expect(result.exitCode, result.stderr).toBe(0);
  return result.stdout.trim();
}

function doctorGit(cwd: string, args: string[]): Promise<GitResult> {
  return git(cwd, args, { env: gitEnvironment() });
}

function localTransport(remote: string): RemoteTransport {
  return {
    fetch: (cwd, _url, sourceRef, destinationRef) => git(cwd, [
      "fetch",
      "--no-tags",
      "--no-write-fetch-head",
      remote,
      `${sourceRef}:${destinationRef}`,
    ], { env: gitEnvironment() }),
    listHeads: cwd => git(cwd, ["ls-remote", "--heads", remote], {
      env: gitEnvironment(),
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
    topic: "autopilot-doctor",
    base: { remote: "origin", branch: "main" },
    tasks: [{
      id: "task-1",
      commitMessage: "Promote doctor task",
      delegation: {
        specVersion: "1",
        objective: "Exercise autopilot doctor diagnostics.",
        context: "Use durable workflow state.",
        writeAllowlist: ["src/**", "tests/**"],
        forbiddenScope: [".git/**"],
        successCriteria: ["Doctor reports stable issue codes."],
        verification,
        executionMode: "edit",
        timeoutMs: 600_000,
        producerPreferences: ["codex"],
        expectedOutput: "candidate-patch",
      },
    }],
    finalSuccessCriteria: ["Diagnostics remain read-only."],
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
  const root = await temporaryDirectory(`ca-autopilot-doctor-${workflowSequence}-`);
  const repositoryPath = path.join(root, "checkout with spaces");
  const remotePath = path.join(root, "remote repository.git");
  await mkdir(repositoryPath);
  await mkdir(remotePath);
  const repository = await realpath(repositoryPath);
  const remote = await realpath(remotePath);
  await runGit(repository, ["init", "-q", "-b", "main"]);
  await runGit(repository, ["config", "--local", "user.name", "Autopilot Doctor Test"]);
  await runGit(repository, ["config", "--local", "user.email", "doctor@example.invalid"]);
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

  const workflowId = `workflow-doctor-${workflowSequence.toString().padStart(3, "0")}`;
  const selected = getPlatformServices();
  const branchManager = new WorkflowBranchManager({
    remoteTransport: localTransport(remote),
    platformServices: {
      os: selected.os,
      acquireCheckoutLock: selected.acquireCheckoutLock.bind(selected),
      canonicalizePath: selected.canonicalizePath.bind(selected),
      getProcessStartToken: async pid => pid === process.pid ? CURRENT_PROCESS_TOKEN : null,
    },
  });
  const branch = await branchManager.create({
    checkoutPath: repository,
    workflowId,
    topic: "autopilot-doctor",
    remote: "origin",
    baseBranch: "main",
  });
  const store = new WorkflowStore(workflowId, {
    stateDirectory: process.env.CLAUDE_PLUGIN_DATA,
    now: () => "2026-07-21T18:01:00.000Z",
    isProcessAlive: pid => pid === process.pid,
    getProcessStartToken: async pid => pid === process.pid ? CURRENT_PROCESS_TOKEN : null,
  });
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
    completion: { spec: autopilotSpec(), branch },
  });
  return { repository, branchManager, branch, store };
}

function ownershipPath(workflowId: string): string {
  return path.join(
    process.env.CLAUDE_PLUGIN_DATA!,
    "autopilot-branches",
    `${createHash("sha256").update(workflowId).digest("hex")}.json`,
  );
}

async function makeOwnersDead(fixture: Fixture): Promise<void> {
  const registrationPath = ownershipPath(fixture.branch.workflowId);
  const registration = JSON.parse(await readFile(registrationPath, "utf8")) as {
    bootstrapOwner: { pid: number; processToken: string | null };
  };
  registration.bootstrapOwner.pid = process.pid;
  registration.bootstrapOwner.processToken = STALE_PROCESS_TOKEN;
  await writeFile(registrationPath, `${JSON.stringify(registration)}\n`);
  await writeFile(fixture.store.ownerPath, `${JSON.stringify({
    workflowId: fixture.store.workflowId,
    pid: process.pid,
    processToken: STALE_PROCESS_TOKEN,
    acquiredAt: "2026-07-21T18:01:00.000Z",
  })}\n`);
}

function doctorPlatform(): PlatformServices {
  const selected = getPlatformServices();
  return {
    os: selected.os,
    resolveExecutable: async () => ({
      kind: "native",
      command: process.execPath,
      prefixArgs: [],
      resolvedFrom: "test",
    }),
    async spawnSupervised() { throw new Error("unexpected spawn"); },
    async requestCooperativeCancellation() { throw new Error("unexpected cancellation"); },
    async terminateProcessTree() { throw new Error("unexpected termination"); },
    async getProcessStartToken(pid) {
      return pid === process.pid ? CURRENT_PROCESS_TOKEN : null;
    },
    async terminateProcessTreeByPid() { throw new Error("unexpected termination"); },
    async acquireCheckoutLock() { throw new Error("unexpected checkout mutation"); },
    async createSecureTempDirectory() { throw new Error("unexpected temp directory"); },
    async canonicalizePath() { throw new Error("unexpected canonicalization"); },
  };
}

async function runDoctor() {
  return await doctor({
    ps: doctorPlatform(),
    env: {
      CLAUDE_PLUGIN_DATA: process.env.CLAUDE_PLUGIN_DATA,
      NODE_ENV: "test",
    },
    nodeVersion: "26.0.0",
    git: doctorGit,
    probeAll: async () => [],
    probeCowSupport: async () => ({ cowSupported: true, strategy: "clonefile" }),
    isProcessAlive: pid => pid === process.pid,
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
  await visit(await realpath(directory), "");
  return output;
}

beforeEach(async () => {
  workflowSequence = 0;
  for (const key of ["CLAUDE_PLUGIN_DATA", "CLAUDE_ARCHITECT_STATE_DIR", "NODE_ENV", ...GIT_ENVIRONMENT_KEYS]) {
    savedEnvironment.set(key, process.env[key]);
  }
  const stateRoot = await temporaryDirectory("ca-autopilot-doctor-state-");
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

describe("autopilot doctor diagnostics", () => {
  it("reports autopilot-lock-held for a live workflow lease", async () => {
    await createFixture();

    expect((await runDoctor()).issues).toContain("autopilot-lock-held");
  });

  it("reports autopilot-lock-leaked for a token-mismatched workflow lease", async () => {
    const fixture = await createFixture();
    await makeOwnersDead(fixture);

    expect((await runDoctor()).issues).toContain("autopilot-lock-leaked");
  });

  it("gives missing-registration worktree orphans precedence over branch mismatch", async () => {
    const fixture = await createFixture();
    await rm(ownershipPath(fixture.branch.workflowId));

    const issues = (await runDoctor()).issues;

    expect(issues).toContain("autopilot-worktree-orphaned");
    expect(issues).not.toContain("autopilot-branch-mismatch");
  });

  it("reports autopilot-branch-mismatch when Git contradicts the registration", async () => {
    const fixture = await createFixture();
    await runGit(fixture.branch.worktreePath, ["checkout", "-q", "--detach"]);

    expect((await runDoctor()).issues).toContain("autopilot-branch-mismatch");
  });

  it("reports autopilot-promotion-incomplete for an unfinished promotion intent", async () => {
    const fixture = await createFixture();
    let state = await fixture.store.read();
    state = await fixture.store.transition({ expectedRevision: state.revision, to: "running-task" });
    state = await fixture.store.transition({ expectedRevision: state.revision, to: "promoting-task" });
    await fixture.store.beginIntent({
      expectedRevision: state.revision,
      operation: "promote-candidate",
      idempotencyKey: "promote:task-1",
      expectedIdentities: { expectedHead: fixture.branch.baseCommitOid },
    });

    expect((await runDoctor()).issues).toContain("autopilot-promotion-incomplete");
  });

  it("reports bounded malformed state, journal, owner, and registration without disclosure", async () => {
    const stateFixture = await createFixture();
    const journalFixture = await createFixture();
    const ownerFixture = await createFixture();
    const registrationFixture = await createFixture();
    const secret = "sk-autopilot-doctor-secret";
    await writeFile(stateFixture.store.statePath, `{${secret}`);
    await writeFile(journalFixture.store.journalPath, `{${secret}`);
    await writeFile(ownerFixture.store.ownerPath, secret.repeat(80));
    await writeFile(
      ownershipPath(registrationFixture.branch.workflowId),
      secret.repeat(2_000),
    );

    const result = await runDoctor();

    expect(result.issues).toContain("autopilot-state-malformed");
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it("does not mutate any scanned workflow or Git bytes", async () => {
    const fixture = await createFixture();
    await makeOwnersDead(fixture);
    const stateBefore = await snapshot(process.env.CLAUDE_PLUGIN_DATA!);
    const repositoryBefore = await snapshot(fixture.repository);

    await runDoctor();

    expect(await snapshot(process.env.CLAUDE_PLUGIN_DATA!)).toEqual(stateBefore);
    expect(await snapshot(fixture.repository)).toEqual(repositoryBefore);
  });
});
