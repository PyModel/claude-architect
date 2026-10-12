import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
  type FileHandle,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DurableDirectorySession,
  appendDurable,
  linkExclusive,
  moveDirectory,
  openDurableDirectorySession,
  publishExclusive,
  writeAtomic,
} from "../../src/platform/durable-write.js";
import { RuntimeError } from "../../src/util/errors.js";

// Pass-through: one test swaps the temp file the moment its handle closes,
// standing in for a same-user writer racing the publish.
vi.mock("node:fs/promises", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, open: vi.fn(actual.open), rm: vi.fn(actual.rm) };
});

const actualFs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");

function substituteTemporaryOnClose(): { displaced: string[] } {
  const displaced: string[] = [];
  vi.mocked(open).mockImplementationOnce(async (...args: Parameters<typeof open>) => {
    const handle: FileHandle = await actualFs.open(...args);
    const close = handle.close.bind(handle);
    handle.close = async () => {
      await close();
      const temporaryPath = String(args[0]);
      const aside = `${temporaryPath}.displaced`;
      await actualFs.rename(temporaryPath, aside);
      displaced.push(aside);
      await actualFs.copyFile(aside, temporaryPath);
    };
    return handle;
  });
  return { displaced };
}

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
      // A dot-leading record would share the namespace of the write temporaries.
      await expect(writeAtomic(session, ".hidden", "text", "replace")).rejects.toThrow("safe leaf name");
      await expect(publishExclusive(session, ".hidden", "text")).rejects.toThrow("safe leaf name");
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

  it("refuses a directory with a real birth time when the recorded birth time is zero (o-5)", async (context) => {
    const metadata = await lstat(testDir, { bigint: true });
    // A filesystem without birth times has nothing to mismatch: report a skip, not a pass.
    context.skip(metadata.birthtimeNs <= 0n, "filesystem records no birth time");
    const session = new DurableDirectorySession(testDir, {
      dev: metadata.dev,
      ino: metadata.ino,
      birthtimeNs: 0n,
    });
    try {
      await expect(session.assertIdentity()).rejects.toThrow(
        "durable directory session identity changed",
      );
    } finally {
      await session.close();
    }
  });

  it("rejects operations after session is closed", async () => {
    const session = await openDurableDirectorySession(testDir);
    await session.close();

    await expect(session.assertIdentity()).rejects.toThrow("durable directory session is closed");
    await expect(session.sync()).rejects.toThrow("durable directory session is closed");
  });

  it.each(["replace", "immutable"] as const)(
    "refuses a temp substituted before %s publish and keeps the previous record",
    async (mode) => {
      await writeFile(path.join(testDir, "state.json"), "previous");
      const session = await openDurableDirectorySession(testDir);
      try {
        const { displaced } = substituteTemporaryOnClose();
        await expect(writeAtomic(session, "state.json", "next", mode))
          .rejects.toThrow("atomic write temporary file changed before publish");
        expect(displaced).toHaveLength(1);
        await rm(displaced[0]!);
      } finally {
        await session.close();
      }
      expect(await readFile(path.join(testDir, "state.json"), "utf8")).toBe("previous");
      expect(await readdir(testDir)).toEqual(["state.json"]);
    },
  );

  it("reports a failed temp removal alongside the primary failure", async () => {
    const session = await openDurableDirectorySession(testDir);
    try {
      const { displaced } = substituteTemporaryOnClose();
      const removal = new Error("simulated temp removal failure");
      vi.mocked(rm).mockImplementationOnce(async () => {
        throw removal;
      });
      const failure = await writeAtomic(session, "state.json", "next", "replace").then(
        () => undefined,
        (error: unknown) => error,
      );
      // A refused-write classifier (instanceof RuntimeError) must still see the refusal.
      expect(failure).toBeInstanceOf(RuntimeError);
      expect((failure as { errors?: unknown }).errors).toHaveLength(2);
      const [primary, cleanup] = (failure as unknown as { errors: unknown[] }).errors;
      expect((primary as Error).message).toContain("atomic write temporary file changed before publish");
      expect(cleanup).toBe(removal);
      expect((failure as Error).message).toContain("atomic write temporary file changed before publish");
      for (const leftover of await readdir(testDir)) await rm(path.join(testDir, leftover));
      expect(displaced).toHaveLength(1);
    } finally {
      await session.close();
    }
  });

  describe("appendDurable", () => {
    it("appends the bytes and flushes the directory after the write", async () => {
      const journal = path.join(testDir, "journal.ndjson");
      const seenAtSync: string[] = [];
      const session = await openDurableDirectorySession(testDir, {
        policy: {
          syncDirectory: async () => {
            seenAtSync.push(await readFile(journal, "utf8"));
          },
        },
      });
      try {
        await appendDurable(session, "journal.ndjson", "one\n");
        await appendDurable(session, "journal.ndjson", Buffer.from("two\n"), { expectedSize: 4 });
      } finally {
        await session.close();
      }
      expect(seenAtSync).toEqual(["one\n", "one\ntwo\n"]);
      expect(await readFile(journal, "utf8")).toBe("one\ntwo\n");
    });

    it("refuses to append when the directory was replaced at the same path", async () => {
      const directory = path.join(testDir, "journal-dir");
      await mkdir(directory);
      const session = await openDurableDirectorySession(directory);
      try {
        await rename(directory, path.join(testDir, "displaced"));
        await mkdir(directory);
        await expect(appendDurable(session, "journal.ndjson", "line\n"))
          .rejects.toThrow("durable directory session identity changed");
        expect(await readdir(directory)).toEqual([]);
      } finally {
        await session.close();
      }
    });

    it("refuses and writes nothing when the directory is swapped at the append's own open", async () => {
      const directory = path.join(testDir, "journal-dir");
      const displaced = path.join(testDir, "displaced");
      await mkdir(directory);
      const session = await openDurableDirectorySession(directory);
      const journal = path.join(directory, "journal.ndjson");
      let swapped = false;
      // The pre-open identity check has already passed when open is called, so
      // only the post-open re-check can catch this swap.
      vi.mocked(open).mockImplementationOnce(async (...args: Parameters<typeof open>) => {
        swapped = true;
        await actualFs.rename(directory, displaced);
        await actualFs.mkdir(directory);
        return actualFs.open(...args);
      });
      try {
        await expect(appendDurable(session, "journal.ndjson", "line\n"))
          .rejects.toThrow("durable directory session identity changed");
        expect(swapped).toBe(true);
        expect(String(vi.mocked(open).mock.calls.at(-1)?.[0])).toBe(journal);
        expect(await readFile(journal, "utf8")).toBe("");
        expect(await readdir(displaced)).toEqual([]);
      } finally {
        await session.close();
      }
    });

    it("refuses to append when the file size is not the expected size", async () => {
      await writeFile(path.join(testDir, "journal.ndjson"), "abc");
      const session = await openDurableDirectorySession(testDir);
      try {
        await expect(appendDurable(session, "journal.ndjson", "x", { expectedSize: 2 }))
          .rejects.toThrow("durable append target changed");
        expect(await readFile(path.join(testDir, "journal.ndjson"), "utf8")).toBe("abc");
      } finally {
        await session.close();
      }
    });

    it.skipIf(process.platform === "win32")("refuses to append through a symlink", async () => {
      const outside = path.join(testDir, "outside.ndjson");
      await writeFile(outside, "");
      const directory = path.join(testDir, "journal-dir");
      await mkdir(directory);
      await symlink(outside, path.join(directory, "journal.ndjson"));
      const session = await openDurableDirectorySession(directory);
      try {
        await expect(appendDurable(session, "journal.ndjson", "line\n")).rejects.toBeDefined();
        expect(await readFile(outside, "utf8")).toBe("");
      } finally {
        await session.close();
      }
    });
  });

  describe("publishExclusive", () => {
    it("publishes a new record durably and leaves no temporary file", async () => {
      const session = await openDurableDirectorySession(testDir);
      try {
        await publishExclusive(session, "owner.json", '{"owner":1}');
      } finally {
        await session.close();
      }
      expect(await readFile(path.join(testDir, "owner.json"), "utf8")).toBe('{"owner":1}');
      expect((await lstat(path.join(testDir, "owner.json"))).nlink).toBe(1);
      expect(await readdir(testDir)).toEqual(["owner.json"]);
    });

    it("refuses to overwrite an existing destination and leaves no temporary file behind", async () => {
      await writeFile(path.join(testDir, "owner.json"), '{"owner":"first"}');
      const session = await openDurableDirectorySession(testDir);
      try {
        await expect(publishExclusive(session, "owner.json", '{"owner":"second"}'))
          .rejects.toMatchObject({ code: "EEXIST" });
      } finally {
        await session.close();
      }
      expect(await readFile(path.join(testDir, "owner.json"), "utf8")).toBe('{"owner":"first"}');
      expect(await readdir(testDir)).toEqual(["owner.json"]);
    });

    it("refuses a temp substituted before the link and publishes nothing", async () => {
      const session = await openDurableDirectorySession(testDir);
      try {
        const { displaced } = substituteTemporaryOnClose();
        await expect(publishExclusive(session, "owner.json", "owner"))
          .rejects.toThrow("atomic write temporary file changed before publish");
        await rm(displaced[0]!);
      } finally {
        await session.close();
      }
      expect(await readdir(testDir)).toEqual([]);
    });

    it("links a retained source exclusively and refuses an existing destination", async () => {
      await writeFile(path.join(testDir, ".lock.a.owner"), "a");
      await writeFile(path.join(testDir, ".lock.b.owner"), "b");
      const session = await openDurableDirectorySession(testDir);
      try {
        const identity = await linkExclusive(session, ".lock.a.owner", "state.lock");
        const named = await lstat(path.join(testDir, "state.lock"), { bigint: true });
        expect(named.nlink).toBe(2n);
        expect(identity).toEqual({ dev: named.dev, ino: named.ino });
        await expect(linkExclusive(session, ".lock.b.owner", "state.lock"))
          .rejects.toMatchObject({ code: "EEXIST" });
      } finally {
        await session.close();
      }
      expect(await readFile(path.join(testDir, "state.lock"), "utf8")).toBe("a");
    });
  });

  describe("moveDirectory", () => {
    it("moves a directory to an absent leaf and keeps its identity", async () => {
      await mkdir(path.join(testDir, "run-1"));
      const before = await lstat(path.join(testDir, "run-1"), { bigint: true });
      const session = await openDurableDirectorySession(testDir);
      try {
        await moveDirectory(session, "run-1", ".poisoned-run-1");
      } finally {
        await session.close();
      }
      const after = await lstat(path.join(testDir, ".poisoned-run-1"), { bigint: true });
      expect([after.dev, after.ino]).toEqual([before.dev, before.ino]);
      expect(await readdir(testDir)).toEqual([".poisoned-run-1"]);
    });

    it("refuses to move a directory that is not the expected one", async () => {
      await mkdir(path.join(testDir, "home"));
      const expected = await lstat(path.join(testDir, "home"), { bigint: true });
      await rename(path.join(testDir, "home"), path.join(testDir, "home-aside"));
      await mkdir(path.join(testDir, "home"));
      const session = await openDurableDirectorySession(testDir);
      try {
        await expect(moveDirectory(session, "home", ".q-home", expected))
          .rejects.toThrow("directory move source is not the expected directory");
      } finally {
        await session.close();
      }
      expect((await readdir(testDir)).sort()).toEqual(["home", "home-aside"]);
    });

    it("refuses to move onto an existing entry", async () => {
      await mkdir(path.join(testDir, "run-1"));
      await mkdir(path.join(testDir, ".poisoned-run-1"));
      const session = await openDurableDirectorySession(testDir);
      try {
        await expect(moveDirectory(session, "run-1", ".poisoned-run-1"))
          .rejects.toThrow("directory move destination already exists");
      } finally {
        await session.close();
      }
      expect((await readdir(testDir)).sort()).toEqual([".poisoned-run-1", "run-1"]);
    });
  });
});
