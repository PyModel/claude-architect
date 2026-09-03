import { createHash, randomUUID } from "node:crypto";
import { constants, type Dirent } from "node:fs";
import {
  lstat,
  link,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  rm,
} from "node:fs/promises";
import path from "node:path";
import nodeProcess from "node:process";
import {
  WorkflowBranchManager,
  workflowOwnershipRecordWorkflowId,
  workflowWorktreeOwnershipClaim,
  type WorkflowWorktreeOwnershipClaim,
  type WorkflowBranchIdentity,
  type WorkflowBranchBootstrapOwnerRecord,
} from "../autopilot/branch-manager.js";
import type { AutopilotWorkflowState } from "../autopilot/types.js";
import {
  SAFE_WORKFLOW_ID,
  TERMINAL_PHASES,
  WorkflowStore,
  type WorkflowIntentJournal,
  type WorkflowOwnerRecord,
} from "../autopilot/workflow-store.js";
import { git, type GitResult } from "../git/git-exec.js";
import { SLICE_REF_PREFIX } from "../git/ref-namespace.js";
import { gitNulRecords, gitPathOutput } from "../git/git-output.js";
import {
  canonicalizeWorktreePath,
  findWorktreeRegistration,
} from "../git/worktree-registration.js";
import {
  managedWorktreeDirectoryIdentity,
  removeMissingRegisteredWorktree,
  removeQuarantinedDirectory,
  removeRegisteredWorktree,
  restoreStagedRegistration,
  WORKTREE_REGISTRATION_QUARANTINE_DIRECTORY,
  type ManagedWorktreeDirectoryIdentity,
} from "./worktree-manager.js";
import {
  lockOwnerStatus,
  parseLockOwner,
  type LockOwnerStatus,
  type LockOwner,
  type AcquiredLock,
  type DeadLockReclaimResult,
  reclaimDeadLock,
  reclaimDeadCheckoutLocks,
  reclaimLocks,
  lockIsOwnedByLiveProcess,
  validateOwnedLockState,
  validatePublishedLock,
  removeExpectedLockPath,
  cleanupOwnedLockPaths,
  createOwnedLock,
  acquireOwnedLock,
  releaseOwnedLock,
  defaultIsProcessAlive,
} from "../platform/lock-ownership.js";
import { platformSafety } from "../platform/platform-safety.js";
import type { PlatformServices } from "../platform/platform-services.js";
import { CLEANUP_JOURNAL_LOCK_KEY } from "../platform/posix-platform-services.js";
import { getPlatformServices } from "../platform/select-platform.js";
import {
  emptyBoundDirectory,
  removeBoundEmptyDirectory,
} from "../platform/bound-directory-cleanup.js";
import type { AttemptResult } from "../protocol/attempt-result.js";
import {
  assertWindowsPrivateDirectory,
  ensurePrivateDirectory,
  syncDirectoryMetadata,
} from "../platform/durable-directory.js";
import { RuntimeError } from "../util/errors.js";
import { logger } from "../util/logger.js";
import { platformPathsEqual } from "../util/platform-path.js";
import { readStableRegularFile } from "../util/stable-file.js";
import { ArtifactStore } from "./artifact-store.js";
import { boundedRedactedDiagnostic } from "./redaction.js";
import { resolveStateDir } from "./state-dir.js";
import {
  readPendingWorktreeRemovalManifests,
  readWorktreeRemovalManifest,
  removeWorktreeRemovalManifest,
  settleLinkedWorktreeRemovalManifest,
  type WorktreeRemovalManifest,
  type WorktreeRemovalManifestIssue,
} from "./worktree-removal-manifest.js";

const NO_FOLLOW = constants.O_NOFOLLOW ?? 0;
const MAX_STATE_FILE_BYTES = 8_000_000;
const MAX_STATE_FILE_BYTES_BIGINT = BigInt(MAX_STATE_FILE_BYTES);
const SAFE_RUN_ID = /^[a-z0-9][a-z0-9._-]*$/;
const WORKFLOW_WORKTREE_NAME = /^workflow-([0-9a-f]{32})(?:-final)?$/;
const LEGACY_FINAL_WORKTREE_NAME = /^final-([0-9a-f]{24})$/;
const WORKFLOW_OWNERSHIP_NAME = /^([0-9a-f]{64})\.json$/;
const OID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const CANDIDATE_REF_PREFIX = "refs/claude-architect/candidates/";
const BACKUP_REF_PREFIX = "refs/claude-architect/prune-backups/";
const MAX_QUARANTINE_REASON_BYTES = 2_000;
const MAX_QUARANTINE_RECORD_BYTES = 4_096;
const MAX_WORKTREE_SWEEP_ISSUES = 100;

interface RunStartRecord {
  runId: string;
  lockKey: string;
  canonicalCommonDir: string;
  pid: number | null;
  processToken: string | null;
  startedAt: string;
}

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

interface RecoveryQuarantineRecord {
  event: "recovery-quarantine";
  runId: string;
  reason: string;
  recordedAt: string;
}

interface DirectoryIdentity {
  dev: bigint;
  ino: bigint;
  birthtimeNs: bigint;
}

interface RecoveryQuarantineSnapshot {
  bytes: Buffer;
  runIds: Set<string>;
  rootIdentity: DirectoryIdentity;
  journalIdentity: DirectoryIdentity | null;
}

export interface RecoveryDependencies {
  /**
   * The platform, whole. Recovery hands it to bound-directory cleanup, which
   * spawns a native helper on Windows, so a partial value cannot serve. It used
   * to be a three-method `Pick` and production grafted the missing members onto
   * the real services at every call -- a full `PlatformServices` built solely so
   * an incomplete test double would type-check. Recovery never takes a checkout
   * lease through it: leases come from `platformSafety.withRecoveryLease`.
   */
  platformServices?: PlatformServices;
  isProcessAlive?: (pid: number) => boolean;
  git?: typeof git;
}

export type AutopilotRecoveryDisposition =
  | "live-preserve"
  | "resume"
  | "finalize"
  | "dispose"
  | "human-decision-required";

export interface AutopilotRecoveryResult {
  workflowId: string;
  disposition: AutopilotRecoveryDisposition;
}

export interface RecoveryResult {
  recovered: string[];
  quarantined: string[];
  workflows?: AutopilotRecoveryResult[];
  worktreeSweepIssues?: WorktreeSweepIssue[];
}

export interface WorktreeSweepIssue {
  worktreePath: string;
  reason: string;
  repositoryIdentity?: string;
}


function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code;
}

function isMissing(error: unknown): boolean {
  return errorCode(error) === "ENOENT";
}

function isPlainDirectory(metadata: {
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}): boolean {
  return metadata.isDirectory() && !metadata.isSymbolicLink();
}

function sameManagedIdentity(
  left: ManagedWorktreeDirectoryIdentity,
  right: ManagedWorktreeDirectoryIdentity,
): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.birthtimeNs === right.birthtimeNs;
}

function sameIdentity(
  metadata: { dev: bigint; ino: bigint; birthtimeNs: bigint },
  expected: DirectoryIdentity,
): boolean {
  return metadata.dev === expected.dev
    && metadata.ino === expected.ino
    && metadata.birthtimeNs === expected.birthtimeNs;
}

function validateRunId(runId: unknown): asserts runId is string {
  if (typeof runId !== "string" || !SAFE_RUN_ID.test(runId)) {
    throw new RuntimeError("recovery record has an invalid run id");
  }
}

async function stateRoot(): Promise<string | null> {
  const configured = nodeProcess.env.CLAUDE_PLUGIN_DATA
    ?? (nodeProcess.env.NODE_ENV === "test"
      ? nodeProcess.env.CLAUDE_ARCHITECT_STATE_DIR
      : undefined);
  if (configured === undefined) return null;
  const root = path.resolve(resolveStateDir());
  try {
    const metadata = await lstat(root, { bigint: true });
    if (!isPlainDirectory(metadata) || metadata.birthtimeNs <= 0n) {
      throw new RuntimeError("plugin data directory must be a stable plain directory during recovery");
    }
    const canonicalRoot = await realpath(root);
    const settled = await lstat(canonicalRoot, { bigint: true });
    if (!isPlainDirectory(settled)
      || settled.dev !== metadata.dev
      || settled.ino !== metadata.ino
      || settled.birthtimeNs !== metadata.birthtimeNs) {
      throw new RuntimeError("plugin data directory identity changed during canonicalization");
    }
    const privateIdentity = await assertPrivateRecoveryDirectory(canonicalRoot);
    if (!sameIdentity(privateIdentity, {
      dev: metadata.dev,
      ino: metadata.ino,
      birthtimeNs: metadata.birthtimeNs,
    })) {
      throw new RuntimeError("plugin data directory identity changed during privacy validation");
    }
    return canonicalRoot;
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

async function readBoundedRegularFile(filename: string): Promise<string | null> {
  try {
    const contents = await readStableRegularFile(filename, MAX_STATE_FILE_BYTES_BIGINT);
    if (contents === null) {
      throw new RuntimeError("recovery state entry is not a stable bounded regular file");
    }
    return contents.toString("utf8");
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
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

async function assertPrivateRecoveryDirectory(directory: string): Promise<DirectoryIdentity> {
  return await ensurePrivateDirectory(directory, {
    description: "recovery directory",
    create: false,
    migratePermissions: true,
  });
}

async function plainDirectoryIdentity(directory: string): Promise<DirectoryIdentity | null> {
  try {
    const metadata = await lstat(directory, { bigint: true });
    if (!isPlainDirectory(metadata)) {
      throw new RuntimeError("recovery directory must not be a symbolic link");
    }
    return {
      dev: metadata.dev,
      ino: metadata.ino,
      birthtimeNs: metadata.birthtimeNs,
    };
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

function parseRunStart(text: string, expectedRunId: string): RunStartRecord {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (cause) {
    throw new RuntimeError("run-start recovery record is invalid JSON", { cause });
  }
  if (typeof value !== "object" || value === null) {
    throw new RuntimeError("run-start recovery record must be an object");
  }
  const record = value as Partial<RunStartRecord>;
  validateRunId(record.runId);
  if (record.runId !== expectedRunId
    || typeof record.lockKey !== "string"
    || !/^[0-9a-f]{64}$/.test(record.lockKey)
    || typeof record.canonicalCommonDir !== "string"
    || !path.isAbsolute(record.canonicalCommonDir)
    || (record.pid !== null
      && (record.pid === undefined || !Number.isSafeInteger(record.pid) || record.pid <= 1))
    || (record.processToken !== undefined
      && record.processToken !== null
      && typeof record.processToken !== "string")
    || typeof record.startedAt !== "string"
    || !Number.isFinite(Date.parse(record.startedAt))) {
    throw new RuntimeError("run-start recovery record is malformed");
  }
  const expectedLockKey = createHash("sha256")
    .update(record.canonicalCommonDir)
    .digest("hex");
  if (record.lockKey !== expectedLockKey) {
    throw new RuntimeError("run-start lock key does not match its canonical common directory");
  }
  return { ...record, processToken: record.processToken ?? null } as RunStartRecord;
}

function validateTerminalResult(result: unknown, runId: string): void {
  if (typeof result !== "object" || result === null) {
    throw new RuntimeError("terminal attempt result is malformed during recovery");
  }
  const value = result as { resultVersion?: unknown; runId?: unknown; status?: unknown };
  if (value.resultVersion !== "1"
    || value.runId !== runId
    || typeof value.status !== "string"
    || !["unavailable", "failed", "cancelled", "verified-candidate"].includes(value.status)) {
    throw new RuntimeError("terminal attempt result is malformed during recovery");
  }
}

function runGitError(action: string, result: GitResult): RuntimeError {
  const diagnostic = (result.stderr || result.stdout).trim().slice(0, 2_000);
  return new RuntimeError(`${action} failed${diagnostic ? `: ${diagnostic}` : ""}`);
}

async function validateGitCommonDir(commonDir: string): Promise<string> {
  const canonical = await realpath(commonDir);
  if (canonical !== commonDir) {
    throw new RuntimeError("recorded Git common directory is no longer canonical");
  }
  const result = await git(canonical, [
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir",
  ]);
  if (result.exitCode !== 0) throw runGitError("validate Git common directory", result);
  const reported = await realpath(gitPathOutput(
    result.stdout,
    "Git common directory",
  ));
  if (reported !== canonical) {
    throw new RuntimeError("recorded Git common directory no longer identifies the repository");
  }
  return canonical;
}

async function validateRepositoryRoot(repoRoot: string): Promise<string> {
  if (!path.isAbsolute(repoRoot)) {
    throw new RuntimeError("cleanup journal repository root is not absolute");
  }
  const canonical = await realpath(repoRoot);
  if (canonical !== repoRoot) {
    throw new RuntimeError("cleanup journal repository root is no longer canonical");
  }
  const result = await git(canonical, ["rev-parse", "--show-toplevel"]);
  if (result.exitCode !== 0) throw runGitError("validate cleanup repository", result);
  if (await realpath(gitPathOutput(result.stdout, "Git repository root")) !== canonical) {
    throw new RuntimeError("cleanup journal repository root is not the repository top level");
  }
  return canonical;
}

async function readDirectRef(
  repoRoot: string,
  ref: string,
  runGit: typeof git = git,
): Promise<string | null> {
  const symbolic = await runGit(repoRoot, ["symbolic-ref", "--quiet", ref]);
  if (symbolic.exitCode === 0) {
    throw new RuntimeError("recovery refuses to mutate a symbolic Git ref");
  }
  if (symbolic.exitCode !== 1) throw runGitError("inspect symbolic Git ref", symbolic);
  const direct = await runGit(repoRoot, ["rev-parse", "--verify", "--quiet", ref]);
  if (direct.exitCode === 1) return null;
  if (direct.exitCode !== 0 || !OID.test(direct.stdout.trim())) {
    throw runGitError("inspect Git ref", direct);
  }
  return direct.stdout.trim();
}

async function deleteExactRef(
  repoRoot: string,
  ref: string,
  oid: string,
  runGit: typeof git = git,
): Promise<void> {
  const result = await runGit(repoRoot, ["update-ref", "--no-deref", "-d", ref, oid]);
  if (result.exitCode !== 0) throw runGitError("delete recovery Git ref", result);
}

async function removeStaleCandidateAnchor(repoRoot: string, runId: string): Promise<void> {
  const ref = `${CANDIDATE_REF_PREFIX}${runId}`;
  const oid = await readDirectRef(repoRoot, ref);
  if (oid !== null) await deleteExactRef(repoRoot, ref, oid);
}

async function archiveInterruptedPipeline(
  store: ArtifactStore,
  result: AttemptResult,
): Promise<void> {
  if (result.status !== "verified-candidate") return;
  const manifest = await store.readManifest();
  if (manifest === null) {
    throw new RuntimeError("run manifest is missing while recovering interrupted pipeline");
  }
  const failed: AttemptResult = {
    ...result,
    status: "failed",
    failure: "verification-failure",
    summary: "Delegation pipeline was interrupted before trusted gates completed.",
    unresolvedIssues: [
      ...result.unresolvedIssues,
      "pipeline-interrupted-before-terminal-cleanup",
    ],
    evidence: {
      ...result.evidence,
      pipelineRecovery: "interrupted-before-terminal-cleanup",
    },
  };
  await store.promoteTerminalArtifacts({ result: failed, manifest });
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

interface TemporarySliceRef {
  ref: string;
  oid: string;
}

async function temporarySliceRefs(
  repoRoot: string,
  runId: string,
  runGit: typeof git,
): Promise<TemporarySliceRef[]> {
  const prefix = `${SLICE_REF_PREFIX}${runId}/`;
  const listed = await runGit(repoRoot, [
    "for-each-ref",
    "--format=%(refname)%09%(objectname)",
    prefix,
  ]);
  if (listed.exitCode !== 0) throw runGitError("enumerate temporary slice refs", listed);
  const expectedName = new RegExp(
    `^${escapeRegex(prefix)}slice-[1-9][0-9]*-attempt-(?:0|[1-9][0-9]*)$`,
  );
  const refs: TemporarySliceRef[] = [];
  for (const line of listed.stdout.split("\n").filter(Boolean)) {
    const fields = line.split("\t");
    if (fields.length !== 2 || fields[0] === undefined || !expectedName.test(fields[0])) {
      throw new RuntimeError("temporary slice ref name is malformed during recovery");
    }
    if (fields[1] === undefined || !OID.test(fields[1])) {
      throw new RuntimeError("temporary slice ref OID is malformed during recovery");
    }
    const object = await runGit(repoRoot, ["cat-file", "-t", fields[1]], {
      env: { GIT_NO_REPLACE_OBJECTS: "1" },
    });
    if (object.exitCode !== 0 || object.stdout.trim() !== "commit") {
      throw new RuntimeError("temporary slice ref does not identify a commit during recovery");
    }
    refs.push({ ref: fields[0], oid: fields[1] });
  }
  for (const temporaryRef of refs) {
    const current = await readDirectRef(repoRoot, temporaryRef.ref, runGit);
    if (current !== temporaryRef.oid) {
      throw new RuntimeError("temporary slice ref moved during recovery");
    }
  }
  return refs;
}

async function cleanupTemporarySliceRefs(
  repoRoot: string,
  runId: string,
  runGit: typeof git,
): Promise<void> {
  const refs = await temporarySliceRefs(repoRoot, runId, runGit);
  for (const temporaryRef of refs) {
    await deleteExactRef(repoRoot, temporaryRef.ref, temporaryRef.oid, runGit);
  }
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

async function readRecoveryQuarantineJournal(
  runsRoot: string,
): Promise<RecoveryQuarantineSnapshot> {
  const rootIdentity = await plainDirectoryIdentity(runsRoot);
  if (rootIdentity === null) {
    throw new RuntimeError("recovery quarantine journal root disappeared");
  }
  const filename = path.join(runsRoot, "recovery-quarantine.ndjson");
  let expectedMetadata;
  try {
    expectedMetadata = await lstat(filename, { bigint: true });
  } catch (error) {
    if (!isMissing(error)) throw error;
    const currentRoot = await lstat(runsRoot, { bigint: true });
    if (!isPlainDirectory(currentRoot) || !sameIdentity(currentRoot, rootIdentity)) {
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
        if (isPlainDirectory(currentRoot) && sameIdentity(currentRoot, rootIdentity)) {
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
      || !sameIdentity(currentRoot, rootIdentity)) {
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
      || !sameIdentity(settledRoot, rootIdentity)) {
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
  filename: string,
  snapshot: RecoveryQuarantineSnapshot,
  nextBytes: Buffer,
): Promise<void> {
  const temporaryPath = path.join(
    runsRoot,
    `.recovery-quarantine-journal-${randomUUID()}.tmp`,
  );
  let handle;
  let temporaryCreated = false;
  let temporaryConsumed = false;
  let linkedPublication = false;
  let temporaryIdentity: DirectoryIdentity | undefined;
  let primaryError: unknown;
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
    const namedMetadata = await lstat(temporaryPath, { bigint: true });
    const currentRoot = await lstat(runsRoot, { bigint: true });
    if (!metadata.isFile()
      || metadata.nlink !== 1n
      || !namedMetadata.isFile()
      || namedMetadata.isSymbolicLink()
      || namedMetadata.nlink !== 1n
      || namedMetadata.dev !== metadata.dev
      || namedMetadata.ino !== metadata.ino
      || namedMetadata.birthtimeNs !== metadata.birthtimeNs
      || metadata.size > MAX_STATE_FILE_BYTES_BIGINT
      || !isPlainDirectory(currentRoot)
      || !sameIdentity(currentRoot, snapshot.rootIdentity)) {
      throw new RuntimeError("recovery quarantine journal temp changed during creation");
    }
    await handle.writeFile(nextBytes);
    await handle.sync();
    await validateOwnedLockState(
      handle,
      [temporaryPath],
      temporaryIdentity,
      nextBytes,
      1,
      runsRoot,
      snapshot.rootIdentity,
    );
  } catch (error) {
    primaryError = error;
  }
  if (handle !== undefined) {
    try {
      await handle.close();
    } catch (closeError) {
      if (primaryError !== undefined) {
        primaryError = new AggregateError(
          [primaryError, closeError],
          "recovery quarantine journal temp failed and its handle could not be closed",
        );
      } else {
        primaryError = closeError;
      }
    }
  }
  if (primaryError === undefined) {
    try {
      if (temporaryIdentity === undefined) {
        throw new RuntimeError("recovery quarantine journal temp identity is unavailable");
      }
      await validatePublishedLock(
        temporaryPath,
        temporaryIdentity,
        nextBytes,
        runsRoot,
        snapshot.rootIdentity,
      );
      const currentSnapshot = await readRecoveryQuarantineJournal(runsRoot);
      const sameJournalIdentity = snapshot.journalIdentity === null
        ? currentSnapshot.journalIdentity === null
        : currentSnapshot.journalIdentity !== null
          && currentSnapshot.journalIdentity.dev === snapshot.journalIdentity.dev
          && currentSnapshot.journalIdentity.ino === snapshot.journalIdentity.ino
          && currentSnapshot.journalIdentity.birthtimeNs === snapshot.journalIdentity.birthtimeNs;
      if (currentSnapshot.rootIdentity.dev !== snapshot.rootIdentity.dev
        || currentSnapshot.rootIdentity.ino !== snapshot.rootIdentity.ino
        || currentSnapshot.rootIdentity.birthtimeNs !== snapshot.rootIdentity.birthtimeNs
        || !sameJournalIdentity
        || !currentSnapshot.bytes.equals(snapshot.bytes)) {
        throw new RuntimeError("recovery quarantine journal changed before publication");
      }
      if (snapshot.journalIdentity === null) {
        await link(temporaryPath, filename);
        linkedPublication = true;
        await validatePublishedLock(
          temporaryPath,
          temporaryIdentity,
          nextBytes,
          runsRoot,
          snapshot.rootIdentity,
          2,
          [temporaryPath, filename],
        );
        const removal = await removeExpectedLockPath(
          temporaryPath,
          temporaryIdentity,
          nextBytes,
          2,
        );
        if (removal === "changed") {
          throw new RuntimeError("recovery quarantine journal temp changed before unlink");
        }
        temporaryConsumed = true;
      } else {
        await rename(temporaryPath, filename);
        temporaryConsumed = true;
      }
    } catch (error) {
      primaryError = error;
    }
  }
  const cleanupErrors: unknown[] = [];
  if (temporaryCreated && !temporaryConsumed) {
    if (temporaryIdentity === undefined) {
      cleanupErrors.push(new RuntimeError(
        "recovery quarantine journal temp identity is unavailable for cleanup",
      ));
    } else {
      cleanupErrors.push(...await cleanupOwnedLockPaths(
        runsRoot,
        snapshot.rootIdentity,
        temporaryPath,
        filename,
        temporaryIdentity,
        nextBytes,
        linkedPublication,
      ));
    }
  }
  if (primaryError !== undefined && cleanupErrors.length > 0) {
    throw new AggregateError(
      [primaryError, ...cleanupErrors],
      "recovery quarantine journal publication and temp cleanup failed",
    );
  }
  if (primaryError !== undefined) throw primaryError;
  if (cleanupErrors.length === 1) throw cleanupErrors[0];
  if (cleanupErrors.length > 1) {
    throw new AggregateError(cleanupErrors, "recovery quarantine journal temp cleanup failed");
  }

  const publishedSnapshot = await readRecoveryQuarantineJournal(runsRoot);
  if (temporaryIdentity === undefined
    || publishedSnapshot.journalIdentity === null
    || publishedSnapshot.journalIdentity.dev !== temporaryIdentity.dev
    || publishedSnapshot.journalIdentity.ino !== temporaryIdentity.ino
    || publishedSnapshot.journalIdentity.birthtimeNs !== temporaryIdentity.birthtimeNs
    || publishedSnapshot.rootIdentity.dev !== snapshot.rootIdentity.dev
    || publishedSnapshot.rootIdentity.ino !== snapshot.rootIdentity.ino
    || publishedSnapshot.rootIdentity.birthtimeNs !== snapshot.rootIdentity.birthtimeNs
    || !publishedSnapshot.bytes.equals(nextBytes)) {
    throw new RuntimeError("recovery quarantine journal changed after publication");
  }
  await syncRecoveryDirectory(runsRoot);
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
  const filename = path.join(runsRoot, "recovery-quarantine.ndjson");
  const snapshot = await readRecoveryQuarantineJournal(runsRoot);
  if (snapshot.runIds.has(record.runId)) {
    await syncRecoveryDirectory(runsRoot);
    const settledSnapshot = await readRecoveryQuarantineJournal(runsRoot);
    if (settledSnapshot.rootIdentity.dev !== snapshot.rootIdentity.dev
      || settledSnapshot.rootIdentity.ino !== snapshot.rootIdentity.ino
      || settledSnapshot.rootIdentity.birthtimeNs !== snapshot.rootIdentity.birthtimeNs
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
  await publishRecoveryQuarantineJournal(runsRoot, filename, snapshot, nextBytes);
}

async function quarantineRun(
  runsRoot: string,
  runId: string,
  error: unknown,
): Promise<void> {
  const runDirectory = path.join(runsRoot, runId);
  const quarantinePath = path.join(runsRoot, `.poisoned-${runId}`);
  const runsIdentity = await plainDirectoryIdentity(runsRoot);
  if (runsIdentity === null) throw new RuntimeError("recovery runs root disappeared");
  let runIdentity: DirectoryIdentity | null = null;
  let renamed = false;
  let journaled = false;
  try {
    runIdentity = await plainDirectoryIdentity(runDirectory);
    if (runIdentity === null) throw new RuntimeError("poisoned recovery run disappeared");
    if (await plainDirectoryIdentity(quarantinePath) !== null) {
      throw new RuntimeError("poisoned recovery quarantine already exists");
    }
    await rename(runDirectory, quarantinePath);
    renamed = true;
    const quarantineIdentity = await plainDirectoryIdentity(quarantinePath);
    const currentRoot = await lstat(runsRoot, { bigint: true });
    if (quarantineIdentity === null
      || quarantineIdentity.dev !== runIdentity.dev
      || quarantineIdentity.ino !== runIdentity.ino
      || quarantineIdentity.birthtimeNs !== runIdentity.birthtimeNs
      || !isPlainDirectory(currentRoot)
      || !sameIdentity(currentRoot, runsIdentity)) {
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
          || !sameIdentity(quarantineMetadata, runIdentity)
          || await plainDirectoryIdentity(runDirectory) !== null
          || !isPlainDirectory(currentRoot)
          || !sameIdentity(currentRoot, runsIdentity)) {
          throw new RuntimeError("poisoned recovery rollback identity or destination is unsafe");
        }
        await rename(quarantinePath, runDirectory);
        const restoredMetadata = await lstat(runDirectory, { bigint: true });
        const restoredRoot = await lstat(runsRoot, { bigint: true });
        if (!isPlainDirectory(restoredMetadata)
          || !sameIdentity(restoredMetadata, runIdentity)
          || !isPlainDirectory(restoredRoot)
          || !sameIdentity(restoredRoot, runsIdentity)) {
          throw new RuntimeError("poisoned recovery rollback identity changed");
        }
        await syncRecoveryDirectory(runsRoot);
        const settledMetadata = await lstat(runDirectory, { bigint: true });
        const settledRoot = await lstat(runsRoot, { bigint: true });
        if (!isPlainDirectory(settledMetadata)
          || !sameIdentity(settledMetadata, runIdentity)
          || !isPlainDirectory(settledRoot)
          || !sameIdentity(settledRoot, runsIdentity)) {
          throw new RuntimeError("poisoned recovery rollback changed after directory sync");
        }
      } catch (rollbackError) {
        errors.push(rollbackError);
      }
    }
    throw new AggregateError(errors, "run recovery failed and quarantine did not complete");
  }
}

async function removePlainDirectory(
  directory: string,
  expected: DirectoryIdentity,
  platformServices: PlatformServices,
): Promise<void> {
  const metadata = await lstat(directory, { bigint: true });
  if (!isPlainDirectory(metadata) || !sameIdentity(metadata, expected)) {
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
      if (!metadata.isFile() || !isPlainDirectory(currentRoot) || !sameIdentity(currentRoot, identity)) {
        throw new RuntimeError("cleanup journal identity changed during recovery");
      }
      await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    const currentRoot = await lstat(runsRoot, { bigint: true });
    if (!isPlainDirectory(currentRoot) || !sameIdentity(currentRoot, identity)) {
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

async function replayInterruptedPrunes(
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


async function managedWorktreeMarkerIsPresent(worktreePath: string): Promise<boolean> {
  let marker;
  try {
    marker = await lstat(path.join(worktreePath, ".git"), { bigint: true });
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
  if (!marker.isFile() || marker.isSymbolicLink() || marker.nlink !== 1n) {
    throw new RuntimeError("managed worktree repository marker is ambiguous");
  }
  return true;
}

async function removeManagedWorktreeUnderLease(
  commonDir: string,
  worktreePath: string,
  expectedIdentity: ManagedWorktreeDirectoryIdentity,
  runGit: typeof git,
): Promise<void> {
  const currentIdentity = await managedWorktreeDirectoryIdentity(worktreePath);
  if (currentIdentity === null) return;
  if (currentIdentity.dev !== expectedIdentity.dev
    || currentIdentity.ino !== expectedIdentity.ino
    || currentIdentity.birthtimeNs !== expectedIdentity.birthtimeNs) {
    throw new RuntimeError("worktree directory identity changed under checkout lease");
  }
  if (await managedWorktreeMarkerIsPresent(worktreePath)) {
    const resolved = await runGit(worktreePath, [
      "rev-parse", "--path-format=absolute", "--git-common-dir",
    ]);
    if (resolved.truncated?.stdout === true || resolved.truncated?.stderr === true) {
      throw new RuntimeError("worktree repository lookup was truncated under checkout lease");
    }
    if (resolved.exitCode !== 0) {
      throw runGitError("resolve worktree repository under checkout lease", resolved);
    }
    const reportedCommonDir = gitPathOutput(
      resolved.stdout,
      "managed worktree common directory",
    );
    if (!path.isAbsolute(reportedCommonDir)
      || await realpath(reportedCommonDir) !== commonDir) {
      throw new RuntimeError("managed worktree belongs to a different repository");
    }
  }
  const listed = await runGit(commonDir, ["worktree", "list", "--porcelain", "-z"]);
  if (listed.exitCode !== 0
    || listed.truncated?.stdout === true
    || listed.truncated?.stderr === true) {
    throw runGitError("recheck worktree registration", listed);
  }
  const registered = await findWorktreeRegistration(
    gitNulRecords(listed.stdout, "rechecked Git worktree list"),
    worktreePath,
  ) !== -1;
  if (!registered) {
    throw new RuntimeError("managed worktree registration is absent");
  }
  await removeRegisteredWorktree(
    commonDir,
    worktreePath,
    { git: runGit },
    expectedIdentity,
  );
}

function mostSpecificKnownRunClaim(
  knownRunIds: ReadonlySet<string>,
  managedId: string,
): string | undefined {
  let owner: string | undefined;
  for (const runId of knownRunIds) {
    if (runClaimsWorktree(runId, managedId)
      && (owner === undefined || runId.length > owner.length)) owner = runId;
  }
  return owner;
}

async function cleanupRunWorktreesUnderLease(
  root: string,
  commonDir: string,
  runId: string,
  runGit: typeof git,
  knownRunIds: ReadonlySet<string>,
): Promise<void> {
  const worktreesRoot = path.join(root, "worktrees");
  const worktreesIdentity = await plainDirectoryIdentity(worktreesRoot);
  if (worktreesIdentity !== null) {
    const entries = await readdir(worktreesRoot, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (!entry.isDirectory()
        || entry.isSymbolicLink()
        || !runClaimsWorktree(runId, entry.name)
        || mostSpecificKnownRunClaim(knownRunIds, entry.name) !== runId) continue;
      const worktreePath = path.join(worktreesRoot, entry.name);
      const identity = await managedWorktreeDirectoryIdentity(worktreePath);
      if (identity !== null) {
        await removeManagedWorktreeUnderLease(commonDir, worktreePath, identity, runGit);
      }
    }
  }

  // A crash or external removal can erase the physical directory before its
  // exact Git registration is cleaned. Such a path cannot be discovered by
  // scanning the state directory, so inspect this run's known repository while
  // its checkout lease is held and remove only registrations in the managed
  // root whose complete run-id boundary matches.
  const listed = await runGit(commonDir, ["worktree", "list", "--porcelain", "-z"]);
  if (listed.exitCode !== 0
    || listed.truncated?.stdout === true
    || listed.truncated?.stderr === true) {
    throw runGitError("enumerate missing run worktree registrations", listed);
  }
  const canonicalWorktreesRoot = worktreesIdentity === null
    ? path.join(await realpath(root), "worktrees")
    : await realpath(worktreesRoot);
  for (const field of gitNulRecords(listed.stdout, "missing-run Git worktree list")) {
    if (!field.startsWith("worktree ")) continue;
    const reportedWorktreePath = path.resolve(field.slice("worktree ".length));
    let worktreePath: string;
    try {
      worktreePath = await canonicalizeWorktreePath(reportedWorktreePath, true);
    } catch (error) {
      if (!isMissing(error) || worktreesIdentity !== null) throw error;
      const reportedRoot = path.dirname(reportedWorktreePath);
      worktreePath = path.join(
        await realpath(path.dirname(reportedRoot)),
        path.basename(reportedRoot),
        path.basename(reportedWorktreePath),
      );
    }
    if (!platformPathsEqual(path.dirname(worktreePath), canonicalWorktreesRoot)
      || !runClaimsWorktree(runId, path.basename(worktreePath))
      || mostSpecificKnownRunClaim(knownRunIds, path.basename(worktreePath)) !== runId
      || await managedWorktreeDirectoryIdentity(worktreePath) !== null) continue;
    await removeMissingRegisteredWorktree(commonDir, worktreePath, { git: runGit });
  }
}

async function recoverRun(
  record: RunStartRecord,
  root: string,
  ps: Pick<PlatformServices, "getProcessStartToken" | "terminateProcessTreeByPid">,
  isProcessAlive: (pid: number) => boolean,
  runGit: typeof git = git,
  worktreeCleanupAllowed = true,
  knownRunIds: ReadonlySet<string> = new Set([record.runId]),
): Promise<"recovered" | "live-preserve"> {
  if (record.pid !== null && isProcessAlive(record.pid)) {
    if (record.processToken === null) return "live-preserve";
    let observedToken: string | null;
    try {
      observedToken = await ps.getProcessStartToken(record.pid);
    } catch {
      return "live-preserve";
    }
    if (observedToken === null) return "live-preserve";
    if (observedToken === record.processToken) {
      await ps.terminateProcessTreeByPid(record.pid, record.processToken);
    }
  }
  if (!worktreeCleanupAllowed) {
    throw new RuntimeError("pending worktree removal ambiguity deferred stale-run cleanup");
  }
  const commonDir = await validateGitCommonDir(record.canonicalCommonDir);
  const store = new ArtifactStore(record.runId);
  const logsRef = await store.writeLog(
    "recovery",
    "startup recovery reclaimed unfinished run\n",
  );
  await cleanupRunWorktreesUnderLease(root, commonDir, record.runId, runGit, knownRunIds);
  await cleanupTemporarySliceRefs(commonDir, record.runId, runGit);
  await removeStaleCandidateAnchor(commonDir, record.runId);
  await store.writeResult({
    resultVersion: "1",
    runId: record.runId,
    status: "cancelled",
    failure: "cancelled",
    summary: "Interrupted attempt was cancelled during startup recovery.",
    producerSummary: null,
    candidate: null,
    requestedVerification: [],
    executedVerification: [],
    unresolvedIssues: ["attempt-interrupted-before-terminal-result"],
    evidence: {
      recovery: "startup-stale-run",
      originalStartedAt: record.startedAt,
    },
    logsRef,
    producerId: null,
    producerVersion: null,
    producerModel: null,
    durationMs: 0,
    sessionId: null,
  });
  return "recovered";
}

async function readHandleBytes(
  handle: Awaited<ReturnType<typeof open>>,
  size: number,
): Promise<Buffer> {
  const contents = Buffer.alloc(size);
  let offset = 0;
  while (offset < size) {
    const { bytesRead } = await handle.read(
      contents,
      offset,
      size - offset,
      offset,
    );
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  return contents.subarray(0, offset);
}


async function assertRegistrationBacklink(
  registrationPath: string,
  expectedPhysicalPath: string,
): Promise<void> {
  const backlink = await readStableRegularFile(path.join(registrationPath, "gitdir"), 32_768n);
  if (backlink === null) {
    throw new RuntimeError("worktree registration backlink is absent or unstable");
  }
  const reportedDotGit = gitPathOutput(
    backlink.toString("utf8"),
    "worktree registration backlink",
  );
  if (!path.isAbsolute(reportedDotGit) || path.basename(reportedDotGit) !== ".git") {
    throw new RuntimeError("worktree registration backlink is malformed");
  }
  const [reportedPhysicalPath, canonicalExpectedPhysicalPath] = await Promise.all([
    canonicalizeWorktreePath(path.dirname(reportedDotGit), true),
    canonicalizeWorktreePath(expectedPhysicalPath, true),
  ]);
  if (!platformPathsEqual(reportedPhysicalPath, canonicalExpectedPhysicalPath)) {
    throw new RuntimeError("worktree registration backlink names a different physical worktree");
  }
}

async function findCreationRegistration(
  registrationRoot: string,
  physicalPath: string,
): Promise<string | null> {
  const matches: string[] = [];
  for (const entry of await readdir(registrationRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const registrationPath = path.join(registrationRoot, entry.name);
    const contents = await readStableRegularFile(
      path.join(registrationPath, "gitdir"),
      32_768n,
    );
    if (contents === null) continue;
    let backlink: string;
    try {
      backlink = gitPathOutput(contents.toString("utf8"), "creation registration backlink");
    } catch {
      continue;
    }
    if (path.isAbsolute(backlink)
      && path.basename(backlink) === ".git"
      && platformPathsEqual(path.resolve(path.dirname(backlink)), physicalPath)) {
      matches.push(registrationPath);
    }
  }
  if (matches.length > 1) {
    throw new RuntimeError("worktree creation registration is ambiguous");
  }
  return matches[0] ?? null;
}

async function findCreationPhysicalRoot(
  stateDirectory: string,
  expected: ManagedWorktreeDirectoryIdentity,
): Promise<string | null> {
  const matches: string[] = [];
  for (const entry of await readdir(stateDirectory, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const candidate = path.join(stateDirectory, entry.name);
    const identity = await managedWorktreeDirectoryIdentity(candidate);
    if (identity !== null && sameManagedIdentity(identity, expected)) matches.push(candidate);
  }
  if (matches.length > 1) {
    throw new RuntimeError("worktree creation root identity is ambiguous");
  }
  return matches[0] ?? null;
}

async function findManagedChildByIdentity(
  root: string,
  expected: ManagedWorktreeDirectoryIdentity,
): Promise<string | null> {
  const matches: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const candidate = path.join(root, entry.name);
    const identity = await managedWorktreeDirectoryIdentity(candidate);
    if (identity !== null && sameManagedIdentity(identity, expected)) matches.push(candidate);
  }
  if (matches.length > 1) {
    throw new RuntimeError("managed directory identity appears at multiple paths");
  }
  return matches[0] ?? null;
}

async function recoverWorktreeCreationIntent(
  manifestPath: string,
  manifest: WorktreeRemovalManifest,
  platformServices: PlatformServices,
  syncDirectory: (directory: string) => Promise<void>,
  temporaryPath?: string,
  temporaryKind?: "linked",
): Promise<void> {
  const root = await stateRoot();
  if (root === null) throw new RuntimeError("runtime state root is unavailable");
  const expectedPhysicalRootPath = path.join(root, "worktrees");
  if (!path.isAbsolute(manifest.physicalPath)
    || path.resolve(manifest.physicalPath) !== manifest.physicalPath
    || !platformPathsEqual(path.dirname(manifest.physicalPath), expectedPhysicalRootPath)
    || path.basename(manifest.physicalPath) === ""
    || !path.isAbsolute(manifest.physicalQuarantinePath)
    || path.resolve(manifest.physicalQuarantinePath) !== manifest.physicalQuarantinePath
    || !platformPathsEqual(
      path.dirname(manifest.physicalQuarantinePath),
      expectedPhysicalRootPath,
    )
    || path.basename(manifest.physicalQuarantinePath)
      !== `.create-${path.basename(manifest.physicalPath)}-${manifest.transactionId}`
    || !path.isAbsolute(manifest.commonDir)
    || !path.isAbsolute(manifest.registrationRoot)
    || !path.isAbsolute(manifest.quarantineRoot)
    || !path.isAbsolute(manifest.quarantinePath)
    || !platformPathsEqual(
      manifest.registrationRoot,
      path.join(manifest.commonDir, "worktrees"),
    )
    || !platformPathsEqual(path.dirname(manifest.quarantinePath), manifest.quarantineRoot)
    || path.basename(manifest.quarantinePath)
      !== `.remove-registration-creation-${manifest.transactionId}`) {
    throw new RuntimeError("worktree creation intent paths are inconsistent");
  }
  const expectedCommonDir = {
    dev: BigInt(manifest.commonDirDev),
    ino: BigInt(manifest.commonDirIno),
    birthtimeNs: BigInt(manifest.commonDirBirthtimeNs),
  };
  const expectedPhysicalRoot = {
    dev: BigInt(manifest.physicalRootDev),
    ino: BigInt(manifest.physicalRootIno),
    birthtimeNs: BigInt(manifest.physicalRootBirthtimeNs),
  };
  const expectedRegistrationRoot = {
    dev: BigInt(manifest.registrationRootDev),
    ino: BigInt(manifest.registrationRootIno),
    birthtimeNs: BigInt(manifest.registrationRootBirthtimeNs),
  };
  const expectedQuarantineRoot = {
    dev: BigInt(manifest.quarantineRootDev),
    ino: BigInt(manifest.quarantineRootIno),
    birthtimeNs: BigInt(manifest.quarantineRootBirthtimeNs),
  };
  const commonDir = await realpath(manifest.commonDir);
  const registrationRoot = await realpath(manifest.registrationRoot);
  const quarantineRoot = await realpath(manifest.quarantineRoot);
  const [commonIdentity, registrationRootIdentity, quarantineRootIdentity] =
    await Promise.all([
      managedWorktreeDirectoryIdentity(commonDir),
      managedWorktreeDirectoryIdentity(registrationRoot),
      managedWorktreeDirectoryIdentity(quarantineRoot),
    ]);
  if (!platformPathsEqual(commonDir, manifest.commonDir)
    || !platformPathsEqual(registrationRoot, manifest.registrationRoot)
    || !platformPathsEqual(quarantineRoot, manifest.quarantineRoot)
    || commonIdentity === null
    || !sameManagedIdentity(commonIdentity, expectedCommonDir)
    || registrationRootIdentity === null
    || !sameManagedIdentity(registrationRootIdentity, expectedRegistrationRoot)
    || quarantineRootIdentity === null
    || !sameManagedIdentity(quarantineRootIdentity, expectedQuarantineRoot)) {
    throw new RuntimeError("worktree creation intent repository identity changed");
  }

  await platformSafety.withRecoveryLease(commonDir, async (lease) => {
    if (!platformPathsEqual(lease.repositoryIdentity, commonDir)) {
      throw new RuntimeError("worktree creation recovery lease identity mismatch");
    }
    if (temporaryPath !== undefined && temporaryKind === "linked") {
      await settleLinkedWorktreeRemovalManifest(
        manifestPath,
        temporaryPath,
        manifest.transactionId,
      );
    }
    const lockedManifest = await readWorktreeRemovalManifest(
      manifestPath,
      manifest.transactionId,
    );
    if (lockedManifest === null
      || JSON.stringify(lockedManifest) !== JSON.stringify(manifest)) {
      throw new RuntimeError("worktree creation intent changed before recovery lease");
    }
    const physicalRoot = await findCreationPhysicalRoot(root, expectedPhysicalRoot);
    if (physicalRoot === null) {
      throw new RuntimeError("worktree creation root moved outside the managed state directory");
    }
    const expectedPhysical = manifest.physicalPresent
      ? {
        dev: BigInt(manifest.physicalDev),
        ino: BigInt(manifest.physicalIno),
        birthtimeNs: BigInt(manifest.physicalBirthtimeNs),
      }
      : null;
    const finalPhysicalPath = physicalRoot === null
      ? null
      : path.join(physicalRoot, path.basename(manifest.physicalPath));
    const stagedPhysicalPath = physicalRoot === null
      ? null
      : path.join(physicalRoot, path.basename(manifest.physicalQuarantinePath));
    const [finalPhysicalIdentity, stagedPhysicalIdentity] = await Promise.all([
      finalPhysicalPath === null
        ? null
        : managedWorktreeDirectoryIdentity(finalPhysicalPath),
      stagedPhysicalPath === null
        ? null
        : managedWorktreeDirectoryIdentity(stagedPhysicalPath),
    ]);
    if (finalPhysicalIdentity !== null && stagedPhysicalIdentity !== null) {
      throw new RuntimeError("worktree creation placeholder exists at two paths");
    }
    const physicalPath = finalPhysicalIdentity !== null
      ? finalPhysicalPath
      : stagedPhysicalIdentity !== null
        ? stagedPhysicalPath
        : null;
    const physicalIdentity = finalPhysicalIdentity ?? stagedPhysicalIdentity;
    if (expectedPhysical === null) {
      if (finalPhysicalIdentity !== null) {
        throw new RuntimeError("unbound final worktree creation path appeared");
      }
    } else if (physicalIdentity !== null
      && !sameManagedIdentity(physicalIdentity, expectedPhysical)) {
      throw new RuntimeError("worktree creation physical identity changed");
    }

    const activeRegistration = await findCreationRegistration(
      registrationRoot,
      manifest.physicalPath,
    );
    let quarantineIdentity = await managedWorktreeDirectoryIdentity(manifest.quarantinePath);
    if (activeRegistration !== null && quarantineIdentity !== null) {
      throw new RuntimeError("worktree creation registration exists at two paths");
    }
    if (expectedPhysical === null
      && (activeRegistration !== null || quarantineIdentity !== null)) {
      throw new RuntimeError("unbound worktree creation acquired a Git registration");
    }
    if (activeRegistration !== null) {
      const registrationIdentity = await managedWorktreeDirectoryIdentity(activeRegistration);
      if (registrationIdentity === null) {
        throw new RuntimeError("worktree creation registration disappeared");
      }
      await assertRegistrationBacklink(activeRegistration, manifest.physicalPath);
      await rename(activeRegistration, manifest.quarantinePath);
      await Promise.all([syncDirectory(registrationRoot), syncDirectory(quarantineRoot)]);
      if (await managedWorktreeDirectoryIdentity(activeRegistration) !== null) {
        throw new RuntimeError("worktree creation registration reappeared after staging");
      }
      quarantineIdentity = await managedWorktreeDirectoryIdentity(manifest.quarantinePath);
      if (quarantineIdentity === null
        || !sameManagedIdentity(quarantineIdentity, registrationIdentity)) {
        throw new RuntimeError("worktree creation registration changed during staging");
      }
    }
    if (quarantineIdentity !== null) {
      await assertRegistrationBacklink(manifest.quarantinePath, manifest.physicalPath);
    }

    const removalIdentity = expectedPhysical ?? stagedPhysicalIdentity;
    if (physicalPath !== null && physicalIdentity !== null && removalIdentity !== null) {
      if (expectedPhysical !== null) {
        await emptyBoundDirectory(physicalPath, removalIdentity, platformServices);
      }
      await removeBoundEmptyDirectory(physicalPath, removalIdentity, platformServices);
      await syncDirectory(physicalRoot);
      const settledRoot = await managedWorktreeDirectoryIdentity(physicalRoot!);
      if (settledRoot === null || !sameManagedIdentity(settledRoot, expectedPhysicalRoot)) {
        throw new RuntimeError("worktree creation root changed during recovery");
      }
    }
    if (quarantineIdentity !== null) {
      await removeQuarantinedDirectory(
        quarantineRoot,
        manifest.quarantinePath,
        quarantineIdentity,
        { processSupervisor: platformServices },
      );
    }
    await Promise.all([syncDirectory(registrationRoot), syncDirectory(quarantineRoot)]);
    await removeWorktreeRemovalManifest(manifestPath, manifest.transactionId);
  });
}


export async function recoverPendingWorktreeRemovals(
  platformServices: PlatformServices = getPlatformServices(),
  syncDirectory: (directory: string) => Promise<void> = syncDirectoryMetadata,
): Promise<WorktreeRemovalManifestIssue[]> {
  const { pending, issues } = await readPendingWorktreeRemovalManifests();
  for (const { manifestPath, manifest, temporaryPath, temporaryKind } of pending) {
    let recoveryError: unknown;
    let repositoryIdentity: string | undefined;
    try {
      if (manifest.phase === "creation-intent") {
        repositoryIdentity = await realpath(manifest.commonDir);
        await recoverWorktreeCreationIntent(
          manifestPath,
          manifest,
          platformServices,
          syncDirectory,
          temporaryPath,
          temporaryKind,
        );
        continue;
      }
      const commonDir = await realpath(manifest.commonDir);
      repositoryIdentity = commonDir;
      const expectedRegistrationRoot = path.join(commonDir, "worktrees");
      const registrationRoot = await realpath(expectedRegistrationRoot);
      const expectedQuarantineRoot = path.join(
        commonDir,
        WORKTREE_REGISTRATION_QUARANTINE_DIRECTORY,
      );
      const quarantineRoot = await realpath(expectedQuarantineRoot);
      const quarantineMetadata = await lstat(quarantineRoot, { bigint: true });
      const physicalRoot = await realpath(path.resolve(resolveStateDir(), "worktrees"));
      const commonDirIdentity = await managedWorktreeDirectoryIdentity(commonDir);
      const registrationRootIdentity = await managedWorktreeDirectoryIdentity(registrationRoot);
      const quarantineRootIdentity = await managedWorktreeDirectoryIdentity(quarantineRoot);
      const physicalRootIdentity = await managedWorktreeDirectoryIdentity(physicalRoot);
      const expectedCommonDirIdentity: ManagedWorktreeDirectoryIdentity = {
        dev: BigInt(manifest.commonDirDev),
        ino: BigInt(manifest.commonDirIno),
        birthtimeNs: BigInt(manifest.commonDirBirthtimeNs),
      };
      const expectedRegistrationRootIdentity: ManagedWorktreeDirectoryIdentity = {
        dev: BigInt(manifest.registrationRootDev),
        ino: BigInt(manifest.registrationRootIno),
        birthtimeNs: BigInt(manifest.registrationRootBirthtimeNs),
      };
      const expectedQuarantineRootIdentity: ManagedWorktreeDirectoryIdentity = {
        dev: BigInt(manifest.quarantineRootDev),
        ino: BigInt(manifest.quarantineRootIno),
        birthtimeNs: BigInt(manifest.quarantineRootBirthtimeNs),
      };
      const expectedPhysicalRootIdentity: ManagedWorktreeDirectoryIdentity = {
        dev: BigInt(manifest.physicalRootDev),
        ino: BigInt(manifest.physicalRootIno),
        birthtimeNs: BigInt(manifest.physicalRootBirthtimeNs),
      };
      if (process.platform === "win32") {
        if (registrationRootIdentity === null
          || quarantineRootIdentity === null
          || physicalRootIdentity === null) {
          throw new RuntimeError("worktree removal root identity is unavailable on Windows");
        }
        await Promise.all([
          assertWindowsPrivateDirectory(
            quarantineRoot,
            quarantineRootIdentity,
            platformServices,
          ),
          assertWindowsPrivateDirectory(
            physicalRoot,
            physicalRootIdentity,
            platformServices,
          ),
        ]);
      }
      const manifestPhysicalRoot = await realpath(path.dirname(manifest.physicalPath));
      const manifestPhysicalQuarantineRoot = await realpath(
        path.dirname(manifest.physicalQuarantinePath),
      );
      const assertRemovalRootsUnchanged = async () => {
        const currentCommonDir = await managedWorktreeDirectoryIdentity(commonDir);
        const currentRegistrationRoot = await managedWorktreeDirectoryIdentity(registrationRoot);
        const currentQuarantineRoot = await managedWorktreeDirectoryIdentity(quarantineRoot);
        const currentPhysicalRoot = await managedWorktreeDirectoryIdentity(physicalRoot);
        if (commonDirIdentity === null
          || currentCommonDir === null
          || !sameManagedIdentity(currentCommonDir, commonDirIdentity)
          || registrationRootIdentity === null
          || quarantineRootIdentity === null
          || physicalRootIdentity === null
          || currentRegistrationRoot === null
          || currentQuarantineRoot === null
          || currentPhysicalRoot === null
          || !sameManagedIdentity(currentRegistrationRoot, registrationRootIdentity)
          || !sameManagedIdentity(currentQuarantineRoot, quarantineRootIdentity)
          || !sameManagedIdentity(currentPhysicalRoot, physicalRootIdentity)) {
          throw new RuntimeError("worktree removal root identity changed");
        }
      };
      const syncRemovalRoots = async () => {
        for (const directory of [physicalRoot, registrationRoot, quarantineRoot]) {
          await syncDirectory(directory);
        }
        await assertRemovalRootsUnchanged();
      };
      const uid = process.getuid?.();
      const checkManifestConsistency = (
        tag: string,
        ok: boolean,
        ...operands: unknown[]
      ) => {
        if (ok) return;
        const detail = operands.length === 0
          ? ""
          : ` (${operands.map(operand => boundedRedactedDiagnostic(
            JSON.stringify(operand, (_key, value) =>
              typeof value === "bigint" ? value.toString() : value),
            256,
          )).join(" vs ")})`;
        throw new RuntimeError(
          `worktree removal manifest paths are inconsistent: ${tag}${detail}`,
        );
      };
      checkManifestConsistency(
        "quarantineRoot directory mismatch",
        quarantineMetadata.isDirectory(),
        quarantineMetadata.isDirectory(),
        true,
      );
      checkManifestConsistency(
        "quarantineRoot symlink mismatch",
        !quarantineMetadata.isSymbolicLink(),
        quarantineMetadata.isSymbolicLink(),
        false,
      );
      if (process.platform !== "win32") {
        checkManifestConsistency("quarantineRoot owner unavailable", uid !== undefined, uid);
        checkManifestConsistency(
          "quarantineRoot owner mismatch",
          quarantineMetadata.uid === BigInt(uid!),
          quarantineMetadata.uid,
          uid,
        );
        checkManifestConsistency(
          "quarantineRoot mode mismatch",
          (quarantineMetadata.mode & 0o077n) === 0n,
          quarantineMetadata.mode & 0o077n,
          0,
        );
      }
      checkManifestConsistency(
        "commonDir identity unavailable",
        commonDirIdentity !== null,
        commonDirIdentity,
      );
      checkManifestConsistency(
        "commonDir identity mismatch",
        sameManagedIdentity(commonDirIdentity!, expectedCommonDirIdentity),
        commonDirIdentity,
        expectedCommonDirIdentity,
      );
      checkManifestConsistency(
        "registrationRoot identity unavailable",
        registrationRootIdentity !== null,
        registrationRootIdentity,
      );
      checkManifestConsistency(
        "registrationRoot identity mismatch",
        sameManagedIdentity(registrationRootIdentity!, expectedRegistrationRootIdentity),
        registrationRootIdentity,
        expectedRegistrationRootIdentity,
      );
      checkManifestConsistency(
        "quarantineRoot identity unavailable",
        quarantineRootIdentity !== null,
        quarantineRootIdentity,
      );
      checkManifestConsistency(
        "quarantineRoot identity mismatch",
        sameManagedIdentity(quarantineRootIdentity!, expectedQuarantineRootIdentity),
        quarantineRootIdentity,
        expectedQuarantineRootIdentity,
      );
      checkManifestConsistency(
        "physicalRoot identity unavailable",
        physicalRootIdentity !== null,
        physicalRootIdentity,
      );
      checkManifestConsistency(
        "physicalRoot identity mismatch",
        sameManagedIdentity(physicalRootIdentity!, expectedPhysicalRootIdentity),
        physicalRootIdentity,
        expectedPhysicalRootIdentity,
      );
      checkManifestConsistency(
        "commonDir mismatch",
        platformPathsEqual(commonDir, manifest.commonDir),
        commonDir,
        manifest.commonDir,
      );
      checkManifestConsistency(
        "derived registrationRoot mismatch",
        platformPathsEqual(registrationRoot, expectedRegistrationRoot),
        registrationRoot,
        expectedRegistrationRoot,
      );
      checkManifestConsistency(
        "derived quarantineRoot mismatch",
        platformPathsEqual(quarantineRoot, expectedQuarantineRoot),
        quarantineRoot,
        expectedQuarantineRoot,
      );
      checkManifestConsistency(
        "registrationRoot mismatch",
        platformPathsEqual(registrationRoot, manifest.registrationRoot),
        registrationRoot,
        manifest.registrationRoot,
      );
      checkManifestConsistency(
        "quarantineRoot mismatch",
        platformPathsEqual(quarantineRoot, manifest.quarantineRoot),
        quarantineRoot,
        manifest.quarantineRoot,
      );
      checkManifestConsistency(
        "registrationPath is not absolute",
        path.isAbsolute(manifest.registrationPath),
        manifest.registrationPath,
      );
      checkManifestConsistency(
        "registrationPath is not normalized",
        path.resolve(manifest.registrationPath) === manifest.registrationPath,
        path.resolve(manifest.registrationPath),
        manifest.registrationPath,
      );
      checkManifestConsistency(
        "registrationPath equals registrationRoot",
        !platformPathsEqual(manifest.registrationPath, registrationRoot),
        manifest.registrationPath,
        registrationRoot,
      );
      checkManifestConsistency(
        "quarantinePath is not absolute",
        path.isAbsolute(manifest.quarantinePath),
        manifest.quarantinePath,
      );
      checkManifestConsistency(
        "quarantinePath is not normalized",
        path.resolve(manifest.quarantinePath) === manifest.quarantinePath,
        path.resolve(manifest.quarantinePath),
        manifest.quarantinePath,
      );
      checkManifestConsistency(
        "quarantinePath equals quarantineRoot",
        !platformPathsEqual(manifest.quarantinePath, quarantineRoot),
        manifest.quarantinePath,
        quarantineRoot,
      );
      checkManifestConsistency(
        "physicalPath is not absolute",
        path.isAbsolute(manifest.physicalPath),
        manifest.physicalPath,
      );
      checkManifestConsistency(
        "physicalPath is not normalized",
        path.resolve(manifest.physicalPath) === manifest.physicalPath,
        path.resolve(manifest.physicalPath),
        manifest.physicalPath,
      );
      checkManifestConsistency(
        "physicalPath equals physicalRoot",
        !platformPathsEqual(manifest.physicalPath, physicalRoot),
        manifest.physicalPath,
        physicalRoot,
      );
      checkManifestConsistency(
        "physicalQuarantinePath is not absolute",
        path.isAbsolute(manifest.physicalQuarantinePath),
        manifest.physicalQuarantinePath,
      );
      checkManifestConsistency(
        "physicalQuarantinePath is not normalized",
        path.resolve(manifest.physicalQuarantinePath) === manifest.physicalQuarantinePath,
        path.resolve(manifest.physicalQuarantinePath),
        manifest.physicalQuarantinePath,
      );
      checkManifestConsistency(
        "physicalQuarantinePath equals physicalRoot",
        !platformPathsEqual(manifest.physicalQuarantinePath, physicalRoot),
        manifest.physicalQuarantinePath,
        physicalRoot,
      );
      checkManifestConsistency(
        "registrationPath parent mismatch",
        platformPathsEqual(path.dirname(manifest.registrationPath), registrationRoot),
        path.dirname(manifest.registrationPath),
        registrationRoot,
      );
      checkManifestConsistency(
        "quarantinePath parent mismatch",
        platformPathsEqual(path.dirname(manifest.quarantinePath), quarantineRoot),
        path.dirname(manifest.quarantinePath),
        quarantineRoot,
      );
      checkManifestConsistency(
        "quarantinePath name mismatch",
        path.basename(manifest.quarantinePath)
          === `.remove-registration-${path.basename(manifest.registrationPath)}-${manifest.transactionId}`,
        path.basename(manifest.quarantinePath),
        `.remove-registration-${path.basename(manifest.registrationPath)}-${manifest.transactionId}`,
      );
      checkManifestConsistency(
        "physicalPath parent mismatch",
        platformPathsEqual(manifestPhysicalRoot, physicalRoot),
        manifestPhysicalRoot,
        physicalRoot,
      );
      checkManifestConsistency(
        "physicalQuarantinePath parent mismatch",
        platformPathsEqual(manifestPhysicalQuarantineRoot, physicalRoot),
        manifestPhysicalQuarantineRoot,
        physicalRoot,
      );
      checkManifestConsistency(
        "physicalQuarantinePath name mismatch",
        path.basename(manifest.physicalQuarantinePath)
          === `.remove-${path.basename(manifest.physicalPath)}-${manifest.transactionId}`,
        path.basename(manifest.physicalQuarantinePath),
        `.remove-${path.basename(manifest.physicalPath)}-${manifest.transactionId}`,
      );
      if (manifest.phase === "creation-root-changed") {
        throw new RuntimeError("worktree creation root changed and requires manual resolution");
      }
      const expectedRegistrationIdentity = {
        dev: BigInt(manifest.registrationDev),
        ino: BigInt(manifest.registrationIno),
        birthtimeNs: BigInt(manifest.registrationBirthtimeNs),
      };
      const expectedPhysicalIdentity = manifest.physicalPresent
        ? {
          dev: BigInt(manifest.physicalDev),
          ino: BigInt(manifest.physicalIno),
          birthtimeNs: BigInt(manifest.physicalBirthtimeNs),
        }
        : null;
      await platformSafety.withRecoveryLease(commonDir, async (lease) => {
        if (lease.repositoryIdentity !== commonDir) {
          throw new RuntimeError("worktree removal recovery lease identity mismatch");
        }

      if (temporaryPath !== undefined && temporaryKind === "linked") {
        await settleLinkedWorktreeRemovalManifest(
          manifestPath,
          temporaryPath,
          manifest.transactionId,
        );
      }
      const lockedManifest = await readWorktreeRemovalManifest(
        manifestPath,
        manifest.transactionId,
      );
      if (lockedManifest === null) return;
      if (JSON.stringify(lockedManifest) !== JSON.stringify(manifest)) {
        throw new RuntimeError("worktree removal manifest changed before recovery lease");
      }
      const registrationIdentity = await managedWorktreeDirectoryIdentity(
        manifest.registrationPath,
      );
      const quarantineIdentity = await managedWorktreeDirectoryIdentity(manifest.quarantinePath);
      let physicalIdentity = await managedWorktreeDirectoryIdentity(manifest.physicalPath);
      let physicalQuarantineIdentity = await managedWorktreeDirectoryIdentity(
        manifest.physicalQuarantinePath,
      );
      await assertRemovalRootsUnchanged();
      if (registrationIdentity !== null && quarantineIdentity !== null) {
        throw new RuntimeError("worktree removal registration exists at two paths");
      }
      if (physicalIdentity !== null && physicalQuarantineIdentity !== null) {
        throw new RuntimeError("physical worktree exists at two paths during removal recovery");
      }
      if (registrationIdentity !== null
        && (registrationIdentity.dev !== expectedRegistrationIdentity.dev
          || registrationIdentity.ino !== expectedRegistrationIdentity.ino
          || registrationIdentity.birthtimeNs !== expectedRegistrationIdentity.birthtimeNs)) {
        throw new RuntimeError("worktree removal registration identity changed");
      }
      if (quarantineIdentity !== null
        && (quarantineIdentity.dev !== expectedRegistrationIdentity.dev
          || quarantineIdentity.ino !== expectedRegistrationIdentity.ino
          || quarantineIdentity.birthtimeNs !== expectedRegistrationIdentity.birthtimeNs)) {
        throw new RuntimeError("worktree removal quarantine identity changed");
      }
      if (expectedPhysicalIdentity === null) {
        if (physicalIdentity !== null || physicalQuarantineIdentity !== null) {
          throw new RuntimeError("stale worktree physical path reappeared during removal recovery");
        }
      } else {
        if (physicalIdentity !== null
          && (physicalIdentity.dev !== expectedPhysicalIdentity.dev
            || physicalIdentity.ino !== expectedPhysicalIdentity.ino
            || physicalIdentity.birthtimeNs !== expectedPhysicalIdentity.birthtimeNs)) {
          throw new RuntimeError("physical worktree identity changed during removal recovery");
        }
        if (physicalQuarantineIdentity !== null
          && (physicalQuarantineIdentity.dev !== expectedPhysicalIdentity.dev
            || physicalQuarantineIdentity.ino !== expectedPhysicalIdentity.ino
            || physicalQuarantineIdentity.birthtimeNs !== expectedPhysicalIdentity.birthtimeNs)) {
          throw new RuntimeError("physical worktree quarantine identity changed");
        }
        if (physicalIdentity === null && physicalQuarantineIdentity === null) {
          const displacedPhysicalPath = await findManagedChildByIdentity(
            physicalRoot,
            expectedPhysicalIdentity,
          );
          if (displacedPhysicalPath !== null) {
            throw new RuntimeError(
              "physical worktree moved away from both recorded removal paths",
            );
          }
        }
      }

      const activeRegistrationPath = quarantineIdentity !== null
        ? manifest.quarantinePath
        : registrationIdentity !== null
          ? manifest.registrationPath
          : null;
      if (activeRegistrationPath === null && manifest.phase !== "physical-removed") {
        throw new RuntimeError("worktree removal registration disappeared before commit");
      }
      if (activeRegistrationPath !== null && manifest.phase !== "physical-removed") {
        await assertRegistrationBacklink(activeRegistrationPath, manifest.physicalPath);
      }

      if (manifest.phase === "physical-removed"
        && (physicalIdentity !== null || physicalQuarantineIdentity !== null)) {
        throw new RuntimeError("committed physical worktree removal reappeared");
      }
      if (manifest.phase === "physical-removal-intent"
        && manifest.physicalPresent
        && physicalIdentity === null
        && physicalQuarantineIdentity === null) {
        throw new RuntimeError(
          "intended physical worktree removal has no provable original or quarantine",
        );
      }
      const rollback = manifest.phase === "registration-intent"
        ? !manifest.physicalPresent || physicalIdentity !== null
        : manifest.phase === "physical-removal-intent"
          ? (manifest.physicalPresent
            ? physicalIdentity !== null || physicalQuarantineIdentity !== null
            : physicalIdentity === null && physicalQuarantineIdentity === null)
          : manifest.phase === "registration-staged"
            && (manifest.physicalPresent
              ? physicalIdentity !== null
              : physicalIdentity === null && physicalQuarantineIdentity === null);
      if (rollback) {
        if (manifest.phase === "physical-removal-intent"
          && physicalQuarantineIdentity !== null) {
          if (expectedPhysicalIdentity === null || physicalIdentity !== null) {
            throw new RuntimeError("physical worktree rollback state is inconsistent");
          }
          await assertRemovalRootsUnchanged();
          await rename(manifest.physicalQuarantinePath, manifest.physicalPath);
          const restoredPhysical = await managedWorktreeDirectoryIdentity(manifest.physicalPath);
          const settledPhysicalQuarantine = await managedWorktreeDirectoryIdentity(
            manifest.physicalQuarantinePath,
          );
          if (restoredPhysical === null
            || !sameManagedIdentity(restoredPhysical, expectedPhysicalIdentity)
            || settledPhysicalQuarantine !== null) {
            throw new RuntimeError("physical worktree rollback identity changed");
          }
          await syncDirectory(physicalRoot);
          await assertRemovalRootsUnchanged();
        }
        if (quarantineIdentity !== null) {
          await restoreStagedRegistration(
            registrationRoot,
            manifest.registrationPath,
            quarantineRoot,
            manifest.quarantinePath,
            expectedRegistrationIdentity,
            expectedRegistrationRootIdentity,
            expectedQuarantineRootIdentity,
            { processSupervisor: platformServices },
          );
        } else if (registrationIdentity === null) {
          throw new RuntimeError("pre-commit worktree registration disappeared");
        }
        await syncRemovalRoots();
        await removeWorktreeRemovalManifest(manifestPath, manifest.transactionId);
      } else {
        if (manifest.phase === "registration-staged") {
          throw new RuntimeError("staged worktree removal physical state is inconsistent");
        }
        if (manifest.phase === "physical-removal-started"
          && physicalIdentity !== null) {
          if (registrationIdentity !== null
            || expectedPhysicalIdentity === null
            || physicalQuarantineIdentity !== null) {
            throw new RuntimeError("started worktree removal state is inconsistent");
          }
          await assertRemovalRootsUnchanged();
          await rename(manifest.physicalPath, manifest.physicalQuarantinePath);
          physicalIdentity = await managedWorktreeDirectoryIdentity(manifest.physicalPath);
          physicalQuarantineIdentity = await managedWorktreeDirectoryIdentity(
            manifest.physicalQuarantinePath,
          );
          if (physicalIdentity !== null
            || physicalQuarantineIdentity === null
            || !sameManagedIdentity(physicalQuarantineIdentity, expectedPhysicalIdentity)) {
            throw new RuntimeError("started worktree removal quarantine identity changed");
          }
          await syncDirectory(physicalRoot);
          await assertRemovalRootsUnchanged();
        }
        if (physicalQuarantineIdentity !== null) {
          if (registrationIdentity !== null || expectedPhysicalIdentity === null) {
            throw new RuntimeError("quarantined worktree removal state is inconsistent");
          }
          await removeQuarantinedDirectory(
            physicalRoot,
            manifest.physicalQuarantinePath,
            expectedPhysicalIdentity,
            { processSupervisor: platformServices },
          );
          physicalQuarantineIdentity = null;
        }
        if (registrationIdentity !== null) {
          throw new RuntimeError("removed physical worktree retained a live registration");
        }
        if (quarantineIdentity !== null) {
          await removeQuarantinedDirectory(
            quarantineRoot,
            manifest.quarantinePath,
            expectedRegistrationIdentity,
            { processSupervisor: platformServices },
          );
        }
        await syncRemovalRoots();
        await removeWorktreeRemovalManifest(manifestPath, manifest.transactionId);
      }
    });
  } catch (error) {
    recoveryError = error;
  }


    if (recoveryError !== undefined) {
      issues.push({
        manifestPath,
        error: recoveryError,
        ...(repositoryIdentity === undefined ? {} : { repositoryIdentity }),
      });
    }
  }
  return issues;
}

function worktreeSweepIssue(
  worktreePath: string,
  error: unknown,
  repositoryIdentity?: string,
): WorktreeSweepIssue {
  return {
    worktreePath,
    reason: boundedRedactedDiagnostic(error, MAX_QUARANTINE_REASON_BYTES),
    ...(repositoryIdentity === undefined ? {} : { repositoryIdentity }),
  };
}

function boundedWorktreeSweepIssues(
  issues: WorktreeSweepIssue[],
  worktreesRoot: string,
): WorktreeSweepIssue[] {
  if (issues.length <= MAX_WORKTREE_SWEEP_ISSUES) return issues;
  const retained = issues.slice(0, MAX_WORKTREE_SWEEP_ISSUES - 1);
  return [...retained, {
    worktreePath: worktreesRoot,
    reason: `${issues.length - retained.length} additional worktree sweep issues omitted`,
  }];
}

function runClaimsWorktree(runId: string, managedId: string): boolean {
  // Worktree phase names are intentionally open-ended: adding a new trusted
  // phase must not make recovery delete it merely because this scanner's enum
  // was not updated. Run IDs are safe, collision-resistant identifiers, and
  // each supported namespace uses an explicit boundary after the full ID.
  return managedId === runId
    || managedId.startsWith(`${runId}-`)
    || managedId === `baseline-${runId}`
    || managedId.startsWith(`baseline-${runId}-`)
    || managedId === `verify-${runId}`
    || managedId.startsWith(`verify-${runId}-`);
}

const MALFORMED_WORKFLOW_OWNERSHIP = "";

async function workflowOwnershipRecords(
  root: string,
): Promise<Map<string, string[]>> {
  const ownershipRoot = path.join(root, "autopilot-branches");
  if (await plainDirectoryIdentity(ownershipRoot) === null) return new Map();
  const records = new Map<string, string[]>();
  for (const entry of await readdir(ownershipRoot, { withFileTypes: true })) {
    const match = WORKFLOW_OWNERSHIP_NAME.exec(entry.name);
    if (match === null || !entry.isFile() || entry.isSymbolicLink()) {
      throw new RuntimeError("workflow ownership directory contains a malformed entry");
    }
    const ownershipPath = path.join(ownershipRoot, entry.name);
    const filenamePrefix = match[1]!.slice(0, 32);
    records.set(filenamePrefix, [...(records.get(filenamePrefix) ?? []), ownershipPath]);
    let workflowId: string;
    try {
      workflowId = await workflowOwnershipRecordWorkflowId(ownershipPath);
    } catch {
      records.set(MALFORMED_WORKFLOW_OWNERSHIP, [
        ...(records.get(MALFORMED_WORKFLOW_OWNERSHIP) ?? []),
        ownershipPath,
      ]);
      continue;
    }
    const expectedPrefix = createHash("sha256").update(workflowId).digest("hex").slice(0, 32);
    if (expectedPrefix !== filenamePrefix) {
      records.set(expectedPrefix, [...(records.get(expectedPrefix) ?? []), ownershipPath]);
    }
    const legacyPrefix = createHash("sha256")
      .update(JSON.stringify(workflowId)).digest("hex").slice(0, 24);
    records.set(`legacy:${legacyPrefix}`, [
      ...(records.get(`legacy:${legacyPrefix}`) ?? []),
      ownershipPath,
    ]);
  }
  return records;
}

async function workflowClaimMustBePreserved(
  root: string,
  claim: WorkflowWorktreeOwnershipClaim,
  isProcessAlive: (pid: number) => boolean,
  getProcessStartToken: (pid: number) => Promise<string | null>,
): Promise<boolean> {
  const store = new WorkflowStore(claim.workflowId, {
    stateDirectory: root,
    isProcessAlive,
    getProcessStartToken,
  });
  let state: AutopilotWorkflowState;
  try {
    state = await store.read();
  } catch {
    return true;
  }
  if (!TERMINAL_PHASES.has(state.phase)) return true;
  const branchOwnerStatus = !isProcessAlive(claim.bootstrapOwner.pid)
    ? Promise.resolve<LockOwnerStatus>("dead")
    : claim.bootstrapOwner.processToken === null
      ? Promise.resolve<LockOwnerStatus>("unverifiable")
      : lockOwnerStatus(
        {
          pid: claim.bootstrapOwner.pid,
          processToken: claim.bootstrapOwner.processToken,
        },
        isProcessAlive,
        getProcessStartToken,
      ).catch((): LockOwnerStatus => "unverifiable");
  const [workflowOwner, branchOwner] = await Promise.all([
    observeWorkflowLease(store, isProcessAlive, getProcessStartToken),
    branchOwnerStatus,
  ]);
  return (workflowOwner.presence === "present" && workflowOwner.status !== "dead")
    || branchOwner !== "dead";
}

async function finalMaterializationMustBePreserved(
  root: string,
  claim: WorkflowWorktreeOwnershipClaim,
  isProcessAlive: (pid: number) => boolean,
  getProcessStartToken: (pid: number) => Promise<string | null>,
): Promise<boolean> {
  const store = new WorkflowStore(claim.workflowId, {
    stateDirectory: root,
    isProcessAlive,
    getProcessStartToken,
  });
  try {
    await store.read();
    const owner = await observeWorkflowLease(store, isProcessAlive, getProcessStartToken);
    return owner.presence === "present" && owner.status !== "dead";
  } catch {
    return true;
  }
}

async function sweepOrphanWorktrees(args: {
  root: string;
  locksRoot: string;
  claimedRunIds: ReadonlySet<string>;
  claimedWorkflowPrefixes: ReadonlySet<string>;
  ownerContents: Buffer;
  isProcessAlive: (pid: number) => boolean;
  getProcessStartToken: (pid: number) => Promise<string | null>;
  runGit: typeof git;
}): Promise<WorktreeSweepIssue[]> {
  const issues: WorktreeSweepIssue[] = [];
  const worktreesRoot = path.join(args.root, "worktrees");
  let entries;
  let stateRootIdentity: DirectoryIdentity;
  let worktreesRootIdentity: DirectoryIdentity;
  try {
    if (await plainDirectoryIdentity(worktreesRoot) === null) return issues;
    [stateRootIdentity, worktreesRootIdentity] = await Promise.all([
      assertPrivateRecoveryDirectory(args.root),
      assertPrivateRecoveryDirectory(worktreesRoot),
    ]);
    entries = await readdir(worktreesRoot, { withFileTypes: true });
    const [settledStateRoot, settledWorktreesRoot] = await Promise.all([
      plainDirectoryIdentity(args.root),
      plainDirectoryIdentity(worktreesRoot),
    ]);
    if (settledStateRoot === null
      || settledWorktreesRoot === null
      || !sameIdentity(settledStateRoot, stateRootIdentity)
      || !sameIdentity(settledWorktreesRoot, worktreesRootIdentity)) {
      throw new RuntimeError("managed worktree namespace identity changed during sweep setup");
    }
  } catch (error) {
    return [worktreeSweepIssue(worktreesRoot, error)];
  }

  let ownershipRecords = new Map<string, string[]>();
  let ownershipLookupError: unknown;
  try {
    ownershipRecords = await workflowOwnershipRecords(args.root);
  } catch (error) {
    ownershipLookupError = error;
  }
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const worktreePath = path.join(worktreesRoot, entry.name);
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      issues.push(worktreeSweepIssue(
        worktreePath,
        new RuntimeError("managed worktree namespace contains a non-directory entry"),
      ));
      continue;
    }
    let expectedIdentity: ManagedWorktreeDirectoryIdentity;
    try {
      const identity = await managedWorktreeDirectoryIdentity(worktreePath);
      if (identity === null) continue;
      expectedIdentity = identity;
    } catch (error) {
      issues.push(worktreeSweepIssue(worktreePath, error));
      continue;
    }

    if ([...args.claimedRunIds].some(runId => runClaimsWorktree(runId, entry.name))) continue;

    try {
      if (!await managedWorktreeMarkerIsPresent(worktreePath)) {
        throw new RuntimeError("orphan worktree repository marker is missing");
      }
    } catch (error) {
      issues.push(worktreeSweepIssue(worktreePath, error));
      continue;
    }

    const workflowMatch = WORKFLOW_WORKTREE_NAME.exec(entry.name);
    const legacyFinalMatch = LEGACY_FINAL_WORKTREE_NAME.exec(entry.name);
    const finalMaterialization = legacyFinalMatch !== null
      || (workflowMatch !== null && entry.name.endsWith("-final"));
    const workflowOwnershipKey = workflowMatch?.[1]
      ?? (legacyFinalMatch === null ? null : `legacy:${legacyFinalMatch[1]}`);
    if (workflowMatch !== null
      && !finalMaterialization
      && args.claimedWorkflowPrefixes.has(workflowMatch[1]!)) continue;
    if (workflowOwnershipKey !== null) {
      if (ownershipLookupError !== undefined) {
        issues.push(worktreeSweepIssue(worktreePath, ownershipLookupError));
        continue;
      }
      const candidates = ownershipRecords.get(workflowOwnershipKey) ?? [];
      const malformedRecords = ownershipRecords.get(MALFORMED_WORKFLOW_OWNERSHIP) ?? [];
      if (malformedRecords.length > 0) {
        issues.push(worktreeSweepIssue(
          worktreePath,
          new RuntimeError("workflow ownership lookup is ambiguous because a record is malformed"),
        ));
        continue;
      }
      if (candidates.length > 1) {
        issues.push(worktreeSweepIssue(
          worktreePath,
          new RuntimeError("workflow worktree ownership lookup is ambiguous"),
        ));
        continue;
      }
      if (candidates.length === 1) {
        try {
          const claim = await workflowWorktreeOwnershipClaim(candidates[0]!, worktreePath);
          const preserve = finalMaterialization
            ? await finalMaterializationMustBePreserved(
              args.root,
              claim,
              args.isProcessAlive,
              args.getProcessStartToken,
            )
            : await workflowClaimMustBePreserved(
              args.root,
              claim,
              args.isProcessAlive,
              args.getProcessStartToken,
            );
          if (preserve) continue;
        } catch (error) {
          issues.push(worktreeSweepIssue(worktreePath, error));
          continue;
        }
      }
    }

    let commonDir: string;
    try {
      const resolved = await args.runGit(worktreePath, [
        "rev-parse", "--path-format=absolute", "--git-common-dir",
      ]);
      if (resolved.truncated?.stdout === true || resolved.truncated?.stderr === true) {
        throw new RuntimeError("worktree repository lookup was truncated");
      }
      if (resolved.exitCode !== 0) {
        throw runGitError("resolve worktree repository", resolved);
      }
      const reportedCommonDir = gitPathOutput(
        resolved.stdout,
        "startup worktree common directory",
      );
      if (!path.isAbsolute(reportedCommonDir)) {
        throw new RuntimeError("worktree repository lookup returned a non-absolute path");
      }
      commonDir = await realpath(reportedCommonDir);
    } catch (error) {
      issues.push(worktreeSweepIssue(worktreePath, error));
      continue;
    }

    const lockKey = createHash("sha256").update(commonDir).digest("hex");
    let lease: AcquiredLock | null = null;
    let contention: DeadLockReclaimResult | undefined;
    try {
      lease = await createOwnedLock(
        path.join(args.locksRoot, `${lockKey}.lock`),
        args.ownerContents,
      );
      if (lease === null) {
        contention = await reclaimDeadLock(
          path.join(args.locksRoot, `${lockKey}.lock`),
          args.isProcessAlive,
          args.getProcessStartToken,
        );
        if (contention === "reclaimed") {
          lease = await createOwnedLock(
            path.join(args.locksRoot, `${lockKey}.lock`),
            args.ownerContents,
          );
        }
      }
    } catch (error) {
      issues.push(worktreeSweepIssue(worktreePath, error, commonDir));
      continue;
    }
    if (lease === null) {
      if (contention === "malformed" || contention === "unverifiable") {
        issues.push(worktreeSweepIssue(
          worktreePath,
          new RuntimeError(`${contention} checkout lease owner`),
          commonDir,
        ));
      }
      continue;
    }

    let cleanupError: unknown;
    try {
      const currentIdentity = await managedWorktreeDirectoryIdentity(worktreePath);
      if (currentIdentity !== null) {
        if (currentIdentity.dev !== expectedIdentity.dev
          || currentIdentity.ino !== expectedIdentity.ino
          || currentIdentity.birthtimeNs !== expectedIdentity.birthtimeNs) {
          throw new RuntimeError("worktree directory identity changed after lease acquisition");
        }
        let workflowClaimed = false;
        if (workflowOwnershipKey !== null) {
          const refreshedOwnership = await workflowOwnershipRecords(args.root);
          const refreshedCandidates = refreshedOwnership.get(workflowOwnershipKey) ?? [];
          const refreshedMalformed = refreshedOwnership.get(MALFORMED_WORKFLOW_OWNERSHIP) ?? [];
          if (refreshedMalformed.length > 0) {
            throw new RuntimeError(
              "workflow ownership lookup became ambiguous because a record is malformed",
            );
          }
          if (refreshedCandidates.length > 1) {
            throw new RuntimeError("workflow worktree ownership lookup became ambiguous");
          }
          if (refreshedCandidates.length === 1) {
            const claim = await workflowWorktreeOwnershipClaim(
              refreshedCandidates[0]!,
              worktreePath,
            );
            workflowClaimed = finalMaterialization
              ? await finalMaterializationMustBePreserved(
                args.root,
                claim,
                args.isProcessAlive,
                args.getProcessStartToken,
              )
              : await workflowClaimMustBePreserved(
                args.root,
                claim,
                args.isProcessAlive,
                args.getProcessStartToken,
              );
          }
        }
        if (!workflowClaimed) {
          const [currentStateRoot, currentWorktreesRoot] = await Promise.all([
            assertPrivateRecoveryDirectory(args.root),
            assertPrivateRecoveryDirectory(worktreesRoot),
          ]);
          if (!sameIdentity(currentStateRoot, stateRootIdentity)
            || !sameIdentity(currentWorktreesRoot, worktreesRootIdentity)) {
            throw new RuntimeError("managed worktree namespace changed before orphan removal");
          }
          await removeManagedWorktreeUnderLease(
            commonDir,
            worktreePath,
            expectedIdentity,
            args.runGit,
          );
        }
      }
    } catch (error) {
      cleanupError = error;
    }
    try {
      await releaseOwnedLock(lease);
    } catch (releaseError) {
      cleanupError = cleanupError === undefined
        ? releaseError
        : new AggregateError(
          [cleanupError, releaseError],
          "worktree sweep failed and its checkout lease could not be released",
        );
    }
    if (cleanupError !== undefined) {
      issues.push(worktreeSweepIssue(worktreePath, cleanupError, commonDir));
    }
  }

  return issues;
}




type OwnerObservation =
  | { presence: "absent" }
  | { presence: "present"; status: LockOwnerStatus };

interface BranchObservation {
  presence: "absent" | "present" | "ambiguous";
  identity: WorkflowBranchIdentity | null;
  owner: WorkflowBranchBootstrapOwnerRecord | null;
  ownerStatus: LockOwnerStatus | null;
}

function exactObjectKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return actual.length === sortedExpected.length
    && actual.every((key, index) => key === sortedExpected[index]);
}

function parseWorkflowLease(text: string, workflowId: string): WorkflowOwnerRecord | null {
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (!exactObjectKeys(record, ["workflowId", "pid", "processToken", "acquiredAt"])
    || record.workflowId !== workflowId
    || !Number.isSafeInteger(record.pid)
    || (record.pid as number) < 1
    || (record.processToken !== null
      && (typeof record.processToken !== "string"
        || record.processToken.length < 1
        || record.processToken.length > 256))
    || typeof record.acquiredAt !== "string"
    || Number.isNaN(Date.parse(record.acquiredAt))) return null;
  return record as unknown as WorkflowOwnerRecord;
}

async function observeWorkflowLease(
  store: WorkflowStore,
  isProcessAlive: (pid: number) => boolean,
  getProcessStartToken: (pid: number) => Promise<string | null>,
): Promise<OwnerObservation> {
  const text = await readBoundedRegularFile(store.ownerPath).catch(() => undefined);
  if (text === undefined) return { presence: "present", status: "unverifiable" };
  if (text === null) return { presence: "absent" };
  const record = parseWorkflowLease(text, store.workflowId);
  if (record === null) return { presence: "present", status: "unverifiable" };
  return {
    presence: "present",
    status: await lockOwnerStatus(record, isProcessAlive, getProcessStartToken)
      .catch((): LockOwnerStatus => "unverifiable"),
  };
}

function branchOwnershipPath(root: string, workflowId: string): string {
  const name = createHash("sha256").update(workflowId).digest("hex");
  return path.join(root, "autopilot-branches", `${name}.json`);
}

async function observeWorkflowBranch(
  root: string,
  workflowId: string,
  manager: WorkflowBranchManager,
  isProcessAlive: (pid: number) => boolean,
  getProcessStartToken: (pid: number) => Promise<string | null>,
): Promise<BranchObservation> {
  const registration = await readBoundedRegularFile(branchOwnershipPath(root, workflowId))
    .catch(() => undefined);
  if (registration === undefined) {
    return { presence: "ambiguous", identity: null, owner: null, ownerStatus: null };
  }
  if (registration === null) {
    return { presence: "absent", identity: null, owner: null, ownerStatus: null };
  }
  const [identity, owner] = await Promise.all([
    manager.load(workflowId),
    manager.readBootstrapOwner(workflowId),
  ]).catch(() => [null, null] as const);
  if (identity === null || owner === null) {
    return { presence: "ambiguous", identity: null, owner: null, ownerStatus: null };
  }
  return {
    presence: "present",
    identity,
    owner,
    ownerStatus: await lockOwnerStatus(owner, isProcessAlive, getProcessStartToken)
      .catch((): LockOwnerStatus => "unverifiable"),
  };
}

function isWorkflowBranchIdentity(value: unknown): value is WorkflowBranchIdentity {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const identity = value as Partial<WorkflowBranchIdentity>;
  return identity.ownershipVersion === "1"
    && typeof identity.workflowId === "string"
    && SAFE_WORKFLOW_ID.test(identity.workflowId)
    && typeof identity.checkoutPath === "string"
    && typeof identity.gitCommonDir === "string"
    && typeof identity.repositoryIdentity === "string"
    && typeof identity.worktreePath === "string"
    && typeof identity.worktreeGitDir === "string"
    && typeof identity.branch === "string"
    && identity.branchRef === `refs/heads/${identity.branch}`
    && identity.baseRef === `refs/claude-architect/autopilot/${identity.workflowId}/base`
    && typeof identity.baseBranch === "string"
    && typeof identity.baseCommitOid === "string"
    && OID.test(identity.baseCommitOid)
    && identity.remote === "origin"
    && typeof identity.remoteUrl === "string"
    && typeof identity.ownerRepo === "string";
}

function branchMatchesWorkflowState(
  branch: WorkflowBranchIdentity,
  state: AutopilotWorkflowState,
): boolean {
  return branch.workflowId === state.workflowId
    && branch.repositoryIdentity === state.repositoryIdentity
    && branch.baseCommitOid === state.baseCommitOid
    && branch.branchRef === state.workflowRef
    && branch.worktreePath === state.worktreePath
    && branch.branch === state.shipping.branch;
}

function sameWorkflowBranch(
  left: WorkflowBranchIdentity,
  right: WorkflowBranchIdentity,
): boolean {
  return left.ownershipVersion === right.ownershipVersion
    && left.workflowId === right.workflowId
    && left.checkoutPath === right.checkoutPath
    && left.gitCommonDir === right.gitCommonDir
    && left.repositoryIdentity === right.repositoryIdentity
    && left.worktreePath === right.worktreePath
    && left.worktreeGitDir === right.worktreeGitDir
    && left.branch === right.branch
    && left.branchRef === right.branchRef
    && left.baseRef === right.baseRef
    && left.baseBranch === right.baseBranch
    && left.baseCommitOid === right.baseCommitOid
    && left.remote === right.remote
    && left.remoteUrl === right.remoteUrl
    && left.ownerRepo === right.ownerRepo;
}

function canonicalGithubRemote(raw: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:"
    || parsed.hostname.toLowerCase() !== "github.com"
    || parsed.port !== ""
    || parsed.username !== ""
    || parsed.password !== ""
    || parsed.search !== ""
    || parsed.hash !== ""
    || parsed.pathname.includes("%")
    || parsed.pathname.endsWith("/")
    || parsed.pathname.includes("//")) return null;
  const components = parsed.pathname.slice(1).split("/");
  if (components.length !== 2) return null;
  const owner = components[0]!;
  const repository = components[1]!.endsWith(".git")
    ? components[1]!.slice(0, -4)
    : components[1]!;
  const component = /^[A-Za-z0-9_.-]+$/u;
  if (!component.test(owner)
    || !component.test(repository)
    || owner === "."
    || owner === ".."
    || repository === "."
    || repository === "..") return null;
  return `https://github.com/${owner.toLowerCase()}/${repository.toLowerCase()}.git`;
}

function recordedBranch(
  journal: WorkflowIntentJournal,
  state: AutopilotWorkflowState,
): WorkflowBranchIdentity | null {
  const recorded = journal.intents.find(status =>
    status.intent.operation === "record-workflow-spec"
    && status.intent.idempotencyKey === "workflow-spec");
  const completion = recorded?.completion?.completion;
  if (typeof completion !== "object" || completion === null || Array.isArray(completion)) {
    return null;
  }
  const branch = (completion as { branch?: unknown }).branch;
  return isWorkflowBranchIdentity(branch) && branchMatchesWorkflowState(branch, state)
    ? branch
    : null;
}

function expectedWorkflowHead(state: AutopilotWorkflowState): string | null {
  const head = state.tasks
    .slice(0, state.currentTaskIndex + 1)
    .reduce((current, task) => task.promotionCommitOid ?? current, state.baseCommitOid);
  return OID.test(head) ? head : null;
}

function cleanupIntent(
  journal: WorkflowIntentJournal,
  expectedHead: string,
) {
  const key = `cleanup:${expectedHead}`;
  const intent = journal.intents.find(status =>
    status.intent.operation === "cleanup-workflow-branch"
    && status.intent.idempotencyKey === key);
  if (intent === undefined
    || intent.intent.expectedIdentities.headCommitOid !== expectedHead
    || intent.completion?.failure !== null && intent.completion !== null) return null;
  if (intent.completion !== null) {
    const completion = intent.completion.completion;
    if (typeof completion !== "object"
      || completion === null
      || Array.isArray(completion)
      || (completion as { worktreeRemoved?: unknown }).worktreeRemoved !== true
      || (completion as { refsRemoved?: unknown }).refsRemoved !== true) return null;
  }
  return intent;
}

async function isAbsent(filename: string): Promise<boolean | null> {
  try {
    await lstat(filename);
    return false;
  } catch (error) {
    return isMissing(error) ? true : null;
  }
}

async function cleanupIsDirectlyObserved(
  branch: WorkflowBranchIdentity,
  runGit: typeof git,
): Promise<boolean> {
  if (await isAbsent(branch.worktreePath) !== true) return false;
  let canonicalCheckout: string;
  let canonicalCommonDir: string;
  try {
    canonicalCheckout = await realpath(branch.checkoutPath);
    canonicalCommonDir = await realpath(branch.gitCommonDir);
  } catch {
    return false;
  }
  if (canonicalCheckout !== branch.checkoutPath || canonicalCommonDir !== branch.gitCommonDir) {
    return false;
  }
  const [commonDir, worktrees, branchRef, baseRef] = await Promise.all([
    runGit(branch.checkoutPath, ["rev-parse", "--path-format=absolute", "--git-common-dir"]),
    runGit(branch.checkoutPath, ["worktree", "list", "--porcelain", "-z"]),
    runGit(branch.checkoutPath, ["show-ref", "--verify", "--quiet", branch.branchRef]),
    runGit(branch.checkoutPath, ["show-ref", "--verify", "--quiet", branch.baseRef]),
  ]);
  if ([commonDir, worktrees, branchRef, baseRef].some(result =>
    result.truncated?.stdout === true || result.truncated?.stderr === true)
    || commonDir.exitCode !== 0
    || worktrees.exitCode !== 0
    || branchRef.exitCode !== 1
    || baseRef.exitCode !== 1) return false;
  let observedCommonDir: string;
  try {
    observedCommonDir = await realpath(gitPathOutput(
      commonDir.stdout,
      "disposed workflow common directory",
    ));
  } catch {
    return false;
  }
  if (observedCommonDir !== branch.gitCommonDir) return false;
  return await findWorktreeRegistration(
    gitNulRecords(worktrees.stdout, "cleanup-observation Git worktree list"),
    branch.worktreePath,
    true,
  ) === -1;
}

async function activeBranchIsDirectlyObserved(
  branch: WorkflowBranchIdentity,
  expectedHead: string,
  runGit: typeof git,
): Promise<boolean> {
  let canonicalCheckout: string;
  let canonicalWorktree: string;
  let canonicalCommonDir: string;
  try {
    [canonicalCheckout, canonicalWorktree, canonicalCommonDir] = await Promise.all([
      realpath(branch.checkoutPath),
      realpath(branch.worktreePath),
      realpath(branch.gitCommonDir),
    ]);
  } catch {
    return false;
  }
  if (canonicalCheckout !== branch.checkoutPath
    || canonicalWorktree !== branch.worktreePath
    || canonicalCommonDir !== branch.gitCommonDir) return false;

  const [commonDir, worktrees, symbolic, head, base, status, remote] = await Promise.all([
    runGit(branch.checkoutPath, ["rev-parse", "--path-format=absolute", "--git-common-dir"]),
    runGit(branch.checkoutPath, ["worktree", "list", "--porcelain", "-z"]),
    runGit(branch.worktreePath, ["symbolic-ref", "--quiet", "--short", "HEAD"]),
    runGit(branch.worktreePath, ["rev-parse", "--verify", "HEAD"]),
    runGit(branch.checkoutPath, ["rev-parse", "--verify", branch.baseRef]),
    runGit(branch.worktreePath, [
      "status", "--porcelain=v1", "--untracked-files=all", "--ignore-submodules=none",
    ]),
    runGit(branch.checkoutPath, ["config", "--get", "remote.origin.url"]),
  ]);
  if ([commonDir, worktrees, symbolic, head, base, status, remote].some(result =>
    result.truncated?.stdout === true || result.truncated?.stderr === true)
    || commonDir.exitCode !== 0
    || worktrees.exitCode !== 0
    || symbolic.exitCode !== 0
    || head.exitCode !== 0
    || base.exitCode !== 0
    || status.exitCode !== 0
    || remote.exitCode !== 0) return false;
  let observedCommonDir: string;
  try {
    observedCommonDir = await realpath(gitPathOutput(
      commonDir.stdout,
      "active workflow common directory",
    ));
  } catch {
    return false;
  }
  if (observedCommonDir !== branch.gitCommonDir
    || symbolic.stdout.trim() !== branch.branch
    || head.stdout.trim() !== expectedHead
    || base.stdout.trim() !== branch.baseCommitOid
    || status.stdout !== ""
    || canonicalGithubRemote(remote.stdout.trim()) !== branch.remoteUrl) return false;

  const fields = gitNulRecords(worktrees.stdout, "active-branch Git worktree list");
  const registrationIndex = await findWorktreeRegistration(fields, branch.worktreePath);
  if (registrationIndex === -1) return false;
  const nextRegistration = fields.findIndex((field, index) =>
    index > registrationIndex && field.startsWith("worktree "));
  const registration = fields.slice(
    registrationIndex + 1,
    nextRegistration === -1 ? undefined : nextRegistration,
  );
  return registration.includes(`HEAD ${expectedHead}`)
    && registration.includes(`branch ${branch.branchRef}`);
}

async function workflowIds(
  root: string,
  issues: WorktreeSweepIssue[],
): Promise<string[]> {
  const ids = new Set<string>();
  const workflowsRoot = path.join(root, "workflows");
  let workflowEntries: Dirent<string>[] = [];
  try {
    const workflowsIdentity = await plainDirectoryIdentity(workflowsRoot);
    workflowEntries = workflowsIdentity === null
      ? []
      : await readdir(workflowsRoot, { withFileTypes: true });
  } catch (error) {
    issues.push(worktreeSweepIssue(workflowsRoot, error));
  }
  for (const entry of workflowEntries) {
    if (entry.isDirectory() && !entry.isSymbolicLink() && SAFE_WORKFLOW_ID.test(entry.name)) {
      ids.add(entry.name);
    }
  }

  const branchesRoot = path.join(root, "autopilot-branches");
  let branchEntries: Dirent<string>[] = [];
  try {
    const branchesIdentity = await plainDirectoryIdentity(branchesRoot);
    branchEntries = branchesIdentity === null
      ? []
      : await readdir(branchesRoot, { withFileTypes: true });
  } catch (error) {
    issues.push(worktreeSweepIssue(branchesRoot, error));
  }
  for (const entry of branchEntries) {
    if (!entry.isFile() || entry.isSymbolicLink() || !/^[0-9a-f]{64}\.json$/u.test(entry.name)) {
      continue;
    }
    const ownershipPath = path.join(branchesRoot, entry.name);
    let text: string | null;
    let value: unknown;
    try {
      text = await readBoundedRegularFile(ownershipPath);
      if (text === null) {
        throw new RuntimeError("workflow ownership record is absent or unstable");
      }
      value = JSON.parse(text) as unknown;
    } catch (error) {
      issues.push(worktreeSweepIssue(ownershipPath, error));
      continue;
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) continue;
    const workflowId = (value as { workflowId?: unknown }).workflowId;
    if (typeof workflowId === "string"
      && SAFE_WORKFLOW_ID.test(workflowId)
      && entry.name === path.basename(branchOwnershipPath(root, workflowId))) {
      ids.add(workflowId);
    }
  }
  return [...ids].sort((left, right) => left.localeCompare(right));
}

async function finalizeObservedWorkflow(
  store: WorkflowStore,
  state: AutopilotWorkflowState,
  expectedHead: string,
): Promise<void> {
  await store.adoptLease();
  let primaryError: unknown;
  try {
    await store.completeIntent({
      expectedRevision: state.revision,
      idempotencyKey: `cleanup:${expectedHead}`,
      completion: { worktreeRemoved: true, refsRemoved: true },
    });
    const completedAt = new Date().toISOString();
    await store.transition({
      expectedRevision: state.revision,
      to: "ready-for-human-review",
      update(draft) {
        draft.cleanup = {
          status: "succeeded",
          worktreeRemoved: true,
          lockReleased: true,
          error: null,
          completedAt,
        };
        draft.terminal = {
          classification: "ready-for-human-review",
          reason: null,
          evidenceRefs: draft.finalGate === null ? [] : [draft.finalGate.reportRef],
          completedAt,
        };
      },
    });
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    try {
      await store.releaseLease();
    } catch (releaseError) {
      if (primaryError === undefined) throw releaseError;
      throw new AggregateError(
        [primaryError, releaseError],
        "workflow finalization failed and its adopted lease could not be released",
      );
    }
  }
}

async function recoverAutopilotWorkflows(
  root: string,
  dependencies: {
    isProcessAlive: (pid: number) => boolean;
    getProcessStartToken: (pid: number) => Promise<string | null>;
    runGit: typeof git;
  },
  workflowIssues: WorktreeSweepIssue[],
): Promise<AutopilotRecoveryResult[]> {
  const results: AutopilotRecoveryResult[] = [];
  const branchManager = new WorkflowBranchManager({ git: dependencies.runGit });
  // Isolate every workflow: the run loop below already quarantines per entry,
  // but a throw here (branch cleanup, finalization) propagated all the way out
  // of recoverStaleRuns and discarded the dispositions already computed for
  // earlier workflows. Because the failure is deterministic — same dead owner,
  // same on-disk evidence — every later startup aborted at the same workflow.
  for (const workflowId of await workflowIds(root, workflowIssues)) {
    try {
    const store = new WorkflowStore(workflowId, {
      stateDirectory: root,
      isProcessAlive: dependencies.isProcessAlive,
      getProcessStartToken: dependencies.getProcessStartToken,
    });
    const [lease, branch] = await Promise.all([
      observeWorkflowLease(
        store,
        dependencies.isProcessAlive,
        dependencies.getProcessStartToken,
      ),
      observeWorkflowBranch(
        root,
        workflowId,
        branchManager,
        dependencies.isProcessAlive,
        dependencies.getProcessStartToken,
      ),
    ]);

    if ((lease.presence === "present" && lease.status === "live")
      || branch.ownerStatus === "live") {
      results.push({ workflowId, disposition: "live-preserve" });
      continue;
    }

    const stateAbsent = await isAbsent(store.statePath);
    if (stateAbsent === true) {
      if (branch.presence === "present" && branch.ownerStatus === "dead"
        && branch.identity !== null) {
        const cleanup = await branchManager.cleanup(branch.identity, branch.identity.baseCommitOid);
        results.push({
          workflowId,
          disposition: cleanup.ok && cleanup.worktreeRemoved && cleanup.refsRemoved
            ? "dispose"
            : "human-decision-required",
        });
      } else {
        results.push({ workflowId, disposition: "human-decision-required" });
      }
      continue;
    }
    if (stateAbsent !== false) {
      results.push({ workflowId, disposition: "human-decision-required" });
      continue;
    }

    let state: AutopilotWorkflowState;
    let journal: WorkflowIntentJournal;
    try {
      [state, journal] = await Promise.all([store.read(), store.readIntentJournal()]);
    } catch {
      results.push({ workflowId, disposition: "human-decision-required" });
      continue;
    }
    if (TERMINAL_PHASES.has(state.phase)) {
      if ((lease.presence === "present" && lease.status === "unverifiable")
        || branch.ownerStatus === "unverifiable") {
        results.push({ workflowId, disposition: "human-decision-required" });
      }
      continue;
    }
    if (lease.presence !== "present" || lease.status !== "dead"
      || branch.presence === "ambiguous"
      || branch.ownerStatus === "unverifiable") {
      results.push({ workflowId, disposition: "human-decision-required" });
      continue;
    }

    const recorded = recordedBranch(journal, state);
    if (recorded === null) {
      results.push({ workflowId, disposition: "human-decision-required" });
      continue;
    }
    if (state.phase === "cleaning-up") {
      const expectedHead = expectedWorkflowHead(state);
      const intent = expectedHead === null ? null : cleanupIntent(journal, expectedHead);
      const directlyObserved = expectedHead !== null
        && state.finalGate?.headCommitOid === expectedHead
        && branch.presence === "absent"
        && await isAbsent(branchOwnershipPath(root, workflowId)) === true
        && await cleanupIsDirectlyObserved(recorded, dependencies.runGit);
      if (expectedHead === null || intent === null || !directlyObserved) {
        results.push({ workflowId, disposition: "human-decision-required" });
        continue;
      }
      await finalizeObservedWorkflow(store, state, expectedHead);
      results.push({ workflowId, disposition: "finalize" });
      continue;
    }

    if (branch.presence !== "present"
      || branch.identity === null
      || branch.ownerStatus !== "dead"
      || !sameWorkflowBranch(branch.identity, recorded)) {
      results.push({ workflowId, disposition: "human-decision-required" });
      continue;
    }
    const expectedHead = expectedWorkflowHead(state);
    if (expectedHead === null
      || !await activeBranchIsDirectlyObserved(
        branch.identity,
        expectedHead,
        dependencies.runGit,
      )) {
      results.push({ workflowId, disposition: "human-decision-required" });
      continue;
    }
    results.push({ workflowId, disposition: "resume" });
    } catch {
      results.push({ workflowId, disposition: "human-decision-required" });
    }
  }
  return results;
}

async function reclaimPendingRemovalLocks(
  locksRoot: string,
  isProcessAlive: (pid: number) => boolean,
  getProcessStartToken: (pid: number) => Promise<string | null>,
): Promise<void> {
  const { pending } = await readPendingWorktreeRemovalManifests();
  const seen = new Set<string>();
  for (const { manifest } of pending) {
    let commonDir: string;
    try {
      commonDir = await realpath(manifest.commonDir);
    } catch {
      continue;
    }
    if (!platformPathsEqual(commonDir, manifest.commonDir)) continue;
    const key = createHash("sha256").update(commonDir).digest("hex");
    if (seen.has(key)) continue;
    seen.add(key);
    await reclaimDeadLock(
      path.join(locksRoot, `${key}.lock`),
      isProcessAlive,
      getProcessStartToken,
    );
  }
}

export async function recoverStaleRuns(
  dependencies: RecoveryDependencies = {},
): Promise<RecoveryResult> {
  const root = await stateRoot();
  const ps = dependencies.platformServices ?? getPlatformServices();
  const isProcessAlive = dependencies.isProcessAlive ?? defaultIsProcessAlive;
  const runGit = dependencies.git ?? git;
  if (root === null) return { recovered: [], quarantined: [] };

  const locksRoot = path.join(root, "locks");
  await mkdir(locksRoot, { recursive: true });
  if (await plainDirectoryIdentity(locksRoot) === null) {
    throw new RuntimeError("recovery locks directory disappeared");
  }
  const ownerContents = Buffer.from(JSON.stringify({
    pid: nodeProcess.pid,
    processToken: await ps.getProcessStartToken(nodeProcess.pid),
  }));
  const recoveryLockPath = path.join(locksRoot, "recovery.lock");
  const recoveryLock = await acquireOwnedLock(
    recoveryLockPath,
    ownerContents,
    isProcessAlive,
    pid => ps.getProcessStartToken(pid),
  );
  if (recoveryLock === null) {
    return {
      recovered: [],
      quarantined: [],
      worktreeSweepIssues: [worktreeSweepIssue(
        recoveryLockPath,
        new RuntimeError("startup recovery is deferred by an active or unverifiable recovery lease"),
      )],
    };
  }

  let primaryError: unknown;
  try {
    const runsRoot = path.join(root, "runs");
    const runsIdentity = await plainDirectoryIdentity(runsRoot);
    // The reconciler completes interrupted prunes under a per-repo checkout lease
    // rather than deferring them, so no run is skipped for a pending prune.
    if (runsIdentity !== null) {
      // A crash can leave the cleanup-journal mutex held by a dead owner. That lock
      // is a 64-hex leaf reclaimed by reclaimLocks() near the end of this body, but
      // replayInterruptedPrunes acquires it first — so without an up-front reclaim a
      // stale lock would make replay spin to its deadline and throw, aborting recovery
      // before reclaimLocks ever runs and permanently blocking every future pass.
      await reclaimDeadLock(
        path.join(locksRoot, `${CLEANUP_JOURNAL_LOCK_KEY}.lock`),
        isProcessAlive,
        pid => ps.getProcessStartToken(pid),
      );
      await replayInterruptedPrunes(runsRoot, ps);
    }
    // Pending removal replay also acquires the per-repository checkout lock.
    // Reclaim only locks named by those manifests here; broad lock reclamation
    // remains at the end, after live run ownership has been revalidated.
    await reclaimPendingRemovalLocks(
      locksRoot,
      isProcessAlive,
      pid => ps.getProcessStartToken(pid),
    );
    // A removal crash can temporarily hide a worktree's administrative
    // directory. Reconcile that durable transaction before stale-run cleanup
    // asks Git to inspect the worktree, or the run is falsely poisoned and its
    // restored worktree becomes permanently claimed by the quarantine journal.
    const pendingRemovalIssues = await recoverPendingWorktreeRemovals(ps);
    const removalsAmbiguous = pendingRemovalIssues.length > 0;
    const journaledQuarantines = runsIdentity === null
      ? new Set<string>()
      : (await readRecoveryQuarantineJournal(runsRoot)).runIds;

    const stale: Array<{ record: RunStartRecord; runStartText: string }> = [];
    const terminalCleanupIssues: WorktreeSweepIssue[] = [];
    const recovered: string[] = [];
    const quarantined: string[] = [];
    const claimedRunIds = new Set(journaledQuarantines);
    const knownRunIds = new Set(journaledQuarantines);
    if (runsIdentity !== null) {
      const runEntries = await readdir(runsRoot, { withFileTypes: true });
      for (const entry of runEntries) {
        if (entry.isDirectory() && !entry.isSymbolicLink() && SAFE_RUN_ID.test(entry.name)) {
          knownRunIds.add(entry.name);
        } else if (entry.isDirectory()
          && !entry.isSymbolicLink()
          && entry.name.startsWith(".poisoned-")
          && SAFE_RUN_ID.test(entry.name.slice(".poisoned-".length))) {
          knownRunIds.add(entry.name.slice(".poisoned-".length));
        }
      }
      for (const entry of runEntries.sort((left, right) => left.name.localeCompare(right.name))) {
        if (entry.isDirectory() && !entry.isSymbolicLink() && entry.name.startsWith(".poisoned-")) {
          const runId = entry.name.slice(".poisoned-".length);
          validateRunId(runId);
          if (!journaledQuarantines.has(runId)) {
            throw new RuntimeError(`unjournaled poisoned run detected: ${runId}`);
          }
          continue;
        }
        if (!entry.isDirectory() || entry.isSymbolicLink() || !SAFE_RUN_ID.test(entry.name)) continue;
        try {
          const runDirectory = path.join(runsRoot, entry.name);
          const runStartText = await readBoundedRegularFile(path.join(runDirectory, "run-start.json"));
          if (runStartText === null) {
            claimedRunIds.add(entry.name);
            continue;
          }
          const record = parseRunStart(runStartText, entry.name);
          const store = new ArtifactStore(entry.name);
          const result = await store.readResult();
          if (result !== null) {
            validateTerminalResult(result, entry.name);
            const marker = await store.readPipelineActiveMarker();
            if (marker !== null) {
              const markerStatus = await lockOwnerStatus(
                { pid: marker.pid, processToken: marker.processToken },
                isProcessAlive,
                pid => ps.getProcessStartToken(pid),
              );
              if (markerStatus !== "dead") {
                claimedRunIds.add(entry.name);
                continue;
              }
            }
            if (removalsAmbiguous) {
              claimedRunIds.add(entry.name);
              continue;
            }
            const checkoutLock = await acquireOwnedLock(
              path.join(locksRoot, `${record.lockKey}.lock`),
              ownerContents,
              isProcessAlive,
              pid => ps.getProcessStartToken(pid),
            );
            if (checkoutLock === null) {
              claimedRunIds.add(entry.name);
              continue;
            }
            let cleanupError: unknown;
            let cleanupFailed = false;
            let cleanupDeferred = false;
            try {
              const lockedRunStartText = await readBoundedRegularFile(
                path.join(runDirectory, "run-start.json"),
              );
              if (lockedRunStartText === null) {
                throw new RuntimeError("run-start recovery record disappeared during recovery");
              }
              const lockedRecord = parseRunStart(lockedRunStartText, entry.name);
              if (lockedRunStartText !== runStartText
                || lockedRecord.runId !== record.runId
                || lockedRecord.lockKey !== record.lockKey
                || lockedRecord.canonicalCommonDir !== record.canonicalCommonDir
                || lockedRecord.pid !== record.pid
                || lockedRecord.processToken !== record.processToken
                || lockedRecord.startedAt !== record.startedAt) {
                throw new RuntimeError("run-start recovery record changed during recovery");
              }
              const lockedResult = await store.readResult();
              if (lockedResult === null) {
                throw new RuntimeError("terminal attempt result disappeared during recovery");
              }
              validateTerminalResult(lockedResult, entry.name);
              const lockedMarker = await store.readPipelineActiveMarker();
              const commonDir = await validateGitCommonDir(lockedRecord.canonicalCommonDir);
              if (lockedMarker === null) {
                await cleanupRunWorktreesUnderLease(
                  root,
                  commonDir,
                  entry.name,
                  runGit,
                  knownRunIds,
                );
                await cleanupTemporarySliceRefs(commonDir, entry.name, runGit);
              } else {
                const lockedMarkerStatus = await lockOwnerStatus(
                  { pid: lockedMarker.pid, processToken: lockedMarker.processToken },
                  isProcessAlive,
                  pid => ps.getProcessStartToken(pid),
                );
                if (lockedMarkerStatus === "dead") {
                  if (lockedMarker.sliced) await archiveInterruptedPipeline(store, lockedResult);
                  await cleanupRunWorktreesUnderLease(
                    root,
                    commonDir,
                    entry.name,
                    runGit,
                    knownRunIds,
                  );
                  await cleanupTemporarySliceRefs(commonDir, entry.name, runGit);
                  await store.clearPipelineActiveMarker();
                } else {
                  cleanupDeferred = true;
                }
              }
            } catch (error) {
              cleanupError = error;
              cleanupFailed = true;
            } finally {
              try {
                await releaseOwnedLock(checkoutLock);
              } catch (releaseError) {
                if (!cleanupFailed) throw releaseError;
                throw new AggregateError(
                  [cleanupError, releaseError],
                  "terminal cleanup failed and its checkout lock could not be released",
                );
              }
            }
            if (cleanupFailed) {
              claimedRunIds.add(entry.name);
              terminalCleanupIssues.push(worktreeSweepIssue(
                runDirectory,
                cleanupError,
                record.canonicalCommonDir,
              ));
              continue;
            }
            if (cleanupDeferred) claimedRunIds.add(entry.name);
            continue;
          }
          let ownerStatus: LockOwnerStatus;
          try {
            ownerStatus = await lockOwnerStatus(
              record.pid === null ? null : { pid: record.pid, processToken: record.processToken },
              isProcessAlive,
              pid => ps.getProcessStartToken(pid),
            );
          } catch {
            ownerStatus = "unverifiable";
          }
          if (ownerStatus !== "dead") {
            claimedRunIds.add(entry.name);
            continue;
          }
          if (await lockIsOwnedByLiveProcess(
            locksRoot,
            record.lockKey,
            isProcessAlive,
            pid => ps.getProcessStartToken(pid),
          )) {
            claimedRunIds.add(entry.name);
            continue;
          }
          stale.push({ record, runStartText });
        } catch (error) {
          claimedRunIds.add(entry.name);
          if (!removalsAmbiguous) {
            await quarantineRun(runsRoot, entry.name, error);
            quarantined.push(entry.name);
          }
        }
      }
    }

    for (const { record, runStartText } of stale) {
      const checkoutLock = await acquireOwnedLock(
        path.join(locksRoot, `${record.lockKey}.lock`),
        ownerContents,
        isProcessAlive,
        pid => ps.getProcessStartToken(pid),
      );
      if (checkoutLock === null) {
        claimedRunIds.add(record.runId);
        continue;
      }
      let recoveryError: unknown;
      let recoveryFailed = false;
      let becameTerminal = false;
      let becameLive = false;
      try {
        const lockedRunStartText = await readBoundedRegularFile(
          path.join(runsRoot, record.runId, "run-start.json"),
        );
        if (lockedRunStartText === null) {
          throw new RuntimeError("run-start recovery record disappeared before stale recovery");
        }
        const lockedRecord = parseRunStart(lockedRunStartText, record.runId);
        if (lockedRunStartText !== runStartText) {
          throw new RuntimeError("run-start recovery record changed before stale recovery");
        }
        const lockedResult = await new ArtifactStore(record.runId).readResult();
        if (lockedResult !== null) {
          validateTerminalResult(lockedResult, record.runId);
          becameTerminal = true;
        } else {
          becameLive = await recoverRun(
            lockedRecord,
            root,
            ps,
            isProcessAlive,
            runGit,
            !removalsAmbiguous,
            knownRunIds,
          ) === "live-preserve";
        }
      } catch (error) {
        recoveryError = error;
        recoveryFailed = true;
      } finally {
        try {
          await releaseOwnedLock(checkoutLock);
        } catch (cleanupError) {
          if (!recoveryFailed) throw cleanupError;
          throw new AggregateError(
            [recoveryError, cleanupError],
            "stale-run recovery failed and its checkout lock could not be released",
          );
        }
      }
      if (recoveryFailed) {
        claimedRunIds.add(record.runId);
        if (!removalsAmbiguous) {
          await quarantineRun(runsRoot, record.runId, recoveryError);
          quarantined.push(record.runId);
        }
        continue;
      }
      if (becameTerminal || becameLive) {
        claimedRunIds.add(record.runId);
        continue;
      }
      recovered.push(record.runId);
    }
    await reclaimLocks(
      locksRoot,
      isProcessAlive,
      pid => ps.getProcessStartToken(pid),
    );
    const workflowRecoveryIssues: WorktreeSweepIssue[] = [];
    const workflows = removalsAmbiguous
      ? []
      : await recoverAutopilotWorkflows(root, {
        isProcessAlive,
        getProcessStartToken: pid => ps.getProcessStartToken(pid),
        runGit,
      }, workflowRecoveryIssues);
    const claimedWorkflowPrefixes = new Set<string>();
    for (const { workflowId } of workflows) {
      if (SAFE_WORKFLOW_ID.test(workflowId)
        && await plainDirectoryIdentity(path.join(root, "workflows", workflowId)) !== null) {
        claimedWorkflowPrefixes.add(
          createHash("sha256").update(workflowId).digest("hex").slice(0, 32),
        );
      }
    }
    const orphanWorktreeIssues = pendingRemovalIssues.length === 0
      ? await sweepOrphanWorktrees({
        root,
        locksRoot,
        claimedRunIds,
        claimedWorkflowPrefixes,
        ownerContents,
        isProcessAlive,
        getProcessStartToken: pid => ps.getProcessStartToken(pid),
        runGit,
      })
      : [];
    const worktreeSweepIssues = boundedWorktreeSweepIssues([
      ...pendingRemovalIssues.map(issue => worktreeSweepIssue(
        issue.manifestPath,
        issue.error,
        issue.repositoryIdentity,
      )),
      ...terminalCleanupIssues,
      ...workflowRecoveryIssues,
      ...orphanWorktreeIssues,
    ], path.join(root, "worktrees"));
    const result: RecoveryResult = workflows.length === 0
      ? { recovered, quarantined }
      : { recovered, quarantined, workflows };
    return worktreeSweepIssues.length === 0
      ? result
      : { ...result, worktreeSweepIssues };
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    try {
      await releaseOwnedLock(recoveryLock);
    } catch (cleanupError) {
      if (primaryError === undefined) throw cleanupError;
      throw new AggregateError(
        [primaryError, cleanupError],
        "startup recovery failed and its recovery lock could not be released",
      );
    }
  }
}
