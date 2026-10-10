import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { link, mkdir, mkdtemp, open, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import nodeProcess from "node:process";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CHECKOUT_LOCK_NAME_PATTERN,
  formatLockRecord,
  isCheckoutLockFileName,
  lockFileName,
  lockFilePath,
  lockIsOwnedByLiveProcess,
  lockKeyFromFileName,
  lockOwnerStatus,
  parseLockOwner,
  parseLockRecord,
  reclaimDeadCheckoutLocks,
  reclaimDeadLock,
  type LockOwner,
  type LockRecord,
} from "../../src/platform/lock-ownership.js";
import { getPlatformServices } from "../../src/platform/select-platform.js";
import { logger } from "../../src/util/logger.js";
import { acquireLock, tryAcquireLockReclaimingDead } from "../../src/platform/checkout-lock.js";

// A passthrough of node:fs/promises whose link() can be armed to fail once with
// a chosen errno, the way an antivirus scan briefly holds a file on Windows.
const linkFault = vi.hoisted(() => ({ code: null as string | null, fired: 0 }));
vi.mock("node:fs/promises", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    async link(source: string, destination: string) {
      if (linkFault.code !== null) {
        const code = linkFault.code;
        linkFault.code = null;
        linkFault.fired += 1;
        throw Object.assign(new Error(`${code}: injected link failure`), { code });
      }
      return actual.link(source, destination);
    },
  };
});

const execFileAsync = promisify(execFile);

describe("LockOwnership", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), "lock-ownership-test-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  describe("naming and patterns", () => {
    it("recognizes valid checkout lock names and extracts keys", () => {
      const key = createHash("sha256").update("repo-identity").digest("hex");
      const name = `${key}.lock`;
      expect(CHECKOUT_LOCK_NAME_PATTERN.test(name)).toBe(true);
      expect(isCheckoutLockFileName(name)).toBe(true);
      expect(lockKeyFromFileName(name)).toBe(key);
      expect(lockFileName(key)).toBe(name);
      expect(lockFilePath(key, tempDir)).toBe(path.join(tempDir, "locks", name));
    });

    it("rejects non-checkout lock names", () => {
      expect(isCheckoutLockFileName("recovery.lock")).toBe(false);
      expect(isCheckoutLockFileName("1234.lock")).toBe(false);
      expect(isCheckoutLockFileName("something.json")).toBe(false);
      expect(lockKeyFromFileName("recovery.lock")).toBeNull();
    });
  });

  describe("record formatting and parsing", () => {
    it("formats and parses full lock record", () => {
      const record: LockRecord = {
        pid: 12345,
        processToken: "token-abc-123",
        acquiredAt: new Date().toISOString(),
        runId: "run-001",
      };
      const formatted = formatLockRecord(record);
      const parsed = parseLockRecord(formatted);
      expect(parsed).toEqual(record);
    });

    it("parses record without runId", () => {
      const json = JSON.stringify({
        pid: 9999,
        processToken: "tok",
        acquiredAt: "2026-01-01T00:00:00.000Z",
      });
      const parsed = parseLockRecord(json);
      expect(parsed).toEqual({
        pid: 9999,
        processToken: "tok",
        acquiredAt: "2026-01-01T00:00:00.000Z",
        runId: undefined,
      });
    });

    it("rejects malformed records", () => {
      expect(parseLockRecord("not json")).toBeNull();
      expect(parseLockRecord("null")).toBeNull();
      expect(parseLockRecord("123")).toBeNull();
      expect(parseLockRecord(JSON.stringify({ pid: "not-a-number" }))).toBeNull();
      expect(parseLockRecord(JSON.stringify({ pid: 1 }))).toBeNull(); // init PID
      expect(parseLockRecord(JSON.stringify({ pid: 0 }))).toBeNull();
      expect(parseLockRecord(JSON.stringify({ pid: -5 }))).toBeNull();
    });

    it("extracts verifiable LockOwner", () => {
      const valid = JSON.stringify({ pid: 54321, processToken: "tok-1" });
      expect(parseLockOwner(valid)).toEqual({ pid: 54321, processToken: "tok-1" });

      const missingToken = JSON.stringify({ pid: 54321, processToken: "" });
      expect(parseLockOwner(missingToken)).toBeNull();

      const nullToken = JSON.stringify({ pid: 54321, processToken: null });
      expect(parseLockOwner(nullToken)).toBeNull();
    });
  });

  describe("liveness verdict (PID birth-tokens)", () => {
    it("reports dead when owner is null", async () => {
      const status = await lockOwnerStatus(null, () => true, async () => "token");
      expect(status).toBe("dead");
    });

    it("reports dead when process is not alive", async () => {
      const owner: LockOwner = { pid: 99999, processToken: "my-token" };
      const status = await lockOwnerStatus(owner, () => false, async () => "my-token");
      expect(status).toBe("dead");
    });

    it("reports unverifiable when processToken in record is null", async () => {
      const status = await lockOwnerStatus(
        { pid: 1234, processToken: null },
        () => true,
        async () => "live-token",
      );
      expect(status).toBe("unverifiable");
    });

    it("reports unverifiable when current process token cannot be obtained", async () => {
      const owner: LockOwner = { pid: 1234, processToken: "my-token" };
      const status = await lockOwnerStatus(owner, () => true, async () => null);
      expect(status).toBe("unverifiable");
    });

    it("reports live when live process token matches record", async () => {
      const owner: LockOwner = { pid: 1234, processToken: "darwin:Mon Jan 1 00:00:00 2026" };
      const status = await lockOwnerStatus(
        owner,
        () => true,
        async pid => (pid === 1234 ? "darwin:Mon Jan 1 00:00:00 2026" : null),
      );
      expect(status).toBe("live");
    });

    it("reports dead when PID is alive but birth token does not match (recycled PID)", async () => {
      const owner: LockOwner = { pid: 1234, processToken: "darwin:old-process-start" };
      const status = await lockOwnerStatus(
        owner,
        () => true,
        async pid => (pid === 1234 ? "darwin:recycled-pid-new-start" : null),
      );
      expect(status).toBe("dead");
    });
  });

  describe("reclaim rules", () => {
    it("returns contended if lock file does not exist", async () => {
      const missingPath = path.join(tempDir, "missing.lock");
      const result = await reclaimDeadLock(missingPath, () => false, async () => null);
      expect(result).toBe("contended");
    });

    it("logs warning and preserves malformed lock file", async () => {
      const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
      const malformedPath = path.join(tempDir, "bad.lock");
      await writeFile(malformedPath, "not valid json\n");

      const result = await reclaimDeadLock(malformedPath, () => false, async () => null);
      expect(result).toBe("malformed");
      expect(warnSpy).toHaveBeenCalledWith(
        "startup recovery preserved malformed lock",
        expect.objectContaining({ event: "recovery-malformed-lock" }),
      );
    });

    it("logs warning and preserves unverifiable lock file", async () => {
      const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
      const unverifiablePath = path.join(tempDir, "unverifiable.lock");
      await writeFile(
        unverifiablePath,
        JSON.stringify({ pid: nodeProcess.pid, processToken: "token" }),
      );

      const result = await reclaimDeadLock(
        unverifiablePath,
        () => true,
        async () => null, // token lookup unavailable
      );
      expect(result).toBe("unverifiable");
      expect(warnSpy).toHaveBeenCalledWith(
        "startup recovery preserved unverifiable lock",
        expect.objectContaining({ event: "recovery-unverifiable-lock" }),
      );
    });

    it("returns live when process is live and token matches", async () => {
      const livePath = path.join(tempDir, "live.lock");
      await writeFile(
        livePath,
        JSON.stringify({ pid: 5555, processToken: "token-5555" }),
      );

      const result = await reclaimDeadLock(
        livePath,
        pid => pid === 5555,
        async pid => (pid === 5555 ? "token-5555" : null),
      );
      expect(result).toBe("live");
    });

    it("safely removes dead lock file and reports reclaimed", async () => {
      const deadPath = path.join(tempDir, "dead.lock");
      await writeFile(
        deadPath,
        JSON.stringify({ pid: 9999, processToken: "token-9999" }),
      );

      const result = await reclaimDeadLock(
        deadPath,
        () => false, // process is dead
        async () => null,
      );
      expect(result).toBe("reclaimed");

      // Verify file was unlinked
      await expect(open(deadPath, "r")).rejects.toThrow();
    });

    it("reclaimDeadCheckoutLocks cleans all dead checkout locks in directory", async () => {
      const locksDir = path.join(tempDir, "locks");
      await mkdir(locksDir);

      const deadKey = createHash("sha256").update("dead-repo").digest("hex");
      const liveKey = createHash("sha256").update("live-repo").digest("hex");

      const deadPath = path.join(locksDir, `${deadKey}.lock`);
      const livePath = path.join(locksDir, `${liveKey}.lock`);

      await writeFile(deadPath, JSON.stringify({ pid: 1111, processToken: "dead-tok" }));
      await writeFile(livePath, JSON.stringify({ pid: 2222, processToken: "live-tok" }));

      await reclaimDeadCheckoutLocks(
        locksDir,
        pid => pid === 2222,
        async pid => (pid === 2222 ? "live-tok" : null),
      );

      await expect(open(deadPath, "r")).rejects.toThrow();
      await expect(open(livePath, "r")).resolves.toBeDefined();
    });

    it("lockIsOwnedByLiveProcess returns false only when owner is proven dead", async () => {
      const locksDir = path.join(tempDir, "locks");
      await mkdir(locksDir, { recursive: true });

      const deadKey = createHash("sha256").update("dead").digest("hex");
      const liveKey = createHash("sha256").update("live").digest("hex");
      const malformedKey = createHash("sha256").update("malformed").digest("hex");

      await writeFile(path.join(locksDir, `${deadKey}.lock`), JSON.stringify({ pid: 1, processToken: "tok" })); // PID 1 is dead/invalid
      await writeFile(path.join(locksDir, `${liveKey}.lock`), JSON.stringify({ pid: 2222, processToken: "tok" }));
      await writeFile(path.join(locksDir, `${malformedKey}.lock`), "bad");

      const isDead = await lockIsOwnedByLiveProcess(
        locksDir,
        deadKey,
        () => false,
        async () => null,
      );
      expect(isDead).toBe(true); // invalid owner is preserved, so returns true

      const realDeadKey = createHash("sha256").update("real-dead").digest("hex");
      await writeFile(path.join(locksDir, `${realDeadKey}.lock`), JSON.stringify({ pid: 8888, processToken: "tok" }));
      const deadResult = await lockIsOwnedByLiveProcess(
        locksDir,
        realDeadKey,
        () => false,
        async () => null,
      );
      expect(deadResult).toBe(false);

      const liveResult = await lockIsOwnedByLiveProcess(
        locksDir,
        liveKey,
        () => true,
        async () => "tok",
      );
      expect(liveResult).toBe(true);
    });
  });

  describe("crash after publish, before temporary cleanup", () => {
    // tryAcquireLock links its temporary record into place and only then
    // unlinks the temporary, so a crash between the two leaves the lock with
    // two links: <key>.lock and its .recovery-lock-<uuid>.tmp sibling.
    async function crashedLock(record: { pid: number; processToken: string }) {
      const locksDir = path.join(tempDir, "locks");
      await mkdir(locksDir);
      const key = createHash("sha256").update("crashed-repo").digest("hex");
      const lockPath = path.join(locksDir, `${key}.lock`);
      const temporaryPath = path.join(
        locksDir,
        ".recovery-lock-0b8e8a3c-6f1d-4c6e-9a51-2f4c1d7e9b10.tmp",
      );
      await writeFile(temporaryPath, formatLockRecord({ ...record, acquiredAt: new Date(0).toISOString() }));
      await link(temporaryPath, lockPath);
      return { locksDir, lockPath, temporaryPath };
    }

    it("reclaims a dead holder's two-link lock and the next acquisition succeeds", async () => {
      const { locksDir, lockPath } = await crashedLock({ pid: 7777, processToken: "dead-tok" });
      // Orphans of other crashed acquisitions are separate files and stay put.
      const orphans = ["00000000", "ffffffff"].map(prefix =>
        path.join(locksDir, `.recovery-lock-${prefix}-2222-4333-8444-555555555555.tmp`));
      for (const orphan of orphans) await writeFile(orphan, await readFile(lockPath));
      const contents = Buffer.from(formatLockRecord({
        pid: nodeProcess.pid,
        processToken: "next-tok",
        acquiredAt: new Date().toISOString(),
      }));

      const { lock, holder } = await tryAcquireLockReclaimingDead(
        lockPath,
        contents,
        () => false,
        async () => null,
      );

      expect(holder).toBe("reclaimed");
      expect(lock).not.toBeNull();
      expect(await readFile(lockPath)).toEqual(contents);
      expect((await readdir(locksDir)).sort()).toEqual(
        [...orphans.map(orphan => path.basename(orphan)), path.basename(lockPath)].sort(),
      );
    });

    it("never reclaims a live holder's lock in the same two-link state", async () => {
      const { lockPath, temporaryPath } = await crashedLock({ pid: 5555, processToken: "live-tok" });
      const before = await readFile(lockPath);

      const result = await reclaimDeadLock(
        lockPath,
        pid => pid === 5555,
        async pid => (pid === 5555 ? "live-tok" : null),
      );

      expect(result).toBe("live");
      expect(await readFile(lockPath)).toEqual(before);
      expect(await readFile(temporaryPath)).toEqual(before);
    });

    it("stays contended when the lock has a link beyond its temporary sibling", async () => {
      const { locksDir, lockPath, temporaryPath } = await crashedLock({ pid: 7777, processToken: "dead-tok" });
      await link(lockPath, path.join(locksDir, "operator-alias"));

      const result = await reclaimDeadLock(lockPath, () => false, async () => null);

      expect(result).toBe("contended");
      expect(await readFile(temporaryPath)).toEqual(await readFile(lockPath));
    });

    it("stays contended when the second link is not a temporary sibling", async () => {
      const { locksDir, lockPath, temporaryPath } = await crashedLock({ pid: 7777, processToken: "dead-tok" });
      const aliasPath = path.join(locksDir, "operator-alias");
      await rm(temporaryPath);
      await link(lockPath, aliasPath);
      // Same name shape and bytes, but a different file: never the lock's link.
      const unrelatedPath = path.join(locksDir, ".recovery-lock-11111111-2222-4333-8444-555555555555.tmp");
      await writeFile(unrelatedPath, await readFile(lockPath));

      const result = await reclaimDeadLock(lockPath, () => false, async () => null);

      expect(result).toBe("contended");
      expect(await readFile(lockPath)).toEqual(await readFile(aliasPath));
      expect(await readFile(unrelatedPath)).toEqual(await readFile(lockPath));
    });
  });

  describe("checkout lock release", () => {
    let previousStateDir: string | undefined;
    let checkout: string;

    beforeEach(async () => {
      previousStateDir = nodeProcess.env.CLAUDE_ARCHITECT_STATE_DIR;
      nodeProcess.env.CLAUDE_ARCHITECT_STATE_DIR = path.join(tempDir, "state");
      checkout = path.join(tempDir, "checkout");
      await mkdir(checkout);
      await execFileAsync("git", ["init", "-q"], { cwd: checkout });
    });

    afterEach(() => {
      if (previousStateDir === undefined) delete nodeProcess.env.CLAUDE_ARCHITECT_STATE_DIR;
      else nodeProcess.env.CLAUDE_ARCHITECT_STATE_DIR = previousStateDir;
    });

    it("leaves another holder's lock in place when the released lock file was replaced", async () => {
      const ps = getPlatformServices();
      const first = await ps.acquireCheckoutLock(checkout, { runId: "run-first" });
      const lockPath = path.join(tempDir, "state", "locks", `${first.key}.lock`);
      // The first holder's file disappears (an operator or a reclaim removed it)
      // and a second holder in the same process publishes its own lock.
      await rm(lockPath);
      const second = await ps.acquireCheckoutLock(checkout, { runId: "run-second" });
      const successorRecord = await readFile(lockPath, "utf8");

      await first.release();

      expect(await readFile(lockPath, "utf8")).toBe(successorRecord);
      await second.release();
      await expect(readFile(lockPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  describe("transient acquisition errors", () => {
    let previousStateDir: string | undefined;

    beforeEach(() => {
      previousStateDir = nodeProcess.env.CLAUDE_ARCHITECT_STATE_DIR;
      nodeProcess.env.CLAUDE_ARCHITECT_STATE_DIR = path.join(tempDir, "state");
      linkFault.code = null;
      linkFault.fired = 0;
    });

    afterEach(() => {
      linkFault.code = null;
      if (previousStateDir === undefined) delete nodeProcess.env.CLAUDE_ARCHITECT_STATE_DIR;
      else nodeProcess.env.CLAUDE_ARCHITECT_STATE_DIR = previousStateDir;
    });

    for (const code of ["EPERM", "EBUSY", "EACCES"]) {
      it(`retries a transient Windows ${code} and acquires within the deadline`, async () => {
        const key = createHash("sha256").update(`transient-${code}`).digest("hex");
        linkFault.code = code;
        const started = Date.now();

        const lock = await acquireLock(key, { platform: "win32" });

        expect(linkFault.fired).toBe(1);
        expect(Date.now() - started).toBeLessThan(15_000);
        const lockPath = path.join(tempDir, "state", "locks", `${key}.lock`);
        expect(parseLockRecord(await readFile(lockPath, "utf8"))?.pid).toBe(nodeProcess.pid);
        await lock.release();
        await expect(readFile(lockPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
      });
    }

    it("does not retry the same error off Windows, where it is not transient", async () => {
      const key = createHash("sha256").update("transient-posix").digest("hex");
      linkFault.code = "EACCES";

      await expect(acquireLock(key, { platform: "linux" })).rejects.toMatchObject({ code: "EACCES" });
      expect(linkFault.fired).toBe(1);
      const locks = await readdir(path.join(tempDir, "state", "locks"));
      expect(locks).toEqual([]);
    });
  });
});
