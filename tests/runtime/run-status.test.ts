import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import {
  access,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { git } from "../../src/git/git-exec.js";
import type { AttemptResult, CandidateArtifact, ChangedPath } from "../../src/protocol/attempt-result.js";
import type { DelegationSpec, Slice } from "../../src/protocol/delegation-spec.js";
import type { ResolvedExecutable } from "../../src/platform/platform-services.js";
import { getPlatformServices } from "../../src/platform/select-platform.js";
import { SANDBOX_BACKENDS } from "../../src/platform/sandbox/backends.js";
import {
  type CapabilityReport,
  type InvocationContext,
  type ProbeContext,
  type ProducerAdapter,
  type ProducerConfigurationProfile,
  type ProducerInvocation,
} from "../../src/producers/producer-adapter.js";
import { ProducerRegistry } from "../../src/producers/producer-registry.js";
import { runPipeline } from "../../src/pipeline/pipeline-runtime.js";
import type { ReviewReport } from "../../src/pipeline/report-types.js";
import type { RoleRunArgs, RoleRunResult } from "../../src/pipeline/role-runner.js";
import { ArtifactStore } from "../../src/runtime/artifact-store.js";
import { runAttempt, type AttemptRuntimeDependencies } from "../../src/runtime/attempt-runtime.js";
import { clearRegisteredSecrets, registerSecretValue } from "../../src/runtime/redaction.js";
import { buildRunManifest } from "../../src/runtime/run-manifest.js";
import { StatusEmitter, type RunStatus } from "../../src/runtime/run-status.js";
import { initializeRunStart } from "../../src/runtime/run-start.js";
import { logger } from "../../src/util/logger.js";

const execFileAsync = promisify(execFile);
const editFixture = fileURLToPath(new URL("fixtures/edit-file.mjs", import.meta.url));
const statusline = fileURLToPath(new URL("../../assets/statusline/delegation-status.sh", import.meta.url));
const temporaryPaths: string[] = [];
let previousPluginData: string | undefined;
let previousNodeEnvironment: string | undefined;
let sandboxState: "certified" | "tested" | "unsupported" | undefined;

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), prefix));
  temporaryPaths.push(directory);
  return directory;
}

async function runGit(cwd: string, args: string[], env?: Record<string, string>): Promise<string> {
  const result = await git(cwd, args, env === undefined ? undefined : { env });
  expect(result.exitCode, result.stderr).toBe(0);
  return result.stdout.trim();
}

async function initRepo(): Promise<string> {
  const repo = await realpath(await temporaryDirectory("ca-run-status-repo-"));
  await runGit(repo, ["init", "-q"]);
  await runGit(repo, ["config", "user.name", "Status Test"]);
  await runGit(repo, ["config", "user.email", "status@example.invalid"]);
  await writeFile(path.join(repo, "a.txt"), "base\n");
  await runGit(repo, ["add", "-A"]);
  await runGit(repo, ["commit", "-q", "-m", "base"]);
  return repo;
}

function verification(id = "check"): DelegationSpec["verification"][number] {
  return {
    id,
    executable: process.execPath,
    args: ["-e", "process.exit(0)"],
    cwd: ".",
    timeoutMs: 60_000,
    network: "denied",
    expectedExitCodes: [0],
  };
}

function validSpec(): DelegationSpec {
  return {
    specVersion: "1",
    objective: "Update the authorized fixture.",
    context: "a.txt is in scope.",
    writeAllowlist: ["a.txt"],
    forbiddenScope: [],
    successCriteria: ["a.txt is updated."],
    verification: [verification()],
    executionMode: "edit",
    timeoutMs: 10_000,
    producerPreferences: ["status-fake"],
    expectedOutput: "candidate-patch",
  };
}

const nodeExecutable: ResolvedExecutable = {
  kind: "native",
  command: process.execPath,
  prefixArgs: [],
  resolvedFrom: "test",
};

class StatusAdapter implements ProducerAdapter {
  readonly producerId = "status-fake";

  async probe(_ctx: ProbeContext): Promise<CapabilityReport> {
    return {
      producerId: this.producerId,
      available: true,
      reason: null,
      os: process.platform === "win32" ? "win32" : process.platform === "darwin" ? "darwin" : "linux",
      arch: process.arch,
      environmentType: "native",
      resolvedExecutable: nodeExecutable,
      version: "1",
      authState: "unknown",
      executionModes: ["edit"],
      structuredOutput: true,
      writeConfinementBackend: "codex-native-sandbox",
      laneEligibility: { edit: true },
    };
  }

  buildInvocation(_spec: DelegationSpec, _ctx: InvocationContext): ProducerInvocation {
    return {
      executable: nodeExecutable,
      args: [editFixture, "a.txt", "changed\n", "0"],
      requiredEnv: [],
      network: "denied",
    };
  }

  normalizeEvents(): ReturnType<ProducerAdapter["normalizeEvents"]> {
    return {
      events: [{ kind: "final", text: "complete" }],
      producerSummary: "complete",
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

function attemptDependencies(runId: string): AttemptRuntimeDependencies {
  return {
    verifier: {
      async verify() {
        return { ok: true, failures: [], evidence: {}, commandOutcomes: [] };
      },
    },
    ps: getPlatformServices(),
    producerRegistry: new ProducerRegistry([new StatusAdapter()]),
    baselineVerifier: async args => ({
      baselineCommitOid: args.headCommitOid,
      commands: args.commands.map(command => ({ id: command.id, exitCode: 0, ok: true })),
      dependencyLink: "none",
    }),
    runId: () => runId,
    env: {},
    repositoryInstructions: [],
    packagedVerifier: { version: "test", content: "trusted verifier" },
  };
}

function statusChangeType(status: string): ChangedPath["changeType"] {
  if (status === "A") return "added";
  if (status === "D") return "deleted";
  return "modified";
}

async function artifactFor(
  repo: string,
  runId: string,
  baselineCommit: string,
  candidateCommit: string,
): Promise<CandidateArtifact> {
  const changedPaths: ChangedPath[] = [];
  const output = await runGit(repo, ["diff", "--name-status", "--no-renames", baselineCommit, candidateCommit]);
  for (const line of output.split("\n").filter(Boolean)) {
    const [status, pathname] = line.split("\t");
    if (status === undefined || pathname === undefined) throw new Error("invalid fixture diff");
    const sourceCommit = status === "D" ? baselineCommit : candidateCommit;
    const entry = await runGit(repo, ["ls-tree", sourceCommit, "--", pathname]);
    const match = /^(\d{6})\s+blob\s+([0-9a-f]+)\t/.exec(entry);
    if (match === null) throw new Error("missing fixture tree entry");
    changedPaths.push({
      path: pathname,
      changeType: statusChangeType(status),
      mode: match[1]!,
      contentHash: status === "D" ? null : match[2]!,
    });
  }
  const anchorRef = `refs/claude-architect/candidates/${runId}`;
  await runGit(repo, ["update-ref", anchorRef, candidateCommit]);
  return {
    baseCommitOid: baselineCommit,
    candidateTreeOid: await runGit(repo, ["rev-parse", `${candidateCommit}^{tree}`]),
    candidateCommitOid: candidateCommit,
    anchorRef,
    manifestHash: createHash("sha256").update(JSON.stringify(changedPaths)).digest("hex"),
    changedPaths,
    patch: await runGit(repo, ["diff", "--binary", baselineCommit, candidateCommit]),
  };
}

function attemptResult(runId: string, candidate: CandidateArtifact): AttemptResult {
  return {
    resultVersion: "1",
    runId,
    status: "verified-candidate",
    failure: null,
    summary: "candidate produced and independently verified",
    producerSummary: "fixture",
    candidate,
    requestedVerification: [],
    executedVerification: [],
    unresolvedIssues: [],
    evidence: {},
    logsRef: "logs/producer.log",
    producerId: "status-fake",
    producerVersion: "1",
    producerModel: null,
    durationMs: 1,
    sessionId: null,
  };
}

async function fakeInitialAttempt(
  repo: string,
  _spec: DelegationSpec,
  deps: AttemptRuntimeDependencies,
): Promise<AttemptResult> {
  const runId = "status-sliced";
  const baselineCommit = await runGit(repo, ["rev-parse", "HEAD"]);
  const store = new ArtifactStore(runId);
  const commonDir = await realpath(path.join(repo, ".git"));
  const runStart = await initializeRunStart(store, {
    runId,
    lockKey: createHash("sha256").update(commonDir).digest("hex"),
    canonicalCommonDir: commonDir,
    pid: null,
    processToken: null,
    startedAt: new Date().toISOString(),
  });
  await deps.onRunStart?.(runStart);
  await deps.onPhase?.("verifying baseline");
  await deps.onPhase?.("producer running");
  await writeFile(path.join(repo, "slice-one.txt"), "slice one candidate\n");
  await runGit(repo, ["add", "-A"]);
  await runGit(repo, ["commit", "-q", "-m", "slice one"]);
  await deps.onPhase?.("freezing candidate");
  const candidateCommit = await runGit(repo, ["rev-parse", "HEAD"]);
  const result = attemptResult(runId, await artifactFor(repo, runId, baselineCommit, candidateCommit));
  await deps.onPhase?.("verifying candidate");
  await store.writeResult(result);
  await store.writeManifest(buildRunManifest({
    runId,
    repoRoot: repo,
    baseCommitOid: baselineCommit,
    candidateManifestHash: result.candidate!.manifestHash,
    producer: { id: "status-fake", version: "1", model: null },
    effectivePolicy: { isolation: "test" },
    repositoryInstructions: [],
    prompt: "test",
    executionPolicy: { network: "denied", writeAllowlist: ["slice-one.txt"] },
    environment: [],
    packagedVerifier: { version: "1", content: "test" },
  }));
  return result;
}

function fileVerification(id: string, expected: Record<string, string>): Slice["verification"][number] {
  return {
    id,
    executable: process.execPath,
    args: ["-e", `const fs=require('node:fs');const e=${JSON.stringify(expected)};for(const [p,c] of Object.entries(e)){if(fs.readFileSync(p,'utf8')!==c)process.exit(1)}`],
    cwd: ".",
    timeoutMs: 60_000,
    network: "denied",
    expectedExitCodes: [0],
  };
}

function slicedSpec(): DelegationSpec {
  return {
    ...validSpec(),
    objective: "Implement two slices.",
    writeAllowlist: ["slice-one.txt", "slice-two.txt"],
    successCriteria: ["Both slice files are complete."],
    verification: [fileVerification("final", {
      "slice-one.txt": "slice one candidate\n",
      "slice-two.txt": "slice two fixed\n",
    })],
    review: { reviewers: ["correctness"], maxRounds: 2 },
    slices: [{
      objective: "Implement slice one.",
      context: "slice one",
      writeAllowlist: ["slice-one.txt"],
      forbiddenScope: [],
      successCriteria: ["slice one complete"],
      verification: [fileVerification("slice-one", { "slice-one.txt": "slice one candidate\n" })],
    }, {
      objective: "Implement slice two.",
      context: "slice two",
      writeAllowlist: ["slice-two.txt"],
      forbiddenScope: [],
      successCriteria: ["slice two complete"],
      verification: [fileVerification("slice-two", {
        "slice-one.txt": "slice one candidate\n",
        "slice-two.txt": "slice two candidate\n",
      })],
    }],
  };
}

async function commitRoleFile(args: RoleRunArgs, content: string): Promise<string> {
  if (args.gitObjectAccess === undefined) throw new Error("missing private git object access");
  const env = {
    GIT_OBJECT_DIRECTORY: args.gitObjectAccess.privateObjectsDir,
    GIT_ALTERNATE_OBJECT_DIRECTORIES: args.gitObjectAccess.sharedObjectsDir,
  };
  await writeFile(path.join(args.worktreePath, "slice-two.txt"), content);
  await runGit(args.worktreePath, ["add", "slice-two.txt"], env);
  await runGit(args.worktreePath, ["commit", "-q", "-m", "update slice two"], env);
  return runGit(args.worktreePath, ["rev-parse", "HEAD"], env);
}

function fenced(value: unknown): string {
  return `\`\`\`json\n${JSON.stringify(value)}\n\`\`\``;
}

function success(value: unknown): RoleRunResult {
  return { ok: true, rawOutput: fenced(value), failure: null, producerId: "fixture" };
}

const blocker: ReviewReport = {
  reportVersion: "1",
  verdict: "request-changes",
  findings: [{
    severity: "major",
    location: "slice-two.txt:1",
    claim: "The final content needs a correction.",
    evidence: "The candidate content is provisional.",
    reproduction: "Read the file.",
    requiredOutcome: "Commit the fixed content.",
    confidence: 1,
  }],
  coverageGaps: [],
};
const approve: ReviewReport = { reportVersion: "1", verdict: "approve", findings: [], coverageGaps: [] };
let slicedReviewCalls = 0;

async function slicedRoleRunner(args: RoleRunArgs): Promise<RoleRunResult> {
  if (args.role === "implementer") {
    const commit = await commitRoleFile(args, "slice two candidate\n");
    return success({
      reportVersion: "1",
      candidateCommit: commit,
      status: "complete",
      summary: "slice two complete",
      nextSteps: "none",
    });
  }
  if (args.role === "fixer") {
    const commit = await commitRoleFile(args, "slice two fixed\n");
    return success({
      reportVersion: "1",
      candidateCommit: commit,
      dispositions: [{
        findingId: "F-001",
        disposition: "fixed",
        evidence: "Committed the correction.",
        commit,
      }],
    });
  }
  slicedReviewCalls += 1;
  return success(slicedReviewCalls === 1 ? blocker : approve);
}

function observeDiskStatuses(): RunStatus[] {
  const statuses: RunStatus[] = [];
  const original = ArtifactStore.prototype.writeRunStatus;
  vi.spyOn(ArtifactStore.prototype, "writeRunStatus").mockImplementation(async function (status) {
    await original.call(this, status);
    try {
      statuses.push(JSON.parse(await readFile(path.join(this.runDirectory, "status.json"), "utf8")) as RunStatus);
    } catch {
      // Missing run directories are a required no-op before trusted run initialization.
    }
  });
  return statuses;
}

// These tests assert run-status plumbing, not write confinement. The fake
// Producer reports the codex native sandbox, which is `unsupported` on Windows,
// so the edit lane would be withheld and every attempt would end `unavailable`
// before a single status transition was written. Pin the current platform to
// `tested` for the duration of the test — the same fixture the autopilot suites
// use — and restore the real matrix afterwards.
function currentSandboxPlatform() {
  const backend = SANDBOX_BACKENDS.find(candidate => candidate.id === "codex-native-sandbox");
  return backend?.platforms.find(candidate =>
    candidate.os === process.platform
    && candidate.environmentType === "native"
    && (candidate.arch === undefined || candidate.arch === process.arch));
}

beforeEach(async () => {
  previousPluginData = process.env.CLAUDE_PLUGIN_DATA;
  previousNodeEnvironment = process.env.NODE_ENV;
  process.env.CLAUDE_PLUGIN_DATA = await temporaryDirectory("ca-run-status-state-");
  process.env.NODE_ENV = "test";
  delete process.env.CLAUDE_ARCHITECT_DELEGATED;
  clearRegisteredSecrets();
  const platform = currentSandboxPlatform();
  if (platform === undefined) throw new Error("no platform sandbox fixture");
  sandboxState = platform.state;
  platform.state = "tested";
});

afterEach(async () => {
  const platform = currentSandboxPlatform();
  if (platform !== undefined && sandboxState !== undefined) platform.state = sandboxState;
  sandboxState = undefined;
  vi.restoreAllMocks();
  clearRegisteredSecrets();
  if (previousPluginData === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
  else process.env.CLAUDE_PLUGIN_DATA = previousPluginData;
  if (previousNodeEnvironment === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = previousNodeEnvironment;
  await Promise.all(temporaryPaths.splice(0).map(entry => rm(entry, { recursive: true, force: true })));
});

describe("trusted run status", () => {
  it("validates, redacts, and never creates a missing run directory", async () => {
    const missing = new ArtifactStore("status-missing");
    const base: RunStatus = {
      statusVersion: "1",
      runId: "status-missing",
      mode: "single",
      phase: "preflight",
      sliceIndex: null,
      sliceCount: null,
      round: null,
      role: null,
      producerId: null,
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      detail: null,
    };
    await missing.writeRunStatus(base);
    await expect(access(missing.runDirectory)).rejects.toMatchObject({ code: "ENOENT" });

    const store = new ArtifactStore("status-redacted");
    await initializeRunStart(store, {
      runId: "status-redacted",
      lockKey: "lock",
      canonicalCommonDir: "/repo",
      pid: null,
      processToken: null,
      startedAt: base.startedAt,
    });
    registerSecretValue("status-secret-value");
    await store.writeRunStatus({
      ...base,
      runId: "status-redacted",
      detail: `status-secret-value ${"x".repeat(250)}`,
    });
    const persisted = await store.readRunStatus("status-redacted");
    expect(persisted?.detail).not.toContain("status-secret-value");
    expect(persisted?.detail?.length).toBeLessThanOrEqual(200);
    await expect(store.writeRunStatus({ ...base, runId: "status-redacted", phase: "unknown" as RunStatus["phase"] }))
      .rejects.toThrow("run status is invalid");
  });

  it("records the real ordered attempt transitions on disk", async () => {
    const repo = await initRepo();
    const statuses = observeDiskStatuses();
    slicedReviewCalls = 0;
    const result = await runAttempt(repo, validSpec(), attemptDependencies("status-attempt"));
    expect(result.status).toBe("verified-candidate");
    // Two preflights: the run's own, then the Producer environment probe, which
    // launches the Producer and is distinguished by its detail.
    expect(statuses.map(status => status.phase)).toEqual([
      "preflight",
      "baseline-verify",
      "preflight",
      "implementing",
      "freezing",
      "verifying",
      "done",
    ]);
    expect(statuses[2]?.detail).toBe("probing producer environment");
    expect(statuses.every(status => status.runId === "status-attempt")).toBe(true);
  });

  it("isolates a throwing status write and a throwing logger from the attempt outcome", async () => {
    const repo = await initRepo();
    vi.spyOn(ArtifactStore.prototype, "writeRunStatus").mockRejectedValue(new Error("status disk failed"));
    vi.spyOn(logger, "warn").mockImplementation(() => { throw new Error("logger failed"); });
    const result = await runAttempt(repo, validSpec(), attemptDependencies("status-isolated"));
    expect(result.status).toBe("verified-candidate");
    expect(result.candidate).not.toBeNull();
  });

  it("records every sliced pipeline transition from the real harness execution", async () => {
    const repo = await initRepo();
    const statuses = observeDiskStatuses();
    const result = await runPipeline(repo, slicedSpec(), {
      verifier: {
        async verify() {
          return { ok: true, failures: [], evidence: {}, commandOutcomes: [] };
        },
      },
      ps: getPlatformServices(),
      registry: new ProducerRegistry([]),
      roleRunner: slicedRoleRunner,
      runAttempt: fakeInitialAttempt,
    });
    expect(result.status, JSON.stringify(result.gate)).toBe("decision-ready");
    expect(statuses.map(({ phase, sliceIndex, round, role }) => ({ phase, sliceIndex, round, role })))
      .toEqual([
        { phase: "preflight", sliceIndex: 1, round: null, role: null },
        { phase: "baseline-verify", sliceIndex: 1, round: null, role: null },
        { phase: "implementing", sliceIndex: 1, round: null, role: null },
        { phase: "freezing", sliceIndex: 1, round: null, role: null },
        { phase: "verifying", sliceIndex: 1, round: null, role: null },
        { phase: "verifying", sliceIndex: 1, round: null, role: null },
        { phase: "implementing", sliceIndex: 2, round: null, role: "implementer" },
        { phase: "freezing", sliceIndex: 2, round: null, role: "implementer" },
        { phase: "verifying", sliceIndex: 2, round: null, role: null },
        { phase: "reviewing", sliceIndex: 2, round: 1, role: "reviewer-correctness" },
        { phase: "fixing", sliceIndex: 2, round: 1, role: "fixer" },
        { phase: "reviewing", sliceIndex: 2, round: 2, role: "reviewer-correctness" },
        { phase: "verifying", sliceIndex: 2, round: null, role: null },
        { phase: "gating", sliceIndex: 2, round: null, role: null },
        { phase: "done", sliceIndex: 2, round: null, role: null },
      ]);
  }, 120_000);

  it.skipIf(process.platform === "win32")(
    "renders phase plus slice only for fresh token-matched live state",
    async () => {
      const runsRoot = path.join(process.env.CLAUDE_PLUGIN_DATA!, "runs");
      const store = new ArtifactStore("statusline-live");
      let commandPath = process.env.PATH ?? "";
      let token: string;
      if (process.platform === "linux") {
        const stat = await readFile(`/proc/${process.pid}/stat`, "utf8");
        token = `linux:${stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19]}`;
      } else {
        const fakeBin = await temporaryDirectory("ca-statusline-bin-");
        const fakePs = path.join(fakeBin, "ps");
        await writeFile(fakePs, "#!/bin/sh\nprintf '%s\\n' 'Mon Jan  1 00:00:00 2024'\n", { mode: 0o755 });
        commandPath = `${fakeBin}${path.delimiter}${commandPath}`;
        token = "darwin:Mon Jan  1 00:00:00 2024";
      }
      await initializeRunStart(store, {
        runId: "statusline-live",
        lockKey: "lock",
        canonicalCommonDir: "/repo",
        pid: null,
        processToken: null,
        startedAt: new Date().toISOString(),
      });
      const now = new Date().toISOString();
      await store.writePipelineActiveMarker({
        pid: process.pid,
        processToken: token,
        startedAt: now,
        sliced: true,
      });
      await store.writeRunStatus({
        statusVersion: "1",
        runId: "statusline-live",
        mode: "sliced",
        phase: "verifying",
        sliceIndex: 2,
        sliceCount: 3,
        round: null,
        role: null,
        producerId: null,
        startedAt: now,
        updatedAt: now,
        detail: null,
      });
      const run = async () => (await execFileAsync(statusline, [], {
        env: {
          ...process.env,
          PATH: commandPath,
          CLAUDE_PLUGIN_DATA: process.env.CLAUDE_PLUGIN_DATA,
        },
      })).stdout;
      await expect(run()).resolves.toBe("[delegation: verifying · slice 2/3]");

      await store.writePipelineActiveMarker({
        pid: process.pid,
        processToken: `${token}-reused`,
        startedAt: now,
        sliced: true,
      });
      await expect(run()).resolves.toBe("");

      await store.writePipelineActiveMarker({
        pid: process.pid,
        processToken: token,
        startedAt: now,
        sliced: true,
      });
      const stale = new Date(Date.now() - 16 * 60 * 1000).toISOString();
      await store.writeRunStatus({
        ...(await store.readRunStatus("statusline-live"))!,
        updatedAt: stale,
      });
      await expect(run()).resolves.toBe("");

      await store.writeRunStatus({
        ...(await store.readRunStatus("statusline-live"))!,
        updatedAt: now,
      });
      await store.writePipelineActiveMarker({
        pid: process.pid,
        processToken: token,
        startedAt: stale,
        sliced: true,
      });
      await expect(run()).resolves.toBe("");
      expect(runsRoot).toContain("runs");
    },
  );

  it("splits into durable transitions and ephemeral progress with exactly one durable write per transition", async () => {
    const store = new ArtifactStore("status-emitter-test");
    await initializeRunStart(store, {
      runId: "status-emitter-test",
      lockKey: "lock",
      canonicalCommonDir: "/repo",
      pid: process.pid,
      processToken: "token",
      startedAt: new Date().toISOString(),
    });

    const initial: RunStatus = {
      statusVersion: "1",
      runId: "status-emitter-test",
      mode: "single",
      phase: "preflight",
      sliceIndex: null,
      sliceCount: null,
      round: null,
      role: null,
      producerId: null,
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      detail: null,
    };
    await store.writeRunStatus(initial);

    let writeCount = 0;
    const originalWrite = store.writeRunStatus.bind(store);
    store.writeRunStatus = async status => {
      writeCount++;
      return originalWrite(status);
    };

    const progressReports: string[] = [];
    const emitter = new StatusEmitter(store, "status-emitter-test", text => {
      progressReports.push(text);
    });

    // Durable transition 1: implementing
    await emitter.transition("implementing", { role: "implementer", producerId: "codex" });
    expect(writeCount).toBe(1);
    expect((await store.readRunStatus("status-emitter-test"))?.phase).toBe("implementing");

    // Ephemeral progress reports do NOT perform durable disk writes
    await emitter.ephemeral("running tests: 1/5 passed");
    await emitter.ephemeral("running tests: 2/5 passed");
    await emitter.ephemeral("running tests: 3/5 passed");
    expect(writeCount).toBe(1);
    expect(progressReports).toEqual([
      "running tests: 1/5 passed",
      "running tests: 2/5 passed",
      "running tests: 3/5 passed",
    ]);

    // Durable transition 2: verifying
    await emitter.transition("verifying");
    expect(writeCount).toBe(2);
    expect((await store.readRunStatus("status-emitter-test"))?.phase).toBe("verifying");

    // Ephemeral progress
    await emitter.ephemeral("verifying candidate tree");
    expect(writeCount).toBe(2);
    expect(progressReports).toHaveLength(4);

    // Durable transition 3: done
    await emitter.transition("done");
    expect(writeCount).toBe(3);
    expect((await store.readRunStatus("status-emitter-test"))?.phase).toBe("done");
  });
});
