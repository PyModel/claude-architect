import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { git } from "../../src/git/git-exec.js";
import { handleDecideCandidate } from "../../src/mcp/tools.js";
import { getPlatformServices } from "../../src/platform/select-platform.js";
import type { AttemptResult } from "../../src/protocol/attempt-result.js";
import { ProducerRegistry } from "../../src/producers/producer-registry.js";
import { runPipeline, type PipelineVerificationReport } from "../../src/pipeline/pipeline-runtime.js";
import { resolveLinkedWorktreeWritableRoots } from "../../src/pipeline/git-writable-roots.js";
import type { RoleRunArgs, RoleRunResult } from "../../src/pipeline/role-runner.js";
import { ArtifactStore } from "../../src/runtime/artifact-store.js";
import { AcceptanceVerifier } from "../../src/verify/acceptance-verifier.js";
import { temporaryDirectory, runGit, initRepo, validSpec, fenced, success, approve, blocker, passingVerifier, dependencies, roundReviews, installPipelineRuntimeHooks } from "../support/pipeline-runtime-harness.js";

installPipelineRuntimeHooks();

describe("runPipeline", () => {
  it("keeps a round whose reviews completed when its fix phase then fails", async () => {
    const repo = await initRepo();
    let reviewed = false;
    const roleRunner = async (args: RoleRunArgs): Promise<RoleRunResult> => {
      if (args.role === "reviewer-correctness") {
        reviewed = true;
        return success(fenced(blocker));
      }
      if (args.role === "fixer") {
        return { ok: false, rawOutput: "", failure: "timeout", producerId: "stub" };
      }
      throw new Error(`unexpected role ${args.role}`);
    };

    const result = await runPipeline(
      repo,
      validSpec({ reviewers: ["correctness"], maxRounds: 1 }),
      dependencies({ runId: "pipeline-round-retained", roleRunner }),
    );

    // Review work already on disk must appear in the result even though the
    // round never reached a fix.
    expect(reviewed).toBe(true);
    expect(result.rounds).toHaveLength(1);
    expect(result.rounds[0]?.round).toBe(1);
    expect(result.rounds[0]?.fix).toBeNull();
    expect(result.rounds[0]?.consolidated.findings).not.toHaveLength(0);
  }, 120_000);

  it("discards the candidate when salvage verification fails", async () => {
    const repo = await initRepo();
    let calls = 0;
    const roleRunner = async (): Promise<RoleRunResult> => {
      calls += 1;
      return success(calls === 1 ? "not json" : "not json either");
    };
    // Salvage must never turn an unverifiable candidate into a decision the
    // human can act on: a red clean room still archives and discards.
    const verify = AcceptanceVerifier.prototype.verify;
    vi.spyOn(AcceptanceVerifier.prototype, "verify").mockImplementation(async function (this: AcceptanceVerifier, args) {
      const report = await verify.call(this, args);
      return { ...report, ok: false, failures: ["salvage clean room is red"] };
    });

    const result = await runPipeline(
      repo,
      validSpec({ reviewers: ["correctness"], maxRounds: 1 }),
      dependencies({ runId: "pipeline-salvage-red", roleRunner }),
    );

    expect(result.status).toBe("failed");
    expect(result.failure).toBe("producer-failure");
    expect(result.gate.requiresHumanDecision).toBe(false);
    await expect(handleDecideCandidate(
      repo,
      "pipeline-salvage-red",
      "accepted",
      "0".repeat(64),
    )).resolves.toMatchObject({ ok: false, error: "candidate-not-verified" });
  }, 120_000);

  it("salvages the candidate after invalid reviewer output and one invalid repair", async () => {
    const repo = await initRepo();
    let calls = 0;
    const roleRunner = async (): Promise<RoleRunResult> => {
      calls += 1;
      return success(calls === 1 ? "not json" : "not json either");
    };

    const result = await runPipeline(
      repo,
      validSpec({ reviewers: ["correctness"], maxRounds: 1 }),
      dependencies({ runId: "pipeline-invalid", roleRunner }),
    );

    expect(result.status).toBe("human-decision-required");
    expect(result.attempt.candidate).not.toBeNull();
    expect(result.gate.reasons[0]).toBe(
      "review phase did not produce valid structured output (see logs/role-reviewer-correctness-round1.log)",
    );
    expect(calls).toBe(2);
    const store = new ArtifactStore("pipeline-invalid");
    await expect(readFile(
      path.join(store.runDirectory, "logs", "role-reviewer-correctness-round1.log"),
      "utf8",
    )).resolves.toBe("not json");
    await expect(readFile(
      path.join(store.runDirectory, "logs", "role-reviewer-correctness-round1-repair.log"),
      "utf8",
    )).resolves.toBe("not json either");
    await expect(readFile(
      path.join(store.runDirectory, "pipeline-active.json"),
      "utf8",
    )).rejects.toMatchObject({ code: "ENOENT" });
  }, 120_000);

  it("requires human decision when the candidate adds a skipped test", async () => {
    const repo = await initRepo();
    const spec = validSpec();
    spec.writeAllowlist = ["a.txt", "tests/**"];
    const roleRunner = roundReviews(
      [{ correctness: approve, systems: approve }],
      async () => { throw new Error("fixer must not run"); },
    );
    const edit = async (checkout: string): Promise<void> => {
      await writeFile(path.join(checkout, "a.txt"), "candidate\n");
      await mkdir(path.join(checkout, "tests"));
      await writeFile(path.join(checkout, "tests", "candidate.test.ts"), [
        "it.skip(\"newly skipped\", () => {});",
        "",
      ].join("\n"));
    };

    const result = await runPipeline(
      repo,
      spec,
      dependencies({ runId: "pipeline-weakened", roleRunner, edit }),
    );

    expect(result.status).toBe("human-decision-required");
    expect(result.verification?.testsSkipped).toBeGreaterThan(0);
  });

  it("passes an architect-authorized test deletion and records its evidence", async () => {
    const repo = await initRepo();
    await mkdir(path.join(repo, "tests"));
    await writeFile(path.join(repo, "tests", "obsolete.test.ts"), "it('works', () => {});\n");
    await runGit(repo, ["add", "tests/obsolete.test.ts"]);
    await runGit(repo, [
      "-c",
      "user.name=Claude Architect Test",
      "-c",
      "user.email=claude-architect@example.invalid",
      "commit",
      "-q",
      "-m",
      "add obsolete test",
    ]);
    const spec = validSpec();
    spec.writeAllowlist = ["a.txt", "tests/**"];
    spec.allowedTestDeletions = ["tests/obsolete.test.ts"];
    const roleRunner = roundReviews(
      [{ correctness: approve, systems: approve }],
      async () => { throw new Error("fixer must not run"); },
    );

    const result = await runPipeline(
      repo,
      spec,
      dependencies({
        runId: "pipeline-authorized-test-deletion",
        roleRunner,
        edit: async checkout => {
          await writeFile(path.join(checkout, "a.txt"), "candidate\n");
          await rm(path.join(checkout, "tests", "obsolete.test.ts"));
        },
      }),
    );

    expect(result.status).toBe("decision-ready");
    expect(result.verification?.testsDeleted).toBe(0);
    expect(result.verification?.evidence.authorizedTestDeletions)
      .toEqual(["tests/obsolete.test.ts"]);
  }, 120_000);

  it("persists round and verification artifacts", async () => {
    const repo = await initRepo();
    const runId = "pipeline-artifacts";
    const roleRunner = roundReviews(
      [{ correctness: approve, systems: approve }],
      async () => { throw new Error("fixer must not run"); },
    );

    const result = await runPipeline(repo, validSpec(), dependencies({ runId, roleRunner }));

    expect(result.verification?.evidence).not.toHaveProperty("authorizedTestDeletions");

    const store = new ArtifactStore(runId);
    await expect(store.readPipelineArtifact("round-1-review-correctness"))
      .resolves.toEqual(approve);
    await expect(store.readPipelineArtifact("round-1-review-systems"))
      .resolves.toEqual(approve);
    await expect(store.readPipelineArtifact("round-1-consolidated"))
      .resolves.toMatchObject({ findings: [] });
    const persistedVerification = await store.readPipelineArtifact<PipelineVerificationReport>("verification");
    expect(persistedVerification?.evidence).not.toHaveProperty("authorizedTestDeletions");
    expect(persistedVerification)
      .toMatchObject({
        pass: true,
        workspaceClean: true,
        evidence: {
          failures: [],
          commandOutcomes: [{
            stdoutRef: "logs/pipeline-verification-0-stdout.log",
            stderrRef: "logs/pipeline-verification-0-stderr.log",
          }],
        },
      });
    await expect(readFile(
      path.join(store.runDirectory, "logs", "pipeline-verification-0-stdout.log"),
      "utf8",
    )).resolves.toBe("");
    await expect(readFile(
      path.join(store.runDirectory, "logs", "pipeline-verification-0-stderr.log"),
      "utf8",
    )).resolves.toBe("");
    await expect(store.readPipelineArtifact("pipeline-result"))
      .resolves.toMatchObject({ status: "decision-ready", runId });
  });

  it("fails the final gate when every verification command is platform-skipped", async () => {
    const repo = await initRepo();
    const spec = validSpec();
    spec.verification[0] = {
      ...spec.verification[0]!,
      platform: {
        os: [getPlatformServices().os === "darwin" ? "linux" : "darwin"],
      },
    };
    const roleRunner = roundReviews(
      [{ correctness: approve, systems: approve }],
      async () => { throw new Error("fixer must not run"); },
    );

    const result = await runPipeline(
      repo,
      spec,
      dependencies({ runId: "pipeline-all-skipped", roleRunner }),
    );

    expect(result.status).toBe("human-decision-required");
    expect(result.verification?.pass).toBe(false);
    expect(result.verification?.evidence.failures).toContain("empty-verification");
    expect(result.gate.reasons).toContain("clean-room verification failed");
  });

  it("does not expose unimported private fixer objects after worktree cleanup", async () => {
    const repo = await initRepo();
    const linked = path.join(await temporaryDirectory("ca-private-objects-"), "linked");
    await runGit(repo, ["worktree", "add", "--detach", "-q", linked, "HEAD"]);
    const objectAccess = await resolveLinkedWorktreeWritableRoots(linked);
    const env = {
      GIT_OBJECT_DIRECTORY: objectAccess.privateObjectsDir,
      GIT_ALTERNATE_OBJECT_DIRECTORIES: objectAccess.sharedObjectsDir,
    };
    await writeFile(path.join(linked, "private.txt"), "private only\n");
    await runGit(linked, ["add", "private.txt"], env);
    await runGit(linked, ["commit", "-q", "-m", "private object"], env);
    const privateCommit = await runGit(linked, ["rev-parse", "HEAD"], env);

    expect((await git(repo, ["cat-file", "-e", `${privateCommit}^{commit}`])).exitCode)
      .not.toBe(0);
    await runGit(repo, ["worktree", "remove", "--force", linked]);
    expect((await git(repo, ["cat-file", "-e", `${privateCommit}^{commit}`])).exitCode)
      .not.toBe(0);
  });

  it("propagates the attempt classification when the implement phase does not verify", async () => {
    const repo = await initRepo();
    const failing: AttemptResult = {
      resultVersion: "1",
      runId: "pipeline-attempt-classification",
      status: "failed",
      failure: "verification-failure",
      summary: "candidate did not pass independent verification",
      producerSummary: "test producer",
      candidate: null,
      requestedVerification: [],
      executedVerification: [],
      unresolvedIssues: ["base-changed"],
      evidence: { structural: { failures: ["base-changed"] } },
      logsRef: "logs/producer.log",
      producerId: "stub",
      producerVersion: "1",
      producerModel: null,
      durationMs: 1,
      sessionId: null,
    };

    const result = await runPipeline(repo, validSpec(), {
      verifier: passingVerifier,
      ps: getPlatformServices(),
      registry: new ProducerRegistry([]),
      roleRunner: async () => {
        throw new Error("roleRunner must not run for a non-verified implement phase");
      },
      runAttempt: async () => failing,
    });

    expect(result.status).toBe("failed");
    expect(result.slices).toEqual([]);
    expect(result.haltedSliceIndex).toBeNull();
    expect(result.failure).toBe("verification-failure");
    expect(result.gate.reasons).toContain("implement phase did not produce a verified candidate");
  });
});
