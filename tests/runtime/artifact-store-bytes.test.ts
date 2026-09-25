import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AttemptResult } from "../../src/protocol/attempt-result.js";
import { ArtifactStore } from "../../src/runtime/artifact-store.js";
import { buildRunManifest } from "../../src/runtime/run-manifest.js";

/**
 * The archive is a public contract: other sessions, the MCP surface, and
 * recovery all read these bytes back. The descriptor-driven store rewrite must
 * therefore produce byte-identical files for identical inputs. These hashes
 * were recorded from the hand-written façades before the rewrite; a change
 * here is a change to the on-disk format and needs its own decision.
 */
const RUN_ID = "bytes-golden-run";
const REPO_ROOT = "/repo";

const GOLDEN: Record<string, string> = {
  "decision.json": "4cef15d87869d4ece959d5bad7ebd0c005ae089144c90c808b84c9729f1d26bb",
  "logs/producer.log": "e9024f1a07d29d52ad3aa5e1a18e94db1f3a9fd32b89e39d47c472cd99071e13",
  "manifest.json": "d68bf2d317822ba625af666854f810fca06d1c66a1da3caf33d1f46287af7dab",
  "pipeline-active.json": "3c1c0c3ff953ec85e6b52da6a0dd124d41e29ba6f3394f545d2ef636dc20edce",
  "pipeline-gate-cleared.json": "a53c3367231380c176a4fc0e03f6f5056b1446452923dca40e1cb80e1a391c46",
  "pipeline/delegation-spec.json": "475e0a1730837fefbf663e3cec5923326087e80da856a60e4c21004c7e2351a3",
  "result.json": "fd4e6dbc3cd1f580b8aeed3ae8c4e8527c8878017b6cd2c0e159a9b7db028b71",
  "status.json": "fa36578b174e1986f9e2aa865d90f0eaa5da29601d13d163c9a49ac0a11ca213",
};

function sampleResult(): AttemptResult {
  return {
    resultVersion: "1",
    runId: RUN_ID,
    status: "failed",
    failure: "producer-failure",
    summary: "producer exited non-zero",
    producerSummary: null,
    candidate: null,
    requestedVerification: [],
    executedVerification: [],
    unresolvedIssues: [],
    evidence: {},
    logsRef: "logs/producer.log",
    producerId: "codex",
    producerVersion: "1.2.3",
    producerModel: null,
    durationMs: 42,
    sessionId: null,
  };
}

async function hashTree(root: string): Promise<Record<string, string>> {
  const hashes: Record<string, string> = {};
  const walk = async (directory: string): Promise<void> => {
    for (const name of (await readdir(directory)).sort()) {
      const full = join(directory, name);
      if ((await stat(full)).isDirectory()) {
        await walk(full);
        continue;
      }
      hashes[relative(root, full).split("\\").join("/")] = createHash("sha256")
        .update(await readFile(full))
        .digest("hex");
    }
  };
  await walk(root);
  return hashes;
}

describe("artifact store archive bytes", () => {
  let stateRoot: string;
  let previousPluginData: string | undefined;

  beforeEach(async () => {
    previousPluginData = process.env.CLAUDE_PLUGIN_DATA;
    stateRoot = await mkdtemp(join(tmpdir(), "claude-architect-bytes-"));
    process.env.CLAUDE_PLUGIN_DATA = stateRoot;
  });

  afterEach(async () => {
    if (previousPluginData === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
    else process.env.CLAUDE_PLUGIN_DATA = previousPluginData;
    await rm(stateRoot, { recursive: true, force: true });
  });

  it("writes byte-identical artifacts for identical inputs", async () => {
    const store = new ArtifactStore(RUN_ID);
    const result = sampleResult();
    const manifest = buildRunManifest({
      runId: RUN_ID,
      repoRoot: REPO_ROOT,
      baseCommitOid: "a".repeat(40),
      candidateManifestHash: null,
      producer: { id: "codex", version: "1.2.3", model: null },
      effectivePolicy: { isolation: "temporary-home", retries: 0 },
      repositoryInstructions: [{ path: "AGENTS.md", content: "follow the repository rules\n" }],
      prompt: "Implement the requested change",
      executionPolicy: { network: "denied", writeAllowlist: ["src/**"] },
      environment: [{ name: "PATH", source: "platform" }],
      packagedVerifier: { version: "1", content: "trusted verifier bytes" },
    });

    await store.writeLog("producer", "line one\nline two\n");
    await store.writePipelineArtifact("delegation-spec", { specVersion: "x", title: "golden" });
    await store.writeResult(result);
    await store.writeManifest(manifest);
    await store.promoteTerminalArtifacts({
      result: { ...result, summary: "promoted" },
      manifest,
    });
    await store.writePipelineGateCleared({
      clearedVersion: "1",
      candidateCommitOid: "b".repeat(40),
      requiresHumanDecision: false,
      clearedAt: "2026-07-14T12:00:00.000Z",
    });
    await store.writePipelineActiveMarker({
      pid: 4242,
      processToken: "token",
      startedAt: "2026-07-14T12:00:00.000Z",
      sliced: false,
    });
    await store.writeHumanDecision({
      decision: "accepted",
      candidateManifestHash: "a".repeat(64),
      evidenceHash: "b".repeat(64),
      policyVersion: "1",
      recordedAt: "2026-07-14T12:01:00.000Z",
    });
    // status.json exists only after run-start; the store replaces it in place.
    await store.writeRunStatus({
      statusVersion: "1",
      runId: RUN_ID,
      mode: "single",
      phase: "done",
      sliceIndex: null,
      sliceCount: null,
      round: null,
      role: null,
      producerId: "codex",
      startedAt: "2026-07-14T12:00:00.000Z",
      updatedAt: "2026-07-14T12:02:00.000Z",
      detail: "done",
    });

    const actual = await hashTree(store.runDirectory);
    expect(actual).toEqual(GOLDEN);
  });
});
