import { realpathSync } from "node:fs";
import { mkdtemp, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { git } from "../../src/git/git-exec.js";
import { getPlatformServices } from "../../src/platform/select-platform.js";
import { recoverPendingWorktreeRemovals } from "../../src/runtime/recovery-worktree-removals.js";
import {
  managedWorktreeDirectoryIdentity,
  WorktreeManager,
} from "../../src/runtime/worktree-manager.js";
import {
  readPendingWorktreeRemovalManifests,
  type WorktreeTransactionPhase,
  type WorktreeTransactionPhaseObserver,
} from "../../src/runtime/worktree-transaction.js";

let temporaryPaths: string[] = [];
let previousPluginData: string | undefined;
let previousStateDirectory: string | undefined;

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  temporaryPaths.push(directory);
  return directory;
}

async function runGit(cwd: string, args: string[]): Promise<string> {
  const result = await git(cwd, args);
  expect(result.exitCode, result.stderr).toBe(0);
  return result.stdout.trim();
}

async function initRepo(): Promise<{ directory: string; base: string }> {
  const directory = await temporaryDirectory("ca-transaction-repo-");
  await runGit(directory, ["init", "-q"]);
  await writeFile(join(directory, "a.txt"), "hello\n");
  await runGit(directory, ["add", "-A"]);
  await runGit(directory, ["commit", "-q", "-m", "init"]);
  return { directory, base: await runGit(directory, ["rev-parse", "HEAD"]) };
}

async function registeredWorktrees(repository: string): Promise<string[]> {
  const listed = await git(repository, ["worktree", "list", "--porcelain", "-z"]);
  expect(listed, listed.stderr).toMatchObject({ exitCode: 0 });
  return await Promise.all(listed.stdout.split("\0")
    .filter(field => field.startsWith("worktree "))
    .map(async field => await realpath(resolve(field.slice("worktree ".length)))));
}

async function identityFields(prefix: string, directory: string) {
  const identity = await managedWorktreeDirectoryIdentity(directory);
  if (identity === null) throw new Error(`${prefix} fixture directory is missing`);
  return {
    [`${prefix}Dev`]: identity.dev.toString(),
    [`${prefix}Ino`]: identity.ino.toString(),
    [`${prefix}BirthtimeNs`]: identity.birthtimeNs.toString(),
  };
}

function manifestRoot(): string {
  return join(process.env.CLAUDE_PLUGIN_DATA!, "worktree-removals");
}

async function manifestNames(): Promise<string[]> {
  try {
    return await readdir(manifestRoot());
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

beforeEach(async () => {
  previousPluginData = process.env.CLAUDE_PLUGIN_DATA;
  previousStateDirectory = process.env.CLAUDE_ARCHITECT_STATE_DIR;
  process.env.CLAUDE_PLUGIN_DATA = await temporaryDirectory("ca-transaction-data-");
  delete process.env.CLAUDE_ARCHITECT_STATE_DIR;
});

afterEach(async () => {
  if (previousPluginData === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
  else process.env.CLAUDE_PLUGIN_DATA = previousPluginData;
  if (previousStateDirectory === undefined) delete process.env.CLAUDE_ARCHITECT_STATE_DIR;
  else process.env.CLAUDE_ARCHITECT_STATE_DIR = previousStateDirectory;
  await Promise.all(temporaryPaths.map(async directory =>
    await rm(directory, { recursive: true, force: true })));
  temporaryPaths = [];
});

describe("worktree transaction", () => {
  it("reads and recovers a version-1 manifest in the format written before the module", async () => {
    const { directory, base } = await initRepo();
    const attempt = await new WorktreeManager(directory, "run-v1-fixture").create(base);
    const physicalPath = await realpath(attempt.path);
    const physicalRoot = dirname(physicalPath);
    const commonDir = await realpath(await runGit(directory, [
      "rev-parse", "--path-format=absolute", "--git-common-dir",
    ]));
    const registrationRoot = join(commonDir, "worktrees");
    const registrationPath = await realpath(await runGit(physicalPath, [
      "rev-parse", "--path-format=absolute", "--git-dir",
    ]));
    const quarantineRoot = join(commonDir, "claude-architect-quarantine");
    const transactionId = "00000000-0000-4000-8000-0000000000a1";
    const quarantinePath = join(
      quarantineRoot,
      `.remove-registration-${basename(registrationPath)}-${transactionId}`,
    );
    // Key order and field set exactly as the removal coordinator wrote them at
    // the ticket base: version, phase, then the transaction fields.
    const fields = {
      manifestVersion: "1",
      phase: "physical-removal-started",
      transactionId,
      commonDir,
      ...await identityFields("commonDir", commonDir),
      physicalPresent: true,
      physicalPath,
      physicalQuarantinePath: join(physicalRoot, `.remove-${basename(physicalPath)}-${transactionId}`),
      ...await identityFields("physical", physicalPath),
      ...await identityFields("physicalRoot", physicalRoot),
      registrationRoot,
      ...await identityFields("registrationRoot", registrationRoot),
      registrationPath,
      quarantineRoot,
      ...await identityFields("quarantineRoot", quarantineRoot),
      quarantinePath,
      ...await identityFields("registration", registrationPath),
    };
    // The coordinator staged the registration before marking removal started.
    await rename(registrationPath, quarantinePath);
    const manifestPath = join(manifestRoot(), `${transactionId}.json`);
    await writeFile(manifestPath, `${JSON.stringify(fields)}\n`, { mode: 0o600 });

    const read = await readPendingWorktreeRemovalManifests();
    expect(read.issues).toEqual([]);
    expect(read.pending).toEqual([{ manifestPath, manifest: fields }]);

    await expect(recoverPendingWorktreeRemovals()).resolves.toEqual([]);
    await expect(stat(physicalPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(quarantinePath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await registeredWorktrees(directory)).not.toContain(physicalPath);
    expect(await manifestNames()).toEqual([]);
  });

  type Outcome = "rolled back" | "fully created" | "fully removed";
  const crashTable: Array<{
    operation: "create" | "remove";
    phase: WorktreeTransactionPhase;
    write: number;
    outcome: Outcome;
  }> = [
    { operation: "create", phase: "creation-intent", write: 1, outcome: "rolled back" },
    { operation: "create", phase: "creation-intent", write: 2, outcome: "rolled back" },
    { operation: "remove", phase: "registration-intent", write: 1, outcome: "fully created" },
    { operation: "remove", phase: "registration-staged", write: 1, outcome: "fully created" },
    { operation: "remove", phase: "physical-removal-intent", write: 1, outcome: "fully created" },
    { operation: "remove", phase: "physical-removal-started", write: 1, outcome: "fully removed" },
    { operation: "remove", phase: "physical-removed", write: 1, outcome: "fully removed" },
  ];

  it.each(crashTable)(
    "recovers a $operation crash after $phase write $write as $outcome",
    async ({ operation, phase, write, outcome }) => {
      const { directory, base } = await initRepo();
      const runId = "run-crash-table";
      const worktreePath = join(
        realpathSync.native(directory),
        ".worktrees",
        "claude-architect",
        runId,
      );
      if (operation === "remove") {
        await new WorktreeManager(directory, runId).create(base);
      }
      // The crashed process held the checkout lock; its death releases it.
      const lease = await getPlatformServices().acquireCheckoutLock(directory);
      let writes = 0;
      let crashed!: () => void;
      const crash = new Promise<void>(resolve => { crashed = resolve; });
      const afterTransactionPhase: WorktreeTransactionPhaseObserver = async recorded => {
        if (recorded !== phase || ++writes !== write) return;
        crashed();
        // Nothing after this durable write ever runs, exactly as in a crash.
        await new Promise<never>(() => {});
      };
      const manager = new WorktreeManager(directory, runId, undefined, {
        borrowedCheckoutLease: lease,
        afterTransactionPhase,
      });
      const interrupted = operation === "create"
        ? manager.create(base)
        : manager.remove(worktreePath);
      await Promise.race([
        crash,
        interrupted.then(() => { throw new Error(`${operation} finished without reaching ${phase}`); }),
      ]);
      await lease.release();
      expect(await manifestNames()).toHaveLength(1);

      await expect(recoverPendingWorktreeRemovals()).resolves.toEqual([]);

      expect(await manifestNames()).toEqual([]);
      const registered = await registeredWorktrees(directory);
      if (outcome === "fully created") {
        await expect(stat(worktreePath)).resolves.toBeDefined();
        expect(registered).toContain(await realpath(worktreePath));
        await expect(runGit(worktreePath, ["rev-parse", "HEAD"])).resolves.toBe(base);
      } else {
        await expect(stat(worktreePath)).rejects.toMatchObject({ code: "ENOENT" });
        expect(registered).toHaveLength(1);
        // Only the namespace's own ignore file remains: no placeholder or quarantine.
        expect(await readdir(dirname(worktreePath))).toEqual([".gitignore"]);
      }
      const commonDir = await realpath(await runGit(directory, [
        "rev-parse", "--path-format=absolute", "--git-common-dir",
      ]));
      expect(await readdir(join(commonDir, "claude-architect-quarantine"))).toEqual([]);
    },
  );
});
