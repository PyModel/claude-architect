import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { GitResult } from "../../src/git/git-exec.js";
import { reviewCandidateOutputSchema } from "../../src/mcp/server.js";
import {
  handleReviewCandidate,
  type ToolArtifactStore,
  type ToolDependencies,
} from "../../src/mcp/tools.js";
import type { PlatformServices } from "../../src/platform/platform-services.js";
import type { AttemptResult, CandidateArtifact } from "../../src/protocol/attempt-result.js";
import { PROTOCOL_VERSION } from "../../src/protocol/versions.js";
import type { RunManifest } from "../../src/runtime/run-manifest.js";
import type { ReviewSnapshot } from "../../src/runtime/review-snapshot.js";

const changedPaths: CandidateArtifact["changedPaths"] = [{
  path: "src/example.ts",
  changeType: "modified",
  mode: "100644",
  contentHash: "5".repeat(40),
}];

const manifestHash = createHash("sha256")
  .update(JSON.stringify(changedPaths))
  .digest("hex");

const candidate: CandidateArtifact = {
  baseCommitOid: "1".repeat(40),
  candidateTreeOid: "2".repeat(40),
  candidateCommitOid: "3".repeat(40),
  anchorRef: "refs/claude-architect/candidates/run-review-hash",
  manifestHash,
  changedPaths,
  patch: "archived patch",
};

const result: AttemptResult = {
  resultVersion: "1",
  runId: "run-review-hash",
  status: "verified-candidate",
  failure: null,
  summary: "verified",
  producerSummary: "done",
  candidate,
  requestedVerification: [],
  executedVerification: [],
  unresolvedIssues: [],
  evidence: { structural: { manifestHash } },
  logsRef: "logs/producer.log",
  producerId: "fake",
  producerVersion: "1.0.0",
  producerModel: null,
  durationMs: 1,
  sessionId: null,
};

function runManifest(candidateManifestHash = manifestHash): RunManifest {
  return {
    manifestVersion: "1",
    runId: result.runId,
    repoRoot: "/canonical/repo",
    baseCommitOid: candidate.baseCommitOid,
    candidateManifestHash,
    producer: { id: "fake", version: "1.0.0", model: null },
    effectivePolicy: {},
    repositoryInstructions: [],
    promptHash: "6".repeat(64),
    executionPolicy: {},
    environment: [],
    runtimeVersion: "0.8.0",
    protocolVersion: PROTOCOL_VERSION,
    schemaVersions: { delegationSpec: "1", attemptResult: "1" },
    packagedVerifier: { version: "test", hash: "7".repeat(64) },
    manifestHash: "8".repeat(64),
  };
}

function gitResult(stdout = "", exitCode = 0): GitResult {
  return { stdout, stderr: "", exitCode };
}

function dependencies(storedManifest: RunManifest): ToolDependencies {
  let persistedSnapshot: ReviewSnapshot | null = null;
  const store: ToolArtifactStore = {
    readResult: async () => result,
    readManifest: async () => storedManifest,
    writeHumanDecision: async () => {},
    readCandidateDecision: async () => null,
    readPipelineActiveMarker: async () => null,
    // The snapshot must actually round-trip: a store that drops it would let a
    // decision bind an evidenceHash to bytes that were never persisted.
    writeReviewSnapshot: async snapshot => { persistedSnapshot = snapshot; },
    readReviewSnapshot: async () => persistedSnapshot,
  };
  const ps = {
    canonicalizePath: async (input: string) => ({
      input,
      canonical: "/canonical/repo",
      gitCommonDir: "/canonical/repo/.git",
    }),
    acquireCheckoutLock: async () => ({
      key: "/canonical/repo/.git",
      repositoryIdentity: "/canonical/repo/.git",
      release: async () => {},
    }),
  } as PlatformServices;
  return {
    ps,
    storeFactory: () => store,
    git: async (_cwd, args) => {
      if (args[0] === "diff") return gitResult("exact patch\n");
      if (args.includes(`${candidate.anchorRef}^{commit}`)) {
        return gitResult(`${candidate.candidateCommitOid}\n`);
      }
      if (args.includes(`${candidate.candidateCommitOid}^{tree}`)) {
        return gitResult(`${candidate.candidateTreeOid}\n`);
      }
      throw new Error(`unexpected git args: ${args.join(" ")}`);
    },
  };
}

describe("reviewCandidate manifest hash contract", () => {
  it("echoes the hash of the frozen candidate artifact", async () => {
    const output = await handleReviewCandidate(
      "/canonical/repo",
      result.runId,
      dependencies(runManifest()),
    );

    expect(output).toMatchObject({ manifestHash, patch: "exact patch\n" });
    expect(reviewCandidateOutputSchema.parse(output)).toMatchObject({ manifestHash });
  });

  it("fails closed instead of echoing a hash when the archive manifest disagrees", async () => {
    const output = await handleReviewCandidate(
      "/canonical/repo",
      result.runId,
      dependencies(runManifest("f".repeat(64))),
    );

    // The snapshot's coherence pass reaches this divergence before review does
    // and names the field that diverged. Same classification, same fail-closed
    // outcome, a diagnostic a reader can act on.
    expect(output).toEqual({
      ok: false,
      error: "archive-inconsistent",
      diagnostic: "archived candidate manifest hash does not match run manifest",
    });
    expect(output).not.toHaveProperty("manifestHash");
  });
});
