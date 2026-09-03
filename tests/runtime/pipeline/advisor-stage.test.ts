import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ArtifactStore } from "../../../src/runtime/artifact-store.js";
import { initializeRunStart } from "../../../src/runtime/run-start.js";
import { runAdvisorStage, type AdvisorStageStore } from "../../../src/pipeline/advisor-stage.js";
import { buildRoleSpec } from "../../../src/pipeline/role-prompts.js";
import type { PipelineDependencies } from "../../../src/pipeline/pipeline-runtime.js";
import type { RoleRunArgs } from "../../../src/pipeline/role-runner.js";
import { advisorReport, autopilotSpec, pipelineResult, reviewSnapshot } from "./autopilot-fixtures.js";

const temporaryRoots: string[] = [];
let previousPluginData: string | undefined;

beforeEach(async () => {
  previousPluginData = process.env.CLAUDE_PLUGIN_DATA;
  const root = await mkdtemp(path.join(tmpdir(), "ca-advisor-stage-"));
  temporaryRoots.push(root);
  process.env.CLAUDE_PLUGIN_DATA = root;
});

afterEach(async () => {
  if (previousPluginData === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
  else process.env.CLAUDE_PLUGIN_DATA = previousPluginData;
  await Promise.all(temporaryRoots.splice(0).map(root =>
    rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })));
});

describe("runAdvisorStage", () => {
  it("uses only the exact durable package in a fresh read-only structured role", async () => {
    const pipeline = pipelineResult();
    const snapshot = reviewSnapshot();
    const spec = autopilotSpec();
    const roleCalls: RoleRunArgs[] = [];
    const persisted: unknown[] = [];
    const store: AdvisorStageStore = {
      async readPipelineArtifact<T>(name: string) {
        return structuredClone(name === "delegation-spec" ? spec : pipeline) as T;
      },
      async readReviewSnapshot() { return structuredClone(snapshot); },
      async writeLog(name) { return `logs/${name}.log`; },
      async writePostPipelineAutopilotArtifacts(value) {
        persisted.push(structuredClone(value));
        return { advisorReportHash: value.eligibility.advisorReportHash, eligibilityRecordHash: "f".repeat(64) };
      },
    };
    const roleRunner = vi.fn(async (args: RoleRunArgs) => {
      roleCalls.push(args);
      return {
        ok: true,
        rawOutput: `\`\`\`json\n${JSON.stringify(advisorReport)}\n\`\`\``,
        failure: null,
        producerId: "codex",
      };
    });

    const result = await runAdvisorStage({
      runId: pipeline.runId,
      spec,
      worktreePath: "/candidate",
      deps: {
        roleRunner,
        ps: {} as never,
        registry: {} as never,
      } as unknown as PipelineDependencies,
      evaluatedAt: "2026-07-20T12:00:00.000Z",
      store,
      pipelineResult: pipeline,
      reviewSnapshot: snapshot,
    });

    expect(result.eligibility).toMatchObject({ eligible: true, reasons: [] });
    expect(roleCalls).toHaveLength(1);
    const call = roleCalls[0]!;
    expect(call.role).toBe("advisor");
    expect(call.pkg.advisorEvidence?.reviewSnapshot).toEqual(snapshot);
    expect(call.pkg.advisorEvidence?.reviewAndFixHistory).toEqual(pipeline.rounds);
    expect(call.pkg.baselineCommit).toBe(snapshot.baseCommitOid);
    expect(call.pkg.candidateCommit).toBe(snapshot.candidateCommitOid);
    expect(call.pkg.candidateDiff).toBe(snapshot.patch);
    expect(call.baseSpec.context).not.toContain("PEER-CONVERSATION-MUST-NOT-BE-SHARED");
    const roleSpec = buildRoleSpec(call.role, call.baseSpec, call.pkg);
    expect(roleSpec.writeAllowlist).toEqual([]);
    expect(roleSpec.forbiddenScope).toEqual(["**/*"]);
    expect(roleSpec.context).toContain("READ-ONLY final advisor in a fresh session");
    expect(roleSpec.context).toContain("cannot edit files, mutate Git or process state");
    expect(roleSpec.context).toContain("call MCP decision tools");
    expect(roleSpec.context).not.toContain("PEER-CONVERSATION-MUST-NOT-BE-SHARED");
    expect(persisted).toHaveLength(1);
  });

  it("includes prior repair dispositions in the frozen evidence for the final re-review", async () => {
    const pipeline = pipelineResult();
    const snapshot = reviewSnapshot();
    const spec = autopilotSpec();
    const finalRound = pipeline.rounds[0]!;
    const disposition = {
      findingId: "F-001",
      disposition: "fixed" as const,
      evidence: "The race regression now passes.",
      commit: pipeline.finalCandidateCommit,
    };
    pipeline.rounds = [{
      ...structuredClone(finalRound),
      round: 1,
      fix: {
        reportVersion: "1",
        candidateCommit: pipeline.finalCandidateCommit,
        dispositions: [disposition],
      },
    }, {
      ...structuredClone(finalRound),
      round: 2,
    }];
    let capturedHistory: unknown;
    const store: AdvisorStageStore = {
      async readPipelineArtifact<T>(name: string) {
        return structuredClone(name === "delegation-spec" ? spec : pipeline) as T;
      },
      async readReviewSnapshot() { return structuredClone(snapshot); },
      async writeLog(name) { return `logs/${name}.log`; },
      async writePostPipelineAutopilotArtifacts(value) {
        return {
          advisorReportHash: value.eligibility.advisorReportHash,
          eligibilityRecordHash: "f".repeat(64),
        };
      },
    };

    await runAdvisorStage({
      runId: pipeline.runId,
      spec,
      worktreePath: "/candidate",
      deps: {
        roleRunner: async (args: RoleRunArgs) => {
          capturedHistory = structuredClone(args.pkg.advisorEvidence?.reviewAndFixHistory);
          return {
            ok: true,
            rawOutput: `\`\`\`json\n${JSON.stringify(advisorReport)}\n\`\`\``,
            failure: null,
            producerId: "codex",
          };
        },
      } as unknown as PipelineDependencies,
      evaluatedAt: "2026-07-20T12:00:00.000Z",
      store,
    });

    expect(capturedHistory).toEqual(pipeline.rounds);
    expect(capturedHistory).toEqual(expect.arrayContaining([
      expect.objectContaining({
        fix: expect.objectContaining({ dispositions: [disposition] }),
      }),
    ]));
  });

  it("persists a deterministic red record when advisor execution fails", async () => {
    const pipeline = pipelineResult();
    const snapshot = reviewSnapshot();
    const spec = autopilotSpec();
    let persisted: Parameters<AdvisorStageStore["writePostPipelineAutopilotArtifacts"]>[0] | null = null;
    const store: AdvisorStageStore = {
      async readPipelineArtifact<T>(name: string) {
        return structuredClone(name === "delegation-spec" ? spec : pipeline) as T;
      },
      async readReviewSnapshot() { return structuredClone(snapshot); },
      async writeLog(name) { return `logs/${name}.log`; },
      async writePostPipelineAutopilotArtifacts(value) {
        persisted = value;
        return { advisorReportHash: value.eligibility.advisorReportHash, eligibilityRecordHash: "f".repeat(64) };
      },
    };
    const result = await runAdvisorStage({
      runId: pipeline.runId,
      spec,
      worktreePath: "/candidate",
      deps: {
        roleRunner: async () => ({
          ok: false,
          rawOutput: "",
          failure: "timeout",
          producerId: "codex",
        }),
        ps: {} as never,
        registry: {} as never,
      } as unknown as PipelineDependencies,
      evaluatedAt: "2026-07-20T12:00:00.000Z",
      store,
    });

    expect(result).toMatchObject({
      failure: "timeout",
      report: { verdict: "human-decision-required" },
      eligibility: { eligible: false },
    });
    expect(persisted).not.toBeNull();
  });

  it("classifies a thrown advisor execution failure and persists a durable red record", async () => {
    const pipeline = pipelineResult();
    const snapshot = reviewSnapshot();
    const spec = autopilotSpec();
    let persisted: Parameters<AdvisorStageStore["writePostPipelineAutopilotArtifacts"]>[0] | null = null;
    let failureLog: { name: string; text: string } | null = null;
    const store: AdvisorStageStore = {
      async readPipelineArtifact<T>(name: string) {
        return structuredClone(name === "delegation-spec" ? spec : pipeline) as T;
      },
      async readReviewSnapshot() { return structuredClone(snapshot); },
      async writeLog(name, text) {
        failureLog = { name, text };
        return `logs/${name}.log`;
      },
      async writePostPipelineAutopilotArtifacts(value) {
        persisted = structuredClone(value);
        return {
          advisorReportHash: value.eligibility.advisorReportHash,
          eligibilityRecordHash: "f".repeat(64),
        };
      },
    };

    const result = await runAdvisorStage({
      runId: pipeline.runId,
      spec,
      worktreePath: "/candidate",
      deps: {
        roleRunner: async () => { throw new Error("launch failed"); },
      } as unknown as PipelineDependencies,
      evaluatedAt: "2026-07-20T12:00:00.000Z",
      store,
    });

    expect(result).toMatchObject({
      failure: "producer-failure",
      report: { verdict: "human-decision-required" },
      eligibility: { eligible: false },
      roleLogRefs: ["logs/role-advisor-final.log"],
    });
    expect(failureLog).toEqual({
      name: "role-advisor-final",
      text: expect.stringContaining("Error: launch failed"),
    });
    expect(persisted).not.toBeNull();
  });

  it("does not convert post-advisor persistence failures into execution outcomes", async () => {
    const pipeline = pipelineResult();
    const snapshot = reviewSnapshot();
    const spec = autopilotSpec();
    const store: AdvisorStageStore = {
      async readPipelineArtifact<T>(name: string) {
        return structuredClone(name === "delegation-spec" ? spec : pipeline) as T;
      },
      async readReviewSnapshot() { return structuredClone(snapshot); },
      async writeLog(name) { return `logs/${name}.log`; },
      async writePostPipelineAutopilotArtifacts() { throw new Error("archive failed"); },
    };

    await expect(runAdvisorStage({
      runId: pipeline.runId,
      spec,
      worktreePath: "/candidate",
      deps: {
        roleRunner: async () => ({
          ok: true,
          rawOutput: `\`\`\`json\n${JSON.stringify(advisorReport)}\n\`\`\``,
          failure: null,
          producerId: "codex",
        }),
      } as unknown as PipelineDependencies,
      evaluatedAt: "2026-07-20T12:00:00.000Z",
      store,
    })).rejects.toThrow(/archive failed/u);
  });

  // The catch in runAdvisorStage exists so a pre-terminal throw does not leave
  // the persisted RunStatus stuck on "advisor" forever, which is what makes an
  // interrupted run recoverable. The throw-path tests asserted only that the
  // promise rejected, never that the transition happened.
  it("moves the run to a terminal status when an early guard throws", async () => {
    const pipeline = pipelineResult();
    const archivedSpec = autopilotSpec();
    const statusStore = new ArtifactStore(pipeline.runId);
    await initializeRunStart(statusStore, {
      runId: pipeline.runId,
      lockKey: "advisor-stage-lock",
      canonicalCommonDir: "/repo/.git",
      pid: null,
      processToken: null,
      startedAt: "2026-07-20T11:59:00.000Z",
    });
    // transitionRunStatusSafely only UPDATES an existing status, so the run
    // needs one before the stage can move it to a terminal phase.
    await statusStore.writeRunStatus({
      statusVersion: "1",
      runId: pipeline.runId,
      mode: "single",
      phase: "preflight",
      sliceIndex: null,
      sliceCount: null,
      round: null,
      role: null,
      producerId: null,
      startedAt: "2026-07-20T11:59:00.000Z",
      updatedAt: "2026-07-20T11:59:00.000Z",
      detail: null,
    });
    const store: AdvisorStageStore = {
      async readPipelineArtifact<T>(name: string) {
        return structuredClone(name === "delegation-spec" ? archivedSpec : pipeline) as T;
      },
      async readReviewSnapshot() { return structuredClone(reviewSnapshot()); },
      async writeLog() { throw new Error("advisor must not launch"); },
      async writePostPipelineAutopilotArtifacts() { throw new Error("must not persist"); },
    };

    await expect(runAdvisorStage({
      runId: pipeline.runId,
      spec: { ...archivedSpec, successCriteria: ["weakened"] },
      worktreePath: "/candidate",
      deps: {} as PipelineDependencies,
      evaluatedAt: "2026-07-20T12:00:00.000Z",
      store,
    })).rejects.toThrow(/differs from the durable archived specification/u);

    await expect(statusStore.readRunStatus())
      .resolves.toMatchObject({ phase: "failed", role: "advisor" });
  });

  it("rejects caller-controlled criteria that differ from the archived specification", async () => {
    const pipeline = pipelineResult();
    const snapshot = reviewSnapshot();
    const archivedSpec = autopilotSpec();
    const store: AdvisorStageStore = {
      async readPipelineArtifact<T>(name: string) {
        return structuredClone(name === "delegation-spec" ? archivedSpec : pipeline) as T;
      },
      async readReviewSnapshot() { return structuredClone(snapshot); },
      async writeLog() { throw new Error("advisor must not launch"); },
      async writePostPipelineAutopilotArtifacts() { throw new Error("must not persist"); },
    };

    await expect(runAdvisorStage({
      runId: pipeline.runId,
      spec: { ...archivedSpec, successCriteria: ["weakened"] },
      worktreePath: "/candidate",
      deps: {} as PipelineDependencies,
      evaluatedAt: "2026-07-20T12:00:00.000Z",
      store,
    })).rejects.toThrow(/differs from the durable archived specification/u);
  });

  it("fails closed without launching when the exact frozen package exceeds the role input bound", async () => {
    const pipeline = pipelineResult();
    const snapshot = { ...reviewSnapshot(), patch: `diff\n${"x".repeat(210_000)}` };
    const spec = autopilotSpec();
    let launched = false;
    let persisted: Parameters<AdvisorStageStore["writePostPipelineAutopilotArtifacts"]>[0] | null = null;
    const store: AdvisorStageStore = {
      async readPipelineArtifact<T>(name: string) {
        return structuredClone(name === "delegation-spec" ? spec : pipeline) as T;
      },
      async readReviewSnapshot() { return structuredClone(snapshot); },
      async writeLog(name, text) {
        expect(name).toBe("role-advisor-final");
        expect(text).toContain("exact frozen evidence package exceeds");
        return "logs/role-advisor-final.log";
      },
      async writePostPipelineAutopilotArtifacts(value) { persisted = value; return {
        advisorReportHash: value.eligibility.advisorReportHash,
        eligibilityRecordHash: "f".repeat(64),
      }; },
    };

    const result = await runAdvisorStage({
      runId: pipeline.runId,
      spec,
      worktreePath: "/candidate",
      deps: {
        roleRunner: async () => {
          launched = true;
          throw new Error("must not launch");
        },
      } as unknown as PipelineDependencies,
      evaluatedAt: "2026-07-20T12:00:00.000Z",
      store,
    });

    expect(launched).toBe(false);
    expect(result).toMatchObject({ failure: "invalid-output", eligibility: { eligible: false } });
    expect(persisted).not.toBeNull();
  });
});
