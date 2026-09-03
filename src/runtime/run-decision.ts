import { createHash } from "node:crypto";
import { type AttemptResult, type CandidateArtifact } from "../protocol/attempt-result.js";
import { type CandidateDecision } from "../protocol/candidate-decision.js";
import {
  type PipelineGateCleared,
  parsePipelineGateCleared,
} from "../protocol/pipeline-gate-cleared.js";
import type { PlatformServices } from "../platform/platform-services.js";
import {
  type DecisionAuthority,
  decisionAuthority,
} from "../mcp/decision-authority.js";
import {
  AcceptanceVerifier,
  type AcceptanceVerifyArgs,
  type AcceptanceVerifyResult,
} from "../verify/acceptance-verifier.js";
import { type VerificationMode } from "../verify/structural-verifier.js";
import { ArtifactStore, validateComponent } from "./artifact-store.js";
import {
  type ReviewSnapshot,
  reviewSnapshotHash,
} from "./review-snapshot.js";
import type { RunManifest } from "./run-manifest.js";

export type Reason = string;

export type RunVerdict =
  | { state: "accepted"; autonomous: true; candidateCommit: string }
  | { state: "human-required"; candidateCommit: string; reasons: Reason[] }
  | { state: "rejected"; reasons: Reason[] }
  | { state: "incomplete"; reasons: Reason[] }
  | { state: "invalid"; reasons: Reason[] };

export interface RunDecisionStore {
  readResult(runId: string): Promise<AttemptResult | null>;
  readManifest(runId: string): Promise<RunManifest | null>;
  readReviewSnapshot(runId: string): Promise<ReviewSnapshot | null>;
  readCandidateDecision(runId: string): Promise<CandidateDecision | null>;
  readPipelineGateCleared?(runId: string): Promise<PipelineGateCleared | null>;
}

export interface RunDecisionSnapshot {
  runId: string;
  result: AttemptResult | null;
  manifest: RunManifest | null;
  reviewSnapshot: ReviewSnapshot | null;
  gateRecord: PipelineGateCleared | null;
  gateRecordError?: string | null;
  decision: CandidateDecision | null;
  coherenceErrors: string[];
}

export interface EvaluateRunOptions {
  authority?: DecisionAuthority | undefined;
  decisionAuthority?: (() => DecisionAuthority) | undefined;
  store?: (RunDecisionStore | ArtifactStore) | undefined;
  storeFactory?: ((runId: string) => RunDecisionStore | ArtifactStore) | undefined;
  platformServices?: PlatformServices | undefined;
  ps?: PlatformServices | undefined;
  /**
   * An archive already read by this caller. The archive of a finished run is
   * immutable, so a caller holding one must pass it rather than paying for a
   * second five-file read; without it `evaluate` reads the archive itself.
   */
  snapshot?: RunDecisionSnapshot | undefined;
}

export interface RunDecisionVerifyArgs extends AcceptanceVerifyArgs {
  mode: VerificationMode;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export class RunDecision {
  async readSnapshot(
    runId: string,
    options?: EvaluateRunOptions,
  ): Promise<RunDecisionSnapshot> {
    validateComponent(runId, "run id");
    const store = options?.store
      ?? (options?.storeFactory ? options.storeFactory(runId) : new ArtifactStore(runId));

    let result: AttemptResult | null = null;
    let manifest: RunManifest | null = null;
    let reviewSnapshot: ReviewSnapshot | null = null;
    let gateRecord: PipelineGateCleared | null = null;
    let gateRecordError: string | null = null;
    let decision: CandidateDecision | null = null;
    const coherenceErrors: string[] = [];

    try {
      const readResult = typeof store.readResult === "function"
        ? store.readResult(runId).catch(err => {
            coherenceErrors.push(`failed to read result: ${err instanceof Error ? err.message : String(err)}`);
            return null;
          })
        : Promise.resolve(null);
      const readManifest = typeof store.readManifest === "function"
        ? store.readManifest(runId).catch(err => {
            coherenceErrors.push(`failed to read manifest: ${err instanceof Error ? err.message : String(err)}`);
            return null;
          })
        : Promise.resolve(null);
      const readSnapshot = typeof store.readReviewSnapshot === "function"
        ? store.readReviewSnapshot(runId).catch(() => null)
        : Promise.resolve(null);
      const readGateRecord = typeof store.readPipelineGateCleared === "function"
        ? store.readPipelineGateCleared(runId).catch(err => {
            gateRecordError = `the pipeline gate clearance record is malformed: ${err instanceof Error ? err.message : String(err)}`;
            return null;
          })
        : Promise.resolve(null);
      const readDecision = typeof store.readCandidateDecision === "function"
        ? store.readCandidateDecision(runId).catch(err => {
            coherenceErrors.push(`failed to read decision: ${err instanceof Error ? err.message : String(err)}`);
            return null;
          })
        : Promise.resolve(null);

      const [r, m, s, g, d] = await Promise.all([
        readResult,
        readManifest,
        readSnapshot,
        readGateRecord,
        readDecision,
      ]);
      result = r;
      manifest = m;
      reviewSnapshot = s;
      gateRecord = g;
      decision = d;
    } catch (err) {
      coherenceErrors.push(`failed to load decision snapshot: ${err instanceof Error ? err.message : String(err)}`);
    }

    if (gateRecord === null && result?.evidence?.pipelineGateCleared !== undefined) {
      try {
        gateRecord = parsePipelineGateCleared(result.evidence.pipelineGateCleared);
      } catch {
        gateRecordError = "the pipeline gate clearance record is malformed";
      }
    }

    if (result !== null && manifest !== null) {
      if (result.runId !== runId || manifest.runId !== runId) {
        coherenceErrors.push("archived run identity does not match runId");
      }
      if (result.candidate !== null) {
        if (manifest.baseCommitOid !== result.candidate.baseCommitOid) {
          coherenceErrors.push("archived candidate base commit does not match run manifest");
        }
        if (manifest.candidateManifestHash !== result.candidate.manifestHash) {
          coherenceErrors.push("archived candidate manifest hash does not match run manifest");
        }
        const expectedHash = createHash("sha256")
          .update(JSON.stringify(result.candidate.changedPaths))
          .digest("hex");
        if (result.candidate.manifestHash !== expectedHash) {
          coherenceErrors.push("archived candidate changed paths hash mismatch");
        }
      }
    }

    if (gateRecord !== null && result?.candidate !== null && result?.candidate !== undefined) {
      if (gateRecord.candidateCommitOid !== result.candidate.candidateCommitOid) {
        gateRecordError = "the pipeline gate clearance record does not match the archived candidate commit";
      }
    }

    if (decision !== null && result?.candidate !== null && result?.candidate !== undefined) {
      if (decision.candidateManifestHash !== undefined && decision.candidateManifestHash !== null) {
        if (decision.candidateManifestHash !== result.candidate.manifestHash) {
          coherenceErrors.push("recorded candidate decision does not match candidate manifest hash");
        }
      }
      if (decision.decisionVersion === "2" && reviewSnapshot !== null) {
        if (decision.evidenceHash !== reviewSnapshotHash(reviewSnapshot)) {
          coherenceErrors.push("recorded candidate decision does not match review snapshot evidence hash");
        }
      }
    }

    return {
      runId,
      result,
      manifest,
      reviewSnapshot,
      gateRecord,
      gateRecordError,
      decision,
      coherenceErrors,
    };
  }

  async evaluate(runId: string, options?: EvaluateRunOptions): Promise<RunVerdict> {
    const snapshot = options?.snapshot ?? await this.readSnapshot(runId, options);
    const authority = options?.authority
      ?? (options?.decisionAuthority ? options.decisionAuthority() : decisionAuthority());
    return this.verdictFor(snapshot, authority);
  }

  /**
   * The whole acceptance rule, over an archive already read. Pure: every caller
   * that once re-derived "may this be accepted without a person" from the same
   * files now asks this one function.
   */
  verdictFor(snapshot: RunDecisionSnapshot, authority: DecisionAuthority): RunVerdict {
    if (snapshot.coherenceErrors.length > 0) {
      return { state: "invalid", reasons: snapshot.coherenceErrors };
    }
    if (snapshot.result === null || snapshot.manifest === null) {
      return { state: "invalid", reasons: ["archived run was not found"] };
    }

    const incompleteEvidence = snapshot.result.evidence?.pipelineReviewIncomplete;
    if (incompleteEvidence !== undefined) {
      const reason = isRecord(incompleteEvidence) && typeof incompleteEvidence.reason === "string"
        ? incompleteEvidence.reason
        : "pipeline review is incomplete";
      return { state: "incomplete", reasons: [reason] };
    }

    if (snapshot.decision !== null) {
      if (snapshot.decision.decision === "rejected") {
        return { state: "rejected", reasons: ["candidate decision is rejected"] };
      }
      if (snapshot.decision.decision === "revision-requested") {
        return { state: "rejected", reasons: ["candidate decision is revision-requested"] };
      }
    }

    const refusedEvidence = snapshot.result.evidence?.pipelineGateRefused;
    if (refusedEvidence !== undefined) {
      const reasons = isRecord(refusedEvidence) && Array.isArray(refusedEvidence.reasons)
        ? refusedEvidence.reasons.filter((r): r is string => typeof r === "string")
        : ["the pipeline gate did NOT clear this candidate"];
      return {
        state: "rejected",
        reasons: reasons.length > 0 ? reasons : ["the pipeline gate did NOT clear this candidate"],
      };
    }

    if (snapshot.result.status !== "verified-candidate" || snapshot.result.failure !== null) {
      const reasons: string[] = [];
      if (snapshot.result.failure !== null) {
        reasons.push(snapshot.result.failure);
      } else {
        reasons.push(`attempt status is ${snapshot.result.status}`);
      }
      return { state: "rejected", reasons };
    }

    if (snapshot.result.candidate === null) {
      return { state: "rejected", reasons: ["no candidate artifact was produced"] };
    }

    const candidateCommit = snapshot.result.candidate.candidateCommitOid;

    const humanReasons: string[] = [];

    if (authority !== "autonomous") {
      humanReasons.push(`decision authority is "${authority}"`);
    }

    const isPlainDelegate = snapshot.result.evidence?.plainDelegate === true
      && refusedEvidence === undefined
      && incompleteEvidence === undefined
      && snapshot.result.evidence?.pipelineGateCleared === undefined
      && snapshot.gateRecord === null;

    if (snapshot.gateRecordError) {
      humanReasons.push(snapshot.gateRecordError);
    } else if (isPlainDelegate) {
      // Plain delegate is judged on verification result alone.
    } else if (snapshot.gateRecord === null) {
      humanReasons.push("the pipeline gate clearance record is missing");
    } else if (snapshot.gateRecord.requiresHumanDecision === true) {
      humanReasons.push("the pipeline gate clearance record requires a human decision");
    }

    if (humanReasons.length > 0) {
      return { state: "human-required", candidateCommit, reasons: humanReasons };
    }

    return { state: "accepted", autonomous: true, candidateCommit };
  }

  async verify(args: RunDecisionVerifyArgs): Promise<AcceptanceVerifyResult> {
    const verifier = new AcceptanceVerifier({ mode: args.mode });
    return verifier.verify(args);
  }
}

export const runDecision = new RunDecision();

export async function readRunDecisionSnapshot(
  runId: string,
  options?: EvaluateRunOptions,
): Promise<RunDecisionSnapshot> {
  return runDecision.readSnapshot(runId, options);
}
