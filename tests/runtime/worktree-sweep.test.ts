import { createHash } from "node:crypto";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { git } from "../../src/git/git-exec.js";
import { WorkflowStore } from "../../src/autopilot/workflow-store.js";
import { WorktreeManager } from "../../src/runtime/worktree-manager.js";
import { getPlatformServices } from "../../src/platform/select-platform.js";
import { ArtifactStore } from "../../src/runtime/artifact-store.js";
import { platformServicesDouble } from "../helpers/platform-services-double.js";
import {
  recoverStaleRuns,
  type RecoveryDependencies,
} from "../../src/runtime/recovery-manager.js";

interface RepositoryFixture {
  directory: string;
  commonDir: string;
  head: string;
}

const temporaryPaths: string[] = [];
let previousPluginData: string | undefined;
let previousStateDirectory: string | undefined;
let previousNodeEnvironment: string | undefined;

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), prefix)));
  temporaryPaths.push(directory);
  return directory;
}

async function runGit(cwd: string, args: string[]): Promise<string> {
  const result = await git(cwd, args);
  expect(result.exitCode, result.stderr).toBe(0);
  return result.stdout.trim();
}

async function initRepo(pathLabel?: string): Promise<RepositoryFixture> {
  const parent = await temporaryDirectory("ca-worktree-sweep-repo-");
  const directory = pathLabel === undefined ? parent : path.join(parent, pathLabel);
  if (pathLabel !== undefined) await mkdir(directory);
  await runGit(directory, ["init", "-q"]);
  await runGit(directory, ["config", "--local", "user.name", "Worktree Sweep Test"]);
  await runGit(directory, [
    "config", "--local", "user.email", "worktree-sweep@example.invalid",
  ]);
  await writeFile(path.join(directory, "tracked.txt"), "base\n");
  await runGit(directory, ["add", "tracked.txt"]);
  await runGit(directory, ["commit", "-q", "-m", "base"]);
  const commonDir = await runGit(directory, [
    "rev-parse", "--path-format=absolute", "--git-common-dir",
  ]);
  return {
    directory,
    commonDir: await realpath(commonDir),
    head: await runGit(directory, ["rev-parse", "HEAD"]),
  };
}

async function expectMissing(filename: string): Promise<void> {
  await expect(access(filename)).rejects.toMatchObject({ code: "ENOENT" });
}

async function createWorkflowWorktree(
  repo: RepositoryFixture,
  workflowId: string,
): Promise<{ path: string; cleanup(): Promise<void> }> {
  const hash = createHash("sha256").update(workflowId).digest("hex");
  const branch = `feat/${workflowId}`;
  await runGit(repo.directory, ["branch", branch, repo.head]);
  return await new WorktreeManager(
    repo.directory,
    `workflow-${hash.slice(0, 32)}`,
  ).createAttached(branch, repo.head);
}

async function writeWorkflowOwnership(
  repo: RepositoryFixture,
  workflowId: string,
  worktreePath: string,
  valid: boolean,
): Promise<void> {
  const hash = createHash("sha256").update(workflowId).digest("hex");
  const ownershipRoot = path.join(process.env.CLAUDE_PLUGIN_DATA!, "autopilot-branches");
  await mkdir(ownershipRoot, { recursive: true });
  const ownershipPath = path.join(ownershipRoot, `${hash}.json`);
  if (!valid) {
    await writeFile(ownershipPath, "{\"ownershipVersion\":\"invalid\"}\n");
    return;
  }
  const branch = `feat/${workflowId}`;
  const worktreeGitDir = await realpath(await runGit(worktreePath, [
    "rev-parse", "--path-format=absolute", "--git-dir",
  ]));
  await writeFile(ownershipPath, `${JSON.stringify({
    ownershipVersion: "1",
    workflowId,
    checkoutPath: repo.directory,
    gitCommonDir: repo.commonDir,
    repositoryIdentity: repo.commonDir,
    worktreePath,
    worktreeGitDir,
    branch,
    branchRef: `refs/heads/${branch}`,
    baseRef: `refs/claude-architect/autopilot/${workflowId}/base`,
    baseBranch: "main",
    baseCommitOid: repo.head,
    remote: "origin",
    remoteUrl: "https://github.com/example/project.git",
    ownerRepo: "example/project",
    bootstrapOwner: {
      workflowId,
      pid: 424_242,
      processToken: "dead-owner-token",
      createdAt: "2026-08-02T12:00:00.000Z",
    },
  })}\n`);
}

async function createNonterminalWorkflowState(
  repo: RepositoryFixture,
  workflowId: string,
  worktreePath: string,
): Promise<WorkflowStore> {
  const timestamp = "2026-08-02T12:00:00.000Z";
  const store = new WorkflowStore(workflowId, {
    stateDirectory: process.env.CLAUDE_PLUGIN_DATA!,
    isProcessAlive: () => false,
    getProcessStartToken: async () => null,
    now: () => timestamp,
  });
  await store.create({
    stateVersion: "2",
    workflowId,
    repositoryIdentity: repo.commonDir,
    baseCommitOid: repo.head,
    workflowRef: `refs/heads/feat/${workflowId}`,
    worktreePath,
    autopilotSpecHash: "a".repeat(64),
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
    branch: `feat/${workflowId}`,
    cleanup: null,
    terminal: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  return store;
}

async function createTerminalWorkflowWithUnverifiableOwner(
  repo: RepositoryFixture,
  workflowId: string,
  worktreePath: string,
): Promise<WorkflowStore> {
  const timestamp = "2026-08-02T12:00:00.000Z";
  const options = {
    stateDirectory: process.env.CLAUDE_PLUGIN_DATA!,
    isProcessAlive: (pid: number) => pid === process.pid,
    getProcessStartToken: async () => "fixture-owner-token",
    now: () => timestamp,
  };
  const store = new WorkflowStore(workflowId, options);
  await store.create({
    stateVersion: "2",
    workflowId,
    repositoryIdentity: repo.commonDir,
    baseCommitOid: repo.head,
    workflowRef: `refs/heads/feat/${workflowId}`,
    worktreePath,
    autopilotSpecHash: "a".repeat(64),
    revision: 0,
    phase: "preflighting",
    currentTaskIndex: 0,
    tasks: [{
      id: "terminal-task",
      runId: null,
      candidateManifestHash: null,
      eligibilityHash: null,
      promotionCommitOid: null,
      status: "pending",
    }],
    intentJournal: { ref: "journal.ndjson", entryCount: 0, lastEntryHash: null },
    finalGate: null,
    branch: `feat/${workflowId}`,
    cleanup: null,
    terminal: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  await store.acquireLease();
  await store.transition({
    expectedRevision: 0,
    to: "cancelled",
    update(draft) {
      draft.terminal = {
        classification: "cancelled",
        reason: "terminal fixture",
        evidenceRefs: [],
        completedAt: timestamp,
      };
    },
  });
  await store.releaseLease();
  const unverifiable = new WorkflowStore(workflowId, {
    ...options,
    getProcessStartToken: async () => null,
  });
  await unverifiable.acquireLease();
  return unverifiable;
}

async function createRecoveryRun(
  repo: RepositoryFixture,
  runId: string,
  terminal: boolean,
): Promise<ArtifactStore> {
  const store = new ArtifactStore(runId);
  await mkdir(store.runDirectory, { recursive: true });
  await writeFile(path.join(store.runDirectory, "run-start.json"), `${JSON.stringify({
    runId,
    lockKey: createHash("sha256").update(repo.commonDir).digest("hex"),
    canonicalCommonDir: repo.commonDir,
    pid: null,
    processToken: null,
    startedAt: "2026-08-02T12:00:00.000Z",
  })}\n`);
  if (terminal) await writeTerminalResult(store, runId);
  return store;
}

async function writeTerminalResult(store: ArtifactStore, runId: string): Promise<void> {
  await store.writeResult({
    resultVersion: "1",
    runId,
    status: "failed",
    failure: "producer-failure",
    summary: "preserved sweep state",
    producerSummary: null,
    candidate: null,
    requestedVerification: [],
    executedVerification: [],
    unresolvedIssues: [],
    evidence: {},
    logsRef: "logs/producer.log",
    producerId: null,
    producerVersion: null,
    producerModel: null,
    durationMs: 1,
    sessionId: null,
  });
}

async function writeCheckoutOwner(repo: RepositoryFixture, contents: string): Promise<string> {
  const lockPath = path.join(
    process.env.CLAUDE_PLUGIN_DATA!,
    "locks",
    `${createHash("sha256").update(repo.commonDir).digest("hex")}.lock`,
  );
  await mkdir(path.dirname(lockPath), { recursive: true });
  await writeFile(lockPath, contents);
  return lockPath;
}

async function sourceFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await sourceFiles(filename));
    else if (entry.isFile() && filename.endsWith(".ts")) files.push(filename);
  }
  return files;
}

beforeEach(async () => {
  previousPluginData = process.env.CLAUDE_PLUGIN_DATA;
  previousStateDirectory = process.env.CLAUDE_ARCHITECT_STATE_DIR;
  previousNodeEnvironment = process.env.NODE_ENV;
  process.env.CLAUDE_PLUGIN_DATA = await temporaryDirectory("ca-worktree-sweep-state-");
  delete process.env.CLAUDE_ARCHITECT_STATE_DIR;
  process.env.NODE_ENV = "test";
});

afterEach(async () => {
  if (previousPluginData === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
  else process.env.CLAUDE_PLUGIN_DATA = previousPluginData;
  if (previousStateDirectory === undefined) delete process.env.CLAUDE_ARCHITECT_STATE_DIR;
  else process.env.CLAUDE_ARCHITECT_STATE_DIR = previousStateDirectory;
  if (previousNodeEnvironment === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = previousNodeEnvironment;
  await Promise.all(temporaryPaths.splice(0).map(directory =>
    rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })));
});

describe("startup worktree sweep", () => {
  it("removes every unclaimed registered leak class without a run record", async () => {
    const repo = await initRepo();
    const managedIds = [
      "recordless-run-preflight",
      "verify-recordless-run-salvage-pipeline",
      "baseline-00000000-0000-4000-8000-000000000000",
      "recordless-run",
    ];
    const worktrees = [];
    for (const managedId of managedIds) {
      worktrees.push(await new WorktreeManager(repo.directory, managedId).create(repo.head));
    }
    const lockPath = path.join(
      process.env.CLAUDE_PLUGIN_DATA!,
      "locks",
      `${createHash("sha256").update(repo.commonDir).digest("hex")}.lock`,
    );
    let pruneOutsideLease = false;
    await expect(recoverStaleRuns({
      git: async (cwd, args, options) => {
        if (args[0] === "worktree" && args[1] === "prune") {
          try { await access(lockPath); }
          catch { pruneOutsideLease = true; }
        }
        return await git(cwd, args, options);
      },
    })).resolves.toEqual({ recovered: [], quarantined: [] });

    expect(pruneOutsideLease).toBe(false);
    await Promise.all(worktrees.map(worktree => expectMissing(worktree.path)));
    const listed = await git(repo.directory, ["worktree", "list", "--porcelain"]);
    expect(listed.exitCode, listed.stderr).toBe(0);
    for (const worktree of worktrees) expect(listed.stdout).not.toContain(worktree.path);
  });

  it.runIf(process.platform !== "win32")(
    "migrates a legacy public managed namespace before sweeping an orphan",
    async () => {
      const repo = await initRepo();
      const worktreesRoot = path.join(process.env.CLAUDE_PLUGIN_DATA!, "worktrees");
      const worktreePath = path.join(worktreesRoot, "orphan-in-public-root");
      await mkdir(worktreesRoot, { mode: 0o700 });
      await runGit(repo.directory, ["worktree", "add", "--detach", worktreePath, repo.head]);
      await chmod(worktreesRoot, 0o755);

      await expect(recoverStaleRuns()).resolves.toEqual({
        recovered: [],
        quarantined: [],
      });
      expect((await stat(worktreesRoot)).mode & 0o077).toBe(0);
      await expectMissing(worktreePath);
      expect(await runGit(repo.directory, ["worktree", "list", "--porcelain"]))
        .not.toContain(worktreePath);
    },
  );

  it.runIf(process.platform !== "win32")(
    "rejects a group-writable state root before trusting recovery records",
    async () => {
      const sentinel = path.join(process.env.CLAUDE_PLUGIN_DATA!, "untrusted-record.json");
      await writeFile(sentinel, "preserve\n");
      await chmod(process.env.CLAUDE_PLUGIN_DATA!, 0o770);

      try {
        await expect(recoverStaleRuns()).rejects.toThrow("writable by another principal");
        await expect(readFile(sentinel, "utf8")).resolves.toBe("preserve\n");
      } finally {
        await chmod(process.env.CLAUDE_PLUGIN_DATA!, 0o700);
      }
    },
  );

  it("preserves an unregistered state directory nested inside a Git checkout", async () => {
    const repo = await initRepo();
    const nestedState = path.join(repo.directory, "plugin-state");
    const worktreePath = path.join(nestedState, "worktrees", "nested-plain-directory");
    const sentinel = path.join(worktreePath, "sentinel.txt");
    await mkdir(nestedState, { mode: 0o700 });
    await mkdir(path.join(nestedState, "worktrees"), { mode: 0o700 });
    await mkdir(worktreePath, { mode: 0o700 });
    await writeFile(sentinel, "preserve nested bytes\n");
    process.env.CLAUDE_PLUGIN_DATA = nestedState;

    await expect(recoverStaleRuns()).resolves.toMatchObject({
      recovered: [],
      quarantined: [],
      worktreeSweepIssues: [{
        worktreePath,
        reason: expect.stringContaining("repository marker is missing"),
      }],
    });
    await expect(readFile(sentinel, "utf8")).resolves.toBe("preserve nested bytes\n");
  });

  it.each([
    "incomplete-creation",
    ".remove-forged-00000000-0000-4000-8000-000000000001",
  ])("preserves an ambiguous managed directory named %s", async managedId => {
    const worktreePath = path.join(
      process.env.CLAUDE_PLUGIN_DATA!,
      "worktrees",
      managedId,
    );
    const sentinel = path.join(worktreePath, "sentinel.txt");
    await mkdir(path.dirname(worktreePath), { mode: 0o700 });
    await mkdir(worktreePath, { mode: 0o700 });
    await writeFile(sentinel, "preserve ambiguous bytes\n");

    await expect(recoverStaleRuns()).resolves.toMatchObject({
      recovered: [],
      quarantined: [],
      worktreeSweepIssues: [{
        worktreePath,
        reason: expect.stringMatching(/repository marker/iu),
      }],
    });

    await expect(readFile(sentinel, "utf8")).resolves.toBe("preserve ambiguous bytes\n");
  });

  it("reports and preserves non-directory managed-namespace entries", async () => {
    const worktreesRoot = path.join(process.env.CLAUDE_PLUGIN_DATA!, "worktrees");
    const unexpected = path.join(worktreesRoot, "forged-entry");
    await mkdir(worktreesRoot, { mode: 0o700 });
    await writeFile(unexpected, "preserve\n");

    await expect(recoverStaleRuns()).resolves.toMatchObject({
      recovered: [],
      quarantined: [],
      worktreeSweepIssues: [{
        worktreePath: unexpected,
        reason: expect.stringContaining("non-directory entry"),
      }],
    });
    await expect(readFile(unexpected, "utf8")).resolves.toBe("preserve\n");
  });

  it.skipIf(process.platform === "win32")(
    "sweeps registered worktrees through newline and Unicode paths",
    async () => {
      const stateParent = await temporaryDirectory("ca-worktree-sweep-state-parent-");
      const stateRoot = path.join(stateParent, "state\n雪");
      await mkdir(stateRoot);
      process.env.CLAUDE_PLUGIN_DATA = stateRoot;
      const repo = await initRepo("repository\n雪");
      const worktree = await new WorktreeManager(
        repo.directory,
        "recordless-unicode-path",
      ).create(repo.head);

      await expect(recoverStaleRuns()).resolves.toEqual({ recovered: [], quarantined: [] });

      await expectMissing(worktree.path);
      const listed = await git(repo.directory, ["worktree", "list", "--porcelain", "-z"]);
      expect(listed.exitCode, listed.stderr).toBe(0);
      expect(listed.stdout.split("\0")).not.toContain(`worktree ${worktree.path}`);
    },
  );

  it.skipIf(process.platform === "win32")(
    "canonicalizes an aliased porcelain path before removing its exact registration",
    async () => {
      const repo = await initRepo();
      const worktree = await new WorktreeManager(
        repo.directory,
        "aliased-registration-path",
      ).create(repo.head);
      const aliasRoot = path.join(await temporaryDirectory("ca-worktree-alias-"), "worktrees");
      await symlink(path.dirname(worktree.path), aliasRoot, "dir");
      const aliasedPath = path.join(aliasRoot, path.basename(worktree.path));

      await expect(recoverStaleRuns({
        git: async (cwd, args, options) => {
          const result = await git(cwd, args, options);
          if (args[0] === "worktree" && args[1] === "list" && result.exitCode === 0) {
            return {
              ...result,
              stdout: result.stdout.split("\0").map(field =>
                field === `worktree ${worktree.path}` ? `worktree ${aliasedPath}` : field).join("\0"),
            };
          }
          return result;
        },
      })).resolves.toEqual({ recovered: [], quarantined: [] });

      await expectMissing(worktree.path);
      const listed = await git(repo.directory, ["worktree", "list", "--porcelain", "-z"]);
      expect(listed.exitCode, listed.stderr).toBe(0);
      expect(listed.stdout).not.toContain(worktree.path);
    },
  );

  it("skips a worktree while its repository checkout lease is held", async () => {
    const repo = await initRepo();
    const worktree = await new WorktreeManager(repo.directory, "live-leased-run").create(repo.head);
    const lockPath = path.join(
      process.env.CLAUDE_PLUGIN_DATA!,
      "locks",
      `${createHash("sha256").update(repo.commonDir).digest("hex")}.lock`,
    );
    await mkdir(path.dirname(lockPath), { recursive: true });
    await writeFile(lockPath, JSON.stringify({
      pid: process.pid,
      processToken: "live-checkout-owner",
    }));
    try {
      await expect(recoverStaleRuns({
        platformServices: platformServicesDouble({
          os: getPlatformServices().os,
          async getProcessStartToken(pid) {
            return pid === process.pid ? "live-checkout-owner" : null;
          },
          async terminateProcessTreeByPid() {},
        }),
        isProcessAlive: pid => pid === process.pid,
      })).resolves.toEqual({ recovered: [], quarantined: [] });
      await expect(access(worktree.path)).resolves.toBeUndefined();
    } finally {
      await rm(lockPath, { force: true });
      await worktree.cleanup();
    }
  });

  it("reports malformed checkout ownership and preserves the worktree", async () => {
    const repo = await initRepo();
    const worktree = await new WorktreeManager(repo.directory, "malformed-lease-run").create(repo.head);
    const lockPath = await writeCheckoutOwner(repo, "{not-json\n");
    try {
      await expect(recoverStaleRuns()).resolves.toMatchObject({
        recovered: [],
        quarantined: [],
        worktreeSweepIssues: [{
          worktreePath: worktree.path,
          reason: expect.stringContaining("malformed checkout lease owner"),
        }],
      });
      await expect(access(worktree.path)).resolves.toBeUndefined();
    } finally {
      await rm(lockPath, { force: true });
      await worktree.cleanup();
    }
  });

  it("preserves unclaimed workflow worktrees while any ownership record is malformed", async () => {
    const repo = await initRepo();
    const validId = "workflow-sweep-valid";
    const invalidId = "workflow-sweep-invalid";
    const missingId = "workflow-sweep-missing";
    const valid = await createWorkflowWorktree(repo, validId);
    const invalid = await createWorkflowWorktree(repo, invalidId);
    const missing = await createWorkflowWorktree(repo, missingId);
    await writeWorkflowOwnership(repo, validId, valid.path, true);
    await writeWorkflowOwnership(repo, missingId, missing.path, true);
    const ownershipRoot = path.join(process.env.CLAUDE_PLUGIN_DATA!, "autopilot-branches");
    const missingOwnership = path.join(
      ownershipRoot,
      `${createHash("sha256").update(missingId).digest("hex")}.json`,
    );
    const invalidOwnership = path.join(
      ownershipRoot,
      `${createHash("sha256").update(invalidId).digest("hex")}.json`,
    );
    const malformed = JSON.parse(await readFile(missingOwnership, "utf8"));
    malformed.unexpected = true;
    await writeFile(invalidOwnership, `${JSON.stringify(malformed)}\n`);
    await rm(missingOwnership);

    const result = await recoverStaleRuns();
    expect(result).toMatchObject({ recovered: [], quarantined: [] });
    expect(result.worktreeSweepIssues).toHaveLength(3);
    expect(result.worktreeSweepIssues).toEqual(expect.arrayContaining(
      [valid.path, invalid.path, missing.path].map(worktreePath => ({
        worktreePath,
        reason: expect.stringMatching(/ownership.*ambiguous.*malformed/iu),
      })),
    ));

    await expect(access(valid.path)).resolves.toBeUndefined();
    await expect(access(invalid.path)).resolves.toBeUndefined();
    await expect(access(missing.path)).resolves.toBeUndefined();
    // One checkout lease serializes these; concurrent cleanups can exceed its
    // acquisition timeout on a loaded host.
    for (const worktree of [valid, invalid, missing]) await worktree.cleanup();
  });

  it("sweeps stale modern and legacy final-review materializations", async () => {
    const repo = await initRepo();
    const workflowId = "workflow-sweep-final-materialization";
    const workflowHash = createHash("sha256").update(workflowId).digest("hex");
    const legacyHash = createHash("sha256")
      .update(JSON.stringify(workflowId)).digest("hex");
    const primary = await createWorkflowWorktree(repo, workflowId);
    const modernFinal = await new WorktreeManager(
      repo.directory,
      `workflow-${workflowHash.slice(0, 32)}-final`,
    ).create(repo.head);
    const legacyFinal = await new WorktreeManager(
      repo.directory,
      `final-${legacyHash.slice(0, 24)}`,
    ).create(repo.head);
    await writeWorkflowOwnership(repo, workflowId, primary.path, true);
    await createNonterminalWorkflowState(repo, workflowId, primary.path);

    const result = await recoverStaleRuns({ isProcessAlive: () => false });
    expect(result).toMatchObject({ recovered: [], quarantined: [] });
    await expect(access(primary.path)).resolves.toBeUndefined();
    await expectMissing(modernFinal.path);
    await expectMissing(legacyFinal.path);
    await primary.cleanup();
  });

  it("sweeps terminal workflow worktrees whose durable owners are dead", async () => {
    const repo = await initRepo();
    const workflowId = "workflow-sweep-terminal-dead";
    const worktree = await createWorkflowWorktree(repo, workflowId);
    await writeWorkflowOwnership(repo, workflowId, worktree.path, true);
    const timestamp = "2026-08-02T12:00:00.000Z";
    const store = new WorkflowStore(workflowId, {
      stateDirectory: process.env.CLAUDE_PLUGIN_DATA!,
      isProcessAlive: () => false,
      getProcessStartToken: async () => null,
      now: () => timestamp,
    });
    await store.create({
      stateVersion: "2",
      workflowId,
      repositoryIdentity: repo.commonDir,
      baseCommitOid: repo.head,
      workflowRef: `refs/heads/feat/${workflowId}`,
      worktreePath: worktree.path,
      autopilotSpecHash: "a".repeat(64),
      revision: 0,
      phase: "preflighting",
      currentTaskIndex: 0,
      tasks: [{
        id: "terminal-task",
        runId: null,
        candidateManifestHash: null,
        eligibilityHash: null,
        promotionCommitOid: null,
        status: "pending",
      }],
      intentJournal: {
        ref: "journal.ndjson",
        entryCount: 0,
        lastEntryHash: null,
      },
      finalGate: null,
      branch: `feat/${workflowId}`,
      cleanup: null,
      terminal: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    await store.acquireLease();
    await store.transition({
      expectedRevision: 0,
      to: "cancelled",
      update(draft) {
        draft.terminal = {
          classification: "cancelled",
          reason: "terminal fixture",
          evidenceRefs: [],
          completedAt: timestamp,
        };
      },
    });
    await store.releaseLease();

    await expect(recoverStaleRuns()).resolves.toEqual({ recovered: [], quarantined: [] });

    await expectMissing(worktree.path);
    expect(await runGit(repo.directory, ["worktree", "list", "--porcelain"]))
      .not.toContain(worktree.path);
  });

  it("preserves a terminal workflow worktree with an unverifiable live owner", async () => {
    const repo = await initRepo();
    const workflowId = "workflow-sweep-terminal-unverifiable";
    const worktree = await createWorkflowWorktree(repo, workflowId);
    const store = await createTerminalWorkflowWithUnverifiableOwner(
      repo,
      workflowId,
      worktree.path,
    );

    try {
      await expect(recoverStaleRuns({
        isProcessAlive: pid => pid === process.pid,
        platformServices: platformServicesDouble({
          os: process.platform,
          getProcessStartToken: async () => null,
          async terminateProcessTreeByPid() {},
        }),
      })).resolves.toEqual({
        recovered: [],
        quarantined: [],
        workflows: [{ workflowId, disposition: "human-decision-required" }],
      });
      await expect(access(worktree.path)).resolves.toBeUndefined();
    } finally {
      await rm(store.ownerPath, { force: true });
      await worktree.cleanup();
    }
  });

  it("preserves a workflow worktree when its ownership record names a different path", async () => {
    const repo = await initRepo();
    const workflowId = "workflow-sweep-conflicting-path";
    const worktree = await createWorkflowWorktree(repo, workflowId);
    const externalRoot = await temporaryDirectory("ca-workflow-owner-conflict-");
    const external = path.join(externalRoot, "different-worktree");
    await runGit(repo.directory, ["worktree", "add", "--detach", external, repo.head]);
    await writeWorkflowOwnership(repo, workflowId, external, true);

    await expect(recoverStaleRuns()).resolves.toMatchObject({
      recovered: [],
      quarantined: [],
      worktreeSweepIssues: [{
        worktreePath: worktree.path,
        reason: expect.stringMatching(/ownership.*different worktree/iu),
      }],
    });

    await expect(access(worktree.path)).resolves.toBeUndefined();
  });

  it("preserves workflow worktrees when the ownership directory has a malformed filename", async () => {
    const repo = await initRepo();
    const workflowId = "workflow-sweep-renamed-owner";
    const worktree = await createWorkflowWorktree(repo, workflowId);
    await writeWorkflowOwnership(repo, workflowId, worktree.path, true);
    const ownershipRoot = path.join(process.env.CLAUDE_PLUGIN_DATA!, "autopilot-branches");
    const ownershipName = `${createHash("sha256").update(workflowId).digest("hex")}.json`;
    const malformedPath = path.join(ownershipRoot, `${"f".repeat(64)}.json`);
    await rename(path.join(ownershipRoot, ownershipName), malformedPath);

    try {
      await expect(recoverStaleRuns()).resolves.toMatchObject({
        recovered: [],
        quarantined: [],
        worktreeSweepIssues: [{
          worktreePath: worktree.path,
          reason: expect.stringMatching(/ownership.*filename/iu),
        }],
      });
      await expect(access(worktree.path)).resolves.toBeUndefined();
    } finally {
      await rm(malformedPath, { force: true });
      try { await worktree.cleanup(); } catch { /* repository fixture is removed by afterEach */ }
    }
  });

  it("rechecks workflow ownership under the repository lease before sweeping", async () => {
    const repo = await initRepo();
    const workflowId = "workflow-sweep-published-during-scan";
    const worktree = await createWorkflowWorktree(repo, workflowId);
    let published = false;

    await expect(recoverStaleRuns({
      git: async (cwd, args, options) => {
        const result = await git(cwd, args, options);
        if (!published
          && path.resolve(cwd) === path.resolve(worktree.path)
          && args[0] === "rev-parse"
          && args.includes("--git-common-dir")) {
          published = true;
          await writeWorkflowOwnership(repo, workflowId, worktree.path, true);
        }
        return result;
      },
    })).resolves.toEqual({ recovered: [], quarantined: [] });

    expect(published).toBe(true);
    await expect(access(worktree.path)).resolves.toBeUndefined();
    await worktree.cleanup();
  });

  it("reports a lookup error and leaves the ambiguous worktree untouched", async () => {
    const repo = await initRepo();
    const worktree = await new WorktreeManager(repo.directory, "ambiguous-lookup").create(repo.head);

    const result = await recoverStaleRuns({
      git: async (cwd, args, options) => {
        if (path.resolve(cwd) === path.resolve(worktree.path)
          && args[0] === "rev-parse"
          && args.includes("--git-common-dir")) {
          throw new Error("forced worktree lookup failure");
        }
        return await git(cwd, args, options);
      },
    });

    expect(result).toMatchObject({
      recovered: [],
      quarantined: [],
      worktreeSweepIssues: [{
        worktreePath: worktree.path,
        reason: expect.stringContaining("forced worktree lookup failure"),
      }],
    });
    await expect(access(worktree.path)).resolves.toBeUndefined();
    await worktree.cleanup();
  });

  it("preserves a repository when Git reports a nonzero lookup result", async () => {
    const repo = await initRepo();
    const worktree = await new WorktreeManager(
      repo.directory,
      "nonzero-ambiguous-lookup",
    ).create(repo.head);

    const result = await recoverStaleRuns({
      git: async (cwd, args, options) => {
        if (path.resolve(cwd) === path.resolve(worktree.path)
          && args[0] === "rev-parse"
          && args.includes("--git-common-dir")) {
          return { exitCode: 1, stdout: "", stderr: "simulated transient Git failure" };
        }
        return await git(cwd, args, options);
      },
    });

    expect(result).toMatchObject({
      recovered: [],
      quarantined: [],
      worktreeSweepIssues: [{
        worktreePath: worktree.path,
        reason: expect.stringContaining("simulated transient Git failure"),
      }],
    });
    await expect(access(worktree.path)).resolves.toBeUndefined();
    await worktree.cleanup();
  });

  it("bounds ambiguous worktree diagnostics and records the omitted count", async () => {
    const worktreesRoot = path.join(process.env.CLAUDE_PLUGIN_DATA!, "worktrees");
    await mkdir(worktreesRoot, { recursive: true, mode: 0o700 });
    for (let index = 0; index < 105; index += 1) {
      await mkdir(path.join(worktreesRoot, `ambiguous-${index}`));
    }

    const result = await recoverStaleRuns({
      git: async () => { throw new Error("forced bulk lookup failure"); },
    });

    expect(result.worktreeSweepIssues).toHaveLength(100);
    expect(result.worktreeSweepIssues?.at(-1)).toEqual({
      worktreePath: worktreesRoot,
      reason: "6 additional worktree sweep issues omitted",
    });
  });

  it("removes a missing run worktree's exact stale registration", async () => {
    const repo = await initRepo();
    const runId = "sweep-missing-physical-worktree";
    await createRecoveryRun(repo, runId, false);
    const worktree = await new WorktreeManager(repo.directory, runId).create(repo.head);
    await rm(worktree.path, { recursive: true });

    await expect(recoverStaleRuns({ isProcessAlive: () => false })).resolves.toEqual({
      recovered: [runId],
      quarantined: [],
    });

    const listed = await git(repo.directory, ["worktree", "list", "--porcelain", "-z"]);
    expect(listed.exitCode, listed.stderr).toBe(0);
    expect(listed.stdout).not.toContain(worktree.path);
  });

  it("sweeps an orphan in a checkout namespace and leaves user worktrees beside it", async () => {
    const repo = await initRepo();
    const userWorktree = path.join(repo.directory, ".worktrees", "user-feature");
    await runGit(repo.directory, ["worktree", "add", "-q", "--detach", userWorktree, repo.head]);
    const orphan = await new WorktreeManager(repo.directory, "namespace-orphan").create(repo.head);

    await expect(recoverStaleRuns({ isProcessAlive: () => false })).resolves.toEqual({
      recovered: [],
      quarantined: [],
    });

    await expectMissing(orphan.path);
    const listed = await git(repo.directory, ["worktree", "list", "--porcelain", "-z"]);
    expect(listed.stdout).not.toContain(orphan.path);
    expect(listed.stdout).toContain(await realpath(userWorktree));
    await expect(readFile(
      path.join(repo.directory, ".worktrees", "claude-architect", ".gitignore"),
      "utf8",
    )).resolves.toBe("*\n");
  });

  it("removes stale registrations when the entire managed worktree root vanished", async () => {
    const repo = await initRepo();
    const runId = "sweep-missing-worktree-root";
    await createRecoveryRun(repo, runId, false);
    const worktree = await new WorktreeManager(repo.directory, runId).create(repo.head);
    await rm(path.dirname(worktree.path), { recursive: true });

    await expect(recoverStaleRuns({ isProcessAlive: () => false })).resolves.toEqual({
      recovered: [runId],
      quarantined: [],
    });

    const listed = await git(repo.directory, ["worktree", "list", "--porcelain", "-z"]);
    expect(listed.exitCode, listed.stderr).toBe(0);
    expect(listed.stdout).not.toContain(worktree.path);
  });

  it("removes a terminal run's stale registration when no pipeline owner remains", async () => {
    const repo = await initRepo();
    const runId = "sweep-terminal-missing-worktree";
    await createRecoveryRun(repo, runId, true);
    const worktree = await new WorktreeManager(repo.directory, runId).create(repo.head);
    await rm(worktree.path, { recursive: true });

    await expect(recoverStaleRuns({ isProcessAlive: () => false })).resolves.toEqual({
      recovered: [],
      quarantined: [],
    });

    const listed = await git(repo.directory, ["worktree", "list", "--porcelain", "-z"]);
    expect(listed.exitCode, listed.stderr).toBe(0);
    expect(listed.stdout).not.toContain(worktree.path);
  });

  it("does not reclaim or poison runs while a removal manifest is unresolved", async () => {
    const repo = await initRepo();
    const runId = "sweep-pending-removal-issue";
    const store = await createRecoveryRun(repo, runId, false);
    const worktree = await new WorktreeManager(repo.directory, runId).create(repo.head);
    const manifestRoot = path.join(process.env.CLAUDE_PLUGIN_DATA!, "worktree-removals");
    const manifestPath = path.join(
      manifestRoot,
      "00000000-0000-4000-8000-000000000404.json",
    );
    await mkdir(manifestRoot, { recursive: true, mode: 0o700 });
    await writeFile(manifestPath, "{\n");

    try {
      await expect(recoverStaleRuns({ isProcessAlive: () => false })).resolves.toMatchObject({
        recovered: [],
        quarantined: [],
        worktreeSweepIssues: [{
          worktreePath: manifestPath,
          reason: expect.stringContaining("manifest is invalid JSON"),
        }],
      });
      await expect(access(worktree.path)).resolves.toBeUndefined();
      await expect(store.readResult()).resolves.toBeNull();
    } finally {
      await rm(manifestPath, { force: true });
      try { await recoverStaleRuns({ isProcessAlive: () => false }); } catch { /* fixture cleanup */ }
    }
  });

  it.each([
    "terminal-published-after-scan",
    "terminal-cleanup-deferred-by-empty-owner",
    "terminal-marker-revalidated-live",
    "terminal-live-owner",
    "unfinished-empty-checkout-owner",
  ] as const)("preserves a run worktree in the %s state", async state => {
    const repo = await initRepo();
    const runId = `sweep-${state}`;
    const terminal = state !== "terminal-published-after-scan"
      && state !== "unfinished-empty-checkout-owner";
    const store = await createRecoveryRun(repo, runId, terminal);
    const managedId = state === "terminal-published-after-scan"
      || state === "unfinished-empty-checkout-owner"
      ? runId
      : `${runId}-pipeline`;
    const worktree = await new WorktreeManager(repo.directory, managedId).create(repo.head);
    let dependencies: RecoveryDependencies = {};

    if (state === "terminal-published-after-scan") {
      const owner = { pid: 9701, processToken: "darwin:stale-checkout" };
      await writeCheckoutOwner(repo, JSON.stringify(owner));
      let published = false;
      dependencies = {
        platformServices: platformServicesDouble({
          os: "darwin",
          async getProcessStartToken(pid) {
            if (pid === owner.pid) {
              if (!published) {
                published = true;
                await writeTerminalResult(store, runId);
              }
              return "darwin:replacement-checkout";
            }
            return "darwin:self";
          },
          async terminateProcessTreeByPid() {},
        }),
        isProcessAlive: pid => pid === owner.pid,
      };
    } else if (state === "terminal-cleanup-deferred-by-empty-owner") {
      await store.writePipelineActiveMarker({
        pid: 4242,
        processToken: "darwin:dead-pipeline",
        startedAt: "2026-08-02T12:01:00.000Z",
        sliced: false,
      });
      await writeCheckoutOwner(repo, "");
      dependencies = { isProcessAlive: () => false };
    } else if (state === "terminal-marker-revalidated-live") {
      await store.writePipelineActiveMarker({
        pid: 4242,
        processToken: "darwin:dead-pipeline",
        startedAt: "2026-08-02T12:01:00.000Z",
        sliced: false,
      });
      const checkoutOwner = { pid: 9401, processToken: "darwin:stale-checkout" };
      const liveOwner = { pid: 9402, processToken: "darwin:live-pipeline" };
      await writeCheckoutOwner(repo, JSON.stringify(checkoutOwner));
      dependencies = {
        platformServices: platformServicesDouble({
          os: "darwin",
          async getProcessStartToken(pid) {
            if (pid === checkoutOwner.pid) {
              await store.writePipelineActiveMarker({
                ...liveOwner,
                startedAt: "2026-08-02T12:02:00.000Z",
                sliced: false,
              });
              return "darwin:replacement-checkout";
            }
            return pid === liveOwner.pid ? liveOwner.processToken : "darwin:self";
          },
          async terminateProcessTreeByPid() {},
        }),
        isProcessAlive: pid => pid === checkoutOwner.pid || pid === liveOwner.pid,
      };
    } else if (state === "terminal-live-owner") {
      await store.writePipelineActiveMarker({
        pid: 4243,
        processToken: null,
        startedAt: "2026-08-02T12:01:00.000Z",
        sliced: false,
      });
      dependencies = {
        platformServices: platformServicesDouble({
          os: "darwin",
          async getProcessStartToken() { return null; },
          async terminateProcessTreeByPid() {},
        }),
        isProcessAlive: pid => pid === 4243,
      };
    } else {
      await writeCheckoutOwner(repo, "");
    }

    await expect(recoverStaleRuns(dependencies)).resolves.toEqual({
      recovered: [],
      quarantined: [],
    });
    await expect(access(worktree.path)).resolves.toBeUndefined();
  }, 120_000);

  it("preserves a verified live run when its checkout lock entry vanished", async () => {
    const repo = await initRepo();
    const runId = "live-run-missing-checkout-lock";
    const pid = 42_424;
    const processToken = "darwin:live-run-token";
    const store = await createRecoveryRun(repo, runId, false);
    await writeFile(path.join(store.runDirectory, "run-start.json"), `${JSON.stringify({
      runId,
      lockKey: createHash("sha256").update(repo.commonDir).digest("hex"),
      canonicalCommonDir: repo.commonDir,
      pid,
      processToken,
      startedAt: "2026-08-02T12:00:00.000Z",
    })}\n`);
    const worktree = await new WorktreeManager(
      repo.directory,
      `${runId}-preflight`,
    ).create(repo.head);
    let terminated = false;

    await expect(recoverStaleRuns({
      platformServices: platformServicesDouble({
        os: "darwin",
        async getProcessStartToken(observedPid) {
          return observedPid === pid ? processToken : "darwin:recovery-token";
        },
        async terminateProcessTreeByPid() { terminated = true; },
      }),
      isProcessAlive: observedPid => observedPid === pid,
    })).resolves.toEqual({ recovered: [], quarantined: [] });

    expect(terminated).toBe(false);
    await expect(access(worktree.path)).resolves.toBeUndefined();
  });

  it("does not let a stale run prefix claim another known run's worktree", async () => {
    const repo = await initRepo();
    await createRecoveryRun(repo, "run", false);
    const protectedStore = await createRecoveryRun(repo, "run-repair", true);
    await protectedStore.writePipelineActiveMarker({
      pid: 4243,
      processToken: null,
      startedAt: "2026-08-02T12:01:00.000Z",
      sliced: false,
    });
    const protectedWorktree = await new WorktreeManager(
      repo.directory,
      "run-repair-pipeline",
    ).create(repo.head);
    const staleWorktree = await new WorktreeManager(
      repo.directory,
      "run-preflight",
    ).create(repo.head);

    await expect(recoverStaleRuns({
      platformServices: platformServicesDouble({
        os: "darwin",
        async getProcessStartToken() { return null; },
        async terminateProcessTreeByPid() {},
      }),
      isProcessAlive: pid => pid === 4243,
    })).resolves.toEqual({ recovered: ["run"], quarantined: [] });

    await expect(access(protectedWorktree.path)).resolves.toBeUndefined();
    await expect(access(staleWorktree.path)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(protectedStore.readPipelineActiveMarker()).resolves.not.toBeNull();
  });

  it("claims a run missing its start record and preserves its worktree", async () => {
    const repo = await initRepo();
    const runId = "sweep-missing-run-record";
    const store = new ArtifactStore(runId);
    await mkdir(store.runDirectory, { recursive: true });
    const worktree = await new WorktreeManager(repo.directory, runId).create(repo.head);

    await expect(recoverStaleRuns()).resolves.toEqual({
      recovered: [],
      quarantined: [],
    });
    await expect(access(worktree.path)).resolves.toBeUndefined();

    await expect(recoverStaleRuns()).resolves.toEqual({ recovered: [], quarantined: [] });
    await expect(access(worktree.path)).resolves.toBeUndefined();
  });

  it("preserves every unreadable run worktree class across later recovery passes", async () => {
    const repo = await initRepo();
    const runId = "sweep-unreadable-run-record";
    const store = await createRecoveryRun(repo, runId, false);
    const managedIds = [
      runId,
      `${runId}-salvage-verify`,
      `verify-${runId}-salvage-pipeline`,
      `${runId}-future-stage`,
      `baseline-${runId}-future-stage`,
      `verify-${runId}-future-stage`,
    ];
    const worktrees = [];
    for (const managedId of managedIds) {
      worktrees.push(await new WorktreeManager(repo.directory, managedId).create(repo.head));
    }
    await writeFile(path.join(store.runDirectory, "run-start.json"), "{\n");

    await expect(recoverStaleRuns()).resolves.toEqual({
      recovered: [],
      quarantined: [runId],
    });
    await Promise.all(worktrees.map(async worktree =>
      await expect(access(worktree.path)).resolves.toBeUndefined()));

    await expect(recoverStaleRuns()).resolves.toEqual({ recovered: [], quarantined: [] });
    await Promise.all(worktrees.map(async worktree =>
      await expect(access(worktree.path)).resolves.toBeUndefined()));
  });
});

describe("worktree lease coverage", () => {
  it("pins every WorktreeManager creation call site to the audited lease policy", async () => {
    const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));
    const calls: string[] = [];
    for (const filename of await sourceFiles(path.join(repositoryRoot, "src"))) {
      const source = await readFile(filename, "utf8");
      if (!source.includes("worktree-manager.js")) continue;
      for (const line of source.split("\n")) {
        // `withManagedWorktree` creates a worktree on its caller's behalf, so a
        // call to it is a creation site too. Without this the helper would hide
        // creations from the very inventory that exists to name them.
        const borrows = /\bwithManagedWorktree\s*\(/u.test(line)
          && !/\bfunction\s+withManagedWorktree/u.test(line);
        if (borrows) {
          calls.push(
            `${path.relative(repositoryRoot, filename).replaceAll(path.sep, "/")}#withManagedWorktree`,
          );
          continue;
        }
        if (!/\.create(?:Attached)?\s*\(/u.test(line) || line.includes("Object.create(")) continue;
        const method = line.match(/\.create(Attached)?\s*\(/u)?.[1] === "Attached"
          ? "createAttached"
          : "create";
        calls.push(`${path.relative(repositoryRoot, filename).replaceAll(path.sep, "/")}#${method}`);
      }
    }
    calls.sort();
    // This is an inventory tripwire, not the lease proof itself. Attempt and
    // pipeline suites prove temporary create-to-cleanup lifetime; the final-
    // branch reviewer suite proves the final-review case. The durable Autopilot
    // branch proves its create and cleanup transactions independently under
    // leases in branch-manager tests.
    const instructions = "A new WorktreeManager create call needs a behavioral lease-lifetime "
      + "test for its ownership model, then must be added to this audited inventory.";
    expect(calls, instructions).toHaveLength(10);
    expect(calls, instructions).toEqual([
      "src/autopilot/branch-manager.ts#createAttached",
      "src/autopilot/final-branch-reviewer.ts#create",
      "src/pipeline/candidate-verifier.ts#withManagedWorktree",
      "src/pipeline/pipeline-runtime.ts#withManagedWorktree",
      "src/pipeline/slice-runner.ts#withManagedWorktree",
      "src/pipeline/slice-runner.ts#withManagedWorktree",
      "src/runtime/attempt-runtime.ts#create",
      "src/runtime/producer-preflight.ts#create",
      "src/verify/baseline-verifier.ts#create",
      "src/verify/project-verifier.ts#create",
    ]);
  });
});
