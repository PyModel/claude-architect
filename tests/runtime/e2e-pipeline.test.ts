import {
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { git } from "../../src/git/git-exec.js";
import {
  handleDecideCandidate,
  handleDelegatePipeline,
  handleIntegrateCandidate,
  readDecisionAdvisory,
  type ToolDependencies,
} from "../../src/mcp/tools.js";
import { runPipeline } from "../../src/pipeline/pipeline-runtime.js";
import type { ReviewReport } from "../../src/pipeline/report-types.js";
import type { ResolvedExecutable } from "../../src/platform/platform-services.js";
import { SANDBOX_BACKENDS } from "../../src/platform/sandbox/backends.js";
import { getPlatformServices } from "../../src/platform/select-platform.js";
import type { DelegationSpec } from "../../src/protocol/delegation-spec.js";
import type {
  CapabilityReport,
  InvocationContext,
  ProbeContext,
  ProducerAdapter,
  ProducerConfigurationProfile,
  ProducerInvocation,
} from "../../src/producers/producer-adapter.js";
import { ProducerRegistry } from "../../src/producers/producer-registry.js";
import { ArtifactStore } from "../../src/runtime/artifact-store.js";
import type {
  AcceptanceVerifierLike,
  AttemptRuntimeDependencies,
} from "../../src/runtime/attempt-runtime.js";
import { clearRegisteredSecrets } from "../../src/runtime/redaction.js";

const editFixture = fileURLToPath(new URL("fixtures/edit-file.mjs", import.meta.url));
const nodeExecutable: ResolvedExecutable = {
  kind: "native",
  command: process.execPath,
  prefixArgs: [],
  resolvedFrom: "e2e-fixture",
};

const approve: ReviewReport = {
  reportVersion: "1",
  verdict: "approve",
  findings: [],
  coverageGaps: [],
};

function requestedChanges(severity: "blocker" | "major"): ReviewReport {
  return {
    reportVersion: "1",
    verdict: "request-changes",
    findings: [{
      severity,
      location: "a.txt:1",
      claim: "The candidate still needs a deterministic correction.",
      evidence: "The first line contains the initial implementation.",
      reproduction: "Read the first line of a.txt.",
      requiredOutcome: "Commit the corrected fixture content.",
      confidence: 1,
    }],
    coverageGaps: [],
  };
}

function fenced(value: unknown): string {
  return `\`\`\`json\n${JSON.stringify(value)}\n\`\`\``;
}

function emit(output: string): ProducerInvocation {
  return {
    executable: nodeExecutable,
    args: ["-e", "process.stdout.write(process.argv[1]);", output],
    requiredEnv: [],
    network: "denied",
  };
}

const fixedScript = [
  'const { writeFileSync } = require("node:fs");',
  'const { spawnSync } = require("node:child_process");',
  "function git(args) {",
  '  const result = spawnSync("git", args, { encoding: "utf8" });',
  "  if (result.status !== 0) {",
  '    process.stderr.write(result.stderr || result.stdout || "git failed");',
  "    process.exit(result.status || 1);",
  "  }",
  "  return result.stdout.trim();",
  "}",
  'writeFileSync("a.txt", "fixed\\n");',
  'git(["add", "a.txt"]);',
  "git([",
  '  "-c", "user.name=Claude Architect Test",',
  '  "-c", "user.email=claude-architect@example.invalid",',
  '  "commit", "-q", "-m", "fix",',
  "]);",
  'const commit = git(["rev-parse", "HEAD"]);',
  "const report = {",
  '  reportVersion: "1",',
  "  candidateCommit: commit,",
  "  dispositions: [{",
  '    findingId: "F-001",',
  '    disposition: "fixed",',
  '    evidence: "Committed the requested correction.",',
  "    commit,",
  "  }],",
  "};",
  'process.stdout.write("```json\\n" + JSON.stringify(report) + "\\n```\\n");',
].join("\n");

const blockedScript = [
  'const { spawnSync } = require("node:child_process");',
  'const result = spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" });',
  "if (result.status !== 0) {",
  '  process.stderr.write(result.stderr || result.stdout || "git failed");',
  "  process.exit(result.status || 1);",
  "}",
  "const report = {",
  '  reportVersion: "1",',
  "  candidateCommit: result.stdout.trim(),",
  "  dispositions: [{",
  '    findingId: "F-001",',
  '    disposition: "blocked",',
  '    evidence: "The blocker remains unresolved.",',
  "  }],",
  "};",
  'process.stdout.write("```json\\n" + JSON.stringify(report) + "\\n```\\n");',
].join("\n");

type Scenario = "fixed" | "blocked";

class FakeAdapter implements ProducerAdapter {
  readonly producerId = "codex";
  readonly calls = {
    implement: 0,
    correctness: 0,
    systems: 0,
    fixer: 0,
  };

  constructor(private readonly scenario: Scenario) {}

  async probe(context: ProbeContext): Promise<CapabilityReport> {
    return {
      producerId: this.producerId,
      available: true,
      reason: null,
      os: context.os,
      arch: context.arch,
      environmentType: context.environmentType,
      resolvedExecutable: nodeExecutable,
      version: "1.0.0",
      authState: "unknown",
      executionModes: ["edit"],
      structuredOutput: true,
      writeConfinementBackend: "macos-seatbelt",
      laneEligibility: { edit: true },
    };
  }

  buildInvocation(spec: DelegationSpec, _context: InvocationContext): ProducerInvocation {
    if (spec.objective.includes("[pipeline role: reviewer-correctness]")) {
      this.calls.correctness += 1;
      const report = this.scenario === "fixed" && this.calls.correctness > 1
        ? approve
        : requestedChanges(this.scenario === "fixed" ? "major" : "blocker");
      return emit(fenced(report));
    }
    if (spec.objective.includes("[pipeline role: reviewer-systems]")) {
      this.calls.systems += 1;
      return emit(fenced(approve));
    }
    if (spec.objective.includes("[pipeline role: fixer]")) {
      this.calls.fixer += 1;
      return {
        executable: nodeExecutable,
        args: ["-e", this.scenario === "fixed" ? fixedScript : blockedScript],
        requiredEnv: [],
        network: "denied",
      };
    }

    this.calls.implement += 1;
    return {
      executable: nodeExecutable,
      args: [editFixture, "a.txt", "candidate\n", "0"],
      requiredEnv: [],
      network: "denied",
    };
  }

  normalizeEvents(
    raw: Parameters<ProducerAdapter["normalizeEvents"]>[0],
  ): ReturnType<ProducerAdapter["normalizeEvents"]> {
    return {
      events: [{ kind: "final", text: raw.stdout }],
      producerSummary: raw.stdout,
      ok: true,
    };
  }

  configurationProfile(): ProducerConfigurationProfile {
    return {
      isolationState: "controlled-config-supported",
      credentialSources: [],
      behavioralConfigSources: [],
      repositoryInstructionSources: [],
      environmentDependencies: [],
      temporaryHomeStrategy: "per-attempt HOME",
    };
  }
}

const passingVerifier: AcceptanceVerifierLike = {
  async verify() {
    return {
      ok: true,
      failures: [],
      // Real-shaped policy: the declared command ran under OS confinement.
      evidence: {
        acceptance: "passed",
        verificationPolicy: [{ id: "unit", confinement: "macos-seatbelt", skipped: false }],
      },
      commandOutcomes: [],
    };
  },
};

const temporaryPaths: string[] = [];
let previousPluginData: string | undefined;
let previousNodeEnvironment: string | undefined;
let previousDelegated: string | undefined;
let previousSeatbeltState: "certified" | "tested" | "unsupported" | undefined;

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), prefix));
  temporaryPaths.push(directory);
  return directory;
}

async function runGit(cwd: string, args: string[]): Promise<string> {
  const result = await git(cwd, args);
  expect(result.exitCode, result.stderr).toBe(0);
  return result.stdout.trim();
}

async function initRepo(): Promise<string> {
  const directory = await realpath(await temporaryDirectory("ca-e2e-pipeline-repo-"));
  await runGit(directory, ["init", "-q"]);
  await writeFile(path.join(directory, "a.txt"), "base\n");
  await runGit(directory, ["add", "-A"]);
  await runGit(directory, [
    "-c",
    "user.name=Claude Architect Test",
    "-c",
    "user.email=claude-architect@example.invalid",
    "commit",
    "-q",
    "-m",
    "base",
  ]);
  return directory;
}

function validSpec(): DelegationSpec {
  return {
    specVersion: "1",
    objective: "Update the authorized fixture file.",
    context: "a.txt is the only file in scope.",
    writeAllowlist: ["a.txt"],
    forbiddenScope: [],
    successCriteria: ["a.txt contains the delegated edit."],
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
    review: { reviewers: ["correctness", "systems"], maxRounds: 2 },
  };
}

function dependencies(adapter: FakeAdapter, runId: string): ToolDependencies {
  const ps = getPlatformServices();
  const attemptDependencies: AttemptRuntimeDependencies = {
    ps,
    producerRegistry: new ProducerRegistry([adapter]),
    verifier: passingVerifier,
    runId: () => runId,
    env: {},
    packagedVerifier: { version: "e2e", content: "trusted e2e verifier" },
  };
  const deps: ToolDependencies = { ps, attemptDependencies };
  deps.runPipeline = (checkoutPath, spec, pipelineDeps) =>
    runPipeline(checkoutPath, spec, {
      ...pipelineDeps,
      registry: new ProducerRegistry([adapter]),
    });
  return deps;
}

beforeEach(async () => {
  previousPluginData = process.env.CLAUDE_PLUGIN_DATA;
  previousNodeEnvironment = process.env.NODE_ENV;
  previousDelegated = process.env.CLAUDE_ARCHITECT_DELEGATED;
  process.env.CLAUDE_PLUGIN_DATA = await temporaryDirectory("ca-e2e-pipeline-state-");
  process.env.NODE_ENV = "test";
  delete process.env.CLAUDE_ARCHITECT_DELEGATED;
  clearRegisteredSecrets();

  const seatbelt = SANDBOX_BACKENDS.find(backend => backend.id === "macos-seatbelt");
  const darwin = seatbelt?.platforms.find(platform =>
    platform.os === "darwin" && platform.environmentType === "native");
  if (darwin === undefined) throw new Error("macOS Seatbelt test backend is missing");
  previousSeatbeltState = darwin.state;
  darwin.state = "tested";
});

afterEach(async () => {
  clearRegisteredSecrets();
  if (previousPluginData === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
  else process.env.CLAUDE_PLUGIN_DATA = previousPluginData;
  if (previousNodeEnvironment === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = previousNodeEnvironment;
  if (previousDelegated === undefined) delete process.env.CLAUDE_ARCHITECT_DELEGATED;
  else process.env.CLAUDE_ARCHITECT_DELEGATED = previousDelegated;

  const seatbelt = SANDBOX_BACKENDS.find(backend => backend.id === "macos-seatbelt");
  const darwin = seatbelt?.platforms.find(platform =>
    platform.os === "darwin" && platform.environmentType === "native");
  if (darwin !== undefined && previousSeatbeltState !== undefined) {
    darwin.state = previousSeatbeltState;
  }
  previousSeatbeltState = undefined;

  await Promise.all(temporaryPaths.splice(0).map(entry =>
    rm(entry, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })));
});

// Every writer and review round gets a fresh worktree, so one pipeline drives
// several real create/remove cycles; on a loaded full-suite host those exceed
// the default per-test budget.
const PIPELINE_TIMEOUT_MS = 90_000;

describe.runIf(process.platform === "darwin")("end-to-end review pipeline", () => {
  it("full lifecycle: a gate-cleared pipeline remains autonomously eligible", async () => {
    const repo = await initRepo();
    const runId = "e2e-pipeline-full-lifecycle";
    const adapter = new FakeAdapter("fixed");
    const deps = dependencies(adapter, runId);
    const lifecycleDeps = {
      ...deps,
      decisionProvenance: "human-elicitation" as const,
    };

    const result = await handleDelegatePipeline(repo, validSpec(), deps);

    expect(result).toMatchObject({
      ok: true,
      result: { runId, status: "decision-ready" },
    });
    if (!result.ok) throw new Error("pipeline delegation unexpectedly failed");
    expect(result.result.rounds).toHaveLength(2);
    // implement: 2 = one Producer environment probe + one real implementation.
    // The stub never writes the probe file, so the probe is inconclusive and
    // correctly declines to block the attempt.
    expect(adapter.calls).toEqual({ implement: 2, correctness: 2, systems: 2, fixer: 1 });
    expect(result.result.attempt.evidence.producerPreflight)
      .toMatchObject({ status: "inconclusive" });
    expect(result.result.attempt.evidence.pipelineGateCleared).toEqual({
      candidateCommitOid: result.result.finalCandidateCommit,
      requiresHumanDecision: false,
    });

    const advisory = await readDecisionAdvisory(runId, deps);
    expect(advisory).toEqual({
      warnings: [],
      verifiedClean: true,
      unreadable: false,
    });

    const candidateHash = result.result.attempt.candidate?.manifestHash;
    expect(candidateHash).toBeDefined();
    await expect(handleDecideCandidate(repo, runId, "accepted", candidateHash!, lifecycleDeps))
      .resolves.toEqual({ recorded: true });
    const manifest = await new ArtifactStore(runId).readManifest();
    expect(manifest).not.toBeNull();
    expect(manifest?.candidateManifestHash).not.toBeNull();
    // decideCandidate compares the caller's hash against the ARCHIVED manifest,
    // so this equality is load-bearing but was only asserted incidentally via
    // `recorded: true`. Pin it, or a divergence between the frozen artifact and
    // the archive would surface as a confusing decision failure.
    expect(manifest!.candidateManifestHash).toBe(candidateHash);
    // Same authority as the first call: idempotence is about repeating a
    // decision, and re-recording one under a different authority is a different
    // claim about who decided, which the store refuses by design.
    await expect(handleDecideCandidate(
      repo,
      runId,
      "accepted",
      manifest!.candidateManifestHash!,
      lifecycleDeps,
    )).resolves.toEqual({
      recorded: true,
    });
    await expect(handleIntegrateCandidate(
      repo,
      runId,
      manifest!.candidateManifestHash!,
      lifecycleDeps,
    )).resolves.toMatchObject({ integration: "applied" });
    await expect(readFile(path.join(repo, "a.txt"), "utf8")).resolves.toBe("fixed\n");
  }, PIPELINE_TIMEOUT_MS);

  it("pipeline with an unfixable blocker ends at human-decision-required", async () => {
    const repo = await initRepo();
    const runId = "e2e-pipeline-blocked";
    const adapter = new FakeAdapter("blocked");

    const result = await handleDelegatePipeline(
      repo,
      validSpec(),
      dependencies(adapter, runId),
    );

    expect(result).toMatchObject({
      ok: true,
      result: { runId, status: "human-decision-required" },
    });
    if (!result.ok) throw new Error("pipeline delegation unexpectedly failed");
    expect(result.result.rounds).toHaveLength(2);
    expect(adapter.calls).toEqual({ implement: 2, correctness: 2, systems: 2, fixer: 2 });
  }, PIPELINE_TIMEOUT_MS);

  it("carries a refusing gate into the archived attempt the accept path reads", async () => {
    const repo = await initRepo();
    const runId = "e2e-pipeline-gate-refusal-durable";
    const deps = dependencies(new FakeAdapter("blocked"), runId);

    const result = await handleDelegatePipeline(repo, validSpec(), deps);
    expect(result).toMatchObject({ ok: true, result: { status: "human-decision-required" } });
    if (!result.ok) throw new Error("pipeline delegation unexpectedly failed");
    expect(result.result.gate.decisionReady).toBe(false);

    // The gate's refusal used to live only in the pipeline-result artifact. The
    // accept path loads the archived attempt, so a candidate the gate rejected
    // was indistinguishable there from one it cleared.
    const archived = await new ArtifactStore(runId).readResult();
    expect(archived?.evidence.pipelineGateRefused).toMatchObject({
      reasons: expect.arrayContaining([expect.any(String)]),
    });

    // It has to reach the text the human reads before spending a decision, and
    // block autonomous acceptance: the advisory is the autonomous verdict.
    await expect(readDecisionAdvisory(runId, deps)).resolves.toMatchObject({
      warnings: archived?.evidence.pipelineGateRefused?.reasons,
      verifiedClean: false,
    });
  }, PIPELINE_TIMEOUT_MS);

  it("warns rather than reporting a clean candidate when the archive cannot be read", async () => {
    const advisory = await readDecisionAdvisory("e2e-pipeline-no-such-run", {});
    expect(advisory).toMatchObject({
      warnings: [expect.stringContaining("could not be read")],
      unreadable: true,
      verifiedClean: false,
    });
  }, PIPELINE_TIMEOUT_MS);
});
