import { execFile, spawn, type ChildProcess } from "node:child_process";
import {
  access,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import type { BigIntStats } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { removeBoundEmptyDirectory } from "../../src/platform/bound-directory-cleanup.js";
import { getPlatformServices } from "../../src/platform/select-platform.js";
import { resolveWindowsFilesystemHelper } from "../../src/platform/windows-filesystem-helper.js";

const execFileAsync = promisify(execFile);

async function invokeRemove(
  command: string,
  directory: string,
  identity: BigIntStats,
  expectedDirectory: boolean,
) {
  return await execFileAsync(command, [
    "remove",
    directory,
    identity.dev.toString(),
    identity.ino.toString(),
    identity.birthtimeNs.toString(),
    String(expectedDirectory),
  ], { windowsHide: true });
}

async function waitForReady(child: ChildProcess): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("lock holder did not become ready")), 10_000);
    child.once("error", error => {
      clearTimeout(timeout);
      reject(error);
    });
    child.stdout?.on("data", chunk => {
      if (!String(chunk).includes("READY")) return;
      clearTimeout(timeout);
      resolve();
    });
  });
}

describe("native Windows filesystem helper", () => {
  it.runIf(process.platform === "win32")(
    "executes the packaged helper for the running Windows architecture",
    async () => {
      const helper = await resolveWindowsFilesystemHelper();
      await expect(access(helper.command)).resolves.toBeUndefined();

      const directory = await mkdtemp(path.join(tmpdir(), "ca-win32-remove-"));
      const metadata = await lstat(directory, { bigint: true });
      try {
        await removeBoundEmptyDirectory(directory, {
          dev: metadata.dev,
          ino: metadata.ino,
          birthtimeNs: metadata.birthtimeNs,
        }, getPlatformServices());
        await expect(access(directory)).rejects.toMatchObject({ code: "ENOENT" });
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

  it.runIf(process.platform === "win32")(
    "rejects stale identity after pathname substitution without deleting either inode",
    async () => {
      const helper = await resolveWindowsFilesystemHelper();
      const directory = await mkdtemp(path.join(tmpdir(), "ca-win32-substitution-"));
      const displaced = `${directory}-displaced`;
      const originalSentinel = path.join(displaced, "original.txt");
      const replacementSentinel = path.join(directory, "replacement.txt");
      await writeFile(path.join(directory, "original.txt"), "original\n");
      const identity = await lstat(directory, { bigint: true });
      await rename(directory, displaced);
      await mkdir(directory);
      await writeFile(replacementSentinel, "replacement\n");

      try {
        await expect(invokeRemove(helper.command, directory, identity, true)).rejects.toBeDefined();
        await expect(readFile(originalSentinel, "utf8")).resolves.toBe("original\n");
        await expect(readFile(replacementSentinel, "utf8")).resolves.toBe("replacement\n");
      } finally {
        await rm(directory, { recursive: true, force: true });
        await rm(displaced, { recursive: true, force: true });
      }
    },
  );

  it.runIf(process.platform === "win32")(
    "fails closed on a real share-delete denial and preserves the locked path",
    async () => {
      const helper = await resolveWindowsFilesystemHelper();
      const directory = await mkdtemp(path.join(tmpdir(), "ca-win32-locked-"));
      const lockedFile = path.join(directory, "locked.txt");
      await writeFile(lockedFile, "locked\n");
      const identity = await lstat(lockedFile, { bigint: true });
      const lockHolder = spawn("powershell.exe", [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "$stream=[IO.File]::Open($env:CA_LOCK_FILE,'Open','ReadWrite','None');"
          + "[Console]::Out.WriteLine('READY');[Console]::Out.Flush();"
          + "Start-Sleep -Seconds 60",
      ], {
        env: { ...process.env, CA_LOCK_FILE: lockedFile },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });

      try {
        await waitForReady(lockHolder);
        await expect(invokeRemove(helper.command, lockedFile, identity, false)).rejects.toBeDefined();
      } finally {
        const closed = new Promise<void>(resolve => lockHolder.once("close", () => resolve()));
        lockHolder.kill();
        await Promise.race([
          closed,
          new Promise((_, reject) => setTimeout(
            () => reject(new Error("lock holder did not stop")),
            10_000,
          )),
        ]);
      }
      try {
        // The holder opened with FileShare None, so the preservation read must
        // wait for release — reading while held fails with EBUSY by design.
        await expect(readFile(lockedFile, "utf8")).resolves.toBe("locked\n");
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
});
