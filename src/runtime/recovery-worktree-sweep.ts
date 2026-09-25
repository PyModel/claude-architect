import { createHash } from "node:crypto";
import { readdir, realpath } from "node:fs/promises";
import path from "node:path";
import {
  workflowOwnershipRecordWorkflowId,
  workflowWorktreeOwnershipClaim,
  type WorkflowWorktreeOwnershipClaim,
} from "../autopilot/branch-manager.js";
import type { AutopilotWorkflowState } from "../autopilot/types.js";
import { TERMINAL_PHASES, WorkflowStore } from "../autopilot/workflow-store.js";
import { git } from "../git/git-exec.js";
import { gitPathOutput } from "../git/git-output.js";
import {
  managedWorktreeDirectoryIdentity,
  type ManagedWorktreeDirectoryIdentity,
} from "./worktree-manager.js";
import {
  lockOwnerStatus,
  type LockOwnerStatus,
  type AcquiredLock,
  type DeadLockReclaimResult,
  reclaimDeadLock,
  createOwnedLock,
  releaseOwnedLock,
} from "../platform/lock-ownership.js";
import { sameDirectoryIdentity } from "../platform/durable-directory.js";
import { RuntimeError } from "../util/errors.js";
import {
  isManagedWorktreeNamespace,
  isNamespaceControlEntry,
  managedWorktreeRoots,
} from "./managed-worktree-root.js";
import {
  WORKFLOW_WORKTREE_NAME,
  LEGACY_FINAL_WORKTREE_NAME,
  WORKFLOW_OWNERSHIP_NAME,
  type DirectoryIdentity,
  type WorktreeSweepIssue,
  assertPrivateRecoveryDirectory,
  plainDirectoryIdentity,
  runGitError,
  worktreeSweepIssue,
} from "./recovery-shared.js";
import {
  managedWorktreeMarkerIsPresent,
  removeManagedWorktreeUnderLease,
  runClaimsWorktree,
} from "./recovery-runs.js";
import { observeWorkflowLease } from "./recovery-autopilot.js";

const MALFORMED_WORKFLOW_OWNERSHIP = "";

async function workflowOwnershipRecords(
  root: string,
): Promise<Map<string, string[]>> {
  const ownershipRoot = path.join(root, "autopilot-branches");
  if (await plainDirectoryIdentity(ownershipRoot) === null) return new Map();
  const records = new Map<string, string[]>();
  for (const entry of await readdir(ownershipRoot, { withFileTypes: true })) {
    const match = WORKFLOW_OWNERSHIP_NAME.exec(entry.name);
    if (match === null || !entry.isFile() || entry.isSymbolicLink()) {
      throw new RuntimeError("workflow ownership directory contains a malformed entry");
    }
    const ownershipPath = path.join(ownershipRoot, entry.name);
    const filenamePrefix = match[1]!.slice(0, 32);
    records.set(filenamePrefix, [...(records.get(filenamePrefix) ?? []), ownershipPath]);
    let workflowId: string;
    try {
      workflowId = await workflowOwnershipRecordWorkflowId(ownershipPath);
    } catch {
      records.set(MALFORMED_WORKFLOW_OWNERSHIP, [
        ...(records.get(MALFORMED_WORKFLOW_OWNERSHIP) ?? []),
        ownershipPath,
      ]);
      continue;
    }
    const expectedPrefix = createHash("sha256").update(workflowId).digest("hex").slice(0, 32);
    if (expectedPrefix !== filenamePrefix) {
      records.set(expectedPrefix, [...(records.get(expectedPrefix) ?? []), ownershipPath]);
    }
    const legacyPrefix = createHash("sha256")
      .update(JSON.stringify(workflowId)).digest("hex").slice(0, 24);
    records.set(`legacy:${legacyPrefix}`, [
      ...(records.get(`legacy:${legacyPrefix}`) ?? []),
      ownershipPath,
    ]);
  }
  return records;
}

async function workflowClaimMustBePreserved(
  root: string,
  claim: WorkflowWorktreeOwnershipClaim,
  isProcessAlive: (pid: number) => boolean,
  getProcessStartToken: (pid: number) => Promise<string | null>,
): Promise<boolean> {
  const store = new WorkflowStore(claim.workflowId, {
    stateDirectory: root,
    isProcessAlive,
    getProcessStartToken,
  });
  let state: AutopilotWorkflowState;
  try {
    state = await store.read();
  } catch {
    return true;
  }
  if (!TERMINAL_PHASES.has(state.phase)) return true;
  const branchOwnerStatus = !isProcessAlive(claim.bootstrapOwner.pid)
    ? Promise.resolve<LockOwnerStatus>("dead")
    : claim.bootstrapOwner.processToken === null
      ? Promise.resolve<LockOwnerStatus>("unverifiable")
      : lockOwnerStatus(
        {
          pid: claim.bootstrapOwner.pid,
          processToken: claim.bootstrapOwner.processToken,
        },
        isProcessAlive,
        getProcessStartToken,
      ).catch((): LockOwnerStatus => "unverifiable");
  const [workflowOwner, branchOwner] = await Promise.all([
    observeWorkflowLease(store, isProcessAlive, getProcessStartToken),
    branchOwnerStatus,
  ]);
  return (workflowOwner.presence === "present" && workflowOwner.status !== "dead")
    || branchOwner !== "dead";
}

async function finalMaterializationMustBePreserved(
  root: string,
  claim: WorkflowWorktreeOwnershipClaim,
  isProcessAlive: (pid: number) => boolean,
  getProcessStartToken: (pid: number) => Promise<string | null>,
): Promise<boolean> {
  const store = new WorkflowStore(claim.workflowId, {
    stateDirectory: root,
    isProcessAlive,
    getProcessStartToken,
  });
  try {
    await store.read();
    const owner = await observeWorkflowLease(store, isProcessAlive, getProcessStartToken);
    return owner.presence === "present" && owner.status !== "dead";
  } catch {
    return true;
  }
}

interface OrphanSweepArgs {
  root: string;
  locksRoot: string;
  claimedRunIds: ReadonlySet<string>;
  claimedWorkflowPrefixes: ReadonlySet<string>;
  ownerContents: Buffer;
  isProcessAlive: (pid: number) => boolean;
  getProcessStartToken: (pid: number) => Promise<string | null>;
  runGit: typeof git;
}

export async function sweepOrphanWorktrees(args: OrphanSweepArgs): Promise<WorktreeSweepIssue[]> {
  const { roots, malformed } = await managedWorktreeRoots();
  const issues = malformed.map(record => worktreeSweepIssue(
    record,
    new RuntimeError("managed worktree root record is malformed"),
  ));
  const legacyRoot = path.join(args.root, "worktrees");
  for (const worktreesRoot of [legacyRoot, ...roots.filter(isManagedWorktreeNamespace)]) {
    issues.push(...await sweepOrphanWorktreeRoot(args, worktreesRoot, worktreesRoot === legacyRoot));
  }
  return issues;
}

/**
 * The legacy root sits in the private state directory, so both levels must be
 * private. A checkout namespace sits in the user's shared `.worktrees/`; only
 * the namespace itself is private, and its parent is bound by identity alone.
 */
async function sweepRootParentIdentity(
  worktreesRoot: string,
  legacy: boolean,
): Promise<DirectoryIdentity> {
  const parent = path.dirname(worktreesRoot);
  if (legacy) return await assertPrivateRecoveryDirectory(parent);
  const identity = await plainDirectoryIdentity(parent);
  if (identity === null) throw new RuntimeError("checkout worktrees directory disappeared");
  return identity;
}

async function sweepOrphanWorktreeRoot(
  args: OrphanSweepArgs,
  worktreesRoot: string,
  legacy: boolean,
): Promise<WorktreeSweepIssue[]> {
  const issues: WorktreeSweepIssue[] = [];
  let entries;
  let stateRootIdentity: DirectoryIdentity;
  let worktreesRootIdentity: DirectoryIdentity;
  try {
    if (await plainDirectoryIdentity(worktreesRoot) === null) return issues;
    [stateRootIdentity, worktreesRootIdentity] = await Promise.all([
      sweepRootParentIdentity(worktreesRoot, legacy),
      assertPrivateRecoveryDirectory(worktreesRoot),
    ]);
    entries = (await readdir(worktreesRoot, { withFileTypes: true }))
      .filter(entry => legacy || !isNamespaceControlEntry(entry.name));
    const [settledStateRoot, settledWorktreesRoot] = await Promise.all([
      plainDirectoryIdentity(path.dirname(worktreesRoot)),
      plainDirectoryIdentity(worktreesRoot),
    ]);
    if (settledStateRoot === null
      || settledWorktreesRoot === null
      || !sameDirectoryIdentity(settledStateRoot, stateRootIdentity)
      || !sameDirectoryIdentity(settledWorktreesRoot, worktreesRootIdentity)) {
      throw new RuntimeError("managed worktree namespace identity changed during sweep setup");
    }
  } catch (error) {
    return [worktreeSweepIssue(worktreesRoot, error)];
  }

  let ownershipRecords = new Map<string, string[]>();
  let ownershipLookupError: unknown;
  try {
    ownershipRecords = await workflowOwnershipRecords(args.root);
  } catch (error) {
    ownershipLookupError = error;
  }
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const worktreePath = path.join(worktreesRoot, entry.name);
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      issues.push(worktreeSweepIssue(
        worktreePath,
        new RuntimeError("managed worktree namespace contains a non-directory entry"),
      ));
      continue;
    }
    let expectedIdentity: ManagedWorktreeDirectoryIdentity;
    try {
      const identity = await managedWorktreeDirectoryIdentity(worktreePath);
      if (identity === null) continue;
      expectedIdentity = identity;
    } catch (error) {
      issues.push(worktreeSweepIssue(worktreePath, error));
      continue;
    }

    if ([...args.claimedRunIds].some(runId => runClaimsWorktree(runId, entry.name))) continue;

    try {
      if (!await managedWorktreeMarkerIsPresent(worktreePath)) {
        throw new RuntimeError("orphan worktree repository marker is missing");
      }
    } catch (error) {
      issues.push(worktreeSweepIssue(worktreePath, error));
      continue;
    }

    const workflowMatch = WORKFLOW_WORKTREE_NAME.exec(entry.name);
    const legacyFinalMatch = LEGACY_FINAL_WORKTREE_NAME.exec(entry.name);
    const finalMaterialization = legacyFinalMatch !== null
      || (workflowMatch !== null && entry.name.endsWith("-final"));
    const workflowOwnershipKey = workflowMatch?.[1]
      ?? (legacyFinalMatch === null ? null : `legacy:${legacyFinalMatch[1]}`);
    if (workflowMatch !== null
      && !finalMaterialization
      && args.claimedWorkflowPrefixes.has(workflowMatch[1]!)) continue;
    if (workflowOwnershipKey !== null) {
      if (ownershipLookupError !== undefined) {
        issues.push(worktreeSweepIssue(worktreePath, ownershipLookupError));
        continue;
      }
      const candidates = ownershipRecords.get(workflowOwnershipKey) ?? [];
      const malformedRecords = ownershipRecords.get(MALFORMED_WORKFLOW_OWNERSHIP) ?? [];
      if (malformedRecords.length > 0) {
        issues.push(worktreeSweepIssue(
          worktreePath,
          new RuntimeError("workflow ownership lookup is ambiguous because a record is malformed"),
        ));
        continue;
      }
      if (candidates.length > 1) {
        issues.push(worktreeSweepIssue(
          worktreePath,
          new RuntimeError("workflow worktree ownership lookup is ambiguous"),
        ));
        continue;
      }
      if (candidates.length === 1) {
        try {
          const claim = await workflowWorktreeOwnershipClaim(candidates[0]!, worktreePath);
          const preserve = finalMaterialization
            ? await finalMaterializationMustBePreserved(
              args.root,
              claim,
              args.isProcessAlive,
              args.getProcessStartToken,
            )
            : await workflowClaimMustBePreserved(
              args.root,
              claim,
              args.isProcessAlive,
              args.getProcessStartToken,
            );
          if (preserve) continue;
        } catch (error) {
          issues.push(worktreeSweepIssue(worktreePath, error));
          continue;
        }
      }
    }

    let commonDir: string;
    try {
      const resolved = await args.runGit(worktreePath, [
        "rev-parse", "--path-format=absolute", "--git-common-dir",
      ]);
      if (resolved.truncated?.stdout === true || resolved.truncated?.stderr === true) {
        throw new RuntimeError("worktree repository lookup was truncated");
      }
      if (resolved.exitCode !== 0) {
        throw runGitError("resolve worktree repository", resolved);
      }
      const reportedCommonDir = gitPathOutput(
        resolved.stdout,
        "startup worktree common directory",
      );
      if (!path.isAbsolute(reportedCommonDir)) {
        throw new RuntimeError("worktree repository lookup returned a non-absolute path");
      }
      commonDir = await realpath(reportedCommonDir);
    } catch (error) {
      issues.push(worktreeSweepIssue(worktreePath, error));
      continue;
    }

    const lockKey = createHash("sha256").update(commonDir).digest("hex");
    let lease: AcquiredLock | null = null;
    let contention: DeadLockReclaimResult | undefined;
    try {
      lease = await createOwnedLock(
        path.join(args.locksRoot, `${lockKey}.lock`),
        args.ownerContents,
      );
      if (lease === null) {
        contention = await reclaimDeadLock(
          path.join(args.locksRoot, `${lockKey}.lock`),
          args.isProcessAlive,
          args.getProcessStartToken,
        );
        if (contention === "reclaimed") {
          lease = await createOwnedLock(
            path.join(args.locksRoot, `${lockKey}.lock`),
            args.ownerContents,
          );
        }
      }
    } catch (error) {
      issues.push(worktreeSweepIssue(worktreePath, error, commonDir));
      continue;
    }
    if (lease === null) {
      if (contention === "malformed" || contention === "unverifiable") {
        issues.push(worktreeSweepIssue(
          worktreePath,
          new RuntimeError(`${contention} checkout lease owner`),
          commonDir,
        ));
      }
      continue;
    }

    let cleanupError: unknown;
    try {
      const currentIdentity = await managedWorktreeDirectoryIdentity(worktreePath);
      if (currentIdentity !== null) {
        if (currentIdentity.dev !== expectedIdentity.dev
          || currentIdentity.ino !== expectedIdentity.ino
          || currentIdentity.birthtimeNs !== expectedIdentity.birthtimeNs) {
          throw new RuntimeError("worktree directory identity changed after lease acquisition");
        }
        let workflowClaimed = false;
        if (workflowOwnershipKey !== null) {
          const refreshedOwnership = await workflowOwnershipRecords(args.root);
          const refreshedCandidates = refreshedOwnership.get(workflowOwnershipKey) ?? [];
          const refreshedMalformed = refreshedOwnership.get(MALFORMED_WORKFLOW_OWNERSHIP) ?? [];
          if (refreshedMalformed.length > 0) {
            throw new RuntimeError(
              "workflow ownership lookup became ambiguous because a record is malformed",
            );
          }
          if (refreshedCandidates.length > 1) {
            throw new RuntimeError("workflow worktree ownership lookup became ambiguous");
          }
          if (refreshedCandidates.length === 1) {
            const claim = await workflowWorktreeOwnershipClaim(
              refreshedCandidates[0]!,
              worktreePath,
            );
            workflowClaimed = finalMaterialization
              ? await finalMaterializationMustBePreserved(
                args.root,
                claim,
                args.isProcessAlive,
                args.getProcessStartToken,
              )
              : await workflowClaimMustBePreserved(
                args.root,
                claim,
                args.isProcessAlive,
                args.getProcessStartToken,
              );
          }
        }
        if (!workflowClaimed) {
          const [currentStateRoot, currentWorktreesRoot] = await Promise.all([
            sweepRootParentIdentity(worktreesRoot, legacy),
            assertPrivateRecoveryDirectory(worktreesRoot),
          ]);
          if (!sameDirectoryIdentity(currentStateRoot, stateRootIdentity)
            || !sameDirectoryIdentity(currentWorktreesRoot, worktreesRootIdentity)) {
            throw new RuntimeError("managed worktree namespace changed before orphan removal");
          }
          await removeManagedWorktreeUnderLease(
            commonDir,
            worktreePath,
            expectedIdentity,
            args.runGit,
          );
        }
      }
    } catch (error) {
      cleanupError = error;
    }
    try {
      await releaseOwnedLock(lease);
    } catch (releaseError) {
      cleanupError = cleanupError === undefined
        ? releaseError
        : new AggregateError(
          [cleanupError, releaseError],
          "worktree sweep failed and its checkout lease could not be released",
        );
    }
    if (cleanupError !== undefined) {
      issues.push(worktreeSweepIssue(worktreePath, cleanupError, commonDir));
    }
  }

  return issues;
}
