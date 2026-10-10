import { describe, expect, it } from "vitest";
import {
  advisorReportHash,
  autopilotEligibilityRecordHash,
  pipelineResultHash,
} from "../../../src/autopilot/autopilot-eligibility.js";
import {
  loadRunEvidence,
  type RunEvidenceExpectations,
  type RunEvidenceStore,
} from "../../../src/autopilot/run-evidence.js";
import { manifestHashOf } from "../../../src/git/changed-path-manifest.js";
import { reviewSnapshotHash } from "../../../src/runtime/review-snapshot.js";

const runId = "run-evidence-task";
const repoRoot = "/repo/workflow";
const baseOid = "a".repeat(40);
const candidateOid = "b".repeat(40);
const treeOid = "c".repeat(40);
const otherOid = "f".repeat(40);
const otherHash = "9".repeat(64);
const changedPaths = [{
  path: "a.txt",
  changeType: "modified" as const,
  mode: "100644",
  contentHash: "e".repeat(64),
}];
const manifestHash = manifestHashOf(changedPaths);

function archive() {
  const candidate = {
    baseCommitOid: baseOid,
    candidateCommitOid: candidateOid,
    candidateTreeOid: treeOid,
    anchorRef: `refs/claude-architect/candidates/${runId}`,
    manifestHash,
    changedPaths,
    patch: "patch",
  };
  return {
    result: { runId, status: "verified-candidate", candidate },
    manifest: { runId, repoRoot, baseCommitOid: baseOid, candidateManifestHash: manifestHash },
    pipelineResult: {
      runId, status: "decision-ready", finalCandidateCommit: candidateOid, marker: "pipeline",
    },
    reviewSnapshot: {
      runId,
      baseCommitOid: baseOid,
      candidateCommitOid: candidateOid,
      candidateTreeOid: treeOid,
      manifestHash,
      patch: "patch",
      changedPaths,
      evidence: {},
      executedVerification: [],
    },
    advisor: { verdict: "approve", marker: "advisor" },
    eligibility: {
      recordVersion: "1" as const,
      policyVersion: "1" as const,
      runId,
      eligible: true,
      reasons: [] as string[],
      baseCommitOid: baseOid,
      candidateCommitOid: candidateOid,
      candidateTreeOid: treeOid,
      candidateManifestHash: manifestHash,
      reviewSnapshotHash: "",
      pipelineResultHash: "",
      advisorReportHash: "",
      evaluatedAt: "2026-07-20T12:00:00.000Z",
    },
  };
}

type Archive = ReturnType<typeof archive>;

/**
 * An archive tampered by `tamper`. Unless `rehash` is false, the eligibility
 * record is re-derived over the tampered artifacts and the caller expects the
 * tampered record's hash, so the one check a row names is the only one it
 * can fail.
 */
function scenario(tamper: (archive: Archive, expected: RunEvidenceExpectations) => void, options: {
  rehash?: boolean;
  expectRecordedEligibility?: boolean;
} = {}) {
  const value = archive();
  const bind = () => {
    value.eligibility.pipelineResultHash = pipelineResultHash(value.pipelineResult as never);
    value.eligibility.reviewSnapshotHash = reviewSnapshotHash(value.reviewSnapshot);
    value.eligibility.advisorReportHash = advisorReportHash(value.advisor as never);
  };
  bind();
  const expected: RunEvidenceExpectations = {
    repoRoot,
    baseCommitOid: baseOid,
    candidateManifestHash: manifestHash,
    eligibilityHash: autopilotEligibilityRecordHash(value.eligibility),
  };
  tamper(value, expected);
  if (options.rehash !== false) bind();
  if (options.expectRecordedEligibility !== true) {
    expected.eligibilityHash = autopilotEligibilityRecordHash(value.eligibility);
  }
  const store = {
    readResult: async () => value.result,
    readManifest: async () => value.manifest,
    readReviewSnapshot: async () => value.reviewSnapshot,
    readCandidateDecision: async () => null,
    readPipelineArtifact: async () => value.pipelineResult,
    readAdvisorReport: async () => value.advisor,
    readAutopilotEligibility: async () => value.eligibility,
  } as unknown as RunEvidenceStore;
  return { store, expected };
}

describe("loadRunEvidence", () => {
  it("returns the coherent bundle", async () => {
    const { store, expected } = scenario(() => {});

    const loaded = await loadRunEvidence(runId, expected, store);

    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.evidence.candidate.candidateCommitOid).toBe(candidateOid);
    expect(loaded.evidence.eligibilityHash).toBe(expected.eligibilityHash);
  });

  it.each([
    ["attempt result run id", (a: Archive) => { a.result.runId = "other-run"; }],
    ["run manifest run id", (a: Archive) => { a.manifest.runId = "other-run"; }],
    ["pipeline result run id", (a: Archive) => { a.pipelineResult.runId = "other-run"; }],
    ["eligibility run id", (a: Archive) => { a.eligibility.runId = "other-run"; }],
    ["run manifest repository root", (a: Archive) => { a.manifest.repoRoot = "/repo/other"; }],
    ["run manifest base commit", (a: Archive) => { a.manifest.baseCommitOid = otherOid; }],
    ["candidate base commit", (a: Archive) => { a.result.candidate.baseCommitOid = otherOid; }],
    ["eligibility base commit", (a: Archive) => { a.eligibility.baseCommitOid = otherOid; }],
    ["eligibility candidate commit", (a: Archive) => {
      a.eligibility.candidateCommitOid = otherOid;
    }],
    ["eligibility candidate tree", (a: Archive) => { a.eligibility.candidateTreeOid = otherOid; }],
    ["candidate tree", (a: Archive) => { a.result.candidate.candidateTreeOid = otherOid; }],
    ["run manifest candidate manifest hash", (a: Archive) => {
      a.manifest.candidateManifestHash = otherHash;
    }],
    ["candidate manifest hash", (a: Archive) => { a.result.candidate.manifestHash = otherHash; }],
    ["eligibility candidate manifest hash", (a: Archive) => {
      a.eligibility.candidateManifestHash = otherHash;
    }],
    ["final candidate commit in the pipeline result", (a: Archive) => {
      a.pipelineResult.finalCandidateCommit = otherOid;
    }],
    ["attempt result status", (a: Archive) => { a.result.status = "failed"; }],
  ] as const)("refuses evidence with a tampered %s", async (_field, tamper) => {
    const { store, expected } = scenario(tamper);

    await expect(loadRunEvidence(runId, expected, store)).resolves.toEqual({
      ok: false, classification: "evidence-mismatch",
    });
  });

  it.each([
    ["a pipeline result", (a: Archive) => { a.pipelineResult.marker = "substituted"; }],
    ["a review snapshot", (a: Archive) => { a.reviewSnapshot.patch = "substituted"; }],
    ["an advisor report", (a: Archive) => { a.advisor.marker = "substituted"; }],
  ] as const)("refuses %s that no longer matches its recorded hash", async (_artifact, tamper) => {
    const { store, expected } = scenario(tamper, { rehash: false });

    await expect(loadRunEvidence(runId, expected, store)).resolves.toEqual({
      ok: false, classification: "evidence-mismatch",
    });
  });

  it("refuses an eligibility record whose hash the workflow did not record", async () => {
    const { store, expected } = scenario(a => { a.eligibility.evaluatedAt = "2026-07-21T12:00:00.000Z"; }, {
      expectRecordedEligibility: true,
    });

    await expect(loadRunEvidence(runId, expected, store)).resolves.toEqual({
      ok: false, classification: "eligibility-stale",
    });
  });

  it("refuses when the workflow recorded no eligibility hash", async () => {
    const { store, expected } = scenario((_a, e) => { e.eligibilityHash = null; }, {
      expectRecordedEligibility: true,
    });

    await expect(loadRunEvidence(runId, expected, store)).resolves.toEqual({
      ok: false, classification: "eligibility-stale",
    });
  });

  it.each([
    ["red eligibility", "eligibility-red", (_s: Record<string, unknown>, a: Archive) => {
      a.eligibility.eligible = false;
    }],
    ["absent eligibility", "eligibility-missing", (s: Record<string, unknown>) => {
      s.readAutopilotEligibility = async () => null;
    }],
    ["an absent advisor report", "run-evidence-missing", (s: Record<string, unknown>) => {
      s.readAdvisorReport = async () => null;
    }],
    ["an unreadable archive", "evidence-mismatch", (s: Record<string, unknown>) => {
      s.readPipelineArtifact = async () => { throw new Error("archive is malformed"); };
    }],
  ] as const)("classifies %s", async (_label, classification, breakArchive) => {
    let archived: Archive | undefined;
    const { store, expected } = scenario(a => { archived = a; });
    breakArchive(store as unknown as Record<string, unknown>, archived!);

    await expect(loadRunEvidence(runId, expected, store)).resolves.toEqual({
      ok: false, classification,
    });
  });
});
