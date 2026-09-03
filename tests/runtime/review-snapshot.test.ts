import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { GitResult } from "../../src/git/git-exec.js";
import type { AttemptResult, CandidateArtifact } from "../../src/protocol/attempt-result.js";
import { PROTOCOL_VERSION } from "../../src/protocol/versions.js";
import { ArtifactStore } from "../../src/runtime/artifact-store.js";
import {
  createReviewSnapshot,
  reviewSnapshotHash,
  type ReviewSnapshot,
  type ReviewSnapshotRun,
} from "../../src/runtime/review-snapshot.js";
import { registerSecretValue } from "../../src/runtime/redaction.js";
import type { RunManifest } from "../../src/runtime/run-manifest.js";

const runId = "run-review-snapshot";
const changedPaths: CandidateArtifact["changedPaths"] = [{
  path: "src/example.ts",
  changeType: "modified",
  mode: "100644",
  contentHash: "4".repeat(40),
}];
const manifestHash = createHash("sha256").update(JSON.stringify(changedPaths)).digest("hex");
const candidate: CandidateArtifact = {
  baseCommitOid: "1".repeat(40),
  candidateCommitOid: "2".repeat(40),
  candidateTreeOid: "3".repeat(40),
  anchorRef: `refs/claude-architect/candidates/${runId}`,
  manifestHash,
  changedPaths,
  patch: "archived redacted patch",
};
const result: AttemptResult = {
  resultVersion: "1",
  runId,
  status: "verified-candidate",
  failure: null,
  summary: "verified",
  producerSummary: null,
  candidate,
  requestedVerification: [],
  executedVerification: [],
  unresolvedIssues: [],
  evidence: { z: 1, nested: { y: 2, x: 3 } },
  logsRef: "logs/producer.log",
  producerId: "fake",
  producerVersion: "1.0.0",
  producerModel: null,
  durationMs: 1,
  sessionId: null,
};
const manifest: RunManifest = {
  manifestVersion: "1",
  runId,
  repoRoot: "/canonical/repo",
  baseCommitOid: candidate.baseCommitOid,
  candidateManifestHash: candidate.manifestHash,
  producer: { id: "fake", version: "1.0.0", model: null },
  effectivePolicy: {},
  repositoryInstructions: [],
  promptHash: "5".repeat(64),
  executionPolicy: {},
  environment: [],
  runtimeVersion: "0.8.0",
  protocolVersion: PROTOCOL_VERSION,
  schemaVersions: { delegationSpec: "1", attemptResult: "1" },
  packagedVerifier: { version: "test", hash: "6".repeat(64) },
  manifestHash: "7".repeat(64),
};

function gitResult(
  stdout = "",
  exitCode = 0,
  truncated: NonNullable<GitResult["truncated"]> = { stdout: false, stderr: false },
): GitResult {
  return { stdout, stderr: "", exitCode, truncated };
}

function reviewRun(overrides: {
  result?: AttemptResult;
  manifest?: RunManifest;
  anchor?: GitResult;
  tree?: GitResult;
  patch?: GitResult;
} = {}): ReviewSnapshotRun {
  const storedResult = overrides.result ?? result;
  const storedManifest = overrides.manifest ?? manifest;
  return {
    runId,
    repoRoot: "/canonical/repo",
    repositoryIdentity: "/canonical/repo/.git",
    store: {
      readResult: async () => storedResult,
      readManifest: async () => storedManifest,
    },
    platformServices: {
      canonicalizePath: async input => ({
        input,
        canonical: "/canonical/repo",
        gitCommonDir: "/canonical/repo/.git",
      }),
    },
    git: async (_cwd, args) => {
      if (args[0] === "diff") return overrides.patch ?? gitResult("exact patch\n");
      if (args.includes(`${candidate.anchorRef}^{commit}`)) {
        return overrides.anchor ?? gitResult(`${candidate.candidateCommitOid}\n`);
      }
      if (args.includes(`${candidate.candidateCommitOid}^{tree}`)) {
        return overrides.tree ?? gitResult(`${candidate.candidateTreeOid}\n`);
      }
      throw new Error(`unexpected git args: ${args.join(" ")}`);
    },
  };
}

let previousPluginData: string | undefined;
let stateRoot = "";

beforeEach(async () => {
  previousPluginData = process.env.CLAUDE_PLUGIN_DATA;
  stateRoot = await mkdtemp(join(tmpdir(), "claude-architect-review-snapshot-"));
  process.env.CLAUDE_PLUGIN_DATA = stateRoot;
}, 30_000);

afterEach(async () => {
  if (previousPluginData === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
  else process.env.CLAUDE_PLUGIN_DATA = previousPluginData;
  await rm(stateRoot, { recursive: true, force: true });
}, 30_000);

describe("review snapshots", () => {
  it("reconstructs the exact identity-bound snapshot and hashes canonical JSON", async () => {
    const snapshot = await createReviewSnapshot(reviewRun());
    expect(snapshot).toEqual({
      runId,
      baseCommitOid: candidate.baseCommitOid,
      candidateCommitOid: candidate.candidateCommitOid,
      candidateTreeOid: candidate.candidateTreeOid,
      manifestHash,
      patch: "exact patch\n",
      changedPaths,
      evidence: result.evidence,
      executedVerification: result.executedVerification,
    });
    expect(reviewSnapshotHash(snapshot)).toMatch(/^[0-9a-f]{64}$/u);

    const reordered: ReviewSnapshot = {
      ...snapshot,
      evidence: { nested: { x: 3, y: 2 }, z: 1 },
    };
    expect(reviewSnapshotHash(reordered)).toBe(reviewSnapshotHash(snapshot));
  }, 30_000);

  it("fails closed instead of hashing a redacted identity substitute", async () => {
    const snapshot = await createReviewSnapshot(reviewRun());
    const registration = registerSecretValue(snapshot.baseCommitOid);
    try {
      expect(() => reviewSnapshotHash(snapshot)).toThrow(
        "review base commit oid cannot be reviewed without redacting its identity",
      );
    } finally {
      registration.dispose();
    }
  }, 30_000);

  it("fails closed instead of hashing an already-redacted identity substitute", async () => {
    const snapshot = await createReviewSnapshot(reviewRun());
    expect(() => reviewSnapshotHash({ ...snapshot, runId: "[s]" })).toThrow(
      "review run id cannot be reviewed without redacting its identity",
    );
  }, 30_000);

  it.each([
    ["anchor", reviewRun({ anchor: gitResult(`${"8".repeat(40)}\n`) }), "candidate-anchor-mismatch"],
    ["tree", reviewRun({ tree: gitResult(`${"9".repeat(40)}\n`) }), "candidate-anchor-mismatch"],
    [
      "manifest",
      reviewRun({ manifest: { ...manifest, candidateManifestHash: "a".repeat(64) } }),
      "candidate-review-failed",
    ],
    [
      "patch truncation",
      reviewRun({ patch: gitResult("partial patch", 0, { stdout: true, stderr: false }) }),
      "candidate-review-failed",
    ],
  ] as const)("fails closed on %s tampering", async (_label, run, expectedError) => {
    await expect(createReviewSnapshot(run)).rejects.toMatchObject({
      detail: { toolError: expectedError },
    });
  }, 30_000);

  it("persists atomically, accepts same-hash rewrites, and rejects conflicts", async () => {
    const snapshot = await createReviewSnapshot(reviewRun());
    const store = new ArtifactStore(runId);

    await store.writeReviewSnapshot(snapshot);
    await store.writeReviewSnapshot({
      ...snapshot,
      evidence: { nested: { x: 3, y: 2 }, z: 1 },
    });
    await expect(store.readReviewSnapshot()).resolves.toEqual(snapshot);

    await expect(store.writeReviewSnapshot({
      ...snapshot,
      patch: "different patch\n",
    })).rejects.toMatchObject({
      message: "review snapshot conflict: archived snapshot differs from attempted snapshot",
      detail: { toolError: "review-snapshot-conflict" },
    });
  }, 30_000);
});
