import { gitFailure } from "../git/checked-git.js";
import { git } from "../git/git-exec.js";
import type { AttemptResult, FailureClassification } from "../protocol/attempt-result.js";
import type { PipelineGateCleared } from "../protocol/pipeline-gate-cleared.js";
import type { ArtifactStore } from "../runtime/artifact-store.js";
import { RuntimeError } from "../util/errors.js";
import type {
  PipelineIncrement,
  PipelineResult,
  PipelineRound,
  PipelineVerificationReport,
} from "./pipeline-runtime.js";
import type { PipelineSlice } from "./slice-runner.js";

const CANDIDATE_REF_PREFIX = "refs/claude-architect/candidates/";

/** The one mutable fact a terminal exit changes: which attempt result.json holds. */
export interface TerminalState {
  finalAttempt: AttemptResult;
}

/** What a failed exit reports; the recorder turns it into the archived outcome. */
export interface FailedExit {
  reason: string;
  failure: FailureClassification;
  rounds: PipelineRound[];
  increments: PipelineIncrement[];
  slices: PipelineSlice[];
  haltedSliceIndex?: number | null;
  finalCandidateCommit: string;
}

/** Demoting result.json did not complete; the archive may still look acceptable. */
export class TerminalArchiveError extends RuntimeError {
  constructor(readonly cause: unknown) {
    super(cause instanceof Error ? cause.message : "pipeline failure archival failed");
    this.name = "TerminalArchiveError";
  }
}

export function containsTerminalArchiveError(error: unknown): boolean {
  if (error instanceof TerminalArchiveError) return true;
  if (!(error instanceof AggregateError)) return false;
  return error.errors.some(containsTerminalArchiveError);
}

function failedAttemptStatus(failure: FailureClassification): AttemptResult["status"] {
  if (failure === "unavailable" || failure === "authentication-required") return "unavailable";
  if (failure === "cancelled") return "cancelled";
  return "failed";
}

function failedResult(attempt: AttemptResult, exit: FailedExit): PipelineResult {
  return {
    runId: attempt.runId,
    status: "failed",
    attempt,
    increments: exit.increments,
    slices: exit.slices,
    haltedSliceIndex: exit.haltedSliceIndex ?? null,
    rounds: exit.rounds,
    verification: null,
    gate: {
      decisionReady: false,
      requiresHumanDecision: false,
      reasons: [exit.reason],
    },
    finalCandidateCommit: exit.finalCandidateCommit,
    failure: exit.failure,
  };
}

/**
 * The only writer of a pipeline's terminal artifacts. Every exit hands it an
 * outcome; it persists the same set each time — result.json first (it is the
 * acceptance authority, so a crash mid-sequence still fails closed), then
 * verification, then pipeline-result.json — and only then lets the caller
 * release the run's lifecycle authority.
 */
export class TerminalRecorder {
  #authoritySafeToRelease: boolean;
  /** pipeline-result.json is write-once; a later demotion leaves it in place. */
  #resultRecorded = false;

  constructor(private readonly target: {
    checkoutPath: string;
    store: ArtifactStore;
    sliced: boolean;
  }) {
    // An unsliced run publishes its marker only after the initial attempt has
    // archived a verified candidate, and has always released it on exit.
    this.#authoritySafeToRelease = !target.sliced;
  }

  /** Whether the pipeline-active marker may be cleared on the way out. */
  get authoritySafeToRelease(): boolean {
    return this.#authoritySafeToRelease;
  }

  /**
   * A failed exit. A still-verified archived candidate is demoted to the
   * failure, and its anchor is removed unless the failure is a verification
   * failure, so a failed pipeline never leaves an acceptable archive.
   */
  async fail(state: TerminalState, exit: FailedExit): Promise<PipelineResult> {
    if (state.finalAttempt.status === "verified-candidate") {
      state.finalAttempt = await this.demote(state.finalAttempt, exit.failure, exit.reason);
    }
    const result = failedResult(state.finalAttempt, exit);
    if (!this.#resultRecorded) await this.recordResult(result);
    this.release();
    return result;
  }

  /**
   * A role failed after the candidate existed. Bytes that still re-verify go
   * to the human with the incomplete review recorded where the accept gate
   * reads it; bytes that do not are demoted, retaining the candidate.
   */
  async salvage(
    state: TerminalState,
    exit: FailedExit & { verification: PipelineVerificationReport },
  ): Promise<PipelineResult> {
    const { store } = this.target;
    const manifest = await store.readManifest();
    if (manifest === null) return await this.fail(state, exit);
    let result: PipelineResult;
    if (!exit.verification.pass) {
      // The pipeline result keeps the role's classification; result.json
      // records what the freshest evidence proved about the bytes.
      const demoted: AttemptResult = {
        ...state.finalAttempt,
        status: "failed",
        failure: "verification-failure",
        summary: exit.reason,
        unresolvedIssues: [
          ...state.finalAttempt.unresolvedIssues,
          exit.reason,
          "salvage re-verification failed",
        ],
        evidence: {
          ...state.finalAttempt.evidence,
          pipelineFailure: { failure: exit.failure, reason: exit.reason },
        },
      };
      await store.promoteTerminalArtifacts({ result: demoted, manifest });
      state.finalAttempt = demoted;
      result = failedResult(demoted, exit);
    } else {
      const salvaged: AttemptResult = {
        ...state.finalAttempt,
        evidence: {
          ...state.finalAttempt.evidence,
          pipelineReviewIncomplete: { failure: exit.failure, reason: exit.reason },
        },
      };
      await store.promoteTerminalArtifacts({ result: salvaged, manifest });
      state.finalAttempt = salvaged;
      result = {
        runId: salvaged.runId,
        status: "human-decision-required",
        attempt: salvaged,
        increments: exit.increments,
        slices: exit.slices,
        haltedSliceIndex: null,
        rounds: exit.rounds,
        verification: exit.verification,
        gate: {
          decisionReady: false,
          requiresHumanDecision: true,
          reasons: [
            exit.reason,
            "the candidate passed independent verification; the pipeline could not"
            + " complete its own review, so the whole-branch review is the human's",
          ],
        },
        finalCandidateCommit: exit.finalCandidateCommit,
        failure: null,
      };
    }
    await store.writePipelineArtifact("verification", exit.verification);
    await this.recordResult(result);
    this.release();
    return result;
  }

  /** A partial slice branch already promoted and verified, handed to the human. */
  async halt(result: PipelineResult & { verification: PipelineVerificationReport }): Promise<PipelineResult> {
    await this.target.store.writePipelineArtifact("verification", result.verification);
    await this.recordResult(result);
    this.release();
    return result;
  }

  /**
   * The gate completed. Its verdict — clearance record or refusal evidence —
   * is archived in result.json, the only place the accept path reads.
   */
  async succeed(
    state: TerminalState,
    result: PipelineResult & { verification: PipelineVerificationReport },
  ): Promise<PipelineResult> {
    const { store } = this.target;
    const { gate } = result;
    await store.writePipelineArtifact("verification", result.verification);
    const manifest = await store.readManifest();
    if (manifest === null) {
      if (!gate.decisionReady) {
        throw new RuntimeError(
          "pipeline gate refused the candidate and the refusal could not be archived",
          { reasons: gate.reasons },
        );
      }
      throw new RuntimeError(
        "pipeline gate cleared the candidate and the clearance could not be archived",
        {
          candidateCommitOid: result.finalCandidateCommit,
          requiresHumanDecision: gate.requiresHumanDecision,
        },
      );
    }
    const cleared: PipelineGateCleared | null = result.pipelineGateCleared ?? null;
    if (cleared !== null) await store.writePipelineGateCleared(cleared);
    await store.promoteTerminalArtifacts({ result: result.attempt, manifest });
    state.finalAttempt = result.attempt;
    await this.recordResult(result);
    this.release();
    return result;
  }

  private async recordResult(result: PipelineResult): Promise<void> {
    await this.target.store.writePipelineArtifact("pipeline-result", result);
    this.#resultRecorded = true;
  }

  private release(): void {
    this.#authoritySafeToRelease = true;
  }

  private async demote(
    attempt: AttemptResult,
    failure: FailureClassification,
    reason: string,
  ): Promise<AttemptResult> {
    const { checkoutPath, store } = this.target;
    try {
      const manifest = await store.readManifest();
      if (manifest === null) {
        throw new RuntimeError("run manifest is missing while archiving pipeline failure");
      }
      const retainCandidate = failure === "verification-failure";
      if (!retainCandidate && attempt.candidate !== null) {
        const candidate = attempt.candidate;
        if (candidate.anchorRef !== `${CANDIDATE_REF_PREFIX}${attempt.runId}`) {
          throw new RuntimeError(
            `${this.target.sliced ? "sliced " : ""}candidate anchor does not match run id`,
          );
        }
        const deleted = await git(checkoutPath, [
          "update-ref",
          "--no-deref",
          "-d",
          candidate.anchorRef,
          candidate.candidateCommitOid,
        ]);
        if (deleted.exitCode !== 0) {
          throw gitFailure(
            `delete ${this.target.sliced ? "sliced " : ""}candidate anchor`,
            deleted,
          );
        }
      }
      const failed: AttemptResult = {
        ...attempt,
        status: failedAttemptStatus(failure),
        failure,
        summary: reason,
        candidate: retainCandidate ? attempt.candidate : null,
        unresolvedIssues: [...attempt.unresolvedIssues, reason],
        evidence: {
          ...attempt.evidence,
          pipelineFailure: { failure, reason },
        },
      };
      await store.promoteTerminalArtifacts({ result: failed, manifest });
      return failed;
    } catch (error) {
      // result.json may still advertise the candidate: keep the run's
      // lifecycle authority so recovery, not this process, settles it.
      this.#authoritySafeToRelease = false;
      throw new TerminalArchiveError(error);
    }
  }
}
