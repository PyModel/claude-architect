import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DECISION_AUTHORITY_ENV,
  decisionAuthority,
} from "../../src/mcp/decision-authority.js";
import { readDecisionAdvisory } from "../../src/mcp/tools.js";
import { start } from "../../src/mcp/server.js";
import type { PlatformServices } from "../../src/platform/platform-services.js";
import type { AttemptResult, CandidateArtifact } from "../../src/protocol/attempt-result.js";
import { ArtifactStore } from "../../src/runtime/artifact-store.js";
import type { CandidateDecisionV2 } from "../../src/protocol/candidate-decision.js";
import type { RunManifest } from "../../src/runtime/run-manifest.js";
import { manifestHashOf } from "../../src/git/changed-path-manifest.js";
import type { ReviewSnapshot } from "../../src/runtime/review-snapshot.js";

describe("decisionAuthority", () => {
  it("defaults to autonomous when unset or empty", () => {
    expect(decisionAuthority({})).toBe("autonomous");
    expect(decisionAuthority({ [DECISION_AUTHORITY_ENV]: "" })).toBe("autonomous");
  });

  it("honors both recognized values", () => {
    expect(decisionAuthority({ [DECISION_AUTHORITY_ENV]: "human" })).toBe("human");
    expect(decisionAuthority({ [DECISION_AUTHORITY_ENV]: "autonomous" })).toBe("autonomous");
  });

  it("fails closed and warns on an unrecognized value", () => {
    // A typo must not silently select the permissive mode — that is the exact
    // failure this setting exists to prevent.
    const warnings: string[] = [];
    expect(decisionAuthority(
      { [DECISION_AUTHORITY_ENV]: "autonomus" },
      message => warnings.push(message),
    )).toBe("human");
    expect(warnings).toEqual([expect.stringContaining("not a recognized decision authority")]);
  });
});

describe("policy-autonomous decisions survive the archive", () => {
  // Isolated state root: this used to write into the real plugin data directory
  // under a fixed run id, so the archive it created survived the run and made
  // the next one fail on a decision conflict with its own leftovers.
  let previousPluginData: string | undefined;
  const suiteRoots: string[] = [];

  beforeEach(async () => {
    previousPluginData = process.env.CLAUDE_PLUGIN_DATA;
    const root = await mkdtemp(join(tmpdir(), "decision-authority-"));
    suiteRoots.push(root);
    process.env.CLAUDE_PLUGIN_DATA = root;
  });

  afterEach(async () => {
    if (previousPluginData === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
    else process.env.CLAUDE_PLUGIN_DATA = previousPluginData;
    // `decideVia` removes its own root; these were left behind full of
    // archived attempt results and decision records.
    await Promise.all(suiteRoots.splice(0).map(root =>
      rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })));
  });

  it("writes and reads back a policy-autonomous decision", async () => {
    // The write validator rejects unknown provenance values, so without this
    // the new value would be unwritable and every autonomous decision would
    // fail at the point of being recorded.
    const store = new ArtifactStore("decision-authority-roundtrip");
    await store.writeResult({
      resultVersion: "1",
      runId: "decision-authority-roundtrip",
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
    });
    const record: CandidateDecisionV2 = {
      decisionVersion: "2",
      decision: "accepted",
      authority: "policy-autonomous",
      candidateManifestHash: "a".repeat(64),
      evidenceHash: "b".repeat(64),
      policyVersion: "1",
      recordedAt: new Date().toISOString(),
    };
    await store.writeCandidateDecisionRecord(record);
    await expect(store.readCandidateDecision())
      .resolves.toMatchObject({ authority: "policy-autonomous" });
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

let confinedVerification: unknown[] = [
  { id: "unit", confinement: "macos-seatbelt", networkPolicy: "unenforced", skipped: false },
];

const verifiedResult = {
  runId: "decide-authority",
  status: "verified-candidate",
  failure: null,
  candidate,
  evidence: {},
  // The review snapshot maps over this, so it must be a real array rather than
  // absent: a fixture that omits it fails inside the snapshot builder before
  // the authority branch under test is ever reached.
  executedVerification: [],
  durationMs: 1,
  producerId: "fake",
} as unknown as AttemptResult;

const gateClearedResult = {
  ...verifiedResult,
  evidence: {
    pipelineGateCleared: {
      candidateCommitOid: candidate.candidateCommitOid,
      requiresHumanDecision: false,
    },
  },
} as AttemptResult;

function fakePlatform(): PlatformServices {
  return {
    os: "darwin",
    canonicalizePath: async (input: string) => ({
      input,
      canonical: "/canonical/repo",
      gitCommonDir: "/canonical/repo/.git",
    }),
    acquireCheckoutLock: async (checkout: string) => ({
      key: checkout,
      repositoryIdentity: "/canonical/repo/.git",
      release: async () => {},
    }),
  } as unknown as PlatformServices;
}

async function advisoryFor(result: AttemptResult) {
  return readDecisionAdvisory("decide-authority", {
    ps: fakePlatform(),
    storeFactory: () => ({
      readResult: async () => result,
      readManifest: async () => ({
        runId: "decide-authority",
        repoRoot: "/canonical/repo",
        baseCommitOid: candidate.baseCommitOid,
        candidateManifestHash: candidate.manifestHash,
        effectivePolicy: { verificationPolicy: confinedVerification },
      } as unknown as RunManifest),
    }) as never,
  });
}

/**
 * Drives `decideCandidate` through a real MCP client so the elicitation branch
 * is exercised as the server actually reaches it.
 *
 * The client advertises NO elicitation capability. That makes the assertion
 * discriminating rather than trivial: if the autonomous path regresses and the
 * server tries to prompt, `confirmWithHuman` fails closed and the call reports
 * an error instead of recording a decision. A test that merely asserted
 * "decision recorded" would pass even if elicitation had been deleted outright.
 */
async function decideVia(
  authority: "autonomous" | "human",
  result: AttemptResult,
  decision: "accepted" | "rejected" | "revision-requested" = "accepted",
): Promise<{ output: unknown; decision: CandidateDecisionV2 | null }> {
  const root = await mkdtemp(join(tmpdir(), "decide-authority-"));
  let recorded: CandidateDecisionV2 | null = null;
  let persistedSnapshot: ReviewSnapshot | null = null;
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await start({
      transport: serverTransport,
      recoverStaleRuns: async () => ({ recovered: [], quarantined: [] }),
      pruneRuns: async () => {},
      ps: fakePlatform(),
      decisionAuthority: () => authority,
      storeFactory: () => ({
        readResult: async () => result,
        readManifest: async () => ({
          runId: "decide-authority",
          repoRoot: "/canonical/repo",
          baseCommitOid: candidate.baseCommitOid,
          candidateManifestHash: candidate.manifestHash,
          effectivePolicy: { verificationPolicy: confinedVerification },
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
        decision,
        expectedArtifactHash: candidate.manifestHash,
      },
    });
    await client.close();
    return { output, decision: recorded };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe("decideCandidate honors the configured authority", () => {
  it("auto-accepts a plain `delegate` result carrying its provenance marker", async () => {
    // A plain `delegate` run never enters the pipeline gate: there is no
    // review round to clear or refuse. Its archive records `plainDelegate`
    // provenance at the terminal-archive funnel, and its only other signal is
    // the archived attempt's own status/failure from independent
    // verification, so a clean verified-candidate is autonomy-eligible.
    const plainDelegateResult = {
      ...verifiedResult,
      evidence: { plainDelegate: true },
    } as AttemptResult;
    const advisory = await advisoryFor(plainDelegateResult);

    expect(advisory).toEqual({ warnings: [], verifiedClean: true, unreadable: false });

    const { decision, output } = await decideVia("autonomous", plainDelegateResult);
    expect(decision, JSON.stringify(output)).not.toBeNull();
    expect(decision?.authority).toBe("policy-autonomous");
  });

  it("requires a person when verification ran without OS confinement", async () => {
    // Unconfined verification ran Producer code with the user's authority and
    // could have rewritten the archive itself, so it cannot ground autonomy.
    const plainDelegateResult = {
      ...verifiedResult,
      evidence: { plainDelegate: true },
    } as AttemptResult;
    const previous = confinedVerification;
    confinedVerification = [{ id: "unit", confinement: "none", skipped: false }];
    try {
      expect(await advisoryFor(plainDelegateResult)).toEqual({
        warnings: ["project verification ran without OS confinement on this platform"],
        verifiedClean: false,
        unreadable: false,
      });
      const { decision } = await decideVia("autonomous", plainDelegateResult);
      expect(decision).toBeNull();
    } finally {
      confinedVerification = previous;
    }
  });

  it("requires a person when a plain delegate rewrote its own verification inputs", async () => {
    const changedPaths = [{
      path: "tests/unit.test.ts",
      changeType: "modified",
      mode: "100644",
      contentHash: "a".repeat(40),
    }];
    const touched = {
      ...verifiedResult,
      candidate: {
        ...candidate,
        changedPaths,
        manifestHash: manifestHashOf(changedPaths as never),
      },
      evidence: { plainDelegate: true },
    } as AttemptResult;

    const advisory = await readDecisionAdvisory("decide-authority", {
      ps: fakePlatform(),
      storeFactory: () => ({
        readResult: async () => touched,
        readManifest: async () => ({
          runId: "decide-authority",
          repoRoot: "/canonical/repo",
          baseCommitOid: candidate.baseCommitOid,
          candidateManifestHash: touched.candidate!.manifestHash,
          effectivePolicy: { verificationPolicy: confinedVerification },
        } as unknown as RunManifest),
      }) as never,
    });

    expect(advisory).toEqual({
      warnings: ["the candidate changes verification inputs: tests/unit.test.ts"],
      verifiedClean: false,
      unreadable: false,
    });
  });

  it("fails closed on an archive with neither provenance marker nor gate evidence", async () => {
    // An archive carrying no `plainDelegate` marker and no pipeline evidence
    // proves nothing about how it was produced. Autonomy must key on positive
    // provenance, never on the absence of a pipeline's paperwork.
    const advisory = await advisoryFor(verifiedResult);

    expect(advisory).toEqual({
      warnings: ["the pipeline gate clearance record is missing"],
      verifiedClean: false,
      unreadable: false,
    });
  });

  it("does not double-report a missing clearance record when the gate refused", async () => {
    const advisory = await advisoryFor({
      ...verifiedResult,
      evidence: {
        pipelineGateRefused: { reasons: ["unresolved blocker F-001: blocked"] },
      },
    });

    expect(advisory).toEqual({
      warnings: ["unresolved blocker F-001: blocked"],
      verifiedClean: false,
      unreadable: false,
    });
  });

  it.each([
    ["malformed", {}, "pipeline gate clearance record is malformed"],
    [
      "human-required",
      {
        candidateCommitOid: candidate.candidateCommitOid,
        requiresHumanDecision: true,
      },
      "pipeline gate clearance record requires a human decision",
    ],
    [
      "commit-mismatched",
      {
        candidateCommitOid: "4".repeat(40),
        requiresHumanDecision: false,
      },
      "pipeline gate clearance record does not match the archived candidate commit",
    ],
  ] as const)(
    "fails closed when pipeline-gate evidence is %s",
    async (_case, pipelineGateCleared, expectedWarning) => {
      const advisory = await advisoryFor({
        ...verifiedResult,
        evidence: { pipelineGateCleared },
      });

      expect(advisory).toMatchObject({
        warnings: [expect.stringContaining(expectedWarning)],
        verifiedClean: false,
        unreadable: false,
      });
    },
  );

  it("records a gate-cleared candidate without prompting under the default authority", async () => {
    const { decision, output } = await decideVia("autonomous", gateClearedResult);
    expect(decision, JSON.stringify(output)).not.toBeNull();
    expect(decision?.authority).toBe("policy-autonomous");
  });

  it.each(["rejected", "revision-requested"] as const)(
    "routes a %s verdict on an eligible candidate through a human",
    async verdict => {
      // Eligibility is about the candidate, not the verdict. A rejection of a
      // candidate the runtime found clean is a person overriding the policy, so
      // it must be elicited and recorded as theirs. Attributing it to
      // `policy-autonomous` also tripped the accept-only guard, which made
      // rejecting a clean candidate fail outright.
      const { decision, output } = await decideVia("autonomous", gateClearedResult, verdict);
      expect(decision).toBeNull();
      expect(JSON.stringify(output)).toContain("elicitation");
    },
  );

  it("still demands a human when the authority is human", async () => {
    // Same candidate, same client, only the authority differs — so this is the
    // mutation that proves the branch above is the reason no prompt happened.
    const { decision, output } = await decideVia("human", gateClearedResult);
    expect(decision).toBeNull();
    expect(JSON.stringify(output)).toContain("elicitation");
  });
});
