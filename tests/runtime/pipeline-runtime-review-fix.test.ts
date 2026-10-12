import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { git } from "../../src/git/git-exec.js";
import { applyCandidateTree } from "../../src/integrate/controlled-integrator.js";
import { runPipeline } from "../../src/pipeline/pipeline-runtime.js";
import type { RoleRunArgs, RoleRunResult } from "../../src/pipeline/role-runner.js";
import { ArtifactStore } from "../../src/runtime/artifact-store.js";
import { runGit, initRepo, validSpec, fenced, success, approve, blocker, dependencies, roundReviews, commitFix, installPipelineRuntimeHooks } from "../support/pipeline-runtime-harness.js";

installPipelineRuntimeHooks();

describe("runPipeline", () => {
  it("returns decision-ready after a clean review round without fixing", async () => {
    const repo = await initRepo();
    const runId = "pipeline-clean";
    const store = new ArtifactStore(runId);
    const spec = validSpec();
    const markerPath = path.join(store.runDirectory, "pipeline-active.json");
    const baseRoleRunner = roundReviews(
      [{ correctness: approve, systems: approve }],
      async () => { throw new Error("fixer must not run"); },
    );
    let markerObserved = false;
    const roleRunner = async (args: RoleRunArgs): Promise<RoleRunResult> => {
      const marker = JSON.parse(await readFile(markerPath, "utf8")) as {
        pid?: unknown;
        sliced?: unknown;
      };
      expect(marker.pid).toBe(process.pid);
      expect(marker.sliced).toBe(false);
      markerObserved = true;
      return baseRoleRunner(args);
    };

    const result = await runPipeline(
      repo,
      spec,
      dependencies({ runId, roleRunner }),
    );

    expect(result.status).toBe("decision-ready");
    expect(result.slices).toEqual([]);
    expect(result.haltedSliceIndex).toBeNull();
    expect(markerObserved).toBe(true);
    await expect(readFile(markerPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(result.rounds).toHaveLength(1);
    expect(result.rounds[0]?.fix).toBeNull();
    expect(result.rounds[0]?.roleLogRefs).toEqual([
      "logs/role-reviewer-correctness-round1.log",
      "logs/role-reviewer-systems-round1.log",
    ]);
    await expect(store.readPipelineArtifact("delegation-spec")).resolves.toEqual(spec);
    await expect(readFile(
      path.join(store.runDirectory, "logs", "role-reviewer-correctness-round1.log"),
      "utf8",
    )).resolves.toBe(fenced(approve));
    await expect(readFile(
      path.join(store.runDirectory, "logs", "role-reviewer-systems-round1.log"),
      "utf8",
    )).resolves.toBe(fenced(approve));
  }, 120_000);

  it("reports the candidate identity when gate clearance cannot be archived", async () => {
    const repo = await initRepo();
    const runId = "pipeline-clearance-archive-missing";
    const store = new ArtifactStore(runId);
    const baseRoleRunner = roundReviews(
      [{ correctness: approve, systems: approve }],
      async () => { throw new Error("fixer must not run"); },
    );
    const roleRunner = async (args: RoleRunArgs): Promise<RoleRunResult> => {
      const result = await baseRoleRunner(args);
      if (args.role === "reviewer-systems") {
        await rm(path.join(store.runDirectory, "manifest.json"));
      }
      return result;
    };

    let thrown: unknown;
    try {
      await runPipeline(
        repo,
        validSpec(),
        dependencies({
          runId,
          roleRunner,
        }),
      );
    } catch (error) {
      thrown = error;
    }

    // The catch path also tries to demote the still-verified archive (bug
    // o-1); with the manifest gone that fails too, so both errors surface.
    expect(thrown).toBeInstanceOf(AggregateError);
    expect((thrown as AggregateError).errors[1]).toMatchObject({
      name: "TerminalArchiveError",
      message: "run manifest is missing while archiving pipeline failure",
    });
    expect((thrown as AggregateError).errors[0]).toMatchObject({
      name: "RuntimeError",
      message: "pipeline gate cleared the candidate and the clearance could not be archived",
      detail: {
        candidateCommitOid: expect.stringMatching(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u),
        requiresHumanDecision: false,
      },
    });
  }, 120_000);

  it("gives every fixer a fresh worktree that no earlier role could leave residue in", async () => {
    const repo = await initRepo();
    const worktrees: Array<{ role: string; path: string; residue: boolean }> = [];
    const base = roundReviews([
      { correctness: blocker, systems: approve },
      { correctness: blocker, systems: approve },
      { correctness: approve, systems: approve },
    ], async (args, round) => {
      const commit = await commitFix(args, `fixed ${round}\n`);
      // Ignored residue (a build cache, say) passes provenance, and a shared
      // worktree would carry it into the next fixer.
      const commonDir = await runGit(args.worktreePath, ["rev-parse", "--git-common-dir"]);
      await mkdir(path.resolve(args.worktreePath, commonDir, "info"), { recursive: true });
      await writeFile(path.resolve(args.worktreePath, commonDir, "info", "exclude"), "residue.txt\n");
      await writeFile(path.join(args.worktreePath, "residue.txt"), "left behind\n");
      return success(fenced({
        reportVersion: "1",
        candidateCommit: commit,
        dispositions: [{ findingId: "F-001", disposition: "fixed", evidence: "Fixed.", commit }],
      }));
    });
    const roleRunner = async (args: RoleRunArgs): Promise<RoleRunResult> => {
      const residue = await readFile(path.join(args.worktreePath, "residue.txt")).then(() => true, () => false);
      worktrees.push({ role: args.role, path: args.worktreePath, residue });
      return await base(args);
    };

    const result = await runPipeline(
      repo,
      validSpec({ reviewers: ["correctness", "systems"], maxRounds: 3 }),
      dependencies({ runId: "pipeline-fresh-fixers", roleRunner }),
    );

    // Two blockers at one location end at the non-convergence gate; what
    // matters here is where each role ran.
    expect(result.rounds).toHaveLength(3);
    const fixers = worktrees.filter(entry => entry.role === "fixer");
    expect(fixers.map(entry => path.basename(entry.path))).toEqual([
      "pipeline-fresh-fixers-round-1-fix",
      "pipeline-fresh-fixers-round-2-fix",
    ]);
    expect(worktrees.every(entry => !entry.residue)).toBe(true);
  }, 120_000);

  it("fixes a blocker and returns decision-ready after a clean re-review", async () => {
    const repo = await initRepo();
    let privateObjectsDir = "";
    const roleRunner = roundReviews([
      { correctness: blocker, systems: approve },
      { correctness: approve, systems: approve },
    ], async args => {
      privateObjectsDir = args.gitObjectAccess?.privateObjectsDir ?? "";
      const commit = await commitFix(args, "fixed\n");
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
      dependencies({ runId: "pipeline-fixed", roleRunner }),
    );

    expect(result.status).toBe("decision-ready");
    expect(result.rounds).toHaveLength(2);
    expect(result.rounds[0]?.roleLogRefs).toContain("logs/role-fixer-round1.log");
    expect(privateObjectsDir).not.toBe("");
    expect((await git(repo, [
      "cat-file",
      "-e",
      `${result.finalCandidateCommit}^{commit}`,
    ])).exitCode).toBe(0);
    expect(await runGit(repo, ["show", `${result.finalCandidateCommit}:a.txt`])).toBe("fixed");
    const promotedArtifact = result.attempt.candidate;
    expect(promotedArtifact).not.toBeNull();
    if (promotedArtifact === null) return;
    const checkoutHead = await runGit(repo, ["rev-parse", "HEAD"]);
    await writeFile(path.join(repo, "a.txt"), "base\n");
    await runGit(repo, ["add", "a.txt"]);
    await runGit(repo, [
      "update-ref",
      "HEAD",
      promotedArtifact.baseCommitOid,
      checkoutHead,
    ]);
    await expect(applyCandidateTree({
      repoRoot: repo,
      artifact: promotedArtifact,
      expectedArtifactHash: promotedArtifact.manifestHash,
    })).resolves.toMatchObject({ integration: "applied" });
    await expect(readFile(path.join(repo, "a.txt"), "utf8")).resolves.toBe("fixed\n");
  }, 120_000);

  it("emits ordered pipeline-stage progress phases across review and fix rounds", async () => {
    const repo = await initRepo();
    const roleRunner = roundReviews([
      { correctness: blocker, systems: approve },
      { correctness: approve, systems: approve },
    ], async args => {
      const commit = await commitFix(args, "fixed\n");
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

    const phases: string[] = [];
    const result = await runPipeline(repo, validSpec(), {
      ...dependencies({ runId: "pipeline-phases", roleRunner }),
      onPhase: phase => { phases.push(phase); },
    });

    expect(result.status).toBe("decision-ready");
    expect(phases).toEqual([
      "review round 1/2",
      "round 1: applying fixes",
      "review round 2/2",
      "final verification",
      "evaluating gate",
      // Terminal, so a reader can tell a finished pipeline from a wedged one.
      "finished: decision-ready",
    ]);
  });

  it("never lets a throwing progress callback affect pipeline control flow", async () => {
    const repo = await initRepo();
    const roleRunner = roundReviews([
      { correctness: approve, systems: approve },
    ], async () => {
      throw new Error("fixer must not run after a clean first round");
    });

    const result = await runPipeline(repo, validSpec(), {
      ...dependencies({ runId: "pipeline-phase-throw", roleRunner }),
      onPhase: () => { throw new Error("progress sink boom"); },
    });

    expect(result.status).toBe("decision-ready");
    expect(result.rounds).toHaveLength(1);
  });

  it.each([
    {
      state: "tracked-file modification",
      dirtyWorktree: async (args: RoleRunArgs): Promise<void> => {
        await writeFile(path.join(args.worktreePath, "a.txt"), "uncommitted\n");
      },
    },
    {
      state: "staged change",
      dirtyWorktree: async (args: RoleRunArgs): Promise<void> => {
        if (args.gitObjectAccess === undefined) {
          throw new Error("fixer git object isolation is missing");
        }
        await writeFile(path.join(args.worktreePath, "a.txt"), "staged\n");
        await runGit(args.worktreePath, ["add", "a.txt"], {
          GIT_OBJECT_DIRECTORY: args.gitObjectAccess.privateObjectsDir,
          GIT_ALTERNATE_OBJECT_DIRECTORIES: args.gitObjectAccess.sharedObjectsDir,
        });
      },
    },
    {
      state: "untracked file",
      dirtyWorktree: async (args: RoleRunArgs): Promise<void> => {
        await writeFile(path.join(args.worktreePath, "untracked.txt"), "uncommitted\n");
      },
    },
  ])("rejects fixer provenance with a $state", async ({ state, dirtyWorktree }) => {
    const repo = await initRepo();
    const roleRunner = roundReviews([
      { correctness: blocker, systems: approve },
    ], async args => {
      const commit = await commitFix(args, "fixed\n");
      await dirtyWorktree(args);
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
      dependencies({ runId: `pipeline-fix-dirty-${state.replaceAll(" ", "-")}`, roleRunner }),
    );

    expect(result.status).toBe("failed");
    expect(result.failure).toBe("sandbox-violation");
    expect(result.gate.reasons).toContain(
      "fix phase candidate worktree contains uncommitted state",
    );
  });

  it("fails closed when fixer worktree cleanliness cannot be read", async () => {
    const repo = await initRepo();
    const roleRunner = roundReviews([
      { correctness: blocker, systems: approve },
    ], async args => {
      if (args.gitObjectAccess === undefined) {
        throw new Error("fixer git object isolation is missing");
      }
      const commit = await commitFix(args, "fixed\n");
      const env = {
        GIT_OBJECT_DIRECTORY: args.gitObjectAccess.privateObjectsDir,
        GIT_ALTERNATE_OBJECT_DIRECTORIES: args.gitObjectAccess.sharedObjectsDir,
      };
      const indexPath = path.resolve(
        args.worktreePath,
        await runGit(args.worktreePath, ["rev-parse", "--git-path", "index"], env),
      );
      await rm(indexPath);
      await mkdir(indexPath);
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
      dependencies({ runId: "pipeline-fix-status-failure", roleRunner }),
    );

    expect(result.status).toBe("failed");
    expect(result.failure).toBe("sandbox-violation");
    expect(result.gate.reasons).toContain(
      "fix phase candidate worktree cleanliness could not be verified",
    );
  });

  it("validates fixer provenance through private objects before promotion", async () => {
    const repo = await initRepo();
    let privateCommit = "";
    const roleRunner = roundReviews([
      { correctness: blocker, systems: approve },
      { correctness: approve, systems: approve },
    ], async args => {
      privateCommit = await commitFix(args, "private-fixed\n");
      expect((await git(repo, [
        "cat-file",
        "-e",
        `${privateCommit}^{commit}`,
      ])).exitCode).not.toBe(0);
      return success(fenced({
        reportVersion: "1",
        candidateCommit: privateCommit,
        dispositions: [{
          findingId: "F-001",
          disposition: "fixed",
          evidence: "Committed the requested correction.",
          commit: privateCommit,
        }],
      }));
    });

    const result = await runPipeline(
      repo,
      validSpec(),
      dependencies({ runId: "pipeline-fix-private-provenance", roleRunner }),
    );

    expect(privateCommit).not.toBe("");
    expect(result.status).toBe("decision-ready");
    expect((await git(repo, [
      "cat-file",
      "-e",
      `${result.finalCandidateCommit}^{commit}`,
    ])).exitCode).toBe(0);
    expect(await runGit(repo, ["show", `${result.finalCandidateCommit}:a.txt`]))
      .toBe("private-fixed");
  });

  it("rejects a fixer report whose candidate does not match worktree HEAD", async () => {
    const repo = await initRepo();
    const roleRunner = roundReviews([
      { correctness: blocker, systems: approve },
    ], async args => {
      const reportedCommit = args.pkg.candidateCommit;
      await commitFix(args, "unreported-head\n");
      return success(fenced({
        reportVersion: "1",
        candidateCommit: reportedCommit,
        dispositions: [{
          findingId: "F-001",
          disposition: "fixed",
          evidence: "Claimed the old candidate instead of the produced HEAD.",
          commit: reportedCommit,
        }],
      }));
    });

    const result = await runPipeline(
      repo,
      validSpec(),
      dependencies({ runId: "pipeline-fix-head-mismatch", roleRunner }),
    );

    expect(result.status).toBe("failed");
    expect(result.failure).toBe("producer-failure");
    expect(result.gate.reasons).toContain(
      "fix phase reported a candidate commit that does not match its worktree HEAD",
    );
    // The failed exit demotes the archive (bug o-1): the candidate is withdrawn
    // and the result names the last adopted commit, the initial candidate.
    expect(result.attempt.candidate).toBeNull();
    expect(result.finalCandidateCommit).toBe(await runGit(repo, ["rev-parse", "HEAD"]));
  });

  it("rejects a fixer HEAD that is not descended from the reviewed candidate", async () => {
    const repo = await initRepo();
    const roleRunner = roundReviews([
      { correctness: blocker, systems: approve },
    ], async args => {
      if (args.gitObjectAccess === undefined) {
        throw new Error("fixer git object isolation is missing");
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
        dispositions: [{
          findingId: "F-001",
          disposition: "fixed",
          evidence: "Replaced the reviewed lineage.",
          commit: sibling,
        }],
      }));
    });

    const result = await runPipeline(
      repo,
      validSpec(),
      dependencies({ runId: "pipeline-fix-sibling", roleRunner }),
    );

    expect(result.status).toBe("failed");
    expect(result.failure).toBe("sandbox-violation");
    expect(result.gate.reasons).toContain(
      "fix phase candidate commit is not descended from the reviewed candidate",
    );
    // The failed exit demotes the archive (bug o-1): the candidate is withdrawn
    // and the result names the last adopted commit, the initial candidate.
    expect(result.attempt.candidate).toBeNull();
    expect(result.finalCandidateCommit).toBe(await runGit(repo, ["rev-parse", "HEAD"]));
  });

  it("rejects a fixer disposition that cites a nonexistent commit", async () => {
    const repo = await initRepo();
    const roleRunner = roundReviews([
      { correctness: blocker, systems: approve },
    ], async args => {
      const commit = await commitFix(args, "fixed-with-false-evidence\n");
      return success(fenced({
        reportVersion: "1",
        candidateCommit: commit,
        dispositions: [{
          findingId: "F-001",
          disposition: "fixed",
          evidence: "Cited an object that does not exist.",
          commit: "d".repeat(40),
        }],
      }));
    });

    const result = await runPipeline(
      repo,
      validSpec(),
      dependencies({ runId: "pipeline-fix-missing-disposition", roleRunner }),
    );

    expect(result.status).toBe("failed");
    expect(result.failure).toBe("producer-failure");
    expect(result.gate.reasons).toContain(
      "fix phase disposition reported a missing commit object",
    );
  });

});
