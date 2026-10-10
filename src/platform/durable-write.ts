import { randomUUID } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { link, lstat, mkdir, open, readFile, rename, rm, type FileHandle } from "node:fs/promises";
import path from "node:path";
import nodeProcess from "node:process";
import { RuntimeError } from "../util/errors.js";
import {
  NO_FOLLOW,
  ensurePrivateDirectory,
  sameDirectoryIdentity,
  syncDirectoryMetadata,
  type DirectoryIdentity,
} from "./durable-directory.js";

// A published record name. It never starts with a dot, so it cannot collide
// with the `.<name>.<uuid>.tmp` temporaries the primitives create.
const SAFE_COMPONENT = /^[a-z0-9][a-z0-9._-]{0,127}$/i;
// A leaf that link and move primitives may also address: hidden entries such
// as lock owners and quarantined runs. "." and ".." never match.
const SAFE_HIDDEN_COMPONENT = /^\.?[a-z0-9][a-z0-9._-]{0,253}$/i;

function assertSafeLeaf(name: string, operation: string, pattern = SAFE_COMPONENT): void {
  if (path.isAbsolute(name)
    || path.basename(name) !== name
    || !pattern.test(name)) {
    throw new RuntimeError(`${operation} target must be a safe leaf name: ${name}`);
  }
}

/** Exact 64-bit device and inode of a file a primitive published. */
export interface PublishedFileIdentity {
  dev: bigint;
  ino: bigint;
}

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

  get platform(): NodeJS.Platform {
    return this.policy.platform ?? nodeProcess.platform;
  }

  async assertIdentity(): Promise<void> {
    if (this.closed) {
      throw new RuntimeError("durable directory session is closed");
    }
    const current = await lstat(this.directory, { bigint: true });
    if (!current.isDirectory()
      || current.isSymbolicLink()
      || !sameDirectoryIdentity(current, this.identity)) {
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

/** The temp is published by name: refuse one substituted after its handle closed. */
async function assertStagedTemporary(
  temporaryPath: string,
  written: { dev: bigint; ino: bigint; size: bigint },
  name: string,
): Promise<void> {
  const staged = await lstat(temporaryPath, { bigint: true });
  if (!staged.isFile()
    || staged.isSymbolicLink()
    || staged.nlink !== 1n
    || staged.dev !== written.dev
    || staged.ino !== written.ino
    || staged.size !== written.size) {
    throw new RuntimeError(`atomic write temporary file changed before publish: ${name}`);
  }
}

export async function writeAtomic(
  session: DurableDirectorySession,
  name: string,
  bytes: Buffer | string,
  mode: DurableWriteMode,
): Promise<void> {
  assertSafeLeaf(name, "atomic write");

  const destination = path.join(session.directory, name);
  const temporaryPath = path.join(session.directory, `.${name}.${randomUUID()}.tmp`);
  let handle: FileHandle | undefined;
  let temporaryCreated = false;
  let primary: { error: unknown } | undefined;

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
    const written = await handle.stat({ bigint: true });
    await handle.close();
    handle = undefined;

    await session.assertIdentity();
    await assertStagedTemporary(temporaryPath, written, name);

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
  } catch (error) {
    primary = { error };
    throw error;
  } finally {
    const cleanup: unknown[] = [];
    if (handle !== undefined) {
      await handle.close().catch((closeError: unknown) => { cleanup.push(closeError); });
    }
    if (temporaryCreated) {
      await rm(temporaryPath, { force: true }).catch((removeError: unknown) => { cleanup.push(removeError); });
    }
    if (cleanup.length > 0) {
      // Cleanup failures stay visible; the primary failure, when any, leads.
      const errors = primary === undefined ? cleanup : [primary.error, ...cleanup];
      throw new AggregateError(errors, `atomic write cleanup failed: ${name}`
        + (primary === undefined ? "" : `; primary failure: ${primary.error instanceof Error ? primary.error.message : String(primary.error)}`));
    }
  }
}

/**
 * Append caller-serialized bytes to a regular file in the session directory:
 * no-follow append open, single-link and identity checks against the
 * directory session, fsync, then a directory flush. With `expectedSize` the
 * file must hold exactly that many bytes before the append and that many plus
 * the appended bytes after it.
 */
export async function appendDurable(
  session: DurableDirectorySession,
  name: string,
  bytes: Buffer | string,
  options: { expectedSize?: number } = {},
): Promise<void> {
  assertSafeLeaf(name, "durable append");
  const payload = typeof bytes === "string" ? Buffer.from(bytes, "utf8") : bytes;
  const filename = path.join(session.directory, name);
  await session.assertIdentity();
  const handle = await open(
    filename,
    constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | NO_FOLLOW,
    0o600,
  );
  let primaryError: unknown;
  try {
    const metadata = await handle.stat({ bigint: true });
    const named = await lstat(filename, { bigint: true });
    if (!metadata.isFile()
      || metadata.nlink !== 1n
      || !named.isFile()
      || named.isSymbolicLink()
      || named.nlink !== 1n
      || named.dev !== metadata.dev
      || named.ino !== metadata.ino
      || (options.expectedSize !== undefined && metadata.size !== BigInt(options.expectedSize))) {
      throw new RuntimeError(`durable append target changed before append: ${name}`);
    }
    await session.assertIdentity();
    await handle.writeFile(payload);
    await handle.sync();
    const settled = await handle.stat({ bigint: true });
    if (options.expectedSize !== undefined
      && settled.size !== BigInt(options.expectedSize + payload.byteLength)) {
      throw new RuntimeError(`durable append was incomplete: ${name}`);
    }
  } catch (error) {
    primaryError = error;
  }
  try {
    await handle.close();
  } catch (closeError) {
    if (primaryError !== undefined) {
      throw new AggregateError([primaryError, closeError], "durable append failed and its handle could not be closed");
    }
    throw closeError;
  }
  if (primaryError !== undefined) throw primaryError;
  await session.sync();
  await session.assertIdentity();
}

/**
 * Hard-link an existing single-link regular file to an absent leaf, keeping
 * the source. EEXIST is rethrown unchanged so callers can classify contention.
 * After the link both names must be the same plain file with exactly two
 * links; otherwise the new name is removed and the publish fails.
 */
export async function linkExclusive(
  session: DurableDirectorySession,
  sourceName: string,
  destinationName: string,
): Promise<PublishedFileIdentity> {
  assertSafeLeaf(sourceName, "exclusive link", SAFE_HIDDEN_COMPONENT);
  assertSafeLeaf(destinationName, "exclusive link", SAFE_HIDDEN_COMPONENT);
  const source = path.join(session.directory, sourceName);
  const destination = path.join(session.directory, destinationName);
  await session.assertIdentity();
  const before = await lstat(source, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n) {
    throw new RuntimeError(`exclusive publish source is not a single-link file: ${sourceName}`);
  }
  await link(source, destination);
  try {
    const [published, retained] = await Promise.all([
      lstat(destination, { bigint: true }),
      lstat(source, { bigint: true }),
    ]);
    if (!published.isFile()
      || published.isSymbolicLink()
      || published.nlink !== 2n
      || published.dev !== before.dev
      || published.ino !== before.ino
      || retained.dev !== before.dev
      || retained.ino !== before.ino) {
      throw new RuntimeError(`exclusive publish source changed: ${destinationName}`);
    }
    await session.assertIdentity();
  } catch (error) {
    await removeIfSameFile(destination, before);
    throw error;
  }
  return { dev: before.dev, ino: before.ino };
}

async function removeIfSameFile(filename: string, identity: PublishedFileIdentity): Promise<void> {
  try {
    const current = await lstat(filename, { bigint: true });
    if (current.isFile() && current.dev === identity.dev && current.ino === identity.ino) {
      await rm(filename);
    }
  } catch (error) {
    if (!isMissingEntry(error)) throw error;
  }
}

function isMissingEntry(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error
    && (error as { code?: unknown }).code === "ENOENT";
}

/**
 * Publish new bytes under a leaf that must not exist yet: exclusive temp,
 * fsync, link with link-count checks, temp removal, directory flush. An
 * existing destination fails with EEXIST and is left untouched; no temporary
 * file survives a failure.
 */
export async function publishExclusive(
  session: DurableDirectorySession,
  name: string,
  bytes: Buffer | string,
): Promise<PublishedFileIdentity> {
  assertSafeLeaf(name, "exclusive publish");
  const temporaryName = `.${name}.${randomUUID()}.tmp`;
  const temporaryPath = path.join(session.directory, temporaryName);
  const destination = path.join(session.directory, name);
  let temporaryCreated = false;
  let published: PublishedFileIdentity | undefined;
  try {
    await session.assertIdentity();
    const handle = await open(
      temporaryPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NO_FOLLOW,
      0o600,
    );
    temporaryCreated = true;
    let written: BigIntStats;
    try {
      await handle.writeFile(typeof bytes === "string" ? Buffer.from(bytes, "utf8") : bytes);
      await handle.sync();
      written = await handle.stat({ bigint: true });
    } finally {
      await handle.close();
    }
    await assertStagedTemporary(temporaryPath, written, name);
    published = await linkExclusive(session, temporaryName, name);
    await rm(temporaryPath);
    temporaryCreated = false;
    await session.sync();
    await session.assertIdentity();
    return published;
  } catch (error) {
    if (published !== undefined) await removeIfSameFile(destination, published);
    throw error;
  } finally {
    if (temporaryCreated) await rm(temporaryPath, { force: true });
  }
}

/**
 * Rename a plain directory to an absent leaf of the same session directory,
 * prove it kept its identity, and flush the parent.
 */
export async function moveDirectory(
  session: DurableDirectorySession,
  sourceName: string,
  destinationName: string,
): Promise<DirectoryIdentity> {
  assertSafeLeaf(sourceName, "directory move", SAFE_HIDDEN_COMPONENT);
  assertSafeLeaf(destinationName, "directory move", SAFE_HIDDEN_COMPONENT);
  const source = path.join(session.directory, sourceName);
  const destination = path.join(session.directory, destinationName);
  await session.assertIdentity();
  const before = await lstat(source, { bigint: true });
  if (!before.isDirectory() || before.isSymbolicLink()) {
    throw new RuntimeError(`directory move source is not a plain directory: ${sourceName}`);
  }
  const identity: DirectoryIdentity = { dev: before.dev, ino: before.ino, birthtimeNs: before.birthtimeNs };
  try {
    await lstat(destination);
    throw new RuntimeError(`directory move destination already exists: ${destinationName}`);
  } catch (error) {
    if (!isMissingEntry(error)) throw error;
  }
  await renameWithRetry(source, destination, session.platform);
  const moved = await lstat(destination, { bigint: true });
  if (!moved.isDirectory() || moved.isSymbolicLink() || !sameDirectoryIdentity(moved, identity)) {
    throw new RuntimeError(`moved directory identity changed: ${destinationName}`);
  }
  await session.assertIdentity();
  await session.sync();
  await session.assertIdentity();
  return identity;
}
