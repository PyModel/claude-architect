import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { AttemptResult, CandidateArtifact } from "../../src/protocol/attempt-result.js";
import type { RunManifest } from "../../src/runtime/run-manifest.js";
import { type ReviewSnapshot, reviewSnapshotHash } from "../../src/runtime/review-snapshot.js";
import type { PipelineGateCleared } from "../../src/protocol/pipeline-gate-cleared.js";
import type { CandidateDecisionV2 } from "../../src/protocol/candidate-decision.js";
import {
  RunDecision,
  readRunDecisionSnapshot,
  runDecision,
  type RunDecisionStore,
} from "../../src/runtime/run-decision.js";

const BASE_COMMIT = "1111111111111111111111111111111111111111";
const CANDIDATE_COMMIT = "2222222222222222222222222222222222222222";
const CANDIDATE_TREE = "3333333333333333333333333333333333333333";
const MANIFEST_HASH = createHash("sha256").update("[]").digest("hex");

function makeArtifact(): CandidateArtifact {
  return {
    baseCommitOid: BASE_COMMIT,
    candidateCommitOid: CANDIDATE_COMMIT,
    candidateTreeOid: CANDIDATE_TREE,
    anchorRef: "refs/claude-architect/candidates/test-run",
    manifestHash: MANIFEST_HASH,
    changedPaths: [],
    patchRef: "patch.diff",
  };
}

function makeManifest(runId: string): RunManifest {
  return {
    manifestVersion: "1",
    runId,
    repoRoot: "/test/repo",
    baseCommitOid: BASE_COMMIT,
    candidateManifestHash: MANIFEST_HASH,
    producer: {
      name: "codex",
      version: "1.0.0",
      model: "test-model",
    },
    effectiveConfig: {},
    policy: {
      confinement: "none",
      writeScope: ["."],
      forbiddenScope: [],
      networkAccess: "none",
      budget: {},
    },
    instructionPaths: [],
    instructionHashes: [],
    promptHash: "prompt-hash",
    environmentSanitized: true,
    runtimeVersion: "1.0.0",
    startedAt: new Date().toISOString(),
  };
}

function makeResult(runId: string, overrides: Partial<AttemptResult> = {}): AttemptResult {
  return {
    runId,
    status: "verified-candidate",
    failure: null,
    candidate: makeArtifact(),
    unresolvedIssues: [],
    summary: "Candidate verified successfully.",
    stdoutRef: "logs/stdout.log",
    stderrRef: "logs/stderr.log",
    timing: { start: 0, finish: 1000 },
    commandOutcomes: [],
    executedVerification: [],
    evidence: {
      pipelineGateCleared: {
        candidateCommitOid: CANDIDATE_COMMIT,
        requiresHumanDecision: false,
      },
    },
    ...overrides,
  };
}

function makeReviewSnapshot(runId: string): ReviewSnapshot {
  return {
    runId,
    baseCommitOid: BASE_COMMIT,
    candidateCommitOid: CANDIDATE_COMMIT,
    candidateTreeOid: CANDIDATE_TREE,
    manifestHash: MANIFEST_HASH,
    patch: "",
    changedPaths: [],
    evidence: {},
    executedVerification: [],
  };
}

function makeGateCleared(): PipelineGateCleared {
  return {
    clearedVersion: "1",
    candidateCommitOid: CANDIDATE_COMMIT,
    requiresHumanDecision: false,
    clearedAt: new Date().toISOString(),
  };
}

function createMockStore(runId: string, overrides: Partial<RunDecisionStore> = {}): RunDecisionStore {
  let result: AttemptResult | null = makeResult(runId);
  let manifest: RunManifest | null = makeManifest(runId);
  let snapshot: ReviewSnapshot | null = makeReviewSnapshot(runId);
  let gateCleared: PipelineGateCleared | null = makeGateCleared();
  let decision: CandidateDecisionV2 | null = null;

  return {
    readResult: async (id: string) => (id === runId ? result : null),
    readManifest: async (id: string) => (id === runId ? manifest : null),
    readReviewSnapshot: async (id: string) => (id === runId ? snapshot : null),
    readPipelineGateCleared: async (id: string) => (id === runId ? gateCleared : null),
    readCandidateDecision: async (id: string) => (id === runId ? decision : null),
    ...overrides,
  };
}

describe("RunDecision", () => {
  describe("readRunDecisionSnapshot", () => {
    it("loads all artifacts concurrently and confirms coherence", async () => {
      const runId = "coherent-run";
      const store = createMockStore(runId);
      const snapshot = await readRunDecisionSnapshot(runId, { store });

      expect(snapshot.runId).toBe(runId);
      expect(snapshot.result).not.toBeNull();
      expect(snapshot.manifest).not.toBeNull();
      expect(snapshot.reviewSnapshot).not.toBeNull();
      expect(snapshot.gateRecord).not.toBeNull();
      expect(snapshot.coherenceErrors).toEqual([]);
    });

    it("falls back to result.evidence.pipelineGateCleared when file is absent", async () => {
      const runId = "fallback-gate-run";
      const store = createMockStore(runId, {
        readPipelineGateCleared: async () => null,
      });
      const snapshot = await readRunDecisionSnapshot(runId, { store });

      expect(snapshot.gateRecord).toEqual({
        clearedVersion: "1",
        candidateCommitOid: CANDIDATE_COMMIT,
        requiresHumanDecision: false,
      });
      expect(snapshot.coherenceErrors).toEqual([]);
    });

    it("detects cross-file identity and manifest hash mismatch", async () => {
      const runId = "incoherent-run";
      const result = makeResult(runId);
      result.candidate!.manifestHash = "different-hash";
      const store = createMockStore(runId, {
        readResult: async () => result,
      });
      const snapshot = await readRunDecisionSnapshot(runId, { store });

      expect(snapshot.coherenceErrors.length).toBeGreaterThan(0);
      expect(snapshot.coherenceErrors).toContainEqual(
        expect.stringContaining("manifest hash does not match"),
      );
    });

    it("detects malformed gate record", async () => {
      const runId = "malformed-gate-run";
      const result = makeResult(runId, {
        evidence: {
          pipelineGateCleared: {
            candidateCommitOid: 12345, // invalid
          },
        },
      });
      const store = createMockStore(runId, {
        readResult: async () => result,
        readPipelineGateCleared: async () => null,
      });
      const snapshot = await readRunDecisionSnapshot(runId, { store });

      expect(snapshot.gateRecordError).toContain("the pipeline gate clearance record is malformed");
    });
  });

  describe("evaluate - 5 RunVerdict states", () => {
    it("1. state: accepted (autonomous: true) on clean verified gate-cleared candidate", async () => {
      const runId = "accepted-run";
      const store = createMockStore(runId);
      const verdict = await runDecision.evaluate(runId, {
        store,
        authority: "autonomous",
      });

      expect(verdict).toEqual({
        state: "accepted",
        autonomous: true,
        candidateCommit: CANDIDATE_COMMIT,
      });
    });

    it("1b. state: accepted on clean verified plain-delegate run without gate record", async () => {
      const runId = "plain-delegate-run";
      const result = makeResult(runId, {
        evidence: { plainDelegate: true },
      });
      const store = createMockStore(runId, {
        readResult: async () => result,
        readPipelineGateCleared: async () => null,
      });
      const verdict = await runDecision.evaluate(runId, {
        store,
        authority: "autonomous",
      });

      expect(verdict).toEqual({
        state: "accepted",
        autonomous: true,
        candidateCommit: CANDIDATE_COMMIT,
      });
    });

    it("2. state: human-required when authority is human", async () => {
      const runId = "human-auth-run";
      const store = createMockStore(runId);
      const verdict = await runDecision.evaluate(runId, {
        store,
        authority: "human",
      });

      expect(verdict.state).toBe("human-required");
      if (verdict.state === "human-required") {
        expect(verdict.candidateCommit).toBe(CANDIDATE_COMMIT);
        expect(verdict.reasons).toContainEqual(
          expect.stringContaining('decision authority is "human"'),
        );
      }
    });

    it("2b. state: human-required when pipeline gate requires human decision", async () => {
      const runId = "human-gate-run";
      const gateCleared: PipelineGateCleared = {
        clearedVersion: "1",
        candidateCommitOid: CANDIDATE_COMMIT,
        requiresHumanDecision: true,
        clearedAt: new Date().toISOString(),
      };
      const store = createMockStore(runId, {
        readPipelineGateCleared: async () => gateCleared,
      });
      const verdict = await runDecision.evaluate(runId, {
        store,
        authority: "autonomous",
      });

      expect(verdict.state).toBe("human-required");
      if (verdict.state === "human-required") {
        expect(verdict.reasons).toContainEqual(
          expect.stringContaining("requires a human decision"),
        );
      }
    });

    it("2c. state: human-required when gate clearance commit does not match candidate commit", async () => {
      const runId = "commit-mismatch-run";
      const gateCleared: PipelineGateCleared = {
        clearedVersion: "1",
        candidateCommitOid: "9999999999999999999999999999999999999999",
        requiresHumanDecision: false,
        clearedAt: new Date().toISOString(),
      };
      const store = createMockStore(runId, {
        readPipelineGateCleared: async () => gateCleared,
      });
      const verdict = await runDecision.evaluate(runId, {
        store,
        authority: "autonomous",
      });

      expect(verdict.state).toBe("human-required");
      if (verdict.state === "human-required") {
        expect(verdict.reasons).toContainEqual(
          expect.stringContaining("does not match"),
        );
      }
    });

    it("2d. state: rejected when pipeline gate was refused", async () => {
      const runId = "refused-gate-run";
      const result = makeResult(runId, {
        evidence: {
          pipelineGateRefused: {
            reasons: ["non-convergent blocker surviving"],
            requiresHumanDecision: true,
          },
        },
      });
      const store = createMockStore(runId, {
        readResult: async () => result,
        readPipelineGateCleared: async () => null,
      });
      const verdict = await runDecision.evaluate(runId, {
        store,
        authority: "autonomous",
      });

      expect(verdict.state).toBe("rejected");
      if (verdict.state === "rejected") {
        expect(verdict.reasons).toContainEqual(
          expect.stringContaining("non-convergent blocker surviving"),
        );
      }
    });

    it("3. state: rejected when attempt failed", async () => {
      const runId = "failed-run";
      const result = makeResult(runId, {
        status: "failed",
        failure: "verification-failure",
        candidate: null,
      });
      const store = createMockStore(runId, {
        readResult: async () => result,
      });
      const verdict = await runDecision.evaluate(runId, {
        store,
        authority: "autonomous",
      });

      expect(verdict.state).toBe("rejected");
      if (verdict.state === "rejected") {
        expect(verdict.reasons).toContainEqual(
          expect.stringContaining("verification-failure"),
        );
      }
    });

    it("3b. state: rejected when candidate decision is rejected or revision-requested", async () => {
      const runId = "decision-rejected-run";
      const snapshot = makeReviewSnapshot(runId);
      const decision: CandidateDecisionV2 = {
        decisionVersion: "2",
        authority: "human",
        decision: "rejected",
        candidateManifestHash: MANIFEST_HASH,
        evidenceHash: reviewSnapshotHash(snapshot),
        policyVersion: "1",
        recordedAt: new Date().toISOString(),
      };
      const store = createMockStore(runId, {
        readReviewSnapshot: async () => snapshot,
        readCandidateDecision: async () => decision,
      });
      const verdict = await runDecision.evaluate(runId, {
        store,
        authority: "autonomous",
      });

      expect(verdict.state).toBe("rejected");
      if (verdict.state === "rejected") {
        expect(verdict.reasons).toContainEqual(
          expect.stringContaining("candidate decision is rejected"),
        );
      }
    });

    it("4. state: incomplete when pipeline review is incomplete", async () => {
      const runId = "incomplete-run";
      const result = makeResult(runId, {
        evidence: {
          pipelineReviewIncomplete: {
            reason: "budget exhausted before review converged",
          },
        },
      });
      const store = createMockStore(runId, {
        readResult: async () => result,
      });
      const verdict = await runDecision.evaluate(runId, {
        store,
        authority: "autonomous",
      });

      expect(verdict.state).toBe("incomplete");
      if (verdict.state === "incomplete") {
        expect(verdict.reasons).toContainEqual(
          expect.stringContaining("budget exhausted before review converged"),
        );
      }
    });

    it("5. state: invalid when run artifacts are not found", async () => {
      const runId = "missing-run";
      const store: RunDecisionStore = {
        readResult: async () => null,
        readManifest: async () => null,
        readReviewSnapshot: async () => null,
        readCandidateDecision: async () => null,
      };
      const verdict = await runDecision.evaluate(runId, {
        store,
        authority: "autonomous",
      });

      expect(verdict.state).toBe("invalid");
      if (verdict.state === "invalid") {
        expect(verdict.reasons).toContain("archived run was not found");
      }
    });

    it("5b. state: invalid when cross-file coherence fails", async () => {
      const runId = "incoherent-eval-run";
      const result = makeResult(runId);
      result.candidate!.manifestHash = "mismatched-hash";
      const store = createMockStore(runId, {
        readResult: async () => result,
      });
      const verdict = await runDecision.evaluate(runId, {
        store,
        authority: "autonomous",
      });

      expect(verdict.state).toBe("invalid");
      if (verdict.state === "invalid") {
        expect(verdict.reasons.length).toBeGreaterThan(0);
      }
    });
  });
});
