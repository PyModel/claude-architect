import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, readFile, rename, rm, type FileHandle } from "node:fs/promises";
import path from "node:path";
import nodeProcess from "node:process";
import { RuntimeError } from "../util/errors.js";
import {
  ensurePrivateDirectory,
  syncDirectoryMetadata,
  type DirectoryIdentity,
} from "./durable-directory.js";

const NO_FOLLOW = constants.O_NOFOLLOW ?? 0;
const SAFE_COMPONENT = /^[a-z0-9][a-z0-9._-]{0,127}$/i;

export type DurableWriteMode = "immutable" | "replace";

export interface DurableDirectoryPolicy {
  syncDirectory?: (directory: string) => Promise<void>;
  platform?: NodeJS.Platform;
  win32RetryAttempts?: number;
}

function isAlreadyPresent(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error
    && (error as { code?: unknown }).code === "EEXIST";
}

function sameIdentity(
  left: { dev: bigint; ino: bigint; birthtimeNs: bigint },
  right: { dev: bigint; ino: bigint; birthtimeNs: bigint },
): boolean {
  if (left.dev !== right.dev || left.ino !== right.ino) return false;
  if (left.birthtimeNs <= 0n || right.birthtimeNs <= 0n) return true;
  return left.birthtimeNs === right.birthtimeNs;
}

export class DurableDirectorySession {
  readonly directory: string;
  readonly identity: DirectoryIdentity;
  private readonly policy: DurableDirectoryPolicy;
  private handle?: FileHandle | undefined;
  private closed = false;

  constructor(
    directory: string,
    identity: DirectoryIdentity,
    policy: DurableDirectoryPolicy = {},
    handle?: FileHandle | undefined,
  ) {
    this.directory = directory;
    this.identity = identity;
    this.policy = policy;
    this.handle = handle;
  }

  async assertIdentity(): Promise<void> {
    if (this.closed) {
      throw new RuntimeError("durable directory session is closed");
    }
    const current = await lstat(this.directory, { bigint: true });
    if (!current.isDirectory()
      || current.isSymbolicLink()
      || !sameIdentity(current, this.identity)) {
      throw new RuntimeError("durable directory session identity changed");
    }
  }

  async sync(): Promise<void> {
    if (this.closed) {
      throw new RuntimeError("durable directory session is closed");
    }
    if (this.policy.syncDirectory !== undefined) {
      await this.policy.syncDirectory(this.directory);
      return;
    }
    if (this.handle !== undefined) {
      try {
        await this.handle.sync();
        return;
      } catch {
        // Fall back to syncDirectoryMetadata
      }
    }
    await syncDirectoryMetadata(this.directory);
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.handle !== undefined) {
      try {
        await this.handle.close();
      } catch {
        // Handle cleanup
      }
      this.handle = undefined;
    }
  }
}

export interface OpenDurableDirectorySessionOptions {
  description?: string;
  create?: boolean;
  policy?: DurableDirectoryPolicy;
  privateDirectory?: boolean;
}

export async function openDurableDirectorySession(
  directory: string,
  options: OpenDurableDirectorySessionOptions = {},
): Promise<DurableDirectorySession> {
  let identity: DirectoryIdentity;
  if (options.privateDirectory === true) {
    identity = await ensurePrivateDirectory(directory, {
      description: options.description ?? "durable directory",
      create: options.create ?? false,
      migratePermissions: true,
      ...(options.policy?.syncDirectory === undefined ? {} : { syncDirectory: options.policy.syncDirectory }),
    });
  } else {
    if (options.create !== false) {
      try {
        await mkdir(directory, { recursive: true, mode: 0o700 });
      } catch (error) {
        if (!isAlreadyPresent(error)) throw error;
      }
    }
    const metadata = await lstat(directory, { bigint: true });
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new RuntimeError(`${options.description ?? "durable directory"} must be a plain directory`);
    }
    identity = {
      dev: metadata.dev,
      ino: metadata.ino,
      birthtimeNs: metadata.birthtimeNs,
    };
  }

  let handle: FileHandle | undefined;
  if (options.policy?.platform !== "win32" && nodeProcess.platform !== "win32") {
    try {
      handle = await open(directory, constants.O_RDONLY | NO_FOLLOW);
    } catch {
      // Optional handle on POSIX
    }
  }

  return new DurableDirectorySession(directory, identity, options.policy, handle);
}

async function renameWithRetry(
  source: string,
  destination: string,
  platform: NodeJS.Platform = nodeProcess.platform,
  maxAttempts = 50,
): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await rename(source, destination);
      return;
    } catch (error) {
      const code = typeof error === "object" && error !== null && "code" in error
        ? String((error as { code?: unknown }).code)
        : undefined;
      const isTransientWin32 = platform === "win32"
        && (code === "EPERM" || code === "EACCES" || code === "EBUSY");
      if (isTransientWin32 && attempt < maxAttempts) {
        await new Promise(resolve => setTimeout(resolve, 50));
        continue;
      }
      throw error;
    }
  }
}

export async function writeAtomic(
  session: DurableDirectorySession,
  name: string,
  bytes: Buffer | string,
  mode: DurableWriteMode,
): Promise<void> {
  if (path.isAbsolute(name)
    || path.basename(name) !== name
    || !SAFE_COMPONENT.test(name)) {
    throw new RuntimeError(`atomic write target must be a safe leaf name: ${name}`);
  }

  const destination = path.join(session.directory, name);
  const temporaryPath = path.join(session.directory, `.${name}.${randomUUID()}.tmp`);
  let handle: FileHandle | undefined;
  let temporaryCreated = false;

  try {
    await session.assertIdentity();
    handle = await open(
      temporaryPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NO_FOLLOW,
      0o600,
    );
    temporaryCreated = true;
    await session.assertIdentity();

    if (typeof bytes === "string") {
      await handle.writeFile(bytes, { encoding: "utf8" });
    } else {
      await handle.writeFile(bytes);
    }
    await handle.sync();
    await handle.close();
    handle = undefined;

    await session.assertIdentity();

    if (mode === "immutable") {
      try {
        await link(temporaryPath, destination);
      } catch (error) {
        if (!isAlreadyPresent(error)) throw error;
        await session.assertIdentity();
        // Compare only against a regular file: a symlink planted at the name
        // must not stand in for the committed record. The link count is not
        // checked, since a crash between link and temp removal leaves two.
        const present = await lstat(destination, { bigint: true });
        if (!present.isFile() || present.isSymbolicLink()) {
          throw new RuntimeError(`archive entry is not a plain file: ${name}`);
        }
        const existing = await readFile(destination);
        const expected = typeof bytes === "string" ? Buffer.from(bytes, "utf8") : bytes;
        if (!existing.equals(expected)) {
          throw new RuntimeError(`archive entry already exists with different content: ${name}`);
        }
      }
      await rm(temporaryPath, { force: true });
      temporaryCreated = false;
    } else if (mode === "replace") {
      await renameWithRetry(temporaryPath, destination);
      temporaryCreated = false;
    }

    await session.sync();
    await session.assertIdentity();
  } finally {
    if (handle !== undefined) {
      try {
        await handle.close();
      } catch {
        // Handle cleanup in finally
      }
    }
    if (temporaryCreated) {
      try {
        await rm(temporaryPath, { force: true });
      } catch {
        // Temp cleanup in finally
      }
    }
  }
}
