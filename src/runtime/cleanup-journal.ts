import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import path from "node:path";
import { NO_FOLLOW, flushDirectory } from "../platform/durable-directory.js";
import { DurableDirectorySession, appendDurable } from "../platform/durable-write.js";
import { getPlatformServices } from "../platform/select-platform.js";
import { RuntimeError, isMissing } from "../util/errors.js";
import { containsRegisteredSecret, containsRegisteredSecretValue } from "./redaction.js";
import {
  BACKUP_REF_PREFIX,
  CANDIDATE_REF_PREFIX,
  MAX_STATE_FILE_BYTES,
  MAX_STATE_FILE_BYTES_BIGINT,
  OID,
  plainDirectoryIdentity,
  readHandleBytes,
  validateRunId,
} from "./recovery-shared.js";

/**
 * The Cleanup Journal: the append-only record, in the runs root, of archive
 * prune and reclaim intents and their completion or rollback. Every
 * writer (the archive store's prune and reclaim, crash recovery's prune replay)
 * appends through this module, so the filename, record shape, serialization,
 * locking and torn-tail handling cannot drift between the live and recovery
 * paths. Every operation runs in one in-process queue and under the
 * cross-process cleanup-journal lock.
 */
const CLEANUP_JOURNAL = "cleanup.ndjson";

export type PruneReason = "max-age" | "max-bytes";
export type AnchorCleanup = "not-applicable" | "deleted" | "already-absent";

export interface CleanupRecord {
  event: "prune-cleanup-intent" | "prune-cleanup-complete" | "prune-cleanup-rollback";
  runId: string;
  reason: PruneReason;
  anchorCleanup: AnchorCleanup | "pending";
  archiveBytes: number;
  quarantineName: string;
  repoRoot: string | null;
  anchorRef: string | null;
  backupRef: string | null;
  candidateCommitOid: string | null;
  recordedAt: string;
}

let journalTail: Promise<unknown> = Promise.resolve();

// One in-process queue in front of the cross-process lock: in-process callers
// never contend on the lock file, and no append can interleave with a read and
// its torn-tail repair. The lock is a leaf: nothing else is acquired under it.
function withJournal<T>(work: () => Promise<T>): Promise<T> {
  const result = journalTail.then(async () => {
    const journalLock = await getPlatformServices().acquireCleanupJournalLock();
    let outcome: { value: T } | { error: unknown };
    try {
      outcome = { value: await work() };
    } catch (error) {
      outcome = { error };
    }
    try {
      await journalLock.release();
    } catch (releaseError) {
      // A release failure stays visible without erasing the operation's own failure.
      if ("error" in outcome) {
        throw new AggregateError(
          [outcome.error, releaseError],
          "cleanup journal operation failed and its lock could not be released",
        );
      }
      throw releaseError;
    }
    if ("error" in outcome) throw outcome.error;
    return outcome.value;
  });
  journalTail = result.catch(() => {});
  return result;
}

function escapeJsonPropertyKeys(serialized: string): string {
  let result = "";
  let cursor = 0;
  while (cursor < serialized.length) {
    if (serialized[cursor] !== '"') {
      result += serialized[cursor];
      cursor += 1;
      continue;
    }

    let end = cursor + 1;
    while (end < serialized.length) {
      if (serialized[end] === "\\") {
        end += 2;
        continue;
      }
      if (serialized[end] === '"') break;
      end += 1;
    }
    const token = serialized.slice(cursor, end + 1);
    let next = end + 1;
    while (/\s/.test(serialized[next] ?? "")) next += 1;
    if (serialized[next] !== ":") {
      result += token;
      cursor = end + 1;
      continue;
    }

    const key = JSON.parse(token) as string;
    let escaped = "";
    for (let index = 0; index < key.length; index += 1) {
      escaped += `\\u${key.charCodeAt(index).toString(16).padStart(4, "0")}`;
    }
    result += `"${escaped}"`;
    cursor = end + 1;
  }
  return result;
}

export function serializeJson(value: unknown, indentation?: number): string {
  if (containsRegisteredSecretValue(value)) {
    throw new RuntimeError("archive JSON cannot be safely persisted after redaction");
  }
  const serialized = escapeJsonPropertyKeys(JSON.stringify(value, null, indentation));
  if (containsRegisteredSecret(serialized)) {
    throw new RuntimeError("archive JSON cannot be safely persisted after redaction");
  }
  return serialized;
}

interface CleanupJournalRead {
  text: string | null;
  tornTail: boolean;
}

async function readCleanupJournal(filename: string): Promise<CleanupJournalRead> {
  let handle;
  try {
    handle = await open(filename, constants.O_RDONLY | NO_FOLLOW);
  } catch (error) {
    if (isMissing(error)) return { text: null, tornTail: false };
    throw error;
  }

  let result: CleanupJournalRead | undefined;
  let primaryError: unknown;
  try {
    const metadata = await handle.stat({ bigint: true });
    const namedMetadata = await lstat(filename, { bigint: true });
    if (!metadata.isFile()
      || metadata.nlink !== 1n
      || metadata.size > MAX_STATE_FILE_BYTES_BIGINT
      || !namedMetadata.isFile()
      || namedMetadata.isSymbolicLink()
      || namedMetadata.nlink !== 1n
      || namedMetadata.dev !== metadata.dev
      || namedMetadata.ino !== metadata.ino
      || namedMetadata.birthtimeNs !== metadata.birthtimeNs
      || namedMetadata.size !== metadata.size) {
      throw new RuntimeError("cleanup journal must be a bounded regular single-link file");
    }
    const bytes = await readHandleBytes(handle, Number(metadata.size));
    const repeatedBytes = await readHandleBytes(handle, Number(metadata.size));
    const settledMetadata = await handle.stat({ bigint: true });
    const settledNamedMetadata = await lstat(filename, { bigint: true });
    if (bytes.byteLength > MAX_STATE_FILE_BYTES
      || settledMetadata.size > MAX_STATE_FILE_BYTES_BIGINT) {
      throw new RuntimeError("cleanup journal exceeds its size limit during read");
    }
    if (!settledMetadata.isFile()
      || settledMetadata.nlink !== 1n
      || settledMetadata.dev !== metadata.dev
      || settledMetadata.ino !== metadata.ino
      || settledMetadata.birthtimeNs !== metadata.birthtimeNs
      || settledMetadata.size !== metadata.size
      || settledMetadata.mtimeNs !== metadata.mtimeNs
      || settledMetadata.ctimeNs !== metadata.ctimeNs
      || !settledNamedMetadata.isFile()
      || settledNamedMetadata.isSymbolicLink()
      || settledNamedMetadata.nlink !== 1n
      || settledNamedMetadata.dev !== metadata.dev
      || settledNamedMetadata.ino !== metadata.ino
      || settledNamedMetadata.birthtimeNs !== metadata.birthtimeNs
      || settledNamedMetadata.size !== metadata.size
      || settledNamedMetadata.mtimeNs !== metadata.mtimeNs
      || settledNamedMetadata.ctimeNs !== metadata.ctimeNs
      || BigInt(bytes.byteLength) !== metadata.size
      || !repeatedBytes.equals(bytes)) {
      throw new RuntimeError("cleanup journal changed during read");
    }
    const text = bytes.toString("utf8");
    if (text === "" || text.endsWith("\n")) {
      result = { text, tornTail: false };
    } else {
      const finalNewline = text.lastIndexOf("\n");
      const completePrefix = finalNewline === -1 ? "" : text.slice(0, finalNewline + 1);
      result = { text: completePrefix, tornTail: true };
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
        "cleanup journal read failed and its handle could not be closed",
      );
    }
    throw closeError;
  }
  if (primaryError !== undefined) throw primaryError;
  if (result === undefined) throw new RuntimeError("cleanup journal read produced no result");
  return result;
}

function parseCleanupRecord(line: string): CleanupRecord {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch (cause) {
    throw new RuntimeError("cleanup journal contains invalid JSON", { cause });
  }
  if (typeof value !== "object" || value === null) {
    throw new RuntimeError("cleanup journal record must be an object");
  }
  const record = value as Partial<CleanupRecord>;
  validateRunId(record.runId);
  if (!(["prune-cleanup-intent", "prune-cleanup-complete", "prune-cleanup-rollback"] as const)
    .includes(record.event as CleanupRecord["event"])
    || !(["max-age", "max-bytes"] as const).includes(record.reason as PruneReason)
    || !(["pending", "not-applicable", "deleted", "already-absent"] as const)
      .includes(record.anchorCleanup as CleanupRecord["anchorCleanup"])
    || !Number.isSafeInteger(record.archiveBytes)
    || (record.archiveBytes ?? -1) < 0
    || typeof record.quarantineName !== "string"
    || record.quarantineName !== `.prune-${record.runId}-${record.quarantineName
      .slice(`.prune-${record.runId}-`.length)}`
    || !/^\.prune-[a-z0-9][a-z0-9._-]*-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
      record.quarantineName,
    )
    || typeof record.recordedAt !== "string"
    || !Number.isFinite(Date.parse(record.recordedAt))) {
    throw new RuntimeError("cleanup journal record is malformed");
  }
  if (record.event === "prune-cleanup-intent" && record.anchorCleanup !== "pending") {
    throw new RuntimeError("cleanup intent must remain pending until reconciled");
  }
  if (record.event !== "prune-cleanup-intent" && record.anchorCleanup === "pending") {
    throw new RuntimeError("terminal cleanup journal record cannot remain pending");
  }

  const hasRepository = typeof record.repoRoot === "string"
    && typeof record.anchorRef === "string"
    && typeof record.candidateCommitOid === "string";
  // A candidate-null prune records the repository root for lease serialization
  // but has no anchor to reconcile: repoRoot set, every Git ref field null.
  const repositoryOnly = typeof record.repoRoot === "string"
    && record.anchorRef === null
    && record.backupRef === null
    && record.candidateCommitOid === null;
  const noRepository = record.repoRoot === null
    && record.anchorRef === null
    && record.backupRef === null
    && record.candidateCommitOid === null;
  if (!noRepository && !repositoryOnly && (!hasRepository
    || record.anchorRef !== `${CANDIDATE_REF_PREFIX}${record.runId}`
    || !OID.test(record.candidateCommitOid as string)
    || (record.backupRef !== null
      && record.backupRef !== `${BACKUP_REF_PREFIX}${record.runId}`))) {
    throw new RuntimeError("cleanup journal Git metadata is malformed");
  }
  return record as CleanupRecord;
}

async function readPendingCleanupRecords(
  runsRoot: string,
): Promise<{ pending: Map<string, CleanupRecord>; tornTail: boolean }> {
  const { text, tornTail } = await readCleanupJournal(path.join(runsRoot, CLEANUP_JOURNAL));
  const pending = new Map<string, CleanupRecord>();
  if (text === null || text === "") return { pending, tornTail };
  const completeText = text.endsWith("\n") ? text.slice(0, -1) : text;
  for (const line of completeText.split("\n")) {
    if (line.trim() === "") throw new RuntimeError("cleanup journal contains a blank record");
    const record = parseCleanupRecord(line);
    if (record.event === "prune-cleanup-intent") pending.set(record.runId, record);
    else pending.delete(record.runId);
  }
  return { pending, tornTail };
}

// A torn trailing record is an intent whose durable write was interrupted before
// any Git ref was mutated (the prune writer journals intent, fsyncs, then mutates),
// so the fragment is safe to discard. The reader validates read-only and reports the
// torn tail; readPendingCleanupIntents removes it here, under the same lock, so a later
// record can never concatenate onto the fragment and corrupt the journal.
async function truncateCleanupTornTail(filename: string): Promise<void> {
  let handle;
  try {
    handle = await open(filename, constants.O_RDWR | NO_FOLLOW);
  } catch (error) {
    if (isMissing(error)) return;
    throw error;
  }
  try {
    const metadata = await handle.stat({ bigint: true });
    const namedMetadata = await lstat(filename, { bigint: true });
    if (!metadata.isFile()
      || metadata.nlink !== 1n
      || metadata.size > MAX_STATE_FILE_BYTES_BIGINT
      || !namedMetadata.isFile()
      || namedMetadata.isSymbolicLink()
      || namedMetadata.nlink !== 1n
      || namedMetadata.dev !== metadata.dev
      || namedMetadata.ino !== metadata.ino
      || namedMetadata.birthtimeNs !== metadata.birthtimeNs
      || namedMetadata.size !== metadata.size) {
      throw new RuntimeError("cleanup journal must be a bounded regular single-link file");
    }
    const bytes = await readHandleBytes(handle, Number(metadata.size));
    const text = bytes.toString("utf8");
    if (text === "" || text.endsWith("\n")) return;
    // A concurrent live prune may append+fsync a fresh intent between the reader's
    // scan and this truncate. Re-validate that we read exactly the stat'd bytes and
    // that the journal has not grown or changed since, and fail closed rather than
    // truncate away a durably-journaled intent (matches the reader's stability gate).
    const settled = await handle.stat({ bigint: true });
    const settledNamed = await lstat(filename, { bigint: true });
    if (BigInt(bytes.byteLength) !== metadata.size
      || !settled.isFile()
      || settled.nlink !== 1n
      || settled.size !== metadata.size
      || settled.dev !== metadata.dev
      || settled.ino !== metadata.ino
      || settled.birthtimeNs !== metadata.birthtimeNs
      || settled.mtimeNs !== metadata.mtimeNs
      || settled.ctimeNs !== metadata.ctimeNs
      || !settledNamed.isFile()
      || settledNamed.isSymbolicLink()
      || settledNamed.nlink !== 1n
      || settledNamed.dev !== metadata.dev
      || settledNamed.ino !== metadata.ino
      || settledNamed.birthtimeNs !== metadata.birthtimeNs
      || settledNamed.size !== metadata.size) {
      throw new RuntimeError("cleanup journal changed during torn-tail repair");
    }
    const finalNewline = text.lastIndexOf("\n");
    const completePrefix = finalNewline === -1 ? "" : text.slice(0, finalNewline + 1);
    await handle.truncate(Buffer.byteLength(completePrefix, "utf8"));
    await handle.sync();
  } finally {
    await handle?.close();
  }
}

/**
 * Durably append one record: redacting serialization (refuses a record that
 * carries a registered secret), no-follow append to a single-link regular file
 * in the identity-checked runs root, fsync, then a directory flush. The caller
 * owns creating the runs root; a missing root fails closed.
 */
export async function appendCleanupRecord(runsRoot: string, record: CleanupRecord): Promise<void> {
  const line = `${serializeJson(record)}\n`;
  await withJournal(async () => {
    const identity = await plainDirectoryIdentity(runsRoot);
    if (identity === null) throw new RuntimeError("cleanup journal root disappeared");
    // A hot path: flushDirectory never spawns the Windows directory helper.
    const session = new DurableDirectorySession(runsRoot, identity, { syncDirectory: flushDirectory });
    await appendDurable(session, CLEANUP_JOURNAL, line);
  });
}

/**
 * Read the journal and return the pending intents (latest intent per run with
 * no later completion or rollback), computed from complete lines only. A torn
 * final line is removed in the same locked section, after every complete line
 * validated, so a later append can never concatenate onto the fragment.
 */
export async function readPendingCleanupIntents(
  runsRoot: string,
): Promise<Map<string, CleanupRecord>> {
  return withJournal(async () => {
    const read = await readPendingCleanupRecords(runsRoot);
    if (read.tornTail) await truncateCleanupTornTail(path.join(runsRoot, CLEANUP_JOURNAL));
    return read.pending;
  });
}
