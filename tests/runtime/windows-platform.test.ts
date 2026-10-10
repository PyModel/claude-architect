import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import nodeProcess from "node:process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  canonicalizeForScope,
  WindowsPlatformServices,
} from "../../src/platform/windows-platform-services.js";

describe("canonicalizeForScope (pure, all OSes)", () => {
  it("fails closed for case-distinct paths on case-sensitive Windows directories", () => {
    expect(canonicalizeForScope("C:\\Repo\\SRC\\a.ts", "c:\\repo")).toBe(false);
  });

  it("normalizes drive-letter case without folding case-sensitive path components", () => {
    expect(canonicalizeForScope("C:\\Repo\\src", "c:\\Repo")).toBe(true);
  });

  it("normalizes extended-length UNC roots", () => {
    expect(canonicalizeForScope(
      "\\\\?\\UNC\\server\\share\\Repo\\src",
      "\\\\server\\share\\Repo",
    )).toBe(true);
  });

  it("treats the exactly-cased root itself as in scope", () => {
    expect(canonicalizeForScope("C:\\Repo", "C:\\Repo\\")).toBe(true);
  });

  it("rejects paths outside the root", () => {
    expect(canonicalizeForScope("C:\\Other\\a.ts", "c:\\repo")).toBe(false);
  });

  it("rejects sibling prefixes that are not path boundaries", () => {
    expect(canonicalizeForScope("C:\\Repo2\\a.ts", "c:\\repo")).toBe(false);
  });

  it("supports reciprocal checks for exactly-cased normalized path identity", () => {
    const sameLeft = "C:\\Repo\\SRC\\a.ts";
    const sameRight = "C:\\Repo\\SRC\\a.ts";
    expect(canonicalizeForScope(sameLeft, sameRight)
      && canonicalizeForScope(sameRight, sameLeft)).toBe(true);

    const descendant = "C:\\Repo\\src\\nested\\a.ts";
    expect(canonicalizeForScope(descendant, sameRight)
      && canonicalizeForScope(sameRight, descendant)).toBe(false);
  });
});

describe("WindowsPlatformServices checkout lock contract", () => {
  let stateDir: string;
  let previousStateDir: string | undefined;

  beforeEach(async () => {
    previousStateDir = nodeProcess.env.CLAUDE_ARCHITECT_STATE_DIR;
    stateDir = await mkdtemp(path.join(tmpdir(), "windows-checkout-lock-"));
    nodeProcess.env.CLAUDE_ARCHITECT_STATE_DIR = stateDir;
  });

  afterEach(async () => {
    if (previousStateDir === undefined) delete nodeProcess.env.CLAUDE_ARCHITECT_STATE_DIR;
    else nodeProcess.env.CLAUDE_ARCHITECT_STATE_DIR = previousStateDir;
    await rm(stateDir, { recursive: true, force: true });
  });

  it("refuses a checkout lock when the Git common directory is ambiguous", async () => {
    const ps = Object.assign(new WindowsPlatformServices(), {
      async canonicalizePath(input: string) {
        return { input, canonical: "C:\\repo", gitCommonDir: null };
      },
    });

    await expect(ps.acquireCheckoutLock("C:\\repo")).rejects.toThrow(
      "checkout Git common directory could not be resolved",
    );
  });

  it("returns the canonical repository identity used to derive its lock key", async () => {
    const repositoryIdentity = `C:\\repo\\.git-${randomUUID()}`;
    const ps = Object.assign(new WindowsPlatformServices(), {
      async canonicalizePath(input: string) {
        return { input, canonical: "C:\\repo", gitCommonDir: repositoryIdentity };
      },
      async getProcessStartToken() { return null; },
    });

    const lock = await ps.acquireCheckoutLock("C:\\repo");

    try {
      expect(lock.repositoryIdentity).toBe(repositoryIdentity);
      expect(lock.key).toBe(createHash("sha256").update(repositoryIdentity).digest("hex"));
    } finally {
      await lock.release();
    }
  });

  it("acquires and releases a checkout lock whose owner has no process token", async () => {
    const repositoryIdentity = `C:\\repo\\.git-${randomUUID()}`;
    const ps = Object.assign(new WindowsPlatformServices(), {
      async canonicalizePath(input: string) {
        return { input, canonical: "C:\\repo", gitCommonDir: repositoryIdentity };
      },
      // The native start-token helper is unavailable: the record carries null.
      async getProcessStartToken() { return null; },
    });

    const lock = await ps.acquireCheckoutLock("C:\\repo", { runId: "run-null-token" });
    const lockPath = path.join(stateDir, "locks", `${lock.key}.lock`);
    expect(JSON.parse(await readFile(lockPath, "utf8"))).toMatchObject({
      pid: nodeProcess.pid,
      processToken: null,
      runId: "run-null-token",
    });

    await lock.release();
    await expect(readFile(lockPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe.runIf(process.platform === "win32")("WindowsPlatformServices (win32-gated)", () => {
  const ps = new WindowsPlatformServices();

  it("spawns a node child and captures bounded stdout", async () => {
    const executable = await ps.resolveExecutable({ explicitPath: process.execPath, name: "node" });
    const proc = await ps.spawnSupervised({
      executable,
      args: ["-e", "console.log('hi')"],
      cwd: process.cwd(),
      env: { ...process.env } as Record<string, string>,
      timeoutMs: 1_000,
      maxOutputBytes: 1_024,
      stdin: undefined,
    });
    const exit = await proc.done;
    expect(exit.exitCode).toBe(0);
    expect(exit.stdout.trim()).toBe("hi");
  });

  it("returns a win32 process start token for the current process", async () => {
    const token = await ps.getProcessStartToken(process.pid);
    expect(token).toMatch(/^win32:\d+$/);
  });

  it("creates a writable secure temp directory", async () => {
    const dir = await ps.createSecureTempDirectory();
    expect(dir.length).toBeGreaterThan(0);
  });
});
