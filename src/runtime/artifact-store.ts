import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  link,
  lstat,
  mkdir,
  open,
  opendir,
  readdir,
  realpath,
  rename,
  rm,
} from "node:fs/promises";
import path from "node:path";
import { git } from "../git/git-exec.js";
import { gitPathOutput } from "../git/git-output.js";
import { manifestHashOf } from "../git/changed-path-manifest.js";
import type {
  AttemptResult,
  CandidateArtifact,
  CommandOutcome,
} from "../protocol/attempt-result.js";
import type {
  AutopilotCandidateDecisionV2,
  CandidateDecision,
  CandidateDecisionV2,
  CandidateDecisionValue,
  HumanCandidateDecisionV2,
  LegacyDecisionAuthority,
} from "../protocol/candidate-decision.js";
import type { VerificationCommand } from "../protocol/delegation-spec.js";
import { loadSchemas } from "../protocol/schema-loader.js";
import { RuntimeError } from "../util/errors.js";
import {
  containsRegisteredSecret,
  containsRegisteredSecretValue,
  redact,
  redactRecord,
} from "./redaction.js";
import {
  reviewSnapshotHash,
  validateReviewSnapshot,
  type ReviewSnapshot,
} from "./review-snapshot.js";
import {
  sanitizeRunManifest,
  verifyRunManifest,
  type RunManifest,
} from "./run-manifest.js";
import { resolveStateDir } from "./state-dir.js";
import { getPlatformServices } from "../platform/select-platform.js";
import { PlatformSafety, platformSafety, openDurableDirectorySession } from "../platform/platform-safety.js";
import type { CheckoutLock, PlatformServices } from "../platform/platform-services.js";
import {
  advisorReportHash,
  autopilotDecisionEligibilityProjection,
  canonicalArtifactHash,
  eligibilityInputFromArtifacts,
  evaluateAutopilotEligibility,
  pipelineResultHash,
  type AutopilotEligibilityRecord,
} from "../autopilot/autopilot-eligibility.js";
import type { PipelineResult } from "../pipeline/pipeline-runtime.js";
import type { AdvisorReport } from "../pipeline/report-types.js";
import type { RunStatus } from "./run-status.js";

const SAFE_COMPONENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const WINDOWS_RESERVED_COMPONENT = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i;
const CANDIDATE_REF_PREFIX = "refs/claude-architect/candidates/";
const PRUNE_BACKUP_REF_PREFIX = "refs/claude-architect/prune-backups/";
const CLEANUP_JOURNAL = "cleanup.ndjson";
const NO_FOLLOW = constants.O_NOFOLLOW ?? 0;
const MAX_ARCHIVE_FILE_BYTES = 8_000_000;
const MAX_EVIDENCE_REFERENCES = 4_096;
const MAX_EVIDENCE_DEPTH = 16;
const schemas = loadSchemas();
const attemptResultSchema = schemas.attemptResult;
const candidateDecisionSchema = schemas.candidateDecision;
const advisorReportSchema = schemas.advisorReport;
const autopilotEligibilitySchema = schemas.autopilotEligibility;
const runStatusSchema = schemas.runStatus;

export interface PrunePolicy {
  maxAgeMs: number;
  maxBytes: number;
}

export interface PruneResult {
  removed: string[];
  retained: Array<{ runId: string; reason: string }>;
}

export interface PruneDependencies {
  platformServices?: Pick<PlatformServices, "acquireCheckoutLock" | "canonicalizePath">;
}

export type RunDecisionValue = CandidateDecisionValue;

/**
 * How the runtime obtained a decision, as the MCP lifecycle observed it.
 *
 * Distinct from the authority persisted with the decision: this describes the
 * mechanism the server used, and {@link decisionAuthorityFor} maps it onto the
 * recorded authority. `caller-asserted` means the MCP caller supplied the
 * decision and the runtime never confirmed a human made it — something an agent
 * can do — so recording the distinction is what makes "who accepted this"
 * answerable after the fact rather than assumed.
 */
export type DecisionProvenance = "human-elicitation" | "caller-asserted" | "policy-autonomous";

type HumanCandidateDecisionV2Input = Omit<
  HumanCandidateDecisionV2,
  "decisionVersion" | "authority"
>;

interface PersistedLegacyCandidateDecisionV1 {
  decision: CandidateDecisionValue;
  recordedAt: string;
  /** Written by 0.39.0+ alongside the legacy shape, without a `decisionVersion`. */
  decidedBy?: string;
  candidateManifestHash?: string | null;
}

export interface PipelineActiveMarker {
  pid: number;
  processToken: string | null;
  startedAt: string;
  sliced: boolean;
}

interface RunEntry {
  runId: string;
  directory: string;
  modifiedAtMs: number;
  bytes: number;
  identity: DirectoryIdentity;
}

interface DirectoryIdentity {
  dev: number;
  ino: number;
}

interface ValidatedDirectory {
  path: string;
  identity: DirectoryIdentity;
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

interface PreparedAnchorCleanup {
  outcome: AnchorCleanup;
  repoRoot: string | null;
  anchorRef: string | null;
  backupRef: string | null;
  candidateCommitOid: string | null;
}

interface AnchorCleanupTransaction {
  outcome: AnchorCleanup;
  commit(): Promise<void>;
  rollback(): Promise<void>;
}

let cleanupJournalTail: Promise<void> = Promise.resolve();

function isSafeComponent(value: string): boolean {
  const base = value.split(".", 1)[0] ?? value;
  return SAFE_COMPONENT.test(value)
    && !value.endsWith(".")
    && !WINDOWS_RESERVED_COMPONENT.test(base);
}

const STORE_TEMPORARY_RESIDUE =
  /^\..+\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tmp$/u;

function validateComponent(value: string, kind: "run id" | "log name"): void {
  if (!isSafeComponent(value) || (kind === "run id" && value !== value.toLowerCase())) {
    throw new RuntimeError(`invalid ${kind}: ${JSON.stringify(value)}`);
  }
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code;
}

function isMissing(error: unknown): boolean {
  return errorCode(error) === "ENOENT";
}

function isAlreadyPresent(error: unknown): boolean {
  return errorCode(error) === "EEXIST";
}

async function pathExists(filename: string): Promise<boolean> {
  try {
    await lstat(filename);
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

function validatePruneLimit(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new RuntimeError(`invalid ${name}`);
  }
}

function compareEntries(left: RunEntry, right: RunEntry): number {
  if (left.modifiedAtMs !== right.modifiedAtMs) {
    return left.modifiedAtMs - right.modifiedAtMs;
  }
  return left.runId < right.runId ? -1 : left.runId > right.runId ? 1 : 0;
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === ""
    || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

async function ensurePlainDirectory(directory: string): Promise<DirectoryIdentity> {
  let created = false;
  try {
    await mkdir(directory, { mode: 0o700 });
    created = true;
  } catch (error) {
    if (!isAlreadyPresent(error)) throw error;
  }
  const metadata = await lstat(directory);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new RuntimeError(`archive directory must not be a symbolic link: ${redact(directory)}`);
  }
  if (created) await syncDirectory(path.dirname(directory));
  return { dev: metadata.dev, ino: metadata.ino };
}

async function ensurePlainDirectoryTree(directory: string): Promise<DirectoryIdentity> {
  try {
    return await ensurePlainDirectory(directory);
  } catch (error) {
    if (!isMissing(error)) throw error;
    const parent = path.dirname(directory);
    if (parent === directory) throw error;
    await ensurePlainDirectoryTree(parent);
    return ensurePlainDirectory(directory);
  }
}

async function assertDirectoryIdentity(
  directory: string,
  expected: DirectoryIdentity,
): Promise<void> {
  const metadata = await lstat(directory);
  if (metadata.isSymbolicLink()
    || !metadata.isDirectory()
    || metadata.dev !== expected.dev
    || metadata.ino !== expected.ino) {
    throw new RuntimeError("archive directory identity changed during operation");
  }
}

async function syncDirectory(directory: string): Promise<void> {
  let handle;
  try {
    handle = await open(directory, constants.O_RDONLY | NO_FOLLOW);
    await handle.sync();
  } catch (error) {
    const unsupportedOnWindows = process.platform === "win32"
      && ["EISDIR", "EINVAL", "ENOTSUP", "EPERM"].includes(errorCode(error) ?? "");
    if (!unsupportedOnWindows) throw error;
  } finally {
    await handle?.close();
  }
}

async function readRegularFile(
  filename: string,
  parentIdentity?: DirectoryIdentity,
): Promise<string> {
  // Reject a symlinked leaf on every platform. `O_NOFOLLOW` is the atomic guard
  // on POSIX but is a no-op on Windows (`O_NOFOLLOW` is undefined there, so
  // `NO_FOLLOW` is 0), which would otherwise let the open follow a symlink out
  // of the archive. The pre-open lstat closes that Windows gap; the fd-identity
  // checks below still defend against a POSIX TOCTOU swap.
  const linkMetadata = await lstat(filename);
  if (linkMetadata.isSymbolicLink()) {
    throw new RuntimeError(`archive entry must not be a symbolic link: ${redact(filename)}`);
  }
  const handle = await open(filename, constants.O_RDONLY | NO_FOLLOW);
  try {
    if (parentIdentity !== undefined) {
      await assertDirectoryIdentity(path.dirname(filename), parentIdentity);
    }
    const metadata = await handle.stat();
    if (!metadata.isFile()) {
      throw new RuntimeError(`archive entry is not a regular file: ${redact(filename)}`);
    }
    if (metadata.nlink !== 1) {
      throw new RuntimeError(`archive entry has an unsafe link count: ${redact(filename)}`);
    }
    if (metadata.size > MAX_ARCHIVE_FILE_BYTES) {
      throw new RuntimeError(`archive entry exceeds byte limit: ${redact(filename)}`);
    }
    const contents = Buffer.alloc(metadata.size + 1);
    let offset = 0;
    while (offset < contents.length) {
      const read = await handle.read(contents, offset, contents.length - offset, offset);
      if (read.bytesRead === 0) break;
      offset += read.bytesRead;
    }
    if (offset > MAX_ARCHIVE_FILE_BYTES) {
      throw new RuntimeError(`archive entry exceeds byte limit: ${redact(filename)}`);
    }
    const finalMetadata = await handle.stat();
    if (!finalMetadata.isFile()
      || finalMetadata.nlink !== 1
      || finalMetadata.dev !== metadata.dev
      || finalMetadata.ino !== metadata.ino
      || finalMetadata.size !== metadata.size
      || finalMetadata.mtimeMs !== metadata.mtimeMs
      || finalMetadata.ctimeMs !== metadata.ctimeMs) {
      throw new RuntimeError(`archive entry changed while being read: ${redact(filename)}`);
    }
    if (parentIdentity !== undefined) {
      await assertDirectoryIdentity(path.dirname(filename), parentIdentity);
    }
    return contents.subarray(0, offset).toString("utf8");
  } finally {
    await handle.close();
  }
}

async function directoryBytes(
  directory: string,
  expectedIdentity?: DirectoryIdentity,
): Promise<number> {
  const metadata = await lstat(directory);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new RuntimeError("archive size accounting requires a plain directory");
  }
  if (expectedIdentity !== undefined
    && (metadata.dev !== expectedIdentity.dev || metadata.ino !== expectedIdentity.ino)) {
    throw new RuntimeError("archive directory identity changed during size accounting");
  }
  const identity = { dev: metadata.dev, ino: metadata.ino };
  let total = 0;
  let entries;
  try {
    entries = await opendir(directory);
  } catch (error) {
    if (isMissing(error)) return 0;
    throw error;
  }
  try {
    await assertDirectoryIdentity(directory, identity);
    for await (const entry of entries) {
      await assertDirectoryIdentity(directory, identity);
      const entryPath = path.join(directory, entry.name);
      try {
        const entryMetadata = await lstat(entryPath);
        if (entryMetadata.isSymbolicLink()) {
          throw new RuntimeError("archive size accounting encountered a symbolic link");
        }
        if (entryMetadata.isDirectory()) total += await directoryBytes(entryPath);
        else if (entryMetadata.isFile()) total += entryMetadata.size;
        await assertDirectoryIdentity(directory, identity);
      } catch (error) {
        if (!isMissing(error)) throw error;
      }
    }
    await assertDirectoryIdentity(directory, identity);
  } finally {
    await entries.close().catch(error => {
      if (errorCode(error) !== "ERR_DIR_CLOSED") throw error;
    });
  }
  return total;
}

function enqueueCleanupJournalWrite(write: () => Promise<void>): Promise<void> {
  const result = cleanupJournalTail.then(write, write);
  cleanupJournalTail = result.catch(() => {});
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

function serializeJson(value: unknown, indentation?: number): string {
  if (containsRegisteredSecretValue(value)) {
    throw new RuntimeError("archive JSON cannot be safely persisted after redaction");
  }
  const serialized = escapeJsonPropertyKeys(JSON.stringify(value, null, indentation));
  if (containsRegisteredSecret(serialized)) {
    throw new RuntimeError("archive JSON cannot be safely persisted after redaction");
  }
  return serialized;
}

function preserveIdentity(value: string, label: string): string {
  if (redact(value) !== value) {
    throw new RuntimeError(`${label} cannot be safely persisted after redaction`);
  }
  return value;
}

function preserveNullableIdentity(value: string | null, label: string): string | null {
  return value === null ? null : preserveIdentity(value, label);
}

function preserveCandidatePath(value: string): string {
  const candidatePath = preserveIdentity(value, "candidate path");
  const segments = candidatePath.split("/");
  if (candidatePath === ""
    || candidatePath.includes("\\")
    || candidatePath.includes("\0")
    || path.posix.isAbsolute(candidatePath)
    || path.win32.isAbsolute(candidatePath)
    || /^[A-Za-z]:/.test(candidatePath)
    || segments.some(segment => segment === "" || segment === "." || segment === "..")) {
    throw new RuntimeError("candidate path must be a normalized relative Git path");
  }
  return candidatePath;
}

function sanitizeVerificationCommand(command: VerificationCommand): VerificationCommand {
  const sanitized: VerificationCommand = {
    id: preserveIdentity(command.id, "verification command id"),
    executable: redact(command.executable),
    args: command.args.map(redact),
    cwd: redact(command.cwd),
    timeoutMs: command.timeoutMs,
    network: command.network,
    expectedExitCodes: [...command.expectedExitCodes],
  };
  if (command.expectBaselineFailure !== undefined) {
    sanitized.expectBaselineFailure = command.expectBaselineFailure;
  }
  if (command.allowedMutations !== undefined) {
    sanitized.allowedMutations = command.allowedMutations;
  }
  if (command.environment !== undefined) {
    sanitized.environment = redactRecord(command.environment);
  }
  if (command.platform !== undefined) {
    sanitized.platform = {
      ...(command.platform.os === undefined ? {} : { os: [...command.platform.os] }),
      ...(command.platform.arch === undefined
        ? {}
        : { arch: command.platform.arch.map(arch => preserveIdentity(arch, "platform arch")) }),
    };
  }
  return sanitized;
}

function sanitizeCommandOutcome(outcome: CommandOutcome): CommandOutcome {
  return {
    id: preserveIdentity(outcome.id, "command outcome id"),
    executable: redact(outcome.executable),
    args: outcome.args.map(redact),
    exitCode: outcome.exitCode,
    timedOut: outcome.timedOut,
    durationMs: outcome.durationMs,
    stdoutRef: preserveIdentity(outcome.stdoutRef, "stdout archive ref"),
    stderrRef: preserveIdentity(outcome.stderrRef, "stderr archive ref"),
  };
}

function sanitizeCandidate(candidate: CandidateArtifact): CandidateArtifact {
  const changedPaths = candidate.changedPaths.map(change => ({
    path: preserveCandidatePath(change.path),
    changeType: change.changeType,
    mode: preserveIdentity(change.mode, "candidate mode"),
    contentHash: preserveNullableIdentity(change.contentHash, "candidate content hash"),
  }));
  const expectedManifestHash = manifestHashOf(changedPaths);
  if (candidate.manifestHash !== expectedManifestHash) {
    throw new RuntimeError("candidate manifest hash does not match changed paths");
  }
  return {
    baseCommitOid: preserveIdentity(candidate.baseCommitOid, "candidate base commit oid"),
    candidateTreeOid: preserveIdentity(candidate.candidateTreeOid, "candidate tree oid"),
    candidateCommitOid: preserveIdentity(candidate.candidateCommitOid, "candidate commit oid"),
    anchorRef: preserveIdentity(candidate.anchorRef, "candidate anchor ref"),
    manifestHash: preserveIdentity(candidate.manifestHash, "candidate manifest hash"),
    changedPaths,
    patch: redact(candidate.patch),
  };
}

function sanitizeAttemptResult(result: AttemptResult): AttemptResult {
  return {
    resultVersion: result.resultVersion,
    runId: preserveIdentity(result.runId, "attempt run id"),
    status: preserveIdentity(result.status, "attempt status") as AttemptResult["status"],
    failure: result.failure === null
      ? null
      : preserveIdentity(
        result.failure,
        "failure classification",
      ) as NonNullable<AttemptResult["failure"]>,
    summary: redact(result.summary),
    producerSummary: result.producerSummary === null ? null : redact(result.producerSummary),
    candidate: result.candidate === null ? null : sanitizeCandidate(result.candidate),
    requestedVerification: result.requestedVerification.map(sanitizeVerificationCommand),
    executedVerification: result.executedVerification.map(sanitizeCommandOutcome),
    unresolvedIssues: result.unresolvedIssues.map(redact),
    evidence: redactRecord(result.evidence),
    logsRef: preserveIdentity(result.logsRef, "logs archive ref"),
    producerId: preserveNullableIdentity(result.producerId, "producer id"),
    producerVersion: preserveNullableIdentity(result.producerVersion, "producer version"),
    producerModel: preserveNullableIdentity(result.producerModel, "producer model"),
    durationMs: result.durationMs,
    sessionId: preserveNullableIdentity(result.sessionId, "producer session id"),
  };
}

function verifyAttemptResult(value: unknown, runId: string): AttemptResult {
  if (!attemptResultSchema(value)) {
    throw new RuntimeError("archived attempt result is invalid");
  }
  const result = value as AttemptResult;
  if (result.runId !== runId) {
    throw new RuntimeError("archived attempt result run id does not match");
  }
  return result;
}

function isCandidateDecisionValue(value: unknown): value is CandidateDecisionValue {
  return (["accepted", "rejected", "revision-requested"] as const)
    .includes(value as CandidateDecisionValue);
}

function verifyCandidateDecisionV2(value: unknown): CandidateDecisionV2 {
  if (!candidateDecisionSchema(value)) {
    throw new RuntimeError("candidate decision is invalid");
  }
  return value as CandidateDecisionV2;
}

function parsePersistedDecision(value: unknown): CandidateDecision {
  if (typeof value === "object"
    && value !== null
    && (value as { decisionVersion?: unknown }).decisionVersion === "2") {
    try {
      return verifyCandidateDecisionV2(value);
    } catch {
      throw new RuntimeError("archived run decision is malformed");
    }
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new RuntimeError("archived run decision is malformed");
  }
  const legacy = value as Partial<PersistedLegacyCandidateDecisionV1>;
  const keys = Object.keys(value);
  // Two legacy shapes reach this branch. The original pre-provenance record is
  // exactly `{decision, recordedAt}`. From 0.39.0 the MCP lifecycle also wrote
  // `decidedBy` and `candidateManifestHash` without a `decisionVersion`, so a
  // strict two-key check would reject every archive the currently-shipped
  // release produced — making a live run's own decision unreadable, which
  // strands recovery, integration, and prune's "retain undecided runs" branch.
  const allowedKeys = new Set(["decision", "recordedAt", "decidedBy", "candidateManifestHash"]);
  if (!keys.includes("decision")
    || !keys.includes("recordedAt")
    || keys.some(key => !allowedKeys.has(key))
    || !isCandidateDecisionValue(legacy.decision)
    || typeof legacy.recordedAt !== "string"
    || !Number.isFinite(Date.parse(legacy.recordedAt))) {
    throw new RuntimeError("archived run decision is malformed");
  }
  const hash = legacy.candidateManifestHash;
  if (hash !== undefined && hash !== null && !/^[0-9a-f]{64}$/u.test(hash)) {
    throw new RuntimeError("archived run decision is malformed");
  }
  return {
    decisionVersion: "1",
    decision: legacy.decision,
    authority: legacyDecisionAuthority(legacy.decidedBy),
    recordedAt: legacy.recordedAt,
    ...(hash === undefined ? {} : { candidateManifestHash: hash }),
  };
}

/**
 * Map a 0.39.0-era `decidedBy` onto the authority vocabulary integration reads.
 *
 * An absent value is reported as `unknown` rather than `human`: the record was
 * written before provenance existed, so claiming a person made it would invent
 * evidence — and would hand a pre-provenance archive the one authority that
 * passes the integration gate.
 */
function legacyDecisionAuthority(decidedBy: unknown): LegacyDecisionAuthority {
  switch (decidedBy) {
    case "human-elicitation": return "human";
    case "policy-autonomous": return "policy-autonomous";
    case "caller-asserted": return "caller-asserted";
    default: return "unknown";
  }
}

function hasIdenticalDecisionProvenance(
  existing: CandidateDecision,
  attempted: CandidateDecision,
): boolean {
  if (existing.decisionVersion !== attempted.decisionVersion
    || existing.decision !== attempted.decision
    || existing.authority !== attempted.authority) {
    return false;
  }
  if (existing.decisionVersion === "1" || attempted.decisionVersion === "1") {
    return true;
  }
  return existing.candidateManifestHash === attempted.candidateManifestHash
    && existing.evidenceHash === attempted.evidenceHash
    && existing.policyVersion === attempted.policyVersion;
}

function validateAdvisorReport(value: unknown): AdvisorReport {
  if (!advisorReportSchema(value)) {
    throw new RuntimeError("archived advisor report is invalid");
  }
  return value as AdvisorReport;
}

function validateAutopilotEligibilityRecord(
  value: unknown,
  runId: string,
): AutopilotEligibilityRecord {
  if (!autopilotEligibilitySchema(value)) {
    throw new RuntimeError("archived autopilot eligibility record is invalid");
  }
  const record = value as AutopilotEligibilityRecord;
  if (record.runId !== runId || record.eligible !== (record.reasons.length === 0)) {
    throw new RuntimeError("archived autopilot eligibility record is inconsistent");
  }
  return record;
}

interface PostPipelineAutopilotArtifacts {
  artifactVersion: "1";
  advisorReport: AdvisorReport;
  eligibility: AutopilotEligibilityRecord;
  advisorReportHash: string;
  eligibilityRecordHash: string;
}

function validatePostPipelineAutopilotArtifacts(
  value: unknown,
  runId: string,
): PostPipelineAutopilotArtifacts {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new RuntimeError("archived post-pipeline autopilot artifacts are invalid");
  }
  const candidate = value as Partial<PostPipelineAutopilotArtifacts>;
  const keys = Object.keys(value);
  if (keys.length !== 5
    || !keys.includes("artifactVersion")
    || !keys.includes("advisorReport")
    || !keys.includes("eligibility")
    || !keys.includes("advisorReportHash")
    || !keys.includes("eligibilityRecordHash")
    || candidate.artifactVersion !== "1") {
    throw new RuntimeError("archived post-pipeline autopilot artifacts are invalid");
  }
  const advisorReport = validateAdvisorReport(candidate.advisorReport);
  const eligibility = validateAutopilotEligibilityRecord(candidate.eligibility, runId);
  const expectedAdvisorHash = advisorReportHash(advisorReport);
  const expectedEligibilityHash = canonicalArtifactHash(eligibility);
  if (candidate.advisorReportHash !== expectedAdvisorHash
    || candidate.eligibilityRecordHash !== expectedEligibilityHash
    || eligibility.advisorReportHash !== expectedAdvisorHash) {
    throw new RuntimeError("archived post-pipeline autopilot artifact hashes do not agree");
  }
  return {
    artifactVersion: "1",
    advisorReport,
    eligibility,
    advisorReportHash: expectedAdvisorHash,
    eligibilityRecordHash: expectedEligibilityHash,
  };
}

export class ArtifactStore {
  readonly runDirectory: string;
  private readonly runsRoot: string;
  private readonly runId: string;

  constructor(runId: string) {
    validateComponent(runId, "run id");
    this.runId = runId;
    this.runsRoot = path.join(resolveStateDir(), "runs");
    this.runDirectory = path.join(this.runsRoot, runId);
  }

  private async ensureRunsRoot(): Promise<string> {
    await ensurePlainDirectoryTree(path.dirname(this.runsRoot));
    await ensurePlainDirectory(this.runsRoot);
    return realpath(this.runsRoot);
  }

  private async ensureRunDirectory(create: boolean): Promise<string | null> {
    const canonicalRunsRoot = await this.ensureRunsRoot();
    if (create) {
      await ensurePlainDirectory(this.runDirectory);
    } else {
      try {
        const metadata = await lstat(this.runDirectory);
        if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
          throw new RuntimeError(`archive directory must not be a symbolic link: ${redact(this.runDirectory)}`);
        }
      } catch (error) {
        if (isMissing(error)) return null;
        throw error;
      }
    }
    const canonicalRunDirectory = await realpath(this.runDirectory);
    if (!isWithin(canonicalRunsRoot, canonicalRunDirectory)) {
      throw new RuntimeError("archive directory escapes plugin data");
    }
    return canonicalRunDirectory;
  }

  private async ensureArchiveDirectory(relativePath: string): Promise<string> {
    if (path.isAbsolute(relativePath)) throw new RuntimeError("archive path must be relative");
    const normalized = path.normalize(relativePath);
    if (normalized === ".." || normalized.startsWith(`..${path.sep}`)) {
      throw new RuntimeError("archive path escapes run directory");
    }

    const canonicalRunDirectory = await this.ensureRunDirectory(true);
    if (canonicalRunDirectory === null) throw new RuntimeError("failed to create archive directory");
    const relativeDirectory = path.dirname(normalized);
    if (relativeDirectory === ".") return canonicalRunDirectory;

    let current = canonicalRunDirectory;
    for (const component of relativeDirectory.split(path.sep)) {
      validateComponent(component, "log name");
      current = path.join(current, component);
      await ensurePlainDirectory(current);
      const canonicalCurrent = await realpath(current);
      if (!isWithin(canonicalRunDirectory, canonicalCurrent)) {
        throw new RuntimeError("archive directory escapes run directory");
      }
      current = canonicalCurrent;
    }
    return current;
  }

  private async writeArchiveFile(relativePath: string, text: string): Promise<void> {
    const directory = await this.ensureArchiveDirectory(relativePath);
    const session = await openDurableDirectorySession(directory);
    try {
      await platformSafety.writeAtomic(session, path.basename(relativePath), text, "immutable");
    } finally {
      await session.close();
    }
  }

  private async writeJson(relativePath: string, value: unknown): Promise<void> {
    const serialized = `${serializeJson(value, 2)}\n`;
    await this.writeArchiveFile(relativePath, serialized);
  }

  private async replaceJson(relativePath: string, value: unknown): Promise<void> {
    if (path.isAbsolute(relativePath)
      || path.dirname(relativePath) !== "."
      || path.basename(relativePath) !== relativePath
      || !isSafeComponent(relativePath)) {
      throw new RuntimeError("replacement archive path must be a safe relative leaf");
    }
    const directory = await this.ensureRunDirectory(false);
    if (directory === null) throw new RuntimeError("run archive does not exist");
    const session = await openDurableDirectorySession(directory);
    try {
      const serialized = `${serializeJson(value, 2)}\n`;
      await platformSafety.writeAtomic(session, relativePath, serialized, "replace");
    } finally {
      await session.close();
    }
  }


  async writeRunStatus(status: RunStatus): Promise<void> {
    if (status.runId !== this.runId) {
      throw new RuntimeError("run status id does not match artifact store");
    }
    const sanitized: RunStatus = {
      ...structuredClone(status),
      detail: status.detail === null ? null : redact(status.detail).slice(0, 200),
    };
    if (!runStatusSchema(sanitized)) {
      throw new RuntimeError("run status is invalid");
    }
    const directory = await this.ensureRunDirectory(false);
    if (directory === null) return;
    await this.replaceJson("status.json", sanitized);
  }

  async readRunStatus(runId: string): Promise<RunStatus | null> {
    validateComponent(runId, "run id");
    const runDirectory = path.join(this.runsRoot, runId);
    const validated = await this.ensureExistingRunDirectory(runDirectory);
    if (validated === null) return null;
    try {
      const value: unknown = JSON.parse(await readRegularFile(
        path.join(validated.path, "status.json"),
        validated.identity,
      ));
      if (!runStatusSchema(value)) throw new RuntimeError("archived run status is malformed");
      return value as RunStatus;
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
  }

  async writeLog(name: string, text: string): Promise<string> {
    validateComponent(name, "log name");
    const ref = path.posix.join("logs", `${name}.log`);
    await this.writeArchiveFile(ref, redact(text));
    return ref;
  }

  async writePipelineArtifact(name: string, value: unknown): Promise<void> {
    validateComponent(name, "log name");
    await this.writeJson(
      path.posix.join("pipeline", `${name}.json`),
      redactRecord(value),
    );
  }

  async readPipelineArtifact<T>(runId: string, name: string): Promise<T | null> {
    validateComponent(runId, "run id");
    validateComponent(name, "log name");
    const runDirectory = path.join(this.runsRoot, runId);
    const validatedRun = await this.ensureExistingRunDirectory(runDirectory);
    if (validatedRun === null) return null;
    const validated = await this.ensureExistingRunDirectory(path.join(runDirectory, "pipeline"));
    if (validated === null) return null;
    if (!isWithin(validatedRun.path, validated.path)) {
      throw new RuntimeError("pipeline archive directory escapes run directory");
    }
    await assertDirectoryIdentity(validatedRun.path, validatedRun.identity);
    try {
      const value = JSON.parse(await readRegularFile(
        path.join(validated.path, `${name}.json`),
        validated.identity,
      )) as T;
      await assertDirectoryIdentity(validatedRun.path, validatedRun.identity);
      return value;
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
  }

  /**
   * Read immutable evidence bytes from this run without permitting traversal or
   * following directory/file symlinks. Final cumulative review uses this
   * narrow primitive so its hashes bind the exact archived bytes, not merely a
   * caller-supplied reference.
   */
  async readEvidence(reference: string): Promise<string | null> {
    if (typeof reference !== "string"
      || reference.length < 1
      || reference.length > 1024
      || path.posix.isAbsolute(reference)
      || reference.includes("\\")
      || /[\0\r\n]/u.test(reference)) {
      throw new RuntimeError("invalid archived evidence reference");
    }
    const components = reference.split("/");
    if (components.some(component => component === "" || component === "." || component === "..")) {
      throw new RuntimeError("invalid archived evidence reference");
    }
    for (const component of components) validateComponent(component, "log name");

    const run = await this.ensureExistingRunDirectory(this.runDirectory);
    if (run === null) return null;
    let directory = run;
    try {
      for (const component of components.slice(0, -1)) {
        await assertDirectoryIdentity(directory.path, directory.identity);
        const child = path.join(directory.path, component);
        const metadata = await lstat(child);
        if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
          throw new RuntimeError("archived evidence directory is not a plain directory");
        }
        const canonical = await realpath(child);
        if (!isWithin(run.path, canonical)) {
          throw new RuntimeError("archived evidence reference escapes run directory");
        }
        directory = {
          path: canonical,
          identity: { dev: metadata.dev, ino: metadata.ino },
        };
        await assertDirectoryIdentity(directory.path, directory.identity);
      }
      const content = await readRegularFile(
        path.join(directory.path, components.at(-1)!),
        directory.identity,
      );
      await assertDirectoryIdentity(run.path, run.identity);
      return content;
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
  }

  /**
   * Enumerate the complete run archive from the archive itself. Callers must
   * not be able to omit review, repair, advisor, or promotion evidence by
   * supplying only a hand-picked list of references.
   */
  async listEvidenceReferences(): Promise<string[]> {
    const run = await this.ensureExistingRunDirectory(this.runDirectory);
    if (run === null) return [];
    const references: string[] = [];

    const walk = async (
      directory: ValidatedDirectory,
      components: string[],
    ): Promise<void> => {
      if (components.length > MAX_EVIDENCE_DEPTH) {
        throw new RuntimeError("archived evidence nesting exceeds the supported limit");
      }
      await assertDirectoryIdentity(directory.path, directory.identity);
      const names = (await readdir(directory.path)).sort();
      for (const name of names) {
        // The store writes `.{basename}.{uuid}.tmp` siblings when persisting.
        // A crash can leave one behind, and `validateComponent` rejects
        // dot-prefixed names, so a single leftover would make every evidence
        // walk for this run throw until someone cleaned it up by hand. Skip
        // only the store's own residue; any other dot-file is still an error.
        if (STORE_TEMPORARY_RESIDUE.test(name)) continue;
        validateComponent(name, "log name");
        const child = path.join(directory.path, name);
        const metadata = await lstat(child);
        if (metadata.isSymbolicLink()) {
          throw new RuntimeError("archived evidence must not contain symbolic links");
        }
        const reference = [...components, name].join("/");
        if (reference.length > 1024) {
          throw new RuntimeError("archived evidence reference is too long");
        }
        if (metadata.isDirectory()) {
          const canonical = await realpath(child);
          if (!isWithin(run.path, canonical)) {
            throw new RuntimeError("archived evidence directory escapes run directory");
          }
          const nested = {
            path: canonical,
            identity: { dev: metadata.dev, ino: metadata.ino },
          };
          await assertDirectoryIdentity(nested.path, nested.identity);
          await walk(nested, [...components, name]);
          continue;
        }
        if (!metadata.isFile()) {
          throw new RuntimeError("archived evidence entry is not a regular file");
        }
        references.push(reference);
        if (references.length > MAX_EVIDENCE_REFERENCES) {
          throw new RuntimeError("archived evidence exceeds the supported file limit");
        }
      }
      await assertDirectoryIdentity(directory.path, directory.identity);
    };

    await walk(run, []);
    await assertDirectoryIdentity(run.path, run.identity);
    return references.sort();
  }

  async writeResult(result: AttemptResult): Promise<void> {
    if (result.runId !== this.runId) {
      throw new RuntimeError("attempt result run id does not match artifact store");
    }
    const sanitized = sanitizeAttemptResult(result);
    verifyAttemptResult(sanitized, this.runId);
    await this.writeJson("result.json", sanitized);
  }

  async writeManifest(manifest: RunManifest): Promise<void> {
    if (manifest.runId !== this.runId) {
      throw new RuntimeError("run manifest id does not match artifact store");
    }
    const sanitized = sanitizeRunManifest(manifest);
    verifyRunManifest(sanitized, this.runId);
    await this.writeJson("manifest.json", sanitized);
  }

  async promoteTerminalArtifacts(args: {
    result: AttemptResult;
    manifest: RunManifest;
  }): Promise<void> {
    if (args.result.runId !== this.runId) {
      throw new RuntimeError("attempt result run id does not match artifact store");
    }
    if (args.manifest.runId !== this.runId) {
      throw new RuntimeError("run manifest id does not match artifact store");
    }
    if (await this.readCandidateDecision(this.runId) !== null) {
      throw new RuntimeError("terminal artifacts cannot be promoted after a decision");
    }
    const result = sanitizeAttemptResult(args.result);
    verifyAttemptResult(result, this.runId);
    const manifest = sanitizeRunManifest(args.manifest);
    verifyRunManifest(manifest, this.runId);
    await this.replaceJson("result.json", result);
    await this.replaceJson("manifest.json", manifest);
  }

  async readResult(runId: string): Promise<AttemptResult | null> {
    validateComponent(runId, "run id");
    const runDirectory = path.join(this.runsRoot, runId);
    const validated = await this.ensureExistingRunDirectory(runDirectory);
    if (validated === null) return null;
    try {
      return verifyAttemptResult(
        JSON.parse(await readRegularFile(
          path.join(validated.path, "result.json"),
          validated.identity,
        )),
        runId,
      );
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
  }

  private async ensureExistingRunDirectory(directory: string): Promise<ValidatedDirectory | null> {
    const canonicalRunsRoot = await this.ensureRunsRoot();
    try {
      const metadata = await lstat(directory);
      if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
        throw new RuntimeError(`archive directory must not be a symbolic link: ${redact(directory)}`);
      }
      const canonicalDirectory = await realpath(directory);
      if (!isWithin(canonicalRunsRoot, canonicalDirectory)) {
        throw new RuntimeError("archive directory escapes plugin data");
      }
      const identity = { dev: metadata.dev, ino: metadata.ino };
      await assertDirectoryIdentity(directory, identity);
      return { path: canonicalDirectory, identity };
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
  }

  async readManifest(runId: string): Promise<RunManifest | null> {
    validateComponent(runId, "run id");
    const runDirectory = path.join(this.runsRoot, runId);
    const validated = await this.ensureExistingRunDirectory(runDirectory);
    if (validated === null) return null;
    try {
      return verifyRunManifest(
        JSON.parse(await readRegularFile(
          path.join(validated.path, "manifest.json"),
          validated.identity,
        )),
        runId,
      );
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
  }

  /**
   * The spec hash recorded when this run started, or null when the run or the
   * record is absent. Lets a caller prove a reported run id actually belongs to
   * the spec it dispatched, rather than trusting the reporter's echo of it.
   */
  async readRunStartSpecSha256(runId: string): Promise<string | null> {
    validateComponent(runId, "run id");
    const validated = await this.ensureExistingRunDirectory(path.join(this.runsRoot, runId));
    if (validated === null) return null;
    try {
      const record: unknown = JSON.parse(await readRegularFile(
        path.join(validated.path, "run-start.json"),
        validated.identity,
      ));
      if (typeof record !== "object" || record === null) return null;
      const value = (record as { specSha256?: unknown }).specSha256;
      return typeof value === "string" && /^[0-9a-f]{64}$/u.test(value) ? value : null;
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
  }

  async writeReviewSnapshot(snapshot: ReviewSnapshot): Promise<void> {
    const validated = validateReviewSnapshot(snapshot, this.runId);
    const attemptedHash = reviewSnapshotHash(validated);
    try {
      await this.writeJson("review-snapshot.json", validated);
      return;
    } catch (error) {
      const existing = await this.readReviewSnapshot(this.runId);
      if (existing === null) throw error;
      if (reviewSnapshotHash(existing) === attemptedHash) return;
      throw new RuntimeError(
        "review snapshot conflict: archived snapshot differs from attempted snapshot",
        { toolError: "review-snapshot-conflict" },
      );
    }
  }

  async readReviewSnapshot(runId: string): Promise<ReviewSnapshot | null> {
    validateComponent(runId, "run id");
    const runDirectory = path.join(this.runsRoot, runId);
    const validated = await this.ensureExistingRunDirectory(runDirectory);
    if (validated === null) return null;
    try {
      const snapshot = validateReviewSnapshot(
        JSON.parse(await readRegularFile(
          path.join(validated.path, "review-snapshot.json"),
          validated.identity,
        )),
        runId,
      );
      reviewSnapshotHash(snapshot);
      return snapshot;
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
  }

  async readAdvisorReport(runId: string): Promise<AdvisorReport | null> {
    const value = await this.readPipelineArtifact<unknown>(runId, "post-pipeline-autopilot");
    return value === null
      ? null
      : validatePostPipelineAutopilotArtifacts(value, runId).advisorReport;
  }

  private async recomputeArchivedEligibility(
    record: AutopilotEligibilityRecord,
  ): Promise<AutopilotEligibilityRecord | null> {
    const [pipelineResult, reviewSnapshot, advisorReport] = await Promise.all([
      this.readPipelineArtifact<PipelineResult>(this.runId, "pipeline-result"),
      this.readReviewSnapshot(this.runId),
      this.readAdvisorReport(this.runId),
    ]);
    if (pipelineResult === null || reviewSnapshot === null || advisorReport === null) return null;
    return evaluateAutopilotEligibility(eligibilityInputFromArtifacts({
      pipelineResult,
      reviewSnapshot,
      advisor: advisorReport,
      evaluatedAt: record.evaluatedAt,
    }));
  }

  async readAutopilotEligibility(runId: string): Promise<AutopilotEligibilityRecord | null> {
    validateComponent(runId, "run id");
    const value = await this.readPipelineArtifact<unknown>(runId, "post-pipeline-autopilot");
    if (value === null) return null;
    const record = validatePostPipelineAutopilotArtifacts(value, runId).eligibility;
    if (runId !== this.runId) {
      return new ArtifactStore(runId).readAutopilotEligibility(runId);
    }
    const expected = await this.recomputeArchivedEligibility(record);
    if (expected === null) return null;
    if (canonicalArtifactHash(expected) !== canonicalArtifactHash(record)) {
      throw new RuntimeError("archived autopilot eligibility does not match its evidence");
    }
    return record;
  }

  async writePostPipelineAutopilotArtifacts(args: {
    pipelineResult: PipelineResult;
    reviewSnapshot: ReviewSnapshot;
    advisorReport: AdvisorReport;
    eligibility: AutopilotEligibilityRecord;
  }): Promise<{ advisorReportHash: string; eligibilityRecordHash: string }> {
    const [archivedPipelineResult, archivedReviewSnapshot] = await Promise.all([
      this.readPipelineArtifact<PipelineResult>(this.runId, "pipeline-result"),
      this.readReviewSnapshot(this.runId),
    ]);
    if (archivedPipelineResult === null || archivedReviewSnapshot === null) {
      throw new RuntimeError("post-pipeline artifacts require a durable pipeline result and review snapshot");
    }
    if (pipelineResultHash(args.pipelineResult) !== pipelineResultHash(archivedPipelineResult)
      || reviewSnapshotHash(args.reviewSnapshot) !== reviewSnapshotHash(archivedReviewSnapshot)) {
      throw new RuntimeError("post-pipeline artifacts do not match the immutable archive");
    }
    const report = validateAdvisorReport(structuredClone(args.advisorReport));
    const sanitizedReport = validateAdvisorReport(redactRecord(report));
    if (advisorReportHash(sanitizedReport) !== advisorReportHash(report)) {
      throw new RuntimeError("advisor report cannot be safely persisted after redaction");
    }
    const record = validateAutopilotEligibilityRecord(structuredClone(args.eligibility), this.runId);
    const expected = evaluateAutopilotEligibility(eligibilityInputFromArtifacts({
      pipelineResult: archivedPipelineResult,
      reviewSnapshot: archivedReviewSnapshot,
      advisor: sanitizedReport,
      evaluatedAt: record.evaluatedAt,
    }));
    if (canonicalArtifactHash(expected) !== canonicalArtifactHash(record)) {
      throw new RuntimeError("post-pipeline eligibility was not derived from the supplied frozen evidence");
    }

    const persistedAdvisorHash = advisorReportHash(sanitizedReport);
    const eligibilityRecordHash = canonicalArtifactHash(record);
    const artifacts: PostPipelineAutopilotArtifacts = {
      artifactVersion: "1",
      advisorReport: sanitizedReport,
      eligibility: record,
      advisorReportHash: persistedAdvisorHash,
      eligibilityRecordHash,
    };
    await this.writeJson(
      path.posix.join("pipeline", "post-pipeline-autopilot.json"),
      artifacts,
    );
    return { advisorReportHash: persistedAdvisorHash, eligibilityRecordHash };
  }

  async writeHumanDecision(record: HumanCandidateDecisionV2Input): Promise<void> {
    const decision = verifyCandidateDecisionV2({
      ...record,
      decisionVersion: "2",
      authority: "human",
    });
    await this.writeCandidateDecision(decision, decision);
  }

  /**
   * Persist a decision whose authority the caller already resolved.
   *
   * The MCP lifecycle derives the authority from how it obtained the decision —
   * a human prompt, the autonomous policy, or an unconfirmed caller assertion —
   * so it cannot go through `writeHumanDecision`, which hard-codes `human`.
   * Validation is unchanged: the schema still rejects any authority outside the
   * union, and the accept-only policy constraint still applies.
   */
  async writeCandidateDecisionRecord(record: CandidateDecisionV2): Promise<void> {
    const decision = verifyCandidateDecisionV2(record);
    await this.writeCandidateDecision(decision, decision);
  }

  async writeAutopilotDecision(
    candidate: CandidateArtifact,
    eligibility: AutopilotEligibilityRecord,
    recordedAt: string,
  ): Promise<void> {
    let validated: AutopilotEligibilityRecord;
    try {
      validated = validateAutopilotEligibilityRecord(eligibility, this.runId);
    } catch {
      throw new RuntimeError("autopilot decision eligibility is invalid");
    }
    const archived = await this.readAutopilotEligibility(this.runId);
    if (archived === null
      || canonicalArtifactHash(archived) !== canonicalArtifactHash(validated)
      || candidate.baseCommitOid !== validated.baseCommitOid
      || candidate.candidateCommitOid !== validated.candidateCommitOid
      || candidate.candidateTreeOid !== validated.candidateTreeOid
      || candidate.manifestHash !== validated.candidateManifestHash
      || candidate.manifestHash !== manifestHashOf(candidate.changedPaths)) {
      throw new RuntimeError("autopilot decision eligibility is invalid");
    }
    const decisionEligibility = autopilotDecisionEligibilityProjection(validated);
    const decision = verifyCandidateDecisionV2({
      decisionVersion: "2",
      decision: "accepted",
      authority: "autopilot-policy",
      candidateManifestHash: candidate.manifestHash,
      evidenceHash: decisionEligibility.evidenceHash,
      policyVersion: decisionEligibility.policyVersion,
      recordedAt,
    }) as AutopilotCandidateDecisionV2;
    await this.writeCandidateDecision(decision, decision);
  }

  private async writeCandidateDecision(
    persisted: CandidateDecisionV2,
    normalized: CandidateDecision,
  ): Promise<void> {
    try {
      await this.writeJson("decision.json", persisted);
      return;
    } catch (error) {
      const existing = await this.readCandidateDecision(this.runId);
      if (existing === null) throw error;
      if (hasIdenticalDecisionProvenance(existing, normalized)) return;
      throw new RuntimeError(
        `candidate decision conflict: recorded ${existing.decision}, attempted ${normalized.decision}`,
        { toolError: "decision-conflict" },
      );
    }
  }

  async readCandidateDecision(runId: string): Promise<CandidateDecision | null> {
    validateComponent(runId, "run id");
    const runDirectory = path.join(this.runsRoot, runId);
    const validated = await this.ensureExistingRunDirectory(runDirectory);
    if (validated === null) return null;
    try {
      const value: unknown = JSON.parse(await readRegularFile(
        path.join(validated.path, "decision.json"),
        validated.identity,
      ));
      return parsePersistedDecision(value);
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
  }


  async readDecision(runId: string): Promise<CandidateDecision | null> {
    return this.readCandidateDecision(runId);
  }

  async writePipelineActiveMarker(marker: PipelineActiveMarker): Promise<void> {
    if (typeof marker !== "object"
      || marker === null
      || !Number.isSafeInteger(marker.pid)
      || marker.pid <= 1
      || (marker.processToken !== null && typeof marker.processToken !== "string")
      || typeof marker.startedAt !== "string"
      || !Number.isFinite(Date.parse(marker.startedAt))
      || typeof marker.sliced !== "boolean") {
      throw new RuntimeError("pipeline-active marker is invalid");
    }
    await this.replaceJson("pipeline-active.json", marker);
  }

  async readPipelineActiveMarker(runId: string): Promise<PipelineActiveMarker | null> {
    validateComponent(runId, "run id");
    const runDirectory = path.join(this.runsRoot, runId);
    const validated = await this.ensureExistingRunDirectory(runDirectory);
    if (validated === null) return null;
    try {
      const value = JSON.parse(await readRegularFile(
        path.join(validated.path, "pipeline-active.json"),
        validated.identity,
      )) as Partial<PipelineActiveMarker>;
      if (typeof value !== "object"
        || value === null
        || typeof value.pid !== "number"
        || !Number.isSafeInteger(value.pid)
        || value.pid <= 1
        || (value.processToken !== null && typeof value.processToken !== "string")
        || typeof value.startedAt !== "string"
        || !Number.isFinite(Date.parse(value.startedAt))
        || typeof value.sliced !== "boolean") {
        throw new RuntimeError("archived pipeline-active marker is malformed");
      }
      return value as PipelineActiveMarker;
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
  }

  async clearPipelineActiveMarker(): Promise<void> {
    const directory = await this.ensureRunDirectory(false);
    if (directory === null) return;
    await rm(path.join(directory, "pipeline-active.json"), { force: true });
  }

  async list(): Promise<string[]> {
    await this.ensureRunsRoot();
    const entries = await readdir(this.runsRoot, { withFileTypes: true });
    return entries
      .filter(entry => entry.isDirectory() && isSafeComponent(entry.name))
      .map(entry => entry.name)
      .sort();
  }

  private async entries(): Promise<RunEntry[]> {
    const entries = await Promise.all((await this.list()).map(async runId => {
      const directory = path.join(this.runsRoot, runId);
      try {
        const metadata = await lstat(directory);
        if (metadata.isSymbolicLink() || !metadata.isDirectory()) return null;
        return {
          runId,
          directory,
          modifiedAtMs: metadata.mtimeMs,
          bytes: await directoryBytes(directory, { dev: metadata.dev, ino: metadata.ino }),
          identity: { dev: metadata.dev, ino: metadata.ino },
        };
      } catch (error) {
        if (isMissing(error)) return null;
        throw error;
      }
    }));
    return entries.filter((entry): entry is RunEntry => entry !== null).sort(compareEntries);
  }

  private async prepareCandidateAnchorCleanup(
    runId: string,
    result: AttemptResult,
    manifest: RunManifest,
    canonicalRepoRoot: string,
  ): Promise<PreparedAnchorCleanup> {
    if (result.candidate === null) {
      return {
        outcome: "not-applicable",
        repoRoot: canonicalRepoRoot,
        anchorRef: null,
        backupRef: null,
        candidateCommitOid: null,
      };
    }

    const candidate = sanitizeCandidate(result.candidate);
    const expectedRef = `${CANDIDATE_REF_PREFIX}${runId}`;
    if (candidate.anchorRef !== expectedRef) {
      throw new RuntimeError("archived candidate anchor does not match run id");
    }
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(candidate.candidateCommitOid)) {
      throw new RuntimeError("archived candidate commit oid is invalid");
    }
    if (manifest.baseCommitOid !== candidate.baseCommitOid
      || manifest.candidateManifestHash !== candidate.manifestHash) {
      throw new RuntimeError("archived candidate does not match its run manifest");
    }
    const repositoryTopLevel = await git(canonicalRepoRoot, ["rev-parse", "--show-toplevel"]);
    if (repositoryTopLevel.exitCode !== 0
      || await realpath(gitPathOutput(
        repositoryTopLevel.stdout,
        "candidate repository root",
      )) !== canonicalRepoRoot) {
      throw new RuntimeError("archived repository root is not a canonical repository root");
    }
    const commit = await git(canonicalRepoRoot, [
      "cat-file",
      "-e",
      `${candidate.candidateCommitOid}^{commit}`,
    ]);
    if (commit.exitCode !== 0) {
      throw new RuntimeError("archived candidate commit does not belong to repository");
    }

    const direct = await git(canonicalRepoRoot, ["rev-parse", "--verify", "--quiet", expectedRef]);
    if (direct.exitCode === 1) {
      const symbolic = await git(canonicalRepoRoot, ["symbolic-ref", "--quiet", expectedRef]);
      if (symbolic.exitCode === 0) {
        throw new RuntimeError("archived candidate anchor is a dangling symbolic ref");
      }
      return {
        outcome: "already-absent",
        repoRoot: canonicalRepoRoot,
        anchorRef: expectedRef,
        backupRef: null,
        candidateCommitOid: candidate.candidateCommitOid,
      };
    }
    if (direct.exitCode !== 0 || direct.stdout.trim() !== candidate.candidateCommitOid) {
      throw new RuntimeError("archived candidate anchor moved");
    }
    return {
      outcome: "deleted",
      repoRoot: canonicalRepoRoot,
      anchorRef: expectedRef,
      backupRef: `${PRUNE_BACKUP_REF_PREFIX}${runId}`,
      candidateCommitOid: candidate.candidateCommitOid,
    };
  }

  private async beginCandidateAnchorCleanup(
    prepared: PreparedAnchorCleanup,
    runId: string,
  ): Promise<AnchorCleanupTransaction> {
    if (prepared.outcome !== "deleted"
      || prepared.repoRoot === null
      || prepared.anchorRef === null
      || prepared.backupRef === null
      || prepared.candidateCommitOid === null) {
      return {
        outcome: prepared.outcome,
        async commit() {},
        async rollback() {},
      };
    }
    const { repoRoot, anchorRef, backupRef, candidateCommitOid } = prepared;
    const zeroOid = "0".repeat(candidateCommitOid.length);
    const backup = await git(repoRoot, [
      "update-ref",
      "--no-deref",
      "-m",
      `claude-architect prune backup ${runId}`,
      backupRef,
      candidateCommitOid,
      zeroOid,
    ]);
    if (backup.exitCode !== 0) {
      throw new RuntimeError("failed to create candidate prune backup");
    }
    const deletion = await git(repoRoot, [
      "update-ref",
      "--no-deref",
      "-m",
      `claude-architect prune ${runId}`,
      "-d",
      anchorRef,
      candidateCommitOid,
    ]);
    if (deletion.exitCode !== 0) {
      await git(repoRoot, ["update-ref", "--no-deref", "-d", backupRef, candidateCommitOid]);
      throw new RuntimeError("failed to remove candidate anchor");
    }

    return {
      outcome: "deleted",
      async commit(): Promise<void> {
        const deleted = await git(repoRoot, [
          "update-ref",
          "--no-deref",
          "-d",
          backupRef,
          candidateCommitOid,
        ]);
        if (deleted.exitCode !== 0) {
          throw new RuntimeError("failed to remove candidate prune backup");
        }
      },
      async rollback(): Promise<void> {
        const restored = await git(repoRoot, [
          "update-ref",
          "--no-deref",
          "-m",
          `claude-architect prune rollback ${runId}`,
          anchorRef,
          candidateCommitOid,
          zeroOid,
        ]);
        if (restored.exitCode !== 0) {
          throw new RuntimeError("failed to restore candidate anchor from prune backup");
        }
        const deleted = await git(repoRoot, [
          "update-ref",
          "--no-deref",
          "-d",
          backupRef,
          candidateCommitOid,
        ]);
        if (deleted.exitCode !== 0) {
          throw new RuntimeError("failed to remove restored candidate prune backup");
        }
      },
    };
  }

  private async appendCleanupRecord(record: CleanupRecord): Promise<void> {
    await enqueueCleanupJournalWrite(async () => {
      // Cross-process mutex over the shared journal: serializes this append against
      // a concurrent process's append or recovery torn-tail truncation. Leaf lock —
      // acquired and released here without holding any other lock across it.
      const journalLock = await getPlatformServices().acquireCleanupJournalLock();
      try {
        await this.ensureRunsRoot();
        const runsRootIdentity = await ensurePlainDirectory(this.runsRoot);
        const filename = path.join(this.runsRoot, CLEANUP_JOURNAL);
        const handle = await open(
          filename,
          constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | NO_FOLLOW,
          0o600,
        );
        try {
          await assertDirectoryIdentity(this.runsRoot, runsRootIdentity);
          const metadata = await handle.stat();
          if (!metadata.isFile()) throw new RuntimeError("cleanup journal is not a regular file");
          const line = `${serializeJson(record)}\n`;
          await handle.writeFile(line, { encoding: "utf8" });
          await handle.sync();
          await assertDirectoryIdentity(this.runsRoot, runsRootIdentity);
        } finally {
          await handle.close();
        }
        await assertDirectoryIdentity(this.runsRoot, runsRootIdentity);
        await syncDirectory(this.runsRoot);
        await assertDirectoryIdentity(this.runsRoot, runsRootIdentity);
      } finally {
        await journalLock.release();
      }
    });
  }

  // Reclaim a run whose delegating repository has been deleted. The intent is written
  // before the archive is moved so a crash mid-removal is recoverable: recovery's
  // repo-absent path finds the pending intent, sees the repository gone, and finishes the
  // quarantine removal. No anchor fields are recorded — the repository's refs are gone, so
  // recovery reconciles by disk state alone.
  private async reclaimRepoAbsentArchive(
    entry: RunEntry,
    reason: PruneReason,
    quarantineName: string,
    quarantinePath: string,
    repoRoot: string,
  ): Promise<void> {
    await this.appendCleanupRecord({
      event: "prune-cleanup-intent",
      runId: entry.runId,
      reason,
      anchorCleanup: "pending",
      archiveBytes: entry.bytes,
      quarantineName,
      repoRoot,
      anchorRef: null,
      backupRef: null,
      candidateCommitOid: null,
      recordedAt: new Date().toISOString(),
    });
    const runsRootIdentity = await ensurePlainDirectory(this.runsRoot);
    await assertDirectoryIdentity(entry.directory, entry.identity);
    await assertDirectoryIdentity(this.runsRoot, runsRootIdentity);
    await rename(entry.directory, quarantinePath);
    await syncDirectory(this.runsRoot);
    await assertDirectoryIdentity(this.runsRoot, runsRootIdentity);
    await assertDirectoryIdentity(quarantinePath, entry.identity);
    await rm(quarantinePath, { recursive: true, force: false });
    await syncDirectory(this.runsRoot);
    await this.appendCleanupRecord({
      event: "prune-cleanup-complete",
      runId: entry.runId,
      reason,
      anchorCleanup: "already-absent",
      archiveBytes: entry.bytes,
      quarantineName,
      repoRoot,
      anchorRef: null,
      backupRef: null,
      candidateCommitOid: null,
      recordedAt: new Date().toISOString(),
    });
  }

  async prune(
    policy: PrunePolicy,
    dependencies: PruneDependencies = {},
  ): Promise<PruneResult> {
    validatePruneLimit(policy.maxAgeMs, "maxAgeMs");
    validatePruneLimit(policy.maxBytes, "maxBytes");

    const entries = await this.entries();
    const removed = new Set<string>();
    const attempted = new Set<string>();
    const retained: PruneResult["retained"] = [];
    let retainedBytes = entries.reduce((total, entry) => total + entry.bytes, 0);

    const removeEntry = async (entry: RunEntry, reason: PruneReason): Promise<void> => {
      if (attempted.has(entry.runId)) return;
      attempted.add(entry.runId);
      const quarantineName = `.prune-${entry.runId}-${randomUUID()}`;
      const quarantinePath = path.join(this.runsRoot, quarantineName);
      let prepared: PreparedAnchorCleanup | null = null;
      let transaction: AnchorCleanupTransaction | null = null;
      let runsRootIdentity: DirectoryIdentity | null = null;
      let archiveRemovalCommitted = false;
      let lease: CheckoutLock | null = null;
      try {
        // Fast path: never wait on a checkout lease for a run that still
        // advertises a live pipeline. Refuse before canonicalizing or locking.
        if (await this.readPipelineActiveMarker(entry.runId) !== null) {
          retained.push({ runId: entry.runId, reason: "active-run" });
          return;
        }
        const initialManifest = await this.readManifest(entry.runId);
        if (initialManifest === null) {
          retained.push({ runId: entry.runId, reason: "incomplete-run" });
          return;
        }
        const initialResult = await this.readResult(entry.runId);
        if (initialResult === null) {
          retained.push({ runId: entry.runId, reason: "incomplete-run" });
          return;
        }
        // Serialize archive removal against the checkout lifecycle: hold the
        // repository's checkout lease so recovery/integration cannot race a
        // prune that is deleting the same candidate anchors.
        const platformServices = dependencies.platformServices ?? getPlatformServices();
        let canonical;
        try {
          canonical = await platformServices.canonicalizePath(initialManifest.repoRoot);
        } catch (error) {
          if (errorCode(error) !== "ENOENT") throw error;
          await this.reclaimRepoAbsentArchive(
            entry, reason, quarantineName, quarantinePath, initialManifest.repoRoot,
          );
          removed.add(entry.runId);
          retainedBytes -= entry.bytes;
          return;
        }
        const safety = new PlatformSafety(platformServices);
        await safety.withCheckoutLease(canonical.canonical, async (acquiredLease) => {
          lease = acquiredLease;
          await assertDirectoryIdentity(entry.directory, entry.identity);
          // Re-establish authority under the lease: the manifest, terminal
          // result, and active marker may all have changed while we waited.
          const currentManifest = await this.readManifest(entry.runId);
          if (currentManifest === null
            || serializeJson(currentManifest) !== serializeJson(initialManifest)) {
            retained.push({ runId: entry.runId, reason: "run identity changed while waiting" });
            return;
          }
          if (await this.readPipelineActiveMarker(entry.runId) !== null) {
            retained.push({ runId: entry.runId, reason: "active-run" });
            return;
          }
          const result = await this.readResult(entry.runId);
          if (result === null) {
            retained.push({ runId: entry.runId, reason: "incomplete-run" });
            return;
          }
          if (serializeJson(result) !== serializeJson(initialResult)) {
            retained.push({ runId: entry.runId, reason: "terminal authority changed while waiting" });
            return;
          }
          prepared = await this.prepareCandidateAnchorCleanup(
            entry.runId,
            result,
            currentManifest,
            canonical.canonical,
          );
          await this.appendCleanupRecord({
            event: "prune-cleanup-intent",
            runId: entry.runId,
            reason,
            anchorCleanup: "pending",
            archiveBytes: entry.bytes,
            quarantineName,
            repoRoot: prepared.repoRoot,
            anchorRef: prepared.anchorRef,
            backupRef: prepared.backupRef,
            candidateCommitOid: prepared.candidateCommitOid,
            recordedAt: new Date().toISOString(),
          });
          transaction = await this.beginCandidateAnchorCleanup(prepared, entry.runId);
          runsRootIdentity = await ensurePlainDirectory(this.runsRoot);
          await assertDirectoryIdentity(entry.directory, entry.identity);
          await assertDirectoryIdentity(this.runsRoot, runsRootIdentity);
          await rename(entry.directory, quarantinePath);
          await syncDirectory(this.runsRoot);
          await assertDirectoryIdentity(this.runsRoot, runsRootIdentity);
          await assertDirectoryIdentity(quarantinePath, entry.identity);
          archiveRemovalCommitted = true;
          await rm(quarantinePath, { recursive: true, force: false });
          await syncDirectory(this.runsRoot);
          await transaction.commit();
          await this.appendCleanupRecord({
            event: "prune-cleanup-complete",
            runId: entry.runId,
            reason,
            anchorCleanup: transaction.outcome,
            archiveBytes: entry.bytes,
            quarantineName,
            repoRoot: prepared.repoRoot,
            anchorRef: prepared.anchorRef,
            backupRef: prepared.backupRef,
            candidateCommitOid: prepared.candidateCommitOid,
            recordedAt: new Date().toISOString(),
          });
          removed.add(entry.runId);
          retainedBytes -= entry.bytes;
        }, {
          runId: entry.runId,
          onReleaseError: (releaseError) => {
            const reason = redact(releaseError instanceof Error ? releaseError.message : String(releaseError));
            retained.push({
              runId: entry.runId,
              reason: archiveRemovalCommitted
                ? `archive removed; checkout lease release failed: ${reason}`
                : reason,
            });
          },
        });
      } catch (error) {
        let rollbackError: unknown;
        if (!archiveRemovalCommitted) {
          try {
            const quarantineExists = await pathExists(quarantinePath);
            const runDirectoryExists = await pathExists(entry.directory);
            if (quarantineExists) {
              if (runDirectoryExists) {
                throw new RuntimeError("archive run directory was replaced during rollback");
              }
              const expectedRunsRoot = runsRootIdentity ?? await ensurePlainDirectory(this.runsRoot);
              await assertDirectoryIdentity(this.runsRoot, expectedRunsRoot);
              await assertDirectoryIdentity(quarantinePath, entry.identity);
              await rename(quarantinePath, entry.directory);
              await syncDirectory(this.runsRoot);
              await assertDirectoryIdentity(this.runsRoot, expectedRunsRoot);
              await assertDirectoryIdentity(entry.directory, entry.identity);
            } else if (runDirectoryExists) {
              await assertDirectoryIdentity(entry.directory, entry.identity);
            } else {
              throw new RuntimeError("archive run directory disappeared during rollback");
            }
            await (transaction as any)?.rollback();
            if (prepared !== null) {
              await this.appendCleanupRecord({
                event: "prune-cleanup-rollback",
                runId: entry.runId,
                reason,
                anchorCleanup: (prepared as any).outcome,
                archiveBytes: entry.bytes,
                quarantineName,
                repoRoot: (prepared as any).repoRoot,
                anchorRef: (prepared as any).anchorRef,
                backupRef: (prepared as any).backupRef,
                candidateCommitOid: (prepared as any).candidateCommitOid,
                recordedAt: new Date().toISOString(),
              });
            }
          } catch (rollbackFailure) {
            rollbackError = rollbackFailure;
          }
        } else {
          removed.add(entry.runId);
          retainedBytes -= entry.bytes;
        }

        const primary = error instanceof Error ? error.message : String(error);
        const rollback = rollbackError instanceof Error
          ? `; rollback failed: ${rollbackError.message}`
          : rollbackError === undefined ? "" : `; rollback failed: ${String(rollbackError)}`;
        if (!archiveRemovalCommitted) {
          retained.push({
            runId: entry.runId,
            reason: redact(`${primary}${rollback}`),
          });
        }
      }
    };

    const now = Date.now();
    for (const entry of entries) {
      if (now - entry.modifiedAtMs > policy.maxAgeMs) await removeEntry(entry, "max-age");
    }
    for (const entry of entries) {
      if (retainedBytes <= policy.maxBytes) break;
      await removeEntry(entry, "max-bytes");
    }

    return { removed: [...removed], retained };
  }
}

/**
 * Default retention for the startup run-archive sweep. Terminal runs older than
 * ~14 days, or the oldest terminal runs once the archive exceeds ~1 GiB, are
 * reclaimed. `prune()` always retains active, incomplete, and undecided runs
 * regardless of these limits. These are deliberate constants, not configuration:
 * they are the minimal fix for unbounded run-log growth, and the runtime has no
 * env-override convention to follow.
 */
export const DEFAULT_PRUNE_POLICY: PrunePolicy = {
  maxAgeMs: 14 * 24 * 60 * 60 * 1000,
  maxBytes: 1024 * 1024 * 1024,
};

/**
 * Prune the shared run archive across every run. `ArtifactStore.prune` reads the
 * runs root and ignores its instance run id, so this thin wrapper expresses the
 * cross-run intent without fabricating a per-run store at the call site. The
 * `prune-sweep` id is inert: it names no real run and prune never reads or writes
 * its run directory.
 */
export async function pruneRuns(
  policy: PrunePolicy = DEFAULT_PRUNE_POLICY,
  dependencies: PruneDependencies = {},
): Promise<PruneResult> {
  return new ArtifactStore("prune-sweep").prune(policy, dependencies);
}
