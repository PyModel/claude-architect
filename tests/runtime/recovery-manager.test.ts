import { createHash } from "node:crypto";
import {
  access,
  link,
  mkdir,
  lstat,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { git } from "../../src/git/git-exec.js";
import { WorktreeManager } from "../../src/runtime/worktree-manager.js";
import { start } from "../../src/mcp/server.js";
import { CLEANUP_JOURNAL_LOCK_KEY } from "../../src/platform/posix-platform-services.js";
import { ArtifactStore } from "../../src/runtime/artifact-store.js";
import { recoverStaleRuns } from "../../src/runtime/recovery-manager.js";
import { buildRunManifest } from "../../src/runtime/run-manifest.js";
import { logger } from "../../src/util/logger.js";
import { platformServicesDouble } from "../helpers/platform-services-double.js";

const serverEvents = vi.hoisted(() => [] as string[]);

vi.mock("@modelcontextprotocol/sdk/server/mcp.js", () => ({
  McpServer: class {
    registerTool() {}
    async connect() { serverEvents.push("connect"); }
  },
}));
vi.mock("@modelcontextprotocol/sdk/server/stdio.js", () => ({
  StdioServerTransport: class {},
}));

// The interrupted-prune tests below perform real bound-directory cleanup, which
// routes through the host OS backend (lsof/df on darwin, /proc on linux, the
// native helper on win32) — so their platform mock must name the real host.
const hostOs = process.platform as "darwin" | "linux" | "win32";

const temporaryPaths: string[] = [];
let previousPluginData: string | undefined;
let previousDelegated: string | undefined;
let previousPluginRoot: string | undefined;

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), prefix));
  temporaryPaths.push(directory);
  return directory;
}

async function runGit(cwd: string, args: string[]): Promise<string> {
  const result = await git(cwd, args);
  expect(result.exitCode, result.stderr).toBe(0);
  return result.stdout.trim();
}

async function initRepo(): Promise<{ directory: string; commonDir: string; head: string }> {
  const directory = await realpath(await temporaryDirectory("ca-recovery-repo-"));
  await runGit(directory, ["init", "-q"]);
  await writeFile(path.join(directory, "tracked.txt"), "base\n");
  await runGit(directory, ["add", "-A"]);
  await runGit(directory, ["commit", "-q", "-m", "base"]);
  return {
    directory,
    commonDir: await realpath(path.join(directory, ".git")),
    head: await runGit(directory, ["rev-parse", "HEAD"]),
  };
}

async function expectMissing(filename: string): Promise<void> {
  await expect(access(filename)).rejects.toMatchObject({ code: "ENOENT" });
}

async function expectQuarantinedRun(
  runId: string,
  runDirectory: string,
  forbiddenText: string[] = [],
): Promise<string> {
  await expectMissing(runDirectory);
  await expect(access(path.join(path.dirname(runDirectory), `.poisoned-${runId}`)))
    .resolves.toBeUndefined();
  const journal = await readFile(
    path.join(path.dirname(runDirectory), "recovery-quarantine.ndjson"),
    "utf8",
  );
  const records = journal.trimEnd().split("\n");
  expect(records).toHaveLength(1);
  expect(Buffer.byteLength(records[0]!, "utf8")).toBeLessThanOrEqual(4_096);
  const record = JSON.parse(records[0]!) as { reason: string };
  expect(record).toMatchObject({
    event: "recovery-quarantine",
    runId,
  });
  expect(Buffer.byteLength(record.reason, "utf8")).toBeLessThanOrEqual(2_000);
  await expectMissing(path.join(path.dirname(runDirectory), "cleanup.ndjson"));
  for (const text of forbiddenText) expect(records[0]).not.toContain(text);
  return records[0]!;
}

async function createUnfinishedRun(
  runId: string,
  commonDir: string,
  pid: number | null,
  processToken: string | null = null,
): Promise<ArtifactStore> {
  const store = new ArtifactStore(runId);
  await mkdir(store.runDirectory, { recursive: true });
  const lockKey = createHash("sha256").update(commonDir).digest("hex");
  await writeFile(path.join(store.runDirectory, "run-start.json"), `${JSON.stringify({
    runId,
    lockKey,
    canonicalCommonDir: commonDir,
    pid,
    processToken,
    startedAt: "2026-07-14T12:00:00.000Z",
  })}\n`);
  return store;
}

async function createTerminalRun(
  runId: string,
  commonDir: string,
): Promise<ArtifactStore> {
  const store = await createUnfinishedRun(runId, commonDir, null);
  await store.writeResult({
    resultVersion: "1",
    runId,
    status: "failed",
    failure: "producer-failure",
    summary: "pipeline failed",
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
  return store;
}

function slicedManagedIds(runId: string): string[] {
  return [
    `${runId}-slice-1-attempt-0`,
    `${runId}-slice-1-attempt-0-review`,
    `${runId}-slice-1-attempt-0-verify`,
    `verify-${runId}-slice-1-attempt-0-pipeline`,
    `${runId}-composed-review`,
    `${runId}-final-verify`,
    `verify-${runId}-final-pipeline`,
  ];
}

async function createManagedWorktrees(
  repo: { directory: string; head: string },
  managedIds: string[],
): Promise<Array<{ path: string; cleanup(): Promise<void> }>> {
  const worktrees: Array<{ path: string; cleanup(): Promise<void> }> = [];
  for (const managedId of managedIds) {
    worktrees.push(await new WorktreeManager(repo.directory, managedId).create(repo.head));
  }
  return worktrees;
}

async function writeTerminalFailure(store: ArtifactStore, runId: string): Promise<void> {
  await store.writeResult({
    resultVersion: "1",
    runId,
    status: "failed",
    failure: "producer-failure",
    summary: "pipeline failed",
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

async function writeVerifiedCandidate(
  store: ArtifactStore,
  runId: string,
  repo: { directory: string; head: string },
): Promise<void> {
  const tree = await runGit(repo.directory, ["rev-parse", `${repo.head}^{tree}`]);
  const manifestHash = createHash("sha256").update("[]").digest("hex");
  const anchorRef = `refs/claude-architect/candidates/${runId}`;
  await runGit(repo.directory, ["update-ref", anchorRef, repo.head]);
  await store.writeResult({
    resultVersion: "1",
    runId,
    status: "verified-candidate",
    failure: null,
    summary: "candidate produced and independently verified",
    producerSummary: "test producer",
    candidate: {
      baseCommitOid: repo.head,
      candidateTreeOid: tree,
      candidateCommitOid: repo.head,
      anchorRef,
      manifestHash,
      changedPaths: [],
      patch: "",
    },
    requestedVerification: [],
    executedVerification: [],
    unresolvedIssues: [],
    evidence: {},
    logsRef: "logs/producer.log",
    producerId: "stub",
    producerVersion: "1",
    producerModel: null,
    durationMs: 1,
    sessionId: null,
  });
  await store.writeManifest(buildRunManifest({
    runId,
    repoRoot: repo.directory,
    baseCommitOid: repo.head,
    candidateManifestHash: manifestHash,
    producer: { id: "stub", version: "1", model: null },
    effectivePolicy: { isolation: "temporary-home", retries: 0 },
    repositoryInstructions: [],
    prompt: "test",
    executionPolicy: { network: "denied", writeAllowlist: ["**"] },
    environment: [],
    packagedVerifier: { version: "1", content: "test" },
  }));
}

beforeEach(async () => {
  previousPluginData = process.env.CLAUDE_PLUGIN_DATA;
  previousDelegated = process.env.CLAUDE_ARCHITECT_DELEGATED;
  previousPluginRoot = process.env.CLAUDE_PLUGIN_ROOT;
  process.env.CLAUDE_PLUGIN_DATA = await temporaryDirectory("ca-recovery-state-");
  delete process.env.CLAUDE_ARCHITECT_DELEGATED;
  serverEvents.length = 0;
});

afterEach(async () => {
  if (previousPluginData === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
  else process.env.CLAUDE_PLUGIN_DATA = previousPluginData;
  if (previousDelegated === undefined) delete process.env.CLAUDE_ARCHITECT_DELEGATED;
  else process.env.CLAUDE_ARCHITECT_DELEGATED = previousDelegated;
  if (previousPluginRoot === undefined) delete process.env.CLAUDE_PLUGIN_ROOT;
  else process.env.CLAUDE_PLUGIN_ROOT = previousPluginRoot;
  await Promise.all(temporaryPaths.splice(0).map(entry =>
    rm(entry, { recursive: true, force: true })));
});

describe("recoverStaleRuns", () => {
  it("skips recovery while a live recovery mutex is held", async () => {
    const repo = await initRepo();
    const runId = "run-live-recovery-mutex";
    const store = await createUnfinishedRun(runId, repo.commonDir, null);
    const worktree = await new WorktreeManager(repo.directory, runId).create(repo.head);
    const anchorRef = `refs/claude-architect/candidates/${runId}`;
    await runGit(repo.directory, ["update-ref", anchorRef, repo.head]);
    const recoveryLockPath = path.join(
      process.env.CLAUDE_PLUGIN_DATA!,
      "locks",
      "recovery.lock",
    );
    const owner = { pid: 9101, processToken: "darwin:live-recovery" };
    await mkdir(path.dirname(recoveryLockPath), { recursive: true });
    await writeFile(recoveryLockPath, JSON.stringify(owner));

    await expect(recoverStaleRuns({
      platformServices: platformServicesDouble({
        os: "darwin",
        async getProcessStartToken(pid) {
          return pid === owner.pid ? owner.processToken : "darwin:self";
        },
        async terminateProcessTreeByPid() {},
      }),
      isProcessAlive: pid => pid === owner.pid,
    })).resolves.toEqual({
      recovered: [],
      quarantined: [],
      worktreeSweepIssues: [{
        worktreePath: await realpath(recoveryLockPath),
        reason: expect.stringContaining("recovery lease"),
      }],
    });

    await expect(store.readResult(runId)).resolves.toBeNull();
    await expect(access(worktree.path)).resolves.toBeUndefined();
    expect(await runGit(repo.directory, ["rev-parse", anchorRef])).toBe(repo.head);
    await expect(readFile(recoveryLockPath, "utf8"))
      .resolves.toBe(JSON.stringify(owner));
  }, 120_000);

  it("defers recovery when a live recovery mutex token cannot be probed", async () => {
    const repo = await initRepo();
    const runId = "run-unprobeable-recovery-mutex";
    const store = await createUnfinishedRun(runId, repo.commonDir, null);
    const worktree = await new WorktreeManager(repo.directory, runId).create(repo.head);
    const anchorRef = `refs/claude-architect/candidates/${runId}`;
    await runGit(repo.directory, ["update-ref", anchorRef, repo.head]);
    const recoveryLockPath = path.join(
      process.env.CLAUDE_PLUGIN_DATA!,
      "locks",
      "recovery.lock",
    );
    const owner = { pid: 9104, processToken: "recorded" };
    const lockBytes = Buffer.from(JSON.stringify(owner));
    const tokenProbes: number[] = [];
    await mkdir(path.dirname(recoveryLockPath), { recursive: true });
    await writeFile(recoveryLockPath, lockBytes);

    await expect(recoverStaleRuns({
      platformServices: platformServicesDouble({
        os: "darwin",
        async getProcessStartToken(pid) {
          if (pid === owner.pid) tokenProbes.push(pid);
          return null;
        },
        async terminateProcessTreeByPid() {},
      }),
      isProcessAlive: pid => pid === owner.pid,
    })).resolves.toEqual({
      recovered: [],
      quarantined: [],
      worktreeSweepIssues: [{
        worktreePath: await realpath(recoveryLockPath),
        reason: expect.stringContaining("recovery lease"),
      }],
    });

    expect(tokenProbes).toEqual([owner.pid]);
    await expect(readFile(recoveryLockPath)).resolves.toEqual(lockBytes);
    await expect(access(worktree.path)).resolves.toBeUndefined();
    expect(await runGit(repo.directory, ["rev-parse", anchorRef])).toBe(repo.head);
    await expect(store.readResult(runId)).resolves.toBeNull();
  }, 120_000);

  // POSIX-only: the release failure is forced by rm-ing the locks directory while
  // recovery holds recovery.lock open. Windows blocks removing a directory that
  // contains an open handle, so the trigger cannot be reproduced; the AggregateError
  // composition it checks is platform-independent and covered by the POSIX run.
  it.skipIf(process.platform === "win32")("preserves a primary recovery error when lock releases also fail", async () => {
    const repo = await initRepo();
    const runId = "run-primary-and-release-failure";
    await createUnfinishedRun(runId, repo.commonDir, 4242, "darwin:live");
    const locksRoot = path.join(process.env.CLAUDE_PLUGIN_DATA!, "locks");
    const primaryError = new Error("primary recovery failure");

    let thrown: unknown;
    try {
      await recoverStaleRuns({
        platformServices: platformServicesDouble({
          os: "darwin",
          async getProcessStartToken(pid) {
            return pid === 4242 ? "darwin:replacement" : "darwin:self";
          },
          async terminateProcessTreeByPid() {},
        }),
        isProcessAlive: () => true,
        async git() {
          await rm(locksRoot, { recursive: true });
          await writeFile(locksRoot, "blocks lock release");
          throw primaryError;
        },
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AggregateError);
    const containedErrors = (error: unknown): unknown[] => error instanceof AggregateError
      ? error.errors.flatMap(containedErrors)
      : [error];
    expect(containedErrors(thrown)).toContain(primaryError);
  }, 120_000);

  it("reclaims a dead recovery mutex before recovering stale runs", async () => {
    const repo = await initRepo();
    const runId = "run-dead-recovery-mutex";
    const store = await createUnfinishedRun(runId, repo.commonDir, null);
    const recoveryLockPath = path.join(
      process.env.CLAUDE_PLUGIN_DATA!,
      "locks",
      "recovery.lock",
    );
    await mkdir(path.dirname(recoveryLockPath), { recursive: true });
    await writeFile(recoveryLockPath, JSON.stringify({
      pid: 9102,
      processToken: "darwin:dead-recovery",
    }));

    await expect(recoverStaleRuns({
      platformServices: platformServicesDouble({
        os: "darwin",
        async getProcessStartToken() { return null; },
        async terminateProcessTreeByPid() {},
      }),
      isProcessAlive: () => false,
    })).resolves.toEqual({ recovered: [runId], quarantined: [] });

    await expect(store.readResult(runId))
      .resolves.toMatchObject({ status: "cancelled" });
    await expectMissing(recoveryLockPath);
  }, 120_000);

  it("defers recovery rather than unlinking a hard-linked stale recovery mutex", async () => {
    const repo = await initRepo();
    const runId = "run-hard-linked-recovery-mutex";
    const store = await createUnfinishedRun(runId, repo.commonDir, null);
    const worktree = await new WorktreeManager(repo.directory, runId).create(repo.head);
    const anchorRef = `refs/claude-architect/candidates/${runId}`;
    await runGit(repo.directory, ["update-ref", anchorRef, repo.head]);
    const recoveryLockPath = path.join(
      process.env.CLAUDE_PLUGIN_DATA!,
      "locks",
      "recovery.lock",
    );
    const aliasPath = path.join(process.env.CLAUDE_PLUGIN_DATA!, "recovery-lock-alias");
    const lockBytes = Buffer.from(JSON.stringify({
      pid: 9105,
      processToken: "stale",
    }));
    await mkdir(path.dirname(recoveryLockPath), { recursive: true });
    await writeFile(recoveryLockPath, lockBytes);
    await link(recoveryLockPath, aliasPath);

    await expect(recoverStaleRuns({
      platformServices: platformServicesDouble({
        os: "darwin",
        async getProcessStartToken() { return null; },
        async terminateProcessTreeByPid() {},
      }),
      isProcessAlive: () => false,
    })).resolves.toEqual({
      recovered: [],
      quarantined: [],
      worktreeSweepIssues: [{
        worktreePath: await realpath(recoveryLockPath),
        reason: expect.stringContaining("recovery lease"),
      }],
    });

    await expect(readFile(recoveryLockPath)).resolves.toEqual(lockBytes);
    await expect(readFile(aliasPath)).resolves.toEqual(lockBytes);
    await expect(access(worktree.path)).resolves.toBeUndefined();
    expect(await runGit(repo.directory, ["rev-parse", anchorRef])).toBe(repo.head);
    await expect(store.readResult(runId)).resolves.toBeNull();
  }, 120_000);

  it("defers recovery when checkout ownership becomes live before mutation", async () => {
    const repo = await initRepo();
    const runId = "run-checkout-owner-revived";
    const store = await createUnfinishedRun(runId, repo.commonDir, null);
    const lockKey = createHash("sha256").update(repo.commonDir).digest("hex");
    const lockPath = path.join(
      process.env.CLAUDE_PLUGIN_DATA!,
      "locks",
      `${lockKey}.lock`,
    );
    await mkdir(path.dirname(lockPath), { recursive: true });
    const lockBytes = JSON.stringify({ pid: 9103, processToken: "owner-9103" });
    await writeFile(lockPath, lockBytes);
    let ownerChecks = 0;

    await expect(recoverStaleRuns({
      platformServices: platformServicesDouble({
        os: "darwin",
        async getProcessStartToken(pid) { return pid === 9103 ? "owner-9103" : null; },
        async terminateProcessTreeByPid() {},
      }),
      isProcessAlive(pid) {
        if (pid !== 9103) return false;
        ownerChecks += 1;
        return ownerChecks > 1;
      },
    })).resolves.toEqual({ recovered: [], quarantined: [] });

    expect(ownerChecks).toBeGreaterThanOrEqual(2);
    await expect(store.readResult(runId)).resolves.toBeNull();
    await expect(readFile(lockPath, "utf8")).resolves.toBe(lockBytes);
  }, 120_000);

  // POSIX-only: this simulates a concurrent process renaming a replacement lock onto
  // the lock file while the reclaimer holds it open for owner probing. Windows blocks
  // renaming onto an open file at the OS level, so the swap cannot occur — the OS
  // itself enforces the property the reclaimer's TOCTOU guard proves on POSIX.
  it.skipIf(process.platform === "win32")("preserves a replacement lock swapped during owner token probing", async () => {
    const locksRoot = path.join(process.env.CLAUDE_PLUGIN_DATA!, "locks");
    const lockPath = path.join(locksRoot, `${"f".repeat(64)}.lock`);
    const replacementPath = path.join(locksRoot, "replacement.lock");
    const replacementOwner = { pid: 9202, processToken: "darwin:live" };
    await mkdir(locksRoot, { recursive: true });
    await writeFile(lockPath, JSON.stringify({
      pid: 9201,
      processToken: "darwin:stale",
    }));

    await recoverStaleRuns({
      platformServices: platformServicesDouble({
        os: "darwin",
        async getProcessStartToken(pid) {
          if (pid !== 9201) return "darwin:self";
          await writeFile(replacementPath, JSON.stringify(replacementOwner));
          await rename(replacementPath, lockPath);
          return "darwin:replacement";
        },
        async terminateProcessTreeByPid() {},
      }),
      isProcessAlive: () => true,
    });

    await expect(readFile(lockPath, "utf8"))
      .resolves.toBe(JSON.stringify(replacementOwner));
  });

  it("preserves a terminal result published after the stale scan", async () => {
    const repo = await initRepo();
    const runId = "run-terminal-after-stale-scan";
    const store = await createUnfinishedRun(runId, repo.commonDir, null);
    const worktree = await new WorktreeManager(repo.directory, runId).create(repo.head);
    const anchorRef = `refs/claude-architect/candidates/${runId}`;
    await runGit(repo.directory, ["update-ref", anchorRef, repo.head]);
    const lockKey = createHash("sha256").update(repo.commonDir).digest("hex");
    const checkoutLockPath = path.join(
      process.env.CLAUDE_PLUGIN_DATA!,
      "locks",
      `${lockKey}.lock`,
    );
    const checkoutOwner = { pid: 9701, processToken: "darwin:stale-checkout" };
    await mkdir(path.dirname(checkoutLockPath), { recursive: true });
    await writeFile(checkoutLockPath, JSON.stringify(checkoutOwner));
    let publishedResult: Buffer | undefined;
    let ownerProbes = 0;

    const result = await recoverStaleRuns({
      platformServices: platformServicesDouble({
        os: "darwin",
        async getProcessStartToken(pid) {
          if (pid === checkoutOwner.pid) {
            ownerProbes += 1;
            if (publishedResult === undefined) {
              await store.writeResult({
                resultVersion: "1",
                runId,
                status: "failed",
                failure: "producer-failure",
                summary: "producer completed while recovery waited for the checkout lock",
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
              publishedResult = await readFile(path.join(store.runDirectory, "result.json"));
            }
            return "darwin:replacement-checkout";
          }
          return "darwin:self";
        },
        async terminateProcessTreeByPid() {},
      }),
      isProcessAlive: pid => pid === checkoutOwner.pid,
    });

    expect(result).toEqual({ recovered: [], quarantined: [] });
    expect(ownerProbes).toBeGreaterThanOrEqual(2);
    expect(publishedResult).toBeDefined();
    await expect(readFile(path.join(store.runDirectory, "result.json")))
      .resolves.toEqual(publishedResult);
    await expect(access(worktree.path)).resolves.toBeUndefined();
    expect(await runGit(repo.directory, ["rev-parse", anchorRef])).toBe(repo.head);
    await expectMissing(checkoutLockPath);
  }, 120_000);

  it.each([
    {
      ownerDescription: "a live matching-token owner",
      lockBytes: Buffer.from(JSON.stringify({
        pid: 9301,
        processToken: "darwin:live-checkout",
      })),
      ownerIsLive: true,
    },
    {
      ownerDescription: "an incomplete empty owner",
      lockBytes: Buffer.alloc(0),
      ownerIsLive: false,
    },
  ])("defers terminal pipeline cleanup while checkout lock has $ownerDescription", async ({
    lockBytes,
    ownerIsLive,
  }) => {
    const repo = await initRepo();
    const runId = ownerIsLive
      ? "run-terminal-live-checkout"
      : "run-terminal-incomplete-checkout";
    const store = await createTerminalRun(runId, repo.commonDir);
    const pipelineWorktree = await new WorktreeManager(
      repo.directory,
      `${runId}-pipeline`,
    ).create(repo.head);
    const verifyWorktree = await new WorktreeManager(
      repo.directory,
      `${runId}-verify`,
    ).create(repo.head);
    const pipelineSentinelPath = path.join(pipelineWorktree.path, "pipeline-sentinel.bin");
    const verifySentinelPath = path.join(verifyWorktree.path, "verify-sentinel.bin");
    await writeFile(pipelineSentinelPath, Buffer.from([0x00, 0x50, 0xff, 0x0a]));
    await writeFile(verifySentinelPath, Buffer.from([0x00, 0x56, 0xfe, 0x0a]));
    await store.writePipelineActiveMarker({
      pid: 4242,
      processToken: "darwin:dead-pipeline",
      startedAt: "2026-07-18T12:00:00.000Z",
      sliced: false,
    });

    const lockKey = createHash("sha256").update(repo.commonDir).digest("hex");
    const checkoutLockPath = path.join(
      process.env.CLAUDE_PLUGIN_DATA!,
      "locks",
      `${lockKey}.lock`,
    );
    await mkdir(path.dirname(checkoutLockPath), { recursive: true });
    await writeFile(checkoutLockPath, lockBytes);

    const resultPath = path.join(store.runDirectory, "result.json");
    const markerPath = path.join(store.runDirectory, "pipeline-active.json");
    const [
      resultBefore,
      markerBefore,
      pipelineSentinelBefore,
      verifySentinelBefore,
      checkoutLockBefore,
      pipelineIdentityBefore,
      verifyIdentityBefore,
    ] = await Promise.all([
      readFile(resultPath),
      readFile(markerPath),
      readFile(pipelineSentinelPath),
      readFile(verifySentinelPath),
      readFile(checkoutLockPath),
      lstat(pipelineWorktree.path),
      lstat(verifyWorktree.path),
    ]);

    await expect(recoverStaleRuns({
      platformServices: platformServicesDouble({
        os: "darwin",
        async getProcessStartToken(pid) {
          return pid === 9301 ? "darwin:live-checkout" : "darwin:self";
        },
        async terminateProcessTreeByPid() {},
      }),
      isProcessAlive: pid => ownerIsLive && pid === 9301,
    })).resolves.toEqual({ recovered: [], quarantined: [] });

    const [pipelineIdentityAfter, verifyIdentityAfter] = await Promise.all([
      lstat(pipelineWorktree.path),
      lstat(verifyWorktree.path),
    ]);
    expect({ dev: pipelineIdentityAfter.dev, ino: pipelineIdentityAfter.ino }).toEqual({
      dev: pipelineIdentityBefore.dev,
      ino: pipelineIdentityBefore.ino,
    });
    expect({ dev: verifyIdentityAfter.dev, ino: verifyIdentityAfter.ino }).toEqual({
      dev: verifyIdentityBefore.dev,
      ino: verifyIdentityBefore.ino,
    });
    await expect(readFile(resultPath)).resolves.toEqual(resultBefore);
    await expect(readFile(markerPath)).resolves.toEqual(markerBefore);
    await expect(readFile(pipelineSentinelPath)).resolves.toEqual(pipelineSentinelBefore);
    await expect(readFile(verifySentinelPath)).resolves.toEqual(verifySentinelBefore);
    await expect(readFile(checkoutLockPath)).resolves.toEqual(checkoutLockBefore);
  }, 120_000);

  it("revalidates a dead pipeline marker after reclaiming its checkout lock", async () => {
    const repo = await initRepo();
    const runId = "run-terminal-marker-revalidated";
    const store = await createTerminalRun(runId, repo.commonDir);
    const pipelineWorktree = await new WorktreeManager(
      repo.directory,
      `${runId}-pipeline`,
    ).create(repo.head);
    const verifyWorktree = await new WorktreeManager(
      repo.directory,
      `${runId}-verify`,
    ).create(repo.head);
    const markerPath = path.join(store.runDirectory, "pipeline-active.json");
    await store.writePipelineActiveMarker({
      pid: 4242,
      processToken: "darwin:dead-pipeline",
      startedAt: "2026-07-18T12:00:00.000Z",
      sliced: false,
    });
    const resultPath = path.join(store.runDirectory, "result.json");
    const resultBefore = await readFile(resultPath);

    const checkoutOwner = { pid: 9401, processToken: "darwin:stale-checkout" };
    const livePipelineOwner = {
      pid: 9402,
      processToken: "darwin:live-pipeline",
      startedAt: "2026-07-18T12:01:00.000Z",
      sliced: false,
    };
    const lockKey = createHash("sha256").update(repo.commonDir).digest("hex");
    const checkoutLockPath = path.join(
      process.env.CLAUDE_PLUGIN_DATA!,
      "locks",
      `${lockKey}.lock`,
    );
    await mkdir(path.dirname(checkoutLockPath), { recursive: true });
    await writeFile(checkoutLockPath, JSON.stringify(checkoutOwner));
    const anchorRef = `refs/claude-architect/candidates/${runId}`;
    await runGit(repo.directory, ["update-ref", anchorRef, repo.head]);

    let checkoutOwnerProbes = 0;
    let worktreesPresentDuringCheckoutProbe: boolean | undefined;
    let replacementMarkerBytes: Buffer | undefined;
    await expect(recoverStaleRuns({
      platformServices: platformServicesDouble({
        os: "darwin",
        async getProcessStartToken(pid) {
          if (pid === checkoutOwner.pid) {
            checkoutOwnerProbes += 1;
            await store.writePipelineActiveMarker(livePipelineOwner);
            replacementMarkerBytes = await readFile(markerPath);
            try {
              await Promise.all([
                access(pipelineWorktree.path),
                access(verifyWorktree.path),
              ]);
              worktreesPresentDuringCheckoutProbe = true;
            } catch {
              worktreesPresentDuringCheckoutProbe = false;
            }
            return "darwin:replacement-checkout";
          }
          if (pid === livePipelineOwner.pid) return livePipelineOwner.processToken;
          return "darwin:self";
        },
        async terminateProcessTreeByPid() {},
      }),
      isProcessAlive: pid => pid === checkoutOwner.pid || pid === livePipelineOwner.pid,
    })).resolves.toEqual({ recovered: [], quarantined: [] });

    expect(checkoutOwnerProbes).toBe(1);
    expect(worktreesPresentDuringCheckoutProbe).toBe(true);
    expect(replacementMarkerBytes).toBeDefined();
    await expect(readFile(markerPath)).resolves.toEqual(replacementMarkerBytes);
    await expect(readFile(resultPath)).resolves.toEqual(resultBefore);
    await expect(access(pipelineWorktree.path)).resolves.toBeUndefined();
    await expect(access(verifyWorktree.path)).resolves.toBeUndefined();
    await expectMissing(checkoutLockPath);
    expect(await runGit(repo.directory, ["rev-parse", anchorRef])).toBe(repo.head);
  }, 120_000);

  it("cleans dead-owner pipeline worktrees for a terminal run", async () => {
    const repo = await initRepo();
    const runId = "run-dead-pipeline";
    const store = await createUnfinishedRun(runId, repo.commonDir, null);
    await store.writeResult({
      resultVersion: "1",
      runId,
      status: "failed",
      failure: "producer-failure",
      summary: "pipeline failed",
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
    const resultBefore = await readFile(path.join(store.runDirectory, "result.json"), "utf8");
    const pipelineWorktree = await new WorktreeManager(
      repo.directory,
      `${runId}-pipeline`,
    ).create(repo.head);
    const verifyWorktree = await new WorktreeManager(
      repo.directory,
      `${runId}-verify`,
    ).create(repo.head);
    await store.writePipelineActiveMarker({
      pid: 4242,
      processToken: "darwin:dead",
      startedAt: "2026-07-18T12:00:00.000Z",
      sliced: false,
    });

    await expect(recoverStaleRuns({
      platformServices: platformServicesDouble({
        os: "darwin",
        async getProcessStartToken() { return null; },
        async terminateProcessTreeByPid() {},
      }),
      isProcessAlive: () => false,
    })).resolves.toEqual({ recovered: [], quarantined: [] });

    await expectMissing(pipelineWorktree.path);
    await expectMissing(verifyWorktree.path);
    await expectMissing(path.join(store.runDirectory, "pipeline-active.json"));
    await expect(readFile(path.join(store.runDirectory, "result.json"), "utf8"))
      .resolves.toBe(resultBefore);
  }, 120_000);

  it("preserves live-owner pipeline worktrees for a terminal run", async () => {
    const repo = await initRepo();
    const runId = "run-live-pipeline";
    const store = await createUnfinishedRun(runId, repo.commonDir, null);
    await store.writeResult({
      resultVersion: "1",
      runId,
      status: "failed",
      failure: "producer-failure",
      summary: "pipeline failed",
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
    const pipelineWorktree = await new WorktreeManager(
      repo.directory,
      `${runId}-pipeline`,
    ).create(repo.head);
    const verifyWorktree = await new WorktreeManager(
      repo.directory,
      `${runId}-verify`,
    ).create(repo.head);
    const markerPath = path.join(store.runDirectory, "pipeline-active.json");
    await store.writePipelineActiveMarker({
      pid: 4242,
      processToken: null,
      startedAt: "2026-07-18T12:00:00.000Z",
      sliced: false,
    });

    await expect(recoverStaleRuns({
      platformServices: platformServicesDouble({
        os: "darwin",
        async getProcessStartToken() { return null; },
        async terminateProcessTreeByPid() {},
      }),
      isProcessAlive: () => true,
    })).resolves.toEqual({ recovered: [], quarantined: [] });

    await expect(access(pipelineWorktree.path)).resolves.toBeUndefined();
    await expect(access(verifyWorktree.path)).resolves.toBeUndefined();
    const preservedMarker = JSON.parse(await readFile(markerPath, "utf8")) as { pid?: unknown };
    expect(preservedMarker.pid).toBe(4242);
  }, 120_000);

  it("terminates and archives a stale run before removing its worktree, anchor, and lock", async () => {
    const repo = await initRepo();
    const runId = "run-stale";
    const lockKey = createHash("sha256").update(repo.commonDir).digest("hex");
    const store = new ArtifactStore(runId);
    await store.writeLog("lifecycle", "attempt lock acquired\n");
    await writeFile(path.join(store.runDirectory, "run-start.json"), `${JSON.stringify({
      runId,
      lockKey,
      canonicalCommonDir: repo.commonDir,
      pid: 4242,
      startedAt: "2026-07-14T12:00:00.000Z",
    })}\n`);
    const worktree = await new WorktreeManager(repo.directory, runId).create(repo.head);
    const baselineWorktree = await new WorktreeManager(
      repo.directory,
      `baseline-${runId}`,
    ).create(repo.head);
    const verifyWorktree = await new WorktreeManager(
      repo.directory,
      `verify-${runId}`,
    ).create(repo.head);
    const pipelineWorktree = await new WorktreeManager(
      repo.directory,
      `${runId}-pipeline`,
    ).create(repo.head);
    const pipelineVerifyWorktree = await new WorktreeManager(
      repo.directory,
      `${runId}-verify`,
    ).create(repo.head);
    const unmanagedParent = await temporaryDirectory("ca-recovery-unmanaged-");
    const unmanagedWorktree = path.join(unmanagedParent, "external-worktree");
    await runGit(repo.directory, ["worktree", "add", "--detach", unmanagedWorktree, repo.head]);
    const anchorRef = `refs/claude-architect/candidates/${runId}`;
    await runGit(repo.directory, ["update-ref", anchorRef, repo.head]);
    const lockPath = path.join(process.env.CLAUDE_PLUGIN_DATA!, "locks", `${lockKey}.lock`);
    await mkdir(path.dirname(lockPath), { recursive: true });
    await writeFile(lockPath, JSON.stringify({ pid: 99123, processToken: "stale-99123" }));
    const terminated: number[] = [];

    const result = await recoverStaleRuns({
      platformServices: platformServicesDouble({
        os: "darwin",
        async getProcessStartToken() { return null; },
        async terminateProcessTreeByPid(pid) { terminated.push(pid); },
      }),
      isProcessAlive: () => false,
    });

    expect(result).toEqual({ recovered: [runId], quarantined: [] });
    expect(terminated).toEqual([]);
    await expectMissing(worktree.path);
    await expectMissing(baselineWorktree.path);
    await expectMissing(verifyWorktree.path);
    await expectMissing(pipelineWorktree.path);
    await expectMissing(pipelineVerifyWorktree.path);
    await expect(access(unmanagedWorktree)).resolves.toBeUndefined();
    await expectMissing(lockPath);
    expect((await git(repo.directory, ["rev-parse", "--verify", "--quiet", anchorRef])).exitCode)
      .not.toBe(0);
    expect(await readFile(path.join(store.runDirectory, "logs", "recovery.log"), "utf8"))
      .toBe("startup recovery reclaimed unfinished run\n");
    await expect(store.readResult(runId)).resolves.toMatchObject({
      runId,
      status: "cancelled",
      failure: "cancelled",
      evidence: { recovery: "startup-stale-run" },
    });

    await expect(recoverStaleRuns({
      platformServices: platformServicesDouble({
        os: "darwin",
        async getProcessStartToken() { return null; },
        async terminateProcessTreeByPid(pid) { terminated.push(pid); },
      }),
      isProcessAlive: () => false,
    })).resolves.toEqual({ recovered: [], quarantined: [] });
    expect(terminated).toEqual([]);
  });

  it("does not kill a stale run when its recorded process token differs", async () => {
    const repo = await initRepo();
    const runId = "run-recycled-pid";
    const lockKey = createHash("sha256").update(repo.commonDir).digest("hex");
    const store = new ArtifactStore(runId);
    await store.writeLog("lifecycle", "attempt lock acquired\n");
    await writeFile(path.join(store.runDirectory, "run-start.json"), `${JSON.stringify({
      runId,
      lockKey,
      canonicalCommonDir: repo.commonDir,
      pid: 4242,
      processToken: "darwin:recorded-start",
      startedAt: "2026-07-14T12:00:00.000Z",
    })}\n`);
    const worktree = await new WorktreeManager(repo.directory, runId).create(repo.head);
    const calls: Array<{ pid: number; expectedToken?: string | null }> = [];
    const liveToken = "darwin:live-start";

    const result = await recoverStaleRuns({
      platformServices: platformServicesDouble({
        os: "darwin",
        async getProcessStartToken() { return liveToken; },
        async terminateProcessTreeByPid(pid, expectedToken) {
          calls.push({ pid, expectedToken });
          if (expectedToken === undefined || expectedToken === liveToken) {
            throw new Error("test would have killed the live process");
          }
        },
      }),
      isProcessAlive: () => true,
    });

    expect(result).toEqual({ recovered: [runId], quarantined: [] });
    expect(calls).toEqual([]);
    await expectMissing(worktree.path);
    await expect(store.readResult(runId)).resolves.toMatchObject({
      runId,
      status: "cancelled",
      evidence: { recovery: "startup-stale-run" },
    });
  });

  it("archives byte-identical recovered results under different wall clocks", async () => {
    const repo = await initRepo();
    const runId = "run-deterministic-recovery-result";
    const store = await createUnfinishedRun(runId, repo.commonDir, null);
    const resultPath = path.join(store.runDirectory, "result.json");
    const now = vi.spyOn(Date, "now");

    try {
      now.mockReturnValue(Date.parse("2026-07-15T12:00:00.000Z"));
      await expect(recoverStaleRuns({
        platformServices: platformServicesDouble({
          os: "darwin",
          async getProcessStartToken() { return null; },
          async terminateProcessTreeByPid() {},
        }),
        isProcessAlive: () => false,
      })).resolves.toEqual({ recovered: [runId], quarantined: [] });
      const firstResult = await readFile(resultPath);

      await rm(resultPath);
      now.mockReturnValue(Date.parse("2026-07-18T12:00:00.000Z"));
      await expect(recoverStaleRuns({
        platformServices: platformServicesDouble({
          os: "darwin",
          async getProcessStartToken() { return null; },
          async terminateProcessTreeByPid() {},
        }),
        isProcessAlive: () => false,
      })).resolves.toEqual({ recovered: [runId], quarantined: [] });
      const secondResult = await readFile(resultPath);

      expect(secondResult.equals(firstResult)).toBe(true);
      expect(JSON.parse(secondResult.toString("utf8"))).toMatchObject({ durationMs: 0 });
    } finally {
      now.mockRestore();
    }
  });

  it("does not kill an alive pid when its recorded process token is null", async () => {
    const repo = await initRepo();
    const runId = "run-live-null-token";
    const pid = 4242;
    const store = await createUnfinishedRun(runId, repo.commonDir, pid, null);
    const worktree = await new WorktreeManager(repo.directory, runId).create(repo.head);
    const anchorRef = `refs/claude-architect/candidates/${runId}`;
    await runGit(repo.directory, ["update-ref", anchorRef, repo.head]);
    const forced = vi.fn();
    const tokenProbes: number[] = [];

    await expect(recoverStaleRuns({
      platformServices: platformServicesDouble({
        os: "darwin",
        async getProcessStartToken(probedPid) {
          tokenProbes.push(probedPid);
          return "darwin:live";
        },
        async terminateProcessTreeByPid(...args) { forced(...args); },
      }),
      isProcessAlive: probedPid => probedPid === pid,
    })).resolves.toEqual({ recovered: [], quarantined: [] });

    // Startup recovery preserves a verified live owner: it neither signals it
    // nor reaps its process tree.
    expect(forced).not.toHaveBeenCalled();
    expect(tokenProbes).not.toContain(pid);
    await expect(lstat(worktree.path)).resolves.toBeDefined();
    expect((await git(repo.directory, ["rev-parse", "--verify", "--quiet", anchorRef])).exitCode)
      .toBe(0);
    await expect(store.readResult(runId)).resolves.toBeNull();
  });

  it("preserves a checkout lock whose recorded owner pid is still alive", async () => {
    const lockKey = "a".repeat(64);
    const lockPath = path.join(process.env.CLAUDE_PLUGIN_DATA!, "locks", `${lockKey}.lock`);
    await mkdir(path.dirname(lockPath), { recursive: true });
    const lockBytes = JSON.stringify({ pid: process.pid, processToken: "current-process" });
    await writeFile(lockPath, lockBytes);

    await expect(recoverStaleRuns({
      platformServices: platformServicesDouble({
        os: "darwin",
        async getProcessStartToken(pid) { return pid === process.pid ? "current-process" : null; },
        async terminateProcessTreeByPid() {},
      }),
      isProcessAlive: () => true,
    })).resolves.toEqual({ recovered: [], quarantined: [] });

    await expect(readFile(lockPath, "utf8")).resolves.toBe(lockBytes);
  });

  it("does not recover an unfinished run owned by a live locked session", async () => {
    const repo = await initRepo();
    const runId = "run-live-session";
    const lockKey = createHash("sha256").update(repo.commonDir).digest("hex");
    const store = new ArtifactStore(runId);
    await store.writeLog("lifecycle", "attempt lock acquired\n");
    await writeFile(path.join(store.runDirectory, "run-start.json"), `${JSON.stringify({
      runId,
      lockKey,
      canonicalCommonDir: repo.commonDir,
      pid: 4242,
      startedAt: "2026-07-14T12:00:00.000Z",
    })}\n`);
    const worktree = await new WorktreeManager(repo.directory, runId).create(repo.head);
    const anchorRef = `refs/claude-architect/candidates/${runId}`;
    await runGit(repo.directory, ["update-ref", anchorRef, repo.head]);
    const lockPath = path.join(process.env.CLAUDE_PLUGIN_DATA!, "locks", `${lockKey}.lock`);
    await mkdir(path.dirname(lockPath), { recursive: true });
    const lockBytes = JSON.stringify({ pid: 7777, processToken: "live-7777" });
    await writeFile(lockPath, lockBytes);
    const terminated: number[] = [];

    await expect(recoverStaleRuns({
      platformServices: platformServicesDouble({
        os: "darwin",
        async getProcessStartToken(pid) { return pid === 7777 ? "live-7777" : null; },
        async terminateProcessTreeByPid(pid) { terminated.push(pid); },
      }),
      isProcessAlive: pid => pid === 7777,
    })).resolves.toEqual({ recovered: [], quarantined: [] });

    expect(terminated).toEqual([]);
    await expect(access(worktree.path)).resolves.toBeUndefined();
    expect(await runGit(repo.directory, ["rev-parse", anchorRef])).toBe(repo.head);
    await expect(readFile(lockPath, "utf8")).resolves.toBe(lockBytes);
    await expect(store.readResult(runId)).resolves.toBeNull();
  });

  it("defers recovery when the checkout lock owner is empty", async () => {
    const repo = await initRepo();
    const runId = "run-empty-checkout-owner";
    const store = await createUnfinishedRun(runId, repo.commonDir, null);
    const worktree = await new WorktreeManager(repo.directory, runId).create(repo.head);
    const anchorRef = `refs/claude-architect/candidates/${runId}`;
    await runGit(repo.directory, ["update-ref", anchorRef, repo.head]);
    const lockKey = createHash("sha256").update(repo.commonDir).digest("hex");
    const lockPath = path.join(
      process.env.CLAUDE_PLUGIN_DATA!,
      "locks",
      `${lockKey}.lock`,
    );
    await mkdir(path.dirname(lockPath), { recursive: true });
    await writeFile(lockPath, "");

    await expect(recoverStaleRuns()).resolves.toEqual({ recovered: [], quarantined: [] });

    await expect(store.readResult(runId)).resolves.toBeNull();
    await expect(access(worktree.path)).resolves.toBeUndefined();
    expect(await runGit(repo.directory, ["rev-parse", anchorRef])).toBe(repo.head);
    await expect(readFile(lockPath, "utf8")).resolves.toBe("");
  }, 120_000);

  it("quarantines a coercible non-string terminal status", async () => {
    const runId = "run-malformed-terminal";
    const commonDir = path.join(process.env.CLAUDE_PLUGIN_DATA!, "missing-common-dir");
    const lockKey = createHash("sha256").update(commonDir).digest("hex");
    const runDirectory = path.join(process.env.CLAUDE_PLUGIN_DATA!, "runs", runId);
    await mkdir(runDirectory, { recursive: true });
    await writeFile(path.join(runDirectory, "run-start.json"), `${JSON.stringify({
      runId,
      lockKey,
      canonicalCommonDir: commonDir,
      pid: null,
      startedAt: "2026-07-14T12:00:00.000Z",
    })}\n`);
    await writeFile(path.join(runDirectory, "result.json"), `${JSON.stringify({
      resultVersion: "1",
      runId,
      status: ["failed"],
    })}\n`);

    await expect(recoverStaleRuns({
      platformServices: platformServicesDouble({
        os: "darwin",
        async getProcessStartToken() { return null; },
        async terminateProcessTreeByPid() {},
      }),
    })).resolves.toEqual({ recovered: [], quarantined: [runId] });
    await expectQuarantinedRun(runId, runDirectory);
  });

  it("quarantines a non-string process token", async () => {
    const runId = "run-malformed-process-token";
    const commonDir = path.join(process.env.CLAUDE_PLUGIN_DATA!, "missing-common-dir");
    const lockKey = createHash("sha256").update(commonDir).digest("hex");
    const runDirectory = path.join(process.env.CLAUDE_PLUGIN_DATA!, "runs", runId);
    await mkdir(runDirectory, { recursive: true });
    await writeFile(path.join(runDirectory, "run-start.json"), `${JSON.stringify({
      runId,
      lockKey,
      canonicalCommonDir: commonDir,
      pid: 4242,
      processToken: 123,
      startedAt: "2026-07-14T12:00:00.000Z",
    })}\n`);

    await expect(recoverStaleRuns({
      platformServices: platformServicesDouble({
        os: "darwin",
        async getProcessStartToken() { return null; },
        async terminateProcessTreeByPid() {},
      }),
      // The recorded pid is fabricated; without injection the default liveness
      // probe asks the real OS, and a colliding live pid preserves the run.
      isProcessAlive: () => false,
    })).resolves.toEqual({ recovered: [], quarantined: [runId] });
    await expectQuarantinedRun(runId, runDirectory);
  });

  it("quarantines a missing recorded repository with a bounded redacted diagnostic", async () => {
    const runId = "run-missing-repository";
    const secret = "sk-recovery-secret-12345678";
    const commonDir = path.join(
      process.env.CLAUDE_PLUGIN_DATA!,
      "missing-common-dir",
      secret,
    );
    const lockKey = createHash("sha256").update(commonDir).digest("hex");
    const runDirectory = path.join(process.env.CLAUDE_PLUGIN_DATA!, "runs", runId);
    await mkdir(runDirectory, { recursive: true });
    await writeFile(path.join(runDirectory, "run-start.json"), `${JSON.stringify({
      runId,
      lockKey,
      canonicalCommonDir: commonDir,
      pid: 5252,
      startedAt: "2026-07-14T12:00:00.000Z",
    })}\n`);
    const terminated: number[] = [];
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});

    await expect(recoverStaleRuns({
      platformServices: platformServicesDouble({
        os: "darwin",
        async getProcessStartToken() { return null; },
        async terminateProcessTreeByPid(pid) { terminated.push(pid); },
      }),
      // Same fabricated-pid hazard as above: pid 5252 was live on a CI runner
      // once, which correctly preserved the "live" run and failed the test.
      isProcessAlive: () => false,
    })).resolves.toEqual({ recovered: [], quarantined: [runId] });
    expect(terminated).toEqual([]);
    await expectQuarantinedRun(runId, runDirectory, [secret, commonDir]);
    const warnCalls = [...warn.mock.calls];
    warn.mockRestore();
    expect(warnCalls).toHaveLength(1);
    const diagnostic = JSON.stringify(warnCalls[0]);
    expect(Buffer.byteLength(diagnostic, "utf8")).toBeLessThanOrEqual(4_096);
    expect(diagnostic).not.toContain(secret);
    expect(diagnostic).not.toContain(commonDir);
    expect(diagnostic).not.toContain(process.env.CLAUDE_PLUGIN_DATA!);
  });

  it("preserves a healthy recovery when a later stale run is poisoned", async () => {
    const repo = await initRepo();
    const healthyRunId = "run-a-healthy";
    const poisonedRunId = "run-z-poisoned";
    const healthyStore = await createUnfinishedRun(healthyRunId, repo.commonDir, null);
    const missingCommonDir = path.join(
      process.env.CLAUDE_PLUGIN_DATA!,
      "missing-common-dir",
    );
    const poisonedStore = await createUnfinishedRun(
      poisonedRunId,
      missingCommonDir,
      null,
    );

    await expect(recoverStaleRuns({
      platformServices: platformServicesDouble({
        os: "darwin",
        async getProcessStartToken() { return null; },
        async terminateProcessTreeByPid() {},
      }),
      isProcessAlive: () => false,
    })).resolves.toEqual({
      recovered: [healthyRunId],
      quarantined: [poisonedRunId],
    });

    await expect(healthyStore.readResult(healthyRunId))
      .resolves.toMatchObject({ status: "cancelled" });
    await expectQuarantinedRun(poisonedRunId, poisonedStore.runDirectory, [missingCommonDir]);
  }, 120_000);

  it("restores a poisoned run and preserves both errors when quarantine persistence fails", async () => {
    const runId = "run-journal-failure";
    const missingCommonDir = path.join(process.env.CLAUDE_PLUGIN_DATA!, "missing-common-dir");
    const store = await createUnfinishedRun(runId, missingCommonDir, 4242, "darwin:recorded");
    const runsRoot = path.dirname(store.runDirectory);
    let injected = false;

    let thrown: unknown;
    try {
      await recoverStaleRuns({
        platformServices: platformServicesDouble({
          os: "darwin",
          async getProcessStartToken(pid) {
            if (pid === 4242 && !injected) {
              injected = true;
              await mkdir(path.join(runsRoot, "recovery-quarantine.ndjson"));
            }
            return pid === 4242 ? "darwin:replacement" : "darwin:self";
          },
          async terminateProcessTreeByPid() {},
        }),
        isProcessAlive: pid => pid === 4242,
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AggregateError);
    const errors = (thrown as AggregateError).errors as unknown[];
    expect(errors).toHaveLength(2);
    expect(String(errors[0])).toMatch(/ENOENT|missing-common-dir/i);
    expect(String(errors[1])).toMatch(/EISDIR|regular file|incompatible/i);
    await expect(access(store.runDirectory)).resolves.toBeUndefined();
    await expectMissing(path.join(runsRoot, `.poisoned-${runId}`));
  });

  it("rejects a hard-linked quarantine journal without mutating its external alias", async () => {
    const runId = "run-hard-linked-journal";
    const missingCommonDir = path.join(process.env.CLAUDE_PLUGIN_DATA!, "missing-common-dir");
    const store = await createUnfinishedRun(runId, missingCommonDir, 4242, "darwin:recorded");
    const runsRoot = path.dirname(store.runDirectory);
    const externalPath = path.join(process.env.CLAUDE_PLUGIN_DATA!, "external-journal");
    const journalPath = path.join(runsRoot, "recovery-quarantine.ndjson");
    const externalBytes = "external bytes must remain unchanged\n";
    await writeFile(externalPath, externalBytes);
    let injected = false;

    let thrown: unknown;
    try {
      await recoverStaleRuns({
        platformServices: platformServicesDouble({
          os: "darwin",
          async getProcessStartToken(pid) {
            if (pid === 4242 && !injected) {
              injected = true;
              await link(externalPath, journalPath);
            }
            return pid === 4242 ? "darwin:replacement" : "darwin:self";
          },
          async terminateProcessTreeByPid() {},
        }),
        isProcessAlive: pid => pid === 4242,
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AggregateError);
    const errors = (thrown as AggregateError).errors as unknown[];
    expect(errors).toHaveLength(2);
    expect(String(errors[0])).toMatch(/ENOENT|missing-common-dir/i);
    expect(String(errors[1])).toMatch(/recovery quarantine journal.*bounded regular file/i);
    await expect(readFile(externalPath, "utf8")).resolves.toBe(externalBytes);
    await expect(access(store.runDirectory)).resolves.toBeUndefined();
    await expectMissing(path.join(runsRoot, `.poisoned-${runId}`));
  });

  it("rejects a COW update when the validated journal snapshot has a hard-link alias", async () => {
    const repo = await initRepo();
    const firstRunId = "run-cow-alias-first";
    const secondRunId = "run-cow-alias-second";
    const missingCommonDir = path.join(process.env.CLAUDE_PLUGIN_DATA!, "missing-common-dir");
    const firstStore = await createUnfinishedRun(firstRunId, missingCommonDir, null);

    await expect(recoverStaleRuns({ isProcessAlive: () => false }))
      .resolves.toEqual({ recovered: [], quarantined: [firstRunId] });

    const runsRoot = path.dirname(firstStore.runDirectory);
    const journalPath = path.join(runsRoot, "recovery-quarantine.ndjson");
    const aliasPath = path.join(process.env.CLAUDE_PLUGIN_DATA!, "old-journal-alias");
    const oldBytes = await readFile(journalPath);
    const secondStore = await createUnfinishedRun(
      secondRunId,
      missingCommonDir,
      4242,
      "darwin:recorded",
    );
    let injected = false;

    let thrown: unknown;
    try {
      await recoverStaleRuns({
        platformServices: platformServicesDouble({
          os: "darwin",
          async getProcessStartToken(pid) {
            if (pid === 4242 && !injected) {
              injected = true;
              await link(journalPath, aliasPath);
            }
            return pid === 4242 ? "darwin:replacement" : "darwin:self";
          },
          async terminateProcessTreeByPid() {},
        }),
        isProcessAlive: pid => pid === 4242,
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AggregateError);
    const containedErrors = (error: unknown): unknown[] => error instanceof AggregateError
      ? error.errors.flatMap(containedErrors)
      : [error];
    expect(containedErrors(thrown).map(String).join("\n"))
      .toMatch(/recovery quarantine journal.*bounded regular file/i);
    await expect(readFile(aliasPath)).resolves.toEqual(oldBytes);
    await expect(readFile(journalPath)).resolves.toEqual(oldBytes);
    await expect(access(secondStore.runDirectory)).resolves.toBeUndefined();
    await expectMissing(path.join(runsRoot, `.poisoned-${secondRunId}`));
  });

  it("preserves journal record order across two successful COW updates", async () => {
    const firstRunId = "run-cow-order-first";
    const secondRunId = "run-cow-order-second";
    const missingCommonDir = path.join(process.env.CLAUDE_PLUGIN_DATA!, "missing-common-dir");
    const firstStore = await createUnfinishedRun(firstRunId, missingCommonDir, null);
    await createUnfinishedRun(secondRunId, missingCommonDir, null);

    await expect(recoverStaleRuns({ isProcessAlive: () => false }))
      .resolves.toEqual({ recovered: [], quarantined: [firstRunId, secondRunId] });

    const journal = await readFile(
      path.join(path.dirname(firstStore.runDirectory), "recovery-quarantine.ndjson"),
      "utf8",
    );
    const records = journal.trimEnd().split("\n")
      .map(line => JSON.parse(line) as { runId: string });
    expect(records.map(record => record.runId)).toEqual([firstRunId, secondRunId]);
  });

  it("rejects a symlinked quarantine journal without mutating its external target", async ({
    skip,
  }) => {
    const runId = "run-symlinked-journal";
    const missingCommonDir = path.join(process.env.CLAUDE_PLUGIN_DATA!, "missing-common-dir");
    const store = await createUnfinishedRun(runId, missingCommonDir, 4242, "darwin:recorded");
    const runsRoot = path.dirname(store.runDirectory);
    const externalPath = path.join(process.env.CLAUDE_PLUGIN_DATA!, "external-target");
    const journalPath = path.join(runsRoot, "recovery-quarantine.ndjson");
    const externalBytes = "external target must remain unchanged\n";
    await writeFile(externalPath, externalBytes);
    let injected = false;

    let thrown: unknown;
    try {
      await recoverStaleRuns({
        platformServices: platformServicesDouble({
          os: "darwin",
          async getProcessStartToken(pid) {
            if (pid === 4242 && !injected) {
              injected = true;
              try {
                await symlink(externalPath, journalPath, "file");
              } catch (error) {
                if (["EACCES", "EPERM", "ENOSYS"].includes(
                  (error as NodeJS.ErrnoException).code ?? "",
                )) {
                  skip();
                } else {
                  throw error;
                }
              }
            }
            return pid === 4242 ? "darwin:replacement" : "darwin:self";
          },
          async terminateProcessTreeByPid() {},
        }),
        isProcessAlive: pid => pid === 4242,
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AggregateError);
    const errors = (thrown as AggregateError).errors as unknown[];
    expect(errors).toHaveLength(2);
    expect(String(errors[0])).toMatch(/ENOENT|missing-common-dir/i);
    expect(String(errors[1])).toMatch(/ELOOP|symbolic link|bounded regular file/i);
    await expect(readFile(externalPath, "utf8")).resolves.toBe(externalBytes);
    await expect(access(store.runDirectory)).resolves.toBeUndefined();
    await expectMissing(path.join(runsRoot, `.poisoned-${runId}`));
  });

  it("fails closed for a dangling quarantine journal symlink without creating its target", async ({
    skip,
  }) => {
    const runsRoot = path.join(process.env.CLAUDE_PLUGIN_DATA!, "runs");
    const externalPath = path.join(process.env.CLAUDE_PLUGIN_DATA!, "missing-external-target");
    const journalPath = path.join(runsRoot, "recovery-quarantine.ndjson");
    await mkdir(runsRoot, { recursive: true });
    try {
      await symlink(externalPath, journalPath, "file");
    } catch (error) {
      if (["EACCES", "EPERM", "ENOSYS"].includes(
        (error as NodeJS.ErrnoException).code ?? "",
      )) {
        skip();
        return;
      }
      throw error;
    }

    await expect(recoverStaleRuns()).rejects.toThrow();
    await expectMissing(externalPath);
  });

  it("fails closed for an unjournaled poisoned run directory", async () => {
    const runId = "run-unjournaled-poison";
    const runsRoot = path.join(process.env.CLAUDE_PLUGIN_DATA!, "runs");
    await mkdir(path.join(runsRoot, `.poisoned-${runId}`), { recursive: true });

    await expect(recoverStaleRuns()).rejects.toThrow(/unjournaled poisoned run/i);
  });

  it("authorizes journaled poison without suppressing a normal historical run", async () => {
    const repo = await initRepo();
    const poisonRunId = "run-journaled-poison";
    const historicalRunId = "run-historical-record";
    const historicalStore = await createUnfinishedRun(historicalRunId, repo.commonDir, null);
    const runsRoot = path.dirname(historicalStore.runDirectory);
    await mkdir(path.join(runsRoot, `.poisoned-${poisonRunId}`));
    await writeFile(path.join(runsRoot, "recovery-quarantine.ndjson"), [
      JSON.stringify({
        event: "recovery-quarantine",
        runId: poisonRunId,
        reason: "Error: poison",
        recordedAt: "2026-07-19T00:00:00.000Z",
      }),
      JSON.stringify({
        event: "recovery-quarantine",
        runId: historicalRunId,
        reason: "Error: historical intent",
        recordedAt: "2026-07-19T00:00:00.000Z",
      }),
      "",
    ].join("\n"));

    await expect(recoverStaleRuns({ isProcessAlive: () => false }))
      .resolves.toEqual({ recovered: [historicalRunId], quarantined: [] });
  });

  it("reuses an existing quarantine record when retrying the same run", async () => {
    const runId = "run-quarantine-retry";
    const missingCommonDir = path.join(process.env.CLAUDE_PLUGIN_DATA!, "missing-common-dir");
    const store = await createUnfinishedRun(runId, missingCommonDir, null);
    const runsRoot = path.dirname(store.runDirectory);
    const journalPath = path.join(runsRoot, "recovery-quarantine.ndjson");
    const journalBytes = Buffer.from(`${JSON.stringify({
      event: "recovery-quarantine",
      runId,
      reason: "Error: prior publication completed",
      recordedAt: "2026-07-19T00:00:00.000Z",
    })}\n`);
    await writeFile(journalPath, journalBytes);

    await expect(recoverStaleRuns({ isProcessAlive: () => false }))
      .resolves.toEqual({ recovered: [], quarantined: [runId] });

    await expect(readFile(journalPath)).resolves.toEqual(journalBytes);
    await expectMissing(store.runDirectory);
    await expect(access(path.join(runsRoot, `.poisoned-${runId}`))).resolves.toBeUndefined();
  });

  it("fails closed for duplicate quarantine run ids", async () => {
    const runId = "run-duplicate-quarantine";
    const runsRoot = path.join(process.env.CLAUDE_PLUGIN_DATA!, "runs");
    const record = {
      event: "recovery-quarantine",
      runId,
      reason: "Error: poison",
      recordedAt: "2026-07-19T00:00:00.000Z",
    };
    await mkdir(runsRoot, { recursive: true });
    await writeFile(
      path.join(runsRoot, "recovery-quarantine.ndjson"),
      `${JSON.stringify(record)}\n${JSON.stringify(record)}\n`,
    );

    await expect(recoverStaleRuns()).rejects.toThrow(/duplicate.*quarantine/i);
  });

  it.each([
    ["torn", "{\"event\":\"recovery-quarantine\"}"],
    ["malformed", `${JSON.stringify({
      event: "unexpected",
      runId: "run-bad-journal",
      reason: "Error: bad",
      recordedAt: "2026-07-19T00:00:00.000Z",
    })}\n`],
  ])("fails closed for a %s quarantine journal", async (_kind, contents) => {
    const runsRoot = path.join(process.env.CLAUDE_PLUGIN_DATA!, "runs");
    await mkdir(runsRoot, { recursive: true });
    await writeFile(path.join(runsRoot, "recovery-quarantine.ndjson"), contents);

    await expect(recoverStaleRuns()).rejects.toThrow(/recovery quarantine journal/i);
  });

  it("redacts a single-backslash-rooted Windows path from quarantine diagnostics", async () => {
    const runId = "run-rooted-windows-path";
    const repo = await initRepo();
    await createUnfinishedRun(runId, repo.commonDir, 4242, "darwin:recorded");
    const rootedPath = "\\Users\\alice\\repo";
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});

    await expect(recoverStaleRuns({
      platformServices: platformServicesDouble({
        os: "darwin",
        async getProcessStartToken(pid) {
          return pid === 4242 ? "darwin:replacement" : "darwin:self";
        },
        async terminateProcessTreeByPid() {},
      }),
      isProcessAlive: pid => pid === 4242,
      async git() { throw new Error(`callback failed at ${rootedPath}`); },
    })).resolves.toEqual({ recovered: [], quarantined: [runId] });

    const journal = await readFile(
      path.join(process.env.CLAUDE_PLUGIN_DATA!, "runs", "recovery-quarantine.ndjson"),
      "utf8",
    );
    const record = JSON.parse(journal) as { reason: string };
    const diagnostic = warn.mock.calls[0]?.[1] as { reason?: string };
    warn.mockRestore();
    expect(record.reason).not.toContain(rootedPath);
    expect(diagnostic.reason).not.toContain(rootedPath);
  });

  it("preserves an unowned creation-like directory as ambiguous", async () => {
    const stagingPath = path.join(
      process.env.CLAUDE_PLUGIN_DATA!,
      "worktrees",
      ".create-run-unknown-00000000-0000-4000-8000-000000000099",
    );
    await mkdir(stagingPath, { recursive: true, mode: 0o700 });

    await expect(recoverStaleRuns({ isProcessAlive: () => false })).resolves.toEqual({
      recovered: [],
      quarantined: [],
      worktreeSweepIssues: [{
        worktreePath: expect.stringContaining(path.basename(stagingPath)),
        reason: expect.stringContaining("marker is missing"),
      }],
    });
    await expect(access(stagingPath)).resolves.toBeUndefined();
  });

  it("recovers a stale registered worktree after the Producer deletes its .git marker", async () => {
    const repo = await initRepo();
    const runId = "run-stale-missing-marker";
    await createUnfinishedRun(runId, repo.commonDir, 4241, "darwin:stale");
    const pipelineWorktree = await new WorktreeManager(
      repo.directory,
      `${runId}-pipeline`,
    ).create(repo.head);
    await rm(path.join(pipelineWorktree.path, ".git"));

    await expect(recoverStaleRuns({
      platformServices: platformServicesDouble({
        os: "darwin",
        async getProcessStartToken() { return "darwin:recovery"; },
        async terminateProcessTreeByPid() {},
      }),
      isProcessAlive: () => false,
    })).resolves.toEqual({ recovered: [runId], quarantined: [] });

    await expectMissing(pipelineWorktree.path);
    expect(await runGit(repo.directory, ["worktree", "list", "--porcelain"]))
      .not.toContain(pipelineWorktree.path);
  });

  it("preserves an orphaned matching-token owner when its checkout lock is absent", async () => {
    const repo = await initRepo();
    const runId = "run-live-owner-matching";
    const store = await createUnfinishedRun(runId, repo.commonDir, 4242, "darwin:start");
    const pipelineWorktree = await new WorktreeManager(
      repo.directory,
      `${runId}-pipeline`,
    ).create(repo.head);
    const terminate = vi.fn();

    await expect(recoverStaleRuns({
      platformServices: platformServicesDouble({
        os: "darwin",
        async getProcessStartToken(pid) {
          return pid === 4242 ? "darwin:start" : "darwin:recovery";
        },
        async terminateProcessTreeByPid(...args) { terminate(...args); },
      }),
      isProcessAlive: pid => pid === 4242,
    })).resolves.toEqual({ recovered: [], quarantined: [] });

    expect(terminate).not.toHaveBeenCalled();
    await expect(lstat(pipelineWorktree.path)).resolves.toBeDefined();
    await expect(store.readResult(runId)).resolves.toBeNull();
  });

  it("preserves a live run whose process token cannot be verified", async () => {
    const repo = await initRepo();
    const runId = "run-live-owner-unverifiable";
    const store = await createUnfinishedRun(runId, repo.commonDir, 4343, "darwin:start");
    const terminate = vi.fn();

    await expect(recoverStaleRuns({
      platformServices: platformServicesDouble({
        os: "darwin",
        async getProcessStartToken(pid) {
          return pid === 4343 ? null : "darwin:recovery";
        },
        async terminateProcessTreeByPid(...args) { terminate(...args); },
      }),
      isProcessAlive: pid => pid === 4343,
    })).resolves.toEqual({ recovered: [], quarantined: [] });

    expect(terminate).not.toHaveBeenCalled();
    await expect(store.readResult(runId)).resolves.toBeNull();
  });

  it("reclaims token-mismatched live locks and preserves matching live locks", async () => {
    const locksRoot = path.join(process.env.CLAUDE_PLUGIN_DATA!, "locks");
    const mismatchedPath = path.join(locksRoot, `${"b".repeat(64)}.lock`);
    const matchingPath = path.join(locksRoot, `${"c".repeat(64)}.lock`);
    const unverifiablePath = path.join(locksRoot, `${"d".repeat(64)}.lock`);
    await mkdir(locksRoot, { recursive: true });
    await writeFile(mismatchedPath, JSON.stringify({ pid: 7001, processToken: "old" }));
    await writeFile(matchingPath, JSON.stringify({ pid: 7002, processToken: "live" }));
    await writeFile(unverifiablePath, JSON.stringify({ pid: 7003, processToken: "recorded" }));
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});

    await recoverStaleRuns({
      platformServices: platformServicesDouble({
        os: "darwin",
        async getProcessStartToken(pid) {
          if (pid === 7001) return "new";
          if (pid === 7002) return "live";
          return null;
        },
        async terminateProcessTreeByPid() {},
      }),
      isProcessAlive: () => true,
    });

    await expectMissing(mismatchedPath);
    await expect(readFile(matchingPath, "utf8")).resolves.toContain("\"processToken\":\"live\"");
    await expect(readFile(unverifiablePath, "utf8"))
      .resolves.toContain("\"processToken\":\"recorded\"");
    expect(warn).toHaveBeenCalledWith("startup recovery preserved unverifiable lock", {
      event: "recovery-unverifiable-lock",
      lockName: path.basename(unverifiablePath),
      reason: "process-token-unavailable",
    });
    warn.mockRestore();
  });

  it("preserves malformed bare-pid locks, emits diagnostics, and recovers other runs", async () => {
    const repo = await initRepo();
    const blockedRunId = "run-a-bare-pid-lock";
    const healthyRunId = "run-z-healthy-lock";
    const blockedStore = await createUnfinishedRun(blockedRunId, repo.commonDir, null);
    const healthyRepo = await initRepo();
    const healthyStore = await createUnfinishedRun(healthyRunId, healthyRepo.commonDir, null);
    const locksRoot = path.join(process.env.CLAUDE_PLUGIN_DATA!, "locks");
    const deadPath = path.join(
      locksRoot,
      `${createHash("sha256").update(repo.commonDir).digest("hex")}.lock`,
    );
    const livePath = path.join(locksRoot, `${"e".repeat(64)}.lock`);
    const nullTokenPath = path.join(locksRoot, `${"f".repeat(64)}.lock`);
    await mkdir(locksRoot, { recursive: true });
    await writeFile(deadPath, "8001");
    await writeFile(livePath, "8002");
    await writeFile(nullTokenPath, JSON.stringify({ pid: 8003, processToken: null }));
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});

    await expect(recoverStaleRuns({
      platformServices: platformServicesDouble({
        os: "darwin",
        async getProcessStartToken() { return "irrelevant"; },
        async terminateProcessTreeByPid() {},
      }),
      isProcessAlive: pid => pid === 8002,
    })).resolves.toEqual({ recovered: [healthyRunId], quarantined: [] });

    await expect(readFile(deadPath, "utf8")).resolves.toBe("8001");
    await expect(readFile(livePath, "utf8")).resolves.toBe("8002");
    await expect(readFile(nullTokenPath, "utf8"))
      .resolves.toBe(JSON.stringify({ pid: 8003, processToken: null }));
    await expect(blockedStore.readResult(blockedRunId)).resolves.toBeNull();
    await expect(healthyStore.readResult(healthyRunId)).resolves.toMatchObject({
      status: "cancelled",
    });
    expect(warn.mock.calls).toEqual(expect.arrayContaining([
      ["startup recovery preserved malformed lock", {
        event: "recovery-malformed-lock",
        lockName: path.basename(deadPath),
        reason: "invalid-owner-record",
      }],
      ["startup recovery preserved malformed lock", {
        event: "recovery-malformed-lock",
        lockName: path.basename(livePath),
        reason: "invalid-owner-record",
      }],
      ["startup recovery preserved malformed lock", {
        event: "recovery-malformed-lock",
        lockName: path.basename(nullTokenPath),
        reason: "invalid-owner-record",
      }],
    ]));
    warn.mockRestore();
  });

  it("recovers state left under a stale plugin root", async () => {
    const repo = await initRepo();
    const runId = "run-stale-plugin-root";
    process.env.CLAUDE_PLUGIN_ROOT = path.join(await temporaryDirectory("old-plugin-root-"), "removed");
    const store = await createUnfinishedRun(runId, repo.commonDir, null);

    await expect(recoverStaleRuns({
      platformServices: platformServicesDouble({
        os: "darwin",
        async getProcessStartToken() { return null; },
        async terminateProcessTreeByPid() {},
      }),
      isProcessAlive: () => false,
    })).resolves.toEqual({ recovered: [runId], quarantined: [] });

    await expect(store.readResult(runId)).resolves.toMatchObject({ status: "cancelled" });
  });

  it("rejects a malformed complete cleanup record before torn-tail deferral", async () => {
    const runsRoot = path.join(process.env.CLAUDE_PLUGIN_DATA!, "runs");
    await mkdir(runsRoot, { recursive: true });
    await writeFile(
      path.join(runsRoot, "cleanup.ndjson"),
      "not-json\n{\"event\":\"prune-cleanup-com",
    );

    await expect(recoverStaleRuns()).rejects.toThrow(/cleanup journal contains invalid JSON/i);
  });

  it.each([
    ["blank", "\n"],
    ["whitespace-only", " \t\n"],
  ])("rejects a complete %s cleanup journal record", async (_description, contents) => {
    const runsRoot = path.join(process.env.CLAUDE_PLUGIN_DATA!, "runs");
    await mkdir(runsRoot, { recursive: true });
    await writeFile(path.join(runsRoot, "cleanup.ndjson"), contents);

    await expect(recoverStaleRuns()).rejects.toThrow(/cleanup journal contains a blank record/i);
  });

  it("rejects a hard-linked cleanup journal without mutating its alias", async () => {
    const runsRoot = path.join(process.env.CLAUDE_PLUGIN_DATA!, "runs");
    const journalPath = path.join(runsRoot, "cleanup.ndjson");
    const aliasPath = path.join(process.env.CLAUDE_PLUGIN_DATA!, "cleanup-journal-alias");
    const journalBytes = Buffer.alloc(0);
    await mkdir(runsRoot, { recursive: true });
    await writeFile(journalPath, journalBytes);
    await link(journalPath, aliasPath);

    await expect(recoverStaleRuns()).rejects.toThrow(/cleanup journal.*single-link/i);
    await expect(readFile(journalPath)).resolves.toEqual(journalBytes);
    await expect(readFile(aliasPath)).resolves.toEqual(journalBytes);
  });

  it("allows normal recovery when the cleanup journal is fully terminal", async () => {
    const repo = await initRepo();
    const runId = "run-terminal-cleanup-healthy";
    const store = await createUnfinishedRun(runId, repo.commonDir, null);
    const cleanupRunId = "run-terminal-cleanup-record";
    const runsRoot = path.join(process.env.CLAUDE_PLUGIN_DATA!, "runs");
    await writeFile(path.join(runsRoot, "cleanup.ndjson"), `${JSON.stringify({
      event: "prune-cleanup-complete",
      runId: cleanupRunId,
      reason: "max-age",
      anchorCleanup: "not-applicable",
      archiveBytes: 3,
      quarantineName: `.prune-${cleanupRunId}-00000000-0000-4000-8000-000000000006`,
      repoRoot: null,
      anchorRef: null,
      backupRef: null,
      candidateCommitOid: null,
      recordedAt: "2026-07-14T12:00:00.000Z",
    })}\n`);
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    let recoveryResult: Awaited<ReturnType<typeof recoverStaleRuns>> | undefined;
    let warnCalls: unknown[][] = [];
    try {
      recoveryResult = await recoverStaleRuns({ isProcessAlive: () => false });
    } finally {
      warnCalls = [...warn.mock.calls];
      warn.mockRestore();
    }

    expect(recoveryResult).toEqual({ recovered: [runId], quarantined: [] });
    expect(warnCalls).toEqual([]);
    await expect(store.readResult(runId)).resolves.toMatchObject({ status: "cancelled" });
  });

  it("finishes an interrupted prune after the archive was quarantined", async () => {
    const repo = await initRepo();
    const runId = "run-prune-finish";
    const anchorRef = `refs/claude-architect/candidates/${runId}`;
    const backupRef = `refs/claude-architect/prune-backups/${runId}`;
    const quarantineName = `.prune-${runId}-00000000-0000-4000-8000-000000000001`;
    const runsRoot = path.join(process.env.CLAUDE_PLUGIN_DATA!, "runs");
    const runDirectory = path.join(runsRoot, runId);
    const quarantinePath = path.join(runsRoot, quarantineName);
    await mkdir(runDirectory, { recursive: true });
    await writeFile(path.join(runDirectory, "result.json"), "{}\n");
    await runGit(repo.directory, ["update-ref", backupRef, repo.head]);
    await rename(runDirectory, quarantinePath);
    await writeFile(path.join(runsRoot, "cleanup.ndjson"), `${JSON.stringify({
      event: "prune-cleanup-intent",
      runId,
      reason: "max-age",
      anchorCleanup: "pending",
      archiveBytes: 3,
      quarantineName,
      repoRoot: repo.directory,
      anchorRef,
      backupRef,
      candidateCommitOid: repo.head,
      recordedAt: "2026-07-14T12:00:00.000Z",
    })}\n{"event":"prune-cleanup-com`);

    await recoverStaleRuns({
      platformServices: platformServicesDouble({
        os: hostOs,
        async getProcessStartToken() { return null; },
        async terminateProcessTreeByPid() {},
      }),
      isProcessAlive: () => false,
    });

    await expectMissing(quarantinePath);
    expect((await git(repo.directory, ["rev-parse", "--verify", "--quiet", backupRef])).exitCode)
      .not.toBe(0);
    const records = (await readFile(path.join(runsRoot, "cleanup.ndjson"), "utf8"))
      .trim().split("\n").map(line => JSON.parse(line) as { event: string });
    expect(records.map(record => record.event)).toEqual([
      "prune-cleanup-intent",
      "prune-cleanup-complete",
    ]);
  });

  it("reclaims a repo-gone interrupted prune without aborting recovery", async () => {
    const repo = await initRepo();
    const runId = "run-prune-repo-gone-finish";
    const anchorRef = `refs/claude-architect/candidates/${runId}`;
    const backupRef = `refs/claude-architect/prune-backups/${runId}`;
    const quarantineName = `.prune-${runId}-00000000-0000-4000-8000-000000000008`;
    const runsRoot = path.join(process.env.CLAUDE_PLUGIN_DATA!, "runs");
    const runDirectory = path.join(runsRoot, runId);
    const quarantinePath = path.join(runsRoot, quarantineName);
    await mkdir(runDirectory, { recursive: true });
    await writeFile(path.join(runDirectory, "result.json"), "{}\n");
    await rename(runDirectory, quarantinePath);
    await writeFile(path.join(runsRoot, "cleanup.ndjson"), `${JSON.stringify({
      event: "prune-cleanup-intent",
      runId,
      reason: "max-age",
      anchorCleanup: "pending",
      archiveBytes: 3,
      quarantineName,
      repoRoot: repo.directory,
      anchorRef,
      backupRef,
      candidateCommitOid: repo.head,
      recordedAt: "2026-07-14T12:00:00.000Z",
    })}\n{"event":"prune-cleanup-com`);

    // The repository this run was delegated from is deleted after the intent was
    // written. Its anchor/backup refs are gone with it. Recovery must reconcile the
    // quarantined archive without Git and converge — not throw in validateRepositoryRoot
    // and abort the whole pass (a permanent block, since replay runs first every pass).
    // Without the fix this test rejects with a realpath ENOENT before recovery completes.
    await rm(repo.directory, { recursive: true, force: true });

    await expect(recoverStaleRuns({
      platformServices: platformServicesDouble({
        os: hostOs,
        async getProcessStartToken() { return null; },
        async terminateProcessTreeByPid() {},
      }),
      isProcessAlive: () => false,
    })).resolves.toEqual({ recovered: [], quarantined: [] });

    await expectMissing(quarantinePath);
    const records = (await readFile(path.join(runsRoot, "cleanup.ndjson"), "utf8"))
      .trim().split("\n").map(line => JSON.parse(line) as { event: string });
    expect(records.map(record => record.event)).toEqual([
      "prune-cleanup-intent",
      "prune-cleanup-complete",
    ]);

    // Recovery must be rerunnable: a second pass re-parses the repo-absent completion
    // (non-null anchor fields + anchorCleanup "already-absent") and converges rather than
    // rejecting the journal as malformed.
    await expect(recoverStaleRuns({
      platformServices: platformServicesDouble({
        os: hostOs,
        async getProcessStartToken() { return null; },
        async terminateProcessTreeByPid() {},
      }),
      isProcessAlive: () => false,
    })).resolves.toEqual({ recovered: [], quarantined: [] });
  });

  it("rolls back a repo-gone interrupted prune whose archive is still retained", async () => {
    const repo = await initRepo();
    const runId = "run-prune-repo-gone-rollback";
    const anchorRef = `refs/claude-architect/candidates/${runId}`;
    const backupRef = `refs/claude-architect/prune-backups/${runId}`;
    const quarantineName = `.prune-${runId}-00000000-0000-4000-8000-000000000009`;
    const runsRoot = path.join(process.env.CLAUDE_PLUGIN_DATA!, "runs");
    const runDirectory = path.join(runsRoot, runId);
    await mkdir(runDirectory, { recursive: true });
    await writeFile(path.join(runDirectory, "result.json"), "{}\n");
    await writeFile(path.join(runsRoot, "cleanup.ndjson"), `${JSON.stringify({
      event: "prune-cleanup-intent",
      runId,
      reason: "max-bytes",
      anchorCleanup: "pending",
      archiveBytes: 3,
      quarantineName,
      repoRoot: repo.directory,
      anchorRef,
      backupRef,
      candidateCommitOid: repo.head,
      recordedAt: "2026-07-14T12:00:00.000Z",
    })}\n`);

    // The archive is still retained (prune crashed before quarantining) and the repo
    // then vanished. Recovery rolls the intent back without Git and leaves the archive
    // for a later prune's repo-gone path to reclaim — never throwing.
    await rm(repo.directory, { recursive: true, force: true });

    await expect(recoverStaleRuns({
      platformServices: platformServicesDouble({
        os: "darwin",
        async getProcessStartToken() { return null; },
        async terminateProcessTreeByPid() {},
      }),
      isProcessAlive: () => false,
    })).resolves.toEqual({ recovered: [], quarantined: [] });

    await expect(access(path.join(runDirectory, "result.json"))).resolves.toBeUndefined();
    const records = (await readFile(path.join(runsRoot, "cleanup.ndjson"), "utf8"))
      .trim().split("\n").map(line => JSON.parse(line) as { event: string });
    expect(records.map(record => record.event)).toEqual([
      "prune-cleanup-intent",
      "prune-cleanup-rollback",
    ]);

    // Rerunnable: a second pass re-parses the repo-absent rollback and converges.
    await expect(recoverStaleRuns({
      platformServices: platformServicesDouble({
        os: "darwin",
        async getProcessStartToken() { return null; },
        async terminateProcessTreeByPid() {},
      }),
      isProcessAlive: () => false,
    })).resolves.toEqual({ recovered: [], quarantined: [] });
  });

  it("fails closed on a malformed relative repoRoot instead of treating it as repo-gone", async () => {
    const runId = "run-prune-relative-reporoot";
    const quarantineName = `.prune-${runId}-00000000-0000-4000-8000-00000000000a`;
    const runsRoot = path.join(process.env.CLAUDE_PLUGIN_DATA!, "runs");
    await mkdir(path.join(runsRoot, runId), { recursive: true });
    await writeFile(path.join(runsRoot, "cleanup.ndjson"), `${JSON.stringify({
      event: "prune-cleanup-intent",
      runId,
      reason: "max-age",
      anchorCleanup: "pending",
      archiveBytes: 3,
      quarantineName,
      repoRoot: "relative/not-absolute/repo",
      anchorRef: null,
      backupRef: null,
      candidateCommitOid: null,
      recordedAt: "2026-07-14T12:00:00.000Z",
    })}\n`);

    // A relative repoRoot is a corrupted record, not a deleted repository. Recovery must
    // fail closed (validateRepositoryRoot rejects a non-absolute root) rather than resolve
    // it against the CWD and silently route it into the repo-absent reconcile path. Without
    // the absoluteness guard, realpath resolves it against the CWD, reports absence, and
    // recovery wrongly reconciles the run as repo-gone.
    await expect(recoverStaleRuns({
      platformServices: platformServicesDouble({
        os: "darwin",
        async getProcessStartToken() { return null; },
        async terminateProcessTreeByPid() {},
      }),
      isProcessAlive: () => false,
    })).rejects.toThrow(/not absolute/i);
  });

  it("reclaims a dead-owner cleanup journal lock before replaying an interrupted prune", async () => {
    const repo = await initRepo();
    const runId = "run-prune-journal-locked";
    const anchorRef = `refs/claude-architect/candidates/${runId}`;
    const backupRef = `refs/claude-architect/prune-backups/${runId}`;
    const quarantineName = `.prune-${runId}-00000000-0000-4000-8000-000000000007`;
    const runsRoot = path.join(process.env.CLAUDE_PLUGIN_DATA!, "runs");
    const runDirectory = path.join(runsRoot, runId);
    const quarantinePath = path.join(runsRoot, quarantineName);
    await mkdir(runDirectory, { recursive: true });
    await writeFile(path.join(runDirectory, "result.json"), "{}\n");
    await runGit(repo.directory, ["update-ref", backupRef, repo.head]);
    await rename(runDirectory, quarantinePath);
    await writeFile(path.join(runsRoot, "cleanup.ndjson"), `${JSON.stringify({
      event: "prune-cleanup-intent",
      runId,
      reason: "max-age",
      anchorCleanup: "pending",
      archiveBytes: 3,
      quarantineName,
      repoRoot: repo.directory,
      anchorRef,
      backupRef,
      candidateCommitOid: repo.head,
      recordedAt: "2026-07-14T12:00:00.000Z",
    })}\n{"event":"prune-cleanup-com`);

    // A previous process crashed while holding the cleanup-journal mutex, leaving its
    // lock file behind with a now-dead owner. Recovery must reclaim it before replay:
    // otherwise replayInterruptedPrunes spins to its acquire deadline, throws, and aborts
    // recovery before reclaimLocks runs — permanently blocking every future pass. Without
    // the up-front reclaim this test throws "cleanup journal is locked" after ~2.5s.
    const journalLockPath = path.join(
      process.env.CLAUDE_PLUGIN_DATA!, "locks", `${CLEANUP_JOURNAL_LOCK_KEY}.lock`,
    );
    await mkdir(path.dirname(journalLockPath), { recursive: true });
    await writeFile(journalLockPath, JSON.stringify({
      pid: 999_999,
      processToken: "stale-journal-owner",
    }));

    await recoverStaleRuns({
      platformServices: platformServicesDouble({
        os: hostOs,
        async getProcessStartToken() { return null; },
        async terminateProcessTreeByPid() {},
      }),
      isProcessAlive: () => false,
    });

    // The stale mutex is reclaimed and the prune it was blocking ran to completion.
    await expectMissing(journalLockPath);
    await expectMissing(quarantinePath);
    expect((await git(repo.directory, ["rev-parse", "--verify", "--quiet", backupRef])).exitCode)
      .not.toBe(0);
    const records = (await readFile(path.join(runsRoot, "cleanup.ndjson"), "utf8"))
      .trim().split("\n").map(line => JSON.parse(line) as { event: string });
    expect(records.map(record => record.event)).toEqual([
      "prune-cleanup-intent",
      "prune-cleanup-complete",
    ]);
  });

  it("rolls back an interrupted prune while the archive is still retained", async () => {
    const repo = await initRepo();
    const runId = "run-prune-rollback";
    const anchorRef = `refs/claude-architect/candidates/${runId}`;
    const backupRef = `refs/claude-architect/prune-backups/${runId}`;
    const quarantineName = `.prune-${runId}-00000000-0000-4000-8000-000000000002`;
    const runsRoot = path.join(process.env.CLAUDE_PLUGIN_DATA!, "runs");
    await mkdir(path.join(runsRoot, runId), { recursive: true });
    await runGit(repo.directory, ["update-ref", backupRef, repo.head]);
    await writeFile(path.join(runsRoot, "cleanup.ndjson"), `${JSON.stringify({
      event: "prune-cleanup-intent",
      runId,
      reason: "max-bytes",
      anchorCleanup: "pending",
      archiveBytes: 3,
      quarantineName,
      repoRoot: repo.directory,
      anchorRef,
      backupRef,
      candidateCommitOid: repo.head,
      recordedAt: "2026-07-14T12:00:00.000Z",
    })}\n`);

    await recoverStaleRuns({
      platformServices: platformServicesDouble({
        os: "darwin",
        async getProcessStartToken() { return null; },
        async terminateProcessTreeByPid() {},
      }),
      isProcessAlive: () => false,
    });

    expect(await runGit(repo.directory, ["rev-parse", anchorRef])).toBe(repo.head);
    expect((await git(repo.directory, ["rev-parse", "--verify", "--quiet", backupRef])).exitCode)
      .not.toBe(0);
    const records = (await readFile(path.join(runsRoot, "cleanup.ndjson"), "utf8"))
      .trim().split("\n").map(line => JSON.parse(line) as { event: string });
    expect(records.at(-1)?.event).toBe("prune-cleanup-rollback");
  });

  it("downgrades a verified candidate before clearing a dead sliced pipeline marker", async () => {
    const repo = await initRepo();
    const runId = "run-interrupted-pipeline-authority";
    const store = await createUnfinishedRun(runId, repo.commonDir, null);
    await writeVerifiedCandidate(store, runId, repo);
    await store.writePipelineActiveMarker({
      pid: 4242,
      processToken: "darwin:dead",
      startedAt: "2026-07-18T12:00:00.000Z",
      sliced: true,
    });

    await expect(recoverStaleRuns({
      platformServices: platformServicesDouble({
        os: "darwin",
        async getProcessStartToken() { return null; },
        async terminateProcessTreeByPid() {},
      }),
      isProcessAlive: () => false,
    })).resolves.toEqual({ recovered: [], quarantined: [] });

    await expect(store.readResult(runId)).resolves.toMatchObject({
      status: "failed",
      failure: "verification-failure",
      candidate: expect.any(Object),
      unresolvedIssues: ["pipeline-interrupted-before-terminal-cleanup"],
      evidence: {
        pipelineRecovery: "interrupted-before-terminal-cleanup",
      },
    });
    await expectMissing(path.join(store.runDirectory, "pipeline-active.json"));
  });

  it("preserves a verified candidate while clearing a dead non-sliced pipeline marker", async () => {
    const repo = await initRepo();
    const runId = "run-interrupted-non-sliced-pipeline";
    const store = await createUnfinishedRun(runId, repo.commonDir, null);
    await writeVerifiedCandidate(store, runId, repo);
    await store.writePipelineActiveMarker({
      pid: 4242,
      processToken: "darwin:dead",
      startedAt: "2026-07-18T12:00:00.000Z",
      sliced: false,
    });

    await expect(recoverStaleRuns({
      platformServices: platformServicesDouble({
        os: "darwin",
        async getProcessStartToken() { return null; },
        async terminateProcessTreeByPid() {},
      }),
      isProcessAlive: () => false,
    })).resolves.toEqual({ recovered: [], quarantined: [] });

    await expect(store.readResult(runId)).resolves.toMatchObject({
      status: "verified-candidate",
      failure: null,
    });
    await expectMissing(path.join(store.runDirectory, "pipeline-active.json"));
  });

  it("quarantines a terminal run with a legacy pipeline marker", async () => {
    const repo = await initRepo();
    const runId = "run-interrupted-legacy-pipeline";
    const store = await createUnfinishedRun(runId, repo.commonDir, null);
    await writeVerifiedCandidate(store, runId, repo);
    await writeFile(path.join(store.runDirectory, "pipeline-active.json"), `${JSON.stringify({
      pid: 4242,
      processToken: "darwin:dead",
      startedAt: "2026-07-18T12:00:00.000Z",
    })}\n`);

    await expect(recoverStaleRuns({
      platformServices: platformServicesDouble({
        os: "darwin",
        async getProcessStartToken() { return null; },
        async terminateProcessTreeByPid() {},
      }),
      isProcessAlive: () => false,
    })).resolves.toEqual({ recovered: [], quarantined: [runId] });

    await expectQuarantinedRun(runId, store.runDirectory);
  });

  it("sweeps every orphan worktree while keeping terminal ref cleanup run-scoped", async () => {
    const repo = await initRepo();
    const runId = "run-sliced-terminal";
    const neighborRunId = `${runId}-neighbor`;
    const store = await createUnfinishedRun(runId, repo.commonDir, null);
    await writeTerminalFailure(store, runId);
    const slicedWorktrees = await createManagedWorktrees(repo, slicedManagedIds(runId));
    const neighborWorktree = (await createManagedWorktrees(
      repo,
      [`${neighborRunId}-slice-1-attempt-0`],
    ))[0]!;
    const sliceRefs = [
      `refs/claude-architect/slices/${runId}/slice-1-attempt-1`,
      `refs/claude-architect/slices/${runId}/slice-2-attempt-0`,
    ];
    const neighborRef = `refs/claude-architect/slices/${neighborRunId}/slice-1-attempt-0`;
    for (const ref of [...sliceRefs, neighborRef]) {
      await runGit(repo.directory, ["update-ref", ref, repo.head]);
    }
    await store.writePipelineActiveMarker({
      pid: 4242,
      processToken: "darwin:dead",
      startedAt: "2026-07-18T12:00:00.000Z",
      sliced: true,
    });

    await expect(recoverStaleRuns({
      platformServices: platformServicesDouble({
        os: "darwin",
        async getProcessStartToken() { return null; },
        async terminateProcessTreeByPid() {},
      }),
      isProcessAlive: () => false,
    })).resolves.toEqual({ recovered: [], quarantined: [] });

    await Promise.all([...slicedWorktrees, neighborWorktree]
      .map(worktree => expectMissing(worktree.path)));
    for (const ref of sliceRefs) {
      expect((await git(repo.directory, ["rev-parse", "--verify", "--quiet", ref])).exitCode)
        .not.toBe(0);
    }
    expect(await runGit(repo.directory, ["rev-parse", neighborRef])).toBe(repo.head);
    await expectMissing(path.join(store.runDirectory, "pipeline-active.json"));
    await expect(recoverStaleRuns({
      platformServices: platformServicesDouble({
        os: "darwin",
        async getProcessStartToken() { return null; },
        async terminateProcessTreeByPid() {},
      }),
      isProcessAlive: () => false,
    })).resolves.toEqual({ recovered: [], quarantined: [] });
    await expectMissing(neighborWorktree.path);
    expect(await runGit(repo.directory, ["rev-parse", neighborRef])).toBe(repo.head);
  }, 120_000);

  it("cleans every sliced worktree and ref for an unfinished run idempotently", async () => {
    const repo = await initRepo();
    const runId = "run-sliced-unfinished";
    const store = await createUnfinishedRun(runId, repo.commonDir, null);
    const slicedWorktrees = await createManagedWorktrees(repo, slicedManagedIds(runId));
    const sliceRefs = [
      `refs/claude-architect/slices/${runId}/slice-1-attempt-1`,
      `refs/claude-architect/slices/${runId}/slice-2-attempt-0`,
    ];
    for (const ref of sliceRefs) await runGit(repo.directory, ["update-ref", ref, repo.head]);
    let worktreesGoneBeforeRefCleanup = false;

    await expect(recoverStaleRuns({
      platformServices: platformServicesDouble({
        os: "darwin",
        async getProcessStartToken() { return null; },
        async terminateProcessTreeByPid() {},
      }),
      isProcessAlive: () => false,
      git: async (cwd, args, options) => {
        if (args[0] === "update-ref" && args.includes("-d")) {
          const states = await Promise.all(slicedWorktrees.map(async worktree => {
            try { await access(worktree.path); return "present" as const; }
            catch { return "missing" as const; }
          }));
          worktreesGoneBeforeRefCleanup = states.every(state => state === "missing");
        }
        return await git(cwd, args, options);
      },
    })).resolves.toEqual({ recovered: [runId], quarantined: [] });

    expect(worktreesGoneBeforeRefCleanup).toBe(true);
    await Promise.all(slicedWorktrees.map(worktree => expectMissing(worktree.path)));
    for (const ref of sliceRefs) {
      expect((await git(repo.directory, ["rev-parse", "--verify", "--quiet", ref])).exitCode)
        .not.toBe(0);
    }
    await expect(store.readResult(runId)).resolves.toMatchObject({ status: "cancelled" });
    await expect(recoverStaleRuns({
      platformServices: platformServicesDouble({
        os: "darwin",
        async getProcessStartToken() { return null; },
        async terminateProcessTreeByPid() {},
      }),
      isProcessAlive: () => false,
    })).resolves.toEqual({ recovered: [], quarantined: [] });
  }, 120_000);

  it("fails closed on a malformed ref inside the run-specific slice namespace", async () => {
    const repo = await initRepo();
    const runId = "run-sliced-malformed-ref";
    const store = await createUnfinishedRun(runId, repo.commonDir, null);
    const malformedRef = `refs/claude-architect/slices/${runId}/unexpected`;
    await runGit(repo.directory, ["update-ref", malformedRef, repo.head]);

    await expect(recoverStaleRuns({
      platformServices: platformServicesDouble({
        os: "darwin",
        async getProcessStartToken() { return null; },
        async terminateProcessTreeByPid() {},
      }),
      isProcessAlive: () => false,
    })).resolves.toEqual({ recovered: [], quarantined: [runId] });

    const record = await expectQuarantinedRun(runId, store.runDirectory);
    expect(record).toContain("temporary slice ref name is malformed during recovery");
    expect(await runGit(repo.directory, ["rev-parse", malformedRef])).toBe(repo.head);
  });

  it("fails closed when a slice ref points to a tag that peels to a commit", async () => {
    const repo = await initRepo();
    const runId = "run-sliced-tag-ref";
    const store = await createUnfinishedRun(runId, repo.commonDir, null);
    const sliceRef = `refs/claude-architect/slices/${runId}/slice-2-attempt-0`;
    await runGit(repo.directory, ["tag", "-a", "slice-tag", "-m", "slice tag", repo.head]);
    const tagOid = await runGit(repo.directory, ["rev-parse", "refs/tags/slice-tag"]);
    await runGit(repo.directory, ["update-ref", sliceRef, tagOid]);

    await expect(recoverStaleRuns({
      platformServices: platformServicesDouble({
        os: "darwin",
        async getProcessStartToken() { return null; },
        async terminateProcessTreeByPid() {},
      }),
      isProcessAlive: () => false,
    })).resolves.toEqual({ recovered: [], quarantined: [runId] });

    const record = await expectQuarantinedRun(runId, store.runDirectory);
    expect(record).toContain("temporary slice ref does not identify a commit during recovery");
    expect(await runGit(repo.directory, ["rev-parse", sliceRef])).toBe(tagOid);
  });

  it("rejects a non-commit slice ref even when a replacement object spoofs its type", async () => {
    const repo = await initRepo();
    const runId = "run-sliced-replacement-spoof";
    const store = await createUnfinishedRun(runId, repo.commonDir, null);
    const sliceRef = `refs/claude-architect/slices/${runId}/slice-2-attempt-0`;
    const treeOid = await runGit(repo.directory, ["rev-parse", `${repo.head}^{tree}`]);
    await runGit(repo.directory, ["update-ref", sliceRef, treeOid]);
    await runGit(repo.directory, ["update-ref", `refs/replace/${treeOid}`, repo.head]);
    expect(await runGit(repo.directory, ["cat-file", "-t", treeOid])).toBe("commit");

    await expect(recoverStaleRuns({
      platformServices: platformServicesDouble({
        os: "darwin",
        async getProcessStartToken() { return null; },
        async terminateProcessTreeByPid() {},
      }),
      isProcessAlive: () => false,
    })).resolves.toEqual({ recovered: [], quarantined: [runId] });

    const record = await expectQuarantinedRun(runId, store.runDirectory);
    expect(record).toContain("temporary slice ref does not identify a commit during recovery");
    expect(await runGit(repo.directory, ["rev-parse", sliceRef])).toBe(treeOid);
  });

  it("disables replacement objects only for temporary-ref object type validation", async () => {
    const repo = await initRepo();
    const runId = "run-sliced-no-replace-scope";
    await createUnfinishedRun(runId, repo.commonDir, null);
    const sliceRef = `refs/claude-architect/slices/${runId}/slice-2-attempt-0`;
    await runGit(repo.directory, ["update-ref", sliceRef, repo.head]);
    const observed: Array<{ command: string; noReplace: string | undefined }> = [];

    await expect(recoverStaleRuns({
      platformServices: platformServicesDouble({
        os: "darwin",
        async getProcessStartToken() { return null; },
        async terminateProcessTreeByPid() {},
      }),
      isProcessAlive: () => false,
      git: async (cwd, args, options) => {
        observed.push({
          command: args[0] ?? "",
          noReplace: typeof options === "object"
            ? options.env?.GIT_NO_REPLACE_OBJECTS
            : undefined,
        });
        return git(cwd, args, options);
      },
    })).resolves.toEqual({ recovered: [runId], quarantined: [] });

    expect(observed.filter(call => call.command === "cat-file"))
      .toEqual([{ command: "cat-file", noReplace: "1" }]);
    expect(observed.filter(call => call.command !== "cat-file").every(
      call => call.noReplace === undefined,
    )).toBe(true);
  });

  it("fails closed when a slice ref moves after recovery enumeration", async () => {
    const repo = await initRepo();
    const runId = "run-sliced-moved-ref";
    const store = await createUnfinishedRun(runId, repo.commonDir, null);
    const sliceRef = `refs/claude-architect/slices/${runId}/slice-2-attempt-0`;
    await runGit(repo.directory, ["update-ref", sliceRef, repo.head]);
    const movedOid = await runGit(repo.directory, [
      "commit-tree",
      `${repo.head}^{tree}`,
      "-p",
      repo.head,
      "-m",
      "moved slice ref",
    ]);
    let moved = false;

    await expect(recoverStaleRuns({
      platformServices: platformServicesDouble({
        os: "darwin",
        async getProcessStartToken() { return null; },
        async terminateProcessTreeByPid() {},
      }),
      isProcessAlive: () => false,
      git: async (cwd, args, options) => {
        const result = await git(cwd, args, options);
        if (!moved && args[0] === "for-each-ref") {
          moved = true;
          await runGit(repo.directory, ["update-ref", sliceRef, movedOid, repo.head]);
        }
        return result;
      },
    })).resolves.toEqual({ recovered: [], quarantined: [runId] });

    const record = await expectQuarantinedRun(runId, store.runDirectory);
    expect(record).toContain("temporary slice ref moved during recovery");
    expect(await runGit(repo.directory, ["rev-parse", sliceRef])).toBe(movedOid);
  });
});

describe("MCP startup recovery", () => {
  it("recovers stale state before connecting the transport", async () => {
    await start({
      async recoverStaleRuns() {
        serverEvents.push("recover");
        return { recovered: [], quarantined: [] };
      },
      async pruneRuns() {
        return { removed: [], retained: [] };
      },
    });

    expect(serverEvents).toEqual(["recover", "connect"]);
  });

  it("prunes run archives after recovery and before connecting", async () => {
    await start({
      async recoverStaleRuns() {
        serverEvents.push("recover");
        return { recovered: [], quarantined: [] };
      },
      async pruneRuns() {
        serverEvents.push("prune");
        return { removed: [], retained: [] };
      },
    });

    expect(serverEvents).toEqual(["recover", "prune", "connect"]);
  });

  it("surfaces bounded sweep issues without logging worktree paths", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const sensitivePath = "/Users/example/private-project/worktree";
    let diagnostics = "";
    try {
      await start({
        async recoverStaleRuns() {
          serverEvents.push("recover");
          return {
            recovered: [],
            quarantined: [],
            worktreeSweepIssues: [{
              worktreePath: sensitivePath,
              reason: "repository identity lookup failed",
            }],
          };
        },
        async pruneRuns() {
          return { removed: [], retained: [] };
        },
      });
      diagnostics = error.mock.calls.flat().join("\n");
    } finally {
      error.mockRestore();
    }

    expect(diagnostics).toContain("worktree sweep preserved 1 ambiguous path");
    expect(diagnostics).toContain("repository identity lookup failed");
    expect(diagnostics).not.toContain(sensitivePath);
    expect(Buffer.byteLength(diagnostics, "utf8")).toBeLessThanOrEqual(2_500);
    expect(serverEvents).toEqual(["recover", "connect"]);
  });

  it("connects even when startup pruning fails", async () => {
    await expect(start({
      async recoverStaleRuns() {
        serverEvents.push("recover");
        return { recovered: [], quarantined: [] };
      },
      async pruneRuns() {
        serverEvents.push("prune");
        throw new Error("prune failed at startup");
      },
    })).resolves.toBeUndefined();

    expect(serverEvents).toEqual(["recover", "prune", "connect"]);
  });
});
