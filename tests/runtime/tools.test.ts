import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import type { GitResult } from "../../src/git/git-exec.js";
import {
  handleDecideCandidate,
  handleDelegate,
  handleDelegatePipeline,
  handleIntegrateCandidate,
  handleReviewCandidate,
  handleValidateDelegationSpec,
  type HumanDecisionRecord,
  type RunDecision,
  type ToolArtifactStore,
  type ToolDependencies,
} from "../../src/mcp/tools.js";
import type { PipelineResult } from "../../src/pipeline/pipeline-runtime.js";
import type { CheckoutLock, PlatformServices } from "../../src/platform/platform-services.js";
import { getPlatformServices } from "../../src/platform/select-platform.js";
import type { AttemptResult, CandidateArtifact } from "../../src/protocol/attempt-result.js";
import type { DelegationSpec } from "../../src/protocol/delegation-spec.js";
import { PROTOCOL_VERSION } from "../../src/protocol/versions.js";
import type { PipelineActiveMarker } from "../../src/runtime/artifact-store.js";
import {
  reviewSnapshotHash,
  type ReviewSnapshot,
} from "../../src/runtime/review-snapshot.js";
import type { RunManifest } from "../../src/runtime/run-manifest.js";
import { RuntimeError } from "../../src/util/errors.js";

const execFileAsync = promisify(execFile);
const temporaryPaths: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

const changedPaths: CandidateArtifact["changedPaths"] = [{
  path: "src/example.ts",
  changeType: "modified",
  mode: "100644",
  contentHash: "5".repeat(40),
}];

const candidate: CandidateArtifact = {
  baseCommitOid: "1".repeat(40),
  candidateTreeOid: "2".repeat(40),
  candidateCommitOid: "3".repeat(40),
  anchorRef: "refs/claude-architect/candidates/run-tools",
  manifestHash: createHash("sha256").update(JSON.stringify(changedPaths)).digest("hex"),
  changedPaths,
  patch: "redacted archived patch",
};

const result: AttemptResult = {
  resultVersion: "1",
  runId: "run-tools",
  status: "verified-candidate",
  failure: null,
  summary: "verified",
  producerSummary: "done",
  candidate,
  requestedVerification: [],
  executedVerification: [{
    id: "test",
    executable: "npm",
    args: ["test"],
    exitCode: 0,
    timedOut: false,
    durationMs: 1,
    stdoutRef: "logs/test-stdout.log",
    stderrRef: "logs/test-stderr.log",
  }],
  unresolvedIssues: [],
  evidence: { structural: { manifestHash: candidate.manifestHash } },
  logsRef: "logs/producer.log",
  producerId: "fake",
  producerVersion: "1.0.0",
  producerModel: null,
  durationMs: 1,
  sessionId: null,
};

const expectedReviewSnapshot = {
  runId: result.runId,
  baseCommitOid: candidate.baseCommitOid,
  candidateCommitOid: candidate.candidateCommitOid,
  candidateTreeOid: candidate.candidateTreeOid,
  manifestHash: candidate.manifestHash,
  patch: "exact unredacted patch\n",
  changedPaths,
  evidence: result.evidence,
  executedVerification: result.executedVerification,
} satisfies ReviewSnapshot;

const expectedReviewEvidenceHash = reviewSnapshotHash(expectedReviewSnapshot);

const failedSlicedResult: AttemptResult = {
  ...result,
  status: "failed",
  failure: "producer-failure",
  summary: "sliced pipeline failed",
  candidate: null,
};

const unverifiedCandidateResult: AttemptResult = {
  ...result,
  status: "failed",
  failure: "verification-failure",
  summary: "candidate verification failed",
};

const pipelineResult: PipelineResult = {
  runId: "run-tools",
  status: "decision-ready",
  attempt: result,
  rounds: [],
  increments: [],
  slices: [],
  haltedSliceIndex: null,
  verification: null,
  gate: {
    decisionReady: true,
    requiresHumanDecision: false,
    reasons: [],
  },
  finalCandidateCommit: candidate.candidateCommitOid,
};

const manifest = {
  manifestVersion: "1",
  runId: "run-tools",
  repoRoot: "/canonical/repo",
  baseCommitOid: candidate.baseCommitOid,
  candidateManifestHash: candidate.manifestHash,
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
} satisfies RunManifest;

const validSpec: DelegationSpec = {
  specVersion: "1",
  objective: "change one file",
  context: "test",
  writeAllowlist: ["src/**"],
  forbiddenScope: [],
  successCriteria: ["tests pass"],
  verification: [{
    id: "check",
    executable: "node",
    args: ["-e", "process.exit(0)"],
    cwd: ".",
    timeoutMs: 60_000,
    network: "denied",
    expectedExitCodes: [0],
  }],
  executionMode: "edit",
  timeoutMs: 600_000,
  producerPreferences: ["codex"],
  expectedOutput: "candidate-patch",
};

class FakeStore implements ToolArtifactStore {
  decision: RunDecision | null = null;
  pipelineActiveMarker: PipelineActiveMarker | null = null;
  reviewSnapshot: ReviewSnapshot | null = null;

  constructor(
    public storedResult: AttemptResult = result,
    public storedManifest: RunManifest = manifest,
  ) {}

  async readResult(_runId: string): Promise<AttemptResult | null> {
    return this.storedResult;
  }

  async readManifest(_runId: string): Promise<RunManifest | null> {
    return this.storedManifest;
  }

  async writeReviewSnapshot(snapshot: ReviewSnapshot): Promise<void> {
    if (this.reviewSnapshot === null) {
      this.reviewSnapshot = structuredClone(snapshot);
      return;
    }
    if (reviewSnapshotHash(this.reviewSnapshot) === reviewSnapshotHash(snapshot)) return;
    throw new RuntimeError(
      "review snapshot conflict: archived snapshot differs from attempted snapshot",
      { toolError: "review-snapshot-conflict" },
    );
  }

  async readReviewSnapshot(_runId: string): Promise<ReviewSnapshot | null> {
    return this.reviewSnapshot === null ? null : structuredClone(this.reviewSnapshot);
  }

  async writeCandidateDecisionRecord(decision: CandidateDecisionV2): Promise<void> {
    if (this.decision?.decisionVersion === "2"
      && this.decision.authority === decision.authority
      && this.decision.decision === decision.decision
      && this.decision.candidateManifestHash === decision.candidateManifestHash
      && this.decision.evidenceHash === decision.evidenceHash
      && this.decision.policyVersion === decision.policyVersion) return;
    if (this.decision !== null) {
      throw new RuntimeError(
        `candidate decision conflict: recorded ${this.decision.decision}, `
          + `attempted ${decision.decision}`,
        { toolError: "decision-conflict" },
      );
    }
    this.decision = structuredClone(decision);
  }

  async writeHumanDecision(decision: HumanDecisionRecord): Promise<void> {
    if (this.decision?.decisionVersion === "2"
      && this.decision.authority === "human"
      && this.decision.decision === decision.decision
      && this.decision.candidateManifestHash === decision.candidateManifestHash
      && this.decision.evidenceHash === decision.evidenceHash
      && this.decision.policyVersion === decision.policyVersion) return;
    if (this.decision !== null) {
      throw new RuntimeError(
        `candidate decision conflict: recorded ${this.decision.decision}, attempted ${decision.decision}`,
        { toolError: "decision-conflict" },
      );
    }
    this.decision = {
      ...decision,
      decisionVersion: "2",
      authority: "human",
    };
  }

  async readCandidateDecision(_runId: string): Promise<RunDecision | null> {
    return this.decision;
  }

  storedSpecSha256: string | null = null;

  async readRunStartSpecSha256(_runId: string): Promise<string | null> {
    return this.storedSpecSha256;
  }

  async readPipelineActiveMarker(_runId: string): Promise<PipelineActiveMarker | null> {
    return this.pipelineActiveMarker;
  }
}

function legacyAcceptedDecision(recordedAt: string): RunDecision {
  return {
    decisionVersion: "1",
    decision: "accepted",
    authority: "human",
    recordedAt,
  };
}

function fakePlatform(): PlatformServices {
  return {
    os: "darwin",
    canonicalizePath: async input => ({
      input,
      canonical: "/canonical/repo",
      gitCommonDir: "/canonical/repo/.git",
    }),
    acquireCheckoutLock: async checkout => ({
      key: checkout,
      repositoryIdentity: "/canonical/repo/.git",
      release: async () => {},
    }),
  } as PlatformServices;
}

function gitResult(stdout = "", exitCode = 0): GitResult {
  return { stdout, stderr: "", exitCode };
}

function dependencies(
  store = new FakeStore(),
  ps: PlatformServices = fakePlatform(),
): ToolDependencies {
  return {
    ps,
    storeFactory: () => store,
    git: async (_cwd, args) => {
      if (args[0] === "diff") return gitResult("exact unredacted patch\n");
      if (args.includes(`${candidate.anchorRef}^{commit}`)) {
        return gitResult(`${candidate.candidateCommitOid}\n`);
      }
      if (args.includes(`${candidate.candidateCommitOid}^{tree}`)) {
        return gitResult(`${candidate.candidateTreeOid}\n`);
      }
      if (args[0] === "update-ref") return gitResult();
      throw new Error(`unexpected git args: ${args.join(" ")}`);
    },
    runAttempt: async () => result,
    applyCandidateTree: async () => ({
      integration: "applied",
      detail: "candidate tree applied",
    }),
  };
}

describe("handleValidateDelegationSpec", () => {
  it("returns the runtime's canonical digest without starting a run", async () => {
    let attempts = 0;
    const deps = dependencies();
    deps.runAttempt = async () => {
      attempts += 1;
      return result;
    };

    const reordered = {
      expectedOutput: validSpec.expectedOutput,
      producerPreferences: validSpec.producerPreferences,
      timeoutMs: validSpec.timeoutMs,
      executionMode: validSpec.executionMode,
      verification: validSpec.verification,
      successCriteria: validSpec.successCriteria,
      forbiddenScope: validSpec.forbiddenScope,
      writeAllowlist: validSpec.writeAllowlist,
      context: validSpec.context,
      objective: validSpec.objective,
      specVersion: validSpec.specVersion,
    };

    await expect(handleValidateDelegationSpec(validSpec, deps)).resolves.toEqual({
      ok: true,
      specSha256: "75d6bdadedf7b97cbae5bce0b3d401bfb77a6099cf158d6f8fe5b39f3964eb69",
    });
    await expect(handleValidateDelegationSpec(reordered, deps)).resolves.toEqual({
      ok: true,
      specSha256: "75d6bdadedf7b97cbae5bce0b3d401bfb77a6099cf158d6f8fe5b39f3964eb69",
    });
    expect(attempts).toBe(0);
  });

  it("rejects unknown producers before any attempt starts", async () => {
    let attempts = 0;
    const deps = dependencies();
    deps.runAttempt = async () => {
      attempts += 1;
      return result;
    };

    await expect(handleValidateDelegationSpec({
      ...validSpec,
      producerPreferences: ["codex-implementer"],
    }, deps)).resolves.toEqual({
      ok: false,
      error: "invalid-specification",
      validationErrors: [{
        path: "#/producerPreferences/0",
        message: expect.stringContaining("unknown producer id"),
      }],
    });
    expect(attempts).toBe(0);
  });
});

describe.each(["delegate", "delegatePipeline"])("%s spec identity", operation => {
  it("starts work when the expected digest matches", async () => {
    const deps = dependencies();
    deps.runPipeline = async () => pipelineResult;

    const output = operation === "delegate"
      ? await handleDelegate(
        "/repo",
        validSpec,
        deps,
        "full",
        "75d6bdadedf7b97cbae5bce0b3d401bfb77a6099cf158d6f8fe5b39f3964eb69",
      )
      : await handleDelegatePipeline(
        "/repo",
        validSpec,
        deps,
        "full",
        "75d6bdadedf7b97cbae5bce0b3d401bfb77a6099cf158d6f8fe5b39f3964eb69",
      );

    expect(output).toMatchObject({ ok: true });
  });

  it("rejects a different valid spec before touching the checkout or starting work", async () => {
    let checkoutReads = 0;
    let attempts = 0;
    let pipelines = 0;
    const basePlatform = fakePlatform();
    const deps = dependencies();
    deps.ps = {
      ...basePlatform,
      canonicalizePath: async input => {
        checkoutReads += 1;
        return basePlatform.canonicalizePath(input);
      },
    };
    deps.runAttempt = async () => {
      attempts += 1;
      return result;
    };
    deps.runPipeline = async () => {
      pipelines += 1;
      return pipelineResult;
    };

    const output = operation === "delegate"
      ? await handleDelegate("/repo", validSpec, deps, "full", "0".repeat(64))
      : await handleDelegatePipeline("/repo", validSpec, deps, "full", "0".repeat(64));

    expect(output).toEqual({
      ok: false,
      error: "spec-identity-mismatch",
      diagnostic: "the validated Delegation Spec does not match expectedSpecSha256",
    });
    expect({ checkoutReads, attempts, pipelines }).toEqual({
      checkoutReads: 0,
      attempts: 0,
      pipelines: 0,
    });
  });

  it("rejects a malformed expected digest before checkout access", async () => {
    const deps = dependencies();
    deps.ps = {
      ...fakePlatform(),
      canonicalizePath: async () => {
        throw new Error("checkout must not be read");
      },
    };

    const output = operation === "delegate"
      ? await handleDelegate("/repo", validSpec, deps, "full", "not-a-digest")
      : await handleDelegatePipeline("/repo", validSpec, deps, "full", "not-a-digest");

    expect(output).toEqual({
      ok: false,
      error: "spec-identity-unverifiable",
      diagnostic: "expectedSpecSha256 is not a sha-256 digest",
    });
  });
});

type LifecycleOperation = "review" | "decide" | "integrate";

function invokeLifecycle(
  operation: LifecycleOperation,
  checkoutPath: string,
  deps: ToolDependencies,
): Promise<unknown> {
  if (operation === "review") return handleReviewCandidate(checkoutPath, "run-tools", deps);
  if (operation === "decide") {
    return handleDecideCandidate(
      checkoutPath,
      "run-tools",
      "accepted",
      candidate.manifestHash,
      deps,
    );
  }
  return handleIntegrateCandidate(
    checkoutPath,
    "run-tools",
    candidate.manifestHash,
    deps,
  );
}

async function git(cwd: string, args: string[]): Promise<string> {
  const output = await execFileAsync("git", args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "test",
      GIT_AUTHOR_EMAIL: "test@example.invalid",
      GIT_COMMITTER_NAME: "test",
      GIT_COMMITTER_EMAIL: "test@example.invalid",
    },
  });
  return output.stdout.trim();
}

async function createRepository(): Promise<string> {
  const rawRoot = await mkdtemp(join(tmpdir(), "claude-architect-tools-repo-"));
  const repoRoot = await realpath(rawRoot);
  temporaryPaths.push(repoRoot);
  await git(repoRoot, ["init"]);
  await git(repoRoot, ["commit", "--allow-empty", "-m", "base"]);
  return repoRoot;
}

async function createLinkedWorktree(repoRoot: string): Promise<string> {
  const rawParent = await mkdtemp(join(tmpdir(), "claude-architect-tools-worktree-"));
  const parent = await realpath(rawParent);
  temporaryPaths.push(parent);
  const linked = join(parent, "linked");
  await git(repoRoot, ["worktree", "add", "--detach", linked]);
  return realpath(linked);
}

function manifestFor(
  repoRoot: string,
  archivedCandidate: CandidateArtifact = candidate,
): RunManifest {
  return {
    ...manifest,
    repoRoot,
    baseCommitOid: archivedCandidate.baseCommitOid,
    candidateManifestHash: archivedCandidate.manifestHash,
  };
}

describe("handleDelegatePipeline", () => {
  it("validates spec and returns pipeline result with runPipeline called once", async () => {
    const calls: string[] = [];
    const deps = dependencies();
    const injectedRunAttempt = deps.runAttempt;
    deps.runPipeline = async (checkoutPath, spec, pipelineDeps) => {
      calls.push(checkoutPath);
      expect(spec).toEqual(validSpec);
      expect(pipelineDeps.ps).toBe(deps.ps);
      expect(pipelineDeps.verifier).toBeDefined();
      expect(pipelineDeps.registry).toBeDefined();
      expect(pipelineDeps.runAttempt).toBe(injectedRunAttempt);
      return pipelineResult;
    };

    const output = await handleDelegatePipeline("/repo", validSpec, deps);

    expect(output).toEqual({ ok: true, result: pipelineResult });
    expect(calls).toEqual(["/canonical/repo"]);
  });

  it("invalid spec returns error without invoking pipeline", async () => {
    let calls = 0;
    const deps = dependencies();
    deps.runPipeline = async () => {
      calls += 1;
      return pipelineResult;
    };

    const output = await handleDelegatePipeline("/repo", { specVersion: "1" }, deps);

    expect(output).toMatchObject({ ok: false, error: "invalid-specification" });
    expect("validationErrors" in output && output.validationErrors.length).toBeGreaterThan(0);
    expect(calls).toBe(0);
  });

  it("accepts spec as JSON string", async () => {
    const deps = dependencies();
    deps.runPipeline = async () => pipelineResult;

    const output = await handleDelegatePipeline("/repo", JSON.stringify(validSpec), deps);

    expect(output).toEqual({ ok: true, result: pipelineResult });
  });

  it("passes a sliced spec through validation to the pipeline unstripped", async () => {
    const slicedSpec: DelegationSpec = {
      ...validSpec,
      slices: [{
        objective: "slice one",
        context: "test",
        writeAllowlist: ["src/**"],
        forbiddenScope: [],
        successCriteria: ["tests pass"],
        verification: validSpec.verification,
      }],
    };
    const deps = dependencies();
    let seenSlices: unknown;
    deps.runPipeline = async (_checkout, spec) => {
      seenSlices = (spec as DelegationSpec).slices;
      return pipelineResult;
    };

    const output = await handleDelegatePipeline("/repo", slicedSpec, deps);

    expect(output).toMatchObject({ ok: true });
    expect(Array.isArray(seenSlices)).toBe(true);
    expect((seenSlices as Array<{ objective: string }>)[0]).toMatchObject({ objective: "slice one" });
  });

  it("forwards the caller's abort signal into pipeline dependencies", async () => {
    // Without this the runtime cannot be cancelled at all: every layer below
    // already honors an AbortSignal, but nothing ever supplied one.
    const controller = new AbortController();
    const deps = dependencies();
    deps.abortSignal = controller.signal;
    let seenSignal: AbortSignal | undefined;
    deps.runPipeline = async (_checkout, _spec, pipelineDeps) => {
      seenSignal = pipelineDeps.abortSignal;
      return pipelineResult;
    };

    await handleDelegatePipeline("/repo", validSpec, deps);

    expect(seenSignal).toBe(controller.signal);
  });
});

describe("MCP tool handlers", () => {
  it("returns repairable validation errors without touching a producer", async () => {
    let attempted = false;
    const deps = dependencies();
    deps.runAttempt = async () => {
      attempted = true;
      return result;
    };

    const output = await handleDelegate("/repo", { specVersion: "1" }, deps);

    expect(output).toMatchObject({ ok: false });
    expect("validationErrors" in output && output.validationErrors.length).toBeGreaterThan(0);
    expect(attempted).toBe(false);
  });

  // A producer id that names no adapter used to pass validation and surface much
  // later as `unavailable / no-eligible-producer`, which reads as "Codex is not
  // installed" rather than "you wrote an agent name where a producer id goes".
  // Observed in the field: producerPreferences ["codex-implementer"].
  it("rejects an unknown producer id as a spec defect before dispatch", async () => {
    let attempted = false;
    const deps = dependencies();
    deps.runAttempt = async () => {
      attempted = true;
      return result;
    };

    const output = await handleDelegate(
      "/repo",
      { ...validSpec, producerPreferences: ["codex-implementer"] },
      deps,
    );

    expect(output).toMatchObject({ ok: false, error: "invalid-specification" });
    expect("validationErrors" in output && output.validationErrors).toEqual([
      expect.objectContaining({ path: "#/producerPreferences/0" }),
    ]);
    expect(
      "validationErrors" in output && output.validationErrors[0]?.message,
    ).toMatch(/codex/u);
    expect(attempted).toBe(false);
  });

  it("accepts every producer id the registry actually ships", async () => {
    const deps = dependencies();
    deps.runAttempt = async () => result;

    const output = await handleDelegate(
      "/repo",
      { ...validSpec, producerPreferences: ["codex", "opencode", "pi", "pythinker", "agy", "claude"] },
      deps,
    );

    expect(output).not.toMatchObject({ ok: false, error: "invalid-specification" });
  });

  it("accepts a JSON-encoded string spec from schemaless MCP clients", async () => {
    const calls: string[] = [];
    const deps = dependencies();
    deps.runAttempt = async (checkoutPath, spec) => {
      calls.push(checkoutPath);
      expect(spec).toEqual(validSpec);
      return result;
    };

    const output = await handleDelegate("/repo", JSON.stringify(validSpec), deps);

    expect(output).toEqual({ ok: true, result });
    expect(calls).toEqual(["/canonical/repo"]);
  });

  it("reports a repairable error for a string spec that is not valid JSON", async () => {
    let attempted = false;
    const deps = dependencies();
    deps.runAttempt = async () => {
      attempted = true;
      return result;
    };

    const output = await handleDelegate("/repo", "{not json", deps);

    expect(output).toMatchObject({ ok: false, error: "invalid-specification" });
    expect(attempted).toBe(false);
  });

  it("bounds repository-sized ignored-path evidence on the returned result", async () => {
    const deps = dependencies();
    const bigResult = {
      ...result,
      evidence: { ...result.evidence, ignoredPaths: Array.from({ length: 500 }, (_, i) => `node_modules/pkg-${i}`) },
    };
    deps.runAttempt = async () => bigResult;

    const output = await handleDelegate("/repo", validSpec, deps);

    expect(output.ok).toBe(true);
    const evidence = (output as { result: { evidence: Record<string, unknown> } }).result.evidence;
    expect((evidence.ignoredPaths as string[]).length).toBe(50);
    expect(evidence.ignoredPathsOmitted).toBe(450);
    expect(bigResult.evidence.ignoredPaths.length).toBe(500); // archived copy untouched
  });

  it("rejects a review whose run was started from a different spec", async () => {
    // A delegation lane reports its own runId and echoes back the specSha256 it
    // was handed, so both are claims by the party under review. Naming a
    // different real run returns a clean candidate for work nobody asked for.
    const store = new FakeStore();
    store.storedSpecSha256 = "a".repeat(64);
    const output = await handleReviewCandidate("/repo", "run-tools", dependencies(store), "b".repeat(64));
    expect(output).toMatchObject({ ok: false, error: "run-spec-mismatch" });
  });

  it("accepts a review whose run records the dispatched spec", async () => {
    const store = new FakeStore();
    store.storedSpecSha256 = "a".repeat(64);
    const output = await handleReviewCandidate("/repo", "run-tools", dependencies(store), "a".repeat(64));
    expect(output).toMatchObject({ manifestHash: candidate.manifestHash });
  });

  it("fails closed when correspondence was requested but nothing was recorded", async () => {
    // Answering "verified" by omission is the one outcome that must not happen:
    // the caller asked for proof precisely because it does not trust the claim.
    const store = new FakeStore();
    store.storedSpecSha256 = null;
    const output = await handleReviewCandidate("/repo", "run-tools", dependencies(store), "a".repeat(64));
    expect(output).toMatchObject({ ok: false, error: "run-spec-unverifiable" });
  });

  it("reviews without correspondence when the caller supplies no spec hash", async () => {
    const store = new FakeStore();
    store.storedSpecSha256 = null;
    const output = await handleReviewCandidate("/repo", "run-tools", dependencies(store));
    expect(output).toMatchObject({ manifestHash: candidate.manifestHash });
  });

  it("returns only the correlation envelope in lane response mode", async () => {
    // A lane has no filesystem tools by design. A full result can exceed the
    // host's inline-response limit, and the host then offloads it to a file the
    // lane cannot open — so the lane reported nothing and its controller
    // re-dispatched, duplicating the entire attempt.
    const deps = dependencies();
    const bigResult = {
      ...result,
      evidence: {
        ...result.evidence,
        ignoredPaths: Array.from({ length: 5000 }, (_, i) => `node_modules/pkg-${i}`),
      },
    };
    deps.runAttempt = async () => bigResult;

    const output = await handleDelegate("/repo", validSpec, deps, "lane");

    expect(output).toEqual({
      ok: true,
      result: {
        runId: "run-tools",
        status: "verified-candidate",
        producerId: "fake",
        manifestHash: candidate.manifestHash,
        failure: null,
        durationMs: 1,
      },
    });
    // Exactly the lane's contract, and nothing that could grow without bound.
    expect(JSON.stringify(output).length).toBeLessThan(1_000);
  });

  it("defaults to the full result so existing callers are unchanged", async () => {
    const output = await handleDelegate("/repo", validSpec, dependencies());
    expect(output).toMatchObject({ ok: true, result: { evidence: expect.any(Object) } });
  });

  it("bounds ignored-path evidence on the pipeline result too", async () => {
    // The cap is applied to `value.evidence`, but a pipeline's evidence lives at
    // `result.attempt.evidence`, so this path returned it unbounded. Measured on
    // a real run: 2026 entries, 162 KB — 68% of a 238 KB response, all of it
    // node_modules paths.
    const deps = dependencies();
    const bigAttempt = {
      ...result,
      evidence: {
        ...result.evidence,
        ignoredPaths: Array.from({ length: 500 }, (_, i) => `node_modules/pkg-${i}`),
      },
    };
    deps.runPipeline = async () => ({
      runId: "run-tools",
      status: "decision-ready",
      attempt: bigAttempt,
      increments: [],
      slices: [],
      haltedSliceIndex: null,
      rounds: [],
      verification: null,
      gate: { decisionReady: true, requiresHumanDecision: false, reasons: [] },
      finalCandidateCommit: "c".repeat(40),
      failure: null,
    }) as never;

    const output = await handleDelegatePipeline("/repo", validSpec, deps);

    expect(output.ok).toBe(true);
    const evidence = (output as {
      result: { attempt: { evidence: Record<string, unknown> } };
    }).result.attempt.evidence;
    expect((evidence.ignoredPaths as string[]).length).toBe(50);
    expect(evidence.ignoredPathsOmitted).toBe(450);
    expect(bigAttempt.evidence.ignoredPaths.length).toBe(500); // archived copy untouched
  });

  it("forwards host progress reporting into the attempt dependencies", async () => {
    const phases: string[] = [];
    const deps = dependencies();
    deps.onProgress = message => phases.push(message);
    deps.runAttempt = async (_checkout, _spec, attemptDeps) => {
      attemptDeps.onPhase?.("probing producers");
      return result;
    };

    await handleDelegate("/repo", validSpec, deps);

    expect(phases).toEqual(["probing producers"]);
  });

  it("forwards the caller's abort signal into the attempt dependencies", async () => {
    const controller = new AbortController();
    const deps = dependencies();
    deps.abortSignal = controller.signal;
    let seenSignal: AbortSignal | undefined;
    deps.runAttempt = async (_checkout, _spec, attemptDeps) => {
      seenSignal = attemptDeps.abortSignal;
      return result;
    };

    await handleDelegate("/repo", validSpec, deps);

    expect(seenSignal).toBe(controller.signal);
  });

  it("warns the caller when the delegation runs a stale published bundle", async () => {
    const phases: string[] = [];
    const deps = dependencies();
    let warnedBeforeAttempt = false;
    deps.onProgress = message => phases.push(message);
    deps.checkLiveBundle = async () => ({
      selfHosted: true,
      runningVersion: "0.27.0",
      repositoryVersion: "0.29.0",
      bundleMatches: false,
      stale: true,
    });
    deps.runAttempt = async () => {
      warnedBeforeAttempt = phases.length === 1;
      return result;
    };

    const output = await handleDelegate("/repo", validSpec, deps);

    expect(output.ok).toBe(true);
    expect(phases[0]).toContain("stale-live-bundle");
    expect(warnedBeforeAttempt).toBe(true);
  });

  it("stays silent when the running bundle matches the checkout", async () => {
    const phases: string[] = [];
    const deps = dependencies();
    deps.onProgress = message => phases.push(message);
    deps.checkLiveBundle = async () => ({
      selfHosted: true,
      runningVersion: "0.29.0",
      repositoryVersion: "0.29.0",
      bundleMatches: true,
      stale: false,
    });
    deps.runAttempt = async () => result;

    await handleDelegate("/repo", validSpec, deps);

    expect(phases).toEqual([]);
  });

  it("names allowlist consumers the Producer could not repair", async () => {
    const phases: string[] = [];
    const deps = dependencies();
    deps.onProgress = message => phases.push(message);
    deps.checkAllowlistSufficiency = async () => ({
      allowlisted: 2,
      gaps: [{ path: "tests/runtime/e2e-pipeline.test.ts", imports: ["src/mcp/tools.ts"] }],
      omitted: 0,
    });
    deps.runAttempt = async () => result;

    const output = await handleDelegate("/repo", validSpec, deps);

    expect(output.ok).toBe(true);
    expect(phases.join("\n")).toContain("allowlist-consumers");
    expect(phases.join("\n")).toContain("tests/runtime/e2e-pipeline.test.ts");
  });

  it("never fails a delegation because the allowlist analysis threw", async () => {
    const deps = dependencies();
    deps.checkAllowlistSufficiency = async () => {
      throw new Error("ls-files exploded");
    };
    deps.runAttempt = async () => result;

    await expect(handleDelegate("/repo", validSpec, deps)).resolves.toMatchObject({ ok: true });
  });

  it("never fails a delegation because the staleness probe threw", async () => {
    const deps = dependencies();
    deps.checkLiveBundle = async () => {
      throw new Error("unreadable manifest");
    };
    deps.runAttempt = async () => result;

    const output = await handleDelegate("/repo", validSpec, deps);

    expect(output.ok).toBe(true);
  });

  it("returns an actionable protocol mismatch without touching a producer", async () => {
    let attempted = false;
    const deps = dependencies();
    deps.skillProtocolVersion = "0.9.0";
    deps.runAttempt = async () => {
      attempted = true;
      return result;
    };

    const output = await handleDelegate("/repo", validSpec, deps);

    expect(output).toEqual({
      ok: false,
      diagnostic: `protocol version mismatch: skill declares 0.9.0, runtime expects ${PROTOCOL_VERSION}`,
    });
    expect(attempted).toBe(false);
  });

  it("canonicalizes and serializes a valid delegation before running it", async () => {
    const calls: string[] = [];
    const deps = dependencies();
    deps.runAttempt = async (checkoutPath, spec, attemptDeps) => {
      calls.push(checkoutPath);
      expect(spec).toEqual(validSpec);
      expect(attemptDeps.ps).toBe(deps.ps);
      expect(attemptDeps.verifier).toBeDefined();
      return result;
    };

    const output = await handleDelegate("/repo", validSpec, deps);

    expect(output).toEqual({ ok: true, result });
    expect(calls).toEqual(["/canonical/repo"]);
  });

  it("binds every candidate lifecycle tool to the archived repository and accepts its linked worktree", async () => {
    const repoRoot = await createRepository();
    const linkedWorktree = await createLinkedWorktree(repoRoot);
    const store = new FakeStore(result, manifestFor(repoRoot));
    const deps = {
      ...dependencies(store, getPlatformServices()),
      decisionProvenance: "human-elicitation" as const,
    };

    for (const checkoutPath of [repoRoot, linkedWorktree]) {
      await expect(handleReviewCandidate(checkoutPath, "run-tools", deps)).resolves.toMatchObject({
        patch: "exact unredacted patch\n",
      });
      await expect(handleDecideCandidate(
        checkoutPath,
        "run-tools",
        "accepted",
        candidate.manifestHash,
        deps,
      )).resolves.toEqual({ recorded: true });
      await expect(handleIntegrateCandidate(
        checkoutPath,
        "run-tools",
        candidate.manifestHash,
        deps,
      )).resolves.toEqual({ integration: "applied", detail: "candidate tree applied" });
    }
  });

  // Before provenance, decision.json was {decision, recordedAt}: an agent's
  // acceptance and a human's were indistinguishable even after the fact, so the
  // human-only invariant was not merely unenforced but unauditable.
  it("records how a decision was obtained and which candidate it binds to", async () => {
    const repoRoot = await createRepository();
    const store = new FakeStore(result, manifestFor(repoRoot));
    const deps = dependencies(store, getPlatformServices());

    await expect(handleDecideCandidate(repoRoot, "run-tools", "accepted", candidate.manifestHash, deps))
      .resolves.toEqual({ recorded: true });

    const recorded = await store.readCandidateDecision("run-tools");
    expect(recorded).toMatchObject({
      decision: "accepted",
      authority: "caller-asserted",
      candidateManifestHash: candidate.manifestHash,
    });
  });

  it("marks a decision the runtime obtained from a human as such", async () => {
    const repoRoot = await createRepository();
    const store = new FakeStore(result, manifestFor(repoRoot));
    const deps = {
      ...dependencies(store, getPlatformServices()),
      decisionProvenance: "human-elicitation" as const,
    };

    await handleDecideCandidate(repoRoot, "run-tools", "accepted", candidate.manifestHash, deps);

    expect(await store.readCandidateDecision("run-tools"))
      .toMatchObject({ authority: "human" });
  });

  it("refuses to spend an acceptance on a different artifact", async () => {
    const repoRoot = await createRepository();
    const store = new FakeStore(result, manifestFor(repoRoot));
    const deps = {
      ...dependencies(store, getPlatformServices()),
      decisionProvenance: "human-elicitation" as const,
    };
    await handleDecideCandidate(repoRoot, "run-tools", "accepted", candidate.manifestHash, deps);

    await expect(handleIntegrateCandidate(repoRoot, "run-tools", "f".repeat(64), deps))
      .resolves.toEqual({ integration: "aborted", detail: "decision-artifact-mismatch" });
  });

  // `undefined` is a record written before provenance existed and
  // `caller-asserted` is one the runtime never confirmed; in both the runtime
  // does not know how the decision was reached. `policy-autonomous` is the
  // opposite: the runtime knows exactly how, and it met every objective
  // condition, so it integrates — see the case below.
  it.each([
    "unknown",
    "caller-asserted",
  ] as const)("refuses integration on unknown acceptance provenance (%s)", async authority => {
    const repoRoot = await createRepository();
    const store = new FakeStore(result, manifestFor(repoRoot));
    store.decision = {
      decisionVersion: "1",
      decision: "accepted",
      authority,
      recordedAt: "2026-07-27T00:00:00.000Z",
      candidateManifestHash: candidate.manifestHash,
    };
    let integrationCalls = 0;
    const deps = dependencies(store, getPlatformServices());
    deps.applyCandidateTree = async () => {
      integrationCalls += 1;
      return { integration: "applied", detail: "candidate tree applied" };
    };

    await expect(handleIntegrateCandidate(
      repoRoot,
      "run-tools",
      candidate.manifestHash,
      deps,
    )).resolves.toEqual({
      integration: "aborted",
      detail: "accepted-decision-not-confirmed",
    });
    expect(integrationCalls).toBe(0);
  });

  it("integrates an acceptance recorded by the autonomous decision authority", async () => {
    // The mirror of the refusals above. Demanding `human-elicitation` here would
    // make an autonomous acceptance unspendable, reintroducing the prompt that
    // authority exists to remove.
    const repoRoot = await createRepository();
    const store = new FakeStore(result, manifestFor(repoRoot));
    store.decision = {
      decisionVersion: "1",
      decision: "accepted",
      authority: "policy-autonomous",
      recordedAt: "2026-07-27T00:00:00.000Z",
      candidateManifestHash: candidate.manifestHash,
    };
    let integrationCalls = 0;
    const deps = dependencies(store, getPlatformServices());
    deps.applyCandidateTree = async () => {
      integrationCalls += 1;
      return { integration: "applied", detail: "candidate tree applied" };
    };

    await expect(handleIntegrateCandidate(
      repoRoot,
      "run-tools",
      candidate.manifestHash,
      deps,
    )).resolves.toEqual({ integration: "applied", detail: "candidate tree applied" });
    expect(integrationCalls).toBe(1);
  });

  it("returns the manifest hash integration requires", async () => {
    const repoRoot = await createRepository();
    const store = new FakeStore(result, manifestFor(repoRoot));
    const deps = dependencies(store, getPlatformServices());

    await expect(handleReviewCandidate(repoRoot, "run-tools", deps))
      .resolves.toMatchObject({ manifestHash: candidate.manifestHash });
  });

  it("rejects cross-project lifecycle authority and preserves the candidate anchor", async () => {
    const repoA = await createRepository();
    const repoB = await createRepository();
    const commitOid = await git(repoA, ["rev-parse", "HEAD"]);
    const treeOid = await git(repoA, ["rev-parse", "HEAD^{tree}"]);
    const archivedCandidate: CandidateArtifact = {
      ...candidate,
      baseCommitOid: commitOid,
      candidateCommitOid: commitOid,
      candidateTreeOid: treeOid,
      anchorRef: "refs/claude-architect/candidates/run-cross-project",
    };
    const archivedResult: AttemptResult = {
      ...result,
      candidate: archivedCandidate,
    };
    await git(repoA, ["update-ref", archivedCandidate.anchorRef, commitOid]);
    const store = new FakeStore(archivedResult, manifestFor(repoA, archivedCandidate));
    const deps = dependencies(store, getPlatformServices());
    const mismatch = {
      ok: false,
      error: "run-checkout-mismatch",
      diagnostic: "candidate run belongs to a different repository than the supplied checkoutPath",
    };

    await expect(handleReviewCandidate(repoB, "run-tools", deps)).resolves.toEqual(mismatch);
    await expect(handleDecideCandidate(
      repoB,
      "run-tools",
      "rejected",
      archivedCandidate.manifestHash,
      deps,
    )).resolves.toEqual(mismatch);
    await expect(handleIntegrateCandidate(
      repoB,
      "run-tools",
      archivedCandidate.manifestHash,
      deps,
    )).resolves.toEqual(mismatch);

    await expect(git(repoA, ["rev-parse", archivedCandidate.anchorRef])).resolves.toBe(commitOid);
    expect(store.decision).toBeNull();
  });

  it.each(["review", "decide", "integrate"] as const)(
    "reloads failed sliced authority after a queued %s acquires the checkout file lease",
    async operation => {
      const repoRoot = await createRepository();
      const platformServices = getPlatformServices();
      const store = new FakeStore(result, manifestFor(repoRoot));
      if (operation === "integrate") {
        store.decision = legacyAcceptedDecision("2026-07-19T00:00:00.000Z");
      }
      let markAcquiring!: () => void;
      const acquisitionStarted = new Promise<void>(resolve => { markAcquiring = resolve; });
      let acquireCalls = 0;
      let releaseCalls = 0;
      const ps = Object.assign(Object.create(platformServices), {
        async acquireCheckoutLock(checkout: string): Promise<CheckoutLock> {
          acquireCalls += 1;
          markAcquiring();
          const lock = await platformServices.acquireCheckoutLock(checkout);
          return {
            ...lock,
            async release() {
              releaseCalls += 1;
              await lock.release();
            },
          };
        },
      }) as PlatformServices;
      const deps = dependencies(store, ps);
      let gitCalls = 0;
      let integrationCalls = 0;
      const originalGit = deps.git!;
      deps.git = async (cwd, args, indexFile) => {
        gitCalls += 1;
        return originalGit(cwd, args, indexFile);
      };
      deps.applyCandidateTree = async () => {
        integrationCalls += 1;
        return { integration: "applied", detail: "candidate tree applied" };
      };
      const heldLock = await platformServices.acquireCheckoutLock(repoRoot);
      const pending = invokeLifecycle(operation, repoRoot, deps);
      const first = await Promise.race([
        acquisitionStarted.then(() => "acquiring" as const),
        pending.then(() => "settled" as const),
      ]);
      store.storedResult = failedSlicedResult;
      await heldLock.release();
      const output = await pending;

      expect.soft(first).toBe("acquiring");
      expect.soft(output).toEqual(operation === "review"
        ? {
          ok: false,
          error: "candidate-not-found",
          diagnostic: "archived run has no candidate",
        }
        : {
          ok: false,
          error: "candidate-not-verified",
          diagnostic: "candidate did not complete independent verification",
        });
      expect.soft(acquireCalls).toBe(1);
      expect.soft(releaseCalls).toBe(1);
      expect.soft(gitCalls).toBe(0);
      expect.soft(integrationCalls).toBe(0);
      if (operation === "decide") expect.soft(store.decision).toBeNull();
    },
  );

  it.each(["review", "decide", "integrate"] as const)(
    "rejects %s caller identity drift before loading archive authority",
    async operation => {
      const callerIdentity = "/canonical/repo-a/.git";
      const acquisitionIdentity = "/canonical/repo-b/.git";
      const store = new FakeStore();
      if (operation === "integrate") {
        store.decision = legacyAcceptedDecision("2026-07-19T00:00:00.000Z");
      }
      let acquireCalls = 0;
      let releaseCalls = 0;
      let storeFactoryCalls = 0;
      const ps = {
        ...fakePlatform(),
        canonicalizePath: async (input: string) => ({
          input,
          canonical: "/canonical/repo-a",
          gitCommonDir: callerIdentity,
        }),
        acquireCheckoutLock: async (): Promise<CheckoutLock> => {
          acquireCalls += 1;
          return {
            key: "acquisition-lock",
            repositoryIdentity: acquisitionIdentity,
            async release() { releaseCalls += 1; },
          };
        },
      } as PlatformServices;
      const deps = dependencies(store, ps);
      deps.storeFactory = () => {
        storeFactoryCalls += 1;
        return store;
      };
      let gitCalls = 0;
      let integrationCalls = 0;
      const originalGit = deps.git!;
      deps.git = async (cwd, args, indexFile) => {
        gitCalls += 1;
        return originalGit(cwd, args, indexFile);
      };
      deps.applyCandidateTree = async () => {
        integrationCalls += 1;
        return { integration: "applied", detail: "candidate tree applied" };
      };

      const output = await invokeLifecycle(operation, "/supplied/repo-a", deps);

      expect.soft(output).toEqual({
        ok: false,
        error: "run-checkout-mismatch",
        diagnostic: "supplied checkout repository identity changed before checkout lease acquisition",
      });
      expect.soft(acquireCalls).toBe(1);
      expect.soft(releaseCalls).toBe(1);
      expect.soft(storeFactoryCalls).toBe(0);
      expect.soft(gitCalls).toBe(0);
      expect.soft(integrationCalls).toBe(0);
      if (operation === "decide") expect.soft(store.decision).toBeNull();
    },
  );

  it("holds the checkout file lock while recording a decision and releases it afterwards", async () => {
    const repoRoot = await createRepository();
    const ps = getPlatformServices();
    const store = new FakeStore(result, manifestFor(repoRoot));
    let markEntered!: () => void;
    let allowWrite!: () => void;
    const entered = new Promise<void>(resolve => { markEntered = resolve; });
    const writeAllowed = new Promise<void>(resolve => { allowWrite = resolve; });
    store.writeCandidateDecisionRecord = async record => {
      markEntered();
      await writeAllowed;
      store.decision = structuredClone(record);
    };
    const pending = handleDecideCandidate(
      repoRoot,
      "run-tools",
      "accepted",
      candidate.manifestHash,
      dependencies(store, ps),
    );
    await entered;

    await expect(ps.acquireCheckoutLock(repoRoot)).rejects.toThrow(/checkout is locked/u);
    allowWrite();
    await expect(pending).resolves.toEqual({ recorded: true });

    const subsequent = await ps.acquireCheckoutLock(repoRoot);
    await subsequent.release();
  });

  it("holds the checkout file lock while deleting a rejected candidate anchor", async () => {
    const repoRoot = await createRepository();
    const ps = getPlatformServices();
    const store = new FakeStore(result, manifestFor(repoRoot));
    let markDeleting!: () => void;
    let allowDelete!: () => void;
    const deleting = new Promise<void>(resolve => { markDeleting = resolve; });
    const deleteAllowed = new Promise<void>(resolve => { allowDelete = resolve; });
    const deps = dependencies(store, ps);
    const originalGit = deps.git!;
    deps.git = async (cwd, args, indexFile) => {
      if (args[0] === "update-ref") {
        markDeleting();
        await deleteAllowed;
        return gitResult();
      }
      return originalGit(cwd, args, indexFile);
    };
    const pending = handleDecideCandidate(
      repoRoot,
      "run-tools",
      "rejected",
      candidate.manifestHash,
      deps,
    );
    await deleting;

    await expect(ps.acquireCheckoutLock(repoRoot)).rejects.toThrow(/checkout is locked/u);
    allowDelete();
    await expect(pending).resolves.toEqual({ recorded: true });

    const subsequent = await ps.acquireCheckoutLock(repoRoot);
    await subsequent.release();
  });

  it("records decisions idempotently and rejects a contradictory decision", async () => {
    const store = new FakeStore();
    const deps = { ...dependencies(store), decisionProvenance: "human-elicitation" as const };
    const recordedAt = [
      new Date("2026-07-18T12:00:00.000Z"),
      new Date("2026-07-18T12:01:00.000Z"),
      new Date("2026-07-18T12:02:00.000Z"),
    ];
    deps.now = () => recordedAt.shift()!;

    await expect(handleDecideCandidate(
      "/canonical/repo",
      "run-tools",
      "accepted",
      candidate.manifestHash,
      deps,
    )).resolves.toEqual({ recorded: true });
    await expect(handleDecideCandidate(
      "/canonical/repo",
      "run-tools",
      "accepted",
      candidate.manifestHash,
      deps,
    )).resolves.toEqual({ recorded: true });
    expect(store.decision).toEqual({
      decisionVersion: "2",
      decision: "accepted",
      authority: "human",
      candidateManifestHash: candidate.manifestHash,
      evidenceHash: expectedReviewEvidenceHash,
      policyVersion: "1",
      recordedAt: "2026-07-18T12:00:00.000Z",
    });

    await expect(handleDecideCandidate(
      "/canonical/repo",
      "run-tools",
      "revision-requested",
      candidate.manifestHash,
      deps,
    )).resolves.toEqual({
      ok: false,
      error: "decision-conflict",
      diagnostic: "candidate decision conflict: recorded accepted, attempted revision-requested",
    });
    expect(store.decision).toEqual({
      decisionVersion: "2",
      decision: "accepted",
      authority: "human",
      candidateManifestHash: candidate.manifestHash,
      evidenceHash: expectedReviewEvidenceHash,
      policyVersion: "1",
      recordedAt: "2026-07-18T12:00:00.000Z",
    });
  });

  it("rejects same-decision idempotence when the regenerated evidence hash differs", async () => {
    const store = new FakeStore();
    store.decision = {
      decisionVersion: "2",
      decision: "accepted",
      authority: "human",
      candidateManifestHash: candidate.manifestHash,
      evidenceHash: "0".repeat(64),
      policyVersion: "1",
      recordedAt: "2026-07-18T12:00:00.000Z",
    };
    const deps = dependencies(store);
    let gitCalls = 0;
    const originalGit = deps.git!;
    deps.git = async (cwd, args, indexFile) => {
      gitCalls += 1;
      return originalGit(cwd, args, indexFile);
    };

    await expect(handleDecideCandidate(
      "/canonical/repo",
      "run-tools",
      "accepted",
      candidate.manifestHash,
      deps,
    )).resolves.toEqual({
      ok: false,
      error: "decision-conflict",
      diagnostic: "candidate decision conflict: recorded accepted, attempted accepted",
    });
    expect(gitCalls).toBe(3);
    expect(store.decision).toMatchObject({ evidenceHash: "0".repeat(64) });
  });

  it("rejects an artifact hash mismatch without regenerating or recording a decision", async () => {
    const store = new FakeStore();
    const deps = dependencies(store);
    let gitCalls = 0;
    deps.git = async () => {
      gitCalls += 1;
      return gitResult();
    };

    await expect(handleDecideCandidate(
      "/canonical/repo",
      "run-tools",
      "accepted",
      "f".repeat(64),
      deps,
    )).resolves.toEqual({
      ok: false,
      error: "artifact-hash-mismatch",
      diagnostic: "expected artifact hash does not match archived candidate manifest hash",
    });
    expect(store.decision).toBeNull();
    expect(gitCalls).toBe(0);
  });

  it("classifies an unverified archived run before checking its artifact hash", async () => {
    const store = new FakeStore(failedSlicedResult);
    const deps = dependencies(store);
    let gitCalls = 0;
    deps.git = async () => {
      gitCalls += 1;
      return gitResult();
    };

    await expect(handleDecideCandidate(
      "/canonical/repo",
      "run-tools",
      "accepted",
      "f".repeat(64),
      deps,
    )).resolves.toEqual({
      ok: false,
      error: "candidate-not-verified",
      diagnostic: "candidate did not complete independent verification",
    });
    expect(store.decision).toBeNull();
    expect(gitCalls).toBe(0);
  });

  it.each(["rejected", "revision-requested"] as const)(
    "records an evidence-bound %s decision for an unverified candidate",
    async decision => {
      const store = new FakeStore(unverifiedCandidateResult);

      await expect(handleDecideCandidate(
        "/canonical/repo",
        "run-tools",
        decision,
        candidate.manifestHash,
        { ...dependencies(store), decisionProvenance: "human-elicitation" as const },
      )).resolves.toEqual({ recorded: true });
      expect(store.decision).toMatchObject({
        decisionVersion: "2",
        decision,
        authority: "human",
        candidateManifestHash: candidate.manifestHash,
        evidenceHash: expectedReviewEvidenceHash,
        policyVersion: "1",
      });
    },
  );

  it("regenerates an unredacted review patch from the anchored tree", async () => {
    const store = new FakeStore();
    const deps = dependencies(store);
    const gitCalls: string[][] = [];
    const originalGit = deps.git!;
    deps.git = async (cwd, args, indexFile) => {
      gitCalls.push(args);
      return originalGit(cwd, args, indexFile);
    };
    const output = await handleReviewCandidate("/canonical/repo", "run-tools", deps);

    expect(output).toEqual({
      runId: result.runId,
      baseCommitOid: candidate.baseCommitOid,
      candidateCommitOid: candidate.candidateCommitOid,
      candidateTreeOid: candidate.candidateTreeOid,
      manifestHash: candidate.manifestHash,
      patch: "exact unredacted patch\n",
      changedPaths: candidate.changedPaths,
      evidence: result.evidence,
      executedVerification: result.executedVerification,
    });
    expect(store.reviewSnapshot).toEqual(expectedReviewSnapshot);
    expect(JSON.stringify(output)).toBe(JSON.stringify(store.reviewSnapshot));
    expect(gitCalls.at(-1)).toEqual([
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      "--binary",
      "--full-index",
      candidate.baseCommitOid,
      candidate.candidateTreeOid,
      "--",
    ]);
  });

  it("fails closed when persisted review snapshot bytes differ from regeneration", async () => {
    const store = new FakeStore();
    // Hoist `evidence` to the first key so the serialized bytes differ from
    // expectedReviewSnapshot while the canonical, key-order-independent hash
    // stays equal — exactly the archive inconsistency the tool must catch. The
    // values are unchanged (same evidence reference), only their insertion order.
    store.reviewSnapshot = {
      evidence: expectedReviewSnapshot.evidence,
      ...expectedReviewSnapshot,
    };
    expect(reviewSnapshotHash(store.reviewSnapshot)).toBe(
      reviewSnapshotHash(expectedReviewSnapshot),
    );
    expect(JSON.stringify(store.reviewSnapshot)).not.toBe(JSON.stringify(expectedReviewSnapshot));

    await expect(handleReviewCandidate(
      "/canonical/repo",
      "run-tools",
      dependencies(store),
    )).resolves.toEqual({
      ok: false,
      error: "archive-inconsistent",
      diagnostic: "persisted review snapshot does not match the regenerated snapshot",
    });
  }, 30_000);

  it("fails closed when an exact review patch exceeds the Git capture bound", async () => {
    const deps = dependencies();
    const originalGit = deps.git!;
    deps.git = async (cwd, args, indexFile) => {
      const output = await originalGit(cwd, args, indexFile);
      return args[0] === "diff"
        ? { ...output, truncated: { stdout: true, stderr: false } }
        : output;
    };

    await expect(handleReviewCandidate("/canonical/repo", "run-tools", deps)).resolves.toEqual({
      ok: false,
      error: "candidate-review-failed",
      diagnostic: "failed to regenerate candidate patch",
    });
  });

  it("persists decisions and gates integration on the latest accepted decision", async () => {
    const store = new FakeStore();
    const deps = {
      ...dependencies(store),
      decisionProvenance: "human-elicitation" as const,
    };
    let integrationCalls = 0;
    deps.applyCandidateTree = async args => {
      integrationCalls += 1;
      expect(args).toMatchObject({
        repoRoot: "/canonical/repo",
        artifact: candidate,
        expectedArtifactHash: candidate.manifestHash,
      });
      return { integration: "applied", detail: "candidate tree applied" };
    };

    await expect(handleIntegrateCandidate(
      "/canonical/repo",
      "run-tools",
      candidate.manifestHash,
      deps,
    )).resolves.toEqual({ integration: "aborted", detail: "no-accepted-decision" });
    expect(integrationCalls).toBe(0);

    await expect(handleDecideCandidate(
      "/canonical/repo",
      "run-tools",
      "accepted",
      candidate.manifestHash,
      deps,
    )).resolves.toEqual({
      recorded: true,
    });
    expect(store.decision).toMatchObject({ decision: "accepted" });

    await expect(handleIntegrateCandidate(
      "/canonical/repo",
      "run-tools",
      candidate.manifestHash,
      deps,
    )).resolves.toEqual({ integration: "applied", detail: "candidate tree applied" });
    expect(integrationCalls).toBe(1);
  });

  it("passes the exact lifecycle checkout lease into integration without nested ownership", async () => {
    const store = new FakeStore();
    store.decision = legacyAcceptedDecision("2026-07-18T12:01:00.000Z");
    let held = false;
    let acquireCalls = 0;
    let releaseCalls = 0;
    const checkoutLock: CheckoutLock = {
      key: "handler-integration-lock",
      repositoryIdentity: "/canonical/repo/.git",
      async release() {
        expect(held).toBe(true);
        releaseCalls += 1;
        held = false;
      },
    };
    let ps: PlatformServices;
    ps = {
      ...fakePlatform(),
      async acquireCheckoutLock() {
        acquireCalls += 1;
        held = true;
        return checkoutLock;
      },
    } as PlatformServices;
    const deps = dependencies(store, ps);
    let integrationCalls = 0;
    deps.applyCandidateTree = async args => {
      integrationCalls += 1;
      expect(held).toBe(true);
      expect(args.borrowedCheckoutLock).toBe(checkoutLock);
      expect(args.platformServices).toBe(ps);
      return { integration: "applied", detail: "candidate tree applied" };
    };

    await expect(invokeLifecycle("integrate", "/canonical/repo", deps)).resolves.toEqual({
      integration: "applied",
      detail: "candidate tree applied",
    });
    expect(acquireCalls).toBe(1);
    expect(releaseCalls).toBe(1);
    expect(integrationCalls).toBe(1);
    expect(held).toBe(false);
  });

  it.each(["review", "decide", "integrate"] as const)(
    "refuses to %s an active pipeline while holding the checkout lease",
    async operation => {
      const store = new FakeStore();
      store.pipelineActiveMarker = {
        pid: process.pid,
        processToken: null,
        startedAt: "2026-07-18T12:00:00.000Z",
        sliced: true,
      };
      if (operation === "integrate") {
        store.decision = legacyAcceptedDecision("2026-07-18T12:01:00.000Z");
      }
      let held = false;
      let acquireCalls = 0;
      let releaseCalls = 0;
      let markerReads = 0;
      const ps = {
        ...fakePlatform(),
        acquireCheckoutLock: async (): Promise<CheckoutLock> => {
          acquireCalls += 1;
          held = true;
          return {
            key: "active-pipeline-lock",
            repositoryIdentity: "/canonical/repo/.git",
            async release() {
              expect(held).toBe(true);
              releaseCalls += 1;
              held = false;
            },
          };
        },
      } as PlatformServices;
      store.readPipelineActiveMarker = async () => {
        markerReads += 1;
        expect(held).toBe(true);
        return store.pipelineActiveMarker;
      };
      const deps = dependencies(store, ps);
      let gitCalls = 0;
      let integrationCalls = 0;
      const originalGit = deps.git!;
      deps.git = async (cwd, args, indexFile) => {
        gitCalls += 1;
        return originalGit(cwd, args, indexFile);
      };
      deps.applyCandidateTree = async () => {
        integrationCalls += 1;
        return { integration: "applied", detail: "candidate tree applied" };
      };

      await expect(invokeLifecycle(operation, "/canonical/repo", deps)).resolves.toEqual({
        ok: false,
        error: "pipeline-active",
        diagnostic: "the delegation pipeline for this run is still active",
      });
      expect.soft(acquireCalls).toBe(1);
      expect.soft(releaseCalls).toBe(1);
      expect.soft(markerReads).toBe(1);
      expect.soft(gitCalls).toBe(0);
      expect.soft(integrationCalls).toBe(0);
      expect.soft(held).toBe(false);
      if (operation === "decide") expect.soft(store.decision).toBeNull();
    },
  );

  it.each(["review", "decide"] as const)(
    "reports %s checkout lease release failure after the action completes",
    async operation => {
      let releaseCalls = 0;
      const ps = {
        ...fakePlatform(),
        acquireCheckoutLock: async (): Promise<CheckoutLock> => ({
          key: "release-failure-lock",
          repositoryIdentity: "/canonical/repo/.git",
          async release() {
            releaseCalls += 1;
            throw new Error("lifecycle checkout release failed");
          },
        }),
      } as PlatformServices;

      await expect(invokeLifecycle(
        operation,
        "/canonical/repo",
        dependencies(new FakeStore(), ps),
      )).resolves.toEqual({
        ok: false,
        error: "runtime-error",
        diagnostic: "lifecycle checkout release failed",
      });
      expect(releaseCalls).toBe(1);
    },
  );

  it("preserves an applied integration result when lifecycle lease release fails", async () => {
    const store = new FakeStore();
    store.decision = legacyAcceptedDecision("2026-07-18T12:01:00.000Z");
    let releaseCalls = 0;
    const ps = {
      ...fakePlatform(),
      acquireCheckoutLock: async (): Promise<CheckoutLock> => ({
        key: "integration-release-failure-lock",
        repositoryIdentity: "/canonical/repo/.git",
        async release() {
          releaseCalls += 1;
          throw new Error("lifecycle checkout release failed");
        },
      }),
    } as PlatformServices;

    await expect(invokeLifecycle(
      "integrate",
      "/canonical/repo",
      dependencies(store, ps),
    )).resolves.toEqual({
      integration: "applied",
      detail: "candidate tree applied; checkout lock release failed",
    });
    expect(releaseCalls).toBe(1);
  });

  it("preserves the primary lifecycle classification when lease release also fails", async () => {
    let acquireCalls = 0;
    let releaseCalls = 0;
    const ps = {
      ...fakePlatform(),
      acquireCheckoutLock: async (): Promise<CheckoutLock> => {
        acquireCalls += 1;
        return {
          key: "primary-and-release-failure-lock",
          repositoryIdentity: "/canonical/repo/.git",
          async release() {
            releaseCalls += 1;
            throw new Error("lifecycle checkout release failed");
          },
        };
      },
    } as PlatformServices;
    const deps = dependencies(new FakeStore(), ps);
    deps.git = async () => gitResult("unexpected-object\n");

    await expect(handleReviewCandidate(
      "/canonical/repo",
      "run-tools",
      deps,
    )).resolves.toEqual({
      ok: false,
      error: "candidate-anchor-mismatch",
      diagnostic: "candidate anchor no longer matches the archive; checkout lock release failed",
    });
    expect(acquireCalls).toBe(1);
    expect(releaseCalls).toBe(1);
  });

  it("deletes the exact candidate anchor and idempotently retries rejection", async () => {
    const store = new FakeStore();
    const deps = dependencies(store);
    const gitCalls: string[][] = [];
    const originalGit = deps.git!;
    let anchorPresent = true;
    deps.git = async (cwd, args, indexFile) => {
      gitCalls.push(args);
      if (args[0] === "show-ref") {
        return anchorPresent
          ? gitResult(`${candidate.candidateCommitOid}\n`)
          : gitResult("", 1);
      }
      if (args.includes(`${candidate.anchorRef}^{commit}`) && !anchorPresent) {
        return gitResult("", 1);
      }
      const output = await originalGit(cwd, args, indexFile);
      if (args[0] === "update-ref") anchorPresent = false;
      return output;
    };

    await expect(handleDecideCandidate(
      "/canonical/repo",
      "run-tools",
      "rejected",
      candidate.manifestHash,
      deps,
    )).resolves.toEqual({
      recorded: true,
    });
    await expect(handleDecideCandidate(
      "/canonical/repo",
      "run-tools",
      "rejected",
      candidate.manifestHash,
      deps,
    )).resolves.toEqual({
      recorded: true,
    });

    expect(store.decision).toMatchObject({ decision: "rejected" });
    expect(gitCalls).toEqual([
      ["rev-parse", "--verify", "--quiet", `${candidate.anchorRef}^{commit}`],
      ["rev-parse", "--verify", `${candidate.candidateCommitOid}^{tree}`],
      [
        "diff",
        "--no-ext-diff",
        "--no-textconv",
        "--binary",
        "--full-index",
        candidate.baseCommitOid,
        candidate.candidateTreeOid,
        "--",
      ],
      [
        "update-ref",
        "--no-deref",
        "-d",
        candidate.anchorRef,
        candidate.candidateCommitOid,
      ],
      [
        "rev-parse",
        "--verify",
        "--quiet",
        `${candidate.anchorRef}^{commit}`,
      ],
      ["rev-parse", "--verify", `${candidate.candidateCommitOid}^{tree}`],
      [
        "diff",
        "--no-ext-diff",
        "--no-textconv",
        "--binary",
        "--full-index",
        candidate.baseCommitOid,
        candidate.candidateTreeOid,
        "--",
      ],
      [
        "show-ref",
        "--verify",
        "--hash",
        candidate.anchorRef,
      ],
    ]);
    await expect(handleIntegrateCandidate(
      "/canonical/repo",
      "run-tools",
      candidate.manifestHash,
      deps,
    )).resolves.toEqual({ integration: "aborted", detail: "no-accepted-decision" });
  });

  it("refuses to accept or integrate a candidate that failed verification", async () => {
    const failedResult: AttemptResult = {
      ...result,
      status: "failed",
      failure: "verification-failure",
      summary: "verification failed",
    };
    const store = new FakeStore(failedResult);
    const deps = dependencies(store);

    await expect(handleDecideCandidate(
      "/canonical/repo",
      "run-tools",
      "accepted",
      candidate.manifestHash,
      deps,
    )).resolves.toEqual({
      ok: false,
      error: "candidate-not-verified",
      diagnostic: "candidate did not complete independent verification",
    });
    store.decision = legacyAcceptedDecision("2026-07-14T00:00:00.000Z");
    await expect(handleIntegrateCandidate(
      "/canonical/repo",
      "run-tools",
      candidate.manifestHash,
      deps,
    )).resolves.toEqual({
      ok: false,
      error: "candidate-not-verified",
      diagnostic: "candidate did not complete independent verification",
    });
  });
});
