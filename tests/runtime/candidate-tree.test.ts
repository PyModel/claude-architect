import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { freezeCandidate } from "../../src/git/candidate-tree.js";
import { git } from "../../src/git/git-exec.js";

const temporaryPaths: string[] = [];
const gitHooks = vi.hoisted(() => ({
  afterReadTree: undefined as (() => Promise<void>) | undefined,
  failCommand: undefined as string | undefined,
  truncateCommand: undefined as string | undefined,
}));

vi.mock("../../src/git/git-exec.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../../src/git/git-exec.js")>();
  return {
    ...actual,
    git: async (...args: Parameters<typeof actual.git>) => {
      // The subcommand, past leading options such as --attr-source.
      const command = args[1].find(arg => !arg.startsWith("-"));
      if (command === gitHooks.failCommand) {
        return { stdout: "", stderr: `forced ${gitHooks.failCommand} failure`, exitCode: 1 };
      }
      const result = await actual.git(...args);
      if (command === gitHooks.truncateCommand) {
        return { ...result, truncated: { stdout: true, stderr: false } };
      }
      if (command === "read-tree" && gitHooks.afterReadTree !== undefined) {
        const hook = gitHooks.afterReadTree;
        gitHooks.afterReadTree = undefined;
        await hook();
      }
      return result;
    },
  };
});

async function runGit(cwd: string, args: string[]): Promise<string> {
  const result = await git(cwd, args);
  expect(result.exitCode, result.stderr).toBe(0);
  return result.stdout.trim();
}

async function initRepoAndWorktree(
  files: Record<string, string> = { "a.txt": "hello\n" },
  symlinks: Record<string, string> = {},
): Promise<{ repoRoot: string; worktreePath: string; baseCommitOid: string; baseTreeOid: string }> {
  const root = await mkdtemp(join(tmpdir(), "ca-candidate-tree-"));
  temporaryPaths.push(root);
  const repoRoot = join(root, "repo");
  const worktreePath = join(root, "worktree");
  await mkdir(repoRoot);
  await runGit(repoRoot, ["init", "-q"]);
  for (const [relativePath, contents] of Object.entries(files)) {
    const filePath = join(repoRoot, relativePath);
    await mkdir(join(filePath, ".."), { recursive: true });
    await writeFile(filePath, contents);
  }
  for (const [relativePath, target] of Object.entries(symlinks)) {
    const filePath = join(repoRoot, relativePath);
    await mkdir(join(filePath, ".."), { recursive: true });
    await symlink(target, filePath);
  }
  await runGit(repoRoot, ["add", "-A"]);
  await runGit(repoRoot, ["commit", "-q", "-m", "init"]);
  const baseCommitOid = await runGit(repoRoot, ["rev-parse", "HEAD"]);
  const baseTreeOid = await runGit(repoRoot, ["rev-parse", `${baseCommitOid}^{tree}`]);
  await runGit(repoRoot, ["worktree", "add", "--detach", "-q", worktreePath, baseCommitOid]);
  return { repoRoot, worktreePath, baseCommitOid, baseTreeOid };
}

afterEach(async () => {
  gitHooks.afterReadTree = undefined;
  gitHooks.failCommand = undefined;
  gitHooks.truncateCommand = undefined;
  await Promise.all(temporaryPaths.splice(0).map(path => rm(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })));
});

describe("freezeCandidate", () => {
  it("rejects out-of-scope writes", async () => {
    const fixture = await initRepoAndWorktree();
    await writeFile(join(fixture.worktreePath, "a.txt"), "allowed\n");
    await writeFile(join(fixture.worktreePath, "b.txt"), "outside\n");

    const result = await freezeCandidate({
      ...fixture,
      runId: "run-out-of-scope",
      writeAllowlist: ["a.txt"],
      forbiddenScope: [],
    });

    expect(result).toEqual({ ok: false, reason: "out-of-scope-write", paths: ["b.txt"] });
  });

  it("freezes an allowed edit into a content-addressed tree", async () => {
    const fixture = await initRepoAndWorktree();
    await writeFile(join(fixture.worktreePath, "a.txt"), "updated\n");

    const result = await freezeCandidate({
      ...fixture,
      runId: "run-allowed",
      writeAllowlist: ["a.txt"],
      forbiddenScope: [],
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.artifact.baseCommitOid).toBe(fixture.baseCommitOid);
      expect(result.artifact.candidateTreeOid).toMatch(/^[0-9a-f]{40}$/);
      expect(result.artifact.candidateTreeOid).not.toBe(fixture.baseTreeOid);
      expect(result.artifact.candidateCommitOid).toMatch(/^[0-9a-f]{40}$/);
      expect(result.artifact.anchorRef).toBe("refs/claude-architect/candidates/run-allowed");
      expect(result.artifact.manifestHash).toMatch(/^[0-9a-f]{64}$/);
      expect(result.artifact.changedPaths).toEqual([
        {
          path: "a.txt",
          changeType: "modified",
          mode: "100644",
          contentHash: expect.stringMatching(/^[0-9a-f]{40}$/),
        },
      ]);
      expect(result.artifact.patch).toContain("a.txt");
      expect(result.artifact.patch.length).toBeGreaterThan(0);
      expect(await runGit(fixture.repoRoot, ["rev-parse", result.artifact.anchorRef])).toBe(
        result.artifact.candidateCommitOid,
      );
    }
  });

  it("records deleted files with their base mode and a null content hash", async () => {
    const fixture = await initRepoAndWorktree({
      "a.txt": "keep\n",
      "delete.txt": "remove\n",
    });
    await rm(join(fixture.worktreePath, "delete.txt"));

    const result = await freezeCandidate({
      ...fixture,
      runId: "run-deletion",
      writeAllowlist: ["delete.txt"],
      forbiddenScope: [],
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.artifact.changedPaths).toEqual([{
        path: "delete.txt",
        changeType: "deleted",
        mode: "100644",
        contentHash: null,
      }]);
      expect(result.artifact.patch).toContain("deleted file mode 100644");
    }
  });

  it("does not leave an anchor when metadata construction fails", async () => {
    const fixture = await initRepoAndWorktree();
    await writeFile(join(fixture.worktreePath, "a.txt"), "updated\n");
    const anchorRef = "refs/claude-architect/candidates/run-metadata-failure";
    gitHooks.failCommand = "diff";

    await expect(freezeCandidate({
      ...fixture,
      runId: "run-metadata-failure",
      writeAllowlist: ["a.txt"],
      forbiddenScope: [],
    })).rejects.toThrow("git diff failed");

    const refResult = await git(fixture.repoRoot, ["show-ref", "--verify", "--quiet", anchorRef]);
    expect(refResult.exitCode).not.toBe(0);
  });

  it("fails closed without publishing an anchor when git output is truncated", async () => {
    const fixture = await initRepoAndWorktree();
    await writeFile(join(fixture.worktreePath, "a.txt"), "updated\n");
    const anchorRef = "refs/claude-architect/candidates/run-truncated-diff";
    gitHooks.truncateCommand = "diff";

    await expect(freezeCandidate({
      ...fixture,
      runId: "run-truncated-diff",
      writeAllowlist: ["a.txt"],
      forbiddenScope: [],
    })).rejects.toMatchObject({
      name: "RuntimeError",
      message: "git diff output exceeded the runtime bound",
      detail: {
        command: "diff",
        truncated: { stdout: true, stderr: false },
      },
    });

    const refResult = await git(fixture.repoRoot, ["show-ref", "--verify", "--quiet", anchorRef]);
    expect(refResult.exitCode).not.toBe(0);
  });

  it.skipIf(process.platform === "win32")("rejects a symlink added by the producer", async () => {
    const fixture = await initRepoAndWorktree();
    await symlink("a.txt", join(fixture.worktreePath, "link.txt"));

    const result = await freezeCandidate({
      ...fixture,
      runId: "run-symlink",
      writeAllowlist: ["link.txt"],
      forbiddenScope: [],
    });

    expect(result).toEqual({ ok: false, reason: "modified-symlink" });
  });

  it.skipIf(process.platform === "win32")("fast-fails an obvious symlink before building the index", async () => {
    const fixture = await initRepoAndWorktree();
    await symlink("a.txt", join(fixture.worktreePath, "link.txt"));

    const result = await freezeCandidate({
      ...fixture,
      baseCommitOid: "0".repeat(40),
      runId: "run-symlink-fast-fail",
      writeAllowlist: ["link.txt"],
      forbiddenScope: [],
    });

    expect(result).toEqual({ ok: false, reason: "modified-symlink" });
  });

  it.skipIf(process.platform === "win32")("rejects a symlink introduced after the advisory scan", async () => {
    const fixture = await initRepoAndWorktree();
    const candidatePath = join(fixture.worktreePath, "link.txt");
    await writeFile(candidatePath, "regular file during inventory\n");
    gitHooks.afterReadTree = async () => {
      await rm(candidatePath);
      await symlink("a.txt", candidatePath);
    };

    const result = await freezeCandidate({
      ...fixture,
      runId: "run-symlink-frozen-tree",
      writeAllowlist: ["link.txt"],
      forbiddenScope: [],
    });

    expect(result).toEqual({ ok: false, reason: "modified-symlink" });
  });

  it.skipIf(process.platform === "win32")("rejects deletion of a tracked symlink", async () => {
    const fixture = await initRepoAndWorktree(
      { "a.txt": "target\n" },
      { "link.txt": "a.txt" },
    );
    await rm(join(fixture.worktreePath, "link.txt"));

    const result = await freezeCandidate({
      ...fixture,
      runId: "run-delete-symlink",
      writeAllowlist: ["link.txt"],
      forbiddenScope: [],
    });

    expect(result).toEqual({ ok: false, reason: "modified-symlink" });
  });

  it.skipIf(process.platform === "win32")("rejects replacement of a tracked symlink", async () => {
    const fixture = await initRepoAndWorktree(
      { "a.txt": "target\n" },
      { "link.txt": "a.txt" },
    );
    await rm(join(fixture.worktreePath, "link.txt"));
    await writeFile(join(fixture.worktreePath, "link.txt"), "regular replacement\n");

    const result = await freezeCandidate({
      ...fixture,
      runId: "run-replace-symlink",
      writeAllowlist: ["link.txt"],
      forbiddenScope: [],
    });

    expect(result).toEqual({ ok: false, reason: "modified-symlink" });
  });

  it("rejects an empty candidate", async () => {
    const fixture = await initRepoAndWorktree();

    const result = await freezeCandidate({
      ...fixture,
      runId: "run-empty",
      writeAllowlist: ["a.txt"],
      forbiddenScope: [],
    });

    expect(result).toEqual({ ok: false, reason: "empty-candidate" });
  });

  it("rejects a write inside forbidden scope even when allowlisted", async () => {
    const fixture = await initRepoAndWorktree({ "src/private.txt": "base\n" });
    await writeFile(join(fixture.worktreePath, "src/private.txt"), "changed\n");

    const result = await freezeCandidate({
      ...fixture,
      runId: "run-forbidden",
      writeAllowlist: ["src/**"],
      forbiddenScope: ["src/private.txt"],
    });

    expect(result).toEqual({
      ok: false,
      reason: "out-of-scope-write",
      paths: ["src/private.txt"],
    });
  });

  it("rejects case variants of forbidden paths", async () => {
    const fixture = await initRepoAndWorktree();
    await mkdir(join(fixture.worktreePath, "src", "Private"), { recursive: true });
    await writeFile(join(fixture.worktreePath, "src", "Private", "secret.txt"), "secret\n");

    const result = await freezeCandidate({
      ...fixture,
      runId: "run-forbidden-case-variant",
      writeAllowlist: ["src/**"],
      forbiddenScope: ["src/private/**"],
    });

    expect(result).toEqual({
      ok: false,
      reason: "out-of-scope-write",
      paths: ["src/Private/secret.txt"],
    });
  });

  it("stages paths containing pathspec metacharacters literally", async () => {
    const fixture = await initRepoAndWorktree({ "foo[1].ts": "base\n" });
    await writeFile(join(fixture.worktreePath, "foo[1].ts"), "changed\n");

    const result = await freezeCandidate({
      ...fixture,
      runId: "run-literal",
      writeAllowlist: ["foo[1].ts"],
      forbiddenScope: [],
    });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.artifact.changedPaths.map(change => change.path)).toEqual(["foo[1].ts"]);
  });

  it("excludes ignored paths from the candidate", async () => {
    const fixture = await initRepoAndWorktree({ ".gitignore": "ignored.txt\n", "a.txt": "hello\n" });
    await writeFile(join(fixture.worktreePath, "ignored.txt"), "ignored\n");

    const result = await freezeCandidate({
      ...fixture,
      runId: "run-ignored",
      writeAllowlist: ["**"],
      forbiddenScope: [],
    });

    expect(result).toEqual({ ok: false, reason: "empty-candidate" });
  });

  it("returns sorted ignored paths as successful freeze evidence", async () => {
    const fixture = await initRepoAndWorktree({
      ".gitignore": "*.log\nignored-dir/\n",
      "a.txt": "hello\n",
    });
    await writeFile(join(fixture.worktreePath, "a.txt"), "changed\n");
    await writeFile(join(fixture.worktreePath, "z.log"), "ignored\n");
    await writeFile(join(fixture.worktreePath, "a.log"), "ignored\n");
    await writeFile(join(fixture.worktreePath, "API_KEY=abcdef123456.log"), "ignored\n");
    await mkdir(join(fixture.worktreePath, "ignored-dir"));
    await writeFile(join(fixture.worktreePath, "ignored-dir", "nested.log"), "ignored\n");

    const result = await freezeCandidate({
      ...fixture,
      runId: "run-ignored-evidence",
      writeAllowlist: ["a.txt"],
      forbiddenScope: [],
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.evidence).toEqual({
        ignoredPaths: ["API_KEY=[e]", "a.log", "ignored-dir/nested.log", "z.log"],
      });
      expect(result.artifact).not.toHaveProperty("ignoredPaths");
    }
  });

  it("redacts secrets from the persisted review patch", async () => {
    const fixture = await initRepoAndWorktree();
    await writeFile(join(fixture.worktreePath, "a.txt"), "API_KEY=abcdef123456\n");

    const result = await freezeCandidate({
      ...fixture,
      runId: "run-redaction",
      writeAllowlist: ["a.txt"],
      forbiddenScope: [],
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.artifact.patch).toContain("[e]");
      expect(result.artifact.patch).not.toContain("abcdef123456");
    }
  });

  it("replaces every reconstructible binary patch payload with a safe marker", async () => {
    const fixture = await initRepoAndWorktree({
      "asset-a.bin": "\0base-a",
      "asset-b.bin": "\0base-b",
    });
    await writeFile(join(fixture.worktreePath, "asset-a.bin"), Buffer.from("\0changed-a"));
    await writeFile(join(fixture.worktreePath, "asset-b.bin"), Buffer.from("\0changed-b"));

    const result = await freezeCandidate({
      ...fixture,
      runId: "run-binary-patch",
      writeAllowlist: ["*.bin"],
      forbiddenScope: [],
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.artifact.patch).toContain("diff --git a/asset-a.bin b/asset-a.bin");
      expect(result.artifact.patch).toContain("diff --git a/asset-b.bin b/asset-b.bin");
      expect(result.artifact.patch.match(/\[\[BINARY_PATCH_PAYLOAD_OMITTED\]\]/g)).toHaveLength(2);
      expect(result.artifact.patch).not.toMatch(/\n(?:literal|delta) \d+\n/);
    }
  });

  it("does not run configured textconv drivers while building review patches", async () => {
    const fixture = await initRepoAndWorktree({
      ".gitattributes": "*.bin diff=leak\n",
      "asset.bin": "\0base",
    });
    const converterPath = join(fixture.repoRoot, "..", "textconv.mjs");
    await writeFile(converterPath, [
      'import { readFileSync } from "node:fs";',
      'process.stdout.write(`TEXTCONV_EXECUTED ${readFileSync(process.argv.at(-1)).toString("hex")}\\n`);',
      "",
    ].join("\n"));
    await runGit(fixture.repoRoot, [
      "config",
      "diff.leak.textconv",
      `${JSON.stringify(process.execPath)} ${JSON.stringify(converterPath)}`,
    ]);
    await writeFile(join(fixture.worktreePath, "asset.bin"), Buffer.from("\0changed"));

    const result = await freezeCandidate({
      ...fixture,
      runId: "run-no-textconv",
      writeAllowlist: ["asset.bin"],
      forbiddenScope: [],
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.artifact.patch).not.toContain("TEXTCONV_EXECUTED");
      expect(result.artifact.patch).toContain("[[BINARY_PATCH_PAYLOAD_OMITTED]]");
    }
  });
});
