import { lstat, mkdtemp, readFile, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeRunStart, type RunStartRecord, type RunStartTarget } from "../../src/runtime/run-start.js";

const RECORD: RunStartRecord = {
  runId: "run-1",
  lockKey: "lock",
  canonicalCommonDir: "/repo/.git",
  pid: null,
  processToken: null,
  startedAt: "2026-10-10T00:00:00.000Z",
};

describe("writeRunStart archive directory check", () => {
  let directory: string;
  let target: RunStartTarget;

  beforeEach(async () => {
    directory = await realpath(await mkdtemp(path.join(tmpdir(), "ca-run-start-")));
    const metadata = await lstat(directory, { bigint: true });
    target = {
      publicDirectory: directory,
      canonicalDirectory: directory,
      identity: { dev: metadata.dev, ino: metadata.ino, birthtimeNs: metadata.birthtimeNs },
    };
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("creates then replaces the record and leaves no temporary file", async () => {
    await writeRunStart(target, RECORD, true);
    await writeRunStart(target, { ...RECORD, pid: 42, processToken: "token" }, false);
    expect(JSON.parse(await readFile(path.join(directory, "run-start.json"), "utf8")))
      .toMatchObject({ pid: 42, processToken: "token" });
    expect(await readdir(directory)).toEqual(["run-start.json"]);
  });

  it.each([
    ["device", "dev"],
    ["inode", "ino"],
  ] as const)("treats a %s that differs only above 2^53 as a different directory", async (_label, field) => {
    const shifted = target.identity[field] + (1n << 60n);
    const changed: RunStartTarget = { ...target, identity: { ...target.identity, [field]: shifted } };
    await expect(writeRunStart(changed, RECORD, true))
      .rejects.toThrow("run archive directory identity changed");
    await expect(writeRunStart(changed, RECORD, false))
      .rejects.toThrow("run archive directory identity changed");
    expect(await readdir(directory)).toEqual([]);
  });
});
