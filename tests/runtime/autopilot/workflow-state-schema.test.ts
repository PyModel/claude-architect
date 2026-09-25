import { describe, expect, it } from "vitest";
import type {
  AutopilotPhase,
  AutopilotResult,
  AutopilotTaskState,
  AutopilotWorkflowState,
} from "../../../src/autopilot/types.js";
import { loadSchemas } from "../../../src/protocol/schema-loader.js";

const task = {
  id: "state-contract",
  runId: "run-state-contract",
  candidateManifestHash: "2".repeat(64),
  eligibilityHash: "3".repeat(64),
  promotionCommitOid: "4".repeat(40),
  status: "promoted",
} satisfies AutopilotTaskState;

function validWorkflowState(): AutopilotWorkflowState {
  return {
    stateVersion: "2",
    workflowId: "workflow-state-contract",
    repositoryIdentity: "/canonical/repository/.git",
    baseCommitOid: "1".repeat(40),
    workflowRef: "refs/heads/feat/autopilot-state-contract",
    worktreePath: "/runtime/worktrees/workflow-state-contract",
    autopilotSpecHash: "5".repeat(64),
    revision: 7,
    phase: "ready-for-human-review",
    currentTaskIndex: 1,
    tasks: [{ ...task }],
    intentJournal: {
      ref: "journal.ndjson",
      entryCount: 12,
      lastEntryHash: "6".repeat(64),
    },
    finalGate: {
      reportRef: "final-branch-report.json",
      reportHash: "7".repeat(64),
      headCommitOid: "4".repeat(40),
      eligibilityHash: "8".repeat(64),
    },
    branch: "feat/autopilot-state-contract",
    cleanup: {
      status: "succeeded",
      worktreeRemoved: true,
      lockReleased: true,
      error: null,
      completedAt: "2026-07-20T18:02:00.000Z",
    },
    terminal: {
      classification: "ready-for-human-review",
      reason: null,
      evidenceRefs: ["final-branch-report.json"],
      completedAt: "2026-07-20T18:02:00.000Z",
    },
    createdAt: "2026-07-20T17:00:00.000Z",
    updatedAt: "2026-07-20T18:02:00.000Z",
  };
}

describe("Autopilot Workflow State v1", () => {
  const validate = loadSchemas().autopilotWorkflowState;

  it("accepts a valid fully populated fixture", () => {
    const state: AutopilotResult = validWorkflowState();
    expect(validate(state)).toBe(true);
  });

  it.each([
    ["top level", (state: any) => { state.unknown = true; }],
    ["task", (state: any) => { state.tasks[0].unknown = true; }],
    ["intent journal", (state: any) => { state.intentJournal.unknown = true; }],
    ["final gate", (state: any) => { state.finalGate.unknown = true; }],
    ["retired v1 shipping", (state: any) => { state.shipping = { prNumber: 42 }; }],
    ["cleanup", (state: any) => { state.cleanup.unknown = true; }],
    ["terminal", (state: any) => { state.terminal.unknown = true; }],
  ] as const)("rejects an unknown %s key", (_name, mutate) => {
    const state = validWorkflowState();
    mutate(state);
    expect(validate(state)).toBe(false);
  });

  it("rejects a phase outside the exact phase union", () => {
    const state = validWorkflowState() as unknown as { phase: string };
    state.phase = "ready";
    expect(validate(state)).toBe(false);
  });

  it("rejects a task status outside the exact status union", () => {
    const state = validWorkflowState() as unknown as { tasks: Array<{ status: string }> };
    state.tasks[0]!.status = "complete";
    expect(validate(state)).toBe(false);
  });

  it("rejects every missing top-level required property", () => {
    for (const key of Object.keys(validWorkflowState())) {
      const state = validWorkflowState() as unknown as Record<string, unknown>;
      delete state[key];
      expect(validate(state), key).toBe(false);
    }
  });

  it("rejects every missing task required property", () => {
    for (const key of Object.keys(task)) {
      const state = structuredClone(validWorkflowState()) as unknown as {
        tasks: Array<Record<string, unknown>>;
      };
      delete state.tasks[0]![key];
      expect(validate(state), key).toBe(false);
    }
  });

  it("uses the exact 9-value phase type", () => {
    const phases: AutopilotPhase[] = [
      "preflighting",
      "running-task",
      "promoting-task",
      "final-review",
      "cleaning-up",
      "ready-for-human-review",
      "human-decision-required",
      "failed",
      "cancelled",
    ];
    // `AutopilotPhase[]` accepts any subset, so a 10th phase would leave this
    // green. Pin the list to the union itself via an exhaustive mapping.
    const everyPhase: Record<AutopilotPhase, true> = {
      "preflighting": true,
      "running-task": true,
      "promoting-task": true,
      "final-review": true,
      "cleaning-up": true,
      "ready-for-human-review": true,
      "human-decision-required": true,
      "failed": true,
      "cancelled": true,
    };
    expect([...phases].sort()).toEqual(Object.keys(everyPhase).sort());
    expect(phases).toHaveLength(9);
    for (const phase of phases) {
      expect(validate({ ...validWorkflowState(), phase }), phase).toBe(true);
    }
  });
});
