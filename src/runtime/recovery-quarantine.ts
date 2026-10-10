import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import path from "node:path";
import {
  DurableDirectorySession,
  moveDirectory,
  publishExclusive,
  writeAtomic,
} from "../platform/durable-write.js";
import {
  NO_FOLLOW,
  sameDevIno,
  sameDirectoryIdentity,
  syncDirectoryMetadata,
  type DirectoryIdentity,
} from "../platform/durable-directory.js";
import { RuntimeError, isMissing } from "../util/errors.js";
import { logger } from "../util/logger.js";
import { boundedRedactedDiagnostic } from "./redaction.js";
import {
  MAX_STATE_FILE_BYTES,
  MAX_STATE_FILE_BYTES_BIGINT,
  MAX_QUARANTINE_REASON_BYTES,
  MAX_QUARANTINE_RECORD_BYTES,
  isPlainDirectory,
  validateRunId,
  plainDirectoryIdentity,
  readHandleBytes,
} from "./recovery-shared.js";

const QUARANTINE_JOURNAL_NAME = "recovery-quarantine.ndjson";

interface RecoveryQuarantineRecord {
  event: "recovery-quarantine";
  runId: string;
  reason: string;
  recordedAt: string;
}

interface RecoveryQuarantineSnapshot {
  bytes: Buffer;
  runIds: Set<string>;
  rootIdentity: DirectoryIdentity;
  journalIdentity: DirectoryIdentity | null;
}

function boundedQuarantineReason(error: unknown): string {
  return boundedRedactedDiagnostic(error, MAX_QUARANTINE_REASON_BYTES);
}

function parseRecoveryQuarantineRecord(line: string): RecoveryQuarantineRecord {
  if (Buffer.byteLength(`${line}\n`, "utf8") > MAX_QUARANTINE_RECORD_BYTES) {
    throw new RuntimeError("recovery quarantine journal record exceeds its size limit");
  }
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch (cause) {
    throw new RuntimeError("recovery quarantine journal contains invalid JSON", { cause });
  }
  if (typeof value !== "object" || value === null) {
    throw new RuntimeError("recovery quarantine journal record must be an object");
  }
  const record = value as Partial<RecoveryQuarantineRecord>;
  validateRunId(record.runId);
  if (Object.keys(value).sort().join(",") !== "event,reason,recordedAt,runId"
    || record.event !== "recovery-quarantine"
    || typeof record.reason !== "string"
    || Buffer.byteLength(record.reason, "utf8") > MAX_QUARANTINE_REASON_BYTES
    || typeof record.recordedAt !== "string"
    || !Number.isFinite(Date.parse(record.recordedAt))) {
    throw new RuntimeError("recovery quarantine journal record is malformed");
  }
  return record as RecoveryQuarantineRecord;
}

function parseRecoveryQuarantineJournal(bytes: Buffer): Set<string> {
  const text = bytes.toString("utf8");
  const runIds = new Set<string>();
  if (text === "") return runIds;
  if (!text.endsWith("\n")) {
    throw new RuntimeError("recovery quarantine journal has a torn final record");
  }
  for (const line of text.slice(0, -1).split("\n")) {
    if (line === "") throw new RuntimeError("recovery quarantine journal contains a blank record");
    const record = parseRecoveryQuarantineRecord(line);
    if (runIds.has(record.runId)) {
      throw new RuntimeError("duplicate recovery quarantine runId");
    }
    runIds.add(record.runId);
  }
  return runIds;
}

export async function readRecoveryQuarantineJournal(
  runsRoot: string,
): Promise<RecoveryQuarantineSnapshot> {
  const rootIdentity = await plainDirectoryIdentity(runsRoot);
  if (rootIdentity === null) {
    throw new RuntimeError("recovery quarantine journal root disappeared");
  }
  const filename = path.join(runsRoot, QUARANTINE_JOURNAL_NAME);
  let expectedMetadata;
  try {
    expectedMetadata = await lstat(filename, { bigint: true });
  } catch (error) {
    if (!isMissing(error)) throw error;
    const currentRoot = await lstat(runsRoot, { bigint: true });
    if (!isPlainDirectory(currentRoot) || !sameDirectoryIdentity(currentRoot, rootIdentity)) {
      throw new RuntimeError("recovery quarantine journal root changed during missing read");
    }
    return {
      bytes: Buffer.alloc(0),
      runIds: new Set<string>(),
      rootIdentity,
      journalIdentity: null,
    };
  }
  if (!expectedMetadata.isFile()
    || expectedMetadata.isSymbolicLink()
    || expectedMetadata.nlink !== 1n
    || expectedMetadata.size > MAX_STATE_FILE_BYTES_BIGINT) {
    throw new RuntimeError("recovery quarantine journal is not a bounded regular file");
  }
  let handle;
  try {
    handle = await open(filename, constants.O_RDONLY | NO_FOLLOW);
  } catch (error) {
    if (!isMissing(error)) throw error;
    try {
      await lstat(filename);
    } catch (namedError) {
      if (isMissing(namedError)) {
        const currentRoot = await lstat(runsRoot, { bigint: true });
        if (isPlainDirectory(currentRoot) && sameDirectoryIdentity(currentRoot, rootIdentity)) {
          return {
            bytes: Buffer.alloc(0),
            runIds: new Set<string>(),
            rootIdentity,
            journalIdentity: null,
          };
        }
      }
    }
    throw new RuntimeError("recovery quarantine journal changed before read", { cause: error });
  }
  let bytes: Buffer | undefined;
  let journalIdentity: DirectoryIdentity | undefined;
  let primaryError: unknown;
  try {
    const metadata = await handle.stat({ bigint: true });
    const namedMetadata = await lstat(filename, { bigint: true });
    const currentRoot = await lstat(runsRoot, { bigint: true });
    if (!metadata.isFile()
      || metadata.size > MAX_STATE_FILE_BYTES_BIGINT
      || metadata.size !== expectedMetadata.size
      || metadata.nlink !== 1n
      || !namedMetadata.isFile()
      || namedMetadata.isSymbolicLink()
      || namedMetadata.nlink !== 1n
      || namedMetadata.size !== metadata.size
      || namedMetadata.dev !== expectedMetadata.dev
      || namedMetadata.ino !== expectedMetadata.ino
      || namedMetadata.birthtimeNs !== expectedMetadata.birthtimeNs
      || namedMetadata.dev !== metadata.dev
      || namedMetadata.ino !== metadata.ino
      || namedMetadata.birthtimeNs !== metadata.birthtimeNs
      || !isPlainDirectory(currentRoot)
      || !sameDirectoryIdentity(currentRoot, rootIdentity)) {
      throw new RuntimeError("recovery quarantine journal changed during read");
    }
    journalIdentity = {
      dev: metadata.dev,
      ino: metadata.ino,
      birthtimeNs: metadata.birthtimeNs,
    };
    bytes = await readHandleBytes(handle, Number(metadata.size));
    const settledHandle = await handle.stat({ bigint: true });
    const settledMetadata = await lstat(filename, { bigint: true });
    const settledRoot = await lstat(runsRoot, { bigint: true });
    if (!settledHandle.isFile()
      || settledHandle.nlink !== 1n
      || settledHandle.size !== metadata.size
      || settledHandle.dev !== metadata.dev
      || settledHandle.ino !== metadata.ino
      || settledHandle.birthtimeNs !== metadata.birthtimeNs
      || settledHandle.mtimeNs !== metadata.mtimeNs
      || settledHandle.ctimeNs !== metadata.ctimeNs
      || !settledMetadata.isFile()
      || settledMetadata.isSymbolicLink()
      || settledMetadata.nlink !== 1n
      || settledMetadata.size !== BigInt(bytes.byteLength)
      || settledMetadata.dev !== metadata.dev
      || settledMetadata.ino !== metadata.ino
      || settledMetadata.birthtimeNs !== metadata.birthtimeNs
      || settledMetadata.mtimeNs !== metadata.mtimeNs
      || settledMetadata.ctimeNs !== metadata.ctimeNs
      || !isPlainDirectory(settledRoot)
      || !sameDirectoryIdentity(settledRoot, rootIdentity)) {
      throw new RuntimeError("recovery quarantine journal changed after read");
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
        "recovery quarantine journal read failed and its handle could not be closed",
      );
    }
    throw closeError;
  }
  if (primaryError !== undefined) throw primaryError;
  if (bytes === undefined || journalIdentity === undefined) {
    throw new RuntimeError("recovery quarantine journal read produced no content");
  }
  return {
    bytes,
    runIds: parseRecoveryQuarantineJournal(bytes),
    rootIdentity,
    journalIdentity,
  };
}

async function syncRecoveryDirectory(directory: string): Promise<void> {
  await syncDirectoryMetadata(directory);
}

async function publishRecoveryQuarantineJournal(
  runsRoot: string,
  snapshot: RecoveryQuarantineSnapshot,
  nextBytes: Buffer,
): Promise<void> {
  const currentSnapshot = await readRecoveryQuarantineJournal(runsRoot);
  const sameJournalIdentity = snapshot.journalIdentity === null
    ? currentSnapshot.journalIdentity === null
    : currentSnapshot.journalIdentity !== null
      && sameDirectoryIdentity(currentSnapshot.journalIdentity, snapshot.journalIdentity);
  if (!sameDirectoryIdentity(currentSnapshot.rootIdentity, snapshot.rootIdentity)
    || !sameJournalIdentity
    || !currentSnapshot.bytes.equals(snapshot.bytes)) {
    throw new RuntimeError("recovery quarantine journal changed before publication");
  }
  // No handle and no policy: the session flushes through syncDirectoryMetadata,
  // which proves the runs root identity, as recovery always has.
  const session = new DurableDirectorySession(runsRoot, snapshot.rootIdentity);
  let created: { dev: bigint; ino: bigint } | undefined;
  if (snapshot.journalIdentity === null) {
    created = await publishExclusive(session, QUARANTINE_JOURNAL_NAME, nextBytes);
  } else {
    await writeAtomic(session, QUARANTINE_JOURNAL_NAME, nextBytes, "replace");
  }
  const publishedSnapshot = await readRecoveryQuarantineJournal(runsRoot);
  if (publishedSnapshot.journalIdentity === null
    || (created !== undefined && !sameDevIno(publishedSnapshot.journalIdentity, created))
    || !sameDirectoryIdentity(publishedSnapshot.rootIdentity, snapshot.rootIdentity)
    || !publishedSnapshot.bytes.equals(nextBytes)) {
    throw new RuntimeError("recovery quarantine journal changed after publication");
  }
}

async function appendRecoveryQuarantineRecord(
  runsRoot: string,
  record: RecoveryQuarantineRecord,
): Promise<void> {
  const line = `${JSON.stringify(record)}\n`;
  const lineBytes = Buffer.byteLength(line, "utf8");
  if (lineBytes > MAX_QUARANTINE_RECORD_BYTES) {
    throw new RuntimeError("recovery quarantine record exceeds its size limit");
  }
  const snapshot = await readRecoveryQuarantineJournal(runsRoot);
  if (snapshot.runIds.has(record.runId)) {
    await syncRecoveryDirectory(runsRoot);
    const settledSnapshot = await readRecoveryQuarantineJournal(runsRoot);
    if (!sameDirectoryIdentity(settledSnapshot.rootIdentity, snapshot.rootIdentity)
      || settledSnapshot.journalIdentity === null
      || snapshot.journalIdentity === null
      || settledSnapshot.journalIdentity.dev !== snapshot.journalIdentity.dev
      || settledSnapshot.journalIdentity.ino !== snapshot.journalIdentity.ino
      || settledSnapshot.journalIdentity.birthtimeNs !== snapshot.journalIdentity.birthtimeNs
      || !settledSnapshot.bytes.equals(snapshot.bytes)) {
      throw new RuntimeError("recovery quarantine journal changed after retry sync");
    }
    return;
  }
  const nextBytes = Buffer.concat([snapshot.bytes, Buffer.from(line, "utf8")]);
  if (nextBytes.byteLength > MAX_STATE_FILE_BYTES) {
    throw new RuntimeError("recovery quarantine journal exceeds its size limit");
  }
  await publishRecoveryQuarantineJournal(runsRoot, snapshot, nextBytes);
}

export async function quarantineRun(
  runsRoot: string,
  runId: string,
  error: unknown,
): Promise<void> {
  const runDirectory = path.join(runsRoot, runId);
  const quarantinePath = path.join(runsRoot, `.poisoned-${runId}`);
  const runsIdentity = await plainDirectoryIdentity(runsRoot);
  if (runsIdentity === null) throw new RuntimeError("recovery runs root disappeared");
  const runsSession = new DurableDirectorySession(runsRoot, runsIdentity);
  let runIdentity: DirectoryIdentity | null = null;
  let renamed = false;
  let journaled = false;
  try {
    runIdentity = await plainDirectoryIdentity(runDirectory);
    if (runIdentity === null) throw new RuntimeError("poisoned recovery run disappeared");
    if (await plainDirectoryIdentity(quarantinePath) !== null) {
      throw new RuntimeError("poisoned recovery quarantine already exists");
    }
    await moveDirectory(runsSession, runId, path.basename(quarantinePath));
    renamed = true;
    const quarantineIdentity = await plainDirectoryIdentity(quarantinePath);
    const currentRoot = await lstat(runsRoot, { bigint: true });
    if (quarantineIdentity === null
      || !sameDirectoryIdentity(quarantineIdentity, runIdentity)
      || !isPlainDirectory(currentRoot)
      || !sameDirectoryIdentity(currentRoot, runsIdentity)) {
      throw new RuntimeError("poisoned recovery run identity changed during quarantine");
    }
    const record: RecoveryQuarantineRecord = {
      event: "recovery-quarantine",
      runId,
      reason: boundedQuarantineReason(error),
      recordedAt: new Date().toISOString(),
    };
    await appendRecoveryQuarantineRecord(runsRoot, record);
    journaled = true;
    logger.warn("startup recovery quarantined poisoned run", {
      runId,
      reason: record.reason,
    });
  } catch (quarantineError) {
    const errors = [error, quarantineError];
    if (renamed && !journaled && runIdentity !== null) {
      try {
        const quarantineMetadata = await lstat(quarantinePath, { bigint: true });
        const currentRoot = await lstat(runsRoot, { bigint: true });
        if (!isPlainDirectory(quarantineMetadata)
          || !sameDirectoryIdentity(quarantineMetadata, runIdentity)
          || await plainDirectoryIdentity(runDirectory) !== null
          || !isPlainDirectory(currentRoot)
          || !sameDirectoryIdentity(currentRoot, runsIdentity)) {
          throw new RuntimeError("poisoned recovery rollback identity or destination is unsafe");
        }
        await moveDirectory(runsSession, path.basename(quarantinePath), runId);
        const restoredMetadata = await lstat(runDirectory, { bigint: true });
        const restoredRoot = await lstat(runsRoot, { bigint: true });
        if (!isPlainDirectory(restoredMetadata)
          || !sameDirectoryIdentity(restoredMetadata, runIdentity)
          || !isPlainDirectory(restoredRoot)
          || !sameDirectoryIdentity(restoredRoot, runsIdentity)) {
          throw new RuntimeError("poisoned recovery rollback identity changed");
        }
        await syncRecoveryDirectory(runsRoot);
        const settledMetadata = await lstat(runDirectory, { bigint: true });
        const settledRoot = await lstat(runsRoot, { bigint: true });
        if (!isPlainDirectory(settledMetadata)
          || !sameDirectoryIdentity(settledMetadata, runIdentity)
          || !isPlainDirectory(settledRoot)
          || !sameDirectoryIdentity(settledRoot, runsIdentity)) {
          throw new RuntimeError("poisoned recovery rollback changed after directory sync");
        }
      } catch (rollbackError) {
        errors.push(rollbackError);
      }
    }
    throw new AggregateError(errors, "run recovery failed and quarantine did not complete");
  }
}
