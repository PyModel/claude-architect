import { chmod, mkdir, mkdtemp, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { freezeCandidate } from "../../src/git/candidate-tree.js";
import { git } from "../../src/git/git-exec.js";
import { composeSliceOntoHead } from "../../src/pipeline/slice-composer.js";
import { producerHomeRoot, withRuntimeScratch } from "../../src/runtime/producer-home.js";
import { RuntimeError } from "../../src/util/errors.js";
import { probeCowSupport } from "../../src/verify/dependency-link.js";
import { projectVerify } from "../../src/verify/project-verifier.js";

/**
 * Runtime-owned scratch directories (Git index files, the CoW probe,
 * verification TMPDIR) are identity-bound allocations under the private HOME
 * root and are retired through quarantine, never removed by pathname from the
 * shared system temp directory.
 */

const temporaryPaths: string[] = [];
/** TMPDIR before lockSharedTemp; `null` means not locked (CI Linux has no TMPDIR). */
let previousTmpdir: string | undefined | null = null;

async function run(cwd: string, args: string[]): Promise<string> {
  const result = await git(cwd, args);
  expect(result.exitCode, result.stderr).toBe(0);
  return result.stdout.trim();
}

async function repository(): Promise<{ directory: string; base: string; worktree: string }> {
  const root = await mkdtemp(join(tmpdir(), "ca-scratch-repo-"));
  temporaryPaths.push(root);
  const directory = join(root, "repo");
  await mkdir(directory);
  await run(directory, ["init", "-q"]);
  await writeFile(join(directory, "a.txt"), "base\n");
  await run(directory, ["add", "-A"]);
  await run(directory, ["commit", "-q", "-m", "base"]);
  const base = await run(directory, ["rev-parse", "HEAD"]);
  const worktree = join(root, "worktree");
  await run(directory, ["worktree", "add", "-q", "--detach", worktree, base]);
  return { directory, base, worktree };
}

async function homeRootEntries(): Promise<string[]> {
  return (await readdir(producerHomeRoot()).catch(() => [] as string[])).sort();
}

/** Make the shared temp directory unusable, so any use of it fails loudly. */
async function lockSharedTemp(): Promise<void> {
  const locked = await mkdtemp(join(tmpdir(), "ca-locked-tmp-"));
  temporaryPaths.push(locked);
  await chmod(locked, 0o500);
  previousTmpdir = process.env.TMPDIR;
  process.env.TMPDIR = locked;
}

beforeEach(() => {
  previousTmpdir = null;
});

afterEach(async () => {
  if (previousTmpdir === undefined) delete process.env.TMPDIR;
  else if (previousTmpdir !== null) process.env.TMPDIR = previousTmpdir;
  for (const entry of temporaryPaths) await chmod(entry, 0o700).catch(() => undefined);
  temporaryPaths.push(producerHomeRoot());
  await Promise.all(temporaryPaths.splice(0).map(entry =>
    rm(entry, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })));
});

describe("withRuntimeScratch", () => {
  it("allocates under the private root and retires the directory", async () => {
    const seen = await withRuntimeScratch(async directory => {
      await mkdir(join(directory, "nested"));
      await writeFile(join(directory, "nested", "index"), "x");
      return directory;
    });

    expect(dirname(seen)).toBe(await realpath(producerHomeRoot()));
    expect(await homeRootEntries()).toEqual([]);
  });

  it("rethrows the work's error after retiring", async () => {
    const failure = new RuntimeError("work failed", { classification: "kept" });

    await expect(withRuntimeScratch(async () => { throw failure; })).rejects.toBe(failure);
    expect(await homeRootEntries()).toEqual([]);
  });

  it("preserves a replaced scratch directory and fails with a classified error", async () => {
    let aside = "";
    const error = await withRuntimeScratch(async directory => {
      aside = `${directory}-aside`;
      await rename(directory, aside);
      await mkdir(directory);
      await writeFile(join(directory, "planted"), "x");
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(RuntimeError);
    expect((error as RuntimeError).detail?.classification).toBe("runtime-scratch-preserved");
    expect((error as RuntimeError).message).toMatch(/replaced before retirement/u);
    expect((error as RuntimeError).message).not.toContain(aside);
    expect(await homeRootEntries()).toContain(basename(aside));
  });
});

describe.runIf(process.platform !== "win32")("runtime scratch never uses the shared temp directory", () => {
  it("freezes a candidate", async () => {
    const { directory, base, worktree } = await repository();
    await writeFile(join(worktree, "a.txt"), "candidate\n");
    await lockSharedTemp();

    const frozen = await freezeCandidate({
      repoRoot: directory,
      worktreePath: worktree,
      baseCommitOid: base,
      runId: "scratch-freeze",
      writeAllowlist: ["a.txt"],
      forbiddenScope: [],
    });

    expect(frozen.ok).toBe(true);
    expect(await homeRootEntries()).toEqual([]);
  });

  it("composes a slice", async () => {
    const { directory, base, worktree } = await repository();
    await writeFile(join(worktree, "b.txt"), "slice one\n");
    await run(worktree, ["add", "-A"]);
    await run(worktree, ["commit", "-q", "-m", "one"]);
    const first = await run(worktree, ["rev-parse", "HEAD"]);
    await run(worktree, ["checkout", "-q", "--detach", base]);
    await writeFile(join(worktree, "c.txt"), "slice two\n");
    await run(worktree, ["add", "-A"]);
    await run(worktree, ["commit", "-q", "-m", "two"]);
    const second = await run(worktree, ["rev-parse", "HEAD"]);
    await lockSharedTemp();

    const composed = await composeSliceOntoHead({
      checkoutPath: directory,
      head: first,
      base,
      sliceCommit: second,
      sliceIndex: 2,
      runId: "scratch-compose",
    });

    expect(composed).toMatch(/^[0-9a-f]{40}$/u);
    expect(await homeRootEntries()).toEqual([]);
  });

  it.runIf(process.platform === "darwin" || process.platform === "linux")("probes copy-on-write support", async () => {
    await lockSharedTemp();

    const result = await probeCowSupport();

    expect(result.strategy).toBe(process.platform === "darwin" ? "clonefile" : "reflink");
    expect(await homeRootEntries()).toEqual([]);
  });
});

describe.runIf(process.platform === "darwin")("verification scratch", () => {
  it("is a private allocation the confined command can fill but neither move nor recreate", async () => {
    const { directory, base, worktree } = await repository();
    await writeFile(join(worktree, "a.txt"), "candidate\n");
    const frozen = await freezeCandidate({
      repoRoot: directory,
      worktreePath: worktree,
      baseCommitOid: base,
      runId: "scratch-verify",
      writeAllowlist: ["a.txt"],
      forbiddenScope: [],
    });
    if (!frozen.ok) throw new Error(`freeze failed: ${frozen.reason}`);

    const result = await projectVerify({
      repoRoot: directory,
      artifact: frozen.artifact,
      commands: [{
        id: "probe",
        executable: process.execPath,
        args: ["-e", `
          const fs = require("node:fs");
          const path = require("node:path");
          const scratch = process.env.TMPDIR;
          const attempt = action => { try { action(); return "written"; } catch (error) { return error.code; } };
          process.stdout.write(JSON.stringify({
            scratch,
            nested: attempt(() => {
              fs.mkdirSync(path.join(scratch, "cache"));
              fs.writeFileSync(path.join(scratch, "cache", "x"), "x");
            }),
            moveOut: attempt(() => fs.renameSync(scratch, path.join(process.cwd(), "stolen-scratch"))),
            sibling: attempt(() => fs.writeFileSync(path.join(path.dirname(scratch), "planted"), "x")),
          }));
        `],
        cwd: ".",
        timeoutMs: 60_000,
        network: "denied",
        expectedExitCodes: [0],
      }],
    });

    const report = JSON.parse(result.outputLogs[0]!.text) as Record<string, string>;
    expect(dirname(report.scratch!)).toBe(await realpath(producerHomeRoot()));
    expect(report).toMatchObject({ nested: "written", moveOut: "EPERM", sibling: "EPERM" });
    expect(await homeRootEntries()).toEqual([]);
  });
});
