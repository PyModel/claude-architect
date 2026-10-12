import { execFile } from "node:child_process";
import { lstat, mkdtemp, open, rm, writeFile, type FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readStableRegularFile } from "../../src/util/stable-file.js";
import { lstatDouble } from "../support/fs-seams.js";

describe("readStableRegularFile", () => {
  it.skipIf(process.platform === "win32")(
    "rejects a FIFO without blocking for a writer",
    async () => {
      const directory = await mkdtemp(path.join(tmpdir(), "stable-file-fifo-"));
      const filename = path.join(directory, "producer-probe");
      try {
        await new Promise<void>((resolve, reject) => {
          execFile("/usr/bin/mkfifo", [filename], error => {
            if (error === null) resolve();
            else reject(error);
          });
        });
        const started = Date.now();

        await expect(readStableRegularFile(filename, 64n)).resolves.toBeNull();
        expect(Date.now() - started).toBeLessThan(2_000);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

  it("preserves a primary read failure when handle cleanup also fails", async () => {
    const primaryError = new Error("simulated stat failure");
    const closeError = new Error("simulated close failure");
    const handle = {
      async stat() { throw primaryError; },
      async close() { throw closeError; },
    } as unknown as FileHandle;

    let observed: unknown;
    try {
      await readStableRegularFile("ignored", 4n, {
        open: (async () => handle) as typeof open,
      });
    } catch (error) {
      observed = error;
    }

    expect(observed).toBeInstanceOf(AggregateError);
    expect((observed as AggregateError).errors).toEqual([primaryError, closeError]);
  });

  it("rejects files whose filesystem cannot supply stable birth-time identity", async () => {
    const ambiguous = {
      isFile: () => true,
      isSymbolicLink: () => false,
      nlink: 1n,
      size: 0n,
      dev: 1n,
      ino: 2n,
      birthtimeNs: 0n,
      mtimeNs: 3n,
      ctimeNs: 4n,
    };
    const handle = {
      async stat() { return ambiguous; },
      async close() {},
    } as unknown as FileHandle;

    await expect(readStableRegularFile("ambiguous", 8n, {
      open: (async () => handle) as typeof open,
      lstat: lstatDouble(async () => ambiguous),
    })).resolves.toBeNull();
  });

  it("rejects a named-file timestamp change after the final handle stat", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "stable-file-timestamp-test-"));
    const filename = path.join(directory, "record.json");
    try {
      await writeFile(filename, "same");
      const before = await lstat(filename, { bigint: true });
      const realHandle = await open(filename, "r");
      await new Promise(resolve => setTimeout(resolve, 2));
      await writeFile(filename, "diff");
      const after = await lstat(filename, { bigint: true });
      expect(after.ctimeNs === before.ctimeNs && after.mtimeNs === before.mtimeNs).toBe(false);
      let handleStatCalls = 0;
      let namedStatCalls = 0;
      const observedHandle = {
        async stat() {
          handleStatCalls += 1;
          return before;
        },
        async read(
          buffer: NodeJS.ArrayBufferView,
          offset: number,
          length: number,
          position: number | null,
        ) {
          return await realHandle.read(buffer, offset, length, position);
        },
        async close() {
          await realHandle.close();
        },
      } as unknown as FileHandle;

      const result = await readStableRegularFile(filename, 4n, {
        open: (async () => observedHandle) as typeof open,
        lstat: lstatDouble(async () => {
          namedStatCalls += 1;
          return namedStatCalls === 1 ? before : after;
        }),
      });

      expect(result).toBeNull();
      expect(handleStatCalls).toBe(2);
      expect(namedStatCalls).toBe(2);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("requests at most maxBytes plus one when the opened file grows", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "stable-file-test-"));
    const filename = path.join(directory, "record.json");
    try {
      await writeFile(filename, "tiny");
      const before = await lstat(filename, { bigint: true });
      const realHandle = await open(filename, "r");
      await writeFile(filename, "x".repeat(1_000_000));
      const after = await lstat(filename, { bigint: true });
      expect({ dev: after.dev, ino: after.ino }).toEqual({ dev: before.dev, ino: before.ino });
      const requestedLengths: number[] = [];
      let handleStatCalls = 0;
      let namedStatCalls = 0;
      const observedHandle = {
        async stat() {
          handleStatCalls += 1;
          return handleStatCalls === 1 ? before : after;
        },
        async read(
          buffer: NodeJS.ArrayBufferView,
          offset: number,
          length: number,
          position: number | null,
        ) {
          requestedLengths.push(length);
          return await realHandle.read(buffer, offset, length, position);
        },
        async close() {
          await realHandle.close();
        },
      } as unknown as FileHandle;

      const result = await readStableRegularFile(filename, 4n, {
        open: (async () => observedHandle) as typeof open,
        lstat: lstatDouble(async () => {
          namedStatCalls += 1;
          return namedStatCalls === 1 ? before : after;
        }),
      });

      expect(result).toBeNull();
      expect(requestedLengths).toEqual([5]);
      expect(handleStatCalls).toBe(1);
      expect(namedStatCalls).toBe(1);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
