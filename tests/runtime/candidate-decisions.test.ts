import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { git } from "../../src/git/git-exec.js";
import type { AttemptResult } from "../../src/protocol/attempt-result.js";
import type {
  CandidateDecision,
  CandidateDecisionV2,
} from "../../src/protocol/candidate-decision.js";
import { ArtifactStore } from "../../src/runtime/artifact-store.js";
import {
  integrationRefusal,
  isAutopilotAcceptance,
  recordCandidateDecision,
  type DecisionProvenance,
} from "../../src/runtime/candidate-decisions.js";

const MANIFEST = "a".repeat(64);
const EVIDENCE = "b".repeat(64);
const OTHER = "c".repeat(64);
const ANCHOR_REF = "refs/claude-architect/candidates/run-decide";

const temporaryRoots: string[] = [];
let previousPluginData: string | undefined;
let previousPluginRoot: string | undefined;

beforeEach(async () => {
  previousPluginData = process.env.CLAUDE_PLUGIN_DATA;
  previousPluginRoot = process.env.CLAUDE_PLUGIN_ROOT;
  const stateRoot = await mkdtemp(join(tmpdir(), "claude-architect-candidate-decisions-"));
  temporaryRoots.push(stateRoot);
  process.env.CLAUDE_PLUGIN_DATA = stateRoot;
  process.env.CLAUDE_PLUGIN_ROOT = join(stateRoot, "plugin-cache");
});

afterEach(async () => {
  if (previousPluginData === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
  else process.env.CLAUDE_PLUGIN_DATA = previousPluginData;
  if (previousPluginRoot === undefined) delete process.env.CLAUDE_PLUGIN_ROOT;
  else process.env.CLAUDE_PLUGIN_ROOT = previousPluginRoot;
  await Promise.all(temporaryRoots.splice(0).map(root =>
    rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })));
});

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

async function archivedStore(runId: string): Promise<ArtifactStore> {
  const store = new ArtifactStore(runId);
  await store.writeResult(sampleResult(runId));
  return store;
}

/** A real repository holding a real candidate anchor, so removal is observed on disk. */
async function anchoredRepository(): Promise<{ repoRoot: string; candidateCommitOid: string }> {
  const repoRoot = await mkdtemp(join(tmpdir(), "claude-architect-candidate-anchor-"));
  temporaryRoots.push(repoRoot);
  expect((await git(repoRoot, ["init", "-q"])).exitCode).toBe(0);
  expect((await git(repoRoot, ["commit", "-q", "--allow-empty", "-m", "candidate"])).exitCode).toBe(0);
  const head = await git(repoRoot, ["rev-parse", "HEAD"]);
  const candidateCommitOid = head.stdout.trim();
  expect((await git(repoRoot, ["update-ref", ANCHOR_REF, candidateCommitOid])).exitCode).toBe(0);
  return { repoRoot, candidateCommitOid };
}

async function anchorPresent(repoRoot: string): Promise<boolean> {
  const shown = await git(repoRoot, ["show-ref", "--verify", "--hash", ANCHOR_REF]);
  return shown.exitCode === 0;
}

/** Anchor stand-in for runs whose test never rejects: any git call fails the test. */
const NO_ANCHOR = {
  repoRoot: "/nonexistent",
  anchorRef: ANCHOR_REF,
  candidateCommitOid: "0".repeat(40),
  git: async () => { throw new Error("anchor must not be touched"); },
};

function v2(overrides: Partial<CandidateDecisionV2>): CandidateDecisionV2 {
  return {
    decisionVersion: "2",
    decision: "accepted",
    authority: "human",
    candidateManifestHash: MANIFEST,
    evidenceHash: EVIDENCE,
    policyVersion: "1",
    recordedAt: "2026-07-14T12:00:00.000Z",
    ...overrides,
  } as CandidateDecisionV2;
}

describe("integration spend check", () => {
  it("spends only an accepted decision with an integrable authority bound to the exact artifact", () => {
    for (const authority of ["human", "policy-autonomous", "autopilot-policy"] as const) {
      expect(integrationRefusal(v2({ authority }), MANIFEST)).toBeNull();
    }
  });

  it.each<[string, CandidateDecision | null, string]>([
    ["no decision", null, "no-accepted-decision"],
    ["a rejection", v2({ decision: "rejected" }), "no-accepted-decision"],
    ["a revision request", v2({ decision: "revision-requested" }), "no-accepted-decision"],
    ["a caller-asserted acceptance", v2({ authority: "caller-asserted" }), "accepted-decision-not-confirmed"],
    ["an unknown-authority version-1 legacy acceptance", {
      decisionVersion: "1",
      decision: "accepted",
      authority: "unknown",
      recordedAt: "2026-07-14T12:00:00.000Z",
      candidateManifestHash: MANIFEST,
    }, "accepted-decision-not-confirmed"],
    ["a version-1 legacy caller-asserted acceptance", {
      decisionVersion: "1",
      decision: "accepted",
      authority: "caller-asserted",
      recordedAt: "2026-07-14T12:00:00.000Z",
      candidateManifestHash: MANIFEST,
    }, "accepted-decision-not-confirmed"],
    ["a version-1 legacy human acceptance that names no artifact", {
      decisionVersion: "1",
      decision: "accepted",
      authority: "human",
      recordedAt: "2026-07-14T12:00:00.000Z",
    }, "decision-artifact-mismatch"],
    ["a version-1 legacy human acceptance with a null binding", {
      decisionVersion: "1",
      decision: "accepted",
      authority: "human",
      recordedAt: "2026-07-14T12:00:00.000Z",
      candidateManifestHash: null,
    }, "decision-artifact-mismatch"],
    ["a version-1 legacy human acceptance of another artifact", {
      decisionVersion: "1",
      decision: "accepted",
      authority: "human",
      recordedAt: "2026-07-14T12:00:00.000Z",
      candidateManifestHash: OTHER,
    }, "decision-artifact-mismatch"],
    ["a human acceptance of another artifact", v2({ candidateManifestHash: OTHER }), "decision-artifact-mismatch"],
    ["an autopilot acceptance of another artifact", v2({
      authority: "autopilot-policy",
      candidateManifestHash: OTHER,
    }), "decision-artifact-mismatch"],
  ])("never spends %s", (_label, decision, refusal) => {
    expect(integrationRefusal(decision, MANIFEST)).toBe(refusal);
  });

  it("refuses an unknown authority read from a pre-provenance archive", async () => {
    const store = await archivedStore("run-pre-provenance");
    await writeFile(join(store.runDirectory, "decision.json"), JSON.stringify({
      decision: "accepted",
      recordedAt: "2026-07-14T12:00:00.000Z",
      candidateManifestHash: MANIFEST,
    }));
    const decision = await store.readCandidateDecision();
    expect(decision?.authority).toBe("unknown");
    expect(integrationRefusal(decision, MANIFEST)).toBe("accepted-decision-not-confirmed");
  });
});

describe("recording a candidate decision", () => {
  async function record(
    store: ArtifactStore,
    overrides: {
      provenance?: DecisionProvenance | undefined;
      decision?: "accepted" | "rejected" | "revision-requested";
      candidateManifestHash?: string;
      evidenceHash?: string;
      recordedAt?: string;
      anchor?: typeof NO_ANCHOR | {
        repoRoot: string;
        anchorRef: string;
        candidateCommitOid: string;
        git: typeof git;
      };
    } = {},
  ): Promise<void> {
    await recordCandidateDecision({
      store,
      existing: await store.readCandidateDecision(),
      provenance: "provenance" in overrides ? overrides.provenance : "human-elicitation",
      decision: overrides.decision ?? "accepted",
      candidateManifestHash: overrides.candidateManifestHash ?? MANIFEST,
      evidenceHash: async () => overrides.evidenceHash ?? EVIDENCE,
      recordedAt: overrides.recordedAt ?? "2026-07-14T12:00:00.000Z",
      anchor: overrides.anchor ?? NO_ANCHOR,
    });
  }

  it.each<[DecisionProvenance | undefined, string]>([
    ["human-elicitation", "human"],
    ["policy-autonomous", "policy-autonomous"],
    ["caller-asserted", "caller-asserted"],
    [undefined, "caller-asserted"],
  ])("records provenance %s as authority %s", async (provenance, authority) => {
    const store = await archivedStore(`run-authority-${String(provenance)}`);
    await record(store, { provenance });
    await expect(store.readCandidateDecision()).resolves.toEqual(v2({
      authority: authority as CandidateDecisionV2["authority"],
    }));
  });

  it("never writes an unknown authority for an unrecognized provenance", async () => {
    const store = await archivedStore("run-authority-unrecognized");
    await record(store, { provenance: "someone-said-so" as DecisionProvenance });
    expect((await store.readCandidateDecision())?.authority).toBe("caller-asserted");
  });

  it.each(["rejected", "revision-requested"] as const)(
    "refuses an autonomous-policy %s before computing evidence or writing",
    async decision => {
      const store = await archivedStore(`run-policy-${decision}`);
      let evidenceComputed = false;
      await expect(recordCandidateDecision({
        store,
        existing: null,
        provenance: "policy-autonomous",
        decision,
        candidateManifestHash: MANIFEST,
        evidenceHash: async () => { evidenceComputed = true; return EVIDENCE; },
        recordedAt: "2026-07-14T12:00:00.000Z",
        anchor: NO_ANCHOR,
      })).rejects.toMatchObject({
        message: `a policy-autonomous authority may only accept, never ${decision}`,
        detail: { toolError: "decision-authority-refused" },
      });
      expect(evidenceComputed).toBe(false);
      await expect(store.readCandidateDecision()).resolves.toBeNull();
    },
  );

  it("treats an identical re-send as idempotent and refuses a different decision as a conflict", async () => {
    const store = await archivedStore("run-idempotent");
    await record(store, { decision: "revision-requested" });
    await record(store, { decision: "revision-requested", recordedAt: "2026-07-14T12:01:00.000Z" });

    for (const conflicting of [
      { decision: "accepted" as const },
      { decision: "revision-requested" as const, candidateManifestHash: OTHER },
      { decision: "revision-requested" as const, evidenceHash: OTHER },
      { decision: "revision-requested" as const, provenance: "caller-asserted" as const },
    ]) {
      await expect(record(store, conflicting)).rejects.toMatchObject({
        message: `candidate decision conflict: recorded revision-requested, attempted ${conflicting.decision}`,
        detail: { toolError: "decision-conflict" },
      });
    }
    await expect(store.readCandidateDecision()).resolves.toEqual(v2({
      decision: "revision-requested",
    }));
  });

  it("refuses any new decision against a version-1 legacy record", async () => {
    const store = await archivedStore("run-legacy-existing");
    const decisionPath = join(store.runDirectory, "decision.json");
    await writeFile(decisionPath, JSON.stringify({
      decision: "accepted",
      recordedAt: "2026-07-14T12:00:00.000Z",
      decidedBy: "human-elicitation",
      candidateManifestHash: MANIFEST,
    }));
    const before = await readFile(decisionPath, "utf8");
    await expect(record(store)).rejects.toMatchObject({
      detail: { toolError: "decision-conflict" },
    });
    expect(await readFile(decisionPath, "utf8")).toBe(before);
  });

  it("removes the candidate anchor once on rejection and tolerates its absence on an identical re-send", async () => {
    const store = await archivedStore("run-reject-anchor");
    const { repoRoot, candidateCommitOid } = await anchoredRepository();
    const anchor = { repoRoot, anchorRef: ANCHOR_REF, candidateCommitOid, git };

    await record(store, { decision: "rejected", anchor });
    expect(await anchorPresent(repoRoot)).toBe(false);
    await expect(store.readCandidateDecision()).resolves.toEqual(v2({ decision: "rejected" }));

    await record(store, { decision: "rejected", anchor, recordedAt: "2026-07-14T12:05:00.000Z" });
    expect(await anchorPresent(repoRoot)).toBe(false);
  });

  it("refuses an identical re-sent rejection when the anchor now names another commit", async () => {
    const store = await archivedStore("run-reject-moved-anchor");
    const { repoRoot, candidateCommitOid } = await anchoredRepository();
    const anchor = { repoRoot, anchorRef: ANCHOR_REF, candidateCommitOid, git };
    await record(store, { decision: "rejected", anchor });

    expect((await git(repoRoot, ["commit", "-q", "--allow-empty", "-m", "other"])).exitCode).toBe(0);
    const other = (await git(repoRoot, ["rev-parse", "HEAD"])).stdout.trim();
    expect((await git(repoRoot, ["update-ref", ANCHOR_REF, other])).exitCode).toBe(0);

    await expect(record(store, { decision: "rejected", anchor })).rejects.toMatchObject({
      detail: { toolError: "anchor-delete-failed" },
    });
    expect(await anchorPresent(repoRoot)).toBe(true);
  });

  it("fails a first rejection whose anchor is already gone", async () => {
    const store = await archivedStore("run-reject-missing-anchor");
    const { repoRoot, candidateCommitOid } = await anchoredRepository();
    expect((await git(repoRoot, ["update-ref", "-d", ANCHOR_REF])).exitCode).toBe(0);
    await expect(record(store, {
      decision: "rejected",
      anchor: { repoRoot, anchorRef: ANCHOR_REF, candidateCommitOid, git },
    })).rejects.toMatchObject({
      detail: { toolError: "anchor-delete-failed" },
    });
  });

  it("keeps the anchor of an accepted candidate", async () => {
    const store = await archivedStore("run-accept-anchor");
    const { repoRoot, candidateCommitOid } = await anchoredRepository();
    await record(store, { anchor: { repoRoot, anchorRef: ANCHOR_REF, candidateCommitOid, git } });
    expect(await anchorPresent(repoRoot)).toBe(true);
  });
});

describe("Autopilot acceptance check", () => {
  const accepted = v2({ authority: "autopilot-policy" });

  it("accepts a version-2 autopilot-policy acceptance bound to both hashes", () => {
    expect(isAutopilotAcceptance(accepted, MANIFEST, EVIDENCE)).toBe(true);
  });

  it.each<[string, CandidateDecision | null]>([
    ["no decision", null],
    ["a human acceptance", v2({ authority: "human" })],
    ["a policy-autonomous acceptance", v2({ authority: "policy-autonomous" })],
    ["a caller-asserted acceptance", v2({ authority: "caller-asserted" })],
    ["a rejection", { ...accepted, decision: "rejected" } as unknown as CandidateDecision],
    ["another manifest", v2({ authority: "autopilot-policy", candidateManifestHash: OTHER })],
    ["other evidence", v2({ authority: "autopilot-policy", evidenceHash: OTHER })],
    ["a version-1 record", {
      decisionVersion: "1",
      decision: "accepted",
      authority: "autopilot-policy",
      recordedAt: "2026-07-14T12:00:00.000Z",
      candidateManifestHash: MANIFEST,
      evidenceHash: EVIDENCE,
    } as unknown as CandidateDecision],
  ])("refuses %s", (_label, decision) => {
    expect(isAutopilotAcceptance(decision, MANIFEST, EVIDENCE)).toBe(false);
  });
});
