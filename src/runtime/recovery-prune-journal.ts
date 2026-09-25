import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";
import { git } from "../git/git-exec.js";
import { gitPathOutput } from "../git/git-output.js";
import { platformSafety } from "../platform/platform-safety.js";
import type { PlatformServices } from "../platform/platform-services.js";
import { getPlatformServices } from "../platform/select-platform.js";
import {
  emptyBoundDirectory,
  removeBoundEmptyDirectory,
} from "../platform/bound-directory-cleanup.js";
import { sameDirectoryIdentity } from "../platform/durable-directory.js";
import { RuntimeError, isMissing } from "../util/errors.js";
import {
  NO_FOLLOW,
  MAX_STATE_FILE_BYTES,
  MAX_STATE_FILE_BYTES_BIGINT,
  OID,
  CANDIDATE_REF_PREFIX,
  BACKUP_REF_PREFIX,
  type DirectoryIdentity,
  isPlainDirectory,
  validateRunId,
  plainDirectoryIdentity,
  runGitError,
  validateRepositoryRoot,
  readDirectRef,
  deleteExactRef,
  readHandleBytes,
} from "./recovery-shared.js";

type PruneReason = "max-age" | "max-bytes";
type AnchorCleanup = "not-applicable" | "deleted" | "already-absent";

interface CleanupRecord {
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

function cleanupOutcome(record: CleanupRecord): AnchorCleanup {
  if (record.repoRoot === null || record.anchorRef === null) return "not-applicable";
  return record.backupRef === null ? "already-absent" : "deleted";
}

async function removePlainDirectory(
  directory: string,
  expected: DirectoryIdentity,
  platformServices: PlatformServices,
): Promise<void> {
  const metadata = await lstat(directory, { bigint: true });
  if (!isPlainDirectory(metadata) || !sameDirectoryIdentity(metadata, expected)) {
    throw new RuntimeError("recovery directory identity changed before removal");
  }
  await emptyBoundDirectory(directory, expected, platformServices);
  await removeBoundEmptyDirectory(directory, expected, platformServices);
}

async function createExactRef(repoRoot: string, ref: string, oid: string): Promise<void> {
  const result = await git(repoRoot, [
    "update-ref",
    "--no-deref",
    ref,
    oid,
    "0".repeat(oid.length),
  ]);
  if (result.exitCode !== 0) throw runGitError("create recovery Git ref", result);
}

async function appendCleanupRecord(runsRoot: string, record: CleanupRecord): Promise<void> {
  // Same shared-journal mutex the prune writer holds: a completion/rollback append
  // can never interleave with a concurrent intent append or a torn-tail truncation.
  const journalLock = await getPlatformServices().acquireCleanupJournalLock();
  try {
    const identity = await plainDirectoryIdentity(runsRoot);
    if (identity === null) throw new RuntimeError("cleanup journal root disappeared");
    const filename = path.join(runsRoot, "cleanup.ndjson");
    const handle = await open(
      filename,
      constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | NO_FOLLOW,
      0o600,
    );
    try {
      const metadata = await handle.stat();
      const currentRoot = await lstat(runsRoot, { bigint: true });
      if (!metadata.isFile() || !isPlainDirectory(currentRoot) || !sameDirectoryIdentity(currentRoot, identity)) {
        throw new RuntimeError("cleanup journal identity changed during recovery");
      }
      await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    const currentRoot = await lstat(runsRoot, { bigint: true });
    if (!isPlainDirectory(currentRoot) || !sameDirectoryIdentity(currentRoot, identity)) {
      throw new RuntimeError("cleanup journal root changed after recovery append");
    }
  } finally {
    await journalLock.release();
  }
}

async function reconcileCleanupRefs(
  record: CleanupRecord,
  action: "finish" | "rollback",
): Promise<AnchorCleanup> {
  const outcome = cleanupOutcome(record);
  if (outcome === "not-applicable") return outcome;
  const repoRoot = await validateRepositoryRoot(record.repoRoot!);
  const anchorRef = record.anchorRef!;
  const candidateOid = record.candidateCommitOid!;
  let anchorOid = await readDirectRef(repoRoot, anchorRef);
  if (anchorOid !== null && anchorOid !== candidateOid) {
    throw new RuntimeError("candidate anchor moved during interrupted prune recovery");
  }
  if (outcome === "already-absent") {
    if (anchorOid !== null) {
      throw new RuntimeError("candidate anchor unexpectedly reappeared during prune recovery");
    }
    return outcome;
  }

  const backupRef = record.backupRef!;
  let backupOid = await readDirectRef(repoRoot, backupRef);
  if (backupOid !== null && backupOid !== candidateOid) {
    throw new RuntimeError("candidate prune backup moved during recovery");
  }
  if (action === "finish") {
    if (anchorOid !== null && backupOid === null) {
      await createExactRef(repoRoot, backupRef, candidateOid);
      backupOid = candidateOid;
    }
    if (anchorOid !== null) {
      await deleteExactRef(repoRoot, anchorRef, candidateOid);
      anchorOid = null;
    }
    return outcome;
  }

  if (anchorOid === null) {
    if (backupOid === null) {
      throw new RuntimeError("cannot restore candidate anchor without its prune backup");
    }
    await createExactRef(repoRoot, anchorRef, candidateOid);
    anchorOid = candidateOid;
  }
  if (backupOid !== null) await deleteExactRef(repoRoot, backupRef, candidateOid);
  return outcome;
}

async function commitCleanupRefs(record: CleanupRecord): Promise<void> {
  if (cleanupOutcome(record) !== "deleted") return;
  const repoRoot = await validateRepositoryRoot(record.repoRoot!);
  const backupOid = await readDirectRef(repoRoot, record.backupRef!);
  if (backupOid === null) return;
  if (backupOid !== record.candidateCommitOid) {
    throw new RuntimeError("candidate prune backup moved before cleanup commit");
  }
  await deleteExactRef(repoRoot, record.backupRef!, backupOid);
}

async function readPendingCleanupRecords(
  runsRoot: string,
): Promise<{ pending: Map<string, CleanupRecord>; tornTail: boolean }> {
  const { text, tornTail } = await readCleanupJournal(path.join(runsRoot, "cleanup.ndjson"));
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
// torn tail; the completing replay removes it here before appending, so a completion
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

async function repositoryRootExists(repoRoot: string): Promise<boolean> {
  // A non-absolute repoRoot is a malformed record, not a deleted repository: realpath
  // would resolve it against the process CWD and could report a corrupt record as "gone",
  // fail-open routing it into the repo-absent reconcile path. Report it present so it falls
  // through to validateRepositoryRoot's absoluteness rejection and stays fail-closed,
  // matching how every other anomalous cleanup record halts recovery for investigation.
  if (!path.isAbsolute(repoRoot)) return true;
  try {
    await realpath(repoRoot);
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

// Complete an interrupted prune whose repository was deleted after the intent was
// written. The candidate anchor and prune-backup refs died with the repository, so
// there is nothing to reconcile in Git; only the archive must converge. The checkout
// lease is intentionally skipped: it serializes Git-ref reconciliation, and this path
// performs none — a vanished repository cannot host a racing integration, and recovery
// already holds the global recovery lock.
//
// Limit of the lease-skip: the normal path's per-repo checkout lease also guarantees at
// most one pending intent per run, so a shadowed quarantine can never be orphaned. This
// path drops that lease, so IF prune were ever wired to run concurrently across processes
// (it has no such caller today — the checkout lease is prune's only cross-process guard),
// two repo-gone intents for one run could interleave and a crash after the losing rename
// could strand a quarantine dir that no surviving pending intent references. That is a
// disk-only leak, never a double-free (rename is atomic) or fail-open. Closing it needs a
// recovery sweep of `.prune-*` dirs unmatched by any pending intent; do that before wiring
// concurrent multi-process prune, not before.
async function reconcileRepoAbsentPrune(
  runsRoot: string,
  record: CleanupRecord,
  platformServices: PlatformServices,
): Promise<void> {
  const runDirectory = path.join(runsRoot, record.runId);
  const quarantinePath = path.join(runsRoot, record.quarantineName);
  const runIdentity = await plainDirectoryIdentity(runDirectory);
  const quarantineIdentity = await plainDirectoryIdentity(quarantinePath);
  if (runIdentity !== null && quarantineIdentity !== null) {
    throw new RuntimeError("both retained and quarantined run archives exist during recovery");
  }
  // Same discriminator as the normal path: a retained run rolls back (nothing was
  // removed), a quarantined run finishes (remove the archive that was moved aside).
  const action = runIdentity !== null ? "rollback" : "finish";
  if (action === "finish" && quarantineIdentity !== null) {
    await removePlainDirectory(quarantinePath, quarantineIdentity, platformServices);
  }
  await appendCleanupRecord(runsRoot, {
    ...record,
    event: action === "finish" ? "prune-cleanup-complete" : "prune-cleanup-rollback",
    anchorCleanup: "already-absent",
    recordedAt: new Date().toISOString(),
  });
}

export async function replayInterruptedPrunes(
  runsRoot: string,
  ps: PlatformServices,
): Promise<void> {
  // Read the journal and repair a torn tail as one critical section under the shared
  // journal mutex, so no concurrent append can land between the read and the truncate
  // (which would otherwise be erased). Completion appends below re-take the same lock.
  let pending: Map<string, CleanupRecord>;
  const journalLock = await getPlatformServices().acquireCleanupJournalLock();
  try {
    const read = await readPendingCleanupRecords(runsRoot);
    if (read.tornTail) await truncateCleanupTornTail(path.join(runsRoot, "cleanup.ndjson"));
    pending = read.pending;
  } finally {
    await journalLock.release();
  }
  for (const record of [...pending.values()].sort((left, right) =>
    left.runId.localeCompare(right.runId))) {
    // A repoRoot-less legacy intent has neither anchor nor repository to lock.
    if (record.repoRoot === null) continue;
    // A crash can strand a pending intent whose repository was deleted afterward.
    // Reconcile its archive without Git and move on; otherwise validateRepositoryRoot
    // below throws and aborts the entire recovery pass — a permanent block, because
    // replayInterruptedPrunes runs before every other recovery step.
    //
    // The boundary is deliberately filesystem-definitive absence (realpath ENOENT), the
    // expected "the user deleted their repo" lifecycle event. A repoRoot that still
    // exists but is no longer the canonical repository (its .git removed, replaced by a
    // file, moved so it is non-canonical, or a transient git error) is NOT treated as
    // gone: it stays fail-closed through validateRepositoryRoot below, matching how every
    // other anomalous cleanup record halts recovery for investigation. Widening this to
    // "any validation failure" would fail open — a transient git hiccup would wrongly
    // reclaim the archive and orphan a real repository's refs.
    if (!(await repositoryRootExists(record.repoRoot))) {
      await reconcileRepoAbsentPrune(runsRoot, record, ps);
      continue;
    }
    // Serialize the archive/anchor reconciliation against the checkout
    // lifecycle: hold the repository's checkout lease exactly as prune did.
    const repoRoot = await validateRepositoryRoot(record.repoRoot);
    const commonResult = await git(repoRoot, [
      "rev-parse",
      "--path-format=absolute",
      "--git-common-dir",
    ]);
    if (commonResult.exitCode !== 0) {
      throw runGitError("resolve cleanup repository identity", commonResult);
    }
    const repositoryIdentity = await realpath(gitPathOutput(
      commonResult.stdout,
      "cleanup repository identity",
    ));
    await platformSafety.withRecoveryLease(repoRoot, async (lease) => {
      if (lease.repositoryIdentity !== repositoryIdentity) {
        throw new RuntimeError("checkout lease repository identity changed during prune recovery");
      }
      const runDirectory = path.join(runsRoot, record.runId);
      const quarantinePath = path.join(runsRoot, record.quarantineName);
      const runIdentity = await plainDirectoryIdentity(runDirectory);
      const quarantineIdentity = await plainDirectoryIdentity(quarantinePath);
      if (runIdentity !== null && quarantineIdentity !== null) {
        throw new RuntimeError("both retained and quarantined run archives exist during recovery");
      }
      const action = runIdentity !== null ? "rollback" : "finish";
      const outcome = await reconcileCleanupRefs(record, action);
      if (action === "finish") {
        if (quarantineIdentity !== null) {
          await removePlainDirectory(quarantinePath, quarantineIdentity, ps);
        }
        await commitCleanupRefs(record);
      }
      await appendCleanupRecord(runsRoot, {
        ...record,
        event: action === "finish" ? "prune-cleanup-complete" : "prune-cleanup-rollback",
        anchorCleanup: outcome,
        recordedAt: new Date().toISOString(),
      });
    });
  }
}
