import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { AttemptResult } from "../../src/protocol/attempt-result.js";
import { INTEGRABLE_DECISION_AUTHORITIES } from "../../src/protocol/candidate-decision.js";
import { ArtifactStore } from "../../src/runtime/artifact-store.js";

const temporaryRoots: string[] = [];

function sampleResult(runId: string): AttemptResult {
  return {
    resultVersion: "1",
    runId,
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

let previousPluginData: string | undefined;
let previousPluginRoot: string | undefined;

beforeEach(async () => {
  previousPluginData = process.env.CLAUDE_PLUGIN_DATA;
  previousPluginRoot = process.env.CLAUDE_PLUGIN_ROOT;
  const stateRoot = await mkdtemp(join(tmpdir(), "claude-architect-legacy-decision-"));
  temporaryRoots.push(stateRoot);
  process.env.CLAUDE_PLUGIN_DATA = stateRoot;
  process.env.CLAUDE_PLUGIN_ROOT = join(stateRoot, "plugin-cache");
});

afterEach(async () => {
  if (previousPluginData === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
  else process.env.CLAUDE_PLUGIN_DATA = previousPluginData;
  if (previousPluginRoot === undefined) delete process.env.CLAUDE_PLUGIN_ROOT;
  else process.env.CLAUDE_PLUGIN_ROOT = previousPluginRoot;
  // Each test fills this root with archived run data; leaving it behind
  // accumulates state directories in tmpdir() on every run.
  await Promise.all(temporaryRoots.splice(0).map(root =>
    rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })));
});

/**
 * Establish a real run directory, then overwrite decision.json with bytes in the
 * exact shape a prior release wrote. Hand-writing the file is the point: these
 * archives already exist on disk in the wild and the current writer can no
 * longer produce them, so nothing but the literal bytes reproduces the case.
 */
async function archiveDecisionBytes(runId: string, decision: unknown): Promise<ArtifactStore> {
  const store = new ArtifactStore(runId);
  await store.writeResult(sampleResult(runId));
  await writeFile(join(store.runDirectory, "decision.json"), JSON.stringify(decision), "utf8");
  return store;
}

describe("legacy decision archives written before decisionVersion existed", () => {
  it("reads a 0.39/0.40 human acceptance and keeps it integrable", async () => {
    // The shape the shipped MCP lifecycle writes today: no decisionVersion, but
    // provenance and a candidate binding alongside the original two fields.
    const store = await archiveDecisionBytes("run-legacy-human", {
      decision: "accepted",
      recordedAt: "2026-07-20T09:00:00.000Z",
      decidedBy: "human-elicitation",
      candidateManifestHash: "a".repeat(64),
    });

    const decision = await store.readCandidateDecision();

    expect(decision).toEqual({
      decisionVersion: "1",
      decision: "accepted",
      authority: "human",
      recordedAt: "2026-07-20T09:00:00.000Z",
      candidateManifestHash: "a".repeat(64),
    });
    expect(INTEGRABLE_DECISION_AUTHORITIES).toContain(decision!.authority);
  });

  it("carries an autonomous acceptance across as policy-autonomous, still integrable", async () => {
    const store = await archiveDecisionBytes("run-legacy-policy", {
      decision: "accepted",
      recordedAt: "2026-07-20T09:00:00.000Z",
      decidedBy: "policy-autonomous",
      candidateManifestHash: "b".repeat(64),
    });

    const decision = await store.readCandidateDecision();

    expect(decision?.authority).toBe("policy-autonomous");
    expect(INTEGRABLE_DECISION_AUTHORITIES).toContain(decision!.authority);
  });

  it("refuses to call a pre-provenance record human", async () => {
    // The original two-key shape. It records that a decision happened and says
    // nothing about who made it; reporting "human" would invent the evidence
    // and hand the record the one authority that passes the integration gate.
    const store = await archiveDecisionBytes("run-legacy-bare", {
      decision: "accepted",
      recordedAt: "2026-07-20T09:00:00.000Z",
    });

    const decision = await store.readCandidateDecision();

    expect(decision?.authority).toBe("unknown");
    expect(INTEGRABLE_DECISION_AUTHORITIES).not.toContain(decision!.authority);
  });

  it("keeps a caller-asserted decision distinguishable and non-integrable", async () => {
    const store = await archiveDecisionBytes("run-legacy-caller", {
      decision: "accepted",
      recordedAt: "2026-07-20T09:00:00.000Z",
      decidedBy: "caller-asserted",
      candidateManifestHash: null,
    });

    const decision = await store.readCandidateDecision();

    expect(decision?.authority).toBe("caller-asserted");
    expect(INTEGRABLE_DECISION_AUTHORITIES).not.toContain(decision!.authority);
  });

  it("still rejects an archive carrying unknown fields", async () => {
    const store = await archiveDecisionBytes("run-legacy-extra", {
      decision: "accepted",
      recordedAt: "2026-07-20T09:00:00.000Z",
      decidedBy: "human-elicitation",
      approvedBy: "someone",
    });

    await expect(store.readCandidateDecision())
      .rejects.toThrow("archived run decision is malformed");
  });

  it("rejects a malformed candidate binding rather than silently dropping it", async () => {
    const store = await archiveDecisionBytes("run-legacy-badhash", {
      decision: "accepted",
      recordedAt: "2026-07-20T09:00:00.000Z",
      decidedBy: "human-elicitation",
      candidateManifestHash: "not-a-hash",
    });

    await expect(store.readCandidateDecision())
      .rejects.toThrow("archived run decision is malformed");
  });

  it("leaves the archived bytes untouched when reading", async () => {
    const original = {
      decision: "accepted",
      recordedAt: "2026-07-20T09:00:00.000Z",
      decidedBy: "human-elicitation",
      candidateManifestHash: "c".repeat(64),
    };
    const store = await archiveDecisionBytes("run-legacy-immutable", original);

    await store.readCandidateDecision();

    const onDisk: unknown = JSON.parse(
      await readFile(join(store.runDirectory, "decision.json"), "utf8"),
    );
    expect(onDisk).toEqual(original);
  });
});
