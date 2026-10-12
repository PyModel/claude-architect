import { execFile } from "node:child_process";
import { access, chmod, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  gitChangedFiles,
  gitDiff,
  gitLog,
  gitStatus,
  type GitReadDependencies,
} from "../../src/mcp/git-read-tools.js";
import { scrubbedGitEnv } from "./helpers/git-fixture-env.js";

const temporaryPaths: string[] = [];
const originalGitDir = process.env.GIT_DIR;

function execGit(cwd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd, env: scrubbedGitEnv() }, error => error ? reject(error) : resolve());
  });
}

afterEach(async () => {
  if (originalGitDir === undefined) delete process.env.GIT_DIR;
  else process.env.GIT_DIR = originalGitDir;
  await Promise.all(temporaryPaths.splice(0).map(entry =>
    rm(entry, { recursive: true, force: true })));
});

describe("read-only Git tools", () => {
  it("keeps fixture git operations isolated from an inherited GIT_DIR", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "ca-git-read-isolation-"));
    temporaryPaths.push(root);
    const foreignGitDir = path.join(root, "foreign-gitdir");
    const repo = path.join(root, "repo");
    await mkdir(foreignGitDir);
    await mkdir(repo);
    process.env.GIT_DIR = foreignGitDir;

    await execGit(repo, ["init", "-q"]);
    await execGit(repo, ["config", "user.name", "Test"]);
    await execGit(repo, ["config", "user.email", "test@example.com"]);
    await writeFile(path.join(repo, "tracked.txt"), "fixture content\n", "utf8");
    await execGit(repo, ["add", "tracked.txt"]);
    await execGit(repo, ["commit", "-qm", "fixture isolation commit"]);

    await expect(access(path.join(repo, ".git"))).resolves.toBeUndefined();
    await expect(gitLog(repo)).resolves.toMatchObject({
      ok: true,
      output: expect.stringContaining("fixture isolation commit"),
    });
  }, 30_000);

  it("returns redacted status, diff, log, and changed-file observations", async () => {
    const secret = "sk-12345678advisor";
    const root = await mkdtemp(path.join(tmpdir(), "ca-git-read-"));
    temporaryPaths.push(root);
    const repo = path.join(root, "repo");
    await mkdir(repo);
    await execGit(repo, ["init", "-q"]);
    await execGit(repo, ["config", "user.name", "Test"]);
    await execGit(repo, ["config", "user.email", "test@example.com"]);
    await writeFile(path.join(repo, "tracked.txt"), "initial\n", "utf8");
    await execGit(repo, ["add", "tracked.txt"]);
    await execGit(repo, ["commit", "-qm", `initial ${secret}`]);
    await writeFile(path.join(repo, "tracked.txt"), `token=${secret}\n`, "utf8");
    await writeFile(path.join(repo, `${secret}.txt`), "new\n", "utf8");
    await execGit(repo, ["add", "tracked.txt", `${secret}.txt`]);

    const outputs = await Promise.all([
      gitStatus(repo),
      gitDiff(repo),
      gitLog(repo),
      gitChangedFiles(repo),
    ]);

    for (const output of outputs) {
      expect(output.ok).toBe(true);
      expect("output" in output ? output.output : "").toContain("[k]");
      expect(JSON.stringify(output)).not.toContain(secret);
    }
  });

  it.skipIf(process.platform === "win32")(
    "does not execute a repository-configured fsmonitor hook",
    async () => {
      const root = await mkdtemp(path.join(tmpdir(), "ca-git-read-fsmonitor-"));
      temporaryPaths.push(root);
      const repo = path.join(root, "repo");
      const marker = path.join(root, "fsmonitor-ran");
      const hook = path.join(root, "fsmonitor.sh");
      await mkdir(repo);
      await execGit(repo, ["init", "-q"]);
      await execGit(repo, ["config", "user.name", "Test"]);
      await execGit(repo, ["config", "user.email", "test@example.com"]);
      await writeFile(path.join(repo, "tracked.txt"), "initial\n", "utf8");
      await execGit(repo, ["add", "tracked.txt"]);
      await execGit(repo, ["commit", "-qm", "initial"]);
      await writeFile(hook, `#!/bin/sh\n: > ${JSON.stringify(marker)}\n`, "utf8");
      await chmod(hook, 0o755);
      await execGit(repo, ["config", "core.fsmonitor", hook]);
      await writeFile(path.join(repo, "tracked.txt"), "changed\n", "utf8");

      await expect(gitStatus(repo)).resolves.toMatchObject({ ok: true });
      await expect(access(marker)).rejects.toThrow();
    },
  );

  it("uses only fixed argv and fails closed when output is truncated", async () => {
    const calls: string[][] = [];
    const deps: GitReadDependencies = {
      ps: {
        os: "darwin",
        canonicalizePath: async input => ({ input, canonical: "/canonical/repo", gitCommonDir: null }),
      } as NonNullable<GitReadDependencies["ps"]>,
      git: async (cwd, args) => {
        expect(cwd).toBe("/canonical/repo");
        calls.push(args);
        return args.includes("--full-index")
          ? {
            stdout: "partial",
            stderr: "",
            exitCode: 0,
            truncated: { stdout: true, stderr: false },
          }
          : { stdout: "ok", stderr: "", exitCode: 0 };
      },
    };

    await expect(gitStatus("/repo", deps)).resolves.toEqual({ ok: true, output: "ok" });
    await expect(gitDiff("/repo", deps)).resolves.toEqual({
      ok: false,
      error: "git-read-failed",
      diagnostic: "Git output exceeded the capture limit",
    });
    await expect(gitLog("/repo", deps)).resolves.toEqual({ ok: true, output: "ok" });
    await expect(gitChangedFiles("/repo", deps)).resolves.toEqual({ ok: true, output: "ok" });

    expect(calls).toEqual([
      ["--no-optional-locks", "-c", "core.fsmonitor=false", "--no-pager", "status", "--porcelain=v1", "--branch", "--untracked-files=all"],
      ["--no-optional-locks", "-c", "core.fsmonitor=false", "--no-pager", "diff", "--no-ext-diff", "--no-textconv", "--no-color", "--full-index", "HEAD", "--"],
      ["--no-optional-locks", "-c", "core.fsmonitor=false", "--no-pager", "log", "-n", "20", "--no-color", "--format=%H%x09%aI%x09%s", "--"],
      ["--no-optional-locks", "-c", "core.fsmonitor=false", "--no-pager", "diff", "--no-ext-diff", "--no-textconv", "--no-color", "--name-status", "HEAD", "--"],
    ]);
  });
});
