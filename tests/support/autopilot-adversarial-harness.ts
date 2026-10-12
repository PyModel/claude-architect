import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect } from "vitest";
import { AutopilotController, type AutopilotControllerDependencies } from "../../src/autopilot/autopilot-controller.js";
import { WorkflowBranchManager, type RemoteTransport } from "../../src/autopilot/branch-manager.js";
import { CandidatePromoter } from "../../src/autopilot/candidate-promoter.js";
import { FinalBranchReviewer } from "../../src/autopilot/final-branch-reviewer.js";
import type { AutopilotWorkflowState } from "../../src/autopilot/types.js";
import { WorkflowStore } from "../../src/autopilot/workflow-store.js";
import { manifestHashOf } from "../../src/git/changed-path-manifest.js";
import { git } from "../../src/git/git-exec.js";
import { withRepoLock } from "../../src/mcp/serialize.js";
import { runAdvisorStage } from "../../src/pipeline/advisor-stage.js";
import { runPipeline, type PipelineDependencies } from "../../src/pipeline/pipeline-runtime.js";
import type { AdvisorReport, ReviewReport } from "../../src/pipeline/report-types.js";
import type { RoleRunArgs, RoleRunResult } from "../../src/pipeline/role-runner.js";
import { SANDBOX_BACKENDS } from "../../src/platform/sandbox/backends.js";
import type { ResolvedExecutable } from "../../src/platform/platform-services.js";
import { getPlatformServices } from "../../src/platform/select-platform.js";
import type { AutopilotSpec } from "../../src/protocol/autopilot-spec.js";
import type { CandidateArtifact } from "../../src/protocol/attempt-result.js";
import type { DelegationSpec } from "../../src/protocol/delegation-spec.js";
import type { CapabilityReport, InvocationContext, ProbeContext, ProducerAdapter, ProducerConfigurationProfile, ProducerInvocation } from "../../src/producers/producer-adapter.js";
import { ProducerRegistry } from "../../src/producers/producer-registry.js";
import { ArtifactStore } from "../../src/runtime/artifact-store.js";
import type { AttemptRuntimeDependencies } from "../../src/runtime/attempt-runtime.js";
import { createReviewSnapshot } from "../../src/runtime/review-snapshot.js";
import { AcceptanceVerifier } from "../../src/verify/acceptance-verifier.js";

export const editFixture = fileURLToPath(new URL("../runtime/fixtures/edit-file.mjs", import.meta.url));
export const NOW = "2026-07-21T12:00:00.000Z";
export const REMOTE_URL = "https://github.com/example/autopilot-adversarial.git";
export const temporaryPaths: string[] = [];
const originalEnvironment = new Map<string, string | undefined>();
let sandboxState: "certified" | "tested" | "unsupported" | undefined;
export let fixtureNumber = 0;

export const nodeExecutable: ResolvedExecutable = {
  kind: "native",
  command: process.execPath,
  prefixArgs: [],
  resolvedFrom: "autopilot-adversarial-fixture",
};

export async function runGit(cwd: string, args: string[], indexFile?: string): Promise<string> {
  const result = await git(cwd, args, indexFile);
  expect(result.exitCode, result.stderr || result.stdout).toBe(0);
  return result.stdout.trim();
}

export function localRemoteTransport(bareRemote: string): RemoteTransport {
  return {
    fetch: (cwd, _canonicalUrl, sourceRef, destinationRef) => git(cwd, [
      "fetch", "--no-tags", bareRemote, `${sourceRef}:${destinationRef}`,
    ]),
    listHeads: cwd => git(cwd, ["ls-remote", "--heads", bareRemote]),
  };
}

export async function createRepository(root: string): Promise<{
  bareRemote: string;
  checkout: string;
  baseCommitOid: string;
}> {
  const bareRemote = path.join(root, `remote-${++fixtureNumber}.git`);
  const checkout = path.join(root, `checkout-${fixtureNumber}`);
  await Promise.all([mkdir(bareRemote), mkdir(checkout)]);
  await runGit(bareRemote, ["init", "--bare", "-q"]);
  await runGit(checkout, ["init", "-q", "-b", "main"]);
  await runGit(checkout, ["config", "user.name", "Autopilot Adversarial"]);
  await runGit(checkout, ["config", "user.email", "autopilot-adversarial@example.invalid"]);
  await writeFile(path.join(checkout, "base.txt"), "base bytes\n");
  await runGit(checkout, ["add", "base.txt"]);
  await runGit(checkout, ["commit", "-q", "-m", "base"]);
  await runGit(checkout, ["remote", "add", "origin", REMOTE_URL]);
  const baseCommitOid = await runGit(checkout, ["rev-parse", "HEAD"]);
  await runGit(checkout, ["push", bareRemote, "main:main"]);
  return {
    bareRemote: await realpath(bareRemote),
    checkout: await realpath(checkout),
    baseCommitOid,
  };
}

export type ProducerMode = "normal" | "cancel" | "oversize";

export class AdversarialProducer implements ProducerAdapter {
  readonly producerId = "codex";
  invocationStarted: (() => void) | undefined;

  constructor(private readonly mode: ProducerMode) {}

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
    this.invocationStarted?.();
    if (this.mode === "cancel") {
      return {
        executable: nodeExecutable,
        args: ["-e", "setInterval(()=>{},1000)"],
        requiredEnv: [],
        network: "denied",
      };
    }
    if (this.mode === "oversize") {
      return {
        executable: nodeExecutable,
        args: [
          "-e",
          "require('node:fs').writeFileSync('candidate.txt','candidate bytes\\n');process.stdout.write('x'.repeat(2000000))",
        ],
        requiredEnv: [],
        network: "denied",
      };
    }
    return {
      executable: nodeExecutable,
      args: [editFixture, "candidate.txt", "candidate bytes\n", "0"],
      requiredEnv: [],
      network: "denied",
    };
  }

  normalizeEvents(
    raw: Parameters<ProducerAdapter["normalizeEvents"]>[0],
  ): ReturnType<ProducerAdapter["normalizeEvents"]> {
    if (raw.exit.truncated.stdout || raw.exit.truncated.stderr
      || raw.exit.cancelled || raw.exit.exitCode !== 0) {
      return {
        events: [{ kind: "error", text: "producer-output-rejected" }],
        producerSummary: null,
        ok: false,
      };
    }
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

export const approvingReview: ReviewReport = {
  reportVersion: "1",
  verdict: "approve",
  findings: [],
  coverageGaps: [],
};

export const approvingAdvisor: AdvisorReport = {
  reportVersion: "1",
  verdict: "approve",
  rationale: "The frozen evidence proves the requested outcome.",
  risks: [],
  coverageGaps: [],
};

export function approvingRoleRunner(args: RoleRunArgs): Promise<RoleRunResult> {
  const report = args.role === "advisor" ? approvingAdvisor : approvingReview;
  return Promise.resolve({
    ok: true,
    rawOutput: `\`\`\`json\n${JSON.stringify(report)}\n\`\`\``,
    failure: null,
    producerId: "adversarial-producer",
  });
}

export function delegation(overrides: Partial<DelegationSpec> = {}): DelegationSpec {
  return {
    specVersion: "1",
    objective: "produce the isolated candidate",
    context: "Only candidate.txt is in scope.",
    writeAllowlist: ["candidate.txt"],
    forbiddenScope: [],
    successCriteria: ["candidate.txt contains the expected bytes"],
    verification: [{
      id: "candidate-green",
      executable: "node",
      args: ["-e", "process.exit(0)"],
      cwd: ".",
      timeoutMs: 30_000,
      network: "denied",
      expectedExitCodes: [0],
    }],
    executionMode: "edit",
    timeoutMs: 600_000,
    producerPreferences: ["codex"],
    expectedOutput: "candidate-patch",
    review: { reviewers: ["correctness", "systems"], maxRounds: 1 },
    ...overrides,
  };
}

export function autopilotSpec(overrides: Partial<AutopilotSpec> = {}): AutopilotSpec {
  return {
    specVersion: "2",
    topic: "adversarial",
    base: { remote: "origin", branch: "main" },
    tasks: [{
      id: "task-one",
      commitMessage: "feat: promote exact candidate",
      delegation: delegation(),
    }],
    finalSuccessCriteria: ["The promoted candidate is present."],
    finalVerification: [{
      id: "final-green",
      executable: "node",
      args: ["-e", "process.exit(0)"],
      cwd: ".",
      timeoutMs: 30_000,
      network: "denied",
      expectedExitCodes: [0],
    }],
    ...overrides,
  };
}

export interface HarnessOptions {
  mode?: ProducerMode;
  abortSignal?: AbortSignal;
  afterEligibility?: (runId: string, state: AutopilotWorkflowState) => Promise<void>;
  afterPromotion?: () => void;
}

export async function createHarness(options: HarnessOptions = {}) {
  const root = temporaryPaths[0]!;
  const fixture = await createRepository(root);
  const platformServices = getPlatformServices();
  const producer = new AdversarialProducer(options.mode ?? "normal");
  const registry = new ProducerRegistry([producer]);
  let nextRun = 0;
  const attemptDependencies: AttemptRuntimeDependencies = {
    ps: platformServices,
    producerRegistry: registry,
    verifier: new AcceptanceVerifier(),
    runId: () => `adversarial-run-${++nextRun}-${fixtureNumber}`,
    env: {},
    packagedVerifier: { version: "adversarial", content: "trusted verifier" },
    ...(options.abortSignal === undefined ? {} : { abortSignal: options.abortSignal }),
  };
  const pipelineDependencies: PipelineDependencies = {
    ...attemptDependencies,
    registry,
    roleRunner: approvingRoleRunner,
  };
  const workflowId = `workflow-adversarial-${fixtureNumber}`;
  const branchManager = new WorkflowBranchManager({
    platformServices,
    remoteTransport: localRemoteTransport(fixture.bareRemote),
  });
  const workflowStore = (id: string) => new WorkflowStore(id);
  // The hand-off (cleanup that keeps the final-reviewed branch) is the one
  // consequential mutation left after promotion; attacks must never reach it.
  const handoffs: string[] = [];
  const dependencies: AutopilotControllerDependencies = {
    workflowId: () => workflowId,
    now: () => NOW,
    workflowLock: {
      runExclusive: (id, operation) => withRepoLock(`autopilot:${id}`, operation),
    },
    workflowStore,
    repositoryIdentity: async checkoutPath => {
      const canonical = await platformServices.canonicalizePath(checkoutPath);
      return canonical.gitCommonDir ?? canonical.canonical;
    },
    branchManager: {
      create: request => branchManager.create(request),
      load: workflowId => branchManager.load(workflowId),
      revalidate: (identity, expectedHead) => branchManager.revalidate(identity, expectedHead),
      cleanup: async (identity, expectedHead, cleanupOptions) => {
        if (cleanupOptions?.retainBranch === true) handoffs.push(expectedHead ?? identity.baseCommitOid);
        return await branchManager.cleanup(identity, expectedHead, cleanupOptions);
      },
    },
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
      async evaluate({ workflow, branch, task, pipelineResult, reviewSnapshot }) {
        const eligibility = (await runAdvisorStage({
          runId: pipelineResult.runId,
          spec: task.delegation,
          worktreePath: branch.worktreePath,
          deps: pipelineDependencies,
          evaluatedAt: NOW,
          pipelineResult,
          reviewSnapshot,
        })).eligibility;
        await options.afterEligibility?.(pipelineResult.runId, workflow);
        return eligibility;
      },
    },
    promoter: {
      async promote(request) {
        const result = await new CandidatePromoter({
          platformServices,
          branchManager,
          workflowStore,
          now: () => NOW,
        }).promote(request);
        options.afterPromotion?.();
        return result;
      },
    },
    finalBranchReviewer: new FinalBranchReviewer({
      platformServices,
      branchManager,
      workflowStore,
      producerRegistry: registry,
      roleRunner: approvingRoleRunner,
      now: () => NOW,
    }),
    ...(options.abortSignal === undefined ? {} : { abortSignal: options.abortSignal }),
  };
  return {
    controller: new AutopilotController(dependencies),
    fixture,
    workflowId,
    store: new WorkflowStore(workflowId),
    producer,
    handoffs,
    branchManager,
  };
}

export async function candidateWorktreeFixture() {
  const root = temporaryPaths[0]!;
  const fixture = await createRepository(root);
  const worktreePath = path.join(root, `candidate-worktree-${fixtureNumber}`);
  await runGit(fixture.checkout, [
    "worktree", "add", "--detach", "-q", worktreePath, fixture.baseCommitOid,
  ]);
  return { ...fixture, worktreePath: await realpath(worktreePath) };
}

export async function candidateArtifactWithEntries(
  fixture: Awaited<ReturnType<typeof createRepository>>,
  entries: Array<{ path: string; mode: "100644" | "120000" }>,
  forgeInvalidManifest = false,
): Promise<CandidateArtifact> {
  const root = temporaryPaths[0]!;
  const payload = path.join(root, `candidate-payload-${fixtureNumber}`);
  const indexFile = path.join(root, `candidate-index-${fixtureNumber}`);
  await writeFile(payload, "candidate payload\n");
  const blobOid = await runGit(fixture.checkout, ["hash-object", "-w", payload]);
  await runGit(fixture.checkout, ["read-tree", fixture.baseCommitOid], indexFile);
  for (const entry of entries) {
    await runGit(fixture.checkout, [
      "update-index", "--add", "--cacheinfo", `${entry.mode},${blobOid},${entry.path}`,
    ], indexFile);
  }
  const candidateTreeOid = await runGit(fixture.checkout, ["write-tree"], indexFile);
  const candidateCommitOid = await runGit(fixture.checkout, [
    "commit-tree", candidateTreeOid, "-p", fixture.baseCommitOid, "-m", "adversarial candidate",
  ]);
  const anchorRef = `refs/claude-architect/candidates/adversarial-${fixtureNumber}`;
  await runGit(fixture.checkout, ["update-ref", anchorRef, candidateCommitOid]);
  const changedPaths: CandidateArtifact["changedPaths"] = entries.map(entry => ({
    path: entry.path,
    changeType: "added" as const,
    mode: entry.mode,
    contentHash: blobOid,
  })).sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  return {
    baseCommitOid: fixture.baseCommitOid,
    candidateTreeOid,
    candidateCommitOid,
    anchorRef,
    changedPaths,
    manifestHash: forgeInvalidManifest
      ? createHash("sha256").update(JSON.stringify(changedPaths)).digest("hex")
      : manifestHashOf(changedPaths),
    patch: "",
  };
}

export function installAutopilotAdversarialHooks(): void {
  beforeEach(async () => {
    for (const key of ["CLAUDE_PLUGIN_DATA", "NODE_ENV", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM"]) {
      originalEnvironment.set(key, process.env[key]);
    }
    const root = await realpath(await mkdtemp(path.join(tmpdir(), "ca-autopilot-adversarial-")));
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
    if (platform === undefined) throw new Error("no platform sandbox fixture");
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
}
