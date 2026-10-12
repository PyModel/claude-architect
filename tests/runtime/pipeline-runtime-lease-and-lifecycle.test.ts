import { createHash } from "node:crypto";
import { readFile, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { git } from "../../src/git/git-exec.js";
import type { CheckoutLock, PlatformServices } from "../../src/platform/platform-services.js";
import { getPlatformServices } from "../../src/platform/select-platform.js";
import type { DelegationSpec } from "../../src/protocol/delegation-spec.js";
import { ProducerRegistry } from "../../src/producers/producer-registry.js";
import {
  runPipeline,
  scopeSpecToSlice,
  type PipelineVerificationReport,
} from "../../src/pipeline/pipeline-runtime.js";
import type { VerificationReport } from "../../src/pipeline/report-types.js";
import type { RoleRunArgs, RoleRunResult } from "../../src/pipeline/role-runner.js";
import { ArtifactStore } from "../../src/runtime/artifact-store.js";
import type { AttemptRuntimeDependencies } from "../../src/runtime/attempt-runtime.js";
import { recoverStaleRuns } from "../../src/runtime/recovery-manager.js";
import { specSha256 } from "../../src/protocol/spec-hash.js";
import { AcceptanceVerifier } from "../../src/verify/acceptance-verifier.js";
import { runGit, expectRefMissing, initRepo, validSpec, fenced, success, approve, blocker, passingVerifier, failedAttemptResult, checkoutLeaseHarness, fakeAttempt, dependencies, expectPipelineAuthorityBlocksTools, roundReviews, commitFix, commitIncrement, initSlicedRepo, slicedSpec, commitRoleFile, installPipelineRuntimeHooks } from "../support/pipeline-runtime-harness.js";
import { platformServicesDouble } from "../helpers/platform-services-double.js";

installPipelineRuntimeHooks();

// Slices type their verification as the bare report, but the pipeline stores
// the evidence-carrying one; the guard checks that instead of assuming it.
function carriesEvidence(report: VerificationReport): report is PipelineVerificationReport {
  return "evidence" in report;
}

function firstStdoutRef(report: VerificationReport | null | undefined): string | undefined {
  return report !== null && report !== undefined && carriesEvidence(report)
    ? report.evidence.commandOutcomes[0]?.stdoutRef
    : undefined;
}

describe("runPipeline", () => {
  it("passes the acquisition-bound identity when canonicalization changes before lock acquisition", async () => {
    const repo = await initRepo();
    const platformServices = getPlatformServices();
    const canonical = await platformServices.canonicalizePath(repo);
    const preAcquireIdentity = `${canonical.gitCommonDir ?? canonical.canonical}-before-acquire`;
    const acquisitionIdentity = `${canonical.gitCommonDir ?? canonical.canonical}-at-acquire`;
    const observations: string[] = [];
    let acquiredLock: CheckoutLock | undefined;
    let releaseCalls = 0;
    let ps: PlatformServices;
    ps = Object.assign(Object.create(platformServices), {
      async canonicalizePath(input: string) {
        const repositoryIdentity = observations.length === 0
          ? preAcquireIdentity
          : acquisitionIdentity;
        observations.push(repositoryIdentity);
        return { input, canonical: canonical.canonical, gitCommonDir: repositoryIdentity };
      },
      async acquireCheckoutLock(checkout: string) {
        const acquired = await ps.canonicalizePath(checkout);
        const repositoryIdentity = acquired.gitCommonDir ?? acquired.canonical;
        acquiredLock = {
          key: createHash("sha256").update(repositoryIdentity).digest("hex"),
          repositoryIdentity,
          async release() { releaseCalls += 1; },
        };
        return acquiredLock;
      },
    }) as PlatformServices;
    let receivedLease: AttemptRuntimeDependencies["borrowedCheckoutLease"];

    const result = await runPipeline(repo, validSpec(), {
      verifier: passingVerifier,
      ps,
      registry: new ProducerRegistry([]),
      roleRunner: async () => { throw new Error("role runner must not run"); },
      runAttempt: async (_checkoutPath, _spec, attemptDeps) => {
        receivedLease = attemptDeps.borrowedCheckoutLease;
        return failedAttemptResult("pipeline-acquisition-bound-identity");
      },
    });

    expect(result.status).toBe("failed");
    expect(observations).toEqual([preAcquireIdentity, acquisitionIdentity]);
    expect(receivedLease).toBe(acquiredLock);
    expect(receivedLease?.repositoryIdentity).toBe(acquisitionIdentity);
    expect(releaseCalls).toBe(1);
  });

  it("holds one checkout lease through attempt, review, fix, verification, and marker cleanup", async () => {
    const repo = await initRepo();
    const runId = "pipeline-continuous-checkout-lease";
    const spec = validSpec();
    spec.implementation = { maxIncrements: 2 };
    const store = new ArtifactStore(runId);
    let releaseObservedLast = false;
    let lease: Awaited<ReturnType<typeof checkoutLeaseHarness>>;
    lease = await checkoutLeaseHarness(repo, {
      onRelease: async () => {
        expect(lease.held()).toBe(true);
        await expect(store.readPipelineActiveMarker()).resolves.toBeNull();
        await expect(store.readPipelineArtifact("pipeline-result"))
          .resolves.toMatchObject({ status: "decision-ready" });
        releaseObservedLast = true;
      },
    });
    const baseRoleRunner = roundReviews([
      { correctness: blocker, systems: approve },
      { correctness: approve, systems: approve },
    ], async args => {
      expect(lease.held()).toBe(true);
      const commit = await commitFix(args, "lease-protected fix\n");
      return success(fenced({
        reportVersion: "1",
        candidateCommit: commit,
        dispositions: [{
          findingId: "F-001",
          disposition: "fixed",
          evidence: "Committed under the pipeline lease.",
          commit,
        }],
      }));
    });
    const roleRunner = async (args: RoleRunArgs): Promise<RoleRunResult> => {
      expect(lease.held()).toBe(true);
      if (args.role === "implementer") {
        const candidateCommit = await commitIncrement(args, "lease-protected increment\n");
        return success(fenced({
          reportVersion: "1",
          candidateCommit,
          status: "complete",
          summary: "increment complete",
        }));
      }
      return baseRoleRunner(args);
    };
    const deps = dependencies({ runId, roleRunner });
    deps.ps = lease.ps;
    const initialRun = deps.runAttempt!;
    let receivedLease: CheckoutLock | undefined;
    deps.runAttempt = async (checkoutPath, receivedSpec, attemptDeps) => {
      expect(lease.held()).toBe(true);
      receivedLease = attemptDeps.borrowedCheckoutLease;
      return initialRun(checkoutPath, receivedSpec, attemptDeps);
    };
    const verify = AcceptanceVerifier.prototype.verify;
    const verifySpy = vi.spyOn(AcceptanceVerifier.prototype, "verify")
      .mockImplementation(function (this: AcceptanceVerifier, args) {
        expect(lease.held()).toBe(true);
        return verify.call(this, args);
      });
    const clearMarker = ArtifactStore.prototype.clearPipelineActiveMarker;
    const clearMarkerSpy = vi.spyOn(ArtifactStore.prototype, "clearPipelineActiveMarker")
      .mockImplementation(function (this: ArtifactStore) {
        expect(lease.held()).toBe(true);
        return clearMarker.call(this);
      });

    const result = await runPipeline(repo, spec, deps);

    expect(result.status).toBe("decision-ready");
    expect(result.increments).toHaveLength(1);
    expect(receivedLease).toBe(lease.lock());
    expect(verifySpy).toHaveBeenCalled();
    expect(clearMarkerSpy).toHaveBeenCalledOnce();
    expect(lease.acquireCalls()).toBe(1);
    expect(lease.releaseCalls()).toBe(1);
    expect(lease.held()).toBe(false);
    expect(releaseObservedLast).toBe(true);
  }, 120_000);

  it("holds the borrowed lease through the early sliced marker and temporary-ref cleanup", async () => {
    const repo = await initSlicedRepo();
    const runId = "pipeline-sliced-continuous-checkout-lease";
    const store = new ArtifactStore(runId);
    const temporaryRef = `refs/claude-architect/slices/${runId}/slice-2-attempt-0`;
    let releaseObservedLast = false;
    let lease: Awaited<ReturnType<typeof checkoutLeaseHarness>>;
    lease = await checkoutLeaseHarness(repo, {
      onRelease: async () => {
        expect(lease.held()).toBe(true);
        await expectRefMissing(repo, temporaryRef);
        await expect(store.readPipelineActiveMarker()).resolves.toBeNull();
        await expect(store.readPipelineArtifact("pipeline-result"))
          .resolves.toMatchObject({ status: "decision-ready" });
        releaseObservedLast = true;
      },
    });
    const deps = dependencies({
      runId,
      edit: async checkout => {
        expect(lease.held()).toBe(true);
        await expect(store.readPipelineActiveMarker()).resolves.toMatchObject({
          sliced: true,
        });
        await writeFile(path.join(checkout, "slice-one.txt"), "slice one candidate\n");
      },
      roleRunner: async args => {
        expect(lease.held()).toBe(true);
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
          expect(await runGit(repo, ["rev-parse", "--verify", temporaryRef]))
            .toMatch(/^[0-9a-f]{40}$/);
          return success(fenced(approve));
        }
        throw new Error(`unexpected role ${args.role}`);
      },
    });
    deps.ps = lease.ps;
    const initialRun = deps.runAttempt!;
    let receivedLease: CheckoutLock | undefined;
    deps.runAttempt = async (checkoutPath, receivedSpec, attemptDeps) => {
      expect(lease.held()).toBe(true);
      receivedLease = attemptDeps.borrowedCheckoutLease;
      return initialRun(checkoutPath, receivedSpec, attemptDeps);
    };
    const verify = AcceptanceVerifier.prototype.verify;
    vi.spyOn(AcceptanceVerifier.prototype, "verify").mockImplementation(function (this: AcceptanceVerifier, args) {
      expect(lease.held()).toBe(true);
      return verify.call(this, args);
    });

    const result = await runPipeline(repo, slicedSpec(), deps);

    expect(result.status).toBe("decision-ready");
    expect(receivedLease).toBe(lease.lock());
    expect(lease.acquireCalls()).toBe(1);
    expect(lease.releaseCalls()).toBe(1);
    expect(lease.held()).toBe(false);
    expect(releaseObservedLast).toBe(true);
  }, 120_000);

  it("releases the checkout lease after a non-verified initial result", async () => {
    const repo = await initRepo();
    const lease = await checkoutLeaseHarness(repo);
    const failing = failedAttemptResult("pipeline-attempt-lock-release");
    let receivedLease: CheckoutLock | undefined;

    const result = await runPipeline(repo, validSpec(), {
      verifier: passingVerifier,
      ps: lease.ps,
      registry: new ProducerRegistry([]),
      roleRunner: async () => { throw new Error("role runner must not run"); },
      runAttempt: async (_checkoutPath, _spec, attemptDeps) => {
        expect(lease.held()).toBe(true);
        receivedLease = attemptDeps.borrowedCheckoutLease;
        return failing;
      },
    });

    expect(result.status).toBe("failed");
    expect(receivedLease).toBe(lease.lock());
    expect(lease.acquireCalls()).toBe(1);
    expect(lease.releaseCalls()).toBe(1);
    expect(lease.held()).toBe(false);
  });

  it("releases the checkout lease when the initial attempt throws", async () => {
    const repo = await initRepo();
    const lease = await checkoutLeaseHarness(repo);

    await expect(runPipeline(repo, validSpec(), {
      verifier: passingVerifier,
      ps: lease.ps,
      registry: new ProducerRegistry([]),
      roleRunner: async () => { throw new Error("role runner must not run"); },
      runAttempt: async () => {
        expect(lease.held()).toBe(true);
        throw new Error("initial attempt failed");
      },
    })).rejects.toThrow("initial attempt failed");

    expect(lease.acquireCalls()).toBe(1);
    expect(lease.releaseCalls()).toBe(1);
    expect(lease.held()).toBe(false);
  });

  it("reports a checkout lease release failure after an otherwise classified result", async () => {
    const repo = await initRepo();
    const releaseError = new Error("checkout lease release failed");
    const lease = await checkoutLeaseHarness(repo, { releaseError });

    await expect(runPipeline(repo, validSpec(), {
      verifier: passingVerifier,
      ps: lease.ps,
      registry: new ProducerRegistry([]),
      roleRunner: async () => { throw new Error("role runner must not run"); },
      runAttempt: async () => failedAttemptResult("pipeline-release-failure"),
    })).rejects.toBe(releaseError);

    expect(lease.acquireCalls()).toBe(1);
    expect(lease.releaseCalls()).toBe(1);
    expect(lease.held()).toBe(false);
  });

  it("aggregates checkout lease release failure with the primary pipeline error", async () => {
    const repo = await initRepo();
    const primaryError = new Error("pipeline primary failure");
    const releaseError = new Error("checkout lease release failed");
    const lease = await checkoutLeaseHarness(repo, { releaseError });
    let thrown: unknown;

    try {
      await runPipeline(repo, validSpec(), {
        verifier: passingVerifier,
        ps: lease.ps,
        registry: new ProducerRegistry([]),
        roleRunner: async () => { throw new Error("role runner must not run"); },
        runAttempt: async () => { throw primaryError; },
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AggregateError);
    expect((thrown as AggregateError).errors).toEqual([primaryError, releaseError]);
    expect(lease.acquireCalls()).toBe(1);
    expect(lease.releaseCalls()).toBe(1);
    expect(lease.held()).toBe(false);
  });

  it("hands the attempt the dispatched spec hash, not the sliced spec's", async () => {
    const repo = await initSlicedRepo();
    const runId = "pipeline-slice-spec-hash";
    const spec = slicedSpec();
    const deps = dependencies({
      runId,
      edit: async checkout => {
        await writeFile(path.join(checkout, "slice-one.txt"), "slice one candidate\n");
      },
      roleRunner: async () => {
        throw new Error("unexpected role run");
      },
    });
    const realAttempt = deps.runAttempt!;
    let handed: string | undefined;
    deps.runAttempt = async (checkoutPath, receivedSpec, attemptDeps) => {
      handed = attemptDeps?.dispatchedSpecSha256;
      // The spec the attempt receives is the slice, which is exactly why the
      // attempt must not derive the run's identity from it.
      expect(specSha256(receivedSpec)).not.toBe(specSha256(spec));
      return realAttempt(checkoutPath, receivedSpec, attemptDeps);
    };

    await runPipeline(repo, spec, deps).catch(() => undefined);

    // scopeSpecToSlice merges the slice over the spec and drops `slices`, so
    // hashing what the attempt receives recorded an identity no caller ever
    // held, and reviewCandidate's correspondence check could never match it.
    expect(handed).toBe(specSha256(spec));
  });

  it("establishes sliced lifecycle authority before the initial candidate is created", async () => {
    const repo = await initSlicedRepo();
    const runId = "pipeline-slices-early-marker";
    let markerBeforeEdit: Awaited<ReturnType<ArtifactStore["readPipelineActiveMarker"]>> | undefined;

    const result = await runPipeline(repo, slicedSpec(), dependencies({
      runId,
      edit: async checkout => {
        markerBeforeEdit = await new ArtifactStore(runId).readPipelineActiveMarker();
        await writeFile(path.join(checkout, "slice-one.txt"), "slice one candidate\n");
      },
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
    }));

    expect(result.status).toBe("decision-ready");
    expect(markerBeforeEdit).toMatchObject({ sliced: true });
  }, 120_000);

  it("does not archive a sliced candidate when lifecycle authority cannot be established", async () => {
    const repo = await initSlicedRepo();
    const runId = "pipeline-slices-marker-write-failure";
    let editCalled = false;
    vi.spyOn(ArtifactStore.prototype, "writePipelineActiveMarker")
      .mockRejectedValueOnce(new Error("pipeline marker write failed"));

    await expect(runPipeline(repo, slicedSpec(), dependencies({
      runId,
      edit: async checkout => {
        editCalled = true;
        await writeFile(path.join(checkout, "slice-one.txt"), "slice one candidate\n");
      },
      roleRunner: async () => { throw new Error("role runner must not run"); },
    }))).rejects.toThrow("pipeline marker write failed");

    expect(editCalled).toBe(false);
    await expect(new ArtifactStore(runId).readResult()).resolves.toBeNull();
  });

  it("advances disjoint slices through private provenance and composed gates", async () => {
    const repo = await initSlicedRepo();
    const runId = "pipeline-slices-advance";
    const spec = slicedSpec();
    const parentSnapshot = structuredClone(spec);
    const initialRun = fakeAttempt(runId, async checkout => {
      await writeFile(path.join(checkout, "slice-one.txt"), "slice one candidate\n");
    });
    let initialSpec: DelegationSpec | undefined;
    let implementerArgs: RoleRunArgs | undefined;
    const temporarySliceRef = `refs/claude-architect/slices/${runId}/slice-2-attempt-0`;
    let observedTemporaryRef = "";
    const reviewArgs: RoleRunArgs[] = [];
    const roleRunner = async (args: RoleRunArgs): Promise<RoleRunResult> => {
      if (args.role === "implementer") {
        implementerArgs = args;
        expect(await readFile(path.join(args.worktreePath, "slice-one.txt"), "utf8"))
          .toBe("slice one candidate\n");
        const candidateCommit = await commitRoleFile(
          args,
          "slice-two.txt",
          "slice two candidate\n",
        );
        return success(fenced({
          reportVersion: "1",
          candidateCommit,
          status: "blocked",
          summary: "Producer status must not control objective routing.",
          blockers: "Untrusted Producer claim.",
        }));
      }
      if (args.role === "reviewer-correctness") {
        observedTemporaryRef = await runGit(repo, ["rev-parse", "--verify", temporarySliceRef]);
        reviewArgs.push(args);
        return success(fenced(approve));
      }
      throw new Error(`unexpected role ${args.role}`);
    };
    const deps = dependencies({ runId, roleRunner });
    deps.runAttempt = async (checkoutPath, receivedSpec, attemptDeps) => {
      initialSpec = structuredClone(receivedSpec);
      return initialRun(checkoutPath, receivedSpec, attemptDeps);
    };
    const acceptanceSpy = vi.spyOn(AcceptanceVerifier.prototype, "verify");

    const result = await runPipeline(repo, spec, deps);

    expect(initialSpec).toEqual(scopeSpecToSlice(parentSnapshot, parentSnapshot.slices![0]!));
    expect(initialSpec).not.toHaveProperty("slices");
    expect(spec).toEqual(parentSnapshot);
    expect(implementerArgs?.baseSpec).toEqual(
      scopeSpecToSlice(parentSnapshot, parentSnapshot.slices![1]!),
    );
    expect(implementerArgs?.pkg.spec).toEqual(implementerArgs?.baseSpec);
    expect(implementerArgs?.pkg.baselineCommit).toBe(result.slices[0]?.candidateCommit);
    expect(implementerArgs?.pkg.candidateCommit).toBe(result.slices[0]?.candidateCommit);
    expect(implementerArgs?.pkg.candidateDiff).toBe("");
    expect(implementerArgs?.pkg).not.toHaveProperty("progress");
    expect(path.basename(implementerArgs?.worktreePath ?? "")).toBe(
      `${runId}-slice-2-attempt-0`,
    );

    expect(reviewArgs).toHaveLength(1);
    expect(reviewArgs[0]?.baseSpec).toEqual(parentSnapshot);
    expect(reviewArgs[0]?.pkg.candidateDiff).toContain("slice one candidate");
    expect(reviewArgs[0]?.pkg.candidateDiff).toContain("slice two candidate");
    expect(reviewArgs[0]?.pkg.testEvidence).toContain('"sliceIndex":1');
    expect(reviewArgs[0]?.pkg.testEvidence).toContain('"sliceIndex":2');
    expect(path.basename(reviewArgs[0]?.worktreePath ?? "")).toBe(`${runId}-round-1-review`);

    expect(result).toMatchObject({
      status: "decision-ready",
      increments: [],
      haltedSliceIndex: null,
      failure: null,
    });
    expect(result.slices).toHaveLength(2);
    expect(result.slices.map(slice => slice.route)).toEqual(["advance", "advance"]);
    expect(result.slices[0]?.roleLogRefs).toEqual(["logs/producer.log"]);
    expect(result.slices[1]?.roleLogRefs).toEqual([
      "logs/role-implementer-slice-2-attempt-0-increment1.log",
    ]);
    expect(observedTemporaryRef).toBe(result.slices[1]?.candidateCommit);
    expect((await git(repo, ["rev-parse", "--verify", "--quiet", temporarySliceRef])).exitCode)
      .not.toBe(0);
    expect(result.slices[1]?.verification?.scopeViolations).toEqual([]);
    expect(result.rounds).toHaveLength(1);
    expect(result.verification?.pass).toBe(true);

    expect(acceptanceSpy.mock.calls.map(call => path.basename(call[0].worktreePath))).toEqual([
      `${runId}-slice-1-attempt-0-verify`,
      `${runId}-slice-2-attempt-0-verify`,
      `${runId}-final-verify`,
    ]);
    const verificationIds = acceptanceSpy.mock.calls.map(call => call[0].verificationId?.());
    expect(verificationIds).toEqual([
      `${runId}-slice-1-attempt-0-pipeline`,
      `${runId}-slice-2-attempt-0-pipeline`,
      `${runId}-final-pipeline`,
    ]);
    const store = new ArtifactStore(runId);
    const sliceOneStdout = firstStdoutRef(result.slices[0]?.verification);
    const sliceTwoStdout = firstStdoutRef(result.slices[1]?.verification);
    const finalStdout = result.verification?.evidence.commandOutcomes[0]?.stdoutRef;
    expect([sliceOneStdout, sliceTwoStdout, finalStdout]).toEqual([
      "logs/slice-1-attempt-0-pipeline-verification-0-stdout.log",
      "logs/slice-2-attempt-0-pipeline-verification-0-stdout.log",
      "logs/final-pipeline-verification-0-stdout.log",
    ]);
    const nestedWorktrees = await Promise.all(
      [sliceOneStdout, sliceTwoStdout, finalStdout].map(async ref =>
        path.basename(await readFile(path.join(store.runDirectory, ref!), "utf8"))),
    );
    expect(nestedWorktrees).toEqual([
      `verify-${runId}-slice-1-attempt-0-pipeline`,
      `verify-${runId}-slice-2-attempt-0-pipeline`,
      `verify-${runId}-final-pipeline`,
    ]);
    expect(new Set([
      implementerArgs?.worktreePath,
      reviewArgs[0]?.worktreePath,
      ...acceptanceSpy.mock.calls.map(call => call[0].worktreePath),
      ...nestedWorktrees,
    ]).size).toBe(8);

    await expect(store.readPipelineArtifact("slice-1-attempt-0"))
      .resolves.toMatchObject({ sliceIndex: 1, attempt: 0, route: "advance" });
    await expect(store.readPipelineArtifact("slice-1"))
      .resolves.toMatchObject({ index: 1, route: "advance" });
    await expect(store.readPipelineArtifact("slice-2-attempt-0"))
      .resolves.toMatchObject({ sliceIndex: 2, attempt: 0, route: "advance" });
    await expect(store.readPipelineArtifact("slice-2"))
      .resolves.toMatchObject({ index: 2, route: "advance" });
    expect(result.attempt.candidate?.candidateCommitOid).toBe(result.finalCandidateCommit);
    await expect(store.readResult()).resolves.toMatchObject({
      candidate: { candidateCommitOid: result.finalCandidateCommit },
    });
    expect(await runGit(repo, ["rev-parse", result.attempt.candidate!.anchorRef]))
      .toBe(result.finalCandidateCommit);
    expect(await runGit(repo, ["show", `${result.finalCandidateCommit}:slice-one.txt`]))
      .toBe("slice one candidate");
    expect(await runGit(repo, ["show", `${result.finalCandidateCommit}:slice-two.txt`]))
      .toBe("slice two candidate");
  }, 120_000);

  it("retains lifecycle authority when a primary failure coincides with incomplete ref cleanup", async () => {
    const repo = await initSlicedRepo();
    const runId = "pipeline-slices-cleanup-errors";
    const spec = slicedSpec();
    const initialRun = fakeAttempt(runId, async checkout => {
      await writeFile(path.join(checkout, "slice-one.txt"), "slice one candidate\n");
    });
    const baselineCommit = await runGit(repo, ["rev-parse", "HEAD"]);
    const temporarySliceRef = `refs/claude-architect/slices/${runId}/slice-2-attempt-0`;
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
          status: "complete",
          summary: "slice complete",
        }));
      }
      if (args.role === "reviewer-correctness") {
        const expectedOid = await runGit(repo, ["rev-parse", "--verify", temporarySliceRef]);
        await runGit(repo, [
          "update-ref",
          temporarySliceRef,
          baselineCommit,
          expectedOid,
        ]);
        throw new Error("primary composed-review failure");
      }
      throw new Error(`unexpected role ${args.role}`);
    };
    const deps = dependencies({ runId, roleRunner });
    deps.runAttempt = initialRun;
    const markerCleanup = vi.spyOn(ArtifactStore.prototype, "clearPipelineActiveMarker");

    let thrown: unknown;
    try {
      await runPipeline(repo, spec, deps);
    } catch (error) {
      thrown = error;
    }

    const messages: string[] = [];
    const collectMessages = (error: unknown): void => {
      if (error instanceof Error) messages.push(error.message);
      if (error instanceof AggregateError) error.errors.forEach(collectMessages);
    };
    collectMessages(thrown);
    expect(thrown).toBeInstanceOf(AggregateError);
    expect(messages).toContain("primary composed-review failure");
    expect(messages.some(message => message.includes("delete temporary slice ref"))).toBe(true);
    expect(markerCleanup).not.toHaveBeenCalled();
    await expect(new ArtifactStore(runId).readPipelineActiveMarker()).resolves.toMatchObject({
      sliced: true,
    });
    expect(await runGit(repo, ["rev-parse", "--verify", temporarySliceRef]))
      .toBe(baselineCommit);
  }, 120_000);

  it("archives a temporary-ref cleanup failure but retains lifecycle authority", async () => {
    const repo = await initSlicedRepo();
    const runId = "pipeline-slices-ref-cleanup-failure";
    const spec = slicedSpec();
    const initialRun = fakeAttempt(runId, async checkout => {
      await writeFile(path.join(checkout, "slice-one.txt"), "slice one candidate\n");
    });
    const baselineCommit = await runGit(repo, ["rev-parse", "HEAD"]);
    const temporarySliceRef = `refs/claude-architect/slices/${runId}/slice-2-attempt-0`;
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
          status: "complete",
          summary: "slice complete",
        }));
      }
      if (args.role === "reviewer-correctness") {
        const expectedOid = await runGit(repo, ["rev-parse", "--verify", temporarySliceRef]);
        await runGit(repo, [
          "update-ref",
          temporarySliceRef,
          baselineCommit,
          expectedOid,
        ]);
        return success(fenced(approve));
      }
      throw new Error(`unexpected role ${args.role}`);
    };
    const deps = dependencies({ runId, roleRunner });
    deps.runAttempt = initialRun;

    await expect(runPipeline(repo, spec, deps))
      .rejects.toThrow("delete temporary slice ref");

    const store = new ArtifactStore(runId);
    await expect(store.readResult()).resolves.toMatchObject({
      status: "failed",
      failure: "verification-failure",
      candidate: expect.any(Object),
    });
    await expect(store.readPipelineActiveMarker()).resolves.toMatchObject({ sliced: true });
    const archived = await store.readResult();
    await expectPipelineAuthorityBlocksTools(
      repo,
      runId,
      archived!.candidate!.manifestHash,
    );
    expect(await runGit(repo, ["rev-parse", temporarySliceRef])).toBe(baselineCommit);
  }, 120_000);

  it("retains lifecycle authority when terminal failure archival does not complete", async () => {
    const repo = await initSlicedRepo();
    const runId = "pipeline-slices-archive-failure";
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
    const promotion = vi.spyOn(ArtifactStore.prototype, "promoteTerminalArtifacts")
      .mockRejectedValueOnce(new Error("terminal archive failed"));

    await expect(runPipeline(repo, spec, deps)).rejects.toThrow(
      "sliced pipeline failed and its attempt result could not be archived",
    );

    const store = new ArtifactStore(runId);
    expect(promotion).toHaveBeenCalledOnce();
    await expect(store.readPipelineActiveMarker()).resolves.toMatchObject({ sliced: true });
    const archived = await store.readResult();
    expect(archived).toMatchObject({ status: "verified-candidate" });
    await expectRefMissing(repo, archived!.candidate!.anchorRef);
    await expectPipelineAuthorityBlocksTools(
      repo,
      runId,
      archived!.candidate!.manifestHash,
    );

    promotion.mockRestore();
    await expect(recoverStaleRuns({
      platformServices: platformServicesDouble({
        os: "darwin",
        async getProcessStartToken() { return null; },
        async terminateProcessTreeByPid() {},
      }),
      isProcessAlive: () => false,
    })).resolves.toEqual({ recovered: [], quarantined: [] });

    await expect(store.readResult()).resolves.toMatchObject({
      status: "failed",
      failure: "verification-failure",
      candidate: expect.any(Object),
    });
    await expect(store.readPipelineActiveMarker()).resolves.toBeNull();
    await expectRefMissing(repo, archived!.candidate!.anchorRef);
    const oldTime = new Date(Date.now() - 60_000);
    await utimes(store.runDirectory, oldTime, oldTime);
    await expect(store.prune({
      maxAgeMs: 1_000,
      maxBytes: Number.MAX_SAFE_INTEGER,
    })).resolves.toMatchObject({ removed: [runId] });
    await expect(store.readResult()).resolves.toBeNull();
  }, 120_000);

  it("refuses candidate-null archival when the exact run anchor moved", async () => {
    const repo = await initSlicedRepo();
    const runId = "pipeline-slices-moved-failure-anchor";
    const spec = slicedSpec(true);
    const initialRun = fakeAttempt(runId, async checkout => {
      await writeFile(path.join(checkout, "slice-one.txt"), "slice one candidate\n");
    });
    const movedOid = await runGit(repo, ["rev-parse", "HEAD"]);
    const anchorRef = `refs/claude-architect/candidates/${runId}`;
    const deps = dependencies({
      runId,
      roleRunner: async args => {
        if (args.role === "reviewer-correctness") {
          const expectedOid = await runGit(repo, ["rev-parse", anchorRef]);
          await runGit(repo, ["update-ref", anchorRef, movedOid, expectedOid]);
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

    let thrown: unknown;
    try {
      await runPipeline(repo, spec, deps);
    } catch (error) {
      thrown = error;
    }

    const messages: string[] = [];
    const collectMessages = (error: unknown): void => {
      if (error instanceof Error) messages.push(error.message);
      if (error instanceof AggregateError) error.errors.forEach(collectMessages);
    };
    collectMessages(thrown);
    expect(messages.some(message => message.includes("delete sliced candidate anchor"))).toBe(true);
    expect(await runGit(repo, ["rev-parse", anchorRef])).toBe(movedOid);
    const store = new ArtifactStore(runId);
    const archived = await store.readResult();
    expect(archived).toMatchObject({ status: "verified-candidate" });
    await expect(store.readPipelineActiveMarker()).resolves.toMatchObject({ sliced: true });
    await expectPipelineAuthorityBlocksTools(
      repo,
      runId,
      archived!.candidate!.manifestHash,
    );
  }, 120_000);

  it("refuses candidate-null archival for a noncanonical candidate anchor", async () => {
    const repo = await initSlicedRepo();
    const runId = "pipeline-slices-noncanonical-failure-anchor";
    const spec = slicedSpec(true);
    const initialRun = fakeAttempt(runId, async checkout => {
      await writeFile(path.join(checkout, "slice-one.txt"), "slice one candidate\n");
    });
    const canonicalRef = `refs/claude-architect/candidates/${runId}`;
    const foreignRef = `${canonicalRef}-foreign`;
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
    deps.runAttempt = async (checkoutPath, receivedSpec, attemptDeps) => {
      const result = await initialRun(checkoutPath, receivedSpec, attemptDeps);
      await runGit(repo, ["update-ref", foreignRef, result.candidate!.candidateCommitOid]);
      return {
        ...result,
        candidate: { ...result.candidate!, anchorRef: foreignRef },
      };
    };

    let thrown: unknown;
    try {
      await runPipeline(repo, spec, deps);
    } catch (error) {
      thrown = error;
    }

    const messages: string[] = [];
    const collectMessages = (error: unknown): void => {
      if (error instanceof Error) messages.push(error.message);
      if (error instanceof AggregateError) error.errors.forEach(collectMessages);
    };
    collectMessages(thrown);
    expect(messages).toContain("sliced candidate anchor does not match run id");

    const canonicalOid = await runGit(repo, ["rev-parse", canonicalRef]);
    expect(await runGit(repo, ["rev-parse", foreignRef])).toBe(canonicalOid);
    const store = new ArtifactStore(runId);
    await expect(store.readResult()).resolves.toMatchObject({ status: "verified-candidate" });
    await expect(store.readPipelineActiveMarker()).resolves.toMatchObject({ sliced: true });
  }, 120_000);

});
