import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { git } from "../git/git-exec.js";
import { gitPathOutput } from "../git/git-output.js";
import { platformSafety } from "../platform/platform-safety.js";
import type { PlatformServices } from "../platform/platform-services.js";
import {
  emptyBoundDirectory,
  removeBoundEmptyDirectory,
} from "../platform/bound-directory-cleanup.js";
import {
  sameDirectoryIdentity,
  type DirectoryIdentity,
} from "../platform/durable-directory.js";
import { RuntimeError, isMissing } from "../util/errors.js";
import {
  appendCleanupRecord,
  readPendingCleanupIntents,
  type AnchorCleanup,
  type CleanupRecord,
} from "./cleanup-journal.js";
import {
  isPlainDirectory,
  plainDirectoryIdentity,
  runGitError,
  validateRepositoryRoot,
  readDirectRef,
  deleteExactRef,
} from "./recovery-shared.js";

function cleanupOutcome(record: CleanupRecord): AnchorCleanup {
  if (record.repoRoot === null || record.anchorRef === null) return "not-applicable";
  return record.backupRef === null ? "already-absent" : "deleted";
}

async function removePlainDirectory(
  directory: string,
  expected: DirectoryIdentity,
  platformServices: PlatformServices,
): Promise<void> {
  const metadata = await lstat(directory, { bigint: true });
  if (!isPlainDirectory(metadata) || !sameDirectoryIdentity(metadata, expected)) {
    throw new RuntimeError("recovery directory identity changed before removal");
  }
  await emptyBoundDirectory(directory, expected, platformServices);
  await removeBoundEmptyDirectory(directory, expected, platformServices);
}

async function createExactRef(repoRoot: string, ref: string, oid: string): Promise<void> {
  const result = await git(repoRoot, [
    "update-ref",
    "--no-deref",
    ref,
    oid,
    "0".repeat(oid.length),
  ]);
  if (result.exitCode !== 0) throw runGitError("create recovery Git ref", result);
}

async function reconcileCleanupRefs(
  record: CleanupRecord,
  action: "finish" | "rollback",
): Promise<AnchorCleanup> {
  const outcome = cleanupOutcome(record);
  if (outcome === "not-applicable") return outcome;
  const repoRoot = await validateRepositoryRoot(record.repoRoot!);
  const anchorRef = record.anchorRef!;
  const candidateOid = record.candidateCommitOid!;
  let anchorOid = await readDirectRef(repoRoot, anchorRef);
  if (anchorOid !== null && anchorOid !== candidateOid) {
    throw new RuntimeError("candidate anchor moved during interrupted prune recovery");
  }
  if (outcome === "already-absent") {
    if (anchorOid !== null) {
      throw new RuntimeError("candidate anchor unexpectedly reappeared during prune recovery");
    }
    return outcome;
  }

  const backupRef = record.backupRef!;
  let backupOid = await readDirectRef(repoRoot, backupRef);
  if (backupOid !== null && backupOid !== candidateOid) {
    throw new RuntimeError("candidate prune backup moved during recovery");
  }
  if (action === "finish") {
    if (anchorOid !== null && backupOid === null) {
      await createExactRef(repoRoot, backupRef, candidateOid);
      backupOid = candidateOid;
    }
    if (anchorOid !== null) {
      await deleteExactRef(repoRoot, anchorRef, candidateOid);
      anchorOid = null;
    }
    return outcome;
  }

  if (anchorOid === null) {
    if (backupOid === null) {
      throw new RuntimeError("cannot restore candidate anchor without its prune backup");
    }
    await createExactRef(repoRoot, anchorRef, candidateOid);
    anchorOid = candidateOid;
  }
  if (backupOid !== null) await deleteExactRef(repoRoot, backupRef, candidateOid);
  return outcome;
}

async function commitCleanupRefs(record: CleanupRecord): Promise<void> {
  if (cleanupOutcome(record) !== "deleted") return;
  const repoRoot = await validateRepositoryRoot(record.repoRoot!);
  const backupOid = await readDirectRef(repoRoot, record.backupRef!);
  if (backupOid === null) return;
  if (backupOid !== record.candidateCommitOid) {
    throw new RuntimeError("candidate prune backup moved before cleanup commit");
  }
  await deleteExactRef(repoRoot, record.backupRef!, backupOid);
}

async function repositoryRootExists(repoRoot: string): Promise<boolean> {
  // A non-absolute repoRoot is a malformed record, not a deleted repository: realpath
  // would resolve it against the process CWD and could report a corrupt record as "gone",
  // fail-open routing it into the repo-absent reconcile path. Report it present so it falls
  // through to validateRepositoryRoot's absoluteness rejection and stays fail-closed,
  // matching how every other anomalous cleanup record halts recovery for investigation.
  if (!path.isAbsolute(repoRoot)) return true;
  try {
    await realpath(repoRoot);
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

// Complete an interrupted prune whose repository was deleted after the intent was
// written. The candidate anchor and prune-backup refs died with the repository, so
// there is nothing to reconcile in Git; only the archive must converge. The checkout
// lease is intentionally skipped: it serializes Git-ref reconciliation, and this path
// performs none — a vanished repository cannot host a racing integration, and recovery
// already holds the global recovery lock.
//
// Limit of the lease-skip: the normal path's per-repo checkout lease also guarantees at
// most one pending intent per run, so a shadowed quarantine can never be orphaned. This
// path drops that lease, so IF prune were ever wired to run concurrently across processes
// (it has no such caller today — the checkout lease is prune's only cross-process guard),
// two repo-gone intents for one run could interleave and a crash after the losing rename
// could strand a quarantine dir that no surviving pending intent references. That is a
// disk-only leak, never a double-free (rename is atomic) or fail-open. Closing it needs a
// recovery sweep of `.prune-*` dirs unmatched by any pending intent; do that before wiring
// concurrent multi-process prune, not before.
async function reconcileRepoAbsentPrune(
  runsRoot: string,
  record: CleanupRecord,
  platformServices: PlatformServices,
): Promise<void> {
  const runDirectory = path.join(runsRoot, record.runId);
  const quarantinePath = path.join(runsRoot, record.quarantineName);
  const runIdentity = await plainDirectoryIdentity(runDirectory);
  const quarantineIdentity = await plainDirectoryIdentity(quarantinePath);
  if (runIdentity !== null && quarantineIdentity !== null) {
    throw new RuntimeError("both retained and quarantined run archives exist during recovery");
  }
  // Same discriminator as the normal path: a retained run rolls back (nothing was
  // removed), a quarantined run finishes (remove the archive that was moved aside).
  const action = runIdentity !== null ? "rollback" : "finish";
  if (action === "finish" && quarantineIdentity !== null) {
    await removePlainDirectory(quarantinePath, quarantineIdentity, platformServices);
  }
  await appendCleanupRecord(runsRoot, {
    ...record,
    event: action === "finish" ? "prune-cleanup-complete" : "prune-cleanup-rollback",
    anchorCleanup: "already-absent",
    recordedAt: new Date().toISOString(),
  });
}

export async function replayInterruptedPrunes(
  runsRoot: string,
  ps: PlatformServices,
): Promise<void> {
  // The journal reads and repairs a torn tail in one locked section; each
  // completion append below re-takes the journal lock.
  const pending = await readPendingCleanupIntents(runsRoot);
  for (const record of [...pending.values()].sort((left, right) =>
    left.runId.localeCompare(right.runId))) {
    // A repoRoot-less legacy intent has neither anchor nor repository to lock.
    if (record.repoRoot === null) continue;
    // A crash can strand a pending intent whose repository was deleted afterward.
    // Reconcile its archive without Git and move on; otherwise validateRepositoryRoot
    // below throws and aborts the entire recovery pass — a permanent block, because
    // replayInterruptedPrunes runs before every other recovery step.
    //
    // The boundary is deliberately filesystem-definitive absence (realpath ENOENT), the
    // expected "the user deleted their repo" lifecycle event. A repoRoot that still
    // exists but is no longer the canonical repository (its .git removed, replaced by a
    // file, moved so it is non-canonical, or a transient git error) is NOT treated as
    // gone: it stays fail-closed through validateRepositoryRoot below, matching how every
    // other anomalous cleanup record halts recovery for investigation. Widening this to
    // "any validation failure" would fail open — a transient git hiccup would wrongly
    // reclaim the archive and orphan a real repository's refs.
    if (!(await repositoryRootExists(record.repoRoot))) {
      await reconcileRepoAbsentPrune(runsRoot, record, ps);
      continue;
    }
    // Serialize the archive/anchor reconciliation against the checkout
    // lifecycle: hold the repository's checkout lease exactly as prune did.
    const repoRoot = await validateRepositoryRoot(record.repoRoot);
    const commonResult = await git(repoRoot, [
      "rev-parse",
      "--path-format=absolute",
      "--git-common-dir",
    ]);
    if (commonResult.exitCode !== 0) {
      throw runGitError("resolve cleanup repository identity", commonResult);
    }
    const repositoryIdentity = await realpath(gitPathOutput(
      commonResult.stdout,
      "cleanup repository identity",
    ));
    await platformSafety.withRecoveryLease(repoRoot, async (lease) => {
      if (lease.repositoryIdentity !== repositoryIdentity) {
        throw new RuntimeError("checkout lease repository identity changed during prune recovery");
      }
      const runDirectory = path.join(runsRoot, record.runId);
      const quarantinePath = path.join(runsRoot, record.quarantineName);
      const runIdentity = await plainDirectoryIdentity(runDirectory);
      const quarantineIdentity = await plainDirectoryIdentity(quarantinePath);
      if (runIdentity !== null && quarantineIdentity !== null) {
        throw new RuntimeError("both retained and quarantined run archives exist during recovery");
      }
      const action = runIdentity !== null ? "rollback" : "finish";
      const outcome = await reconcileCleanupRefs(record, action);
      if (action === "finish") {
        if (quarantineIdentity !== null) {
          await removePlainDirectory(quarantinePath, quarantineIdentity, ps);
        }
        await commitCleanupRefs(record);
      }
      await appendCleanupRecord(runsRoot, {
        ...record,
        event: action === "finish" ? "prune-cleanup-complete" : "prune-cleanup-rollback",
        anchorCleanup: outcome,
        recordedAt: new Date().toISOString(),
      });
    });
  }
}
