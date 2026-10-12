import { createHash } from "node:crypto";
import { readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { git } from "../../src/git/git-exec.js";
import { WorktreeManager } from "../../src/runtime/worktree-manager.js";
import { delegatePipelineOutput } from "../../src/mcp/server.js";
import { getPlatformServices } from "../../src/platform/select-platform.js";
import type { DelegationSpec } from "../../src/protocol/delegation-spec.js";
import { runPipeline, type PipelineDependencies } from "../../src/pipeline/pipeline-runtime.js";
import type { IncrementReport } from "../../src/pipeline/report-types.js";
import type { RoleRunArgs, RoleRunResult } from "../../src/pipeline/role-runner.js";
import { ArtifactStore } from "../../src/runtime/artifact-store.js";
import { registerSecretValue } from "../../src/runtime/redaction.js";
import { recoverStaleRuns } from "../../src/runtime/recovery-manager.js";
import { RunDecision } from "../../src/runtime/run-decision.js";
import { AcceptanceVerifier } from "../../src/verify/acceptance-verifier.js";
import { runGit, expectRefMissing, initRepo, validSpec, fenced, success, approve, artifactFor, attemptResult, failedAttemptResult, fakeAttempt, dependencies, implementationSpec, incrementRoleRunner, commitIncrement, initSlicedRepo, slicedSpec, commitRoleFile, installPipelineRuntimeHooks } from "../support/pipeline-runtime-harness.js";

installPipelineRuntimeHooks();

describe("runPipeline", () => {
  it("runs a completed increment, redacts and archives it, then reviews its diff", async () => {
    const repo = await initRepo();
    registerSecretValue("increment-secret-value");
    let reviewedDiff = "";
    const roleRunner = incrementRoleRunner(async args => {
      const commit = await commitIncrement(args, "increment complete\n");
      return success(fenced({
        reportVersion: "1",
        candidateCommit: commit,
        status: "complete",
        summary: "completed with increment-secret-value",
      }));
    });
    const observingRunner = async (args: RoleRunArgs): Promise<RoleRunResult> => {
      if (args.role === "reviewer-correctness") reviewedDiff = args.pkg.candidateDiff;
      return roleRunner(args);
    };

    const result = await runPipeline(
      repo,
      implementationSpec(3),
      dependencies({ runId: "pipeline-increment-complete", roleRunner: observingRunner }),
    );

    expect(result.status).toBe("decision-ready");
    expect(result.gate).toEqual({
      decisionReady: true,
      requiresHumanDecision: false,
      reasons: [],
    });
    expect(result.increments).toHaveLength(1);
    expect(result.increments[0]).toMatchObject({
      increment: 2,
      report: { status: "complete", summary: "completed with [s]" },
      roleLogRefs: ["logs/role-implementer-increment2.log"],
    });
    expect(reviewedDiff).toContain("increment complete");
    const store = new ArtifactStore("pipeline-increment-complete");
    await expect(store.readPipelineArtifact("increment-2"))
      .resolves.toMatchObject({ status: "complete", summary: "completed with [s]" });
    expect(delegatePipelineOutput.parse({ ok: true, result })).toMatchObject({
      result: { increments: [{ increment: 2, report: { status: "complete" } }] },
    });
    expect(delegatePipelineOutput.parse({ ok: true, result: { ...result, increments: [] } }))
      .toMatchObject({ result: { increments: [] } });
    // The wire schema must carry the sliced-pipeline fields through, not strip them.
    const parsed = delegatePipelineOutput.parse({ ok: true, result });
    expect(parsed.result).toHaveProperty("slices", []);
    expect(parsed.result).toHaveProperty("haltedSliceIndex", null);
    const sliced = delegatePipelineOutput.parse({
      ok: true,
      result: { ...result, slices: [{ index: 1, route: "advance" }], haltedSliceIndex: 2 },
    });
    expect(sliced.result?.slices).toEqual([{ index: 1, route: "advance" }]);
    expect(sliced.result?.haltedSliceIndex).toBe(2);
  }, 120_000);

  it("exhausts the increment budget after continued real progress and still reviews", async () => {
    const repo = await initRepo();
    let reviewerCalls = 0;
    const scripted = incrementRoleRunner(async (args, call) => {
      const commit = await commitIncrement(args, `increment ${call}\n`);
      return success(fenced({
        reportVersion: "1",
        candidateCommit: commit,
        status: "continue",
        summary: `increment ${call}`,
        nextSteps: "continue",
      }));
    });
    const roleRunner = async (args: RoleRunArgs): Promise<RoleRunResult> => {
      if (args.role === "reviewer-correctness") reviewerCalls += 1;
      return scripted(args);
    };

    const result = await runPipeline(
      repo,
      implementationSpec(3),
      dependencies({ runId: "pipeline-increment-budget", roleRunner }),
    );

    expect(result.increments).toHaveLength(2);
    expect(result.increments.map(entry => entry.increment)).toEqual([2, 3]);
    expect(reviewerCalls).toBe(1);
    expect(result.status).toBe("human-decision-required");
    expect(result.gate).toMatchObject({
      decisionReady: false,
      requiresHumanDecision: true,
      reasons: ["increment loop ended 'budget-exhausted' without completion"],
    });
  }, 120_000);

  it("stops incrementing when blocked and still reviews", async () => {
    const repo = await initRepo();
    let reviewerCalls = 0;
    const scripted = incrementRoleRunner(async args => success(fenced({
      reportVersion: "1",
      candidateCommit: args.pkg.candidateCommit,
      status: "blocked",
      summary: "blocked by unavailable input",
      blockers: "input unavailable",
    })));
    const roleRunner = async (args: RoleRunArgs): Promise<RoleRunResult> => {
      if (args.role === "reviewer-correctness") reviewerCalls += 1;
      return scripted(args);
    };

    const result = await runPipeline(
      repo,
      implementationSpec(4),
      dependencies({ runId: "pipeline-increment-blocked", roleRunner }),
    );

    expect(result.increments).toHaveLength(1);
    expect(result.increments[0]?.report.status).toBe("blocked");
    expect(reviewerCalls).toBe(1);
    expect(result.status).toBe("human-decision-required");
    expect(result.gate).toMatchObject({
      decisionReady: false,
      requiresHumanDecision: true,
      reasons: ["increment loop ended 'blocked' without completion"],
    });
  }, 120_000);

  it("treats an allow-empty continuing increment as stalled", async () => {
    const repo = await initRepo();
    const roleRunner = incrementRoleRunner(async (args, call) => {
      const commit = await commitIncrement(
        args,
        call === 1 ? "real progress\n" : "",
        call === 2,
      );
      return success(fenced({
        reportVersion: "1",
        candidateCommit: commit,
        status: "continue",
        summary: `increment ${call}`,
        nextSteps: "continue",
      }));
    });

    const result = await runPipeline(
      repo,
      implementationSpec(3),
      dependencies({ runId: "pipeline-increment-stalled", roleRunner }),
    );

    expect(result.increments).toHaveLength(2);
    expect(result.increments.map(entry => entry.increment)).toEqual([2, 3]);
    expect(result.status).toBe("human-decision-required");
    expect(result.gate).toMatchObject({
      decisionReady: false,
      requiresHumanDecision: true,
      reasons: ["increment loop ended 'stalled' without completion"],
    });
    const store = new ArtifactStore("pipeline-increment-stalled");
    await expect(store.readPipelineArtifact("increment-2"))
      .resolves.toMatchObject({ summary: "increment 1" });
    await expect(store.readPipelineArtifact("increment-3"))
      .resolves.toMatchObject({ summary: "increment 2" });
  }, 120_000);

  it("preserves completed increments when a later implementer role fails", async () => {
    const repo = await initRepo();
    const roleRunner = incrementRoleRunner(async (args, call) => {
      if (call === 2) {
        return {
          ok: false,
          rawOutput: "",
          failure: "timeout",
          producerId: "stub",
        };
      }
      const commit = await commitIncrement(args, "first increment\n");
      return success(fenced({
        reportVersion: "1",
        candidateCommit: commit,
        status: "continue",
        summary: "first increment",
        nextSteps: "continue",
      }));
    });

    const result = await runPipeline(
      repo,
      implementationSpec(3),
      dependencies({ runId: "pipeline-increment-role-failure", roleRunner }),
    );

    expect(result.status).toBe("failed");
    expect(result.failure).toBe("timeout");
    expect(result.increments).toHaveLength(1);
    expect(result.gate.reasons[0]).toContain("logs/role-implementer-increment3.log");
  }, 120_000);

  it("stops instead of launching the next increment once cancelled", async () => {
    // A cancellation landing between Producer runs previously did nothing: the
    // loop launched the next increment regardless, so a caller who gave up on a
    // run kept paying for Producers it no longer wanted.
    const repo = await initRepo();
    const controller = new AbortController();
    const roles: string[] = [];
    const roleRunner = incrementRoleRunner(async (args, _call) => {
      roles.push(args.role);
      return success(fenced({
        reportVersion: "1",
        candidateCommit: "c".repeat(40),
        status: "complete",
        summary: "should never run",
      }));
    });
    const deps = dependencies({
      runId: "pipeline-cancelled-increment",
      roleRunner,
      edit: async repoPath => {
        await writeFile(path.join(repoPath, "a.txt"), "candidate\n");
        controller.abort();
      },
    });
    deps.abortSignal = controller.signal;

    const result = await runPipeline(repo, implementationSpec(2), deps);

    expect(result.status).toBe("failed");
    expect(result.failure).toBe("cancelled");
    expect(result.gate.reasons[0]).toContain("cancelled before increment 2");
    expect(roles).toEqual([]);
  }, 120_000);

  it("archives an unsliced pipeline that fails after verification as rejected", async () => {
    // Bug o-1: an unsliced pipeline whose review never ran left the archive at
    // verified-candidate with no failure and its anchor in place, so the
    // decision advisory offered a candidate the pipeline had not reviewed.
    const repo = await initRepo();
    const runId = "pipeline-unsliced-review-cancelled";
    const controller = new AbortController();
    const deps = dependencies({
      runId,
      roleRunner: async args => { throw new Error(`unexpected role ${args.role}`); },
      edit: async repoPath => {
        await writeFile(path.join(repoPath, "a.txt"), "candidate\n");
        controller.abort();
      },
    });
    deps.abortSignal = controller.signal;

    const result = await runPipeline(repo, validSpec(), deps);

    expect(result.status).toBe("failed");
    expect(result.failure).toBe("cancelled");
    const store = new ArtifactStore(runId);
    const archived = await store.readResult();
    expect(archived?.status).not.toBe("verified-candidate");
    expect(archived).toMatchObject({
      status: "cancelled",
      failure: "cancelled",
      candidate: null,
      evidence: {
        pipelineFailure: { failure: "cancelled", reason: "cancelled before review round 1" },
      },
    });
    await expectRefMissing(repo, `refs/claude-architect/candidates/${runId}`);
    await expect(store.readPipelineActiveMarker()).resolves.toBeNull();
    await expect(store.readPipelineArtifact("pipeline-result"))
      .resolves.toMatchObject({ status: "failed", failure: "cancelled" });
    await expect(new RunDecision().evaluate(runId, { authority: "autonomous" }))
      .resolves.toMatchObject({ state: "rejected", reasons: ["cancelled", "cancelled before review round 1"] });
  }, 120_000);

  it.each<{
    exit: string;
    status: "decision-ready" | "human-decision-required" | "failed" | "thrown";
    spec: () => DelegationSpec;
    deps: (runId: string) => PipelineDependencies;
    sliced?: true;
  }>([
    {
      exit: "implement phase failure",
      status: "failed",
      spec: () => validSpec(),
      deps: runId => ({
        ...dependencies({ runId, roleRunner: async () => success("") }),
        runAttempt: async () => failedAttemptResult(runId),
      }),
    },
    {
      exit: "cancellation before review",
      status: "failed",
      spec: () => validSpec(),
      deps: runId => {
        const controller = new AbortController();
        return {
          ...dependencies({
            runId,
            roleRunner: async () => success(""),
            edit: async repo => {
              await writeFile(path.join(repo, "a.txt"), "candidate\n");
              controller.abort();
            },
          }),
          abortSignal: controller.signal,
        };
      },
    },
    {
      exit: "increment role failure",
      status: "failed",
      spec: () => implementationSpec(2),
      deps: runId => dependencies({
        runId,
        roleRunner: incrementRoleRunner(async () => ({
          ok: false,
          rawOutput: "",
          failure: "timeout",
          producerId: "stub",
        })),
      }),
    },
    {
      exit: "salvage of a candidate that re-verifies",
      status: "human-decision-required",
      spec: () => validSpec({ reviewers: ["correctness"], maxRounds: 1 }),
      deps: runId => dependencies({ runId, roleRunner: async () => success("not json") }),
    },
    {
      exit: "salvage of a candidate that fails re-verification",
      status: "failed",
      spec: () => validSpec({ reviewers: ["correctness"], maxRounds: 1 }),
      deps: runId => {
        vi.spyOn(AcceptanceVerifier.prototype, "verify").mockResolvedValue({
          ok: false,
          failures: ["salvage clean room is red"],
          evidence: {},
          commandOutcomes: [],
        });
        return dependencies({ runId, roleRunner: async () => success("not json") });
      },
    },
    {
      exit: "a completed gate",
      status: "decision-ready",
      spec: () => validSpec({ reviewers: ["correctness"], maxRounds: 1 }),
      deps: runId => dependencies({ runId, roleRunner: async () => success(fenced(approve)) }),
    },
    {
      exit: "a slice halt with nothing past the baseline",
      status: "failed",
      sliced: true,
      spec: () => {
        const halting = slicedSpec();
        halting.writeAllowlist.push("a.txt");
        return halting;
      },
      deps: runId => ({
        ...dependencies({
          runId,
          roleRunner: async args => success(fenced({
            reportVersion: "1",
            candidateCommit: await commitRoleFile(args, "a.txt", "still out of scope\n"),
            status: "complete",
            summary: "repair stayed outside the slice",
          })),
        }),
        runAttempt: fakeAttempt(runId, async checkout => {
          await writeFile(path.join(checkout, "a.txt"), "out of slice one scope\n");
        }),
      }),
    },
    {
      exit: "an unexpected error",
      status: "thrown",
      spec: () => validSpec({ reviewers: ["correctness"], maxRounds: 1 }),
      deps: runId => {
        vi.spyOn(AcceptanceVerifier.prototype, "verify")
          .mockRejectedValue(new Error("final verification infrastructure failed"));
        return dependencies({ runId, roleRunner: async () => success(fenced(approve)) });
      },
    },
  ])("records pipeline/pipeline-result.json on $exit", async ({ exit, status, spec, deps, sliced }) => {
    const repo = sliced ? await initSlicedRepo() : await initRepo();
    const runId = `pipeline-terminal-${exit.replace(/[^a-z]+/gu, "-")}`;

    let returned: string;
    let thrown: unknown;
    try {
      returned = (await runPipeline(repo, spec(), deps(runId))).status;
    } catch (error) {
      returned = "thrown";
      thrown = error;
    }

    expect(returned, `unexpected throw: ${String(thrown)}`).toBe(status);
    const recorded = await new ArtifactStore(runId)
      .readPipelineArtifact<{ status: string; runId: string }>("pipeline-result");
    expect(recorded).toMatchObject({
      runId,
      status: status === "thrown" ? "failed" : status,
    });
  }, 120_000);

  it("fails invalid increment output after one archived repair", async () => {
    const repo = await initRepo();
    const roleRunner = incrementRoleRunner(async (_args, call) =>
      success(call === 1 ? "not json" : "still not json"));

    const result = await runPipeline(
      repo,
      implementationSpec(2),
      dependencies({ runId: "pipeline-increment-invalid", roleRunner }),
    );

    expect(result.status).toBe("failed");
    expect(result.failure).toBe("invalid-output");
    expect(result.increments).toEqual([]);
    expect(result.gate.reasons[0]).toContain("logs/role-implementer-increment2.log");
    const store = new ArtifactStore("pipeline-increment-invalid");
    await expect(readFile(
      path.join(store.runDirectory, "logs", "role-implementer-increment2-repair.log"),
      "utf8",
    )).resolves.toBe("still not json");
  }, 120_000);

  it("fails closed when an increment leaves the worktree dirty", async () => {
    const repo = await initRepo();
    const roleRunner = incrementRoleRunner(async args => {
      const commit = await commitIncrement(args, "committed increment\n");
      await writeFile(path.join(args.worktreePath, "dirty.txt"), "uncommitted\n");
      return success(fenced({
        reportVersion: "1",
        candidateCommit: commit,
        status: "complete",
        summary: "complete",
      }));
    });

    const result = await runPipeline(
      repo,
      implementationSpec(2),
      dependencies({ runId: "pipeline-increment-dirty", roleRunner }),
    );

    expect(result.status).toBe("failed");
    expect(result.failure).toBe("sandbox-violation");
    expect(result.increments).toEqual([]);
  }, 120_000);

  it("rejects an increment report whose candidate does not match worktree HEAD", async () => {
    const repo = await initRepo();
    let reviewerCalls = 0;
    const scripted = incrementRoleRunner(async args => {
      await commitIncrement(args, "real\n");
      return success(fenced({
        reportVersion: "1",
        candidateCommit: args.pkg.candidateCommit,
        status: "complete",
        summary: "reported the stale candidate",
      }));
    });
    const roleRunner = async (args: RoleRunArgs): Promise<RoleRunResult> => {
      if (args.role === "reviewer-correctness") {
        reviewerCalls += 1;
        throw new Error("reviewer must not run after increment provenance failure");
      }
      return scripted(args);
    };

    const result = await runPipeline(
      repo,
      implementationSpec(2),
      dependencies({ runId: "pipeline-increment-head-mismatch", roleRunner }),
    );

    expect(result.status).toBe("failed");
    expect(result.failure).toBe("producer-failure");
    expect(result.gate.reasons).toContain(
      "fix phase reported a candidate commit that does not match its worktree HEAD",
    );
    expect(result.increments).toEqual([]);
    // The failed exit demotes the archive (bug o-1): the candidate is withdrawn
    // and the result names the last adopted commit, the initial candidate.
    expect(result.attempt.candidate).toBeNull();
    expect(result.finalCandidateCommit).toBe(await runGit(repo, ["rev-parse", "HEAD"]));
    expect(reviewerCalls).toBe(0);
  }, 120_000);

  it("rejects an increment report whose candidate commit does not exist", async () => {
    const repo = await initRepo();
    let reviewerCalls = 0;
    const scripted = incrementRoleRunner(async () => success(fenced({
      reportVersion: "1",
      candidateCommit: "d".repeat(40),
      status: "complete",
      summary: "reported a nonexistent candidate",
    })));
    const roleRunner = async (args: RoleRunArgs): Promise<RoleRunResult> => {
      if (args.role === "reviewer-correctness") {
        reviewerCalls += 1;
        throw new Error("reviewer must not run after increment provenance failure");
      }
      return scripted(args);
    };

    const result = await runPipeline(
      repo,
      implementationSpec(2),
      dependencies({ runId: "pipeline-increment-missing", roleRunner }),
    );

    expect(result.status).toBe("failed");
    expect(result.failure).toBe("producer-failure");
    expect(result.gate.reasons).toContain("fix phase reported a missing candidate commit");
    expect(result.increments).toEqual([]);
    // The failed exit demotes the archive (bug o-1): the candidate is withdrawn
    // and the result names the last adopted commit, the initial candidate.
    expect(result.attempt.candidate).toBeNull();
    expect(result.finalCandidateCommit).toBe(await runGit(repo, ["rev-parse", "HEAD"]));
    expect(reviewerCalls).toBe(0);
  }, 120_000);

  it("rejects an increment HEAD that is not descended from the reviewed candidate", async () => {
    const repo = await initRepo();
    let reviewerCalls = 0;
    const scripted = incrementRoleRunner(async args => {
      if (args.gitObjectAccess === undefined) {
        throw new Error("implementer git object isolation is missing");
      }
      const env = {
        GIT_OBJECT_DIRECTORY: args.gitObjectAccess.privateObjectsDir,
        GIT_ALTERNATE_OBJECT_DIRECTORIES: args.gitObjectAccess.sharedObjectsDir,
      };
      const baselineTree = await runGit(
        args.worktreePath,
        ["rev-parse", `${args.pkg.baselineCommit}^{tree}`],
        env,
      );
      const sibling = await runGit(args.worktreePath, [
        "commit-tree",
        baselineTree,
        "-p",
        args.pkg.baselineCommit,
        "-m",
        "discard reviewed candidate",
      ], env);
      await runGit(args.worktreePath, [
        "update-ref",
        "HEAD",
        sibling,
        args.pkg.candidateCommit,
      ], env);
      return success(fenced({
        reportVersion: "1",
        candidateCommit: sibling,
        status: "complete",
        summary: "replaced the reviewed lineage",
      }));
    });
    const roleRunner = async (args: RoleRunArgs): Promise<RoleRunResult> => {
      if (args.role === "reviewer-correctness") {
        reviewerCalls += 1;
        throw new Error("reviewer must not run after increment provenance failure");
      }
      return scripted(args);
    };

    const result = await runPipeline(
      repo,
      implementationSpec(2),
      dependencies({ runId: "pipeline-increment-sibling", roleRunner }),
    );

    expect(result.status).toBe("failed");
    expect(result.failure).toBe("sandbox-violation");
    expect(result.gate.reasons).toContain(
      "fix phase candidate commit is not descended from the reviewed candidate",
    );
    expect(result.increments).toEqual([]);
    // The failed exit demotes the archive (bug o-1): the candidate is withdrawn
    // and the result names the last adopted commit, the initial candidate.
    expect(result.attempt.candidate).toBeNull();
    expect(result.finalCandidateCommit).toBe(await runGit(repo, ["rev-parse", "HEAD"]));
    expect(reviewerCalls).toBe(0);
  }, 120_000);

  it("fails closed without review when implementer confinement is unavailable", async () => {
    const repo = await initRepo();
    let reviewerCalls = 0;
    const scripted = incrementRoleRunner(async () => ({
      ok: false,
      rawOutput: "",
      failure: "sandbox-violation",
      producerId: "stub",
    }));
    const roleRunner = async (args: RoleRunArgs): Promise<RoleRunResult> => {
      if (args.role === "reviewer-correctness") {
        reviewerCalls += 1;
        throw new Error("reviewer must not run after implementer confinement failure");
      }
      return scripted(args);
    };

    const result = await runPipeline(
      repo,
      implementationSpec(2),
      dependencies({ runId: "pipeline-increment-no-confinement", roleRunner }),
    );

    expect(result.status).toBe("failed");
    expect(result.failure).toBe("sandbox-violation");
    expect(result.increments).toEqual([]);
    expect(reviewerCalls).toBe(0);
  }, 120_000);

  it("stops before dispatching another increment when only the commit oid changes", async () => {
    const repo = await initRepo();
    let implementerCalls = 0;
    const roleRunner = incrementRoleRunner(async (args, call) => {
      implementerCalls += 1;
      const commit = await commitIncrement(
        args,
        call === 1 ? "real progress\n" : "",
        call === 2,
      );
      return success(fenced({
        reportVersion: "1",
        candidateCommit: commit,
        status: "continue",
        summary: `increment ${call}`,
        nextSteps: "continue",
      }));
    });

    const result = await runPipeline(
      repo,
      implementationSpec(4),
      dependencies({ runId: "pipeline-increment-tree-progress", roleRunner }),
    );

    expect(result.increments.map(entry => entry.increment)).toEqual([2, 3]);
    expect(implementerCalls).toBe(2);
  }, 120_000);

  it("redacts increment secrets from archives, progress notes, and results", async () => {
    const repo = await initRepo();
    const runId = "pipeline-increment-secret-hygiene";
    const secret = "increment-secret-XYZ";
    registerSecretValue(secret);
    let incrementThreeProgress = "";
    const roleRunner = incrementRoleRunner(async (args, call) => {
      if (call === 2) incrementThreeProgress = args.pkg.progress ?? "";
      const commit = await commitIncrement(args, `secret progress ${call}\n`);
      return success(fenced({
        reportVersion: "1",
        candidateCommit: commit,
        status: call === 1 ? "continue" : "complete",
        summary: call === 1 ? `summary ${secret}` : "complete",
        ...(call === 1 ? { nextSteps: `next ${secret}` } : {}),
      }));
    });

    const result = await runPipeline(
      repo,
      implementationSpec(3),
      dependencies({ runId, roleRunner }),
    );

    const store = new ArtifactStore(runId);
    const archived = await store.readPipelineArtifact<IncrementReport>("increment-2");
    expect(archived?.summary).not.toContain(secret);
    expect(archived?.summary).toContain("[s]");
    expect(incrementThreeProgress).not.toContain(secret);
    expect(JSON.stringify(result)).not.toContain(secret);
  }, 120_000);

  it("passes only the immediately previous increment as progress", async () => {
    const repo = await initRepo();
    let incrementFourProgress = "";
    const roleRunner = incrementRoleRunner(async (args, call) => {
      if (call === 3) incrementFourProgress = args.pkg.progress ?? "";
      const commit = await commitIncrement(args, `progress ${call}\n`);
      return success(fenced({
        reportVersion: "1",
        candidateCommit: commit,
        status: "continue",
        summary: call === 1 ? "INCREMENT_TWO_MARKER" : `increment ${call + 1}`,
        nextSteps: call === 2 ? "INCREMENT_THREE_MARKER" : "continue",
      }));
    });

    const result = await runPipeline(
      repo,
      implementationSpec(4),
      dependencies({ runId: "pipeline-increment-progress", roleRunner }),
    );

    expect(result.increments).toHaveLength(3);
    expect(incrementFourProgress).toContain("INCREMENT_THREE_MARKER");
    expect(incrementFourProgress).not.toContain("INCREMENT_TWO_MARKER");
  }, 120_000);

  it("does not invoke an implementer without an implementation block", async () => {
    const repo = await initRepo();
    const roles: string[] = [];
    const roleRunner = async (args: RoleRunArgs): Promise<RoleRunResult> => {
      roles.push(args.role);
      if (args.role === "reviewer-correctness") return success(fenced(approve));
      throw new Error(`unexpected role ${args.role}`);
    };

    const result = await runPipeline(
      repo,
      validSpec({ reviewers: ["correctness"], maxRounds: 1 }),
      dependencies({ runId: "pipeline-no-increments", roleRunner }),
    );

    expect(result.increments).toEqual([]);
    expect(roles).toEqual(["reviewer-correctness"]);
    const preIncrementGate = {
      decisionReady: true,
      requiresHumanDecision: false,
      reasons: [],
    };
    expect(result.status).toBe("decision-ready");
    expect(JSON.stringify(result.gate)).toBe(JSON.stringify(preIncrementGate));
  }, 120_000);

  it("preserves and skips a terminal run recovered after an increment archive", async () => {
    const repo = await initRepo();
    const runId = "pipeline-increment-crash";
    const baselineCommit = await runGit(repo, ["rev-parse", "HEAD"]);
    await writeFile(path.join(repo, "a.txt"), "candidate before crash\n");
    await runGit(repo, ["add", "a.txt"]);
    await runGit(repo, ["commit", "-q", "-m", "candidate before crash"]);
    const candidateCommit = await runGit(repo, ["rev-parse", "HEAD"]);
    const candidate = await artifactFor(repo, runId, baselineCommit, candidateCommit);
    const store = new ArtifactStore(runId);
    await store.writeResult(attemptResult(runId, candidate));
    const canonicalCommonDir = await realpath(path.join(repo, ".git"));
    const lockKey = createHash("sha256").update(canonicalCommonDir).digest("hex");
    const writerPid = 424_242;
    await writeFile(path.join(store.runDirectory, "run-start.json"), `${JSON.stringify({
      runId,
      lockKey,
      canonicalCommonDir,
      pid: writerPid,
      processToken: null,
      startedAt: "2026-07-18T12:00:00.000Z",
    })}\n`);
    await new WorktreeManager(
      repo,
      `${runId}-pipeline`,
      getPlatformServices(),
    ).create(candidateCommit);
    await store.writePipelineArtifact("increment-2", {
      reportVersion: "1",
      candidateCommit,
      status: "continue",
      summary: "increment two",
    });
    const terminated: number[] = [];

    const recovery = await recoverStaleRuns({
      platformServices: {
        os: "darwin",
        async getProcessStartToken() { return null; },
        async terminateProcessTreeByPid(pid) { terminated.push(pid); },
      },
      isProcessAlive: () => false,
    });

    expect(recovery).toEqual({ recovered: [], quarantined: [] });
    expect(terminated).toEqual([]);
    await expect(store.readResult()).resolves.toMatchObject({
      status: "verified-candidate",
    });
    const anchor = await git(repo, [
      "rev-parse",
      "--verify",
      "--quiet",
      `refs/claude-architect/candidates/${runId}^{commit}`,
    ]);
    expect(anchor.exitCode, anchor.stderr).toBe(0);
    expect(anchor.stdout.trim()).toBe(candidateCommit);
    await expect(store.readPipelineArtifact("increment-2"))
      .resolves.toMatchObject({ summary: "increment two" });
  }, 120_000);

});
