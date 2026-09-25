export type AutopilotPhase =
  | "preflighting"
  | "running-task"
  | "promoting-task"
  | "final-review"
  | "cleaning-up"
  | "ready-for-human-review"
  | "human-decision-required"
  | "failed"
  | "cancelled";

export interface AutopilotTaskState {
  id: string;
  runId: string | null;
  candidateManifestHash: string | null;
  eligibilityHash: string | null;
  promotionCommitOid: string | null;
  status: "pending" | "running" | "promoted" | "halted";
}

export interface AutopilotWorkflowState {
  stateVersion: "2";
  workflowId: string;
  repositoryIdentity: string;
  baseCommitOid: string;
  workflowRef: string;
  worktreePath: string;
  autopilotSpecHash: string;
  revision: number;
  phase: AutopilotPhase;
  currentTaskIndex: number;
  tasks: AutopilotTaskState[];
  intentJournal: {
    ref: string;
    entryCount: number;
    lastEntryHash: string | null;
  };
  finalGate: {
    reportRef: string;
    reportHash: string;
    headCommitOid: string;
    eligibilityHash: string;
  } | null;
  /** The local workflow branch handed to the delivery gate once final-reviewed. */
  branch: string;
  cleanup: {
    status: "succeeded" | "failed";
    worktreeRemoved: boolean;
    lockReleased: boolean;
    error: string | null;
    completedAt: string;
  } | null;
  terminal: {
    classification:
      | "ready-for-human-review"
      | "human-decision-required"
      | "failed"
      | "cancelled";
    reason: string | null;
    evidenceRefs: string[];
    completedAt: string;
  } | null;
  createdAt: string;
  updatedAt: string;
}

export type AutopilotResult = AutopilotWorkflowState;
