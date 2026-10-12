import { manifestHashOf } from "../../../src/git/changed-path-manifest.js";
import type { DelegationSpec } from "../../../src/protocol/delegation-spec.js";
import type { PipelineResult } from "../../../src/pipeline/pipeline-runtime.js";
import type { AdvisorReport } from "../../../src/pipeline/report-types.js";
import type { ReviewSnapshot } from "../../../src/runtime/review-snapshot.js";

// Derived from the runtime canonicalization rather than a hand-rolled sha256
// of "[]", so the fixture cannot drift from the hashing it stands in for.
export const manifestHash = manifestHashOf([]);
const DEAD_BOOTSTRAP_PID = 900_001;
const DEAD_LEASE_PID = 900_002;
const DEAD_PROCESS_TOKEN = "dead-autopilot-owner-token";

export function autopilotOwnershipPath(workflowId: string, stateDirectory: string): string {
  return path.join(
    stateDirectory,
    "autopilot-branches",
    `${createHash("sha256").update(workflowId).digest("hex")}.json`,
  );
}

export async function makeBootstrapOwnerDead(
  subject: Pick<WorkflowBranchIdentity, "workflowId">
    | { branch: Pick<WorkflowBranchIdentity, "workflowId"> },
  stateDirectory = process.env.CLAUDE_PLUGIN_DATA,
): Promise<void> {
  if (stateDirectory === undefined) throw new Error("CLAUDE_PLUGIN_DATA is required");
  const branch = "branch" in subject ? subject.branch : subject;
  const filename = autopilotOwnershipPath(branch.workflowId, stateDirectory);
  const registration = JSON.parse(await readFile(filename, "utf8")) as {
    bootstrapOwner: { pid: number; processToken: string | null; createdAt: string };
  };
  registration.bootstrapOwner.pid = DEAD_BOOTSTRAP_PID;
  registration.bootstrapOwner.processToken = DEAD_PROCESS_TOKEN;
  await writeFile(filename, `${JSON.stringify(registration)}\n`);
}

export async function makeLeaseDead(store: Pick<
  WorkflowStore,
  "ownerPath" | "workflowId"
>): Promise<void> {
  await writeFile(store.ownerPath, `${JSON.stringify({
    workflowId: store.workflowId,
    pid: DEAD_LEASE_PID,
    processToken: DEAD_PROCESS_TOKEN,
    acquiredAt: "2026-07-21T17:00:00.000Z",
  })}\n`);
}

export const advisorReport: AdvisorReport = {
  reportVersion: "1",
  verdict: "approve",
  rationale: "All frozen evidence agrees.",
  risks: [],
  coverageGaps: [],
};

export function autopilotSpec(): DelegationSpec {
  return {
    specVersion: "1",
    objective: "Implement the bounded change",
    context: "PEER-CONVERSATION-MUST-NOT-BE-SHARED",
    writeAllowlist: ["src/**"],
    forbiddenScope: ["docs/**"],
    successCriteria: ["The bounded behavior is verified"],
    verification: [{
      id: "unit",
      executable: "npm",
      args: ["test"],
      cwd: ".",
      timeoutMs: 60_000,
      network: "denied",
      expectedExitCodes: [0],
    }],
    executionMode: "edit",
    timeoutMs: 600_000,
    producerPreferences: ["codex"],
    expectedOutput: "candidate-patch",
  };
}

export function reviewSnapshot(runId = "run-advisor"): ReviewSnapshot {
  return {
    runId,
    baseCommitOid: "a".repeat(40),
    candidateCommitOid: "b".repeat(40),
    candidateTreeOid: "c".repeat(40),
    manifestHash,
    patch: "diff --git a/src/a.ts b/src/a.ts\n+export const value = 1;",
    changedPaths: [],
    evidence: { structural: "valid" },
    executedVerification: [{
      id: "unit",
      executable: "npm",
      args: ["test"],
      exitCode: 0,
      timedOut: false,
      durationMs: 10,
      stdoutRef: "logs/unit.stdout.log",
      stderrRef: "logs/unit.stderr.log",
    }],
  };
}

export function pipelineResult(runId = "run-advisor"): PipelineResult {
  const snapshot = reviewSnapshot(runId);
  const commandOutcome = snapshot.executedVerification[0]!;
  const approve = {
    reportVersion: "1" as const,
    verdict: "approve" as const,
    findings: [],
    coverageGaps: [],
  };
  return {
    runId,
    status: "decision-ready",
    attempt: {
      resultVersion: "1",
      runId,
      status: "verified-candidate",
      failure: null,
      summary: "verified",
      producerSummary: null,
      candidate: {
        baseCommitOid: snapshot.baseCommitOid,
        candidateCommitOid: snapshot.candidateCommitOid,
        candidateTreeOid: snapshot.candidateTreeOid,
        anchorRef: `refs/claude-architect/candidates/${runId}`,
        manifestHash,
        changedPaths: [],
        patch: snapshot.patch,
      },
      requestedVerification: [],
      executedVerification: [commandOutcome],
      unresolvedIssues: [],
      evidence: { structural: "valid" },
      logsRef: "logs/producer.log",
      producerId: "codex",
      producerVersion: "1.0.0",
      producerModel: null,
      durationMs: 100,
      sessionId: null,
    },
    increments: [],
    slices: [],
    haltedSliceIndex: null,
    rounds: [{
      round: 1,
      reviews: [
        { reviewer: "correctness", report: approve },
        { reviewer: "systems", report: approve },
      ],
      consolidated: { findings: [] },
      fix: null,
      roleLogRefs: ["logs/reviewer-correctness.log", "logs/reviewer-systems.log"],
    }],
    verification: {
      reportVersion: "1",
      pass: true,
      commandResults: [{ id: "unit", exitCode: 0, ok: true }],
      workspaceClean: true,
      testsDeleted: 0,
      testsSkipped: 0,
      scopeViolations: [],
      evidence: {
        failures: [],
        acceptance: {},
        commandOutcomes: [commandOutcome],
      },
    },
    gate: { decisionReady: true, requiresHumanDecision: false, reasons: [] },
    finalCandidateCommit: snapshot.candidateCommitOid,
    failure: null,
  };
}
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { WorkflowBranchIdentity } from "../../../src/autopilot/branch-manager.js";
import type { WorkflowStore } from "../../../src/autopilot/workflow-store.js";
