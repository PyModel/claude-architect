import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { git, userCommitEnvironment, type GitResult } from "../../src/git/git-exec.js";
import { getPlatformServices } from "../../src/platform/select-platform.js";

const temporaryPaths: string[] = [];

describe("git executable resolution", () => {
  it("resolves once per search environment and re-resolves when PATH changes", async () => {
    // Resolution probes every PATH entry with fs.access, and git is the runtime's
    // hottest subprocess. Caching must still honor a caller that installs a shim.
    const services = getPlatformServices();
    const { repo } = await makeRepo();
    const spy = vi.spyOn(services, "resolveExecutable");
    const originalPath = process.env.PATH;
    try {
      await expectGit(repo, ["rev-parse", "HEAD"]);
      await expectGit(repo, ["rev-parse", "HEAD"]);
      await expectGit(repo, ["status", "--porcelain"]);
      const afterWarmCache = spy.mock.calls.length;

      process.env.PATH = `${path.dirname(process.execPath)}${path.delimiter}${originalPath ?? ""}`;
      await expectGit(repo, ["rev-parse", "HEAD"]);

      expect(afterWarmCache).toBeLessThanOrEqual(1);
      expect(spy.mock.calls.length).toBe(afterWarmCache + 1);
    } finally {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
      spy.mockRestore();
    }
  });
});


function rawGit(cwd: string, args: string[], env: NodeJS.ProcessEnv = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", args, {
      cwd,
      env: {
        PATH: process.env.PATH,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
        ...env,
      },
    }, (error, stdout, stderr) => {
      if (error !== null) reject(new Error(stderr || error.message));
      else resolve(stdout);
    });
  });
}

async function expectGit(cwd: string, args: string[]): Promise<GitResult> {
  const result = await git(cwd, args);
  expect(result.exitCode, result.stderr).toBe(0);
  return result;
}

async function makeRepo(): Promise<{ root: string; repo: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "ca-git-exec-"));
  temporaryPaths.push(root);
  const repo = path.join(root, "repo");
  await mkdir(repo);
  await expectGit(repo, ["init", "-q"]);
  await writeFile(path.join(repo, "base.txt"), "base\n");
  await expectGit(repo, ["add", "base.txt"]);
  await expectGit(repo, ["commit", "-q", "-m", "base"]);
  return { root, repo };
}

afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map(candidate =>
    rm(candidate, { recursive: true, force: true })));
});

describe("git execution hardening", () => {
  it.skipIf(process.platform === "win32")(
    "disables local hooks, fsmonitor, and clean filters in an ordinary repository",
    async () => {
      const fixture = await makeRepo();
      const hookMarker = path.join(fixture.root, "hook-ran");
      const monitorMarker = path.join(fixture.root, "fsmonitor-ran");
      const filterMarker = path.join(fixture.root, "filter-ran");
      const hook = path.join(fixture.repo, ".git", "hooks", "post-checkout");
      const monitor = path.join(fixture.root, "fsmonitor.sh");
      const filter = path.join(fixture.root, "filter.sh");
      await writeFile(hook, `#!/bin/sh\nprintf ran > "${hookMarker}"\n`);
      await writeFile(monitor, `#!/bin/sh\nprintf ran > "${monitorMarker}"\nprintf '0\\0'\n`);
      await writeFile(filter, `#!/bin/sh\nprintf ran > "${filterMarker}"\nprintf transformed\n`);
      await Promise.all([chmod(hook, 0o755), chmod(monitor, 0o755), chmod(filter, 0o755)]);
      await rawGit(fixture.repo, ["config", "core.fsmonitor", monitor]);
      await rawGit(fixture.repo, ["config", "filter.hostile.clean", filter]);
      await rawGit(fixture.repo, ["config", "filter.hostile.required", "true"]);
      await writeFile(path.join(fixture.repo, ".gitattributes"), "payload.txt filter=hostile\n");
      await writeFile(path.join(fixture.repo, "payload.txt"), "original bytes\n");

      await expectGit(fixture.repo, ["status", "--porcelain"]);
      await expectGit(fixture.repo, ["checkout", "-q", "-b", "hardened"]);
      await expectGit(fixture.repo, ["add", ".gitattributes", "payload.txt"]);
      const staged = await expectGit(fixture.repo, ["show", ":payload.txt"]);

      expect(staged.stdout).toBe("original bytes\n");
      await expect(readFile(hookMarker)).rejects.toBeDefined();
      await expect(readFile(monitorMarker)).rejects.toBeDefined();
      await expect(readFile(filterMarker)).rejects.toBeDefined();
    },
  );

  it("ignores host global configuration", async () => {
    const fixture = await makeRepo();
    const globalConfig = path.join(fixture.root, "host.gitconfig");
    await writeFile(globalConfig, "[host]\n\tvalue = leaked\n");
    const previous = process.env.GIT_CONFIG_GLOBAL;
    process.env.GIT_CONFIG_GLOBAL = globalConfig;
    try {
      const result = await git(fixture.repo, ["config", "--get", "host.value"]);
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe("");
    } finally {
      if (previous === undefined) delete process.env.GIT_CONFIG_GLOBAL;
      else process.env.GIT_CONFIG_GLOBAL = previous;
    }
  });

  it.skipIf(process.platform === "win32")("neutralizes a worktree-scoped filter when enabled", async () => {
    const fixture = await makeRepo();
    const marker = path.join(fixture.root, "worktree-filter-ran");
    const filter = path.join(fixture.root, "worktree-filter.sh");
    await writeFile(filter, `#!/bin/sh\nprintf ran > "${marker}"\nprintf transformed\n`);
    await chmod(filter, 0o755);
    await rawGit(fixture.repo, ["config", "extensions.worktreeConfig", "true"]);
    await rawGit(fixture.repo, ["config", "--worktree", "filter.worktree.clean", filter]);
    await rawGit(fixture.repo, ["config", "--worktree", "filter.worktree.required", "true"]);
    await writeFile(path.join(fixture.repo, ".gitattributes"), "payload.txt filter=worktree\n");
    await writeFile(path.join(fixture.repo, "payload.txt"), "worktree bytes\n");

    await expectGit(fixture.repo, ["add", ".gitattributes", "payload.txt"]);
    const staged = await expectGit(fixture.repo, ["show", ":payload.txt"]);

    expect(staged.stdout).toBe("worktree bytes\n");
    await expect(readFile(marker)).rejects.toBeDefined();
  });

  it("fails closed when a filter driver name contains an equals sign", async () => {
    const fixture = await makeRepo();
    const configPath = path.join(fixture.repo, ".git", "config");
    const existing = await readFile(configPath, "utf8");
    await writeFile(configPath, `${existing}\n[filter "bad=name"]\n\tclean = cat\n`);

    const result = await git(fixture.repo, ["status", "--porcelain"]);

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("unsafe Git filter driver name");
  });

  it("applies runtime-supplied config after hardening config", async () => {
    const fixture = await makeRepo();

    const result = await expectGit(fixture.repo, [
      "-c", "core.autocrlf=input", "config", "--get", "core.autocrlf",
    ]);

    expect(result.stdout.trim()).toBe("input");
  });

  it("reports output truncated at a caller-supplied bound", async () => {
    const fixture = await makeRepo();

    const result = await git(fixture.repo, ["show", "HEAD:base.txt"], { maxOutputBytes: 2 });

    expect(result.exitCode).toBe(0);
    expect(result.truncated?.stdout).toBe(true);
  });
});

describe("diff driver suppression", () => {
  it("never runs a configured textconv or external diff bound by in-tree attributes", async () => {
    const { repo } = await makeRepo();
    const marker = path.join(repo, "..", `driver-ran-${path.basename(repo)}`);
    temporaryPaths.push(marker);
    const script = `require('fs').writeFileSync(${JSON.stringify(marker)},'')`;
    await rawGit(repo, ["config", "diff.x.textconv", `"${process.execPath}" -e "${script.replaceAll("\"", "\\\"")}"`]);
    await rawGit(repo, ["config", "diff.x.command", `"${process.execPath}" -e "${script.replaceAll("\"", "\\\"")}"`]);
    await writeFile(path.join(repo, ".gitattributes"), "* diff=x\n");
    await writeFile(path.join(repo, "tracked.txt"), "changed\n");

    for (const args of [
      ["diff"],
      ["-c", "core.quotepath=false", "diff", "HEAD"],
      ["log", "-p", "-1"],
      ["show", "HEAD"],
    ]) {
      const result = await git(repo, args);
      expect(result.exitCode, `${args.join(" ")}: ${result.stderr}`).toBe(0);
    }
    await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" });
  });
});


describe("index listing bound", () => {
  it("lists an index larger than the default output bound in full", async () => {
    const repo = await mkdtemp(path.join(tmpdir(), "ca-git-ls-files-"));
    try {
      expect((await git(repo, ["init", "-q"])).exitCode).toBe(0);
      await writeFile(path.join(repo, "blob"), "x");
      const blob = (await git(repo, ["hash-object", "-w", "blob"])).stdout.trim();
      // Index-only entries with long names: ~9 MB of listing, no files on disk.
      const directory = "d".repeat(200);
      const total = 11_000;
      for (let start = 0; start < total; start += 500) {
        const args = ["update-index", "--add"];
        for (let index = start; index < start + 500; index += 1) {
          args.push("--cacheinfo", `100644,${blob},${directory}/${directory}/${directory}/${directory}/f${index}`);
        }
        expect((await git(repo, args)).exitCode).toBe(0);
      }

      const listed = await git(repo, ["ls-files", "-v", "-z"]);

      expect(listed.truncated?.stdout).toBe(false);
      expect(listed.stdout.length).toBeGreaterThan(8_000_000);
      expect(listed.stdout.split("\0").filter(Boolean)).toHaveLength(total);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  }, 60_000);
});

describe("commit identity", () => {
  it("reads the user's global identity only for promotion commits", async () => {
    const { root, repo } = await makeRepo();
    const home = path.join(root, "home");
    await mkdir(home);
    await writeFile(
      path.join(home, ".gitconfig"),
      "[user]\n\tname = Global Person\n\temail = global@example.invalid\n",
    );
    const saved = Object.fromEntries(
      ["HOME", "XDG_CONFIG_HOME", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM", "GIT_CONFIG_NOSYSTEM"]
        .map(key => [key, process.env[key]]),
    );
    for (const key of Object.keys(saved)) delete process.env[key];
    process.env.HOME = home;
    try {
      const environment = await userCommitEnvironment(repo);
      expect(environment).toMatchObject({
        GIT_AUTHOR_NAME: "Global Person",
        GIT_AUTHOR_EMAIL: "global@example.invalid",
        GIT_COMMITTER_NAME: "Global Person",
        GIT_COMMITTER_EMAIL: "global@example.invalid",
      });
      expect(environment?.GIT_AUTHOR_DATE).toMatch(/^\d+ [+-]\d{4}$/);
      expect(Number(environment!.GIT_AUTHOR_DATE!.split(" ")[0]))
        .toBeGreaterThan(Date.parse("2020-01-01") / 1000);

      const tree = (await expectGit(repo, ["rev-parse", "HEAD^{tree}"])).stdout.trim();
      const promoted = (await git(repo, ["commit-tree", tree, "-m", "promoted"], {
        env: environment!,
      })).stdout.trim();
      expect((await expectGit(repo, ["log", "-1", "--format=%an <%ae>|%cn", promoted])).stdout)
        .toBe("Global Person <global@example.invalid>|Global Person\n");

      // Every other Git call still sees neither global config nor the user.
      const internal = (await expectGit(repo, ["commit-tree", tree, "-m", "internal"])).stdout.trim();
      expect((await expectGit(repo, ["log", "-1", "--format=%an|%ad", "--date=unix", internal])).stdout)
        .toBe("claude-architect|946684800\n");
      expect((await git(repo, ["config", "user.name"])).exitCode).toBe(1);
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it("honors the caller's GIT_CONFIG_GLOBAL when reading the user identity", async () => {
    const { root, repo } = await makeRepo();
    const config = path.join(root, "chosen.gitconfig");
    await writeFile(config, "[user]\n\tname = Chosen Config\n\temail = chosen@example.invalid\n");
    const original = process.env.GIT_CONFIG_GLOBAL;
    process.env.GIT_CONFIG_GLOBAL = config;
    try {
      expect(await userCommitEnvironment(repo)).toMatchObject({
        GIT_AUTHOR_NAME: "Chosen Config",
        GIT_COMMITTER_EMAIL: "chosen@example.invalid",
      });
    } finally {
      if (original === undefined) delete process.env.GIT_CONFIG_GLOBAL;
      else process.env.GIT_CONFIG_GLOBAL = original;
    }
  });

  it("refuses the user-identity mode for anything but git var of an identity", async () => {
    const { repo } = await makeRepo();
    for (const args of [["config", "user.name"], ["var", "GIT_EDITOR"], ["var"]]) {
      const result = await git(repo, args, { userIdentity: true });
      expect(result.exitCode, args.join(" ")).toBe(2);
      expect(result.stderr).toContain("userIdentity");
    }
  });

  it("refuses a machine-guessed identity when none is configured", async () => {
    const { root, repo } = await makeRepo();
    const home = path.join(root, "empty-home");
    await mkdir(home);
    const empty = path.join(root, "empty.gitconfig");
    await writeFile(empty, "");
    const saved = Object.fromEntries(
      ["HOME", "XDG_CONFIG_HOME", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM", "GIT_CONFIG_NOSYSTEM"]
        .map(key => [key, process.env[key]]),
    );
    for (const key of Object.keys(saved)) delete process.env[key];
    process.env.HOME = home;
    process.env.GIT_CONFIG_GLOBAL = empty;
    process.env.GIT_CONFIG_NOSYSTEM = "1";
    try {
      expect(await userCommitEnvironment(repo)).toBeNull();
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it("reports a missing identity instead of inventing one", async () => {
    const result = await userCommitEnvironment("/unused", async () => ({
      stdout: "", stderr: "fatal: unable to auto-detect email address", exitCode: 128,
    }));
    expect(result).toBeNull();
  });
});
