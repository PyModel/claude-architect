import type { DelegationSpec } from "../protocol/delegation-spec.js";
import type { CheckoutLock, PlatformServices } from "../platform/platform-services.js";
import type { ArtifactStore } from "../runtime/artifact-store.js";
import type { RunStartContext } from "../runtime/run-start.js";
import {
  transitionRunStatusSafely,
  type RunStatusPhase,
} from "../runtime/run-status.js";

export interface RunStatusFields {
  sliceIndex?: number | null | undefined;
  sliceCount?: number | null | undefined;
  round?: number | null | undefined;
  role?: string | null | undefined;
  producerId?: string | null | undefined;
  detail?: string | null | undefined;
}

export interface RunContext {
  readonly runId: string;
  readonly checkoutPath: string;
  readonly spec: DelegationSpec;
  readonly store: ArtifactStore;
  readonly ps: PlatformServices;
  readonly borrowedCheckoutLease?: CheckoutLock | undefined;
  readonly runStart?: RunStartContext | undefined;
  emitStatus(phase: RunStatusPhase, fields?: RunStatusFields): Promise<void>;
  notePhase(phase: string): Promise<void>;
}

export interface CreateRunContextOptions {
  runId: string;
  checkoutPath: string;
  spec: DelegationSpec;
  store: ArtifactStore;
  ps: PlatformServices;
  borrowedCheckoutLease?: CheckoutLock | undefined;
  runStart?: RunStartContext | undefined;
  onPhase?: ((phase: string) => Promise<void> | void) | undefined;
  sliceCount?: number | null | undefined;
  /** Default `sliceIndex` for status lines that name no slice of their own. */
  sliceIndex?: number | null | undefined;
}

export function createRunContext(options: CreateRunContextOptions): RunContext {
  const {
    runId,
    checkoutPath,
    spec,
    store,
    ps,
    borrowedCheckoutLease,
    runStart,
    onPhase,
    sliceCount,
    sliceIndex,
  } = options;

  return {
    runId,
    checkoutPath,
    spec,
    store,
    ps,
    ...(borrowedCheckoutLease === undefined ? {} : { borrowedCheckoutLease }),
    ...(runStart === undefined ? {} : { runStart }),
    async emitStatus(phase: RunStatusPhase, fields?: RunStatusFields): Promise<void> {
      await transitionRunStatusSafely(store, runId, phase, {
        sliceIndex: fields?.sliceIndex ?? sliceIndex ?? null,
        sliceCount: fields?.sliceCount ?? sliceCount ?? null,
        round: fields?.round ?? null,
        role: fields?.role ?? null,
        producerId: fields?.producerId ?? null,
        detail: fields?.detail ?? null,
      });
    },
    async notePhase(phase: string): Promise<void> {
      try {
        await onPhase?.(phase);
      } catch {
        // Advisory progress must never break pipeline execution.
      }
    },
  };
}
