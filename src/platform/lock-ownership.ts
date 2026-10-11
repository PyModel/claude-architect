import { readFile } from "node:fs/promises";
import path from "node:path";
import nodeProcess from "node:process";
import { resolveStateDir } from "../runtime/state-dir.js";
import { RuntimeError, errorCode, isMissing } from "../util/errors.js";

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isPlainDirectory(metadata: {
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}): boolean {
  return metadata.isDirectory() && !metadata.isSymbolicLink();
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
