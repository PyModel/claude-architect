import { createHash } from "node:crypto";
import { sanitizeReviewPatch } from "../git/candidate-tree.js";
import { gitSucceeded, reviewDiffArgs } from "../git/checked-git.js";
import { git as runGit, type GitResult } from "../git/git-exec.js";
import { manifestHashOf } from "../git/changed-path-manifest.js";
import type { PlatformServices } from "../platform/platform-services.js";
import type {
  AttemptResult,
  CandidateArtifact,
  ChangedPath,
  CommandOutcome,
} from "../protocol/attempt-result.js";
import { RuntimeError } from "../util/errors.js";
import { redact, redactRecord } from "./redaction.js";
import type { RunManifest } from "./run-manifest.js";

const SHA256 = /^[0-9a-f]{64}$/u;
const GIT_OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const REDACTION_MARKER = /\[(?:a|b|e|g|j|k|l|s)\]/u;
const IGNORED_PATHS_LIMIT = 50;

export interface ReviewSnapshot {
  runId: string;
  baseCommitOid: string;
  candidateCommitOid: string;
  candidateTreeOid: string;
  manifestHash: string;
  patch: string;
  changedPaths: ChangedPath[];
  evidence: AttemptResult["evidence"];
  executedVerification: CommandOutcome[];
}

export interface ReviewSnapshotStore {
  readResult(): Promise<AttemptResult | null>;
  readManifest(): Promise<RunManifest | null>;
}

export interface ReviewSnapshotRun {
  runId: string;
  repoRoot: string;
  repositoryIdentity: string;
  store: ReviewSnapshotStore;
  platformServices: Pick<PlatformServices, "canonicalizePath">;
  git?: (cwd: string, args: string[]) => Promise<GitResult>;
  allowMissingAnchor?: boolean;
}

function reviewError(message: string, toolError: string): RuntimeError {
  return new RuntimeError(message, { toolError });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return actual.length === sortedExpected.length
    && actual.every((key, index) => key === sortedExpected[index]);
}

function assertIdentity(value: string, label: string): void {
  if (REDACTION_MARKER.test(value) || redact(value) !== value) {
    throw reviewError(
      `${label} cannot be reviewed without redacting its identity`,
      "candidate-review-failed",
    );
  }
}

function canonicalJsonValue(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new RuntimeError("review snapshot contains a non-JSON number");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(item => canonicalJsonValue(item)).join(",")}]`;
  }
  if (!isRecord(value)) throw new RuntimeError("review snapshot contains a non-JSON value");
  return `{${Object.keys(value).sort().map(key =>
    `${JSON.stringify(key)}:${canonicalJsonValue(value[key])}`).join(",")}}`;
}

function validateChangedPath(value: unknown): value is ChangedPath {
  return isRecord(value)
    && hasExactKeys(value, ["path", "changeType", "mode", "contentHash"])
    && typeof value.path === "string"
    && (["added", "modified", "deleted"] as const)
      .includes(value.changeType as ChangedPath["changeType"])
    && typeof value.mode === "string"
    && (value.contentHash === null || typeof value.contentHash === "string");
}

function validateCommandOutcome(value: unknown): value is CommandOutcome {
  return isRecord(value)
    && hasExactKeys(value, [
      "id",
      "executable",
      "args",
      "exitCode",
      "timedOut",
      "durationMs",
      "stdoutRef",
      "stderrRef",
    ])
    && typeof value.id === "string"
    && typeof value.executable === "string"
    && Array.isArray(value.args)
    && value.args.every(arg => typeof arg === "string")
    && (value.exitCode === null
      || (typeof value.exitCode === "number" && Number.isInteger(value.exitCode)))
    && typeof value.timedOut === "boolean"
    && typeof value.durationMs === "number"
    && Number.isFinite(value.durationMs)
    && value.durationMs >= 0
    && typeof value.stdoutRef === "string"
    && typeof value.stderrRef === "string";
}

export function validateReviewSnapshot(value: unknown, expectedRunId?: string): ReviewSnapshot {
  if (!isRecord(value)
    || !hasExactKeys(value, [
      "runId",
      "baseCommitOid",
      "candidateCommitOid",
      "candidateTreeOid",
      "manifestHash",
      "patch",
      "changedPaths",
      "evidence",
      "executedVerification",
    ])
    || typeof value.runId !== "string"
    || (expectedRunId !== undefined && value.runId !== expectedRunId)
    || typeof value.baseCommitOid !== "string"
    || !GIT_OID.test(value.baseCommitOid)
    || typeof value.candidateCommitOid !== "string"
    || !GIT_OID.test(value.candidateCommitOid)
    || typeof value.candidateTreeOid !== "string"
    || !GIT_OID.test(value.candidateTreeOid)
    || typeof value.manifestHash !== "string"
    || !SHA256.test(value.manifestHash)
    || typeof value.patch !== "string"
    || !Array.isArray(value.changedPaths)
    || !value.changedPaths.every(validateChangedPath)
    || !isRecord(value.evidence)
    || !Array.isArray(value.executedVerification)
    || !value.executedVerification.every(validateCommandOutcome)) {
    throw new RuntimeError("archived review snapshot is malformed");
  }
  const snapshot = value as unknown as ReviewSnapshot;
  if (manifestHashOf(snapshot.changedPaths) !== snapshot.manifestHash) {
    throw new RuntimeError("archived review snapshot manifest hash is inconsistent");
  }
  canonicalJsonValue(snapshot);
  return snapshot;
}

function assertRedactionInvariants(snapshot: ReviewSnapshot): void {
  assertIdentity(snapshot.runId, "review run id");
  assertIdentity(snapshot.baseCommitOid, "review base commit oid");
  assertIdentity(snapshot.candidateCommitOid, "review candidate commit oid");
  assertIdentity(snapshot.candidateTreeOid, "review candidate tree oid");
  assertIdentity(snapshot.manifestHash, "review manifest hash");
  for (const changedPath of snapshot.changedPaths) {
    assertIdentity(changedPath.path, "review changed path");
    assertIdentity(changedPath.mode, "review changed path mode");
    if (changedPath.contentHash !== null) {
      assertIdentity(changedPath.contentHash, "review changed path content hash");
    }
  }
  for (const outcome of snapshot.executedVerification) {
    assertIdentity(outcome.id, "review verification id");
    assertIdentity(outcome.executable, "review verification executable");
    for (const arg of outcome.args) assertIdentity(arg, "review verification argument");
    assertIdentity(outcome.stdoutRef, "review stdout ref");
    assertIdentity(outcome.stderrRef, "review stderr ref");
  }
  if (canonicalJsonValue(redactRecord(snapshot.evidence)) !== canonicalJsonValue(snapshot.evidence)) {
    throw reviewError("review evidence violates redaction invariants", "candidate-review-failed");
  }
}

function boundEvidence(evidence: AttemptResult["evidence"]): AttemptResult["evidence"] {
  const clone = structuredClone(evidence);
  const ignoredPaths = clone.ignoredPaths;
  if (!Array.isArray(ignoredPaths) || ignoredPaths.length <= IGNORED_PATHS_LIMIT) return clone;
  return {
    ...clone,
    ignoredPaths: ignoredPaths.slice(0, IGNORED_PATHS_LIMIT),
    ignoredPathsOmitted: ignoredPaths.length - IGNORED_PATHS_LIMIT,
  };
}

function requireCoherentCandidate(
  runId: string,
  result: AttemptResult,
  manifest: RunManifest,
): CandidateArtifact {
  if (result.runId !== runId || manifest.runId !== runId) {
    throw reviewError("archived run identity does not match", "archive-inconsistent");
  }
  if ((result.status === "verified-candidate") !== (result.failure === null)) {
    throw reviewError("archived candidate status is inconsistent", "archive-inconsistent");
  }
  const candidate = result.candidate;
  if (candidate === null) {
    throw reviewError("archived run has no candidate", "candidate-not-found");
  }
  if (candidate.anchorRef !== `refs/claude-architect/candidates/${runId}`
    || manifest.baseCommitOid !== candidate.baseCommitOid
    || manifest.candidateManifestHash !== candidate.manifestHash
    || manifestHashOf(candidate.changedPaths) !== candidate.manifestHash) {
    throw reviewError("archived candidate does not match its run manifest", "candidate-review-failed");
  }
  return candidate;
}

export async function createReviewSnapshot(run: ReviewSnapshotRun): Promise<ReviewSnapshot> {
  // Deliberately not the run-decision snapshot: this function *produces* the
  // review snapshot that snapshot reads, and it needs neither the gate record
  // nor the decision. Reading them here would cost three extra files and invert
  // the dependency between an artifact and the policy that judges it.
  const [result, manifest] = await Promise.all([
    run.store.readResult(),
    run.store.readManifest(),
  ]);
  if (result === null || manifest === null) {
    throw reviewError("archived run was not found", "run-not-found");
  }
  const canonical = await run.platformServices.canonicalizePath(manifest.repoRoot);
  const repositoryIdentity = canonical.gitCommonDir ?? canonical.canonical;
  if (canonical.canonical !== manifest.repoRoot
    || run.repoRoot !== manifest.repoRoot
    || repositoryIdentity !== run.repositoryIdentity) {
    throw reviewError("archived repository root changed identity", "archive-inconsistent");
  }

  const candidate = requireCoherentCandidate(run.runId, result, manifest);
  const git = run.git ?? runGit;
  const [anchor, tree] = await Promise.all([
    git(run.repoRoot, [
      "rev-parse",
      "--verify",
      "--quiet",
      `${candidate.anchorRef}^{commit}`,
    ]),
    git(run.repoRoot, [
      "rev-parse",
      "--verify",
      `${candidate.candidateCommitOid}^{tree}`,
    ]),
  ]);
  const anchorMissing = run.allowMissingAnchor === true
    && anchor.exitCode === 1
    && anchor.stdout.trim().length === 0
    && anchor.stderr.trim().length === 0
    && anchor.truncated?.stdout !== true
    && anchor.truncated?.stderr !== true;
  if ((!anchorMissing && (anchor.exitCode !== 0
    || anchor.stdout.trim() !== candidate.candidateCommitOid
    || anchor.truncated?.stdout === true
    || anchor.truncated?.stderr === true))
    || tree.exitCode !== 0
    || tree.stdout.trim() !== candidate.candidateTreeOid
    || tree.truncated?.stdout === true
    || tree.truncated?.stderr === true) {
    throw reviewError("candidate anchor no longer matches the archive", "candidate-anchor-mismatch");
  }

  const patchResult = await git(run.repoRoot, reviewDiffArgs(
    candidate.baseCommitOid,
    candidate.candidateTreeOid,
    ["--binary", "--full-index"],
  ));
  if (!gitSucceeded(patchResult)) {
    throw reviewError("failed to regenerate candidate patch", "candidate-review-failed");
  }
  const patch = sanitizeReviewPatch(patchResult.stdout);

  const snapshot: ReviewSnapshot = {
    runId: run.runId,
    baseCommitOid: candidate.baseCommitOid,
    candidateCommitOid: candidate.candidateCommitOid,
    candidateTreeOid: candidate.candidateTreeOid,
    manifestHash: candidate.manifestHash,
    patch,
    changedPaths: candidate.changedPaths.map(change => ({ ...change })),
    evidence: boundEvidence(result.evidence),
    executedVerification: result.executedVerification.map(outcome => ({
      ...outcome,
      args: [...outcome.args],
    })),
  };
  validateReviewSnapshot(snapshot, run.runId);
  assertRedactionInvariants(snapshot);
  return snapshot;
}

export function reviewSnapshotHash(snapshot: ReviewSnapshot): string {
  const validated = validateReviewSnapshot(snapshot, snapshot.runId);
  assertRedactionInvariants(validated);
  const hash = createHash("sha256").update(canonicalJsonValue(validated)).digest("hex");
  if (!SHA256.test(hash)) throw new RuntimeError("review snapshot hash is invalid");
  return hash;
}
