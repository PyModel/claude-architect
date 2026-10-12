import type { LiveBundleStatus } from "../../src/mcp/live-bundle.js";
import type { AllowlistSufficiency } from "../../src/mcp/allowlist-sufficiency.js";
import type { PruneResult } from "../../src/runtime/artifact-store.js";

/** `pruneRuns` seam: pruning that finds nothing to do. */
export async function pruneNothing(): Promise<PruneResult> {
  return { removed: [], retained: [] };
}

/** `checkLiveBundle` seam: the target is not this repository, so nothing is stale. */
export async function notSelfHosted(): Promise<LiveBundleStatus> {
  return {
    selfHosted: false,
    runningVersion: "0.0.0-test",
    repositoryVersion: null,
    bundleMatches: null,
    stale: false,
  };
}

/** `checkAllowlistSufficiency` seam: every referenced source file is allowlisted. */
export async function noAllowlistGaps(): Promise<AllowlistSufficiency> {
  return { allowlisted: 0, gaps: [], omitted: 0 };
}
