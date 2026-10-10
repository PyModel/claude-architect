import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir, readFile, rm, type FileHandle } from "node:fs/promises";
import path from "node:path";
import nodeProcess from "node:process";
import { resolveStateDir } from "../runtime/state-dir.js";
import { RuntimeError, errorCode, isMissing } from "../util/errors.js";
import { logger } from "../util/logger.js";
import { NO_FOLLOW, sameDirectoryIdentity, type DirectoryIdentity } from "./durable-directory.js";

export const MAX_STATE_FILE_BYTES = 1_000_000;
export const MAX_STATE_FILE_BYTES_BIGINT = BigInt(MAX_STATE_FILE_BYTES);

export const CHECKOUT_LOCK_NAME_PATTERN = /^([0-9a-f]{64})\.lock$/;

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

export type LockOwnerStatus = "dead" | "live" | "unverifiable";
export type DeadLockReclaimResult = "reclaimed" | "live" | "unverifiable" | "malformed" | "contended";


function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isPlainDirectory(metadata: {
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

export async function readHandleBytes(handle: FileHandle, length: number): Promise<Buffer> {
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

const TEMPORARY_LOCK_NAME = /^\.recovery-lock-[0-9a-f-]{36}\.tmp$/;

/** A fresh name for the exclusive record a holder links into place as its lock. */
export function temporaryLockFileName(): string {
  return `.recovery-lock-${randomUUID()}.tmp`;
}

/**
 * A holder that crashed after linking its record into place but before
 * unlinking the temporary leaves the lock with a second link, its
 * `.recovery-lock-<uuid>.tmp` sibling. Remove that sibling only while it is
 * provably the same file with the same bytes; anything else stays contended.
 */
async function removeCrashedTemporarySibling(
  lockPath: string,
  identity: DirectoryIdentity,
  contents: Buffer,
): Promise<boolean> {
  const parentPath = path.dirname(lockPath);
  for (const name of await readdir(parentPath)) {
    if (!TEMPORARY_LOCK_NAME.test(name)) continue;
    const temporaryPath = path.join(parentPath, name);
    let metadata;
    try {
      metadata = await lstat(temporaryPath, { bigint: true });
    } catch (error) {
      if (isMissing(error)) continue;
      throw error;
    }
    if (!metadata.isFile() || !sameDirectoryIdentity(metadata, identity)) continue;
    let handle: FileHandle;
    try {
      handle = await open(temporaryPath, constants.O_RDONLY | NO_FOLLOW);
    } catch (error) {
      if (isMissing(error)) continue;
      throw error;
    }
    try {
      return await removeLockIfUnchanged(temporaryPath, handle, identity, contents, 2);
    } finally {
      await handle.close();
    }
  }
  return false;
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
    const identity = { dev: metadata.dev, ino: metadata.ino, birthtimeNs: metadata.birthtimeNs };
    if (metadata.nlink === 2n
      && !await removeCrashedTemporarySibling(lockPath, identity, contents)) {
      return "contended";
    }
    return await removeLockIfUnchanged(lockPath, handle, identity, contents)
      ? "reclaimed"
      : "contended";
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
