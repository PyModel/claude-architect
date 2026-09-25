import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, open, readdir, readFile, rm, type FileHandle } from "node:fs/promises";
import path from "node:path";
import nodeProcess from "node:process";
import { resolveStateDir } from "../runtime/state-dir.js";
import { RuntimeError, errorCode, isMissing } from "../util/errors.js";
import { logger } from "../util/logger.js";
import type { DirectoryIdentity } from "./durable-directory.js";
import type { CheckoutLock, LockOwnerAnnotation } from "./platform-services.js";
import { sameDirectoryIdentity } from "./durable-directory.js";

const NO_FOLLOW = constants.O_NOFOLLOW ?? 0;
const MAX_STATE_FILE_BYTES = 1_000_000;
const MAX_STATE_FILE_BYTES_BIGINT = BigInt(MAX_STATE_FILE_BYTES);

export const CHECKOUT_LOCK_NAME_PATTERN = /^([0-9a-f]{64})\.lock$/;

const LOCK_RETRY_MS = 30;
const LOCK_TIMEOUT_MS = nodeProcess.platform === "win32" ? 15_000 : 2500;
const OWNER_PROBE_TIMEOUT_MS = 1000;
const SAFE_RUN_ID = /^[a-z0-9][a-z0-9._-]{0,127}$/;

export interface LockOwner {
  pid: number;
  processToken: string;
}

export interface LockRecord {
  pid: number;
  processToken: string | null;
  acquiredAt: string;
  runId?: string | undefined;
}

export interface AcquiredLock {
  lockPath: string;
  identity: DirectoryIdentity;
  contents: Buffer;
}

export type LockOwnerStatus = "dead" | "live" | "unverifiable";
export type DeadLockReclaimResult = "reclaimed" | "live" | "unverifiable" | "malformed" | "contended";
export type ExpectedLockRemoval = "removed" | "absent" | "changed";


function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPlainDirectory(metadata: {
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}): boolean {
  return metadata.isDirectory() && !metadata.isSymbolicLink();
}

export async function plainDirectoryIdentity(directoryPath: string): Promise<DirectoryIdentity | null> {
  try {
    const metadata = await lstat(directoryPath, { bigint: true });
    if (!isPlainDirectory(metadata) || metadata.birthtimeNs <= 0n) return null;
    return { dev: metadata.dev, ino: metadata.ino, birthtimeNs: metadata.birthtimeNs };
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

export function isCheckoutLockFileName(filename: string): boolean {
  return CHECKOUT_LOCK_NAME_PATTERN.test(filename);
}

export function lockKeyFromFileName(filename: string): string | null {
  const match = CHECKOUT_LOCK_NAME_PATTERN.exec(filename);
  return match?.[1] ?? null;
}

export function lockFileName(key: string): string {
  return `${key}.lock`;
}

export function lockFilePath(key: string, stateDir = resolveStateDir()): string {
  return path.join(stateDir, "locks", lockFileName(key));
}

export function formatLockRecord(record: LockRecord): string {
  return JSON.stringify({
    pid: record.pid,
    processToken: record.processToken,
    acquiredAt: record.acquiredAt,
    ...(record.runId === undefined ? {} : { runId: record.runId }),
  });
}

export function parseLockRecord(contents: string): LockRecord | null {
  const trimmed = contents.trim();
  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!isRecord(value)) return null;
  if (typeof value.pid !== "number" || !Number.isSafeInteger(value.pid) || value.pid <= 1) {
    return null;
  }
  const processToken = typeof value.processToken === "string" && value.processToken.length > 0
    ? value.processToken
    : null;
  const acquiredAt = typeof value.acquiredAt === "string" ? value.acquiredAt : new Date(0).toISOString();
  const runId = typeof value.runId === "string" && SAFE_RUN_ID.test(value.runId) ? value.runId : undefined;
  return { pid: value.pid, processToken, acquiredAt, runId };
}

export function parseLockOwner(contents: string): LockOwner | null {
  const record = parseLockRecord(contents);
  if (record === null || record.processToken === null) return null;
  return { pid: record.pid, processToken: record.processToken };
}

export async function lockOwnerStatus(
  owner: { pid: number; processToken: string | null } | null,
  isProcessAlive: (pid: number) => boolean,
  getProcessStartToken: (pid: number) => Promise<string | null>,
): Promise<LockOwnerStatus> {
  if (owner === null || !isProcessAlive(owner.pid)) return "dead";
  if (owner.processToken === null) return "unverifiable";
  const currentToken = await getProcessStartToken(owner.pid);
  if (currentToken === null) return "unverifiable";
  return currentToken === owner.processToken ? "live" : "dead";
}

async function readHandleBytes(handle: FileHandle, length: number): Promise<Buffer> {
  const buffer = Buffer.alloc(length);
  let bytesRead = 0;
  while (bytesRead < length) {
    const result = await handle.read(buffer, bytesRead, length - bytesRead, bytesRead);
    if (result.bytesRead === 0) break;
    bytesRead += result.bytesRead;
  }
  return bytesRead === length ? buffer : buffer.subarray(0, bytesRead);
}

export async function removeLockIfUnchanged(
  lockPath: string,
  handle: FileHandle,
  expectedIdentity: DirectoryIdentity,
  expectedContents: Buffer,
  expectedLinks = 1,
): Promise<boolean> {
  const beforeMetadata = await handle.stat({ bigint: true });
  if (!beforeMetadata.isFile()
    || beforeMetadata.isSymbolicLink()
    || !sameDirectoryIdentity(beforeMetadata, expectedIdentity)
    || beforeMetadata.nlink !== BigInt(expectedLinks)
    || beforeMetadata.size !== BigInt(expectedContents.byteLength)) {
    return false;
  }
  const currentBytes = await readHandleBytes(handle, expectedContents.byteLength);
  if (!currentBytes.equals(expectedContents)) return false;
  try {
    await rm(lockPath, { force: true });
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
  const afterMetadata = await handle.stat({ bigint: true });
  return afterMetadata.nlink === BigInt(expectedLinks - 1);
}

export async function reclaimDeadLock(
  lockPath: string,
  isProcessAlive: (pid: number) => boolean,
  getProcessStartToken: (pid: number) => Promise<string | null>,
): Promise<DeadLockReclaimResult> {
  let handle: FileHandle;
  try {
    handle = await open(lockPath, constants.O_RDONLY | NO_FOLLOW);
  } catch (error) {
    if (isMissing(error)) return "contended";
    throw error;
  }
  try {
    const metadata = await handle.stat({ bigint: true });
    if (!metadata.isFile() || metadata.size > MAX_STATE_FILE_BYTES_BIGINT) {
      throw new RuntimeError("recovery lock must be a bounded regular file");
    }
    const contents = await readHandleBytes(handle, Number(metadata.size));
    if (BigInt(contents.byteLength) !== metadata.size) return "contended";
    const owner = parseLockOwner(contents.toString("utf8"));
    if (owner === null) {
      logger.warn("startup recovery preserved malformed lock", {
        event: "recovery-malformed-lock",
        lockName: path.basename(lockPath),
        reason: "invalid-owner-record",
      });
      return "malformed";
    }
    const ownerStatus = await lockOwnerStatus(owner, isProcessAlive, getProcessStartToken);
    if (ownerStatus === "live") return "live";
    if (ownerStatus === "unverifiable") {
      logger.warn("startup recovery preserved unverifiable lock", {
        event: "recovery-unverifiable-lock",
        lockName: path.basename(lockPath),
        reason: "process-token-unavailable",
      });
      return "unverifiable";
    }
    return await removeLockIfUnchanged(
      lockPath,
      handle,
      {
        dev: metadata.dev,
        ino: metadata.ino,
        birthtimeNs: metadata.birthtimeNs,
      },
      contents,
    ) ? "reclaimed" : "contended";
  } finally {
    await handle.close();
  }
}

export async function reclaimDeadCheckoutLocks(
  locksRoot: string,
  isProcessAlive: (pid: number) => boolean,
  getProcessStartToken: (pid: number) => Promise<string | null>,
): Promise<void> {
  let entries;
  try {
    entries = await readdir(locksRoot, { withFileTypes: true });
  } catch (error) {
    if (isMissing(error)) return;
    throw error;
  }
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!isCheckoutLockFileName(entry.name)) continue;
    const lockPath = path.join(locksRoot, entry.name);
    await reclaimDeadLock(lockPath, isProcessAlive, getProcessStartToken);
  }
}



export async function lockIsOwnedByLiveProcess(
  locksRoot: string,
  lockKey: string,
  isProcessAlive: (pid: number) => boolean,
  getProcessStartToken: (pid: number) => Promise<string | null>,
): Promise<boolean> {
  let contents: string;
  try {
    contents = await readFile(path.join(locksRoot, lockFileName(lockKey)), "utf8");
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
  const owner = parseLockOwner(contents);
  if (owner === null) return true; // Malformed is preserved
  return await lockOwnerStatus(owner, isProcessAlive, getProcessStartToken) !== "dead";
}

export function defaultIsProcessAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 1) return false;
  try {
    nodeProcess.kill(pid, 0);
    return true;
  } catch (error) {
    if (errorCode(error) === "EPERM") return true;
    if (errorCode(error) === "ESRCH") return false;
    throw error;
  }
}

function heldFor(acquiredAt: unknown): string {
  if (typeof acquiredAt !== "string") return "";
  const startedMs = Date.parse(acquiredAt);
  if (!Number.isFinite(startedMs)) return "";
  const elapsedMs = Date.now() - startedMs;
  if (elapsedMs < 0) return "";
  return `, held for ${Math.round(elapsedMs / 1000)}s`;
}

function heldByRun(runId: unknown): string {
  return typeof runId === "string" && SAFE_RUN_ID.test(runId) ? `, run ${runId}` : "";
}

function withTimeout<T>(work: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise<T>(resolve => {
    const timer = setTimeout(() => resolve(fallback), ms);
    void work.then(
      value => { clearTimeout(timer); resolve(value); },
      () => { clearTimeout(timer); resolve(fallback); },
    );
  });
}

export async function describeLockContention(
  key: string,
  getProcessStartToken: (pid: number) => Promise<string | null>,
): Promise<string | null> {
  let contents: string;
  try {
    contents = await readFile(lockFilePath(key), "utf8");
  } catch {
    return null;
  }

  const owner = parseLockOwner(contents);
  if (owner === null) {
    return "its owner cannot be identified, and startup recovery preserves a lock "
      + `it cannot parse, so remove it by hand: ${lockFilePath(key)}`;
  }

  const annotations = parseLockRecord(contents);
  const extras = annotations !== null
    ? `${heldByRun(annotations.runId)}${heldFor(annotations.acquiredAt)}`
    : "";

  let status: LockOwnerStatus;
  try {
    status = await lockOwnerStatus(
      owner,
      defaultIsProcessAlive,
      pid => withTimeout(getProcessStartToken(pid), OWNER_PROBE_TIMEOUT_MS, null),
    );
  } catch {
    return null;
  }

  if (status === "dead") {
    return `it was left behind by a process that exited (pid ${owner.pid}${extras}); `
      + "startup recovery reclaims it on the next server start";
  }
  if (status === "unverifiable") {
    return `it is held by pid ${owner.pid}${extras}, whose identity could not be `
      + "verified; startup recovery preserves it until that changes";
  }
  const self = owner.pid === nodeProcess.pid ? " (this same process)" : "";
  return `it is held by live pid ${owner.pid}${self}${extras}`;
}

/** The classification every lock-acquisition timeout carries. */
export const LOCK_CONTENDED = "lock-contended";

export function isLockContention(error: unknown): boolean {
  return error instanceof RuntimeError && error.detail?.classification === LOCK_CONTENDED;
}

export async function withLockContentionDetail(
  error: unknown,
  key: string,
  getProcessStartToken: (pid: number) => Promise<string | null>,
): Promise<unknown> {
  if (!(error instanceof RuntimeError)) return error;
  let description: string | null;
  try {
    description = await describeLockContention(key, getProcessStartToken);
  } catch {
    return error;
  }
  if (description === null) return error;
  return new RuntimeError(`${error.message} — ${description}`, { ...error.detail, key });
}

export async function acquireWxFileLock(
  key: string,
  timeoutMessage?: string,
  ownerToken: string | null = null,
  owner: LockOwnerAnnotation = {},
): Promise<Omit<CheckoutLock, "repositoryIdentity">> {
  const targetLockPath = lockFilePath(key);
  const locksDir = path.dirname(targetLockPath);
  const { mkdir } = await import("node:fs/promises");
  await mkdir(locksDir, { recursive: true });
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  for (;;) {
    try {
      const handle = await open(targetLockPath, "wx");
      const ownerPid = nodeProcess.pid;
      const record: LockRecord = {
        pid: ownerPid,
        processToken: ownerToken,
        acquiredAt: new Date().toISOString(),
        ...(owner.runId === undefined ? {} : { runId: owner.runId }),
      };
      try {
        await handle.writeFile(formatLockRecord(record));
      } finally {
        await handle.close();
      }
      return {
        key,
        release: async () => {
          let recordedOwner: LockRecord | null;
          try {
            recordedOwner = parseLockRecord(await readFile(targetLockPath, "utf8"));
          } catch {
            return;
          }
          if (recordedOwner === null
            || recordedOwner.pid !== ownerPid
            || recordedOwner.processToken !== ownerToken) {
            return;
          }
          await rm(targetLockPath, { force: true });
        },
      };
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
      if (Date.now() >= deadline) {
        throw new RuntimeError(timeoutMessage ?? `lock is held: ${key}`, {
          key,
          classification: LOCK_CONTENDED,
        });
      }
      await delay(LOCK_RETRY_MS);
    }
  }
}

export async function validateLockParentIdentity(
  parentPath: string,
  expectedIdentity: DirectoryIdentity,
): Promise<void> {
  const metadata = await lstat(parentPath, { bigint: true });
  if (!isPlainDirectory(metadata) || !sameDirectoryIdentity(metadata, expectedIdentity)) {
    throw new RuntimeError("recovery lock parent identity changed");
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

export async function validateOwnedLockState(
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
      throw new RuntimeError("recovery lock handle or contents changed");
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
    )) throw new RuntimeError("recovery lock path changed");
  }
  await validateHandle();
  await validateLockParentIdentity(parentPath, parentIdentity);
}

export async function removeExpectedLockPath(
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
        "recovery lock cleanup failed and its handle could not be closed",
      );
    }
    throw closeError;
  }
  if (primaryError !== undefined) throw primaryError;
  return removed ? "removed" : "changed";
}

export async function pathNamesLockIdentity(
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

export async function validatePublishedLock(
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
        "published recovery lock validation failed and its handle could not be closed",
      );
    }
    throw closeError;
  }
  if (primaryError !== undefined) throw primaryError;
}

function throwLockAcquisitionErrors(errors: unknown[]): never {
  if (errors.length === 1) throw errors[0]!;
  throw new AggregateError(errors, "recovery lock acquisition and safe cleanup failed");
}

export async function cleanupOwnedLockPaths(
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
        errors.push(new RuntimeError("published recovery lock changed before safe cleanup"));
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
      errors.push(new RuntimeError("temporary recovery lock changed before safe cleanup"));
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

export async function createOwnedLock(
  lockPath: string,
  contents: Buffer,
): Promise<AcquiredLock | null> {
  if (contents.byteLength > MAX_STATE_FILE_BYTES) {
    throw new RuntimeError("new recovery lock exceeds its size limit");
  }
  const parentPath = path.dirname(lockPath);
  const parentIdentity = await plainDirectoryIdentity(parentPath);
  if (parentIdentity === null) {
    throw new RuntimeError("recovery lock parent must remain a plain directory");
  }
  const temporaryPath = path.join(parentPath, `.recovery-lock-${randomUUID()}.tmp`);
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
    errors.push(new RuntimeError("temporary recovery lock identity is unavailable for cleanup"));
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
        throw new RuntimeError("temporary recovery lock changed before unlink");
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

export async function acquireOwnedLock(
  lockPath: string,
  contents: Buffer,
  isProcessAlive: (pid: number) => boolean = defaultIsProcessAlive,
  getProcessStartToken: (pid: number) => Promise<string | null> = async () => null,
): Promise<AcquiredLock | null> {
  const created = await createOwnedLock(lockPath, contents);
  if (created !== null) return created;
  if (await reclaimDeadLock(lockPath, isProcessAlive, getProcessStartToken) !== "reclaimed") {
    return null;
  }
  return createOwnedLock(lockPath, contents);
}

export async function releaseOwnedLock(lock: AcquiredLock): Promise<void> {
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
