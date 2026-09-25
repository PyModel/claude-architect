import { describe, expect, it } from "vitest";
import {
  advisorReportHash,
  evaluateAutopilotEligibility,
  pipelineResultHash,
  type AutopilotEligibilityEvidence,
} from "../../../src/autopilot/autopilot-eligibility.js";
import { reviewSnapshotHash } from "../../../src/runtime/review-snapshot.js";
import { advisorReport, pipelineResult, reviewSnapshot } from "./autopilot-fixtures.js";
import { loadSchemas } from "../../../src/protocol/schema-loader.js";

function greenEvidence(): AutopilotEligibilityEvidence {
  return {
    pipelineResult: pipelineResult(),
    reviewSnapshot: reviewSnapshot(),
    advisor: structuredClone(advisorReport),
    evaluatedAt: "2026-07-20T12:00:00.000Z",
  };
}

describe("evaluateAutopilotEligibility", () => {
  it("derives eligibility only from completely green evidence", () => {
    const evidence = greenEvidence();
    expect(evaluateAutopilotEligibility(evidence)).toEqual({
      recordVersion: "1",
      policyVersion: "1",
      runId: evidence.pipelineResult.runId,
      eligible: true,
      reasons: [],
      baseCommitOid: evidence.reviewSnapshot.baseCommitOid,
      candidateCommitOid: evidence.reviewSnapshot.candidateCommitOid,
      candidateTreeOid: evidence.reviewSnapshot.candidateTreeOid,
      candidateManifestHash: evidence.reviewSnapshot.manifestHash,
      reviewSnapshotHash: reviewSnapshotHash(evidence.reviewSnapshot),
      pipelineResultHash: pipelineResultHash(evidence.pipelineResult),
      advisorReportHash: advisorReportHash(evidence.advisor),
      evaluatedAt: evidence.evaluatedAt,
    });
  });

  // Each row pins the reason it claims to exercise, so removing that one
  // check cannot leave the row green on some other red reason.
  it.each([
    ["human status", (e: AutopilotEligibilityEvidence) => {
      e.pipelineResult.status = "human-decision-required";
    }, "pipeline status is not decision-ready"],
    ["gate reason", (e: AutopilotEligibilityEvidence) => {
      e.pipelineResult.gate = { decisionReady: false, requiresHumanDecision: false, reasons: ["baseline drift"] };
    }, "pipeline gate: baseline drift"],
    ["advisor risk", (e: AutopilotEligibilityEvidence) => {
      e.advisor.risks = [{ severity: "major", claim: "race", evidence: "repro" }];
    }, "advisor reported blocker or major risk"],
    ["advisor coverage gap", (e: AutopilotEligibilityEvidence) => {
      e.advisor.coverageGaps = ["Windows not reviewed"];
    }, "advisor reported coverage gaps"],
    ["snapshot of other bytes", (e: AutopilotEligibilityEvidence) => {
      e.reviewSnapshot.manifestHash = "0".repeat(64);
    }, "review snapshot candidate manifest mismatch"],
    ["snapshot of another run", (e: AutopilotEligibilityEvidence) => {
      e.reviewSnapshot.runId = "run-other";
    }, "review snapshot run id mismatch"],
    ["candidate manifest not matching its paths", (e: AutopilotEligibilityEvidence) => {
      e.pipelineResult.attempt.candidate!.changedPaths = [
        { path: "unreviewed.txt", changeType: "added", mode: "100644", contentHash: "d".repeat(40) },
      ];
    }, "pipeline result candidate binding mismatch"],
    ["missing candidate", (e: AutopilotEligibilityEvidence) => {
      e.pipelineResult.attempt.candidate = null;
    }, "pipeline result has no candidate"],
  ] as const)("rejects %s", (_name, mutate, expectedReason) => {
    const evidence = greenEvidence();
    mutate(evidence);
    const record = evaluateAutopilotEligibility(evidence);
    expect(record.eligible).toBe(false);
    expect(record.reasons).toContain(expectedReason);
  });

  it("reports malformed evidence instead of throwing", () => {
    const evidence = greenEvidence();
    // A BigInt has no JSON form, so the advisor report cannot be hashed.
    (evidence.advisor as { rationale: unknown }).rationale = 1n;
    const record = evaluateAutopilotEligibility(evidence);
    expect(record.eligible).toBe(false);
    expect(record.reasons).toContain("advisor report is malformed");
  });

  it("registers strict advisor and eligibility schemas", () => {
    const schemas = loadSchemas();
    const eligibility = evaluateAutopilotEligibility(greenEvidence());
    expect(schemas.advisorReport(advisorReport)).toBe(true);
    expect(schemas.autopilotEligibility(eligibility)).toBe(true);
    expect(schemas.advisorReport({
      ...advisorReport,
      risks: [{ severity: "minor", claim: "claim", evidence: "evidence", extra: true }],
    })).toBe(false);
    expect(schemas.autopilotEligibility({ ...eligibility, extra: true })).toBe(false);
  });
});
