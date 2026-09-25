import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DurableDirectorySession,
  openDurableDirectorySession,
  writeAtomic,
} from "../../src/platform/durable-write.js";

describe("PlatformSafety durable-write", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await mkdtemp(path.join(tmpdir(), "ca-durable-write-"));
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("writes atomically in immutable mode and allows identical retry", async () => {
    const session = await openDurableDirectorySession(testDir);
    try {
      await writeAtomic(session, "artifact.json", '{"data":1}', "immutable");
      const read = await readFile(path.join(testDir, "artifact.json"), "utf8");
      expect(read).toBe('{"data":1}');

      // Identical retry succeeds
      await expect(
        writeAtomic(session, "artifact.json", '{"data":1}', "immutable"),
      ).resolves.toBeUndefined();

      // Conflicting retry fails
      await expect(
        writeAtomic(session, "artifact.json", '{"data":2}', "immutable"),
      ).rejects.toThrow("archive entry already exists with different content");
    } finally {
      await session.close();
    }
  });

  it.skipIf(process.platform === "win32")(
    "refuses a symlink planted where an immutable record belongs",
    async () => {
      const outside = path.join(testDir, "outside.json");
      await writeFile(outside, '{"data":1}');
      await symlink(outside, path.join(testDir, "artifact.json"));
      const session = await openDurableDirectorySession(testDir);
      try {
        // Identical bytes behind the link must not count as the record.
        await expect(writeAtomic(session, "artifact.json", '{"data":1}', "immutable"))
          .rejects.toThrow("archive entry is not a plain file");
      } finally {
        await session.close();
      }
    },
  );

  it("writes atomically in replace mode", async () => {
    const session = await openDurableDirectorySession(testDir);
    try {
      await writeAtomic(session, "status.json", '{"phase":"preflight"}', "replace");
      expect(await readFile(path.join(testDir, "status.json"), "utf8")).toBe('{"phase":"preflight"}');

      await writeAtomic(session, "status.json", '{"phase":"implementing"}', "replace");
      expect(await readFile(path.join(testDir, "status.json"), "utf8")).toBe('{"phase":"implementing"}');
    } finally {
      await session.close();
    }
  });

  it("rejects non-safe or path-traversal target names", async () => {
    const session = await openDurableDirectorySession(testDir);
    try {
      await expect(writeAtomic(session, "../escape", "text", "replace")).rejects.toThrow("safe leaf name");
      await expect(writeAtomic(session, "sub/dir", "text", "replace")).rejects.toThrow("safe leaf name");
      await expect(writeAtomic(session, "/root", "text", "replace")).rejects.toThrow("safe leaf name");
    } finally {
      await session.close();
    }
  });

  it("cleans up temporary files when write or sync crashes before completion", async () => {
    const session = await openDurableDirectorySession(testDir, {
      policy: {
        syncDirectory: async () => {
          throw new Error("simulated directory sync crash");
        },
      },
    });

    try {
      await expect(
        writeAtomic(session, "crash-test.txt", "payload", "replace"),
      ).rejects.toThrow("simulated directory sync crash");

      // Destination was renamed before sync error, but NO temporary files remain leaked
      const files = await readdir(testDir);
      const tempFiles = files.filter(f => f.startsWith("."));
      expect(tempFiles).toEqual([]);
    } finally {
      await session.close();
    }
  });

  it("detects directory identity tampering through session", async () => {
    const session = new DurableDirectorySession(testDir, {
      dev: 999999n,
      ino: 999999n,
      birthtimeNs: 999999n,
    });

    await expect(writeAtomic(session, "tamper.txt", "data", "replace")).rejects.toThrow(
      "durable directory session identity changed",
    );
  });

  it("rejects operations after session is closed", async () => {
    const session = await openDurableDirectorySession(testDir);
    await session.close();

    await expect(session.assertIdentity()).rejects.toThrow("durable directory session is closed");
    await expect(session.sync()).rejects.toThrow("durable directory session is closed");
  });
});
