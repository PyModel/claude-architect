import { createHash } from "node:crypto";
import { mkdir, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import nodeProcess from "node:process";
import { SAFE_WORKFLOW_ID } from "../autopilot/workflow-store.js";
import { git } from "../git/git-exec.js";
import {
  lockOwnerStatus,
  type LockOwnerStatus,
  reclaimDeadLock,
  reclaimDeadCheckoutLocks,
  lockIsOwnedByLiveProcess,
  acquireOwnedLock,
  releaseOwnedLock,
  defaultIsProcessAlive,
} from "../platform/lock-ownership.js";
import type { PlatformServices } from "../platform/platform-services.js";
import { CLEANUP_JOURNAL_LOCK_KEY } from "../platform/posix-platform-services.js";
import { getPlatformServices } from "../platform/select-platform.js";
import { RuntimeError } from "../util/errors.js";
import { platformPathsEqual } from "../util/platform-path.js";
import { ArtifactStore } from "./artifact-store.js";
import { readPendingWorktreeRemovalManifests } from "./worktree-removal-manifest.js";
import {
  SAFE_RUN_ID,
  type RunStartRecord,
  type WorktreeSweepIssue,
  validateRunId,
  stateRoot,
  readBoundedRegularFile,
  plainDirectoryIdentity,
  parseRunStart,
  validateTerminalResult,
  validateGitCommonDir,
  worktreeSweepIssue,
  boundedWorktreeSweepIssues,
} from "./recovery-shared.js";
import { replayInterruptedPrunes } from "./recovery-prune-journal.js";
import { readRecoveryQuarantineJournal, quarantineRun } from "./recovery-quarantine.js";
import {
  archiveInterruptedPipeline,
  cleanupTemporarySliceRefs,
  cleanupRunWorktreesUnderLease,
  recoverRun,
} from "./recovery-runs.js";
import { recoverPendingWorktreeRemovals } from "./recovery-worktree-removals.js";
import { sweepOrphanWorktrees } from "./recovery-worktree-sweep.js";
import { type AutopilotRecoveryResult, recoverAutopilotWorkflows } from "./recovery-autopilot.js";

export interface RecoveryDependencies {
  /**
   * The platform, whole. Recovery hands it to bound-directory cleanup, which
   * spawns a native helper on Windows, so a partial value cannot serve. It used
   * to be a three-method `Pick` and production grafted the missing members onto
   * the real services at every call -- a full `PlatformServices` built solely so
   * an incomplete test double would type-check. Recovery never takes a checkout
   * lease through it: leases come from `platformSafety.withRecoveryLease`.
   */
  platformServices?: PlatformServices;
  isProcessAlive?: (pid: number) => boolean;
  git?: typeof git;
}

export interface RecoveryResult {
  recovered: string[];
  quarantined: string[];
  workflows?: AutopilotRecoveryResult[];
  worktreeSweepIssues?: WorktreeSweepIssue[];
}

async function reclaimPendingRemovalLocks(
  locksRoot: string,
  isProcessAlive: (pid: number) => boolean,
  getProcessStartToken: (pid: number) => Promise<string | null>,
): Promise<void> {
  const { pending } = await readPendingWorktreeRemovalManifests();
  const seen = new Set<string>();
  for (const { manifest } of pending) {
    let commonDir: string;
    try {
      commonDir = await realpath(manifest.commonDir);
    } catch {
      continue;
    }
    if (!platformPathsEqual(commonDir, manifest.commonDir)) continue;
    const key = createHash("sha256").update(commonDir).digest("hex");
    if (seen.has(key)) continue;
    seen.add(key);
    await reclaimDeadLock(
      path.join(locksRoot, `${key}.lock`),
      isProcessAlive,
      getProcessStartToken,
    );
  }
}

export async function recoverStaleRuns(
  dependencies: RecoveryDependencies = {},
): Promise<RecoveryResult> {
  const root = await stateRoot();
  const ps = dependencies.platformServices ?? getPlatformServices();
  const isProcessAlive = dependencies.isProcessAlive ?? defaultIsProcessAlive;
  const runGit = dependencies.git ?? git;
  if (root === null) return { recovered: [], quarantined: [] };

  const locksRoot = path.join(root, "locks");
  await mkdir(locksRoot, { recursive: true });
  if (await plainDirectoryIdentity(locksRoot) === null) {
    throw new RuntimeError("recovery locks directory disappeared");
  }
  const ownerContents = Buffer.from(JSON.stringify({
    pid: nodeProcess.pid,
    processToken: await ps.getProcessStartToken(nodeProcess.pid),
  }));
  const recoveryLockPath = path.join(locksRoot, "recovery.lock");
  const recoveryLock = await acquireOwnedLock(
    recoveryLockPath,
    ownerContents,
    isProcessAlive,
    pid => ps.getProcessStartToken(pid),
  );
  if (recoveryLock === null) {
    return {
      recovered: [],
      quarantined: [],
      worktreeSweepIssues: [worktreeSweepIssue(
        recoveryLockPath,
        new RuntimeError("startup recovery is deferred by an active or unverifiable recovery lease"),
      )],
    };
  }

  let primaryError: unknown;
  try {
    const runsRoot = path.join(root, "runs");
    const runsIdentity = await plainDirectoryIdentity(runsRoot);
    // The reconciler completes interrupted prunes under a per-repo checkout lease
    // rather than deferring them, so no run is skipped for a pending prune.
    if (runsIdentity !== null) {
      // A crash can leave the cleanup-journal mutex held by a dead owner. That lock
      // is a 64-hex leaf reclaimed by reclaimDeadCheckoutLocks() near the end of this body, but
      // replayInterruptedPrunes acquires it first — so without an up-front reclaim a
      // stale lock would make replay spin to its deadline and throw, aborting recovery
      // before reclaimDeadCheckoutLocks ever runs and permanently blocking every future pass.
      await reclaimDeadLock(
        path.join(locksRoot, `${CLEANUP_JOURNAL_LOCK_KEY}.lock`),
        isProcessAlive,
        pid => ps.getProcessStartToken(pid),
      );
      await replayInterruptedPrunes(runsRoot, ps);
    }
    // Pending removal replay also acquires the per-repository checkout lock.
    // Reclaim only locks named by those manifests here; broad lock reclamation
    // remains at the end, after live run ownership has been revalidated.
    await reclaimPendingRemovalLocks(
      locksRoot,
      isProcessAlive,
      pid => ps.getProcessStartToken(pid),
    );
    // A removal crash can temporarily hide a worktree's administrative
    // directory. Reconcile that durable transaction before stale-run cleanup
    // asks Git to inspect the worktree, or the run is falsely poisoned and its
    // restored worktree becomes permanently claimed by the quarantine journal.
    const pendingRemovalIssues = await recoverPendingWorktreeRemovals(ps);
    const removalsAmbiguous = pendingRemovalIssues.length > 0;
    const journaledQuarantines = runsIdentity === null
      ? new Set<string>()
      : (await readRecoveryQuarantineJournal(runsRoot)).runIds;

    const stale: Array<{ record: RunStartRecord; runStartText: string }> = [];
    const terminalCleanupIssues: WorktreeSweepIssue[] = [];
    const recovered: string[] = [];
    const quarantined: string[] = [];
    const claimedRunIds = new Set(journaledQuarantines);
    const knownRunIds = new Set(journaledQuarantines);
    if (runsIdentity !== null) {
      const runEntries = await readdir(runsRoot, { withFileTypes: true });
      for (const entry of runEntries) {
        if (entry.isDirectory() && !entry.isSymbolicLink() && SAFE_RUN_ID.test(entry.name)) {
          knownRunIds.add(entry.name);
        } else if (entry.isDirectory()
          && !entry.isSymbolicLink()
          && entry.name.startsWith(".poisoned-")
          && SAFE_RUN_ID.test(entry.name.slice(".poisoned-".length))) {
          knownRunIds.add(entry.name.slice(".poisoned-".length));
        }
      }
      for (const entry of runEntries.sort((left, right) => left.name.localeCompare(right.name))) {
        if (entry.isDirectory() && !entry.isSymbolicLink() && entry.name.startsWith(".poisoned-")) {
          const runId = entry.name.slice(".poisoned-".length);
          validateRunId(runId);
          if (!journaledQuarantines.has(runId)) {
            throw new RuntimeError(`unjournaled poisoned run detected: ${runId}`);
          }
          continue;
        }
        if (!entry.isDirectory() || entry.isSymbolicLink() || !SAFE_RUN_ID.test(entry.name)) continue;
        try {
          const runDirectory = path.join(runsRoot, entry.name);
          const runStartText = await readBoundedRegularFile(path.join(runDirectory, "run-start.json"));
          if (runStartText === null) {
            claimedRunIds.add(entry.name);
            continue;
          }
          const record = parseRunStart(runStartText, entry.name);
          const store = new ArtifactStore(entry.name);
          const result = await store.readResult();
          if (result !== null) {
            validateTerminalResult(result, entry.name);
            const marker = await store.readPipelineActiveMarker();
            if (marker !== null) {
              const markerStatus = await lockOwnerStatus(
                { pid: marker.pid, processToken: marker.processToken },
                isProcessAlive,
                pid => ps.getProcessStartToken(pid),
              );
              if (markerStatus !== "dead") {
                claimedRunIds.add(entry.name);
                continue;
              }
            }
            if (removalsAmbiguous) {
              claimedRunIds.add(entry.name);
              continue;
            }
            const checkoutLock = await acquireOwnedLock(
              path.join(locksRoot, `${record.lockKey}.lock`),
              ownerContents,
              isProcessAlive,
              pid => ps.getProcessStartToken(pid),
            );
            if (checkoutLock === null) {
              claimedRunIds.add(entry.name);
              continue;
            }
            let cleanupError: unknown;
            let cleanupFailed = false;
            let cleanupDeferred = false;
            try {
              const lockedRunStartText = await readBoundedRegularFile(
                path.join(runDirectory, "run-start.json"),
              );
              if (lockedRunStartText === null) {
                throw new RuntimeError("run-start recovery record disappeared during recovery");
              }
              const lockedRecord = parseRunStart(lockedRunStartText, entry.name);
              if (lockedRunStartText !== runStartText
                || lockedRecord.runId !== record.runId
                || lockedRecord.lockKey !== record.lockKey
                || lockedRecord.canonicalCommonDir !== record.canonicalCommonDir
                || lockedRecord.pid !== record.pid
                || lockedRecord.processToken !== record.processToken
                || lockedRecord.startedAt !== record.startedAt) {
                throw new RuntimeError("run-start recovery record changed during recovery");
              }
              const lockedResult = await store.readResult();
              if (lockedResult === null) {
                throw new RuntimeError("terminal attempt result disappeared during recovery");
              }
              validateTerminalResult(lockedResult, entry.name);
              const lockedMarker = await store.readPipelineActiveMarker();
              const commonDir = await validateGitCommonDir(lockedRecord.canonicalCommonDir);
              if (lockedMarker === null) {
                await cleanupRunWorktreesUnderLease(
                  commonDir,
                  entry.name,
                  runGit,
                  knownRunIds,
                );
                await cleanupTemporarySliceRefs(commonDir, entry.name, runGit);
              } else {
                const lockedMarkerStatus = await lockOwnerStatus(
                  { pid: lockedMarker.pid, processToken: lockedMarker.processToken },
                  isProcessAlive,
                  pid => ps.getProcessStartToken(pid),
                );
                if (lockedMarkerStatus === "dead") {
                  if (lockedMarker.sliced) await archiveInterruptedPipeline(store, lockedResult);
                  await cleanupRunWorktreesUnderLease(
                    commonDir,
                    entry.name,
                    runGit,
                    knownRunIds,
                  );
                  await cleanupTemporarySliceRefs(commonDir, entry.name, runGit);
                  await store.clearPipelineActiveMarker();
                } else {
                  cleanupDeferred = true;
                }
              }
            } catch (error) {
              cleanupError = error;
              cleanupFailed = true;
            } finally {
              try {
                await releaseOwnedLock(checkoutLock);
              } catch (releaseError) {
                if (!cleanupFailed) throw releaseError;
                throw new AggregateError(
                  [cleanupError, releaseError],
                  "terminal cleanup failed and its checkout lock could not be released",
                );
              }
            }
            if (cleanupFailed) {
              claimedRunIds.add(entry.name);
              terminalCleanupIssues.push(worktreeSweepIssue(
                runDirectory,
                cleanupError,
                record.canonicalCommonDir,
              ));
              continue;
            }
            if (cleanupDeferred) claimedRunIds.add(entry.name);
            continue;
          }
          let ownerStatus: LockOwnerStatus;
          try {
            ownerStatus = await lockOwnerStatus(
              record.pid === null ? null : { pid: record.pid, processToken: record.processToken },
              isProcessAlive,
              pid => ps.getProcessStartToken(pid),
            );
          } catch {
            ownerStatus = "unverifiable";
          }
          if (ownerStatus !== "dead") {
            claimedRunIds.add(entry.name);
            continue;
          }
          if (await lockIsOwnedByLiveProcess(
            locksRoot,
            record.lockKey,
            isProcessAlive,
            pid => ps.getProcessStartToken(pid),
          )) {
            claimedRunIds.add(entry.name);
            continue;
          }
          stale.push({ record, runStartText });
        } catch (error) {
          claimedRunIds.add(entry.name);
          if (!removalsAmbiguous) {
            await quarantineRun(runsRoot, entry.name, error);
            quarantined.push(entry.name);
          }
        }
      }
    }

    for (const { record, runStartText } of stale) {
      const checkoutLock = await acquireOwnedLock(
        path.join(locksRoot, `${record.lockKey}.lock`),
        ownerContents,
        isProcessAlive,
        pid => ps.getProcessStartToken(pid),
      );
      if (checkoutLock === null) {
        claimedRunIds.add(record.runId);
        continue;
      }
      let recoveryError: unknown;
      let recoveryFailed = false;
      let becameTerminal = false;
      let becameLive = false;
      try {
        const lockedRunStartText = await readBoundedRegularFile(
          path.join(runsRoot, record.runId, "run-start.json"),
        );
        if (lockedRunStartText === null) {
          throw new RuntimeError("run-start recovery record disappeared before stale recovery");
        }
        const lockedRecord = parseRunStart(lockedRunStartText, record.runId);
        if (lockedRunStartText !== runStartText) {
          throw new RuntimeError("run-start recovery record changed before stale recovery");
        }
        const lockedResult = await new ArtifactStore(record.runId).readResult();
        if (lockedResult !== null) {
          validateTerminalResult(lockedResult, record.runId);
          becameTerminal = true;
        } else {
          becameLive = await recoverRun(
            lockedRecord,
            root,
            ps,
            isProcessAlive,
            runGit,
            !removalsAmbiguous,
            knownRunIds,
          ) === "live-preserve";
        }
      } catch (error) {
        recoveryError = error;
        recoveryFailed = true;
      } finally {
        try {
          await releaseOwnedLock(checkoutLock);
        } catch (cleanupError) {
          if (!recoveryFailed) throw cleanupError;
          throw new AggregateError(
            [recoveryError, cleanupError],
            "stale-run recovery failed and its checkout lock could not be released",
          );
        }
      }
      if (recoveryFailed) {
        claimedRunIds.add(record.runId);
        if (!removalsAmbiguous) {
          await quarantineRun(runsRoot, record.runId, recoveryError);
          quarantined.push(record.runId);
        }
        continue;
      }
      if (becameTerminal || becameLive) {
        claimedRunIds.add(record.runId);
        continue;
      }
      recovered.push(record.runId);
    }
    await reclaimDeadCheckoutLocks(
      locksRoot,
      isProcessAlive,
      pid => ps.getProcessStartToken(pid),
    );
    const workflowRecoveryIssues: WorktreeSweepIssue[] = [];
    const workflows = removalsAmbiguous
      ? []
      : await recoverAutopilotWorkflows(root, {
        isProcessAlive,
        getProcessStartToken: pid => ps.getProcessStartToken(pid),
        runGit,
      }, workflowRecoveryIssues);
    const claimedWorkflowPrefixes = new Set<string>();
    for (const { workflowId } of workflows) {
      if (SAFE_WORKFLOW_ID.test(workflowId)
        && await plainDirectoryIdentity(path.join(root, "workflows", workflowId)) !== null) {
        claimedWorkflowPrefixes.add(
          createHash("sha256").update(workflowId).digest("hex").slice(0, 32),
        );
      }
    }
    const orphanWorktreeIssues = pendingRemovalIssues.length === 0
      ? await sweepOrphanWorktrees({
        root,
        locksRoot,
        claimedRunIds,
        claimedWorkflowPrefixes,
        ownerContents,
        isProcessAlive,
        getProcessStartToken: pid => ps.getProcessStartToken(pid),
        runGit,
      })
      : [];
    const worktreeSweepIssues = boundedWorktreeSweepIssues([
      ...pendingRemovalIssues.map(issue => worktreeSweepIssue(
        issue.manifestPath,
        issue.error,
        issue.repositoryIdentity,
      )),
      ...terminalCleanupIssues,
      ...workflowRecoveryIssues,
      ...orphanWorktreeIssues,
    ], path.join(root, "worktrees"));
    const result: RecoveryResult = workflows.length === 0
      ? { recovered, quarantined }
      : { recovered, quarantined, workflows };
    return worktreeSweepIssues.length === 0
      ? result
      : { ...result, worktreeSweepIssues };
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    try {
      await releaseOwnedLock(recoveryLock);
    } catch (cleanupError) {
      if (primaryError === undefined) throw cleanupError;
      throw new AggregateError(
        [primaryError, cleanupError],
        "startup recovery failed and its recovery lock could not be released",
      );
    }
  }
}
