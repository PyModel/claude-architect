import { access, link, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { recoverStaleRuns } from "../../src/runtime/recovery-manager.js";
import { recoverPendingWorktreeRemovals } from "../../src/runtime/recovery-worktree-removals.js";
import { PlatformSafety } from "../../src/platform/platform-safety.js";
import {
  assertNoPendingWorktreeRemovalForRepository,
  persistWorktreeRemovalManifest,
  readPendingWorktreeRemovalManifests,
  replaceWorktreeRemovalManifest,
  type WorktreeRemovalManifest,
} from "../../src/runtime/worktree-removal-manifest.js";

const transactionId = "00000000-0000-4000-8000-000000000123";
let stateRoot: string;
let previousPluginData: string | undefined;
let previousNodeEnvironment: string | undefined;

function manifest(): WorktreeRemovalManifest {
  const commonDir = path.join(stateRoot, "repository", ".git");
  const physicalRoot = path.join(stateRoot, "worktrees");
  const registrationRoot = path.join(commonDir, "worktrees");
  const quarantineRoot = path.join(commonDir, "claude-architect-quarantine");
  return {
    manifestVersion: "1",
    transactionId,
    phase: "registration-staged",
    commonDir,
    commonDirDev: "10",
    commonDirIno: "11",
    commonDirBirthtimeNs: "12",
    physicalPresent: true,
    physicalPath: path.join(physicalRoot, "run-1"),
    physicalQuarantinePath: path.join(physicalRoot, `.remove-run-1-${transactionId}`),
    physicalDev: "1",
    physicalIno: "2",
    physicalBirthtimeNs: "5",
    physicalRootDev: "13",
    physicalRootIno: "14",
    physicalRootBirthtimeNs: "15",
    registrationRoot,
    registrationRootDev: "16",
    registrationRootIno: "17",
    registrationRootBirthtimeNs: "18",
    registrationPath: path.join(registrationRoot, "run-1"),
    quarantineRoot,
    quarantineRootDev: "19",
    quarantineRootIno: "20",
    quarantineRootBirthtimeNs: "21",
    quarantinePath: path.join(
      quarantineRoot,
      `.remove-registration-run-1-${transactionId}`,
    ),
    registrationDev: "3",
    registrationIno: "4",
    registrationBirthtimeNs: "6",
  };
}

beforeEach(async () => {
  previousPluginData = process.env.CLAUDE_PLUGIN_DATA;
  previousNodeEnvironment = process.env.NODE_ENV;
  stateRoot = await mkdtemp(path.join(tmpdir(), "worktree-removal-manifest-test-"));
  process.env.CLAUDE_PLUGIN_DATA = stateRoot;
  process.env.NODE_ENV = "test";
});

afterEach(async () => {
  if (previousPluginData === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
  else process.env.CLAUDE_PLUGIN_DATA = previousPluginData;
  if (previousNodeEnvironment === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = previousNodeEnvironment;
  await rm(stateRoot, { recursive: true, force: true });
});

describe("worktree removal manifest recovery", () => {
  it("releases a newly acquired lease when runtime mutation remains ambiguous", async () => {
    const root = path.join(stateRoot, "worktree-removals");
    const commonDir = path.join(stateRoot, "repository.git");
    await Promise.all([mkdir(root, { mode: 0o700 }), mkdir(commonDir)]);
    const pending = { ...manifest(), commonDir };
    await writeFile(
      path.join(root, `${transactionId}.json`),
      `${JSON.stringify(pending)}\n`,
      { mode: 0o600 },
    );
    const repositoryIdentity = await realpath(commonDir);
    const release = vi.fn(async () => {});
    const safety = new PlatformSafety({
      acquireCheckoutLock: vi.fn(async () => ({
        key: "test-lock",
        repositoryIdentity,
        release,
      })),
      canonicalizePath: vi.fn(async (p: string) => ({
        canonical: p,
        gitCommonDir: commonDir,
      })),
    });

    await expect(safety.withCheckoutLease(commonDir, async () => {})).rejects.toMatchObject({
      message: "worktree mutation is unavailable while removal recovery remains ambiguous",
      detail: expect.objectContaining({ classification: "recovery-ambiguous" }),
    });
    expect(release).toHaveBeenCalledOnce();
  });


  it("rechecks pending removal state after acquiring the repository lease", async () => {
    const root = path.join(stateRoot, "worktree-removals");
    const commonDir = path.join(stateRoot, "repository.git");
    const unrelated = path.join(stateRoot, "unrelated.git");
    await Promise.all([
      mkdir(root, { mode: 0o700 }),
      mkdir(commonDir),
      mkdir(unrelated),
    ]);
    const pending = { ...manifest(), commonDir };
    await writeFile(
      path.join(root, `${transactionId}.json`),
      `${JSON.stringify(pending)}\n`,
      { mode: 0o600 },
    );

    await expect(assertNoPendingWorktreeRemovalForRepository(await realpath(commonDir)))
      .rejects.toThrow("pending worktree removal transaction");
    await expect(assertNoPendingWorktreeRemovalForRepository(await realpath(unrelated)))
      .resolves.toBeUndefined();
  });

  it("ignores another operation's recognized hard-link capability probe", async () => {
    const root = path.join(stateRoot, "worktree-removals");
    const commonDir = path.join(stateRoot, "repository.git");
    await Promise.all([mkdir(root, { mode: 0o700 }), mkdir(commonDir)]);
    const token = "00000000-0000-4000-8000-000000000124";
    const source = path.join(root, `.hardlink-probe-${token}.source`);
    const linked = path.join(root, `.hardlink-probe-${token}.linked`);
    await writeFile(source, "probe\n", { mode: 0o600 });
    await link(source, linked);

    await expect(assertNoPendingWorktreeRemovalForRepository(await realpath(commonDir)))
      .resolves.toBeUndefined();
  });

  it("rejects oversized manifests before persistence or replacement", async () => {
    const oversized = {
      ...manifest(),
      physicalPath: `/${"x".repeat(40_000)}`,
    };
    await expect(persistWorktreeRemovalManifest(oversized)).rejects.toThrow(
      "exceeds its recovery size limit",
    );

    const original = manifest();
    const manifestPath = await persistWorktreeRemovalManifest(original);
    const before = await readFile(manifestPath);
    await expect(replaceWorktreeRemovalManifest(manifestPath, oversized)).rejects.toThrow(
      "exceeds its recovery size limit",
    );
    await expect(readFile(manifestPath)).resolves.toEqual(before);
  });

  it("rejects cwd-dependent relative paths in persisted removal ownership", async () => {
    const root = path.join(stateRoot, "worktree-removals");
    await mkdir(root, { mode: 0o700 });
    const relative = {
      ...manifest(),
      commonDir: ".git",
      registrationRoot: path.join(".git", "worktrees"),
      registrationPath: path.join(".git", "worktrees", "run-1"),
      quarantineRoot: path.join(".git", "claude-architect-quarantine"),
      quarantinePath: path.join(".git", "claude-architect-quarantine", "run-1"),
    };
    const manifestPath = path.join(root, `${transactionId}.json`);
    await writeFile(manifestPath, `${JSON.stringify(relative)}\n`, { mode: 0o600 });

    const result = await readPendingWorktreeRemovalManifests();

    expect(result.pending).toEqual([]);
    expect(result.issues).toEqual([{
      manifestPath,
      error: expect.objectContaining({ message: "worktree removal manifest is malformed" }),
    }]);
  });

  it("retains linked publication residue for settlement under the checkout lease", async () => {
    const root = path.join(stateRoot, "worktree-removals");
    await mkdir(root, { mode: 0o700 });
    const temporaryPath = path.join(
      root,
      `.${transactionId}.00000000-0000-4000-8000-000000000124.tmp`,
    );
    const publishedPath = path.join(root, `${transactionId}.json`);
    await writeFile(temporaryPath, `${JSON.stringify(manifest())}\n`, { mode: 0o600 });
    await link(temporaryPath, publishedPath);

    const result = await readPendingWorktreeRemovalManifests();

    expect(result.issues).toEqual([]);
    expect(result.pending).toEqual([{
      manifestPath: publishedPath,
      manifest: manifest(),
      temporaryPath,
      temporaryKind: "linked",
    }]);
    await expect(access(temporaryPath)).resolves.toBeUndefined();
    expect((await lstat(publishedPath)).nlink).toBe(2);
  });

  it("removes an unpublished temporary manifest without requiring its repository", async () => {
    const root = path.join(stateRoot, "worktree-removals");
    await mkdir(root, { mode: 0o700 });
    const temporaryPath = path.join(
      root,
      `.${transactionId}.00000000-0000-4000-8000-000000000126.tmp`,
    );
    await writeFile(temporaryPath, `${JSON.stringify(manifest())}\n`, { mode: 0o600 });

    await expect(recoverPendingWorktreeRemovals()).resolves.toEqual([]);
    await expect(access(temporaryPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("recovers a manifest-removal guard without losing published evidence", async () => {
    const root = path.join(stateRoot, "worktree-removals");
    await mkdir(root, { mode: 0o700 });
    const publishedPath = path.join(root, `${transactionId}.json`);
    const guardPath = path.join(
      root,
      `.remove-manifest-${transactionId}.00000000-0000-4000-8000-000000000128.guard`,
    );
    await writeFile(publishedPath, `${JSON.stringify(manifest())}\n`, { mode: 0o600 });
    await link(publishedPath, guardPath);

    const result = await readPendingWorktreeRemovalManifests();

    expect(result).toEqual({
      pending: [{ manifestPath: publishedPath, manifest: manifest() }],
      issues: [],
    });
    await expect(access(guardPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await lstat(publishedPath)).nlink).toBe(1);
  });

  it("removes incomplete hard-link probe residue without blocking recovery", async () => {
    const root = path.join(stateRoot, "worktree-removals");
    await mkdir(root, { mode: 0o700 });
    const probePath = path.join(
      root,
      ".hardlink-probe-00000000-0000-4000-8000-000000000127.source",
    );
    await writeFile(probePath, "partial probe\n", { mode: 0o600 });

    await expect(readPendingWorktreeRemovalManifests()).resolves.toEqual({
      pending: [],
      issues: [],
    });
    await expect(access(probePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reports ambiguous temporary residue and suppresses orphan sweeping", async () => {
    const root = path.join(stateRoot, "worktree-removals");
    const worktreePath = path.join(stateRoot, "worktrees", "unrelated-recordless-worktree");
    await Promise.all([
      mkdir(root, { mode: 0o700 }),
      mkdir(worktreePath, { recursive: true }),
    ]);
    const sourcePath = path.join(root, "ambiguous-source.bin");
    const temporaryPath = path.join(
      root,
      `.${transactionId}.00000000-0000-4000-8000-000000000125.tmp`,
    );
    await writeFile(sourcePath, "ambiguous\n");
    await link(sourcePath, temporaryPath);

    const result = await recoverStaleRuns();

    expect(result.worktreeSweepIssues?.some(issue =>
      issue.worktreePath === temporaryPath
      && issue.reason.includes("ENOENT"))).toBe(true);
    await expect(access(worktreePath)).resolves.toBeUndefined();
  });
});
