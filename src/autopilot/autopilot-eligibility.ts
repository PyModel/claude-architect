import { createHash } from "node:crypto";
import { manifestHashOf } from "../git/changed-path-manifest.js";
import type { AutopilotDecisionEligibilityV1 } from "../protocol/candidate-decision.js";
import type { PipelineResult } from "../pipeline/pipeline-runtime.js";
import type { AdvisorReport } from "../pipeline/report-types.js";
import {
  reviewSnapshotHash as hashReviewSnapshot,
  type ReviewSnapshot,
} from "../runtime/review-snapshot.js";

export interface AutopilotEligibilityRecord {
  recordVersion: "1";
  policyVersion: "1";
  runId: string;
  eligible: boolean;
  reasons: string[];
  baseCommitOid: string;
  candidateCommitOid: string;
  candidateTreeOid: string;
  candidateManifestHash: string;
  reviewSnapshotHash: string;
  pipelineResultHash: string;
  advisorReportHash: string;
  evaluatedAt: string;
}

/** The complete frozen evidence one eligibility record is derived from. */
export interface AutopilotEligibilityEvidence {
  pipelineResult: PipelineResult;
  reviewSnapshot: ReviewSnapshot;
  advisor: AdvisorReport;
  evaluatedAt: string;
}

function canonicalJsonValue(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("artifact contains a non-JSON number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(item => canonicalJsonValue(item)).join(",")}]`;
  }
  if (typeof value !== "object" || value === undefined) {
    throw new TypeError("artifact contains a non-JSON value");
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map(key =>
    `${JSON.stringify(key)}:${canonicalJsonValue(record[key])}`).join(",")}}`;
}

export function canonicalArtifactHash(value: unknown): string {
  const jsonValue = JSON.parse(JSON.stringify(value)) as unknown;
  return createHash("sha256").update(canonicalJsonValue(jsonValue)).digest("hex");
}

export function pipelineResultHash(result: PipelineResult): string {
  return canonicalArtifactHash(result);
}

export function advisorReportHash(report: AdvisorReport): string {
  return canonicalArtifactHash(report);
}

export function autopilotEligibilityRecordHash(record: AutopilotEligibilityRecord): string {
  return canonicalArtifactHash(record);
}

export function autopilotDecisionEligibilityProjection(
  record: AutopilotEligibilityRecord,
): AutopilotDecisionEligibilityV1 {
  if (!record.eligible || record.reasons.length !== 0) {
    throw new TypeError("an ineligible autopilot record cannot authorize a decision");
  }
  return {
    eligibilityVersion: "1",
    eligible: true,
    candidateManifestHash: record.candidateManifestHash,
    evidenceHash: autopilotEligibilityRecordHash(record),
    policyVersion: record.policyVersion,
  };
}

function addReason(reasons: string[], reason: string): void {
  if (!reasons.includes(reason)) reasons.push(reason);
}

/**
 * Pure, deterministic derivation from the frozen evidence itself. Every field
 * of the record is computed here, so no caller-supplied projection or hash can
 * disagree with the artifacts it describes.
 */
export function evaluateAutopilotEligibility(
  evidence: AutopilotEligibilityEvidence,
): AutopilotEligibilityRecord {
  const { pipelineResult, reviewSnapshot, advisor } = evidence;
  const reasons: string[] = [];
  const candidate = pipelineResult.attempt.candidate;
  const lastRound = pipelineResult.rounds.at(-1);
  const gate = pipelineResult.gate;

  if (pipelineResult.status !== "decision-ready") {
    addReason(reasons, "pipeline status is not decision-ready");
  }
  if (!gate.decisionReady) addReason(reasons, "pipeline gate is not decision-ready");
  if (gate.requiresHumanDecision) addReason(reasons, "pipeline gate requires human decision");
  for (const reason of gate.reasons) addReason(reasons, `pipeline gate: ${reason}`);
  if (pipelineResult.attempt.status !== "verified-candidate") {
    addReason(reasons, "attempt is not a verified candidate");
  }

  const verification = pipelineResult.verification;
  if (verification === null) {
    addReason(reasons, "trusted verification is missing");
  } else {
    if (!verification.pass) addReason(reasons, "trusted verification did not pass");
    if (verification.commandResults.length === 0) {
      addReason(reasons, "trusted verification executed no applicable command");
    }
    if (!verification.workspaceClean) addReason(reasons, "verification worktree is not clean");
    if (verification.testsDeleted > 0) addReason(reasons, "verification detected deleted tests");
    if (verification.testsSkipped > 0) addReason(reasons, "verification detected newly skipped tests");
    if (verification.scopeViolations.length > 0) {
      addReason(reasons, "verification detected scope violations");
    }
    if (!Array.isArray(verification.evidence?.failures)) {
      addReason(reasons, "trusted verification evidence is missing");
    } else if (verification.evidence.failures.length > 0) {
      addReason(reasons, "trusted verification evidence contains failures");
    }
  }

  const finalReviews = lastRound?.reviews ?? [];
  for (const reviewer of ["correctness", "systems"] as const) {
    const report = finalReviews.find(review => review.reviewer === reviewer)?.report;
    if (report?.verdict !== "approve") {
      addReason(reasons, `final ${reviewer} review does not approve`);
    }
    if ((report?.coverageGaps.length ?? 1) > 0) {
      addReason(reasons, `final ${reviewer} review has coverage gaps`);
    }
  }
  if ((lastRound?.consolidated.findings ?? []).some(finding =>
    finding.severity === "blocker" || finding.severity === "major")) {
    addReason(reasons, "final review contains blocker or major findings");
  }
  if (lastRound?.fix !== null) addReason(reasons, "final fix was not independently re-reviewed");

  if (advisor.verdict !== "approve") addReason(reasons, "advisor does not approve");
  if (advisor.risks.some(risk => risk.severity === "blocker" || risk.severity === "major")) {
    addReason(reasons, "advisor reported blocker or major risk");
  }
  if (advisor.coverageGaps.length > 0) addReason(reasons, "advisor reported coverage gaps");

  // The review snapshot is produced independently of the pipeline, so its
  // binding to the pipeline's candidate is a real check, not a restatement.
  if (candidate === null) {
    addReason(reasons, "pipeline result has no candidate");
  } else {
    if (pipelineResult.runId !== reviewSnapshot.runId) {
      addReason(reasons, "review snapshot run id mismatch");
    }
    if (candidate.baseCommitOid !== reviewSnapshot.baseCommitOid) {
      addReason(reasons, "review snapshot base commit mismatch");
    }
    if (candidate.candidateCommitOid !== reviewSnapshot.candidateCommitOid) {
      addReason(reasons, "review snapshot candidate commit mismatch");
    }
    if (candidate.candidateTreeOid !== reviewSnapshot.candidateTreeOid) {
      addReason(reasons, "review snapshot candidate tree mismatch");
    }
    if (candidate.manifestHash !== reviewSnapshot.manifestHash) {
      addReason(reasons, "review snapshot candidate manifest mismatch");
    }
    try {
      if (pipelineResult.attempt.runId !== pipelineResult.runId
        || pipelineResult.finalCandidateCommit !== candidate.candidateCommitOid
        || manifestHashOf(candidate.changedPaths) !== candidate.manifestHash) {
        addReason(reasons, "pipeline result candidate binding mismatch");
      }
    } catch {
      addReason(reasons, "pipeline result is malformed");
    }
  }

  let reviewSnapshotHash = "";
  let resultHash = "";
  let advisorHash = "";
  try {
    reviewSnapshotHash = hashReviewSnapshot(reviewSnapshot);
  } catch {
    addReason(reasons, "review snapshot is malformed");
  }
  try {
    resultHash = pipelineResultHash(pipelineResult);
  } catch {
    addReason(reasons, "pipeline result is malformed");
  }
  try {
    advisorHash = advisorReportHash(advisor);
  } catch {
    addReason(reasons, "advisor report is malformed");
  }

  return {
    recordVersion: "1",
    policyVersion: "1",
    runId: pipelineResult.runId,
    eligible: reasons.length === 0,
    reasons,
    baseCommitOid: candidate?.baseCommitOid ?? reviewSnapshot.baseCommitOid,
    candidateCommitOid: candidate?.candidateCommitOid ?? reviewSnapshot.candidateCommitOid,
    candidateTreeOid: candidate?.candidateTreeOid ?? reviewSnapshot.candidateTreeOid,
    candidateManifestHash: candidate?.manifestHash ?? reviewSnapshot.manifestHash,
    reviewSnapshotHash,
    pipelineResultHash: resultHash,
    advisorReportHash: advisorHash,
    evaluatedAt: evidence.evaluatedAt,
  };
}
