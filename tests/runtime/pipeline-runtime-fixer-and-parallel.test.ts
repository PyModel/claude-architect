import { writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { WorktreeManager } from "../../src/runtime/worktree-manager.js";
import type { DelegationSpec } from "../../src/protocol/delegation-spec.js";
import { runPipeline } from "../../src/pipeline/pipeline-runtime.js";
import { initRepo, validSpec, fenced, success, approve, blocker, fakeAttempt, dependencies, roundReviews, commitFix, initSlicedRepo, fileVerification, slicedSpec, commitRoleFile, installPipelineRuntimeHooks } from "../support/pipeline-runtime-harness.js";

installPipelineRuntimeHooks();

describe("runPipeline", () => {
  it("requires human decision when the final-round fix was not re-reviewed", async () => {
    const repo = await initRepo();
    const roleRunner = roundReviews([
      { correctness: blocker, systems: approve },
      { correctness: blocker, systems: approve },
    ], async (args, round) => {
      const commit = await commitFix(args, `still-blocked-${round}\n`);
      return success(fenced({
        reportVersion: "1",
        candidateCommit: commit,
        dispositions: [{
          findingId: "F-001",
          disposition: "fixed",
          evidence: "Committed the requested correction.",
          commit,
        }],
      }));
    });

    const result = await runPipeline(
      repo,
      validSpec(),
      dependencies({ runId: "pipeline-capped", roleRunner }),
    );

    expect(result.status).toBe("human-decision-required");
    expect(result.gate.requiresHumanDecision).toBe(true);
    expect(result.gate.reasons).toContain("final fix was not re-reviewed");
    expect(result.rounds.at(-1)?.fix).not.toBeNull();
  });

  function parallelSpec(overrides: {
    sliceTwoCheck: Record<string, string>;
    finalCheck: Record<string, string>;
  }): DelegationSpec {
    const spec = slicedSpec();
    return {
      ...spec,
      sliceConcurrency: 2,
      slices: [
        { ...spec.slices![0]!, dependsOn: [] },
        {
          ...spec.slices![1]!,
          dependsOn: [],
          verification: [fileVerification("slice-two-check", overrides.sliceTwoCheck)],
        },
      ],
      verification: [fileVerification("final-check", overrides.finalCheck)],
    };
  }

  function parallelDeps(runId: string) {
    const deps = dependencies({
      runId,
      roleRunner: async args => {
        if (args.role === "implementer") {
          const commit = await commitRoleFile(args, "slice-two.txt", "slice two candidate\n");
          return success(fenced({
            reportVersion: "1",
            candidateCommit: commit,
            status: "complete",
            summary: "slice complete",
          }));
        }
        if (args.role === "reviewer-correctness") return success(fenced(approve));
        throw new Error(`unexpected role ${args.role}`);
      },
    });
    deps.runAttempt = fakeAttempt(runId, async checkout => {
      await writeFile(path.join(checkout, "slice-one.txt"), "slice one candidate\n");
    });
    return deps;
  }

  it("composes slices that ran in the same wave into one candidate", async () => {
    const repo = await initSlicedRepo();
    const runId = "pipeline-parallel-compose";

    const result = await runPipeline(repo, parallelSpec({
      // Slice two is verified without slice one present, which is exactly what
      // declaring independence means.
      sliceTwoCheck: { "slice-two.txt": "slice two candidate\n" },
      finalCheck: {
        "slice-one.txt": "slice one candidate\n",
        "slice-two.txt": "slice two candidate\n",
      },
    }), parallelDeps(runId));

    expect(result.status).toBe("decision-ready");
    expect(result.slices.map(slice => slice.index)).toEqual([1, 2]);
    const changed = result.attempt.candidate?.changedPaths.map(entry => entry.path) ?? [];
    expect(changed.sort()).toEqual(["slice-one.txt", "slice-two.txt"]);
  }, 180_000);

  it("fails closed when a slice under-declared what it depended on", async () => {
    const repo = await initSlicedRepo();
    const runId = "pipeline-parallel-underdeclared";

    // Both slices pass their own checks against a base that lacks the other's
    // work. Nothing in scheduling can detect an under-declared dependency, so
    // the mandatory verification of the composed tree is the only thing standing
    // between a wrong `dependsOn` and a shipped candidate.
    const result = await runPipeline(repo, parallelSpec({
      sliceTwoCheck: { "slice-two.txt": "slice two candidate\n" },
      finalCheck: { "slice-one.txt": "the composed tree must satisfy this\n" },
    }), parallelDeps(runId));

    expect(result.status).not.toBe("decision-ready");
    expect(result.gate.decisionReady).toBe(false);
    expect(result.gate.reasons.join("\n")).toContain("clean-room verification failed");
  }, 180_000);

  it("keeps the slice outcome when its worktree cannot be cleaned up", async () => {
    const repo = await initSlicedRepo();
    const runId = "pipeline-slice-cleanup-failure";
    const spec = slicedSpec();
    const initialRun = fakeAttempt(runId, async checkout => {
      await writeFile(path.join(checkout, "slice-one.txt"), "slice one candidate\n");
    });
    // Producer test children can outlive their parent and hold the worktree
    // open. Losing the whole slice result to that is finding 16.
    const create = WorktreeManager.prototype.create;
    let failedOnce = false;
    vi.spyOn(WorktreeManager.prototype, "create").mockImplementation(async function (this: WorktreeManager, commit) {
      const worktree = await create.call(this, commit);
      if (failedOnce) return worktree;
      failedOnce = true;
      return {
        ...worktree,
        async cleanup() {
          await worktree.cleanup();
          throw new Error("worktree busy");
        },
      };
    });
    const deps = dependencies({
      runId,
      roleRunner: async args => {
        if (args.role === "implementer") {
          const candidateCommit = await commitRoleFile(
            args,
            "slice-two.txt",
            "slice two candidate\n",
          );
          return success(fenced({
            reportVersion: "1",
            candidateCommit,
            status: "complete",
            summary: "slice complete",
          }));
        }
        if (args.role === "reviewer-correctness") return success(fenced(approve));
        throw new Error(`unexpected role ${args.role}`);
      },
    });
    deps.runAttempt = initialRun;

    const result = await runPipeline(repo, spec, deps);

    expect(result.status).toBe("decision-ready");
    expect(result.attempt.candidate).not.toBeNull();
  }, 120_000);

});
