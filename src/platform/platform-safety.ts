import { RuntimeError } from "../util/errors.js";
import { assertNoPendingWorktreeRemovalForRepository } from "../runtime/worktree-removal-manifest.js";
import type { CheckoutLock, PlatformServices } from "./platform-services.js";
import { getPlatformServices } from "./select-platform.js";
import {
  writeAtomic,
  DurableDirectorySession,
  openDurableDirectorySession,
  type DurableWriteMode,
  type DurableDirectoryPolicy,
} from "./durable-write.js";

export {
  DurableDirectorySession,
  openDurableDirectorySession,
  type DurableWriteMode,
  type DurableDirectoryPolicy,
};

export interface CheckoutLeaseOptions<T = unknown> {
  runId?: string | undefined;
  onReleaseError?: ((releaseError: unknown, result: T) => T) | undefined;
}

export type PlatformSafetyServices = Pick<PlatformServices, "acquireCheckoutLock"> & Partial<Pick<PlatformServices, "canonicalizePath">>;

export class PlatformSafety {
  constructor(private readonly platformServices: PlatformSafetyServices = getPlatformServices()) {}

  async withCheckoutLease<T>(
    checkout: string,
    fn: (lease: CheckoutLock) => Promise<T>,
    options?: CheckoutLeaseOptions<T>,
  ): Promise<T> {
    const lease = await this.platformServices.acquireCheckoutLock(checkout, {
      ...(options?.runId === undefined ? {} : { runId: options.runId }),
    });

    let result: T;
    try {
      // 1. Ambiguity gate under the acquired lease
      await this.assertAmbiguityGate(lease.repositoryIdentity);

      // 2. Execute caller logic under the lease
      result = await fn(lease);
    } catch (primaryError) {
      try {
        await lease.release();
      } catch (releaseError) {
        const primaryMessage = primaryError instanceof Error ? primaryError.message : String(primaryError);
        throw new AggregateError(
          [primaryError, releaseError],
          `${primaryMessage}; checkout lock release failed`,
        );
      }
      throw primaryError;
    }
    try {
      await lease.release();
    } catch (releaseError) {
      if (options?.onReleaseError === undefined) throw releaseError;
      return options.onReleaseError(releaseError, result);
    }
    return result;
  }

  async withRecoveryLease<T>(
    checkout: string,
    fn: (lease: CheckoutLock) => Promise<T>,
    options?: CheckoutLeaseOptions,
  ): Promise<T> {
    const lease = await this.platformServices.acquireCheckoutLock(checkout, {
      ...(options?.runId === undefined ? {} : { runId: options.runId }),
    });

    let primaryError: unknown;
    try {
      return await fn(lease);
    } catch (error) {
      primaryError = error;
      throw error;
    } finally {
      try {
        await lease.release();
      } catch (releaseError) {
        if (primaryError !== undefined) {
          throw new AggregateError(
            [primaryError, releaseError],
            "recovery lease release failed after operation failure",
          );
        }
        throw releaseError;
      }
    }
  }

  async writeAtomic(
    session: DurableDirectorySession,
    name: string,
    bytes: Buffer | string,
    mode: DurableWriteMode,
  ): Promise<void> {
    return writeAtomic(session, name, bytes, mode);
  }

  private async assertAmbiguityGate(repositoryIdentity: string): Promise<void> {
    try {
      await assertNoPendingWorktreeRemovalForRepository(repositoryIdentity);
    } catch (error) {
      throw new RuntimeError(
        "worktree mutation is unavailable while removal recovery remains ambiguous",
        { classification: "recovery-ambiguous", cause: error },
      );
    }
  }
}

export const platformSafety = new PlatformSafety();
