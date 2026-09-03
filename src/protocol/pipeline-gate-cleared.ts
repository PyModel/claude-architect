import { RuntimeError } from "../util/errors.js";

/**
 * The pipeline's durable statement that its gate cleared a candidate. Versioned
 * next to `CandidateDecisionV2` because integration reads it to decide whether a
 * decision may be recorded without a human, so its shape is an external
 * contract, not an internal detail.
 *
 * `runtime/schemas/pipeline-gate-cleared.v1.json` is the canonical shape;
 * `parsePipelineGateCleared` is the only way a record enters the runtime.
 */
export interface PipelineGateCleared {
  clearedVersion: "1";
  candidateCommitOid: string;
  requiresHumanDecision: boolean;
  clearedAt?: string;
}

const GIT_OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;

/**
 * Accepts only a record matching the canonical schema. `clearedVersion` defaults
 * to `"1"` so a record embedded in `AttemptResult.evidence` before the artifact
 * was versioned still parses; every other field is required, and an unknown
 * field is a malformed record rather than a field to ignore.
 */
export function parsePipelineGateCleared(value: unknown): PipelineGateCleared {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new RuntimeError("the pipeline gate clearance record is malformed");
  }
  const record = value as Record<string, unknown>;
  const known = new Set([
    "clearedVersion",
    "candidateCommitOid",
    "requiresHumanDecision",
    "clearedAt",
  ]);
  const candidateCommitOid = record.candidateCommitOid;
  const requiresHumanDecision = record.requiresHumanDecision;
  const clearedVersion = record.clearedVersion ?? "1";
  const clearedAt = record.clearedAt;

  if (
    Object.keys(record).some(key => !known.has(key))
    || clearedVersion !== "1"
    || typeof candidateCommitOid !== "string"
    || !GIT_OID.test(candidateCommitOid)
    || typeof requiresHumanDecision !== "boolean"
    || (clearedAt !== undefined
      && (typeof clearedAt !== "string" || Number.isNaN(Date.parse(clearedAt))))
  ) {
    throw new RuntimeError("the pipeline gate clearance record is malformed");
  }

  return {
    clearedVersion: "1",
    candidateCommitOid,
    requiresHumanDecision,
    ...(clearedAt === undefined ? {} : { clearedAt }),
  };
}
