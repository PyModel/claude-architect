import {
  advisorReportHash,
  canonicalArtifactHash,
  evaluateAutopilotEligibility,
  pipelineResultHash,
  type AutopilotEligibilityRecord,
} from "../autopilot/autopilot-eligibility.js";
import type { FailureClassification } from "../protocol/attempt-result.js";
import type { DelegationSpec } from "../protocol/delegation-spec.js";
import { loadSchemas } from "../protocol/schema-loader.js";
import { ArtifactStore } from "../runtime/artifact-store.js";
import { redact, redactRecord } from "../runtime/redaction.js";
import {
  reviewSnapshotHash,
  type ReviewSnapshot,
} from "../runtime/review-snapshot.js";
import { transitionRunStatusSafely } from "../runtime/run-status.js";
import { RuntimeError } from "../util/errors.js";
import {
  type PipelineDependencies,
  type PipelineResult,
} from "./pipeline-runtime.js";
import {
  runStructuredRole,
  type StructuredRoleRunResult,
} from "./pipeline-roles.js";
import type { AdvisorReport } from "./report-types.js";
import {
  canRenderUntrustedBlockExactly,
  type RolePackage,
} from "./role-prompts.js";

const schemas = loadSchemas();

export interface AdvisorStageStore {
  readPipelineArtifact<T>(name: string): Promise<T | null>;
  readReviewSnapshot(): Promise<ReviewSnapshot | null>;
  writePostPipelineAutopilotArtifacts(args: {
    pipelineResult: PipelineResult;
    reviewSnapshot: ReviewSnapshot;
    advisorReport: AdvisorReport;
    eligibility: AutopilotEligibilityRecord;
  }): Promise<{ advisorReportHash: string; eligibilityRecordHash: string }>;
  writeLog(name: string, text: string): Promise<string>;
}

export interface RunAdvisorStageArgs {
  runId: string;
  spec: DelegationSpec;
  worktreePath: string;
  deps: PipelineDependencies;
  evaluatedAt: string;
  store?: AdvisorStageStore;
  pipelineResult?: PipelineResult;
  reviewSnapshot?: ReviewSnapshot;
}

export interface AdvisorStageResult {
  report: AdvisorReport;
  eligibility: AutopilotEligibilityRecord;
  failure: FailureClassification | null;
  roleLogRefs: string[];
}

function frozenAdvisorEvidence(
  spec: DelegationSpec,
  pipelineResult: PipelineResult,
  reviewSnapshot: ReviewSnapshot,
): Record<string, unknown> {
  const finalRound = pipelineResult.rounds.at(-1) ?? null;
  return {
    runId: pipelineResult.runId,
    specification: {
      objective: spec.objective,
      successCriteria: [...spec.successCriteria],
      writeAllowlist: [...spec.writeAllowlist],
      forbiddenScope: [...spec.forbiddenScope],
    },
    baselineCommitOid: reviewSnapshot.baseCommitOid,
    candidateCommitOid: reviewSnapshot.candidateCommitOid,
    candidateTreeOid: reviewSnapshot.candidateTreeOid,
    candidateManifestHash: reviewSnapshot.manifestHash,
    reviewSnapshot: structuredClone(reviewSnapshot),
    finalRound: structuredClone(finalRound),
    reviewAndFixHistory: structuredClone(pipelineResult.rounds),
    trustedVerification: structuredClone(pipelineResult.verification),
    gate: structuredClone(pipelineResult.gate),
    pipelineStatus: pipelineResult.status,
  };
}

function failureReport(
  failure: FailureClassification,
  failedRoleLogRef: string,
): AdvisorReport {
  return {
    reportVersion: "1",
    verdict: "human-decision-required",
    rationale: `The final advisor did not produce an approving valid report (${failure}; see ${failedRoleLogRef}).`,
    risks: [],
    coverageGaps: ["A fresh confined advisor review is unavailable."],
  };
}

function assertSameFrozenArtifact(
  label: string,
  providedHash: string,
  archivedHash: string,
): void {
  if (providedHash !== archivedHash) {
    throw new RuntimeError(`${label} differs from the durable archived artifact`);
  }
}

function advisorExecutionDiagnostic(error: unknown): string {
  const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return redact(detail).slice(0, 2_000);
}

/**
 * Runs only from already-durable post-pipeline evidence. It never writes or
 * replaces pipeline-result.json; durable writes are limited to advisory status,
 * the advisor log/report, and the independently derived eligibility record.
 */
export async function runAdvisorStage(args: RunAdvisorStageArgs): Promise<AdvisorStageResult> {
  const store = args.store ?? new ArtifactStore(args.runId);
  const statusStore = new ArtifactStore(args.runId);
  await transitionRunStatusSafely(statusStore, args.runId, "advisor", {
    round: null,
    role: "advisor",
    detail: null,
  });
  try {
  const [archivedPipelineResult, archivedReviewSnapshot, archivedSpec] = await Promise.all([
    store.readPipelineArtifact<PipelineResult>("pipeline-result"),
    store.readReviewSnapshot(),
    store.readPipelineArtifact<DelegationSpec>("delegation-spec"),
  ]);
  if (archivedPipelineResult === null) {
    throw new RuntimeError("advisor stage requires a durable archived PipelineResult");
  }
  if (archivedReviewSnapshot === null) {
    throw new RuntimeError("advisor stage requires a durable review snapshot");
  }
  if (archivedSpec === null) {
    throw new RuntimeError("advisor stage requires a durable archived delegation specification");
  }
  if (!schemas.delegationSpec(archivedSpec)) {
    throw new RuntimeError("advisor stage archived delegation specification is invalid");
  }
  const suppliedSpec = redactRecord(structuredClone(args.spec)) as DelegationSpec;
  if (canonicalArtifactHash(suppliedSpec) !== canonicalArtifactHash(archivedSpec)) {
    throw new RuntimeError("advisor stage specification differs from the durable archived specification");
  }
  if (archivedPipelineResult.runId !== args.runId
    || archivedReviewSnapshot.runId !== args.runId) {
    throw new RuntimeError("advisor stage run identity does not match its durable evidence");
  }
  if (args.pipelineResult !== undefined) {
    assertSameFrozenArtifact(
      "pipeline result",
      pipelineResultHash(args.pipelineResult),
      pipelineResultHash(archivedPipelineResult),
    );
  }
  if (args.reviewSnapshot !== undefined) {
    assertSameFrozenArtifact(
      "review snapshot",
      reviewSnapshotHash(args.reviewSnapshot),
      reviewSnapshotHash(archivedReviewSnapshot),
    );
  }

  // Exclude the originating session's prose context. The advisor receives
  // only the objective, criteria, policy fields, and frozen durable package.
  const advisorSpec: DelegationSpec = {
    ...structuredClone(archivedSpec),
    context: "",
  };
  const pkg: RolePackage = {
    spec: advisorSpec,
    baselineCommit: archivedReviewSnapshot.baseCommitOid,
    candidateCommit: archivedReviewSnapshot.candidateCommitOid,
    candidateDiff: archivedReviewSnapshot.patch,
    testEvidence: JSON.stringify({
      evidence: archivedReviewSnapshot.evidence,
      executedVerification: archivedReviewSnapshot.executedVerification,
      finalVerification: archivedPipelineResult.verification,
    }),
    advisorEvidence: frozenAdvisorEvidence(
      advisorSpec,
      archivedPipelineResult,
      archivedReviewSnapshot,
    ),
  };
  const advisorEvidenceText = JSON.stringify(pkg.advisorEvidence, null, 2);
  let outcome: StructuredRoleRunResult<AdvisorReport>;
  if (!canRenderUntrustedBlockExactly(advisorEvidenceText)) {
    const failedRoleLogRef = await store.writeLog(
      "role-advisor-final",
      "advisor was not launched: the exact frozen evidence package exceeds the bounded role input\n",
    );
    outcome = {
      ok: false,
      failure: "invalid-output",
      failedRoleLogRef,
      roleLogRefs: [failedRoleLogRef],
    };
  } else {
    try {
      outcome = await runStructuredRole<AdvisorReport>({
        role: "advisor",
        schema: schemas.advisorReport,
        logName: "role-advisor-final",
        spec: advisorSpec,
        pkg,
        worktreePath: args.worktreePath,
        deps: args.deps,
        runId: args.runId,
        store,
      });
    } catch (error) {
      const failedRoleLogRef = await store.writeLog(
        "role-advisor-final",
        `advisor execution failed before producing a classified result: ${advisorExecutionDiagnostic(error)}\n`,
      );
      outcome = {
        ok: false,
        failure: "producer-failure",
        failedRoleLogRef,
        roleLogRefs: [failedRoleLogRef],
      };
    }
  }
  const report = outcome.ok
    ? redactRecord(outcome.report) as AdvisorReport
    : failureReport(outcome.failure, outcome.failedRoleLogRef);
  const eligibility = evaluateAutopilotEligibility({
    pipelineResult: archivedPipelineResult,
    reviewSnapshot: archivedReviewSnapshot,
    advisor: report,
    evaluatedAt: args.evaluatedAt,
  });
  await transitionRunStatusSafely(statusStore, args.runId, "gating", {
    role: "advisor",
  });
  await store.writePostPipelineAutopilotArtifacts({
    pipelineResult: archivedPipelineResult,
    reviewSnapshot: archivedReviewSnapshot,
    advisorReport: report,
    eligibility,
  });

  // Force hash construction here as an assertion that the persisted report is
  // canonical JSON before returning control to the autopilot controller.
  advisorReportHash(report);
  await transitionRunStatusSafely(
    statusStore,
    args.runId,
    outcome.ok ? "done" : "failed",
    {
      role: "advisor",
      detail: outcome.ok ? report.verdict : outcome.failure,
    },
  );
  return {
    report,
    eligibility,
    failure: outcome.ok ? null : outcome.failure,
    roleLogRefs: outcome.roleLogRefs,
  };
  } catch (error) {
    // Any pre-terminal throw — evidence validation, eligibility derivation, or a
    // durable write — must move the run out of the "advisor" status into a
    // terminal "failed" state, mirroring runPipelineWithLease. Without this the
    // persisted RunStatus would stay "advisor" forever after an early guard.
    await transitionRunStatusSafely(statusStore, args.runId, "failed", {
      role: "advisor",
      detail: error instanceof Error ? error.message : "advisor stage failed unexpectedly",
    });
    throw error;
  }
}
