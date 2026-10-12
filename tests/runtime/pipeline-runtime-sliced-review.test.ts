import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { handleDecideCandidate, handleIntegrateCandidate } from "../../src/mcp/tools.js";
import { runPipeline } from "../../src/pipeline/pipeline-runtime.js";
import type { RoleRunArgs, RoleRunResult } from "../../src/pipeline/role-runner.js";
import { ArtifactStore } from "../../src/runtime/artifact-store.js";
import { AcceptanceVerifier } from "../../src/verify/acceptance-verifier.js";
import { runGit, expectRefMissing, expectRefPresent, fenced, success, approve, blocker, fakeAttempt, dependencies, initSlicedRepo, slicedSpec, commitRoleFile, installPipelineRuntimeHooks } from "../support/pipeline-runtime-harness.js";

installPipelineRuntimeHooks();

describe("runPipeline", () => {
  it("runs independent per-slice reviewers with slice-local evidence and logs", async () => {
    const repo = await initSlicedRepo();
    const runId = "pipeline-slices-review";
    const spec = slicedSpec(true);
    const initialRun = fakeAttempt(runId, async checkout => {
      await writeFile(path.join(checkout, "slice-one.txt"), "slice one candidate\n");
    });
    const reviewerArgs: RoleRunArgs[] = [];
    const roleRunner = async (args: RoleRunArgs): Promise<RoleRunResult> => {
      if (args.role === "implementer") {
        const candidateCommit = await commitRoleFile(
          args,
          "slice-two.txt",
          "slice two candidate\n",
        );
        return success(fenced({
          reportVersion: "1",
          candidateCommit,
          status: "continue",
          summary: "Producer continuation is non-authoritative.",
          nextSteps: "Objective gates decide advancement.",
        }));
      }
      if (args.role === "reviewer-correctness") {
        reviewerArgs.push(args);
        return success(fenced(approve));
      }
      throw new Error(`unexpected role ${args.role}`);
    };
    const deps = dependencies({ runId, roleRunner });
    deps.runAttempt = initialRun;

    const result = await runPipeline(repo, spec, deps);

    expect(result.status).toBe("decision-ready");
    expect(result.slices).toHaveLength(2);
    expect(reviewerArgs).toHaveLength(3);
    expect(reviewerArgs.map(args => path.basename(args.worktreePath))).toEqual([
      `${runId}-slice-1-attempt-0-review`,
      `${runId}-slice-2-attempt-0-review`,
      `${runId}-round-1-review`,
    ]);
    expect(reviewerArgs[0]?.baseSpec.objective).toBe("Implement slice one only.");
    expect(reviewerArgs[0]?.pkg.candidateDiff).toContain("slice one candidate");
    expect(reviewerArgs[0]?.pkg.candidateDiff).not.toContain("slice two candidate");
    expect(reviewerArgs[0]?.pkg.testEvidence).toContain('"slice-one-check"');
    expect(reviewerArgs[1]?.baseSpec.objective).toBe("Implement slice two only.");
    expect(reviewerArgs[1]?.pkg.candidateDiff).toContain("slice two candidate");
    expect(reviewerArgs[1]?.pkg.candidateDiff).not.toContain("slice one candidate");
    expect(reviewerArgs[1]?.pkg.testEvidence).toContain('"slice-two-check"');
    expect(reviewerArgs[2]?.baseSpec.objective).toBe("Implement both ordered slices.");
    expect(reviewerArgs[2]?.pkg.testEvidence).toContain('"sliceIndex":1');
    expect(reviewerArgs[2]?.pkg.testEvidence).toContain('"sliceIndex":2');
    expect(result.slices.map(slice => slice.perSliceReview)).toEqual([
      { findings: [] },
      { findings: [] },
    ]);
    expect(result.slices.map(slice => slice.roleLogRefs)).toEqual([
      [
        "logs/producer.log",
        "logs/role-reviewer-correctness-slice-1-attempt-0-round1.log",
      ],
      [
        "logs/role-implementer-slice-2-attempt-0-increment1.log",
        "logs/role-reviewer-correctness-slice-2-attempt-0-round1.log",
      ],
    ]);
  }, 120_000);

  it("returns an explicit failed sliced result when objective routing halts", async () => {
    const repo = await initSlicedRepo();
    const runId = "pipeline-slices-halt";
    const spec = slicedSpec();
    spec.writeAllowlist.push("a.txt");
    const initialRun = fakeAttempt(runId, async checkout => {
      await writeFile(path.join(checkout, "a.txt"), "out of slice one scope\n");
    });
    let reviewerCalls = 0;
    const roleRunner = async (args: RoleRunArgs): Promise<RoleRunResult> => {
      if (args.role === "implementer") {
        const candidateCommit = await commitRoleFile(
          args,
          "a.txt",
          "still out of slice one scope\n",
        );
        return success(fenced({
          reportVersion: "1",
          candidateCommit,
          status: "complete",
          summary: "Untrusted repair remained outside the slice.",
        }));
      }
      reviewerCalls += 1;
      return success(fenced(approve));
    };
    const deps = dependencies({ runId, roleRunner });
    deps.runAttempt = initialRun;
    const baselineCommit = await runGit(repo, ["rev-parse", "HEAD"]);

    const result = await runPipeline(repo, spec, deps);

    expect(result).toMatchObject({
      status: "failed",
      increments: [],
      haltedSliceIndex: 1,
      rounds: [],
      verification: null,
      finalCandidateCommit: baselineCommit,
      failure: "verification-failure",
    });
    expect(result.slices).toHaveLength(1);
    expect(result.slices[0]).toMatchObject({
      index: 1,
      route: "halt",
      roundsUsed: 1,
      reasons: ["slice verification failed", "out-of-scope diff: a.txt"],
    });
    expect(result.slices[0]?.attempts).toHaveLength(2);
    expect(reviewerCalls).toBe(0);
    expect(result.attempt.candidate?.candidateCommitOid).not.toBe(result.finalCandidateCommit);
    const store = new ArtifactStore(runId);
    await expect(store.readPipelineArtifact("slice-1-attempt-0"))
      .resolves.toMatchObject({ route: "repair" });
    await expect(store.readPipelineArtifact("slice-1-attempt-1"))
      .resolves.toMatchObject({ route: "halt" });
    await expect(store.readPipelineArtifact("slice-1"))
      .resolves.toMatchObject({ route: "halt" });
    const archived = await store.readResult();
    expect(archived).toMatchObject({
      status: "failed",
      failure: "verification-failure",
      candidate: result.attempt.candidate,
    });
    expect(result.attempt).toEqual(archived);
    expect(await runGit(repo, ["rev-parse", result.attempt.candidate!.anchorRef]))
      .toBe(result.attempt.candidate!.candidateCommitOid);
    await writeFile(
      path.join(store.runDirectory, "decision.json"),
      `${JSON.stringify({
        decision: "accepted",
        recordedAt: "2026-07-19T12:00:00.000Z",
      })}\n`,
    );
    await expect(handleIntegrateCandidate(
      repo,
      runId,
      result.attempt.candidate!.manifestHash,
    )).resolves.toEqual({
      ok: false,
      error: "candidate-not-verified",
      diagnostic: "candidate did not complete independent verification",
    });
  }, 120_000);

  it("hands a later-slice halt to the human as an acceptable partial candidate", async () => {
    const repo = await initSlicedRepo();
    const runId = "pipeline-slices-partial-halt";
    const spec = slicedSpec();
    const initialRun = fakeAttempt(runId, async checkout => {
      await writeFile(path.join(checkout, "slice-one.txt"), "slice one candidate\n");
    });
    let reviewerCalls = 0;
    const roleRunner = async (args: RoleRunArgs): Promise<RoleRunResult> => {
      if (args.role === "implementer") {
        // Slice two never satisfies its verification, so it exhausts its repair
        // budget and halts — but only after slice one has already advanced.
        const candidateCommit = await commitRoleFile(
          args,
          "slice-two.txt",
          "wrong slice two\n",
        );
        return success(fenced({
          reportVersion: "1",
          candidateCommit,
          status: "complete",
          summary: "Producer claim is not objective evidence.",
        }));
      }
      reviewerCalls += 1;
      return success(fenced(approve));
    };
    const deps = dependencies({ runId, roleRunner });
    deps.runAttempt = initialRun;
    const baselineCommit = await runGit(repo, ["rev-parse", "HEAD"]);

    const result = await runPipeline(repo, spec, deps);

    // A halt after at least one advance is handed to the human, not reported
    // failed: the design routes it to human-decision-required with the partial
    // branch promoted for a decision.
    expect(result).toMatchObject({
      status: "human-decision-required",
      haltedSliceIndex: 2,
      failure: null,
      increments: [],
      rounds: [],
    });
    expect(result.slices.map(slice => slice.route)).toEqual(["advance", "halt"]);
    expect(result.slices[1]?.attempts).toHaveLength(2);
    expect(reviewerCalls).toBe(0);
    expect(result.gate).toMatchObject({ decisionReady: false, requiresHumanDecision: true });
    expect(result.finalCandidateCommit).not.toBe(baselineCommit);

    // The partial branch keeps slice one's advance and leaves slice two at its
    // baseline; the composed verification honestly fails on the unbuilt slice.
    expect(await runGit(repo, ["show", `${result.finalCandidateCommit}:slice-one.txt`]))
      .toBe("slice one candidate");
    expect(await runGit(repo, ["show", `${result.finalCandidateCommit}:slice-two.txt`]))
      .toBe("slice two base");
    expect(result.verification?.pass).toBe(false);

    // The promoted partial is a real verified-candidate anchored at the partial
    // branch, so the human can accept it — the crux of a human-decision halt.
    const store = new ArtifactStore(runId);
    const archivedResult = await store.readResult();
    expect(archivedResult).toMatchObject({
      status: "verified-candidate",
      failure: null,
      candidate: { candidateCommitOid: result.finalCandidateCommit },
    });
    expect(await runGit(repo, ["rev-parse", result.attempt.candidate!.anchorRef]))
      .toBe(result.finalCandidateCommit);
    await expect(handleDecideCandidate(
      repo,
      runId,
      "accepted",
      archivedResult!.candidate!.manifestHash,
    ))
      .resolves.toEqual({ recorded: true });
  }, 120_000);

  it("archives a SliceExecutionError as the returned non-integrable attempt", async () => {
    const repo = await initSlicedRepo();
    const runId = "pipeline-slices-role-failure";
    const spec = slicedSpec();
    const initialRun = fakeAttempt(runId, async checkout => {
      await writeFile(path.join(checkout, "slice-one.txt"), "slice one candidate\n");
    });
    const deps = dependencies({
      runId,
      roleRunner: async args => {
        if (args.role === "implementer") {
          return {
            ok: false,
            rawOutput: "",
            failure: "timeout",
            producerId: "stub",
          };
        }
        throw new Error(`unexpected role ${args.role}`);
      },
    });
    deps.runAttempt = initialRun;

    const result = await runPipeline(repo, spec, deps);

    expect(result).toMatchObject({
      status: "failed",
      failure: "timeout",
      attempt: {
        status: "failed",
        failure: "timeout",
        candidate: null,
      },
    });
    const store = new ArtifactStore(runId);
    await expect(store.readResult()).resolves.toEqual(result.attempt);
    await expectRefMissing(repo, `refs/claude-architect/candidates/${runId}`);
    await expect(readFile(
      path.join(store.runDirectory, "pipeline-active.json"),
      "utf8",
    )).rejects.toMatchObject({ code: "ENOENT" });
  }, 120_000);

  it("labels sliced candidate provenance failures as slice implementer failures", async () => {
    const repo = await initSlicedRepo();
    const runId = "pipeline-slices-provenance-label";
    const spec = slicedSpec();
    const initialRun = fakeAttempt(runId, async checkout => {
      await writeFile(path.join(checkout, "slice-one.txt"), "slice one candidate\n");
    });
    const deps = dependencies({
      runId,
      roleRunner: async args => {
        if (args.role === "implementer") {
          return success(fenced({
            reportVersion: "1",
            candidateCommit: "d".repeat(40),
            status: "complete",
            summary: "reported a nonexistent commit",
          }));
        }
        throw new Error(`unexpected role ${args.role}`);
      },
    });
    deps.runAttempt = initialRun;

    const result = await runPipeline(repo, spec, deps);

    expect(result.gate.reasons).toContain("slice implementer reported a missing candidate commit");
    expect(result.gate.reasons.some(reason => reason.includes("fix phase"))).toBe(false);
  }, 120_000);

  it("archives an initial per-slice review error before returning failure", async () => {
    const repo = await initSlicedRepo();
    const runId = "pipeline-slices-initial-review-failure";
    const spec = slicedSpec(true);
    const initialRun = fakeAttempt(runId, async checkout => {
      await writeFile(path.join(checkout, "slice-one.txt"), "slice one candidate\n");
    });
    const deps = dependencies({
      runId,
      roleRunner: async args => {
        if (args.role === "reviewer-correctness") {
          return {
            ok: false,
            rawOutput: "",
            failure: "timeout",
            producerId: "stub",
          };
        }
        throw new Error(`unexpected role ${args.role}`);
      },
    });
    deps.runAttempt = initialRun;

    const result = await runPipeline(repo, spec, deps);

    expect(result).toMatchObject({
      status: "failed",
      failure: "producer-failure",
      attempt: {
        status: "failed",
        failure: "producer-failure",
        candidate: null,
      },
    });
    await expect(new ArtifactStore(runId).readResult()).resolves.toEqual(result.attempt);
    await expectRefMissing(repo, `refs/claude-architect/candidates/${runId}`);
  }, 120_000);

  it("salvages a verified composed candidate when the review role fails", async () => {
    const repo = await initSlicedRepo();
    const runId = "pipeline-slices-composed-review-failure";
    const spec = slicedSpec();
    const initialRun = fakeAttempt(runId, async checkout => {
      await writeFile(path.join(checkout, "slice-one.txt"), "slice one candidate\n");
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
        if (args.role === "reviewer-correctness") {
          return {
            ok: false,
            rawOutput: "",
            failure: "timeout",
            producerId: "stub",
          };
        }
        throw new Error(`unexpected role ${args.role}`);
      },
    });
    deps.runAttempt = initialRun;

    const result = await runPipeline(repo, spec, deps);

    // A reviewer that cannot run is an orchestration failure, not a verdict.
    // The composed bytes still passed independent verification, so they are
    // presented for the human review the pipeline could not perform itself.
    expect(result).toMatchObject({
      status: "human-decision-required",
      failure: null,
      attempt: { status: "verified-candidate", failure: null },
    });
    expect(result.attempt.candidate).not.toBeNull();
    expect(result.verification?.pass).toBe(true);
    expect(result.gate.requiresHumanDecision).toBe(true);
    expect(result.gate.reasons[0]).toContain("review phase");

    // Salvage is only worth anything if the trusted accept path can load these
    // bytes: the archived result — not the in-memory one — is what it reads.
    const archived = await new ArtifactStore(runId).readResult();
    expect(archived).toMatchObject({ status: "verified-candidate", failure: null });
    expect(archived?.candidate?.candidateCommitOid).toBe(result.finalCandidateCommit);
    const archivedManifest = await new ArtifactStore(runId).readManifest();
    expect(archivedManifest?.candidateManifestHash).toBe(archived?.candidate?.manifestHash);
    expect(archived?.evidence.pipelineReviewIncomplete).toMatchObject({
      failure: "producer-failure",
    });
    // The definitive check: the real accept gate must admit these bytes.
    await expect(handleDecideCandidate(
      repo,
      runId,
      "accepted",
      archived!.candidate!.manifestHash,
    )).resolves.toEqual({ recorded: true });
  }, 120_000);

  it("demotes the promoted salvage candidate when its re-verification throws", async () => {
    // Bug t07-1: salvage promoted the composed candidate (moving the anchor),
    // then the fallback demoted the pre-promotion attempt, whose exact-OID
    // anchor delete could no longer match.
    const repo = await initSlicedRepo();
    const runId = "pipeline-slices-salvage-verification-error";
    const deps = dependencies({
      runId,
      roleRunner: async args => {
        if (args.role === "implementer") {
          return success(fenced({
            reportVersion: "1",
            candidateCommit: await commitRoleFile(args, "slice-two.txt", "slice two candidate\n"),
            status: "complete",
            summary: "slice complete",
          }));
        }
        return { ok: false, rawOutput: "", failure: "timeout", producerId: "stub" };
      },
    });
    deps.runAttempt = fakeAttempt(runId, async checkout => {
      await writeFile(path.join(checkout, "slice-one.txt"), "slice one candidate\n");
    });
    const originalVerify = AcceptanceVerifier.prototype.verify;
    vi.spyOn(AcceptanceVerifier.prototype, "verify").mockImplementation(function (this: AcceptanceVerifier, args) {
      if (String(args.logNamePrefix).includes("salvage")) {
        return Promise.reject(new Error("salvage verification infrastructure failed"));
      }
      return originalVerify.call(this, args);
    });

    const result = await runPipeline(repo, slicedSpec(), deps);

    expect(result).toMatchObject({ status: "failed", failure: "producer-failure" });
    const store = new ArtifactStore(runId);
    await expect(store.readResult()).resolves.toMatchObject({
      status: "failed",
      failure: "producer-failure",
      candidate: null,
    });
    await expectRefMissing(repo, `refs/claude-architect/candidates/${runId}`);
    await expect(store.readPipelineActiveMarker()).resolves.toBeNull();
  }, 120_000);

  it("archives an unexpected final-verification error before clearing lifecycle authority", async () => {
    const repo = await initSlicedRepo();
    const runId = "pipeline-slices-final-verification-error";
    const spec = slicedSpec();
    const initialRun = fakeAttempt(runId, async checkout => {
      await writeFile(path.join(checkout, "slice-one.txt"), "slice one candidate\n");
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
    const originalVerify = AcceptanceVerifier.prototype.verify;
    let verificationCalls = 0;
    vi.spyOn(AcceptanceVerifier.prototype, "verify").mockImplementation(function (this: AcceptanceVerifier, args) {
      verificationCalls += 1;
      if (verificationCalls === 3) {
        return Promise.reject(new Error("final verification infrastructure failed"));
      }
      return originalVerify.call(this, args);
    });

    await expect(runPipeline(repo, spec, deps))
      .rejects.toThrow("final verification infrastructure failed");

    const store = new ArtifactStore(runId);
    await expect(store.readResult()).resolves.toMatchObject({
      status: "failed",
      failure: "verification-failure",
      candidate: expect.any(Object),
    });
    await expect(readFile(
      path.join(store.runDirectory, "pipeline-active.json"),
      "utf8",
    )).rejects.toMatchObject({ code: "ENOENT" });
  }, 120_000);

  it("salvages the reviewed composed candidate when the fixer role fails", async () => {
    const repo = await initSlicedRepo();
    const runId = "pipeline-slices-composed-fixer-failure";
    const spec = slicedSpec();
    const initialRun = fakeAttempt(runId, async checkout => {
      await writeFile(path.join(checkout, "slice-one.txt"), "slice one candidate\n");
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
        if (args.role === "reviewer-correctness") return success(fenced(blocker));
        if (args.role === "fixer") {
          return {
            ok: false,
            rawOutput: "",
            failure: "timeout",
            producerId: "stub",
          };
        }
        throw new Error(`unexpected role ${args.role}`);
      },
    });
    deps.runAttempt = initialRun;

    const result = await runPipeline(repo, spec, deps);

    // The fix never landed, so these are the last reviewed bytes; the blocking
    // finding is what the human decides on, not a reason to destroy the work.
    expect(result).toMatchObject({
      status: "human-decision-required",
      failure: null,
      attempt: { status: "verified-candidate", failure: null },
    });
    expect(result.attempt.candidate).not.toBeNull();
    expect(result.gate.reasons[0]).toContain("fix phase");
    await expectRefPresent(repo, `refs/claude-architect/candidates/${runId}`);
  }, 120_000);

});
