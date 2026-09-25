import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { start } from "../../src/mcp/server.js";
import type { PlatformServices } from "../../src/platform/platform-services.js";
import type { AttemptResult, CandidateArtifact } from "../../src/protocol/attempt-result.js";
import { ArtifactStore } from "../../src/runtime/artifact-store.js";
import type { CandidateDecisionV2 } from "../../src/protocol/candidate-decision.js";
import type { RunManifest } from "../../src/runtime/run-manifest.js";
import type { JevScreen } from "../../src/mcp/jev-screen.js";
import type { ReviewSnapshot } from "../../src/runtime/review-snapshot.js";

function minimalResult(runId: string): AttemptResult {
  return {
    resultVersion: "1",
    runId,
    status: "failed",
    failure: "producer-failure",
    summary: "fixture",
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
    durationMs: 1,
    sessionId: null,
  };
}

describe("legacy decision provenance", () => {
  it("keeps policy-autonomous archives readable for backward compatibility", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "decision-authority-state-"));
    const previousStateRoot = process.env.CLAUDE_ARCHITECT_STATE_DIR;
    const previousPluginData = process.env.CLAUDE_PLUGIN_DATA;
    process.env.CLAUDE_ARCHITECT_STATE_DIR = stateRoot;
    process.env.CLAUDE_PLUGIN_DATA = stateRoot;
    try {
      const store = new ArtifactStore("decision-authority-roundtrip");
      // The pre-V2 shape a shipped release wrote: provenance and a candidate
      // binding, but no decisionVersion. It must still read back as the same
      // authority, or a live run's own decision becomes unreadable.
      await store.writeResult(minimalResult("decision-authority-roundtrip"));
      await writeFile(
        join(store.runDirectory, "decision.json"),
        JSON.stringify({
          decision: "accepted",
          recordedAt: new Date().toISOString(),
          decidedBy: "policy-autonomous",
          candidateManifestHash: "a".repeat(64),
        }),
        "utf8",
      );
      await expect(store.readCandidateDecision())
        .resolves.toMatchObject({ authority: "policy-autonomous" });
    } finally {
      if (previousStateRoot === undefined) {
        delete process.env.CLAUDE_ARCHITECT_STATE_DIR;
      } else {
        process.env.CLAUDE_ARCHITECT_STATE_DIR = previousStateRoot;
      }
      if (previousPluginData === undefined) {
        delete process.env.CLAUDE_PLUGIN_DATA;
      } else {
        process.env.CLAUDE_PLUGIN_DATA = previousPluginData;
      }
      await rm(stateRoot, { recursive: true, force: true });
    }
  });
});

const candidate: CandidateArtifact = {
  baseCommitOid: "1".repeat(40),
  candidateCommitOid: "2".repeat(40),
  candidateTreeOid: "3".repeat(40),
  anchorRef: "refs/claude-architect/candidates/decide-authority",
  // `loadArchivedRun` recomputes this from the changed paths and rejects a
  // mismatch, so derive it rather than inventing a value.
  manifestHash: createHash("sha256").update(JSON.stringify([])).digest("hex"),
  changedPaths: [],
};

const verifiedResult = {
  runId: "decide-authority",
  status: "verified-candidate",
  failure: null,
  candidate,
  evidence: {
    pipelineGateCleared: {
      candidateCommitOid: candidate.candidateCommitOid,
      requiresHumanDecision: false,
    },
  },
  // The review snapshot maps over this, so it must be a real array rather than
  // absent: a fixture that omits it fails inside the snapshot builder before
  // the authority branch under test is ever reached.
  executedVerification: [],
  durationMs: 1,
  producerId: "fake",
} as unknown as AttemptResult;

function fakePlatform(onAcquireLock?: () => void): PlatformServices {
  return {
    os: "darwin",
    canonicalizePath: async (input: string) => ({
      input,
      canonical: "/canonical/repo",
      gitCommonDir: "/canonical/repo/.git",
    }),
    acquireCheckoutLock: async (checkout: string) => {
      onAcquireLock?.();
      return {
        key: checkout,
        repositoryIdentity: "/canonical/repo/.git",
        release: async () => {},
      };
    },
  } as unknown as PlatformServices;
}

/**
 * Drives `decideCandidate` through a real MCP client so the elicitation branch
 * is exercised as the server actually reaches it.
 *
 * The client advertises NO elicitation capability. A verified candidate is the
 * most tempting case to auto-accept, so this proves the public tool still fails
 * closed rather than treating objective verification as human authorization.
 */
async function decideVia(
  result: AttemptResult,
  authority: "autonomous" | "human" = "autonomous",
  options: {
    onAcquireLock?: () => void;
    currentResult?: () => AttemptResult;
    jevScreen?: JevScreen;
  } = {},
): Promise<{ output: unknown; decision: CandidateDecisionV2 | null }> {
  let recorded: CandidateDecisionV2 | null = null;
  let persistedSnapshot: ReviewSnapshot | null = null;
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await start({
    transport: serverTransport,
    recoverStaleRuns: async () => ({ recovered: [], quarantined: [] }),
    pruneRuns: async () => {},
    ps: fakePlatform(options.onAcquireLock),
    decisionAuthority: () => authority,
    // Hermetic by default: the real screen is opt-in and networked.
    jevScreen: options.jevScreen ?? (async () => ({ status: "disabled" })),
    storeFactory: () => ({
      readResult: async () => options.currentResult?.() ?? result,
      readManifest: async () => ({
        runId: "decide-authority",
        repoRoot: "/canonical/repo",
        baseCommitOid: candidate.baseCommitOid,
        candidateManifestHash: candidate.manifestHash,
        effectivePolicy: { verificationPolicy: [{ id: "unit", confinement: "macos-seatbelt", skipped: false }] },
      } as unknown as RunManifest),
      writeCandidateDecisionRecord: async (record: CandidateDecisionV2) => {
        recorded = record;
      },
      readCandidateDecision: async () => recorded,
      writeReviewSnapshot: async snapshot => { persistedSnapshot = snapshot; },
      readReviewSnapshot: async () => persistedSnapshot,
      readRunStartSpecSha256: async () => null,
      readPipelineActiveMarker: async () => null,
    }) as never,
    // The decision path regenerates a review snapshot, which verifies the anchor
  // and tree against the archive before anything is recorded. A git stub that
  // answered nothing failed that check, so the authority branch under test was
  // never reached.
  git: async (_cwd: string, args: string[]) => {
    if (args[0] === "rev-parse" && args.at(-1)?.endsWith("^{commit}") === true) {
      return { stdout: `${candidate.candidateCommitOid}\n`, stderr: "", exitCode: 0 };
    }
    if (args[0] === "rev-parse" && args.at(-1)?.endsWith("^{tree}") === true) {
      return { stdout: `${candidate.candidateTreeOid}\n`, stderr: "", exitCode: 0 };
    }
    return { stdout: "", stderr: "", exitCode: 0 };
  },
  });
  const client = new Client({ name: "authority-test", version: "1.0.0" });
  await client.connect(clientTransport);
  const output = await client.callTool({
    name: "decideCandidate",
    arguments: {
      checkoutPath: "/repo",
      runId: "decide-authority",
      decision: "accepted",
      expectedArtifactHash: candidate.manifestHash,
    },
  });
  await client.close();
  return { output, decision: recorded };
}

describe("decideCandidate authority", () => {
  // The client used here advertises NO elicitation capability, which is what
  // makes these assertions discriminating: if the autonomous path regressed the
  // server would try to prompt, fail closed, and record nothing.
  it("records a clean candidate without prompting under the default authority", async () => {
    const { decision } = await decideVia(verifiedResult);
    expect(decision).not.toBeNull();
    expect(decision?.authority).toBe("policy-autonomous");
    // The binding between the decision and the exact reviewed bytes. Without
    // this, a regression that recorded an unrelated hash -- or none -- would
    // still satisfy every other assertion in this suite.
    expect(decision).toMatchObject({
      candidateManifestHash: candidate.manifestHash,
      evidenceHash: expect.stringMatching(/^[0-9a-f]{64}$/u),
    });
  });

  it("autonomously accepts a plain delegate result recording its provenance", async () => {
    // Same client and authority as above; a plain `delegate` run never enters
    // the pipeline gate, and its archive records `plainDelegate` provenance —
    // the archived status/failure is the only other signal there is.
    const { decision, output } = await decideVia({
      ...verifiedResult,
      evidence: { plainDelegate: true },
    });
    expect(decision, JSON.stringify(output)).not.toBeNull();
    expect(decision?.authority).toBe("policy-autonomous");
  });

  it("lets a Jev concern withdraw autonomy but never grant it", async () => {
    const concern: JevScreen = async () => ({
      status: "concern",
      reasons: ["an independent screen (Jev) flagged security-sensitive changes in the candidate (p=0.91)"],
    });
    const flagged = await decideVia(verifiedResult, "autonomous", { jevScreen: concern });
    expect(flagged.decision).toBeNull();
    expect(JSON.stringify(flagged.output)).toContain("elicitation");

    for (const status of ["clear", "disabled"] as const) {
      const { decision } = await decideVia(verifiedResult, "autonomous", {
        jevScreen: async () => ({ status }),
      });
      expect(decision?.authority).toBe("policy-autonomous");
    }
    const outage = await decideVia(verifiedResult, "autonomous", {
      jevScreen: async () => ({ status: "unavailable", reason: "HTTP 529" }),
    });
    expect(outage.decision?.authority).toBe("policy-autonomous");
  });

  it("never records a clean candidate without elicitation under human authority", async () => {
    // Same candidate, same client, only the authority differs — the mutation
    // that proves the branch above is why no prompt happened.
    const { decision, output } = await decideVia(verifiedResult, "human");
    expect(decision).toBeNull();
    expect(JSON.stringify(output)).toContain("elicitation");
  });

  it("cannot record policy-autonomous from an advisory that changed before locking", async () => {
    let current = verifiedResult;
    const warned = {
      ...verifiedResult,
      evidence: {
        pipelineGateRefused: { reasons: ["the locked gate now requires a human"] },
      },
    } as AttemptResult;
    const { decision, output } = await decideVia(verifiedResult, "autonomous", {
      onAcquireLock: () => { current = warned; },
      currentResult: () => current,
    });

    expect(decision).toBeNull();
    expect(JSON.stringify(output)).toContain("elicitation");
    expect(JSON.stringify(output)).not.toContain("policy-autonomous");
  });

  it.each([
    undefined,
    "caller-asserted",
    "policy-autonomous",
  ] as const)(
    "reports a conflict when human confirmation meets an accepted %s archive",
    async decidedBy => {
      let persistedSnapshot: ReviewSnapshot | null = null;
      const stateRoot = await mkdtemp(join(tmpdir(), "decision-authority-conflict-"));
      const previousStateRoot = process.env.CLAUDE_ARCHITECT_STATE_DIR;
      const previousPluginData = process.env.CLAUDE_PLUGIN_DATA;
      process.env.CLAUDE_ARCHITECT_STATE_DIR = stateRoot;
      process.env.CLAUDE_PLUGIN_DATA = stateRoot;
      const persistentStore = new ArtifactStore("decide-authority");
      try {
        await persistentStore.writeResult(minimalResult("decide-authority"));
        await writeFile(
          join(persistentStore.runDirectory, "decision.json"),
          JSON.stringify({
            decision: "accepted",
            recordedAt: "2026-07-27T00:00:00.000Z",
            ...(decidedBy === undefined ? {} : { decidedBy }),
            candidateManifestHash: candidate.manifestHash,
          }),
          "utf8",
        );
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        await start({
          transport: serverTransport,
          recoverStaleRuns: async () => ({ recovered: [], quarantined: [] }),
          pruneRuns: async () => {},
          ps: fakePlatform(),
          decisionAuthority: () => "human" as const,
          storeFactory: () => ({
            readResult: async () => verifiedResult,
            readManifest: async () => ({
              runId: "decide-authority",
              repoRoot: "/canonical/repo",
              baseCommitOid: candidate.baseCommitOid,
              candidateManifestHash: candidate.manifestHash,
              effectivePolicy: { verificationPolicy: [{ id: "unit", confinement: "macos-seatbelt", skipped: false }] },
            } as unknown as RunManifest),
            writeCandidateDecisionRecord: async (record: CandidateDecisionV2) => {
              await persistentStore.writeCandidateDecisionRecord(record);
            },
            readCandidateDecision: async () => persistentStore.readCandidateDecision(),
            writeReviewSnapshot: async snapshot => { persistedSnapshot = snapshot; },
            readReviewSnapshot: async () => persistedSnapshot,
            readRunStartSpecSha256: async () => null,
            readPipelineActiveMarker: async () => null,
          }) as never,
        // The decision path regenerates a review snapshot, which verifies the anchor
    // and tree against the archive before anything is recorded. A git stub that
    // answered nothing failed that check, so the authority branch under test was
    // never reached.
    git: async (_cwd: string, args: string[]) => {
      if (args[0] === "rev-parse" && args.at(-1)?.endsWith("^{commit}") === true) {
        return { stdout: `${candidate.candidateCommitOid}\n`, stderr: "", exitCode: 0 };
      }
      if (args[0] === "rev-parse" && args.at(-1)?.endsWith("^{tree}") === true) {
        return { stdout: `${candidate.candidateTreeOid}\n`, stderr: "", exitCode: 0 };
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    },
        });
        const client = new Client(
          { name: "authority-conflict-test", version: "1.0.0" },
          { capabilities: { elicitation: { form: {} } } },
        );
        client.setRequestHandler(ElicitRequestSchema, async () => ({
          action: "accept",
          content: { confirm: true },
        }));
        await client.connect(clientTransport);
        const output = await client.callTool({
          name: "decideCandidate",
          arguments: {
            checkoutPath: "/repo",
            runId: "decide-authority",
            decision: "accepted",
            expectedArtifactHash: candidate.manifestHash,
          },
        });
        await client.close();

        expect(JSON.stringify(output)).toContain("decision-conflict");
        // The archived decision must survive the refused write unchanged, with
        // the authority its recorded provenance maps to. An absent decidedBy is
        // "unknown": the record cannot say a person decided.
        await expect(persistentStore.readCandidateDecision())
          .resolves.toMatchObject({
            decision: "accepted",
            authority: decidedBy ?? "unknown",
            candidateManifestHash: candidate.manifestHash,
          });
      } finally {
        if (previousStateRoot === undefined) {
          delete process.env.CLAUDE_ARCHITECT_STATE_DIR;
        } else {
          process.env.CLAUDE_ARCHITECT_STATE_DIR = previousStateRoot;
        }
        if (previousPluginData === undefined) {
          delete process.env.CLAUDE_PLUGIN_DATA;
        } else {
          process.env.CLAUDE_PLUGIN_DATA = previousPluginData;
        }
        await rm(stateRoot, { recursive: true, force: true });
      }
    },
  );
});
