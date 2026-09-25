import { realpathSync } from "node:fs";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  access,
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  rmdir as removeEmptyDirectory,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { git } from "../../src/git/git-exec.js";
import { gitNulRecords, gitPathOutput } from "../../src/git/git-output.js";
import type { PlatformServices } from "../../src/platform/platform-services.js";
import { syncDirectoryMetadata } from "../../src/platform/durable-directory.js";
import { getPlatformServices } from "../../src/platform/select-platform.js";
import { windowsEssentialEnvironment } from "../../src/platform/windows-env.js";
import { platformPathsEqual } from "../../src/util/platform-path.js";
import { recoverStaleRuns } from "../../src/runtime/recovery-manager.js";
import { recoverPendingWorktreeRemovals } from "../../src/runtime/recovery-worktree-removals.js";
import { ArtifactStore } from "../../src/runtime/artifact-store.js";
import {
  managedWorktreeDirectoryIdentity,
  removeManagedWorktreeDirectory,
  WorktreeManager,
} from "../../src/runtime/worktree-manager.js";

// git prints worktree paths in its own format, which is forward-slashed on
// Windows; resolve them so these assertions compare paths rather than bytes.
async function removalRootIdentities(
  commonDir: string,
  physicalRoot: string,
  registrationRoot: string,
  quarantineRoot: string,
) {
  const [common, physical, registration, quarantine] = await Promise.all([
    managedWorktreeDirectoryIdentity(commonDir),
    managedWorktreeDirectoryIdentity(physicalRoot),
    managedWorktreeDirectoryIdentity(registrationRoot),
    managedWorktreeDirectoryIdentity(quarantineRoot),
  ]);
  if (common === null || physical === null || registration === null || quarantine === null) {
    throw new Error("removal fixture root disappeared");
  }
  return {
    commonDirDev: common.dev.toString(),
    commonDirIno: common.ino.toString(),
    commonDirBirthtimeNs: common.birthtimeNs.toString(),
    physicalRootDev: physical.dev.toString(),
    physicalRootIno: physical.ino.toString(),
    physicalRootBirthtimeNs: physical.birthtimeNs.toString(),
    registrationRootDev: registration.dev.toString(),
    registrationRootIno: registration.ino.toString(),
    registrationRootBirthtimeNs: registration.birthtimeNs.toString(),
    quarantineRootDev: quarantine.dev.toString(),
    quarantineRootIno: quarantine.ino.toString(),
    quarantineRootBirthtimeNs: quarantine.birthtimeNs.toString(),
  };
}

async function registeredWorktrees(repository: string): Promise<string[]> {
  const listed = await git(repository, ["worktree", "list", "--porcelain", "-z"]);
  // A failed list yields empty stdout, which would make every "no longer
  // registered" assertion below pass for the wrong reason.
  expect(listed, listed.stderr).toMatchObject({ exitCode: 0 });
  return await Promise.all(listed.stdout.split("\0")
    .filter(field => field.startsWith("worktree "))
    .map(async field => await realpath(resolve(field.slice("worktree ".length)))));
}

let temporaryPaths: string[] = [];
let previousPluginData: string | undefined;
let previousStateDirectory: string | undefined;
let previousNodeEnvironment: string | undefined;

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  temporaryPaths.push(directory);
  return directory;
}

async function canonicalPathsEqual(left: string, right: string): Promise<boolean> {
  try {
    const [canonicalLeft, canonicalRight] = await Promise.all([realpath(left), realpath(right)]);
    return platformPathsEqual(canonicalLeft, canonicalRight);
  } catch {
    return platformPathsEqual(left, right);
  }
}

function managedRootOf(repo: string): string {
  return join(realpathSync(repo), ".worktrees", "claude-architect");
}

async function runGit(cwd: string, args: string[]): Promise<string> {
  const result = await git(cwd, args);
  expect(result.exitCode, result.stderr).toBe(0);
  return result.stdout.trim();
}

async function initRepo(pathLabel?: string): Promise<{ directory: string; base: string }> {
  const parent = await temporaryDirectory("ca-worktree-repo-");
  const directory = pathLabel === undefined ? parent : join(parent, pathLabel);
  if (pathLabel !== undefined) await mkdir(directory);
  await runGit(directory, ["init", "-q"]);
  await writeFile(join(directory, "a.txt"), "hello\n");
  await runGit(directory, ["add", "-A"]);
  await runGit(directory, ["commit", "-q", "-m", "init"]);
  return { directory, base: await runGit(directory, ["rev-parse", "HEAD"]) };
}

beforeEach(async () => {
  previousPluginData = process.env.CLAUDE_PLUGIN_DATA;
  previousStateDirectory = process.env.CLAUDE_ARCHITECT_STATE_DIR;
  previousNodeEnvironment = process.env.NODE_ENV;
  process.env.CLAUDE_PLUGIN_DATA = await temporaryDirectory("ca-plugin-data-");
  delete process.env.CLAUDE_ARCHITECT_STATE_DIR;
});

afterEach(async () => {
  if (previousPluginData === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
  else process.env.CLAUDE_PLUGIN_DATA = previousPluginData;
  if (previousStateDirectory === undefined) delete process.env.CLAUDE_ARCHITECT_STATE_DIR;
  else process.env.CLAUDE_ARCHITECT_STATE_DIR = previousStateDirectory;
  if (previousNodeEnvironment === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = previousNodeEnvironment;
  await Promise.all(temporaryPaths.map(path => rm(path, { recursive: true, force: true })));
  temporaryPaths = [];
});

describe("WorktreeManager", () => {
  it("quarantines a dirty worktree before pruning its registration", async () => {
    const { directory, base } = await initRepo();
    let directGitRemoval = false;
    let repositoryWidePrune = false;
    const manager = new WorktreeManager(directory, "stuck", undefined, {
      git: async (cwd, args) => {
        if (args[0] === "worktree" && args[1] === "remove") directGitRemoval = true;
        if (args[0] === "worktree" && args[1] === "prune") repositoryWidePrune = true;
        return git(cwd, args);
      },
    });
    const worktree = await manager.create(base);
    await writeFile(join(worktree.path, "held-open.txt"), "child still writing\n");

    await worktree.cleanup();

    expect(directGitRemoval).toBe(false);
    expect(repositoryWidePrune).toBe(false);
    await expect(stat(worktree.path)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await runGit(directory, ["worktree", "list"])).not.toContain("stuck");
  });

  it("creates a detached attempt worktree under persistent plugin data and cleans it up", async () => {
    const { directory, base } = await initRepo();
    const manager = new WorktreeManager(directory, "run-123");

    const attempt = await manager.create(base);

    expect(attempt.path).toBe(await realpath(
      join(managedRootOf(directory), "run-123"),
    ));
    await expect(stat(attempt.path)).resolves.toBeDefined();
    expect(await runGit(attempt.path, ["rev-parse", "HEAD"])).toBe(base);
    expect((await git(attempt.path, ["symbolic-ref", "-q", "HEAD"])).exitCode).not.toBe(0);

    await attempt.cleanup();

    await expect(stat(attempt.path)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await registeredWorktrees(directory)).not.toContain(resolve(attempt.path));
  });

  it("removes a worktree through the downstream remove method", async () => {
    const { directory, base } = await initRepo();
    const manager = new WorktreeManager(directory, "run-remove");
    const attempt = await manager.create(base);

    await manager.remove(attempt.path);

    await expect(stat(attempt.path)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await registeredWorktrees(directory)).not.toContain(resolve(attempt.path));
  });

  it("pins Git to the managed registration so a rewritten .git pointer cannot run commands", async () => {
    const { directory, base } = await initRepo();
    const manager = new WorktreeManager(directory, "run-pinned");
    const attempt = await manager.create(base);
    const hostile = await temporaryDirectory("ca-hostile-gitdir-");
    const marker = join(hostile, "textconv-ran");
    await runGit(hostile, ["init", "-q"]);
    await writeFile(
      join(hostile, ".git", "config"),
      `[diff "x"]\n\ttextconv = "${process.execPath}" -e "require('fs').writeFileSync('${marker.replaceAll("\\", "/")}','')"\n`,
      { flag: "a" },
    );
    await writeFile(join(attempt.path, ".git"), `gitdir: ${join(hostile, ".git")}\n`);
    await writeFile(join(attempt.path, ".gitattributes"), "a.txt diff=x\n");
    await writeFile(join(attempt.path, "a.txt"), "changed\n");

    const diff = await git(attempt.path, ["diff", "--stat"]);
    const head = await git(attempt.path, ["rev-parse", "HEAD"]);

    expect(diff.exitCode, diff.stderr).toBe(0);
    expect(diff.stdout).toContain("a.txt");
    expect(head.stdout.trim()).toBe(base);
    await expect(stat(marker)).rejects.toMatchObject({ code: "ENOENT" });

    await attempt.cleanup();

    await expect(stat(attempt.path)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(marker)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await registeredWorktrees(directory)).not.toContain(resolve(attempt.path));
  });

  it("retries a locked Windows quarantine rename until it succeeds", async () => {
    const { directory, base } = await initRepo();
    const delays: number[] = [];
    let physicalMoves = 0;
    const physicalPath = join(managedRootOf(directory), "run-retry");
    const manager = new WorktreeManager(directory, "run-retry", { os: "win32" }, {
      async rename(source, destination) {
        if (await canonicalPathsEqual(source, physicalPath)) {
          physicalMoves += 1;
          if (physicalMoves < 3) {
            const error = new Error("locked") as NodeJS.ErrnoException;
            error.code = "EBUSY";
            throw error;
          }
        }
        await rename(source, destination);
      },
      delay: async milliseconds => { delays.push(milliseconds); },
    });
    const attempt = await manager.create(base);

    await attempt.cleanup();

    expect(physicalMoves).toBe(3);
    expect(delays).toEqual([250, 250]);
  });

  it("preserves the worktree after exhausting quarantine rename retries", async () => {
    const { directory, base } = await initRepo();
    const delays: number[] = [];
    let moves = 0;
    const physicalPath = join(managedRootOf(directory), "run-exhausted");
    const manager = new WorktreeManager(directory, "run-exhausted", { os: "win32" }, {
      async rename(source, destination) {
        if (!await canonicalPathsEqual(source, physicalPath)) {
          await rename(source, destination);
          return;
        }
        moves += 1;
        const error = new Error("locked") as NodeJS.ErrnoException;
        error.code = "EBUSY";
        throw error;
      },
      delay: async milliseconds => { delays.push(milliseconds); },
    });
    const attempt = await manager.create(base);

    try {
      await expect(attempt.cleanup()).rejects.toThrow("could not be quarantined");
      await expect(stat(attempt.path)).resolves.toBeDefined();
      expect(await registeredWorktrees(directory)).toContain(await realpath(attempt.path));
      expect(moves).toBe(5);
      expect(delays).toEqual([250, 250, 250, 250]);
    } finally {
      await new WorktreeManager(directory, "run-exhausted").remove(attempt.path);
    }
  });

  it("restores registration before physical removal when verification fails", async () => {
    const { directory, base } = await initRepo();
    let listCalls = 0;
    const manager = new WorktreeManager(directory, "run-registration-verification", undefined, {
      git: async (cwd, args, options) => {
        if (args[0] === "worktree" && args[1] === "list") {
          listCalls += 1;
          if (listCalls === 2) {
            return { exitCode: 1, stdout: "", stderr: "simulated registration lookup failure" };
          }
        }
        return await git(cwd, args, options);
      },
    });
    const attempt = await manager.create(base);

    try {
      await expect(attempt.cleanup()).rejects.toThrow("simulated registration lookup failure");
      await expect(stat(attempt.path)).resolves.toBeDefined();
      expect(await registeredWorktrees(directory)).toContain(await realpath(attempt.path));
    } finally {
      await new WorktreeManager(directory, "run-registration-verification").remove(attempt.path);
    }
  });

  it("retains the manifest when registration rollback cannot be durably synced", async () => {
    const { directory, base } = await initRepo();
    let listCalls = 0;
    let syncCalls = 0;
    let cleanupStarted = false;
    const manager = new WorktreeManager(directory, "run-rollback-sync-failure", undefined, {
      git: async (cwd, args, options) => {
        if (args[0] === "worktree" && args[1] === "list") {
          listCalls += 1;
          if (listCalls === 2) {
            return { exitCode: 1, stdout: "", stderr: "simulated registration lookup failure" };
          }
        }
        return await git(cwd, args, options);
      },
      async syncDirectory() {
        if (!cleanupStarted) return;
        syncCalls += 1;
        if (syncCalls >= 4) throw new Error("simulated rollback directory sync failure");
      },
    });
    const attempt = await manager.create(base);
    cleanupStarted = true;
    const manifestRoot = join(process.env.CLAUDE_PLUGIN_DATA!, "worktree-removals");

    try {
      await expect(attempt.cleanup()).rejects.toThrow(/rollback.*ambiguous|sync failure/iu);
      await expect(access(attempt.path)).resolves.toBeUndefined();
      expect(await registeredWorktrees(directory)).toContain(await realpath(attempt.path));
      await expect(readdir(manifestRoot)).resolves.toHaveLength(1);
    } finally {
      await rm(manifestRoot, { recursive: true, force: true });
      await new WorktreeManager(directory, "run-rollback-sync-failure").remove(attempt.path);
    }
  });

  it("preserves staged registration when its administrative root is substituted", async () => {
    const { directory, base } = await initRepo();
    const commonDir = await realpath(await runGit(directory, [
      "rev-parse", "--path-format=absolute", "--git-common-dir",
    ]));
    const registrationRoot = join(commonDir, "worktrees");
    const displacedRoot = `${registrationRoot}-displaced`;
    let substituted = false;
    const manager = new WorktreeManager(directory, "run-registration-root-race", undefined, {
      async rename(source, destination) {
        await rename(source, destination);
        if (!substituted && resolve(dirname(source)) === resolve(registrationRoot)) {
          await rename(registrationRoot, displacedRoot);
          await mkdir(registrationRoot, { mode: 0o700 });
          substituted = true;
        }
      },
    });
    const attempt = await manager.create(base);
    const manifestRoot = join(process.env.CLAUDE_PLUGIN_DATA!, "worktree-removals");

    try {
      await expect(attempt.cleanup()).rejects.toThrow(/root.*identity|rollback/iu);
      expect(substituted).toBe(true);
      await expect(readdir(manifestRoot)).resolves.toHaveLength(1);
      await expect(stat(attempt.path)).resolves.toBeDefined();
    } finally {
      await rm(registrationRoot, { recursive: true, force: true });
      try { await rename(displacedRoot, registrationRoot); } catch { /* fixture cleanup */ }
    }

    await expect(recoverPendingWorktreeRemovals()).resolves.toEqual([]);
    await expect(attempt.cleanup()).resolves.toBeUndefined();
  });

  it("rejects a symlinked registration leaf instead of deleting its resolved sibling", async () => {
    const { directory, base } = await initRepo();
    const manager = new WorktreeManager(directory, "run-symlinked-registration-leaf");
    const attempt = await manager.create(base);
    const registrationPath = await realpath(await runGit(attempt.path, [
      "rev-parse", "--path-format=absolute", "--git-dir",
    ]));
    const displacedRegistration = `${registrationPath}-displaced`;
    await rename(registrationPath, displacedRegistration);
    await symlink(
      displacedRegistration,
      registrationPath,
      process.platform === "win32" ? "junction" : "dir",
    );

    try {
      await expect(attempt.cleanup()).rejects.toThrow(
        /plain directory|identity|different administrative directory/iu,
      );
      expect((await lstat(registrationPath)).isSymbolicLink()).toBe(true);
      await expect(stat(displacedRegistration)).resolves.toBeDefined();
    } finally {
      await rm(registrationPath, { force: true });
      await rename(displacedRegistration, registrationPath);
      await attempt.cleanup();
    }
  });

  it("rejects a symlinked administrative root before removing outside metadata", async () => {
    const { directory, base } = await initRepo();
    let forcedAdministrativePath: string | null = null;
    const manager = new WorktreeManager(directory, "run-symlinked-registration-root", undefined, {
      git: async (cwd, args, options) => {
        if (forcedAdministrativePath !== null
          && args[0] === "rev-parse"
          && args.includes("--git-dir")) {
          return { exitCode: 0, stdout: `${forcedAdministrativePath}\n`, stderr: "" };
        }
        return await git(cwd, args, options);
      },
    });
    const attempt = await manager.create(base);
    const commonDir = await realpath(await runGit(directory, [
      "rev-parse", "--path-format=absolute", "--git-common-dir",
    ]));
    const administrativeRoot = join(commonDir, "worktrees");
    const externalParent = await temporaryDirectory("ca-external-registration-root-");
    const externalRoot = join(externalParent, "outside-worktrees");
    const registrationPath = await realpath(await runGit(attempt.path, [
      "rev-parse", "--path-format=absolute", "--git-dir",
    ]));
    const sentinelName = "outside-sentinel.txt";
    await writeFile(join(registrationPath, sentinelName), "preserve outside metadata\n");
    await rename(administrativeRoot, externalRoot);
    await symlink(externalRoot, administrativeRoot, "dir");
    forcedAdministrativePath = join(externalRoot, basename(registrationPath));

    try {
      await expect(attempt.cleanup()).rejects.toThrow(/administrative.*root|escaped/iu);
      await expect(readFile(join(externalRoot, basename(registrationPath), sentinelName), "utf8"))
        .resolves.toBe("preserve outside metadata\n");
      await expect(access(attempt.path)).resolves.toBeUndefined();
    } finally {
      await rm(administrativeRoot, { force: true });
      try { await rename(externalRoot, administrativeRoot); } catch { /* fixture already mutated */ }
      try { await attempt.cleanup(); } catch { /* repository fixture is removed by afterEach */ }
    }
  });

  it("preserves physical worktree when registration staging fails", async () => {
    const { directory, base } = await initRepo();
    let registrationMoves = 0;
    const manager = new WorktreeManager(directory, "run-registration-failure", undefined, {
      async rename(source, destination) {
        if (source.includes(`${sep}.git${sep}worktrees${sep}`)) {
          registrationMoves += 1;
          const error = new Error("simulated registration removal failure") as NodeJS.ErrnoException;
          error.code = "EBUSY";
          throw error;
        }
        await rename(source, destination);
      },
      delay: async () => {},
    });
    const attempt = await manager.create(base);

    try {
      await expect(attempt.cleanup()).rejects.toThrow("could not be quarantined");
      await expect(stat(attempt.path)).resolves.toBeDefined();
      expect(await registeredWorktrees(directory)).toContain(await realpath(attempt.path));
      expect(registrationMoves).toBe(5);
    } finally {
      await new WorktreeManager(directory, "run-registration-failure").remove(attempt.path);
    }
  });

  it.skipIf(process.platform === "win32")(
    "detects a registration pathname recreated during staged commit",
    async () => {
    const { directory, base } = await initRepo();
    let registrationPath = "";
    let quarantineRoot = "";
    const manager = new WorktreeManager(directory, "run-registration-recreated", undefined, {
      async rmdir(directoryPath) {
        await removeEmptyDirectory(directoryPath);
        if (registrationPath !== ""
          && await canonicalPathsEqual(dirname(directoryPath), quarantineRoot)) {
          await mkdir(registrationPath, { mode: 0o700 });
        }
      },
    });
    const attempt = await manager.create(base);
    registrationPath = await realpath(await runGit(attempt.path, [
      "rev-parse", "--path-format=absolute", "--git-dir",
    ]));
    quarantineRoot = join(dirname(dirname(registrationPath)), "claude-architect-quarantine");

    await expect(attempt.cleanup()).rejects.toThrow(
      "staged worktree registration pathname reappeared during commit",
    );

    await expect(stat(registrationPath)).resolves.toBeDefined();
    await expect(readdir(join(process.env.CLAUDE_PLUGIN_DATA!, "worktree-removals")))
      .resolves.toHaveLength(1);
  });

  it("recovers a staged registration before reclaiming its unfinished run", async () => {
    const { directory, base } = await initRepo();
    const runId = "run-precommit-recovery";
    const manager = new WorktreeManager(directory, runId);
    const attempt = await manager.create(base);
    const transactionId = "00000000-0000-4000-8000-000000000099";
    // realpath the Git-reported paths: on Windows rev-parse emits forward-slash
    // paths, which the manifest validator rejects as non-normalized.
    const commonDir = await realpath(await runGit(directory, [
      "rev-parse", "--path-format=absolute", "--git-common-dir",
    ]));
    const registrationPath = await realpath(await runGit(attempt.path, [
      "rev-parse", "--path-format=absolute", "--git-dir",
    ]));
    const registrationRoot = join(commonDir, "worktrees");
    const quarantineRoot = join(commonDir, "claude-architect-quarantine");
    const quarantinePath = join(
      quarantineRoot,
      `.remove-registration-${basename(registrationPath)}-${transactionId}`,
    );
    const physicalQuarantinePath = join(managedRootOf(directory),
      `.remove-run-precommit-recovery-${transactionId}`,
    );
    const physicalIdentity = await managedWorktreeDirectoryIdentity(attempt.path);
    const registrationIdentity = await managedWorktreeDirectoryIdentity(registrationPath);
    expect(physicalIdentity).not.toBeNull();
    expect(registrationIdentity).not.toBeNull();
    await mkdir(quarantineRoot, { recursive: true, mode: 0o700 });
    await rename(registrationPath, quarantinePath);
    const manifestRoot = join(process.env.CLAUDE_PLUGIN_DATA!, "worktree-removals");
    await mkdir(manifestRoot, { recursive: true, mode: 0o700 });
    await writeFile(join(manifestRoot, `${transactionId}.json`), `${JSON.stringify({
      manifestVersion: "1",
      transactionId,
      phase: "registration-staged",
      commonDir,
      ...await removalRootIdentities(
        commonDir,
        managedRootOf(directory),
        registrationRoot,
        quarantineRoot,
      ),
      physicalPresent: true,
      physicalPath: attempt.path,
      physicalQuarantinePath,
      physicalDev: physicalIdentity!.dev.toString(),
      physicalIno: physicalIdentity!.ino.toString(),
      physicalBirthtimeNs: physicalIdentity!.birthtimeNs.toString(),
      registrationRoot,
      registrationPath,
      quarantineRoot,
      quarantinePath,
      registrationDev: registrationIdentity!.dev.toString(),
      registrationIno: registrationIdentity!.ino.toString(),
      registrationBirthtimeNs: registrationIdentity!.birthtimeNs.toString(),
    })}\n`);
    const store = new ArtifactStore(runId);
    await mkdir(store.runDirectory, { recursive: true });
    await writeFile(join(store.runDirectory, "run-start.json"), `${JSON.stringify({
      runId,
      lockKey: createHash("sha256").update(await realpath(commonDir)).digest("hex"),
      canonicalCommonDir: await realpath(commonDir),
      pid: null,
      processToken: null,
      startedAt: "2026-08-02T12:00:00.000Z",
    })}\n`);

    await expect(recoverStaleRuns({ isProcessAlive: () => false })).resolves.toEqual({
      recovered: [runId],
      quarantined: [],
    });

    await expect(stat(attempt.path)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(registrationPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(quarantinePath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readdir(manifestRoot)).resolves.toEqual([]);
  });

  it("rejects a manifest that pairs one registration with another physical worktree", async () => {
    const { directory, base } = await initRepo();
    const attemptA = await new WorktreeManager(directory, "run-cross-pair-a").create(base);
    const attemptB = await new WorktreeManager(directory, "run-cross-pair-b").create(base);
    const transactionId = "00000000-0000-4000-8000-000000000097";
    const commonDir = await realpath(await runGit(directory, [
      "rev-parse", "--path-format=absolute", "--git-common-dir",
    ]));
    const registrationPath = await realpath(await runGit(attemptA.path, [
      "rev-parse", "--path-format=absolute", "--git-dir",
    ]));
    const registrationIdentity = await managedWorktreeDirectoryIdentity(registrationPath);
    const physicalIdentity = await managedWorktreeDirectoryIdentity(attemptB.path);
    const registrationRoot = dirname(registrationPath);
    const quarantineRoot = join(commonDir, "claude-architect-quarantine");
    await mkdir(quarantineRoot, { recursive: true, mode: 0o700 });
    const quarantinePath = join(
      quarantineRoot,
      `.remove-registration-${basename(registrationPath)}-${transactionId}`,
    );
    await rename(registrationPath, quarantinePath);
    const physicalRoot = dirname(attemptB.path);
    const manifestRoot = join(process.env.CLAUDE_PLUGIN_DATA!, "worktree-removals");
    await mkdir(manifestRoot, { recursive: true, mode: 0o700 });
    const manifestPath = join(manifestRoot, `${transactionId}.json`);
    await writeFile(manifestPath, `${JSON.stringify({
      manifestVersion: "1",
      transactionId,
      phase: "physical-removal-started",
      commonDir,
      ...await removalRootIdentities(
        commonDir,
        physicalRoot,
        registrationRoot,
        quarantineRoot,
      ),
      physicalPresent: true,
      physicalPath: attemptB.path,
      physicalQuarantinePath: join(
        physicalRoot,
        `.remove-${basename(attemptB.path)}-${transactionId}`,
      ),
      physicalDev: physicalIdentity!.dev.toString(),
      physicalIno: physicalIdentity!.ino.toString(),
      physicalBirthtimeNs: physicalIdentity!.birthtimeNs.toString(),
      registrationRoot,
      registrationPath,
      quarantineRoot,
      quarantinePath,
      registrationDev: registrationIdentity!.dev.toString(),
      registrationIno: registrationIdentity!.ino.toString(),
      registrationBirthtimeNs: registrationIdentity!.birthtimeNs.toString(),
    })}\n`);

    try {
      await expect(recoverPendingWorktreeRemovals()).resolves.toEqual([{
        manifestPath,
        error: expect.objectContaining({
          message: expect.stringContaining("backlink names a different physical worktree"),
        }),
        repositoryIdentity: commonDir,
      }]);
      await expect(access(attemptB.path)).resolves.toBeUndefined();
      await expect(access(quarantinePath)).resolves.toBeUndefined();
    } finally {
      await rm(manifestPath, { force: true });
      await rename(quarantinePath, registrationPath);
      // Both cleanups take the same checkout lease; run them in turn.
      await attemptA.cleanup();
      await attemptB.cleanup();
    }
  });

  it("re-syncs observed rollback roots before deleting a recovery manifest", async () => {
    const { directory, base } = await initRepo();
    const runId = "run-observed-rollback-sync";
    const attempt = await new WorktreeManager(directory, runId).create(base);
    const transactionId = "00000000-0000-4000-8000-000000000098";
    const commonDir = await realpath(await runGit(directory, [
      "rev-parse", "--path-format=absolute", "--git-common-dir",
    ]));
    const registrationPath = await realpath(await runGit(attempt.path, [
      "rev-parse", "--path-format=absolute", "--git-dir",
    ]));
    const registrationRoot = join(commonDir, "worktrees");
    const quarantineRoot = join(commonDir, "claude-architect-quarantine");
    await mkdir(quarantineRoot, { recursive: true, mode: 0o700 });
    const quarantinePath = join(
      quarantineRoot,
      `.remove-registration-${basename(registrationPath)}-${transactionId}`,
    );
    const physicalRoot = managedRootOf(directory);
    const physicalIdentity = await managedWorktreeDirectoryIdentity(attempt.path);
    const registrationIdentity = await managedWorktreeDirectoryIdentity(registrationPath);
    const manifestRoot = join(process.env.CLAUDE_PLUGIN_DATA!, "worktree-removals");
    await mkdir(manifestRoot, { recursive: true, mode: 0o700 });
    await writeFile(join(manifestRoot, `${transactionId}.json`), `${JSON.stringify({
      manifestVersion: "1",
      transactionId,
      phase: "registration-staged",
      commonDir,
      ...await removalRootIdentities(
        commonDir,
        physicalRoot,
        registrationRoot,
        quarantineRoot,
      ),
      physicalPresent: true,
      physicalPath: attempt.path,
      physicalQuarantinePath: join(physicalRoot, `.remove-${runId}-${transactionId}`),
      physicalDev: physicalIdentity!.dev.toString(),
      physicalIno: physicalIdentity!.ino.toString(),
      physicalBirthtimeNs: physicalIdentity!.birthtimeNs.toString(),
      registrationRoot,
      registrationPath,
      quarantineRoot,
      quarantinePath,
      registrationDev: registrationIdentity!.dev.toString(),
      registrationIno: registrationIdentity!.ino.toString(),
      registrationBirthtimeNs: registrationIdentity!.birthtimeNs.toString(),
    })}\n`);
    const synced: string[] = [];

    await expect(recoverPendingWorktreeRemovals(
      undefined,
      async directoryPath => { synced.push(await realpath(directoryPath)); },
    )).resolves.toEqual([]);

    expect(synced).toEqual([
      await realpath(physicalRoot),
      await realpath(registrationRoot),
      await realpath(quarantineRoot),
    ]);
    await expect(readdir(manifestRoot)).resolves.toEqual([]);
    await attempt.cleanup();
  });

  it("retains both quarantines when supervised physical emptying fails", async () => {
    const { directory, base } = await initRepo();
    const selected = getPlatformServices();
    const processSupervisor = Object.create(selected) as PlatformServices;
    // Intercept only the bound-cleanup "node -e" spawn: on Windows, ACL
    // validation and helper removal also route through spawnSupervised and
    // must run for real, or worktree creation itself fails.
    processSupervisor.spawnSupervised = async request => {
      if (request.executable.command !== process.execPath || request.args[0] !== "-e") {
        return selected.spawnSupervised(request);
      }
      return {
        pid: 42_424,
        done: Promise.resolve({
          exitCode: 43,
          signal: null,
          timedOut: false,
          cancelled: false,
          stdout: "",
          stderr: "",
          truncated: { stdout: false, stderr: false },
        }),
        stdout: Readable.from([]),
        stderr: Readable.from([]),
      };
    };
    const physicalRoot = managedRootOf(directory);
    const manager = new WorktreeManager(directory, "run-emptying-failure", undefined, {
      processSupervisor,
    });
    const attempt = await manager.create(base);
    const commonDir = await runGit(directory, [
      "rev-parse", "--path-format=absolute", "--git-common-dir",
    ]);

    await expect(attempt.cleanup()).rejects.toThrow(
      "quarantined directory contents could not be removed",
    );

    const physicalQuarantines = (await readdir(physicalRoot))
      .filter(name => name.startsWith(".remove-run-emptying-failure-"));
    const registrationQuarantines = await readdir(join(
      commonDir,
      "claude-architect-quarantine",
    ));
    expect(physicalQuarantines).toHaveLength(1);
    expect(registrationQuarantines).toHaveLength(1);
    expect(await registeredWorktrees(directory)).not.toContain(resolve(attempt.path));

    await expect(recoverStaleRuns()).resolves.toEqual({ recovered: [], quarantined: [] });
    expect(await readdir(join(commonDir, "claude-architect-quarantine"))).toEqual([]);
    expect(await readdir(join(process.env.CLAUDE_PLUGIN_DATA!, "worktree-removals"))).toEqual([]);
    await expect(stat(join(physicalRoot, physicalQuarantines[0]!))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("never rolls back registration after physical emptying has started", async () => {
    const { directory, base } = await initRepo();
    let physicalPath = "";
    const selected = getPlatformServices();
    const processSupervisor = Object.create(selected) as PlatformServices;
    // Intercept only the bound-cleanup "node -e" spawn (see note above): the
    // Windows ACL-validation spawn must not be renamed out from under itself.
    processSupervisor.spawnSupervised = async request => {
      if (request.executable.command !== process.execPath || request.args[0] !== "-e") {
        return selected.spawnSupervised(request);
      }
      await rename(request.cwd, physicalPath);
      await rm(join(physicalPath, "damage-me.txt"), { force: false });
      return {
        pid: 42_427,
        done: Promise.resolve({
          exitCode: 43,
          signal: null,
          timedOut: false,
          cancelled: false,
          stdout: "",
          stderr: "",
          truncated: { stdout: false, stderr: false },
        }),
        stdout: Readable.from([]),
        stderr: Readable.from([]),
      };
    };
    const manager = new WorktreeManager(directory, "run-started-emptying", undefined, {
      processSupervisor,
    });
    const attempt = await manager.create(base);
    physicalPath = attempt.path;
    await writeFile(join(physicalPath, "damage-me.txt"), "removed before failure\n");

    await expect(attempt.cleanup()).rejects.toThrow(
      "quarantined directory contents could not be removed",
    );

    const manifestRoot = join(process.env.CLAUDE_PLUGIN_DATA!, "worktree-removals");
    const manifests = await readdir(manifestRoot);
    expect(manifests).toHaveLength(1);
    const pendingManifest = JSON.parse(
      await readFile(join(manifestRoot, manifests[0]!), "utf8"),
    ) as { phase: string; physicalPath: string };
    expect(pendingManifest.phase).toBe("physical-removal-started");
    expect(await realpath(pendingManifest.physicalPath)).toBe(await realpath(physicalPath));
    await expect(stat(physicalPath)).resolves.toBeDefined();
    await expect(stat(join(physicalPath, "damage-me.txt"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(await registeredWorktrees(directory)).not.toContain(resolve(physicalPath));

    await expect(recoverPendingWorktreeRemovals()).resolves.toEqual([]);
    await expect(stat(physicalPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readdir(manifestRoot)).resolves.toEqual([]);
  });

  it("preserves physical-removal intent when both recorded paths disappear", async () => {
    const { directory, base } = await initRepo();
    let physicalPath = "";
    const manager = new WorktreeManager(directory, "run-intent-disappeared", undefined, {
      async rename(source, destination) {
        if (physicalPath !== "" && await canonicalPathsEqual(source, physicalPath)) {
          await rm(source, { recursive: true, force: true });
          throw new Error("simulated external physical disappearance");
        }
        await rename(source, destination);
      },
      delay: async () => {},
    });
    const attempt = await manager.create(base);
    physicalPath = attempt.path;

    await expect(attempt.cleanup()).rejects.toThrow("could not be quarantined");

    const manifestRoot = join(process.env.CLAUDE_PLUGIN_DATA!, "worktree-removals");
    const manifests = await readdir(manifestRoot);
    expect(manifests).toHaveLength(1);
    expect(JSON.parse(await readFile(join(manifestRoot, manifests[0]!), "utf8")))
      .toMatchObject({ phase: "physical-removal-intent" });
    await expect(recoverPendingWorktreeRemovals()).resolves.toEqual([{
      manifestPath: join(manifestRoot, manifests[0]!),
      error: expect.objectContaining({
        message: expect.stringContaining("no provable original or quarantine"),
      }),
      repositoryIdentity: expect.any(String),
    }]);
    await expect(readdir(manifestRoot)).resolves.toEqual(manifests);
  });

  it("persists the physical-removal commit marker before quarantine sync", async () => {
    const { directory, base } = await initRepo();
    const physicalRoot = managedRootOf(directory);
    let failPhysicalSync = false;
    const manager = new WorktreeManager(directory, "run-intent-sync-failure", undefined, {
      syncDirectory: async directoryPath => {
        if (failPhysicalSync
          && await canonicalPathsEqual(directoryPath, physicalRoot)
          && (await readdir(directoryPath)).some(name =>
            name.startsWith(".remove-run-intent-sync-failure-"))) {
          throw new Error("simulated physical quarantine sync failure");
        }
        await syncDirectoryMetadata(directoryPath);
      },
    });
    const attempt = await manager.create(base);
    failPhysicalSync = true;

    await expect(attempt.cleanup()).rejects.toThrow("simulated physical quarantine sync failure");
    const manifestRoot = join(process.env.CLAUDE_PLUGIN_DATA!, "worktree-removals");
    const manifests = await readdir(manifestRoot);
    expect(manifests).toHaveLength(1);
    expect(JSON.parse(await readFile(join(manifestRoot, manifests[0]!), "utf8")))
      .toMatchObject({ phase: "physical-removal-started" });

    failPhysicalSync = false;
    const commonDir = await realpath(join(directory, ".git"));
    const staleLockPath = join(
      process.env.CLAUDE_PLUGIN_DATA!,
      "locks",
      `${createHash("sha256").update(commonDir).digest("hex")}.lock`,
    );
    await mkdir(dirname(staleLockPath), { recursive: true });
    await writeFile(staleLockPath, JSON.stringify({
      pid: 424_242,
      processToken: "dead-owner",
    }));

    await expect(recoverStaleRuns({ isProcessAlive: () => false }))
      .resolves.toEqual({ recovered: [], quarantined: [] });
    await expect(access(staleLockPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(attempt.path)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await registeredWorktrees(directory)).not.toContain(resolve(attempt.path));
    await expect(readdir(manifestRoot)).resolves.toEqual([]);
  });

  it("removes a registered worktree after the Producer deletes its .git marker", async () => {
    const { directory, base } = await initRepo();
    const manager = new WorktreeManager(directory, "run-missing-git-marker");
    const attempt = await manager.create(base);
    await rm(join(attempt.path, ".git"));

    await expect(attempt.cleanup()).resolves.toBeUndefined();
    await expect(access(attempt.path)).rejects.toMatchObject({ code: "ENOENT" });
    const listed = await git(directory, ["worktree", "list", "--porcelain", "-z"]);
    expect(listed.exitCode, listed.stderr).toBe(0);
    expect(listed.stdout).not.toContain(attempt.path);
  });

  it("recovers a physical-removed manifest when registration commit fails", async () => {
    const { directory, base } = await initRepo();
    let helperCalls = 0;
    const selected = getPlatformServices();
    const processSupervisor = Object.create(selected) as PlatformServices;
    processSupervisor.spawnSupervised = async request => {
      if (request.executable.command !== process.execPath || request.args[0] !== "-e") {
        // lsof probes, Windows ACL validation, and identity-bound helper
        // removal all run for real; only the bound-cleanup spawn is faked.
        return await selected.spawnSupervised(request);
      }
      helperCalls += 1;
      if (helperCalls === 1) {
        for (const entry of await readdir(request.cwd)) {
          await rm(join(request.cwd, entry), { recursive: true, force: false });
        }
      }
      return {
        pid: 42_426,
        done: Promise.resolve({
          exitCode: helperCalls === 1 ? 0 : 43,
          signal: null,
          timedOut: false,
          cancelled: false,
          stdout: "",
          stderr: "",
          truncated: { stdout: false, stderr: false },
        }),
        stdout: Readable.from([]),
        stderr: Readable.from([]),
      };
    };
    const manager = new WorktreeManager(directory, "run-postcommit-recovery", undefined, {
      processSupervisor,
    });
    const attempt = await manager.create(base);
    const commonDir = await runGit(directory, [
      "rev-parse", "--path-format=absolute", "--git-common-dir",
    ]);

    await expect(attempt.cleanup()).rejects.toThrow(
      "quarantined directory contents could not be removed",
    );

    const manifestRoot = join(process.env.CLAUDE_PLUGIN_DATA!, "worktree-removals");
    const manifests = await readdir(manifestRoot);
    expect(manifests).toHaveLength(1);
    const pendingManifest = JSON.parse(
      await readFile(join(manifestRoot, manifests[0]!), "utf8"),
    ) as { phase: string; physicalPath: string };
    expect(pendingManifest.phase).toBe("physical-removed");
    await expect(realpath(pendingManifest.physicalPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(attempt.path)).rejects.toMatchObject({ code: "ENOENT" });

    await expect(recoverStaleRuns()).resolves.toEqual({ recovered: [], quarantined: [] });
    expect(await readdir(join(commonDir, "claude-architect-quarantine"))).toEqual([]);
    expect(await readdir(manifestRoot)).toEqual([]);
  });

  it.skipIf(process.platform === "win32")(
    "retains staged registration when final physical rmdir fails",
    async () => {
    const { directory, base } = await initRepo();
    const physicalRoot = managedRootOf(directory);
    const manager = new WorktreeManager(directory, "run-rmdir-failure", undefined, {
      async rmdir(directoryPath) {
        if (await canonicalPathsEqual(dirname(directoryPath), physicalRoot)) {
          const error = new Error("simulated final rmdir failure") as NodeJS.ErrnoException;
          error.code = "EBUSY";
          throw error;
        }
        await removeEmptyDirectory(directoryPath);
      },
    });
    const attempt = await manager.create(base);
    const commonDir = await runGit(directory, [
      "rev-parse", "--path-format=absolute", "--git-common-dir",
    ]);

    await expect(attempt.cleanup()).rejects.toThrow("simulated final rmdir failure");

    const physicalQuarantines = (await readdir(physicalRoot))
      .filter(name => name.startsWith(".remove-run-rmdir-failure-"));
    const registrationQuarantines = await readdir(join(
      commonDir,
      "claude-architect-quarantine",
    ));
    expect(physicalQuarantines).toHaveLength(1);
    expect(registrationQuarantines).toHaveLength(1);
    expect(await registeredWorktrees(directory)).not.toContain(resolve(attempt.path));

    await expect(recoverStaleRuns()).resolves.toEqual({ recovered: [], quarantined: [] });
    expect(await readdir(join(commonDir, "claude-architect-quarantine"))).toEqual([]);
    expect(await readdir(join(process.env.CLAUDE_PLUGIN_DATA!, "worktree-removals"))).toEqual([]);
    await expect(stat(join(physicalRoot, physicalQuarantines[0]!))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it.skipIf(process.platform === "win32")(
    "preserves a removal whose quarantined inode moved to an unrecorded sibling",
    async () => {
      const { directory, base } = await initRepo();
      const physicalRoot = managedRootOf(directory);
      const manager = new WorktreeManager(directory, "run-moved-quarantine", undefined, {
        async rmdir(directoryPath) {
          if (await canonicalPathsEqual(dirname(directoryPath), physicalRoot)) {
            const error = new Error("simulated final rmdir failure") as NodeJS.ErrnoException;
            error.code = "EBUSY";
            throw error;
          }
          await removeEmptyDirectory(directoryPath);
        },
      });
      const attempt = await manager.create(base);
      await expect(attempt.cleanup()).rejects.toThrow("simulated final rmdir failure");
      const recordedName = (await readdir(physicalRoot))
        .find(name => name.startsWith(".remove-run-moved-quarantine-"));
      if (recordedName === undefined) throw new Error("physical quarantine was not created");
      const recordedPath = join(physicalRoot, recordedName);
      const displacedPath = join(physicalRoot, ".displaced-removal-inode");
      await rename(recordedPath, displacedPath);

      const issues = await recoverPendingWorktreeRemovals();
      expect(issues).toEqual([expect.objectContaining({
        error: expect.objectContaining({
          message: expect.stringContaining("moved away from both recorded removal paths"),
        }),
        repositoryIdentity: expect.any(String),
      })]);
      await expect(stat(displacedPath)).resolves.toBeDefined();
      await expect(readdir(join(process.env.CLAUDE_PLUGIN_DATA!, "worktree-removals")))
        .resolves.toHaveLength(1);

      await rename(displacedPath, recordedPath);
      await expect(recoverPendingWorktreeRemovals()).resolves.toEqual([]);
    },
  );

  it.skipIf(process.platform === "win32")(
    "preserves a pending removal when its registration root changed before startup",
    async () => {
    const { directory, base } = await initRepo();
    const physicalRoot = managedRootOf(directory);
    const manager = new WorktreeManager(directory, "run-root-substitution", undefined, {
      async rmdir(directoryPath) {
        if (await canonicalPathsEqual(dirname(directoryPath), physicalRoot)) {
          const error = new Error("simulated final rmdir failure") as NodeJS.ErrnoException;
          error.code = "EBUSY";
          throw error;
        }
        await removeEmptyDirectory(directoryPath);
      },
    });
    const attempt = await manager.create(base);
    await expect(attempt.cleanup()).rejects.toThrow("simulated final rmdir failure");
    const commonDir = await runGit(directory, [
      "rev-parse", "--path-format=absolute", "--git-common-dir",
    ]);
    const registrationRoot = join(commonDir, "worktrees");
    const displacedRoot = `${registrationRoot}-displaced`;
    await rename(registrationRoot, displacedRoot);
    await mkdir(registrationRoot, { mode: 0o700 });

    try {
      await expect(recoverPendingWorktreeRemovals()).resolves.toEqual([{
        manifestPath: expect.stringContaining("worktree-removals"),
        error: expect.objectContaining({
          message: expect.stringContaining("manifest paths are inconsistent"),
        }),
        repositoryIdentity: commonDir,
      }]);
      await expect(readdir(join(process.env.CLAUDE_PLUGIN_DATA!, "worktree-removals")))
        .resolves.toHaveLength(1);
      await expect(stat(displacedRoot)).resolves.toBeDefined();
    } finally {
      await rm(registrationRoot, { recursive: true, force: true });
      try { await rename(displacedRoot, registrationRoot); } catch { /* fixture cleanup */ }
    }

    await expect(recoverPendingWorktreeRemovals()).resolves.toEqual([]);
    await expect(readdir(join(process.env.CLAUDE_PLUGIN_DATA!, "worktree-removals")))
      .resolves.toEqual([]);
  });

  it.skipIf(process.platform === "win32")(
    "preserves worktrees when a durable removal manifest is malformed",
    async () => {
    const { directory, base } = await initRepo();
    const physicalRoot = managedRootOf(directory);
    const manager = new WorktreeManager(directory, "run-malformed-manifest", undefined, {
      async rmdir(directoryPath) {
        if (await canonicalPathsEqual(dirname(directoryPath), physicalRoot)) {
          const error = new Error("simulated final rmdir failure") as NodeJS.ErrnoException;
          error.code = "EBUSY";
          throw error;
        }
        await removeEmptyDirectory(directoryPath);
      },
    });
    const attempt = await manager.create(base);
    await expect(attempt.cleanup()).rejects.toThrow("simulated final rmdir failure");
    const manifestRoot = join(process.env.CLAUDE_PLUGIN_DATA!, "worktree-removals");
    const manifests = await readdir(manifestRoot);
    expect(manifests).toHaveLength(1);
    const manifestPath = join(manifestRoot, manifests[0]!);
    await writeFile(manifestPath, "{\n");
    const unrelated = join(physicalRoot, "unrelated-recordless-worktree");
    await mkdir(unrelated);

    await expect(recoverStaleRuns()).resolves.toMatchObject({
      recovered: [],
      quarantined: [],
      worktreeSweepIssues: [{
        worktreePath: manifestPath,
        reason: expect.stringContaining("manifest is invalid JSON"),
      }],
    });

    await expect(stat(unrelated)).resolves.toBeDefined();
    expect((await readdir(physicalRoot)).some(name =>
      name.startsWith(".remove-run-malformed-manifest-"))).toBe(true);
  });

  it("rejects a managed root substituted during removal-storage preflight", async () => {
    const { directory, base } = await initRepo();
    const worktreesRoot = managedRootOf(directory);
    const displacedRoot = `${worktreesRoot}-preflight-displaced`;
    let gitCalls = 0;
    const manager = new WorktreeManager(directory, "run-preflight-root-race", undefined, {
      async verifyRemovalStorage() {
        await rename(worktreesRoot, displacedRoot);
        await mkdir(worktreesRoot, { mode: 0o700 });
      },
      git: async (cwd, args, options) => {
        gitCalls += 1;
        return await git(cwd, args, options);
      },
    });

    try {
      await expect(manager.create(base)).rejects.toThrow(
        "managed worktree root identity changed",
      );
      expect(gitCalls).toBe(0);
    } finally {
      await rm(worktreesRoot, { recursive: true, force: true });
      await rename(displacedRoot, worktreesRoot);
    }
  });

  it.runIf(process.platform !== "win32")(
    "accepts an existing read-only-to-others Git worktree registration root",
    async () => {
      const { directory, base } = await initRepo();
      const registrationRoot = join(directory, ".git", "worktrees");
      await mkdir(registrationRoot, { recursive: true, mode: 0o755 });
      await chmod(registrationRoot, 0o755);
      const manager = new WorktreeManager(directory, "run-readable-registration-root");

      const attempt = await manager.create(base);
      try {
        expect((await stat(registrationRoot)).mode & 0o777).toBe(0o755);
      } finally {
        await attempt.cleanup();
      }
    },
  );

  it("rejects an unsupported registration filesystem before git worktree add", async () => {
    const { directory, base } = await initRepo();
    let addCalled = false;
    const unavailableCommonDir = join(directory, "missing-registration-filesystem");
    const manager = new WorktreeManager(directory, "run-registration-preflight", undefined, {
      git: async (cwd, args, options) => {
        if (args[0] === "rev-parse" && args.at(-1) === "--git-common-dir") {
          return {
            exitCode: 0,
            stdout: `${unavailableCommonDir}\n`,
            stderr: "",
            truncated: { stdout: false, stderr: false },
          };
        }
        if (args[0] === "worktree" && args[1] === "add") addCalled = true;
        return await git(cwd, args, options);
      },
    });

    await expect(manager.create(base)).rejects.toMatchObject({ code: "ENOENT" });
    expect(addCalled).toBe(false);
  });

  it("durably records a worktree root substituted before git chooses its destination", async () => {
    const { directory, base } = await initRepo();
    const worktreesRoot = managedRootOf(directory);
    const displacedRoot = `${worktreesRoot}-pre-add-displaced`;
    const worktreePath = join(worktreesRoot, "run-create-pre-add-race");
    let substituted = false;
    const manager = new WorktreeManager(directory, "run-create-pre-add-race", undefined, {
      git: async (cwd, args, options) => {
        if (!substituted && args[0] === "worktree" && args[1] === "add") {
          await rename(worktreesRoot, displacedRoot);
          await mkdir(worktreesRoot, { mode: 0o700 });
          substituted = true;
        }
        return await git(cwd, args, options);
      },
    });
    const manifestRoot = join(process.env.CLAUDE_PLUGIN_DATA!, "worktree-removals");

    try {
      await expect(manager.create(base)).rejects.toThrow(
        "managed worktree root identity changed during creation",
      );
      expect(substituted).toBe(true);
      await expect(stat(worktreePath)).resolves.toBeDefined();
      await expect(readdir(manifestRoot)).resolves.toHaveLength(1);
      await expect(recoverPendingWorktreeRemovals()).resolves.toEqual([]);
      await expect(stat(join(displacedRoot, "run-create-pre-add-race")))
        .rejects.toMatchObject({ code: "ENOENT" });
      await expect(stat(worktreePath)).resolves.toBeDefined();
      expect(await registeredWorktrees(directory)).not.toContain(resolve(worktreePath));
      await expect(readdir(manifestRoot)).resolves.toEqual([]);
    } finally {
      await rm(manifestRoot, { recursive: true, force: true });
      try { await manager.remove(worktreePath); } catch { /* fixture cleanup */ }
      await rm(worktreesRoot, { recursive: true, force: true });
      try { await rename(displacedRoot, worktreesRoot); } catch { /* fixture cleanup */ }
    }
  });

  it("recovers a placeholder created before its identity publication completes", async () => {
    const { directory, base } = await initRepo();
    const worktreesRoot = managedRootOf(directory);
    const manifestRoot = join(process.env.CLAUDE_PLUGIN_DATA!, "worktree-removals");
    let interrupted = false;
    const manager = new WorktreeManager(directory, "run-create-unbound-staging", undefined, {
      async syncDirectory(directoryPath) {
        if (!interrupted
          && await canonicalPathsEqual(directoryPath, worktreesRoot)
          && (await readdir(directoryPath)).some(name =>
            name.startsWith(".create-run-create-unbound-staging-"))) {
          interrupted = true;
          throw new Error("simulated crash before placeholder identity publication");
        }
        await syncDirectoryMetadata(directoryPath);
      },
    });

    await expect(manager.create(base)).rejects.toThrow("simulated crash");
    await expect(readdir(manifestRoot)).resolves.toHaveLength(1);
    expect((await readdir(worktreesRoot)).some(name =>
      name.startsWith(".create-run-create-unbound-staging-"))).toBe(true);

    await expect(recoverPendingWorktreeRemovals()).resolves.toEqual([]);
    await expect(readdir(manifestRoot)).resolves.toEqual([]);
    expect((await readdir(worktreesRoot)).some(name =>
      name.startsWith(".create-run-create-unbound-staging-"))).toBe(false);
  });

  it("recovers a creation interrupted after intent publication but before placeholder promotion", async () => {
    const { directory, base } = await initRepo();
    const worktreesRoot = managedRootOf(directory);
    const worktreePath = join(worktreesRoot, "run-create-intent-crash");
    let interrupted = false;
    const manager = new WorktreeManager(directory, "run-create-intent-crash", undefined, {
      async rename(source, destination) {
        if (!interrupted
          && basename(source).startsWith(".create-run-create-intent-crash-")
          && basename(destination) === "run-create-intent-crash") {
          interrupted = true;
          throw new Error("simulated crash before placeholder promotion");
        }
        await rename(source, destination);
      },
    });
    const manifestRoot = join(process.env.CLAUDE_PLUGIN_DATA!, "worktree-removals");

    await expect(manager.create(base)).rejects.toThrow("simulated crash");
    await expect(readdir(manifestRoot)).resolves.toHaveLength(1);
    expect((await readdir(worktreesRoot)).some(name =>
      name.startsWith(".create-run-create-intent-crash-"))).toBe(true);

    await expect(recoverPendingWorktreeRemovals()).resolves.toEqual([]);
    await expect(readdir(manifestRoot)).resolves.toEqual([]);
    expect((await readdir(worktreesRoot)).some(name =>
      name.startsWith(".create-run-create-intent-crash-"))).toBe(false);
    await expect(stat(worktreePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("cleans its durable placeholder after an ordinary git worktree rejection", async () => {
    const { directory, base } = await initRepo();
    const worktreePath = join(managedRootOf(directory),
      "run-create-git-rejection",
    );
    const manager = new WorktreeManager(directory, "run-create-git-rejection", undefined, {
      git: async (cwd, args, options) => args[0] === "worktree" && args[1] === "add"
        ? { exitCode: 1, stdout: "", stderr: "simulated rejection" }
        : git(cwd, args, options),
    });

    await expect(manager.create(base)).rejects.toThrow("git worktree add failed");
    await expect(stat(worktreePath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readdir(join(process.env.CLAUDE_PLUGIN_DATA!, "worktree-removals")))
      .resolves.toEqual([]);
  });

  it("publishes before Git and cleans an in-process post-add interruption", async () => {
    const { directory, base } = await initRepo();
    const worktreePath = join(managedRootOf(directory),
      "run-create-post-add-crash",
    );
    const manifestRoot = join(process.env.CLAUDE_PLUGIN_DATA!, "worktree-removals");
    let interrupted = false;
    let intentObserved = false;
    const manager = new WorktreeManager(directory, "run-create-post-add-crash", undefined, {
      git: async (cwd, args, options) => {
        const result = await git(cwd, args, options);
        if (!interrupted
          && args[0] === "worktree"
          && args[1] === "add"
          && result.exitCode === 0) {
          interrupted = true;
          intentObserved = (await readdir(manifestRoot)).length === 1;
          throw new Error("simulated in-process interruption after git worktree add");
        }
        return result;
      },
    });
    await expect(manager.create(base)).rejects.toThrow("simulated in-process interruption");
    expect(intentObserved).toBe(true);
    await expect(stat(worktreePath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await registeredWorktrees(directory)).not.toContain(resolve(worktreePath));
    await expect(readdir(manifestRoot)).resolves.toEqual([]);
  });

  it("durably records a worktree root substitution after git add", async () => {
    const { directory, base } = await initRepo();
    const worktreesRoot = managedRootOf(directory);
    const displacedRoot = `${worktreesRoot}-displaced`;
    const worktreePath = join(worktreesRoot, "run-create-root-race");
    let substituted = false;
    const manager = new WorktreeManager(directory, "run-create-root-race", undefined, {
      git: async (cwd, args, options) => {
        const result = await git(cwd, args, options);
        if (!substituted
          && args[0] === "worktree"
          && args[1] === "add"
          && result.exitCode === 0) {
          await rename(worktreesRoot, displacedRoot);
          await mkdir(worktreesRoot, { mode: 0o700 });
          substituted = true;
        }
        return result;
      },
    });
    const manifestRoot = join(process.env.CLAUDE_PLUGIN_DATA!, "worktree-removals");

    try {
      await expect(manager.create(base)).rejects.toThrow(
        "managed worktree root identity changed during creation",
      );
      expect(substituted).toBe(true);
      await expect(readdir(manifestRoot)).resolves.toHaveLength(1);
      await expect(stat(join(displacedRoot, "run-create-root-race"))).resolves.toBeDefined();
      await expect(recoverPendingWorktreeRemovals()).resolves.toEqual([]);
      await expect(stat(join(displacedRoot, "run-create-root-race")))
        .rejects.toMatchObject({ code: "ENOENT" });
      expect(await registeredWorktrees(directory)).not.toContain(resolve(worktreePath));
      await expect(readdir(manifestRoot)).resolves.toEqual([]);
    } finally {
      await rm(worktreesRoot, { recursive: true, force: true });
      try { await rename(displacedRoot, worktreesRoot); } catch { /* fixture cleanup */ }
      await rm(manifestRoot, { recursive: true, force: true });
      try { await manager.remove(worktreePath); } catch { /* fixture cleanup */ }
    }
  });

  it.runIf(process.platform !== "win32")(
    "privatizes and durably publishes a newly created runtime state root",
    async () => {
      const { directory, base } = await initRepo();
      const parent = await temporaryDirectory("ca-state-parent-");
      const stateRoot = join(parent, "private-state");
      process.env.CLAUDE_PLUGIN_DATA = stateRoot;
      const syncedDirectories: string[] = [];
      const manager = new WorktreeManager(directory, "run-private-state", undefined, {
        syncDirectory: async candidate => {
          syncedDirectories.push(candidate);
          await syncDirectoryMetadata(candidate);
        },
      });

      const attempt = await manager.create(base);
      try {
        expect((await stat(stateRoot)).mode & 0o077).toBe(0);
        expect(syncedDirectories).toContain(parent);
      } finally {
        await attempt.cleanup();
      }
    },
  );

  it.runIf(process.platform !== "win32")(
    "tightens an existing runtime state root before creating a worktree",
    async () => {
      const { directory, base } = await initRepo();
      await chmod(process.env.CLAUDE_PLUGIN_DATA!, 0o755);
      const manager = new WorktreeManager(directory, "run-private-existing-state");

      const attempt = await manager.create(base);
      try {
        expect((await stat(process.env.CLAUDE_PLUGIN_DATA!)).mode & 0o077).toBe(0);
      } finally {
        await attempt.cleanup();
      }
    },
  );

  it("canonicalizes a checkout reached through a symlinked ancestor", async () => {
    const { directory, base } = await initRepo();
    const aliasParent = `${directory}-alias`;
    await symlink(directory, aliasParent, process.platform === "win32" ? "junction" : "dir");
    const manager = new WorktreeManager(aliasParent, "run-checkout-alias");

    try {
      const attempt = await manager.create(base);
      expect(dirname(attempt.path)).toBe(managedRootOf(directory));
      await attempt.cleanup();
    } finally {
      await rm(aliasParent, { force: true });
    }
  });

  it("places worktrees made from a linked checkout in the main checkout namespace", async () => {
    const { directory, base } = await initRepo();
    const linked = join(directory, ".worktrees", "user-linked");
    await runGit(directory, ["worktree", "add", "-q", "--detach", linked, base]);
    const manager = new WorktreeManager(linked, "run-from-linked");

    const attempt = await manager.create(base);

    expect(dirname(attempt.path)).toBe(managedRootOf(directory));
    expect(await runGit(linked, ["status", "--porcelain", "--untracked-files=all"])).toBe("");
    await attempt.cleanup();
    await expect(stat(attempt.path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps the checkout clean and never touches user worktrees beside the namespace", async () => {
    const { directory, base } = await initRepo();
    const userWorktree = join(directory, ".worktrees", "user-feature");
    await runGit(directory, ["worktree", "add", "-q", "--detach", userWorktree, base]);
    await writeFile(join(userWorktree, "user-work.txt"), "keep\n");
    const manager = new WorktreeManager(directory, "run-namespaced");

    const attempt = await manager.create(base);
    await writeFile(join(attempt.path, "producer.txt"), "candidate\n");

    expect(dirname(attempt.path)).toBe(managedRootOf(directory));
    expect(await readFile(join(managedRootOf(directory), ".gitignore"), "utf8")).toBe("*\n");
    expect(await runGit(directory, ["status", "--porcelain", "--untracked-files=all"]))
      .toBe("?? .worktrees/user-feature/");
    await attempt.cleanup();
    await expect(recoverStaleRuns({ isProcessAlive: () => false })).resolves.toMatchObject({
      recovered: [],
    });
    await expect(readFile(join(userWorktree, "user-work.txt"), "utf8")).resolves.toBe("keep\n");
    expect(await registeredWorktrees(directory)).toContain(await realpath(userWorktree));
  });

  it.runIf(process.platform !== "win32")(
    "rejects a group-writable runtime state root before invoking git",
    async () => {
      const { directory, base } = await initRepo();
      await chmod(process.env.CLAUDE_PLUGIN_DATA!, 0o770);
      let gitCalls = 0;
      const manager = new WorktreeManager(directory, "run-writable-state", undefined, {
        git: async (cwd, args, options) => {
          gitCalls += 1;
          return await git(cwd, args, options);
        },
      });

      try {
        await expect(manager.create(base)).rejects.toThrow("writable by another principal");
        expect(gitCalls).toBe(0);
      } finally {
        await chmod(process.env.CLAUDE_PLUGIN_DATA!, 0o700);
      }
    },
  );

  it("rejects unsupported manifest storage before invoking git", async () => {
    const { directory, base } = await initRepo();
    let gitCalls = 0;
    const manager = new WorktreeManager(directory, "run-no-hardlinks", undefined, {
      async verifyRemovalStorage() {
        throw new Error("hard links unsupported");
      },
      git: async (cwd, args, options) => {
        gitCalls += 1;
        return await git(cwd, args, options);
      },
    });

    await expect(manager.create(base)).rejects.toThrow("hard links unsupported");
    expect(gitCalls).toBe(0);
  });

  it("rejects a symlinked worktree root before invoking git", async () => {
    const { directory, base } = await initRepo();
    const outside = await temporaryDirectory("ca-symlinked-worktree-root-");
    const sentinel = join(outside, "sentinel.txt");
    await writeFile(sentinel, "preserve outside root\n");
    const worktreesRoot = managedRootOf(directory);
    await mkdir(dirname(worktreesRoot));
    await symlink(outside, worktreesRoot, process.platform === "win32" ? "junction" : "dir");
    let gitCalls = 0;
    const manager = new WorktreeManager(directory, "run-symlinked-root", undefined, {
      git: async (cwd, args, options) => {
        gitCalls += 1;
        return await git(cwd, args, options);
      },
    });

    await expect(manager.create(base)).rejects.toThrow("managed worktree root must be a plain");
    expect(gitCalls).toBe(0);
    await expect(readFile(sentinel, "utf8")).resolves.toBe("preserve outside root\n");
  });

  it("refuses to remove a path outside its managed worktree", async () => {
    const { directory } = await initRepo();
    const outside = await temporaryDirectory("ca-outside-worktree-");
    const sentinel = join(outside, "sentinel.txt");
    await writeFile(sentinel, "keep\n");
    const manager = new WorktreeManager(directory, "run-confined");

    await expect(manager.remove(outside)).rejects.toThrow("refusing to remove unmanaged worktree path");

    await expect(stat(outside)).resolves.toBeDefined();
    await expect(stat(sentinel)).resolves.toBeDefined();
  });

  it("removes the exact registration when a new worktree vanishes before identity capture", async () => {
    const { directory, base } = await initRepo();
    const worktreePath = join(managedRootOf(directory),
      "run-vanished-after-add",
    );
    const manager = new WorktreeManager(directory, "run-vanished-after-add", undefined, {
      git: async (cwd, args, options) => {
        const result = await git(cwd, args, options);
        if (result.exitCode === 0 && args[0] === "worktree" && args[1] === "add") {
          await rm(worktreePath, { recursive: true });
        }
        return result;
      },
    });

    await expect(manager.create(base)).rejects.toThrow("created worktree directory disappeared");

    const listed = await git(directory, ["worktree", "list", "--porcelain", "-z"]);
    expect(listed.exitCode, listed.stderr).toBe(0);
    expect(listed.stdout).not.toContain(worktreePath);
  });

  it("preserves a colliding managed directory when worktree creation fails", async () => {
    const { directory, base } = await initRepo();
    const collidingPath = join(managedRootOf(directory), "run-collision");
    const sentinel = join(collidingPath, "sentinel.txt");
    await mkdir(collidingPath, { recursive: true });
    await writeFile(sentinel, "keep\n");
    const manager = new WorktreeManager(directory, "run-collision");

    await expect(manager.create(base)).rejects.toThrow("git worktree add failed");

    await expect(stat(collidingPath)).resolves.toBeDefined();
    await expect(stat(sentinel)).resolves.toBeDefined();
  });

  it("preserves an unregistered managed directory when worktree removal fails", async () => {
    const { directory, base } = await initRepo();
    const manager = new WorktreeManager(directory, "run-remove-failure");
    const attempt = await manager.create(base);
    await runGit(directory, ["worktree", "remove", "--force", attempt.path]);
    const sentinel = join(attempt.path, "sentinel.txt");
    await mkdir(attempt.path, { recursive: true });
    await writeFile(sentinel, "keep\n");

    await expect(manager.remove(attempt.path)).rejects.toThrow(
      "refusing to remove an unregistered managed directory",
    );

    await expect(stat(attempt.path)).resolves.toBeDefined();
    await expect(stat(sentinel)).resolves.toBeDefined();
  });

  it("rejects a quarantine token that could escape the managed root", async () => {
    const managedDirectory = join(process.env.CLAUDE_PLUGIN_DATA!, "worktrees",
      "run-quarantine-token",
    );
    await mkdir(managedDirectory, { recursive: true });
    await writeFile(join(managedDirectory, "sentinel.txt"), "preserve\n");

    await expect(removeManagedWorktreeDirectory(managedDirectory, {
      uuid: () => "../escape",
    })).rejects.toThrow("invalid managed worktree quarantine token");

    await expect(stat(join(managedDirectory, "sentinel.txt"))).resolves.toBeDefined();
  });

  it("restores a quarantined directory when removal-phase publication fails", async () => {
    const managedRoot = join(process.env.CLAUDE_PLUGIN_DATA!, "worktrees");
    const managedDirectory = join(managedRoot, "run-publication-failure");
    const quarantine = join(managedRoot, ".remove-run-publication-failure-fixed");
    const sentinel = join(managedDirectory, "sentinel.txt");
    await mkdir(managedDirectory, { recursive: true });
    await writeFile(sentinel, "preserve\n");
    const expectedIdentity = await managedWorktreeDirectoryIdentity(managedDirectory);
    expect(expectedIdentity).not.toBeNull();
    const publicationError = new Error("simulated manifest publication failure");

    await expect(removeManagedWorktreeDirectory(managedDirectory, {
      expectedIdentity: expectedIdentity!,
      uuid: () => "fixed",
      async afterQuarantine() { throw publicationError; },
    })).rejects.toBe(publicationError);

    await expect(readFile(sentinel, "utf8")).resolves.toBe("preserve\n");
    await expect(managedWorktreeDirectoryIdentity(managedDirectory)).resolves
      .toEqual(expectedIdentity);
    await expect(managedWorktreeDirectoryIdentity(quarantine)).resolves.toBeNull();
  });

  it("preserves leading and trailing newlines in Git path records", () => {
    expect(gitPathOutput("\nleading/path\n", "test path")).toBe("\nleading/path");
    expect(gitPathOutput("trailing/path\n\n", "test path")).toBe("trailing/path\n");
  });

  it("rejects a Git NUL record stream without its terminal delimiter", () => {
    expect(() => gitNulRecords("worktree /managed/path", "test list"))
      .toThrow("did not end with its NUL record delimiter");
    expect(gitNulRecords("worktree /managed/path\0", "test list"))
      .toEqual(["worktree /managed/path"]);
  });

  it("syncs each renamed or removed directory entry before advancing cleanup", async () => {
    const { directory, base } = await initRepo();
    const synced: string[] = [];
    const manager = new WorktreeManager(directory, "run-directory-sync", undefined, {
      syncDirectory: async directoryPath => { synced.push(await realpath(directoryPath)); },
    });
    const attempt = await manager.create(base);
    const commonDir = await realpath(await runGit(directory, [
      "rev-parse", "--path-format=absolute", "--git-common-dir",
    ]));
    const physicalRoot = await realpath(managedRootOf(directory));
    const registrationRoot = await realpath(join(commonDir, "worktrees"));
    const registrationQuarantineRoot = join(commonDir, "claude-architect-quarantine");

    await attempt.cleanup();

    expect(synced).toContain(physicalRoot);
    expect(synced).toContain(commonDir);
    expect(synced).toContain(registrationRoot);
    expect(synced).toContain(await realpath(registrationQuarantineRoot));
  });

  it("passes no ambient secrets to the native Windows cleanup helpers", async () => {
    const previousSecret = process.env.UNRELATED_SECRET;
    process.env.UNRELATED_SECRET = "do-not-pass";
    const managedDirectory = join(process.env.CLAUDE_PLUGIN_DATA!, "worktrees",
      "run-windows-environment",
    );
    await mkdir(managedDirectory, { recursive: true });
    await writeFile(join(managedDirectory, "payload.txt"), "remove\n");
    const spawnedRequests: Array<{ command: string; args: string[]; env: Record<string, string> }> = [];
    const processSupervisor = Object.create(getPlatformServices()) as PlatformServices;
    Object.defineProperty(processSupervisor, "os", { value: "win32" });
    processSupervisor.spawnSupervised = async request => {
      spawnedRequests.push({
        command: request.executable.command,
        args: [...request.args],
        env: { ...request.env },
      });
      if (request.executable.command === process.execPath) {
        for (const entry of await readdir(request.cwd)) {
          await rm(join(request.cwd, entry), { recursive: true, force: false });
        }
      } else if (request.args[0] === "remove" && request.args[1] !== undefined) {
        await removeEmptyDirectory(request.args[1]);
      }
      return {
        pid: 42_425,
        done: Promise.resolve({
          exitCode: 0,
          signal: null,
          timedOut: false,
          cancelled: false,
          stdout: "",
          stderr: "",
          truncated: { stdout: false, stderr: false },
        }),
        stdout: Readable.from([]),
        stderr: Readable.from([]),
      };
    };

    try {
      await expect(removeManagedWorktreeDirectory(managedDirectory, {
        processSupervisor,
      })).resolves.toBe(true);
      expect(spawnedRequests).toHaveLength(2);
      expect(spawnedRequests[0]?.command).toBe(process.execPath);
      expect(spawnedRequests[0]?.env).toEqual({
        ...windowsEssentialEnvironment(),
        CLAUDE_ARCHITECT_WINDOWS_FILESYSTEM_HELPER: expect.stringMatching(
          /win32-filesystem-(?:x64|arm64)\.exe$/u,
        ),
      });
      expect(spawnedRequests[1]?.command).toMatch(/win32-filesystem-(?:x64|arm64)\.exe$/u);
      expect(spawnedRequests[1]?.args[0]).toBe("remove");
      expect(spawnedRequests[1]?.env).toEqual(windowsEssentialEnvironment());
      expect(spawnedRequests.some(request => "UNRELATED_SECRET" in request.env)).toBe(false);
    } finally {
      if (previousSecret === undefined) delete process.env.UNRELATED_SECRET;
      else process.env.UNRELATED_SECRET = previousSecret;
    }
  });

  it("removes a quarantined symlink without following its external target", async () => {
    const physicalRoot = join(process.env.CLAUDE_PLUGIN_DATA!, "worktrees");
    const managedDirectory = join(physicalRoot, "run-symlink-cleanup");
    const external = await temporaryDirectory("ca-cleanup-symlink-target-");
    const sentinel = join(external, "sentinel.txt");
    await mkdir(managedDirectory, { recursive: true, mode: 0o700 });
    await writeFile(sentinel, "preserve external target\n");
    await symlink(
      external,
      join(managedDirectory, "producer-link"),
      process.platform === "win32" ? "junction" : "dir",
    );
    const expectedIdentity = await managedWorktreeDirectoryIdentity(managedDirectory);
    expect(expectedIdentity).not.toBeNull();

    await expect(removeManagedWorktreeDirectory(managedDirectory, {
      expectedIdentity: expectedIdentity!,
      uuid: () => "fixed",
    })).resolves.toBe(true);
    await expect(readFile(sentinel, "utf8")).resolves.toBe("preserve external target\n");
  });

  it.skipIf(process.platform === "win32")(
    "removes producer-created FIFOs without waiting for a reader",
    async () => {
      const physicalRoot = join(process.env.CLAUDE_PLUGIN_DATA!, "worktrees");
      const managedDirectory = join(physicalRoot, "run-fifo-cleanup");
      await mkdir(managedDirectory, { recursive: true, mode: 0o700 });
      await new Promise<void>((resolvePromise, rejectPromise) => {
        execFile("/usr/bin/mkfifo", [join(managedDirectory, "producer.fifo")], error => {
          if (error === null) resolvePromise();
          else rejectPromise(error);
        });
      });
      const expectedIdentity = await managedWorktreeDirectoryIdentity(managedDirectory);
      expect(expectedIdentity).not.toBeNull();
      const startedAt = Date.now();

      await expect(removeManagedWorktreeDirectory(managedDirectory, {
        expectedIdentity: expectedIdentity!,
        uuid: () => "fixed",
      })).resolves.toBe(true);
      expect(Date.now() - startedAt).toBeLessThan(10_000);
    },
  );

  it.skipIf(process.platform === "win32")(
    "removes only the managed link of a multiply-linked file",
    async () => {
      const physicalRoot = join(process.env.CLAUDE_PLUGIN_DATA!, "worktrees");
      const managedDirectory = join(physicalRoot, "run-hardlink-cleanup");
      const managedFile = join(managedDirectory, "producer-hardlink.txt");
      const retainedLink = join(process.env.CLAUDE_PLUGIN_DATA!, "retained-hardlink.txt");
      await mkdir(managedDirectory, { recursive: true, mode: 0o700 });
      await writeFile(managedFile, "retained bytes\n");
      await link(managedFile, retainedLink);
      const expectedIdentity = await managedWorktreeDirectoryIdentity(managedDirectory);
      expect(expectedIdentity).not.toBeNull();

      await expect(removeManagedWorktreeDirectory(managedDirectory, {
        expectedIdentity: expectedIdentity!,
        uuid: () => "fixed",
      })).resolves.toBe(true);
      await expect(readFile(retainedLink, "utf8")).resolves.toBe("retained bytes\n");
    },
  );

  it.skipIf(process.platform === "win32")(
    "preserves a nonempty replacement inserted at the final rmdir seam",
    async () => {
    const managedRoot = join(process.env.CLAUDE_PLUGIN_DATA!, "worktrees");
    const managedDirectory = join(managedRoot, "run-final-rmdir-race");
    const quarantine = join(managedRoot, ".remove-run-final-rmdir-race-fixed");
    const displaced = `${quarantine}-displaced`;
    const sentinel = join(quarantine, "sentinel.txt");
    await mkdir(managedDirectory, { recursive: true });
    await writeFile(join(managedDirectory, "original.txt"), "remove original\n");
    const expectedIdentity = await managedWorktreeDirectoryIdentity(managedDirectory);
    expect(expectedIdentity).not.toBeNull();

    try {
      await expect(removeManagedWorktreeDirectory(managedDirectory, {
        expectedIdentity: expectedIdentity!,
        uuid: () => "fixed",
        async rmdir(directory) {
          await rename(directory, displaced);
          await mkdir(directory);
          await writeFile(join(directory, "sentinel.txt"), "preserve replacement\n");
          await removeEmptyDirectory(directory);
        },
      })).rejects.toBeDefined();

      await expect(stat(displaced)).resolves.toBeDefined();
      await expect(stat(quarantine)).resolves.toBeDefined();
      await expect(stat(sentinel)).resolves.toBeDefined();
    } finally {
      await rm(quarantine, { recursive: true, force: true });
      await rm(displaced, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform !== "darwin")(
    "never removes an empty replacement inserted after final handle validation",
    async () => {
      const managedRoot = join(process.env.CLAUDE_PLUGIN_DATA!, "worktrees");
      const managedDirectory = join(managedRoot, "run-empty-final-rmdir-race");
      const quarantine = join(managedRoot, ".remove-run-empty-final-rmdir-race-fixed");
      const displaced = `${quarantine}-displaced`;
      await mkdir(managedDirectory, { recursive: true });
      await writeFile(join(managedDirectory, "original.txt"), "empty original during cleanup\n");
      const expectedIdentity = await managedWorktreeDirectoryIdentity(managedDirectory);
      expect(expectedIdentity).not.toBeNull();
      const selected = getPlatformServices();
      const processSupervisor = Object.create(selected) as PlatformServices;
      let lsofCalls = 0;
      processSupervisor.spawnSupervised = async request => {
        const result = await selected.spawnSupervised(request);
        if (request.executable.command === "/usr/sbin/lsof" && ++lsofCalls === 1) {
          await rename(quarantine, displaced);
          await mkdir(quarantine);
        }
        return result;
      };

      try {
        await expect(removeManagedWorktreeDirectory(managedDirectory, {
          expectedIdentity: expectedIdentity!,
          uuid: () => "fixed",
          processSupervisor,
        })).rejects.toThrow(/identity changed|escaped its validated path|remains linked/iu);
        await expect(stat(displaced)).resolves.toBeDefined();
        await expect(stat(quarantine)).resolves.toBeDefined();
      } finally {
        await rm(quarantine, { recursive: true, force: true });
        await rm(displaced, { recursive: true, force: true });
      }
    },
  );

  it.runIf(process.platform === "win32")(
    "never removes a directory substituted before Windows handle disposition",
    async () => {
      const managedRoot = join(process.env.CLAUDE_PLUGIN_DATA!, "worktrees");
      const managedDirectory = join(managedRoot, "run-windows-final-race");
      const quarantine = join(managedRoot, ".remove-run-windows-final-race-fixed");
      const displaced = `${quarantine}-displaced`;
      await mkdir(managedDirectory, { recursive: true });
      await writeFile(join(managedDirectory, "original.txt"), "empty original during cleanup\n");
      const expectedIdentity = await managedWorktreeDirectoryIdentity(managedDirectory);
      expect(expectedIdentity).not.toBeNull();
      const selected = getPlatformServices();
      const processSupervisor = Object.create(selected) as PlatformServices;
      let substituted = false;
      processSupervisor.spawnSupervised = async request => {
        if (!substituted
          && request.executable.command.match(/win32-filesystem-(?:x64|arm64)\.exe$/u)
          && request.args[0] === "remove"
          && request.args.at(-1) === "true") {
          substituted = true;
          await rename(quarantine, displaced);
          await mkdir(quarantine);
        }
        return await selected.spawnSupervised(request);
      };

      try {
        await expect(removeManagedWorktreeDirectory(managedDirectory, {
          expectedIdentity: expectedIdentity!,
          uuid: () => "fixed",
          processSupervisor,
        })).rejects.toThrow("validated Windows directory could not be removed");
        expect(substituted).toBe(true);
        await expect(stat(displaced)).resolves.toBeDefined();
        await expect(stat(quarantine)).resolves.toBeDefined();
      } finally {
        await rm(quarantine, { recursive: true, force: true });
        await rm(displaced, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "detects a managed-path replacement inserted after quarantine deletion",
    async () => {
    const physicalRoot = join(process.env.CLAUDE_PLUGIN_DATA!, "worktrees");
    await mkdir(physicalRoot, { mode: 0o700 });
    const managedDirectory = join(physicalRoot, "run-post-remove-replacement");
    const sentinel = join(managedDirectory, "sentinel.txt");
    await mkdir(managedDirectory, { mode: 0o700 });
    await writeFile(join(managedDirectory, "original.txt"), "remove original\n");
    const expectedIdentity = await managedWorktreeDirectoryIdentity(managedDirectory);
    expect(expectedIdentity).not.toBeNull();

    try {
      await expect(removeManagedWorktreeDirectory(managedDirectory, {
        expectedIdentity: expectedIdentity!,
        uuid: () => "fixed",
        async rmdir(directory) {
          await removeEmptyDirectory(directory);
          await mkdir(managedDirectory, { mode: 0o700 });
          await writeFile(sentinel, "preserve replacement\n");
        },
      })).rejects.toThrow("managed worktree root or target changed after removal");
      await expect(readFile(sentinel, "utf8")).resolves.toBe("preserve replacement\n");
    } finally {
      await rm(managedDirectory, { recursive: true, force: true });
    }
  });

  it("binds the real cleanup child to the validated quarantine inode", async () => {
    const managedRoot = join(process.env.CLAUDE_PLUGIN_DATA!, "worktrees");
    const managedDirectory = join(managedRoot, "run-child-cwd-race");
    const quarantine = join(managedRoot, ".remove-run-child-cwd-race-fixed");
    const displaced = `${quarantine}-displaced`;
    const sentinel = join(quarantine, "sentinel.txt");
    await mkdir(managedDirectory, { recursive: true });
    await writeFile(join(managedDirectory, "original.txt"), "preserve original inode\n");
    const expectedIdentity = await managedWorktreeDirectoryIdentity(managedDirectory);
    expect(expectedIdentity).not.toBeNull();
    const selected = getPlatformServices();
    const processSupervisor = Object.create(selected) as PlatformServices;
    processSupervisor.spawnSupervised = async request => {
      await rename(request.cwd, displaced);
      await mkdir(request.cwd);
      await writeFile(sentinel, "preserve replacement inode\n");
      return await selected.spawnSupervised(request);
    };

    try {
      await expect(removeManagedWorktreeDirectory(managedDirectory, {
        expectedIdentity: expectedIdentity!,
        uuid: () => "fixed",
        processSupervisor,
      })).rejects.toThrow("quarantined directory contents could not be removed");
      await expect(readFile(sentinel, "utf8")).resolves.toBe("preserve replacement inode\n");
      await expect(readFile(join(displaced, "original.txt"), "utf8"))
        .resolves.toBe("preserve original inode\n");
    } finally {
      await rm(quarantine, { recursive: true, force: true });
      await rm(displaced, { recursive: true, force: true });
    }
  });

  it("never deletes a directory substituted during quarantine rename", async () => {
    const { directory, base } = await initRepo();
    const manager = new WorktreeManager(directory, "run-substitution");
    const attempt = await manager.create(base);
    const expectedIdentity = await managedWorktreeDirectoryIdentity(attempt.path);
    expect(expectedIdentity).not.toBeNull();
    const displaced = `${attempt.path}-displaced`;
    const quarantine = join(managedRootOf(directory),
      ".remove-run-substitution-fixed",
    );
    const sentinel = join(quarantine, "sentinel.txt");

    try {
      await expect(removeManagedWorktreeDirectory(attempt.path, {
        expectedIdentity: expectedIdentity!,
        uuid: () => "fixed",
        async rename(source, destination) {
          await rename(source, displaced);
          await mkdir(source);
          await writeFile(join(source, "sentinel.txt"), "preserve replacement\n");
          await rename(source, destination);
        },
      })).rejects.toThrow("identity changed during quarantine");

      await expect(stat(displaced)).resolves.toBeDefined();
      await expect(stat(quarantine)).resolves.toBeDefined();
      await expect(stat(sentinel)).resolves.toBeDefined();
    } finally {
      await rm(quarantine, { recursive: true, force: true });
      await rename(displaced, attempt.path);
      await attempt.cleanup();
    }
  });

  it.runIf(process.platform === "win32")(
    "accepts equivalent state-root casing during cleanup",
    async () => {
      const { directory, base } = await initRepo();
      const manager = new WorktreeManager(directory, "run-state-case-change");
      const attempt = await manager.create(base);
      process.env.CLAUDE_PLUGIN_DATA = process.env.CLAUDE_PLUGIN_DATA!.toUpperCase();

      await expect(attempt.cleanup()).resolves.toBeUndefined();
      await expect(stat(attempt.path)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it.skipIf(process.platform === "win32")(
    "removes a registered worktree through newline and Unicode paths",
    async () => {
      const pluginParent = await temporaryDirectory("ca-plugin-path-parent-");
      const pluginData = join(pluginParent, "state\n雪");
      await mkdir(pluginData);
      process.env.CLAUDE_PLUGIN_DATA = pluginData;
      const repo = await initRepo("repository\n雪");
      const manager = new WorktreeManager(repo.directory, "run-unicode-path");
      const attempt = await manager.create(repo.base);

      await attempt.cleanup();

      await expect(stat(attempt.path)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await registeredWorktrees(repo.directory)).not.toContain(resolve(attempt.path));
    },
  );

  it.skipIf(process.platform === "win32")(
    "decodes an actual Git common directory starting and ending with newlines",
    async () => {
      const parent = await temporaryDirectory("ca-newline-common-dir-");
      const commonDir = join(parent, "\ncommon.git\n");
      await runGit(parent, ["init", "-q", "--bare", commonDir]);

      const result = await git(commonDir, [
        "rev-parse", "--path-format=absolute", "--git-common-dir",
      ]);

      expect(result.exitCode, result.stderr).toBe(0);
      expect(gitPathOutput(result.stdout, "test common directory")).toBe(
        await realpath(commonDir),
      );
    },
  );

  it("does not silently fall back to a temporary directory outside tests", async () => {
    const { directory, base } = await initRepo();
    delete process.env.CLAUDE_PLUGIN_DATA;
    delete process.env.CLAUDE_ARCHITECT_STATE_DIR;
    process.env.NODE_ENV = "production";

    await expect(new WorktreeManager(directory, "run-no-state").create(base)).rejects.toThrow(
      "CLAUDE_PLUGIN_DATA is required outside test environments",
    );
  });

});
