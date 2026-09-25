import { fileURLToPath } from "node:url";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AutopilotController } from "../../../src/autopilot/autopilot-controller.js";
import { WorkflowBranchManager, type RemoteTransport } from "../../../src/autopilot/branch-manager.js";
import { CandidatePromoter } from "../../../src/autopilot/candidate-promoter.js";
import {
  FINAL_BRANCH_ARTIFACT_REF,
  FinalBranchReviewer,
  type CumulativeBranchArtifact,
} from "../../../src/autopilot/final-branch-reviewer.js";
import { WorkflowStore } from "../../../src/autopilot/workflow-store.js";
import { git, type GitResult } from "../../../src/git/git-exec.js";
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
const WORKFLOW_ID = "workflow-e2e-12345678";
const NOW = "2026-07-21T12:00:00.000Z";
const REMOTE_URL = "https://github.com/example/autopilot-fixture.git";
const nodeExecutable: ResolvedExecutable = {
  kind: "native",
  command: process.execPath,
  prefixArgs: [],
  resolvedFrom: "autopilot-e2e-fixture",
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
}> {
  const bareRemote = path.join(root, "remote.git");
  const checkout = path.join(root, "human-checkout");
  await mkdir(bareRemote);
  await mkdir(checkout);
  await runGit(bareRemote, ["init", "--bare", "-q"]);
  await runGit(checkout, ["init", "-q", "-b", "main"]);
  await runGit(checkout, ["config", "user.name", "Autopilot E2E"]);
  await runGit(checkout, ["config", "user.email", "autopilot-e2e@example.invalid"]);
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

async function workingTreeSnapshot(directory: string): Promise<Record<string, string>> {
  const snapshot: Record<string, string> = {};
  const visit = async (current: string, relative: string): Promise<void> => {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (relative === "" && entry.name === ".git") continue;
      const childRelative = relative === "" ? entry.name : `${relative}/${entry.name}`;
      const child = path.join(current, entry.name);
      if (entry.isDirectory()) await visit(child, childRelative);
      else if (entry.isFile()) snapshot[childRelative] = (await readFile(child)).toString("base64");
      else snapshot[childRelative] = `special:${entry.isSymbolicLink() ? "symlink" : "other"}`;
    }
  };
  await visit(directory, "");
  return snapshot;
}

async function lockFiles(root: string): Promise<string[]> {
  const locks: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      const child = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(child);
      else if (entry.name.endsWith(".lock") || entry.name === "owner.json") locks.push(child);
    }
  };
  await visit(root);
  return locks.sort();
}

class IsolatedFakeProducer implements ProducerAdapter {
  readonly producerId = "codex";
  readonly invocations: string[] = [];

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

  buildInvocation(spec: DelegationSpec, _context: InvocationContext): ProducerInvocation {
    // The Producer environment probe runs before each real attempt and carries a
    // rewritten objective. Labelling it keeps it visible here instead of being
    // silently counted as the task it precedes.
    if (spec.objective.includes("This is an environment probe")) {
      this.invocations.push("probe");
      return {
        executable: nodeExecutable,
        args: ["-e", "process.stdout.write('probe');"],
        requiredEnv: [],
        network: "denied",
      };
    }
    const task = spec.objective.includes("task one") ? "task-one" : "task-two";
    this.invocations.push(task);
    return {
      executable: nodeExecutable,
      args: [editFixture, `${task}.txt`, `${task} promoted bytes\n`, "0"],
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

const approvingReview: ReviewReport = {
  reportVersion: "1",
  verdict: "approve",
  findings: [],
  coverageGaps: [],
};

const approvingAdvisor: AdvisorReport = {
  reportVersion: "1",
  verdict: "approve",
  rationale: "The frozen evidence proves every requested outcome.",
  risks: [],
  coverageGaps: [],
};

function approvingRoleRunner(args: RoleRunArgs): Promise<RoleRunResult> {
  const report = args.role === "advisor" ? approvingAdvisor : approvingReview;
  return Promise.resolve({
    ok: true,
    rawOutput: `\`\`\`json\n${JSON.stringify(report)}\n\`\`\``,
    failure: null,
    producerId: "isolated-fake-producer",
  });
}

function delegation(task: "one" | "two"): DelegationSpec {
  return {
    specVersion: "1",
    objective: `implement task ${task}`,
    context: "Only the task-specific fixture file is in scope.",
    writeAllowlist: [`task-${task}.txt`],
    forbiddenScope: [],
    successCriteria: [`task-${task}.txt contains the promoted bytes`],
    verification: [{
      id: `task-${task}-green`,
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
  };
}

function autopilotSpec(): AutopilotSpec {
  return {
    specVersion: "2",
    topic: "e2e-green",
    base: { remote: "origin", branch: "main" },
    tasks: [{
      id: "task-one",
      commitMessage: "feat: promote task one",
      delegation: delegation("one"),
    }, {
      id: "task-two",
      commitMessage: "feat: promote task two",
      delegation: delegation("two"),
    }],
    finalSuccessCriteria: ["Both promoted task files are present."],
    finalVerification: [{
      id: "final-green",
      executable: "node",
      args: [
        "-e",
        "const fs=require('node:fs');process.exit(fs.readFileSync('task-one.txt','utf8')==='task-one promoted bytes\\n'&&fs.readFileSync('task-two.txt','utf8')==='task-two promoted bytes\\n'?0:1)",
      ],
      cwd: ".",
      timeoutMs: 30_000,
      network: "denied",
      expectedExitCodes: [0],
    }],
  };
}

beforeEach(async () => {
  for (const key of ["CLAUDE_PLUGIN_DATA", "NODE_ENV", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM"]) {
    originalEnvironment.set(key, process.env[key]);
  }
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "ca-autopilot-e2e-")));
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

describe("AutopilotController end-to-end", () => {
  it("promotes two exact commits, freezes cumulative evidence, and hands off the reviewed branch", async () => {
    const root = temporaryPaths[0]!;
    const stateRoot = process.env.CLAUDE_PLUGIN_DATA!;
    const fixture = await createRepository(root);
    const humanBefore = await workingTreeSnapshot(fixture.checkout);
    const platformServices = getPlatformServices();
    const producer = new IsolatedFakeProducer();
    const producerRegistry = new ProducerRegistry([producer]);
    let nextRun = 0;
    const attemptDependencies: AttemptRuntimeDependencies = {
      ps: platformServices,
      producerRegistry,
      verifier: new AcceptanceVerifier(),
      runId: () => `autopilot-e2e-task-${++nextRun}`,
      env: {},
      packagedVerifier: { version: "e2e", content: "trusted autopilot e2e verifier" },
    };
    const pipelineDependencies: PipelineDependencies = {
      ...attemptDependencies,
      registry: producerRegistry,
      roleRunner: approvingRoleRunner,
    };
    const branchManager = new WorkflowBranchManager({
      platformServices,
      remoteTransport: localRemoteTransport(fixture.bareRemote),
    });
    const workflowStore = (workflowId: string) => new WorkflowStore(workflowId);
    const controller = new AutopilotController({
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
        roleRunner: approvingRoleRunner,
        now: () => NOW,
      }),
    });

    const result = await controller.start(fixture.checkout, autopilotSpec());

    expect(result.phase).toBe("ready-for-human-review");
    expect(result.terminal?.classification).toBe("ready-for-human-review");
    expect(result.tasks.map(task => task.status)).toEqual(["promoted", "promoted"]);
    expect(producer.invocations.filter(name => name !== "probe"))
      .toEqual(["task-one", "task-two"]);
    // The final-reviewed branch survives cleanup as the hand-off to the
    // delivery gate; nothing was pushed.
    expect(await runGit(fixture.checkout, ["rev-parse", `refs/heads/${result.branch}`]))
      .toBe(result.headCommitOid);
    expect((await git(fixture.bareRemote, ["show-ref", "--verify", "--quiet", `refs/heads/${result.branch}`])).exitCode)
      .toBe(1);
    expect(await runGit(fixture.checkout, [
      "log", "--reverse", "--format=%s", `${fixture.baseCommitOid}..${result.headCommitOid}`,
    ])).toBe("feat: promote task one\nfeat: promote task two");
    // Promotions are the user's commits, not the runtime's fixed identity.
    expect(await runGit(fixture.checkout, [
      "log", "--format=%an <%ae>|%cn", `${fixture.baseCommitOid}..${result.headCommitOid}`,
    ])).toBe([
      "Autopilot E2E <autopilot-e2e@example.invalid>|Autopilot E2E",
      "Autopilot E2E <autopilot-e2e@example.invalid>|Autopilot E2E",
    ].join("\n"));
    expect(await runGit(fixture.checkout, ["show", `${result.headCommitOid}:task-one.txt`]))
      .toBe("task-one promoted bytes");
    expect(await runGit(fixture.checkout, ["show", `${result.headCommitOid}:task-two.txt`]))
      .toBe("task-two promoted bytes");
    // The only runtime residue in the checkout is the self-ignoring namespace
    // marker; every worktree beneath it is gone.
    const { [".worktrees/claude-architect/.gitignore"]: namespaceMarker, ...humanAfter } =
      await workingTreeSnapshot(fixture.checkout);
    expect(humanAfter).toEqual(humanBefore);
    expect(Buffer.from(namespaceMarker ?? "", "base64").toString()).toBe("*\n");
    expect(await runGit(fixture.checkout, ["status", "--porcelain=v1", "--untracked-files=all"]))
      .toBe("");

    const store = new WorkflowStore(WORKFLOW_ID);
    const durable = await store.read();
    expect(durable).toEqual(expect.objectContaining({
      phase: "ready-for-human-review",
      terminal: expect.objectContaining({ classification: "ready-for-human-review" }),
      cleanup: expect.objectContaining({ status: "succeeded", worktreeRemoved: true }),
    }));
    const evidence = JSON.parse(await readFile(
      path.join(store.workflowDirectory, FINAL_BRANCH_ARTIFACT_REF),
      "utf8",
    )) as CumulativeBranchArtifact;
    expect(evidence.headCommitOid).toBe(result.headCommitOid);
    expect(evidence.taskEvidence.map(task => ({
      taskId: task.taskId,
      promotionCommitOid: task.promotionCommitOid,
    }))).toEqual(result.tasks.map(task => ({
      taskId: task.id,
      promotionCommitOid: task.promotionCommitOid,
    })));
    expect(evidence.taskEvidence).toHaveLength(2);

    expect(await branchManager.load(WORKFLOW_ID)).toBeNull();
    await expect(lstat(store.ownerPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await lockFiles(stateRoot)).toEqual([]);
    // git prints its own path format, which is forward-slashed on Windows;
    // resolve to the Node-canonical form the checkout path is recorded in.
    // `runGit` already asserts a zero exit, so empty output cannot pass silently.
    const registeredWorktrees = (await runGit(fixture.checkout, ["worktree", "list", "--porcelain"]))
      .split(/\r?\n/u).filter(line => line.startsWith("worktree "))
      .map(line => path.resolve(line.slice("worktree ".length)));
    expect(registeredWorktrees).toEqual([fixture.checkout]);
    await expect(readdir(path.join(fixture.checkout, ".worktrees", "claude-architect")))
      .resolves.toEqual([".gitignore"]);
  // Full-suite contention can push dual-commit promotion past 120s; scale gracefully.
  }, process.platform === "win32" ? 360_000 : 240_000);
});
