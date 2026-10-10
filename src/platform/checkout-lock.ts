import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, type FileHandle } from "node:fs/promises";
import path from "node:path";
import nodeProcess from "node:process";
import { RuntimeError, errorCode, isMissing } from "../util/errors.js";
import type { CheckoutLock, FileLock, LockOwnerAnnotation, PlatformServices } from "./platform-services.js";
import { NO_FOLLOW, sameDirectoryIdentity, type DirectoryIdentity } from "./durable-directory.js";
import {
  LOCK_CONTENDED,
  MAX_STATE_FILE_BYTES,
  MAX_STATE_FILE_BYTES_BIGINT,
  formatLockRecord,
  isPlainDirectory,
  lockFilePath,
  plainDirectoryIdentity,
  readHandleBytes,
  reclaimDeadLock,
  removeLockIfUnchanged,
  temporaryLockFileName,
  withLockContentionDetail,
  type DeadLockReclaimResult,
} from "./lock-ownership.js";

/**
 * The Checkout Lock: one owned protocol for every holder of a `<key>.lock`
 * file — live checkout leases, recovery leases and claims, the worktree sweep
 * and the cleanup-journal mutex. A lock is published by linking an exclusive,
 * fsynced temporary record into place, and released only after its open handle
 * proves the file is still this holder's record, so a slow holder can never
 * remove a successor's lock.
 */

const LOCK_RETRY_MS = 30;
// Antivirus and indexers briefly hold files on Windows; these clear on retry.
const TRANSIENT_WIN32_CODES = new Set(["EPERM", "EBUSY", "EACCES"]);

/**
 * Fixed 64-hex key for the state-dir-scoped cleanup-journal mutex. sha256 so it
 * matches the checkout lock-name pattern and is reclaimed like any dead lock,
 * and distinct (by domain prefix) from checkout locks keyed on a repository.
 */
export const CLEANUP_JOURNAL_LOCK_KEY =
  createHash("sha256").update("claude-architect:cleanup-journal:v1").digest("hex");

export interface AcquiredLock {
  lockPath: string;
  identity: DirectoryIdentity;
  contents: Buffer;
}

export interface LockAcquisitionOptions {
  timeoutMessage?: string | undefined;
  ownerToken?: string | null | undefined;
  owner?: LockOwnerAnnotation | undefined;
  /** The platform whose timeout and transient-error rules apply; defaults to the host. */
  platform?: NodeJS.Platform | undefined;
}

/** The lock key of a repository: sha256 of its canonical Git common directory. */
export function checkoutLockKey(commonDir: string): string {
  return createHash("sha256").update(commonDir).digest("hex");
}

type ExpectedLockRemoval = "removed" | "absent" | "changed";

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isTransientAcquisitionError(error: unknown, platform: NodeJS.Platform): boolean {
  return platform === "win32" && TRANSIENT_WIN32_CODES.has(errorCode(error) ?? "");
}

async function validateLockParentIdentity(
  parentPath: string,
  expectedIdentity: DirectoryIdentity,
): Promise<void> {
  const metadata = await lstat(parentPath, { bigint: true });
  if (!isPlainDirectory(metadata) || !sameDirectoryIdentity(metadata, expectedIdentity)) {
    throw new RuntimeError("lock parent identity changed");
  }
}

function isExpectedLockMetadata(
  metadata: {
    dev: bigint;
    ino: bigint;
    nlink: bigint;
    size: bigint;
    birthtimeNs: bigint;
    isFile(): boolean;
    isSymbolicLink(): boolean;
  },
  expectedIdentity: DirectoryIdentity,
  expectedSize: number,
  expectedLinks: number,
): boolean {
  return metadata.isFile()
    && !metadata.isSymbolicLink()
    && metadata.nlink === BigInt(expectedLinks)
    && sameDirectoryIdentity(metadata, expectedIdentity)
    && metadata.size === BigInt(expectedSize)
    && metadata.size <= MAX_STATE_FILE_BYTES_BIGINT;
}

async function validateOwnedLockState(
  handle: FileHandle,
  namedPaths: readonly string[],
  expectedIdentity: DirectoryIdentity,
  expectedContents: Buffer,
  expectedLinks: number,
  parentPath: string,
  parentIdentity: DirectoryIdentity,
): Promise<void> {
  const validateHandle = async () => {
    const metadata = await handle.stat({ bigint: true });
    if (!isExpectedLockMetadata(
      metadata,
      expectedIdentity,
      expectedContents.byteLength,
      expectedLinks,
    ) || !(await readHandleBytes(handle, Number(metadata.size))).equals(expectedContents)) {
      throw new RuntimeError("lock handle or contents changed");
    }
  };

  await validateLockParentIdentity(parentPath, parentIdentity);
  await validateHandle();
  for (const namedPath of namedPaths) {
    const metadata = await lstat(namedPath, { bigint: true });
    if (!isExpectedLockMetadata(
      metadata,
      expectedIdentity,
      expectedContents.byteLength,
      expectedLinks,
    )) throw new RuntimeError("lock path changed");
  }
  await validateHandle();
  await validateLockParentIdentity(parentPath, parentIdentity);
}

async function removeExpectedLockPath(
  filename: string,
  expectedIdentity: DirectoryIdentity,
  expectedContents: Buffer,
  expectedLinks: number,
): Promise<ExpectedLockRemoval> {
  let handle: FileHandle;
  try {
    handle = await open(filename, constants.O_RDONLY | NO_FOLLOW);
  } catch (error) {
    if (isMissing(error)) return "absent";
    throw error;
  }
  let primaryError: unknown;
  let removed = false;
  try {
    removed = await removeLockIfUnchanged(
      filename,
      handle,
      expectedIdentity,
      expectedContents,
      expectedLinks,
    );
  } catch (error) {
    primaryError = error;
  }
  try {
    await handle.close();
  } catch (closeError) {
    if (primaryError !== undefined) {
      throw new AggregateError(
        [primaryError, closeError],
        "lock cleanup failed and its handle could not be closed",
      );
    }
    throw closeError;
  }
  if (primaryError !== undefined) throw primaryError;
  return removed ? "removed" : "changed";
}

async function pathNamesLockIdentity(
  filename: string,
  expectedIdentity: DirectoryIdentity,
): Promise<boolean> {
  try {
    const metadata = await lstat(filename, { bigint: true });
    return metadata.isFile()
      && !metadata.isSymbolicLink()
      && sameDirectoryIdentity(metadata, expectedIdentity);
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

async function validatePublishedLock(
  lockPath: string,
  expectedIdentity: DirectoryIdentity,
  expectedContents: Buffer,
  parentPath: string,
  parentIdentity: DirectoryIdentity,
  expectedLinks = 1,
  namedPaths: readonly string[] = [lockPath],
): Promise<void> {
  const handle = await open(lockPath, constants.O_RDONLY | NO_FOLLOW);
  let primaryError: unknown;
  try {
    await validateOwnedLockState(
      handle,
      namedPaths,
      expectedIdentity,
      expectedContents,
      expectedLinks,
      parentPath,
      parentIdentity,
    );
  } catch (error) {
    primaryError = error;
  }
  try {
    await handle.close();
  } catch (closeError) {
    if (primaryError !== undefined) {
      throw new AggregateError(
        [primaryError, closeError],
        "published lock validation failed and its handle could not be closed",
      );
    }
    throw closeError;
  }
  if (primaryError !== undefined) throw primaryError;
}

function throwLockAcquisitionErrors(errors: unknown[]): never {
  if (errors.length === 1) throw errors[0]!;
  throw new AggregateError(errors, "lock acquisition and safe cleanup failed");
}

async function cleanupOwnedLockPaths(
  parentPath: string,
  parentIdentity: DirectoryIdentity,
  temporaryPath: string,
  lockPath: string,
  expectedIdentity: DirectoryIdentity,
  expectedContents: Buffer,
  published: boolean,
): Promise<unknown[]> {
  const errors: unknown[] = [];
  try {
    await validateLockParentIdentity(parentPath, parentIdentity);
  } catch (error) {
    return [error];
  }

  if (published) {
    try {
      const temporaryExists = await pathNamesLockIdentity(temporaryPath, expectedIdentity);
      const result = await removeExpectedLockPath(
        lockPath,
        expectedIdentity,
        expectedContents,
        temporaryExists ? 2 : 1,
      );
      if (result === "changed") {
        errors.push(new RuntimeError("published lock changed before safe cleanup"));
      }
    } catch (error) {
      errors.push(error);
    }
  }
  try {
    const result = await removeExpectedLockPath(
      temporaryPath,
      expectedIdentity,
      expectedContents,
      1,
    );
    if (result === "changed") {
      errors.push(new RuntimeError("temporary lock changed before safe cleanup"));
    }
  } catch (error) {
    errors.push(error);
  }
  try {
    await validateLockParentIdentity(parentPath, parentIdentity);
  } catch (error) {
    errors.push(error);
  }
  return errors;
}

export async function tryAcquireLock(
  lockPath: string,
  contents: Buffer,
): Promise<AcquiredLock | null> {
  if (contents.byteLength > MAX_STATE_FILE_BYTES) {
    throw new RuntimeError("new lock exceeds its size limit");
  }
  const parentPath = path.dirname(lockPath);
  const parentIdentity = await plainDirectoryIdentity(parentPath);
  if (parentIdentity === null) {
    throw new RuntimeError("lock parent must remain a plain directory");
  }
  const temporaryPath = path.join(parentPath, temporaryLockFileName());
  let handle: FileHandle | undefined;
  let temporaryIdentity: DirectoryIdentity | undefined;
  let temporaryCreated = false;
  let published = false;
  let contended = false;
  const errors: unknown[] = [];

  try {
    handle = await open(
      temporaryPath,
      constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | NO_FOLLOW,
      0o600,
    );
    temporaryCreated = true;
    const metadata = await handle.stat({ bigint: true });
    temporaryIdentity = {
      dev: metadata.dev,
      ino: metadata.ino,
      birthtimeNs: metadata.birthtimeNs,
    };
    await handle.writeFile(contents);
    await handle.sync();
    await validateOwnedLockState(
      handle,
      [temporaryPath],
      temporaryIdentity,
      contents,
      1,
      parentPath,
      parentIdentity,
    );
    try {
      await link(temporaryPath, lockPath);
      published = true;
    } catch (error) {
      if (errorCode(error) === "EEXIST") contended = true;
      else throw error;
    }
    if (published) {
      await validateOwnedLockState(
        handle,
        [temporaryPath, lockPath],
        temporaryIdentity,
        contents,
        2,
        parentPath,
        parentIdentity,
      );
    }
  } catch (error) {
    errors.push(error);
  }
  if (handle !== undefined) {
    try {
      await handle.close();
    } catch (error) {
      errors.push(error);
    }
  }

  if (temporaryCreated && temporaryIdentity === undefined) {
    errors.push(new RuntimeError("temporary lock identity is unavailable for cleanup"));
  }
  if (temporaryIdentity === undefined) throwLockAcquisitionErrors(errors);

  if (contended) {
    errors.push(...await cleanupOwnedLockPaths(
      parentPath,
      parentIdentity,
      temporaryPath,
      lockPath,
      temporaryIdentity,
      contents,
      false,
    ));
    if (errors.length === 0) return null;
    throwLockAcquisitionErrors(errors);
  }

  if (!published) {
    if (temporaryCreated) {
      errors.push(...await cleanupOwnedLockPaths(
        parentPath,
        parentIdentity,
        temporaryPath,
        lockPath,
        temporaryIdentity,
        contents,
        false,
      ));
    }
    throwLockAcquisitionErrors(errors);
  }

  if (errors.length === 0) {
    try {
      await validateLockParentIdentity(parentPath, parentIdentity);
      const result = await removeExpectedLockPath(
        temporaryPath,
        temporaryIdentity,
        contents,
        2,
      );
      if (result === "changed") {
        throw new RuntimeError("temporary lock changed before unlink");
      }
      await validatePublishedLock(
        lockPath,
        temporaryIdentity,
        contents,
        parentPath,
        parentIdentity,
      );
    } catch (error) {
      errors.push(error);
    }
  }

  if (errors.length === 0) {
    return { lockPath, identity: temporaryIdentity, contents };
  }
  errors.push(...await cleanupOwnedLockPaths(
    parentPath,
    parentIdentity,
    temporaryPath,
    lockPath,
    temporaryIdentity,
    contents,
    true,
  ));
  throwLockAcquisitionErrors(errors);
}

/**
 * Live acquisition: retry every 30 ms until the deadline (2.5 s, 15 s on
 * Windows), then fail with the lock-contended classification. A dead holder is
 * never reclaimed here; startup recovery does that.
 */
export async function acquireLock(
  key: string,
  options: LockAcquisitionOptions = {},
): Promise<FileLock> {
  const platform = options.platform ?? nodeProcess.platform;
  const lockPath = lockFilePath(key);
  await mkdir(path.dirname(lockPath), { recursive: true });
  const deadline = Date.now() + (platform === "win32" ? 15_000 : 2500);
  for (;;) {
    const contents = Buffer.from(formatLockRecord({
      pid: nodeProcess.pid,
      processToken: options.ownerToken ?? null,
      acquiredAt: new Date().toISOString(),
      ...(options.owner?.runId === undefined ? {} : { runId: options.owner.runId }),
    }));
    let acquired: AcquiredLock | null;
    try {
      acquired = await tryAcquireLock(lockPath, contents);
    } catch (error) {
      if (!isTransientAcquisitionError(error, platform) || Date.now() >= deadline) throw error;
      await delay(LOCK_RETRY_MS);
      continue;
    }
    if (acquired !== null) {
      const held = acquired;
      return { key, release: () => releaseLock(held) };
    }
    if (Date.now() >= deadline) {
      throw new RuntimeError(options.timeoutMessage ?? `lock is held: ${key}`, {
        key,
        classification: LOCK_CONTENDED,
      });
    }
    await delay(LOCK_RETRY_MS);
  }
}

/**
 * Recovery acquisition: one attempt, and when the holder is provably dead,
 * reclaim its lock and attempt once more. `holder` says why no lock was taken.
 */
export async function tryAcquireLockReclaimingDead(
  lockPath: string,
  contents: Buffer,
  isProcessAlive: (pid: number) => boolean,
  getProcessStartToken: (pid: number) => Promise<string | null>,
): Promise<{ lock: AcquiredLock | null; holder: DeadLockReclaimResult | null }> {
  const created = await tryAcquireLock(lockPath, contents);
  if (created !== null) return { lock: created, holder: null };
  const holder = await reclaimDeadLock(lockPath, isProcessAlive, getProcessStartToken);
  if (holder !== "reclaimed") return { lock: null, holder };
  return { lock: await tryAcquireLock(lockPath, contents), holder };
}

/** Remove the lock only while its open handle proves it is still this holder's record. */
export async function releaseLock(lock: AcquiredLock): Promise<void> {
  let handle: FileHandle;
  try {
    handle = await open(lock.lockPath, constants.O_RDONLY | NO_FOLLOW);
  } catch (error) {
    if (isMissing(error)) return;
    throw error;
  }
  try {
    await removeLockIfUnchanged(lock.lockPath, handle, lock.identity, lock.contents);
  } finally {
    await handle.close();
  }
}

type LockServices = Pick<PlatformServices, "canonicalizePath" | "getProcessStartToken">;

/** The checkout lock of the repository that owns `checkout`, behind PlatformServices. */
export async function acquireCheckoutLock(
  services: LockServices,
  checkout: string,
  owner: LockOwnerAnnotation = {},
): Promise<CheckoutLock> {
  const { gitCommonDir: repositoryIdentity } = await services.canonicalizePath(checkout);
  if (repositoryIdentity === null) {
    throw new RuntimeError("checkout Git common directory could not be resolved");
  }
  const key = checkoutLockKey(repositoryIdentity);
  const ownerToken = await services.getProcessStartToken(nodeProcess.pid);
  let lock: FileLock;
  try {
    lock = await acquireLock(key, {
      timeoutMessage: `checkout is locked: ${checkout}`,
      ownerToken,
      owner,
    });
  } catch (error) {
    throw await withLockContentionDetail(error, key, pid => services.getProcessStartToken(pid));
  }
  return { ...lock, repositoryIdentity };
}

export async function acquireCleanupJournalLock(
  services: Pick<PlatformServices, "getProcessStartToken">,
): Promise<FileLock> {
  const ownerToken = await services.getProcessStartToken(nodeProcess.pid);
  return acquireLock(CLEANUP_JOURNAL_LOCK_KEY, {
    timeoutMessage: "cleanup journal is locked",
    ownerToken,
  });
}
