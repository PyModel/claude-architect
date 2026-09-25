import { fileURLToPath } from "node:url";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AutopilotController,
  type AutopilotControllerDependencies,
} from "../../../src/autopilot/autopilot-controller.js";
import { WorkflowBranchManager, type RemoteTransport } from "../../../src/autopilot/branch-manager.js";
import { CandidatePromoter } from "../../../src/autopilot/candidate-promoter.js";
import {
  FINAL_BRANCH_ARTIFACT_REF,
  FinalBranchReviewer,
} from "../../../src/autopilot/final-branch-reviewer.js";
import { WorkflowStore } from "../../../src/autopilot/workflow-store.js";
import { git } from "../../../src/git/git-exec.js";
import { withRepoLock } from "../../../src/mcp/serialize.js";
import { runAdvisorStage } from "../../../src/pipeline/advisor-stage.js";
import {
  runPipeline,
  type PipelineDependencies,
} from "../../../src/pipeline/pipeline-runtime.js";
import type { AdvisorReport, ReviewReport } from "../../../src/pipeline/report-types.js";
import type { RoleRunArgs, RoleRunResult } from "../../../src/pipeline/role-runner.js";
import { SANDBOX_BACKENDS } from "../../../src/platform/sandbox/backends.js";
import type { ResolvedExecutable } from "../../../src/platform/platform-services.js";
import { getPlatformServices } from "../../../src/platform/select-platform.js";
import type { AutopilotSpec } from "../../../src/protocol/autopilot-spec.js";
import type { DelegationSpec } from "../../../src/protocol/delegation-spec.js";
import type {
  CapabilityReport,
  InvocationContext,
  ProbeContext,
  ProducerAdapter,
  ProducerConfigurationProfile,
  ProducerInvocation,
} from "../../../src/producers/producer-adapter.js";
import { ProducerRegistry } from "../../../src/producers/producer-registry.js";
import { ArtifactStore } from "../../../src/runtime/artifact-store.js";
import type { AttemptRuntimeDependencies } from "../../../src/runtime/attempt-runtime.js";
import { createReviewSnapshot } from "../../../src/runtime/review-snapshot.js";
import { AcceptanceVerifier } from "../../../src/verify/acceptance-verifier.js";

const editFixture = fileURLToPath(new URL("../fixtures/edit-file.mjs", import.meta.url));
const WORKFLOW_ID = "workflow-forced-red-12345678";
const RUN_ID = "autopilot-forced-red-task";
const NOW = "2026-07-21T13:00:00.000Z";
const REMOTE_URL = "https://github.com/example/autopilot-forced-red.git";
const FORCED_RED = {
  id: "forced-red",
  executable: "node",
  args: ["-e", "process.exit(7)"],
  cwd: ".",
  timeoutMs: 30_000,
  network: "denied" as const,
  expectedExitCodes: [0],
};
const nodeExecutable: ResolvedExecutable = {
  kind: "native",
  command: process.execPath,
  prefixArgs: [],
  resolvedFrom: "autopilot-forced-red-fixture",
};

const temporaryPaths: string[] = [];
const originalEnvironment = new Map<string, string | undefined>();
let sandboxState: "certified" | "tested" | "unsupported" | undefined;

async function runGit(cwd: string, args: string[]): Promise<string> {
  const result = await git(cwd, args);
  expect(result.exitCode, result.stderr || result.stdout).toBe(0);
  return result.stdout.trim();
}

function localRemoteTransport(bareRemote: string): RemoteTransport {
  return {
    fetch: (cwd, _canonicalUrl, sourceRef, destinationRef) => git(cwd, [
      "fetch", "--no-tags", bareRemote, `${sourceRef}:${destinationRef}`,
    ]),
    listHeads: cwd => git(cwd, ["ls-remote", "--heads", bareRemote]),
  };
}

async function createRepository(root: string): Promise<{
  bareRemote: string;
  checkout: string;
  baseCommitOid: string;
  baseBytes: Buffer;
}> {
  const bareRemote = path.join(root, "remote.git");
  const checkout = path.join(root, "human-checkout");
  await Promise.all([mkdir(bareRemote), mkdir(checkout)]);
  await runGit(bareRemote, ["init", "--bare", "-q"]);
  await runGit(checkout, ["init", "-q", "-b", "main"]);
  await runGit(checkout, ["config", "user.name", "Autopilot Forced Red"]);
  await runGit(checkout, ["config", "user.email", "forced-red@example.invalid"]);
  const baseBytes = Buffer.from("human checkout must remain unchanged\n");
  await writeFile(path.join(checkout, "base.txt"), baseBytes);
  await runGit(checkout, ["add", "base.txt"]);
  await runGit(checkout, ["commit", "-q", "-m", "base"]);
  await runGit(checkout, ["remote", "add", "origin", REMOTE_URL]);
  const baseCommitOid = await runGit(checkout, ["rev-parse", "HEAD"]);
  await runGit(checkout, ["push", bareRemote, "main:main"]);
  return {
    bareRemote: await realpath(bareRemote),
    checkout: await realpath(checkout),
    baseCommitOid,
    baseBytes,
  };
}

class UnreachedFakeProducer implements ProducerAdapter {
  readonly producerId = "codex";
  readonly invocations: ProducerInvocation[] = [];

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
      writeConfinementBackend: "codex-native-sandbox",
      laneEligibility: { edit: true },
    };
  }

  buildInvocation(_spec: DelegationSpec, _context: InvocationContext): ProducerInvocation {
    const invocation: ProducerInvocation = {
      executable: nodeExecutable,
      args: [editFixture, "must-not-exist.txt", "unexpected producer bytes\n", "0"],
      requiredEnv: [],
      network: "denied",
    };
    this.invocations.push(invocation);
    return invocation;
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

const approvingReview: ReviewReport = {
  reportVersion: "1",
  verdict: "approve",
  findings: [],
  coverageGaps: [],
};
const approvingAdvisor: AdvisorReport = {
  reportVersion: "1",
  verdict: "approve",
  rationale: "This role must remain unreachable after the forced-red gate.",
  risks: [],
  coverageGaps: [],
};

function unreachableRoleRunner(args: RoleRunArgs): Promise<RoleRunResult> {
  const report = args.role === "advisor" ? approvingAdvisor : approvingReview;
  return Promise.resolve({
    ok: true,
    rawOutput: `\`\`\`json\n${JSON.stringify(report)}\n\`\`\``,
    failure: null,
    producerId: "unreached-fake-producer",
  });
}

function forcedRedSpec(): AutopilotSpec {
  return {
    specVersion: "2",
    topic: "forced-red",
    base: { remote: "origin", branch: "main" },
    tasks: [{
      id: "forced-red-task",
      commitMessage: "feat: this commit must never exist",
      delegation: {
        specVersion: "1",
        objective: "The canonical cross-platform verification command must fail.",
        context: "No mutation may follow a red gate.",
        writeAllowlist: ["must-not-exist.txt"],
        forbiddenScope: [],
        successCriteria: ["The forced-red gate fails closed."],
        verification: [structuredClone(FORCED_RED)],
        executionMode: "edit",
        timeoutMs: 600_000,
        producerPreferences: ["codex"],
        expectedOutput: "candidate-patch",
        review: { reviewers: ["correctness", "systems"], maxRounds: 1 },
      },
    }],
    finalSuccessCriteria: ["No authorization or promotion follows the red gate."],
    finalVerification: [structuredClone(FORCED_RED)],
  };
}

beforeEach(async () => {
  for (const key of ["CLAUDE_PLUGIN_DATA", "NODE_ENV", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM"]) {
    originalEnvironment.set(key, process.env[key]);
  }
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "ca-autopilot-forced-red-")));
  temporaryPaths.push(root);
  const globalConfig = path.join(root, "global.gitconfig");
  const systemConfig = path.join(root, "system.gitconfig");
  await Promise.all([writeFile(globalConfig, ""), writeFile(systemConfig, "")]);
  process.env.CLAUDE_PLUGIN_DATA = path.join(root, "state");
  process.env.NODE_ENV = "test";
  process.env.GIT_CONFIG_GLOBAL = globalConfig;
  process.env.GIT_CONFIG_SYSTEM = systemConfig;

  const backend = SANDBOX_BACKENDS.find(candidate => candidate.id === "codex-native-sandbox");
  const platform = backend?.platforms.find(candidate =>
    candidate.os === process.platform
    && candidate.environmentType === "native"
    && (candidate.arch === undefined || candidate.arch === process.arch));
  if (platform === undefined) throw new Error("the fake Producer has no platform sandbox fixture");
  sandboxState = platform.state;
  platform.state = "tested";
});

afterEach(async () => {
  const backend = SANDBOX_BACKENDS.find(candidate => candidate.id === "codex-native-sandbox");
  const platform = backend?.platforms.find(candidate =>
    candidate.os === process.platform
    && candidate.environmentType === "native"
    && (candidate.arch === undefined || candidate.arch === process.arch));
  if (platform !== undefined && sandboxState !== undefined) platform.state = sandboxState;
  sandboxState = undefined;
  for (const [key, value] of originalEnvironment) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  originalEnvironment.clear();
  await Promise.all(temporaryPaths.splice(0).map(directory =>
    rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })));
});

describe("AutopilotController platform-neutral forced-red gate", () => {
  it("durably fails before eligibility, promotion, or integration", async () => {
    const root = temporaryPaths[0]!;
    const fixture = await createRepository(root);
    const platformServices = getPlatformServices();
    const producer = new UnreachedFakeProducer();
    const producerRegistry = new ProducerRegistry([producer]);
    const attemptDependencies: AttemptRuntimeDependencies = {
      ps: platformServices,
      producerRegistry,
      verifier: new AcceptanceVerifier(),
      runId: () => RUN_ID,
      env: {},
      packagedVerifier: { version: "forced-red", content: "trusted forced-red verifier" },
    };
    const pipelineDependencies: PipelineDependencies = {
      ...attemptDependencies,
      registry: producerRegistry,
      roleRunner: unreachableRoleRunner,
    };
    const branchManager = new WorkflowBranchManager({
      platformServices,
      remoteTransport: localRemoteTransport(fixture.bareRemote),
    });
    const workflowStore = (workflowId: string) => new WorkflowStore(workflowId);
    const controllerDependencies: AutopilotControllerDependencies = {
      workflowId: () => WORKFLOW_ID,
      now: () => NOW,
      workflowLock: {
        runExclusive: (workflowId, operation) => withRepoLock(`autopilot:${workflowId}`, operation),
      },
      workflowStore,
      repositoryIdentity: async checkoutPath => {
        const canonical = await platformServices.canonicalizePath(checkoutPath);
        return canonical.gitCommonDir ?? canonical.canonical;
      },
      branchManager,
      pipelineRunner: {
        run: (checkoutPath, spec) => runPipeline(checkoutPath, spec, pipelineDependencies),
      },
      reviewSnapshotter: {
        async create({ branch, pipelineResult }) {
          const store = new ArtifactStore(pipelineResult.runId);
          const snapshot = await createReviewSnapshot({
            runId: pipelineResult.runId,
            repoRoot: branch.worktreePath,
            repositoryIdentity: branch.repositoryIdentity,
            store,
            platformServices,
            git,
          });
          await store.writeReviewSnapshot(snapshot);
          return snapshot;
        },
      },
      eligibilityEvaluator: {
        async evaluate({ branch, task, pipelineResult, reviewSnapshot }) {
          return (await runAdvisorStage({
            runId: pipelineResult.runId,
            spec: task.delegation,
            worktreePath: branch.worktreePath,
            deps: pipelineDependencies,
            evaluatedAt: NOW,
            pipelineResult,
            reviewSnapshot,
          })).eligibility;
        },
      },
      promoter: new CandidatePromoter({
        platformServices,
        branchManager,
        workflowStore,
        now: () => NOW,
      }),
      finalBranchReviewer: new FinalBranchReviewer({
        platformServices,
        branchManager,
        workflowStore,
        producerRegistry,
        roleRunner: unreachableRoleRunner,
        now: () => NOW,
      }),
    };
    const controller = new AutopilotController(controllerDependencies);

    await expect(controller.start(fixture.checkout, forcedRedSpec())).rejects.toMatchObject({
      classification: "pipeline-failed",
    });

    const store = new WorkflowStore(WORKFLOW_ID);
    const durable = await store.read();
    expect(durable.phase).toBe("failed");
    expect(durable.terminal).toMatchObject({
      classification: "failed",
      reason: "pipeline-failed",
    });
    expect(durable.tasks[0]).toMatchObject({
      status: "halted",
      runId: null,
      candidateManifestHash: null,
      eligibilityHash: null,
      promotionCommitOid: null,
    });
    await expect(lstat(store.ownerPath)).rejects.toMatchObject({ code: "ENOENT" });

    const runStore = new ArtifactStore(RUN_ID);
    const attempt = await runStore.readResult();
    expect(attempt).toMatchObject({
      runId: RUN_ID,
      status: "failed",
      requestedVerification: [FORCED_RED],
      evidence: {
        baseline: {
          commands: [{ id: "forced-red", exitCode: 7, ok: false }],
        },
      },
    });
    expect(await runStore.readAutopilotEligibility()).toBeNull();
    expect(await runStore.readCandidateDecision()).toBeNull();
    await expect(lstat(path.join(store.workflowDirectory, FINAL_BRANCH_ARTIFACT_REF)))
      .rejects.toMatchObject({ code: "ENOENT" });

    expect(producer.invocations).toEqual([]);
    expect(await readFile(path.join(fixture.checkout, "base.txt"))).toEqual(fixture.baseBytes);
    expect(await runGit(fixture.checkout, ["rev-parse", "HEAD"])).toBe(fixture.baseCommitOid);
    expect(await runGit(fixture.checkout, ["status", "--porcelain=v1", "--untracked-files=all"]))
      .toBe("");
    expect(await runGit(fixture.checkout, ["rev-list", "--count", "--all"])).toBe("1");
    const branch = await branchManager.load(WORKFLOW_ID);
    expect(branch).not.toBeNull();
    expect(await runGit(branch!.worktreePath, ["rev-parse", "HEAD"])).toBe(fixture.baseCommitOid);
    await expect(readFile(path.join(branch!.worktreePath, "must-not-exist.txt")))
      .rejects.toMatchObject({ code: "ENOENT" });
  }, 120_000);
});
