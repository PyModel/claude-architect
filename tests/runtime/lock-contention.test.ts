import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import nodeProcess from "node:process";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isLockContention } from "../../src/platform/lock-ownership.js";
import { getPlatformServices } from "../../src/platform/select-platform.js";

const execFileAsync = promisify(execFile);

/**
 * A repository lock that times out used to report only "checkout is locked:
 * <path>". Three very different situations produced that identical line: a
 * live sibling session mid-attempt, a lock file leaked by a process that died,
 * and a lock whose record recovery will never clean up. The first resolves
 * itself, the second clears on the next start, and the third needs a human.
 * These tests pin the message down to the distinction.
 */
describe("repository lock contention diagnostics", () => {
  let stateDir: string;
  let checkout: string;
  let previousStateDir: string | undefined;

  const lockPathFor = (repositoryIdentity: string): string =>
    path.join(
      stateDir,
      "locks",
      `${createHash("sha256").update(repositoryIdentity).digest("hex")}.lock`,
    );

  /** The identity acquireCheckoutLock requires: the Git common directory. */
  const identityFor = async (target: string): Promise<string> => {
    const ps = getPlatformServices();
    const canonical = await ps.canonicalizePath(target);
    return canonical.gitCommonDir ?? canonical.canonical;
  };

  const writeLockRecord = async (record: unknown): Promise<void> => {
    const lockPath = lockPathFor(await identityFor(checkout));
    await fs.mkdir(path.dirname(lockPath), { recursive: true });
    await fs.writeFile(lockPath, JSON.stringify(record));
  };

  beforeEach(async () => {
    previousStateDir = nodeProcess.env.CLAUDE_ARCHITECT_STATE_DIR;
    stateDir = await fs.mkdtemp(path.join(tmpdir(), "lock-contention-"));
    nodeProcess.env.CLAUDE_ARCHITECT_STATE_DIR = stateDir;
    checkout = await fs.mkdtemp(path.join(tmpdir(), "lock-checkout-"));
    await execFileAsync("git", ["init", "-q"], { cwd: checkout });
  });

  afterEach(async () => {
    if (previousStateDir === undefined) delete nodeProcess.env.CLAUDE_ARCHITECT_STATE_DIR;
    else nodeProcess.env.CLAUDE_ARCHITECT_STATE_DIR = previousStateDir;
    await fs.rm(stateDir, { recursive: true, force: true });
    await fs.rm(checkout, { recursive: true, force: true });
  });

  it("names the live holder and its run when the lock is genuinely busy", async () => {
    const ps = getPlatformServices();
    const held = await ps.acquireCheckoutLock(checkout, { runId: "run-holder" });
    try {
      await expect(ps.acquireCheckoutLock(checkout)).rejects.toThrow(
        new RegExp(`held by live pid ${nodeProcess.pid}.*run-holder`, "u"),
      );
    } finally {
      await held.release();
    }
  });

  it("reports a leaked lock as reclaimable rather than as a busy peer", async () => {
    // A live pid with a token that does not match the running process is exactly
    // what a recycled pid looks like, and reaches the "dead" branch on every OS
    // without depending on pid-space behaviour that differs across platforms.
    await writeLockRecord({
      pid: nodeProcess.pid,
      processToken: "stale-token-from-a-process-that-exited",
      acquiredAt: new Date().toISOString(),
      runId: "run-that-died",
    });
    const ps = getPlatformServices();
    await expect(ps.acquireCheckoutLock(checkout)).rejects.toThrow(
      /left behind by a process that exited.*startup recovery/u,
    );
  });

  it("says a malformed lock needs a human because recovery preserves it", async () => {
    await writeLockRecord({ pid: nodeProcess.pid });
    const ps = getPlatformServices();
    await expect(ps.acquireCheckoutLock(checkout)).rejects.toThrow(
      /owner cannot be identified.*remove it by hand/u,
    );
  });

  it("still reports what it can from a record written before run correlation", async () => {
    const ps = getPlatformServices();
    const token = await ps.getProcessStartToken(nodeProcess.pid);
    // The pre-correlation record shape: no acquiredAt, no runId.
    await writeLockRecord({ pid: nodeProcess.pid, processToken: token });
    await expect(ps.acquireCheckoutLock(checkout)).rejects.toThrow(
      new RegExp(`checkout is locked.*held by live pid ${nodeProcess.pid}`, "u"),
    );
  });

  it("classifies a timed-out acquisition as contention for callers to branch on", async () => {
    const ps = getPlatformServices();
    const token = await ps.getProcessStartToken(nodeProcess.pid);
    await writeLockRecord({ pid: nodeProcess.pid, processToken: token });
    const error = await ps.acquireCheckoutLock(checkout).then(() => null, (caught: unknown) => caught);
    expect(isLockContention(error)).toBe(true);
  });

  it("never discloses the owner's process token", async () => {
    const ps = getPlatformServices();
    const held = await ps.acquireCheckoutLock(checkout, { runId: "run-secret" });
    try {
      const token = await ps.getProcessStartToken(nodeProcess.pid);
      const error = await ps.acquireCheckoutLock(checkout).catch((thrown: unknown) => thrown);
      expect(error).toBeInstanceOf(Error);
      if (typeof token === "string" && token.length > 0) {
        expect((error as Error).message).not.toContain(token);
      }
    } finally {
      await held.release();
    }
  });
});
