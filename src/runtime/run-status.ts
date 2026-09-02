import { logger } from "../util/logger.js";
import type { ArtifactStore } from "./artifact-store.js";

export type RunStatusPhase =
  | "preflight"
  | "baseline-verify"
  | "implementing"
  | "freezing"
  | "verifying"
  | "reviewing"
  | "fixing"
  | "advisor"
  | "gating"
  | "integrating"
  | "done"
  | "failed";

export interface RunStatus {
  statusVersion: "1";
  runId: string;
  mode: "single" | "sliced";
  phase: RunStatusPhase;
  sliceIndex: number | null;
  sliceCount: number | null;
  round: number | null;
  role: string | null;
  producerId: string | null;
  startedAt: string;
  updatedAt: string;
  detail: string | null;
}

type RunStatusStore = Pick<ArtifactStore, "writeRunStatus">;
type RunStatusTransitionStore = Pick<ArtifactStore, "readRunStatus" | "writeRunStatus">;

function warnStatusFailure(runId: string, phase: RunStatusPhase, error: unknown): void {
  try {
    logger.warn("run status update failed", {
      runId,
      phase,
      error: error instanceof Error ? error.name : "unknown",
    });
  } catch {
    // Logging is advisory too; even a hostile or broken sink is isolated.
  }
}

/** Status is advisory: persistence and diagnostics must never affect trusted control flow. */
export async function writeRunStatusSafely(
  store: RunStatusStore,
  status: RunStatus,
): Promise<void> {
  try {
    await store.writeRunStatus(status);
  } catch (error) {
    warnStatusFailure(status.runId, status.phase, error);
  }
}

export async function transitionRunStatusSafely(
  store: RunStatusTransitionStore,
  runId: string,
  phase: RunStatusPhase,
  fields: Partial<Pick<
    RunStatus,
    "sliceIndex" | "sliceCount" | "round" | "role" | "producerId" | "detail"
  >> = {},
): Promise<void> {
  try {
    const current = await store.readRunStatus(runId);
    if (current === null) return;
    await store.writeRunStatus({
      ...current,
      ...fields,
      phase,
      updatedAt: new Date().toISOString(),
    });
  } catch (error) {
    warnStatusFailure(runId, phase, error);
  }
}

export class StatusEmitter {
  private lastPhase: RunStatusPhase | null = null;
  private pendingEphemeral: string | null = null;

  constructor(
    private readonly store: RunStatusTransitionStore,
    private readonly runId: string,
    private readonly onProgress?: ((text: string) => void) | undefined,
  ) {}

  get currentPhase(): RunStatusPhase | null {
    return this.lastPhase;
  }

  /**
   * Emits a DURABLE lifecycle transition.
   * Persisted immediately and awaited before the phase begins (lesson d07d031).
   * Durable write count per phase transition is exactly one.
   */
  async transition(
    phase: RunStatusPhase,
    fields: Partial<Pick<
      RunStatus,
      "sliceIndex" | "sliceCount" | "round" | "role" | "producerId" | "detail"
    >> = {},
  ): Promise<void> {
    this.lastPhase = phase;
    this.pendingEphemeral = null;
    await transitionRunStatusSafely(this.store, this.runId, phase, fields);
  }

  /**
   * Emits EPHEMERAL progress (text, counters, detail within the current phase).
   * Coalesced and dispatched to progress listeners without blocking on disk.
   */
  async ephemeral(detail: string): Promise<void> {
    this.pendingEphemeral = detail;
    this.onProgress?.(detail);
  }
}
