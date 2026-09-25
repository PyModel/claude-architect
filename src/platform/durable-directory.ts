import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, type FileHandle } from "node:fs/promises";
import path from "node:path";
import type { PlatformServices } from "./platform-services.js";
import { supervise } from "./process-supervisor.js";
import { getPlatformServices } from "./select-platform.js";
import { resolveWindowsFilesystemHelper } from "./windows-filesystem-helper.js";
import { windowsEssentialEnvironment } from "./windows-env.js";
import { RuntimeError, errorCode } from "../util/errors.js";

const WINDOWS_DIRECTORY_SYNC_TIMEOUT_MS = 30_000;
const WINDOWS_UNSUPPORTED_DIRECTORY_CODES = new Set(["EISDIR", "EINVAL", "ENOTSUP", "EPERM"]);

function windowsHelperFailure(result: Awaited<ReturnType<typeof supervise>>): string {
  const condition = result.spawnError !== undefined
    ? "spawnError"
    : result.exitCode !== 0
      ? `exitCode=${result.exitCode}`
      : result.signal !== null
        ? `signal=${result.signal}`
        : result.timedOut
          ? "timedOut=true"
          : result.cancelled
            ? "cancelled=true"
            : result.truncated.stdout
              ? "stdoutTruncated=true"
              : "stderrTruncated=true";
  const stderr = result.stderr.slice(0, 512);
  return ` (${condition})${stderr.length === 0 ? "" : `: ${stderr}`}`;
}

async function assertWindowsDirectoryAcl(
  command: "validate-private-directory" | "validate-directory-write-integrity",
  directory: string,
  expectedIdentity: DirectoryIdentity,
  platformServices: PlatformServices,
): Promise<void> {
  const helper = await resolveWindowsFilesystemHelper();
  // Helper exit 3 means CreateFileW could not open the directory, which
  // includes transient sharing violations from antivirus scans of freshly
  // created directories. Validation is read-only and re-runs completely, so a
  // bounded retry is safe; any other failure is a real refusal.
  for (let attempt = 1; ; attempt += 1) {
    const result = await supervise(platformServices, {
      executable: helper,
      args: [
        command,
        path.toNamespacedPath(directory),
        expectedIdentity.dev.toString(),
        expectedIdentity.ino.toString(),
        expectedIdentity.birthtimeNs.toString(),
      ],
      cwd: path.dirname(directory),
      env: windowsEssentialEnvironment(),
      timeoutMs: WINDOWS_DIRECTORY_SYNC_TIMEOUT_MS,
      maxOutputBytes: 16_384,
    }, { graceMs: 1_000 });
    if (result.spawnError === undefined
      && result.exitCode === 0
      && result.signal === null
      && !result.timedOut
      && !result.cancelled
      && !result.truncated.stdout
      && !result.truncated.stderr) {
      return;
    }
    if (result.exitCode === 3 && attempt < 50) {
      await new Promise(resolve => setTimeout(resolve, 200));
      continue;
    }
    throw new RuntimeError(
      `Windows directory ACL validation failed: ${command}${windowsHelperFailure(result)}`,
    );
  }
}

export async function assertWindowsPrivateDirectory(
  directory: string,
  expectedIdentity: DirectoryIdentity,
  platformServices: PlatformServices = getPlatformServices(),
): Promise<void> {
  await assertWindowsDirectoryAcl(
    "validate-private-directory",
    directory,
    expectedIdentity,
    platformServices,
  );
}

export async function assertWindowsDirectoryWriteIntegrity(
  directory: string,
  expectedIdentity: DirectoryIdentity,
  platformServices: PlatformServices = getPlatformServices(),
): Promise<void> {
  await assertWindowsDirectoryAcl(
    "validate-directory-write-integrity",
    directory,
    expectedIdentity,
    platformServices,
  );
}

export interface DirectoryIdentity {
  dev: bigint;
  ino: bigint;
  birthtimeNs: bigint;
}

export interface PrivateDirectoryOptions {
  description: string;
  create?: boolean;
  migratePermissions?: boolean;
  platformServices?: PlatformServices;
  syncDirectory?: (directory: string) => Promise<void>;
}

/** Create or validate runtime-owned state with one cross-platform privacy policy. */
export async function ensurePrivateDirectory(
  directory: string,
  options: PrivateDirectoryOptions,
): Promise<DirectoryIdentity> {
  const platformServices = options.platformServices ?? getPlatformServices();
  const syncDirectory = options.syncDirectory ?? syncDirectoryMetadata;
  let created = false;
  if (options.create !== false) {
    try {
      await mkdir(directory, { mode: 0o700 });
      created = true;
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
    }
  }
  const metadata = await lstat(directory, { bigint: true });
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new RuntimeError(`${options.description} must be a plain directory`);
  }
  if (metadata.birthtimeNs <= 0n) {
    throw new RuntimeError(`${options.description} lacks stable identity`);
  }
  const identity = {
    dev: metadata.dev,
    ino: metadata.ino,
    birthtimeNs: metadata.birthtimeNs,
  };
  if (platformServices.os === "win32") {
    await assertWindowsPrivateDirectory(directory, identity, platformServices);
  } else {
    const uid = process.getuid?.();
    if (uid === undefined || metadata.uid !== BigInt(uid)) {
      throw new RuntimeError(`${options.description} is not owned by the current user`);
    }
    if ((metadata.mode & 0o022n) !== 0n) {
      throw new RuntimeError(`${options.description} is writable by another principal`);
    }
    if ((metadata.mode & 0o077n) !== 0n) {
      if (options.migratePermissions !== true) {
        throw new RuntimeError(`${options.description} is not private`);
      }
      const handle = await open(
        directory,
        constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
      );
      let primaryError: unknown;
      try {
        const opened = await handle.stat({ bigint: true });
        if (!opened.isDirectory()
          || opened.dev !== identity.dev
          || opened.ino !== identity.ino
          || opened.birthtimeNs !== identity.birthtimeNs) {
          throw new RuntimeError(
            `${options.description} identity changed before tightening permissions`,
          );
        }
        await handle.chmod(0o700);
        await handle.sync();
        const tightened = await handle.stat({ bigint: true });
        if (tightened.uid !== metadata.uid || (tightened.mode & 0o077n) !== 0n) {
          throw new RuntimeError(`${options.description} permissions could not be tightened`);
        }
      } catch (error) {
        primaryError = error;
      }
      try {
        await handle.close();
      } catch (closeError) {
        if (primaryError !== undefined) {
          throw new AggregateError(
            [primaryError, closeError],
            `${options.description} permission update and handle close failed`,
          );
        }
        throw closeError;
      }
      if (primaryError !== undefined) throw primaryError;
      await syncDirectory(directory);
    }
  }
  if (created) await syncDirectory(path.dirname(directory));
  const settled = await lstat(directory, { bigint: true });
  if (!settled.isDirectory()
    || settled.isSymbolicLink()
    || settled.dev !== identity.dev
    || settled.ino !== identity.ino
    || settled.birthtimeNs !== identity.birthtimeNs) {
    throw new RuntimeError(`${options.description} identity changed during privacy validation`);
  }
  return identity;
}

export interface DirectorySyncDependencies {
  platform?: NodeJS.Platform;
  open?: typeof open;
  lstat?: typeof lstat;
  syncWindowsDirectory?: (
    directory: string,
    expectedIdentity: DirectoryIdentity,
  ) => Promise<void>;
}

async function closeDirectoryHandle(handle: FileHandle | undefined, primaryError: unknown) {
  try {
    await handle?.close();
  } catch (closeError) {
    if (primaryError !== undefined) {
      throw new AggregateError(
        [primaryError, closeError],
        "directory sync failed and its handle could not be closed",
      );
    }
    throw closeError;
  }
}

async function syncWindowsDirectoryMetadata(
  directory: string,
  expectedIdentity: DirectoryIdentity,
  platformServices: PlatformServices = getPlatformServices(),
): Promise<void> {
  const helper = await resolveWindowsFilesystemHelper();
  const result = await supervise(platformServices, {
    executable: helper,
    args: [
      "sync-directory",
      path.toNamespacedPath(directory),
      expectedIdentity.dev.toString(),
      expectedIdentity.ino.toString(),
      expectedIdentity.birthtimeNs.toString(),
    ],
    cwd: path.dirname(directory),
    env: windowsEssentialEnvironment(),
    timeoutMs: WINDOWS_DIRECTORY_SYNC_TIMEOUT_MS,
    maxOutputBytes: 16_384,
  }, { graceMs: 1_000 });
  if (result.spawnError !== undefined
    || result.exitCode !== 0
    || result.signal !== null
    || result.timedOut
    || result.cancelled
    || result.truncated.stdout
    || result.truncated.stderr) {
    throw new RuntimeError(
      `Windows directory metadata sync failed${windowsHelperFailure(result)}`,
    );
  }
}

/** Flush directory-entry metadata after a rename, link, or unlink. */
/**
 * Flush a directory entry on the hot write paths (artifact, workflow and
 * run-start records). Unlike {@link syncDirectoryMetadata} it neither proves
 * identity nor spawns the Windows helper: on Windows, where a directory handle
 * cannot be flushed, it is a no-op rather than a process per write.
 */
export async function flushDirectory(directory: string): Promise<void> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(directory, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    await handle.sync();
  } catch (error) {
    const unsupportedOnWindows = process.platform === "win32"
      && ["EISDIR", "EINVAL", "ENOTSUP", "EPERM"].includes(errorCode(error) ?? "");
    if (!unsupportedOnWindows) throw error;
  } finally {
    await handle?.close();
  }
}

/** Exact identity: same device, inode and birth time. */
export function sameDirectoryIdentity(left: DirectoryIdentity, right: DirectoryIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.birthtimeNs === right.birthtimeNs;
}

export async function syncDirectoryMetadata(
  directory: string,
  dependencies: DirectorySyncDependencies = {},
): Promise<void> {
  const platform = dependencies.platform ?? process.platform;
  const openDirectory = dependencies.open ?? open;
  const inspectPath = dependencies.lstat ?? lstat;
  const initial = await inspectPath(directory, { bigint: true });
  if (!initial.isDirectory() || initial.isSymbolicLink() || initial.birthtimeNs <= 0n) {
    throw new RuntimeError("directory sync target lacks stable plain-directory identity");
  }
  const expectedIdentity = {
    dev: initial.dev,
    ino: initial.ino,
    birthtimeNs: initial.birthtimeNs,
  };
  let handle: FileHandle | undefined;
  let primaryError: unknown;
  let windowsFallbackRequired = false;
  try {
    handle = await openDirectory(directory, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = await handle.stat({ bigint: true });
    if (!opened.isDirectory()
      || opened.dev !== expectedIdentity.dev
      || opened.ino !== expectedIdentity.ino
      || opened.birthtimeNs !== expectedIdentity.birthtimeNs) {
      throw new RuntimeError("directory sync target identity changed before flush");
    }
    await handle.sync();
  } catch (error) {
    if (platform === "win32"
      && WINDOWS_UNSUPPORTED_DIRECTORY_CODES.has(errorCode(error) ?? "")) {
      windowsFallbackRequired = true;
    } else {
      primaryError = error;
    }
  }

  await closeDirectoryHandle(handle, primaryError);
  if (primaryError !== undefined) throw primaryError;
  if (windowsFallbackRequired) {
    await (dependencies.syncWindowsDirectory ?? syncWindowsDirectoryMetadata)(
      directory,
      expectedIdentity,
    );
  }
  const settled = await inspectPath(directory, { bigint: true });
  if (!settled.isDirectory()
    || settled.isSymbolicLink()
    || settled.dev !== expectedIdentity.dev
    || settled.ino !== expectedIdentity.ino
    || settled.birthtimeNs !== expectedIdentity.birthtimeNs) {
    throw new RuntimeError("directory sync target identity changed during flush");
  }
}

export interface DirectoryTreeSyncOptions {
  maxDepth?: number;
  maxEntries?: number;
  syncDirectory?: (directory: string) => Promise<void>;
}

/** Flush bounded regular-file contents and every containing directory bottom-up. */
export async function syncDirectoryTreeMetadata(
  directory: string,
  options: DirectoryTreeSyncOptions = {},
): Promise<void> {
  const maxDepth = options.maxDepth ?? 16;
  const maxEntries = options.maxEntries ?? 1_024;
  const syncDirectory = options.syncDirectory ?? syncDirectoryMetadata;
  let observedEntries = 0;

  const syncFile = async (filename: string) => {
    const initial = await lstat(filename, { bigint: true });
    if (!initial.isFile() || initial.isSymbolicLink() || initial.birthtimeNs <= 0n) {
      throw new RuntimeError("durable directory tree contains a non-regular file");
    }
    const handle = await open(
      filename,
      constants.O_RDWR | (constants.O_NOFOLLOW ?? 0),
    );
    let primaryError: unknown;
    try {
      const opened = await handle.stat({ bigint: true });
      if (!opened.isFile()
        || opened.dev !== initial.dev
        || opened.ino !== initial.ino
        || opened.birthtimeNs !== initial.birthtimeNs) {
        throw new RuntimeError("durable file identity changed before flush");
      }
      await handle.sync();
      const settledHandle = await handle.stat({ bigint: true });
      if (settledHandle.dev !== initial.dev
        || settledHandle.ino !== initial.ino
        || settledHandle.birthtimeNs !== initial.birthtimeNs
        || settledHandle.size !== initial.size
        || settledHandle.mtimeNs !== initial.mtimeNs) {
        throw new RuntimeError("durable file changed during flush");
      }
    } catch (error) {
      primaryError = error;
    }
    try {
      await handle.close();
    } catch (closeError) {
      if (primaryError !== undefined) {
        throw new AggregateError(
          [primaryError, closeError],
          "durable file flush failed and its handle could not be closed",
        );
      }
      throw closeError;
    }
    if (primaryError !== undefined) throw primaryError;
    const settledPath = await lstat(filename, { bigint: true });
    if (!settledPath.isFile()
      || settledPath.isSymbolicLink()
      || settledPath.dev !== initial.dev
      || settledPath.ino !== initial.ino
      || settledPath.birthtimeNs !== initial.birthtimeNs
      || settledPath.size !== initial.size
      || settledPath.mtimeNs !== initial.mtimeNs) {
      throw new RuntimeError("durable file identity changed after flush");
    }
  };

  const visit = async (current: string, depth: number): Promise<void> => {
    if (depth > maxDepth) throw new RuntimeError("durable directory tree exceeds depth limit");
    const initial = await lstat(current, { bigint: true });
    if (!initial.isDirectory() || initial.isSymbolicLink() || initial.birthtimeNs <= 0n) {
      throw new RuntimeError("durable directory tree contains an invalid directory");
    }
    const entries = await readdir(current, { withFileTypes: true });
    observedEntries += entries.length;
    if (observedEntries > maxEntries) {
      throw new RuntimeError("durable directory tree exceeds entry limit");
    }
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        await visit(entryPath, depth + 1);
      } else if (entry.isFile() && !entry.isSymbolicLink()) {
        await syncFile(entryPath);
      } else {
        throw new RuntimeError("durable directory tree contains an unsupported entry");
      }
    }
    await syncDirectory(current);
    const settled = await lstat(current, { bigint: true });
    if (!settled.isDirectory()
      || settled.isSymbolicLink()
      || settled.dev !== initial.dev
      || settled.ino !== initial.ino
      || settled.birthtimeNs !== initial.birthtimeNs) {
      throw new RuntimeError("durable directory identity changed during tree flush");
    }
  };

  await visit(directory, 0);
}
