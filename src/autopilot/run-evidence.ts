import type { PipelineResult } from "../pipeline/pipeline-runtime.js";
import type { AdvisorReport } from "../pipeline/report-types.js";
import type { AttemptResult, CandidateArtifact } from "../protocol/attempt-result.js";
import type { CandidateDecision } from "../protocol/candidate-decision.js";
import type { RunManifest } from "../runtime/run-manifest.js";
import { ArtifactStore } from "../runtime/artifact-store.js";
import { reviewSnapshotHash, type ReviewSnapshot } from "../runtime/review-snapshot.js";
import { readRunDecisionSnapshot } from "../runtime/run-decision.js";
import {
  advisorReportHash,
  autopilotEligibilityRecordHash,
  pipelineResultHash,
  type AutopilotEligibilityRecord,
} from "./autopilot-eligibility.js";

/** The archive references every promoted Autopilot task must carry. */
export const REQUIRED_TASK_EVIDENCE_REFS = [
  "decision.json",
  "manifest.json",
  "pipeline/pipeline-result.json",
  "pipeline/post-pipeline-autopilot.json",
  "result.json",
  "review-snapshot.json",
] as const;

export type RunEvidenceStore = Pick<
  ArtifactStore,
  | "readResult"
  | "readManifest"
  | "readReviewSnapshot"
  | "readCandidateDecision"
  | "readPipelineArtifact"
  | "readAdvisorReport"
  | "readAutopilotEligibility"
>;

/** What the caller already holds and the archive must agree with. */
export interface RunEvidenceExpectations {
  /** The workflow checkout the run was delegated in. */
  repoRoot: string;
  /** The commit the candidate was built on (the promotion's parent). */
  baseCommitOid: string;
  candidateManifestHash: string;
  /** The eligibility hash the workflow recorded for this task, if any. */
  eligibilityHash: string | null;
}

export interface RunEvidence {
  result: AttemptResult;
  manifest: RunManifest;
  candidate: CandidateArtifact;
  pipelineResult: PipelineResult;
  reviewSnapshot: ReviewSnapshot;
  advisor: AdvisorReport;
  eligibility: AutopilotEligibilityRecord;
  eligibilityHash: string;
  /** Returned, never judged: promotion records it, final review requires it. */
  decision: CandidateDecision | null;
}

export type RunEvidenceClassification =
  | "evidence-mismatch"
  | "eligibility-missing"
  | "eligibility-red"
  | "eligibility-stale"
  | "run-evidence-missing";

export type RunEvidenceLoad =
  | { ok: true; evidence: RunEvidence }
  | { ok: false; classification: RunEvidenceClassification };

function refused(classification: RunEvidenceClassification): RunEvidenceLoad {
  return { ok: false, classification };
}

/**
 * Read a run's archived Autopilot evidence once and prove it coherent with
 * itself and with the caller's expectations. Every identity either the
 * promoter or the final reviewer used to check lives here, so neither can
 * accept evidence the other would refuse. Any read failure is a mismatch.
 */
export async function loadRunEvidence(
  runId: string,
  expected: RunEvidenceExpectations,
  store: RunEvidenceStore = new ArtifactStore(runId),
): Promise<RunEvidenceLoad> {
  let result;
  let manifest;
  let reviewSnapshot;
  let decision;
  let pipelineResult;
  let advisor;
  let eligibility;
  try {
    const snapshot = await readRunDecisionSnapshot(runId, { store });
    ({ result, manifest, reviewSnapshot, decision } = snapshot);
    [pipelineResult, advisor, eligibility] = await Promise.all([
      store.readPipelineArtifact<PipelineResult>("pipeline-result"),
      store.readAdvisorReport(),
      store.readAutopilotEligibility(),
    ]);
  } catch {
    return refused("evidence-mismatch");
  }
  if (eligibility === null) return refused("eligibility-missing");
  if (!eligibility.eligible || eligibility.reasons.length !== 0) return refused("eligibility-red");
  let eligibilityHash: string;
  try {
    eligibilityHash = autopilotEligibilityRecordHash(eligibility);
  } catch {
    return refused("evidence-mismatch");
  }
  if (expected.eligibilityHash === null || eligibilityHash !== expected.eligibilityHash) {
    return refused("eligibility-stale");
  }
  const candidate = result?.candidate ?? null;
  if (result === null || manifest === null || pipelineResult === null
    || reviewSnapshot === null || advisor === null || candidate === null) {
    return refused("run-evidence-missing");
  }
  let hashesMatch: boolean;
  try {
    hashesMatch = eligibility.pipelineResultHash === pipelineResultHash(pipelineResult)
      && eligibility.reviewSnapshotHash === reviewSnapshotHash(reviewSnapshot)
      && eligibility.advisorReportHash === advisorReportHash(advisor);
  } catch {
    return refused("evidence-mismatch");
  }
  if (!hashesMatch
    || result.status !== "verified-candidate"
    || result.runId !== runId
    || manifest.runId !== runId
    || pipelineResult.runId !== runId
    || eligibility.runId !== runId
    || manifest.repoRoot !== expected.repoRoot
    || manifest.baseCommitOid !== expected.baseCommitOid
    || candidate.baseCommitOid !== expected.baseCommitOid
    || eligibility.baseCommitOid !== expected.baseCommitOid
    || manifest.candidateManifestHash !== expected.candidateManifestHash
    || candidate.manifestHash !== expected.candidateManifestHash
    || eligibility.candidateManifestHash !== expected.candidateManifestHash
    || pipelineResult.finalCandidateCommit !== candidate.candidateCommitOid
    || eligibility.candidateCommitOid !== candidate.candidateCommitOid
    || eligibility.candidateTreeOid !== candidate.candidateTreeOid) {
    return refused("evidence-mismatch");
  }
  return {
    ok: true,
    evidence: {
      result,
      manifest,
      candidate,
      pipelineResult,
      reviewSnapshot,
      advisor,
      eligibility,
      eligibilityHash,
      decision,
    },
  };
}
