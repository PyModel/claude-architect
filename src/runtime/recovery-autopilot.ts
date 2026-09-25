import { createHash } from "node:crypto";
import type { Dirent } from "node:fs";
import { lstat, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import {
  WorkflowBranchManager,
  type WorkflowBranchIdentity,
  type WorkflowBranchBootstrapOwnerRecord,
} from "../autopilot/branch-manager.js";
import type { AutopilotWorkflowState } from "../autopilot/types.js";
import {
  SAFE_WORKFLOW_ID,
  TERMINAL_PHASES,
  WorkflowStore,
  type WorkflowIntentJournal,
  type WorkflowOwnerRecord,
} from "../autopilot/workflow-store.js";
import { git } from "../git/git-exec.js";
import { gitNulRecords, gitPathOutput } from "../git/git-output.js";
import { findWorktreeRegistration } from "../git/worktree-registration.js";
import { lockOwnerStatus, type LockOwnerStatus } from "../platform/lock-ownership.js";
import { RuntimeError, isMissing } from "../util/errors.js";
import {
  OID,
  type WorktreeSweepIssue,
  readBoundedRegularFile,
  plainDirectoryIdentity,
  worktreeSweepIssue,
} from "./recovery-shared.js";

export type AutopilotRecoveryDisposition =
  | "live-preserve"
  | "resume"
  | "dispose"
  | "human-decision-required";

export interface AutopilotRecoveryResult {
  workflowId: string;
  disposition: AutopilotRecoveryDisposition;
}

type OwnerObservation =
  | { presence: "absent" }
  | { presence: "present"; status: LockOwnerStatus };

interface BranchObservation {
  presence: "absent" | "present" | "ambiguous";
  identity: WorkflowBranchIdentity | null;
  owner: WorkflowBranchBootstrapOwnerRecord | null;
  ownerStatus: LockOwnerStatus | null;
}

function exactObjectKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return actual.length === sortedExpected.length
    && actual.every((key, index) => key === sortedExpected[index]);
}

function parseWorkflowLease(text: string, workflowId: string): WorkflowOwnerRecord | null {
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (!exactObjectKeys(record, ["workflowId", "pid", "processToken", "acquiredAt"])
    || record.workflowId !== workflowId
    || !Number.isSafeInteger(record.pid)
    || (record.pid as number) < 1
    || (record.processToken !== null
      && (typeof record.processToken !== "string"
        || record.processToken.length < 1
        || record.processToken.length > 256))
    || typeof record.acquiredAt !== "string"
    || Number.isNaN(Date.parse(record.acquiredAt))) return null;
  return record as unknown as WorkflowOwnerRecord;
}

export async function observeWorkflowLease(
  store: WorkflowStore,
  isProcessAlive: (pid: number) => boolean,
  getProcessStartToken: (pid: number) => Promise<string | null>,
): Promise<OwnerObservation> {
  const text = await readBoundedRegularFile(store.ownerPath).catch(() => undefined);
  if (text === undefined) return { presence: "present", status: "unverifiable" };
  if (text === null) return { presence: "absent" };
  const record = parseWorkflowLease(text, store.workflowId);
  if (record === null) return { presence: "present", status: "unverifiable" };
  return {
    presence: "present",
    status: await lockOwnerStatus(record, isProcessAlive, getProcessStartToken)
      .catch((): LockOwnerStatus => "unverifiable"),
  };
}

function branchOwnershipPath(root: string, workflowId: string): string {
  const name = createHash("sha256").update(workflowId).digest("hex");
  return path.join(root, "autopilot-branches", `${name}.json`);
}

async function observeWorkflowBranch(
  root: string,
  workflowId: string,
  manager: WorkflowBranchManager,
  isProcessAlive: (pid: number) => boolean,
  getProcessStartToken: (pid: number) => Promise<string | null>,
): Promise<BranchObservation> {
  const registration = await readBoundedRegularFile(branchOwnershipPath(root, workflowId))
    .catch(() => undefined);
  if (registration === undefined) {
    return { presence: "ambiguous", identity: null, owner: null, ownerStatus: null };
  }
  if (registration === null) {
    return { presence: "absent", identity: null, owner: null, ownerStatus: null };
  }
  const [identity, owner] = await Promise.all([
    manager.load(workflowId),
    manager.readBootstrapOwner(workflowId),
  ]).catch(() => [null, null] as const);
  if (identity === null || owner === null) {
    return { presence: "ambiguous", identity: null, owner: null, ownerStatus: null };
  }
  return {
    presence: "present",
    identity,
    owner,
    ownerStatus: await lockOwnerStatus(owner, isProcessAlive, getProcessStartToken)
      .catch((): LockOwnerStatus => "unverifiable"),
  };
}

function isWorkflowBranchIdentity(value: unknown): value is WorkflowBranchIdentity {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const identity = value as Partial<WorkflowBranchIdentity>;
  return identity.ownershipVersion === "1"
    && typeof identity.workflowId === "string"
    && SAFE_WORKFLOW_ID.test(identity.workflowId)
    && typeof identity.checkoutPath === "string"
    && typeof identity.gitCommonDir === "string"
    && typeof identity.repositoryIdentity === "string"
    && typeof identity.worktreePath === "string"
    && typeof identity.worktreeGitDir === "string"
    && typeof identity.branch === "string"
    && identity.branchRef === `refs/heads/${identity.branch}`
    && identity.baseRef === `refs/claude-architect/autopilot/${identity.workflowId}/base`
    && typeof identity.baseBranch === "string"
    && typeof identity.baseCommitOid === "string"
    && OID.test(identity.baseCommitOid)
    && identity.remote === "origin"
    && typeof identity.remoteUrl === "string"
    && typeof identity.ownerRepo === "string";
}

function branchMatchesWorkflowState(
  branch: WorkflowBranchIdentity,
  state: AutopilotWorkflowState,
): boolean {
  return branch.workflowId === state.workflowId
    && branch.repositoryIdentity === state.repositoryIdentity
    && branch.baseCommitOid === state.baseCommitOid
    && branch.branchRef === state.workflowRef
    && branch.worktreePath === state.worktreePath
    && branch.branch === state.branch;
}

function sameWorkflowBranch(
  left: WorkflowBranchIdentity,
  right: WorkflowBranchIdentity,
): boolean {
  return left.ownershipVersion === right.ownershipVersion
    && left.workflowId === right.workflowId
    && left.checkoutPath === right.checkoutPath
    && left.gitCommonDir === right.gitCommonDir
    && left.repositoryIdentity === right.repositoryIdentity
    && left.worktreePath === right.worktreePath
    && left.worktreeGitDir === right.worktreeGitDir
    && left.branch === right.branch
    && left.branchRef === right.branchRef
    && left.baseRef === right.baseRef
    && left.baseBranch === right.baseBranch
    && left.baseCommitOid === right.baseCommitOid
    && left.remote === right.remote
    && left.remoteUrl === right.remoteUrl
    && left.ownerRepo === right.ownerRepo;
}

function canonicalGithubRemote(raw: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:"
    || parsed.hostname.toLowerCase() !== "github.com"
    || parsed.port !== ""
    || parsed.username !== ""
    || parsed.password !== ""
    || parsed.search !== ""
    || parsed.hash !== ""
    || parsed.pathname.includes("%")
    || parsed.pathname.endsWith("/")
    || parsed.pathname.includes("//")) return null;
  const components = parsed.pathname.slice(1).split("/");
  if (components.length !== 2) return null;
  const owner = components[0]!;
  const repository = components[1]!.endsWith(".git")
    ? components[1]!.slice(0, -4)
    : components[1]!;
  const component = /^[A-Za-z0-9_.-]+$/u;
  if (!component.test(owner)
    || !component.test(repository)
    || owner === "."
    || owner === ".."
    || repository === "."
    || repository === "..") return null;
  return `https://github.com/${owner.toLowerCase()}/${repository.toLowerCase()}.git`;
}

function recordedBranch(
  journal: WorkflowIntentJournal,
  state: AutopilotWorkflowState,
): WorkflowBranchIdentity | null {
  const recorded = journal.intents.find(status =>
    status.intent.operation === "record-workflow-spec"
    && status.intent.idempotencyKey === "workflow-spec");
  const completion = recorded?.completion?.completion;
  if (typeof completion !== "object" || completion === null || Array.isArray(completion)) {
    return null;
  }
  const branch = (completion as { branch?: unknown }).branch;
  return isWorkflowBranchIdentity(branch) && branchMatchesWorkflowState(branch, state)
    ? branch
    : null;
}

function expectedWorkflowHead(state: AutopilotWorkflowState): string | null {
  const head = state.tasks
    .slice(0, state.currentTaskIndex + 1)
    .reduce((current, task) => task.promotionCommitOid ?? current, state.baseCommitOid);
  return OID.test(head) ? head : null;
}

async function isAbsent(filename: string): Promise<boolean | null> {
  try {
    await lstat(filename);
    return false;
  } catch (error) {
    return isMissing(error) ? true : null;
  }
}

async function activeBranchIsDirectlyObserved(
  branch: WorkflowBranchIdentity,
  expectedHead: string,
  runGit: typeof git,
): Promise<boolean> {
  let canonicalCheckout: string;
  let canonicalWorktree: string;
  let canonicalCommonDir: string;
  try {
    [canonicalCheckout, canonicalWorktree, canonicalCommonDir] = await Promise.all([
      realpath(branch.checkoutPath),
      realpath(branch.worktreePath),
      realpath(branch.gitCommonDir),
    ]);
  } catch {
    return false;
  }
  if (canonicalCheckout !== branch.checkoutPath
    || canonicalWorktree !== branch.worktreePath
    || canonicalCommonDir !== branch.gitCommonDir) return false;

  const [commonDir, worktrees, symbolic, head, base, status, remote] = await Promise.all([
    runGit(branch.checkoutPath, ["rev-parse", "--path-format=absolute", "--git-common-dir"]),
    runGit(branch.checkoutPath, ["worktree", "list", "--porcelain", "-z"]),
    runGit(branch.worktreePath, ["symbolic-ref", "--quiet", "--short", "HEAD"]),
    runGit(branch.worktreePath, ["rev-parse", "--verify", "HEAD"]),
    runGit(branch.checkoutPath, ["rev-parse", "--verify", branch.baseRef]),
    runGit(branch.worktreePath, [
      "status", "--porcelain=v1", "--untracked-files=all", "--ignore-submodules=none",
    ]),
    runGit(branch.checkoutPath, ["config", "--get", "remote.origin.url"]),
  ]);
  if ([commonDir, worktrees, symbolic, head, base, status, remote].some(result =>
    result.truncated?.stdout === true || result.truncated?.stderr === true)
    || commonDir.exitCode !== 0
    || worktrees.exitCode !== 0
    || symbolic.exitCode !== 0
    || head.exitCode !== 0
    || base.exitCode !== 0
    || status.exitCode !== 0
    || remote.exitCode !== 0) return false;
  let observedCommonDir: string;
  try {
    observedCommonDir = await realpath(gitPathOutput(
      commonDir.stdout,
      "active workflow common directory",
    ));
  } catch {
    return false;
  }
  if (observedCommonDir !== branch.gitCommonDir
    || symbolic.stdout.trim() !== branch.branch
    || head.stdout.trim() !== expectedHead
    || base.stdout.trim() !== branch.baseCommitOid
    || status.stdout !== ""
    || canonicalGithubRemote(remote.stdout.trim()) !== branch.remoteUrl) return false;

  const fields = gitNulRecords(worktrees.stdout, "active-branch Git worktree list");
  const registrationIndex = await findWorktreeRegistration(fields, branch.worktreePath);
  if (registrationIndex === -1) return false;
  const nextRegistration = fields.findIndex((field, index) =>
    index > registrationIndex && field.startsWith("worktree "));
  const registration = fields.slice(
    registrationIndex + 1,
    nextRegistration === -1 ? undefined : nextRegistration,
  );
  return registration.includes(`HEAD ${expectedHead}`)
    && registration.includes(`branch ${branch.branchRef}`);
}

async function workflowIds(
  root: string,
  issues: WorktreeSweepIssue[],
): Promise<string[]> {
  const ids = new Set<string>();
  const workflowsRoot = path.join(root, "workflows");
  let workflowEntries: Dirent<string>[] = [];
  try {
    const workflowsIdentity = await plainDirectoryIdentity(workflowsRoot);
    workflowEntries = workflowsIdentity === null
      ? []
      : await readdir(workflowsRoot, { withFileTypes: true });
  } catch (error) {
    issues.push(worktreeSweepIssue(workflowsRoot, error));
  }
  for (const entry of workflowEntries) {
    if (entry.isDirectory() && !entry.isSymbolicLink() && SAFE_WORKFLOW_ID.test(entry.name)) {
      ids.add(entry.name);
    }
  }

  const branchesRoot = path.join(root, "autopilot-branches");
  let branchEntries: Dirent<string>[] = [];
  try {
    const branchesIdentity = await plainDirectoryIdentity(branchesRoot);
    branchEntries = branchesIdentity === null
      ? []
      : await readdir(branchesRoot, { withFileTypes: true });
  } catch (error) {
    issues.push(worktreeSweepIssue(branchesRoot, error));
  }
  for (const entry of branchEntries) {
    if (!entry.isFile() || entry.isSymbolicLink() || !/^[0-9a-f]{64}\.json$/u.test(entry.name)) {
      continue;
    }
    const ownershipPath = path.join(branchesRoot, entry.name);
    let text: string | null;
    let value: unknown;
    try {
      text = await readBoundedRegularFile(ownershipPath);
      if (text === null) {
        throw new RuntimeError("workflow ownership record is absent or unstable");
      }
      value = JSON.parse(text) as unknown;
    } catch (error) {
      issues.push(worktreeSweepIssue(ownershipPath, error));
      continue;
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) continue;
    const workflowId = (value as { workflowId?: unknown }).workflowId;
    if (typeof workflowId === "string"
      && SAFE_WORKFLOW_ID.test(workflowId)
      && entry.name === path.basename(branchOwnershipPath(root, workflowId))) {
      ids.add(workflowId);
    }
  }
  return [...ids].sort((left, right) => left.localeCompare(right));
}

export async function recoverAutopilotWorkflows(
  root: string,
  dependencies: {
    isProcessAlive: (pid: number) => boolean;
    getProcessStartToken: (pid: number) => Promise<string | null>;
    runGit: typeof git;
  },
  workflowIssues: WorktreeSweepIssue[],
): Promise<AutopilotRecoveryResult[]> {
  const results: AutopilotRecoveryResult[] = [];
  const branchManager = new WorkflowBranchManager({ git: dependencies.runGit });
  // Isolate every workflow: the run loop below already quarantines per entry,
  // but a throw here (branch cleanup, finalization) propagated all the way out
  // of recoverStaleRuns and discarded the dispositions already computed for
  // earlier workflows. Because the failure is deterministic — same dead owner,
  // same on-disk evidence — every later startup aborted at the same workflow.
  for (const workflowId of await workflowIds(root, workflowIssues)) {
    try {
    const store = new WorkflowStore(workflowId, {
      stateDirectory: root,
      isProcessAlive: dependencies.isProcessAlive,
      getProcessStartToken: dependencies.getProcessStartToken,
    });
    const [lease, branch] = await Promise.all([
      observeWorkflowLease(
        store,
        dependencies.isProcessAlive,
        dependencies.getProcessStartToken,
      ),
      observeWorkflowBranch(
        root,
        workflowId,
        branchManager,
        dependencies.isProcessAlive,
        dependencies.getProcessStartToken,
      ),
    ]);

    if ((lease.presence === "present" && lease.status === "live")
      || branch.ownerStatus === "live") {
      results.push({ workflowId, disposition: "live-preserve" });
      continue;
    }

    const stateAbsent = await isAbsent(store.statePath);
    if (stateAbsent === true) {
      if (branch.presence === "present" && branch.ownerStatus === "dead"
        && branch.identity !== null) {
        const cleanup = await branchManager.cleanup(branch.identity, branch.identity.baseCommitOid);
        results.push({
          workflowId,
          disposition: cleanup.ok && cleanup.worktreeRemoved && cleanup.refsRemoved
            ? "dispose"
            : "human-decision-required",
        });
      } else {
        results.push({ workflowId, disposition: "human-decision-required" });
      }
      continue;
    }
    if (stateAbsent !== false) {
      results.push({ workflowId, disposition: "human-decision-required" });
      continue;
    }

    let state: AutopilotWorkflowState;
    let journal: WorkflowIntentJournal;
    try {
      [state, journal] = await Promise.all([store.read(), store.readIntentJournal()]);
    } catch {
      results.push({ workflowId, disposition: "human-decision-required" });
      continue;
    }
    if (TERMINAL_PHASES.has(state.phase)) {
      if ((lease.presence === "present" && lease.status === "unverifiable")
        || branch.ownerStatus === "unverifiable") {
        results.push({ workflowId, disposition: "human-decision-required" });
      }
      continue;
    }
    if (lease.presence !== "present" || lease.status !== "dead"
      || branch.presence === "ambiguous"
      || branch.ownerStatus === "unverifiable") {
      results.push({ workflowId, disposition: "human-decision-required" });
      continue;
    }

    const recorded = recordedBranch(journal, state);
    if (recorded === null) {
      results.push({ workflowId, disposition: "human-decision-required" });
      continue;
    }
    if (state.phase === "cleaning-up") {
      // Cleanup is finished by the controller's own resume, whose branch
      // manager revalidates every identity under the checkout lease before it
      // removes anything. Recovery only establishes that the workflow is
      // abandoned and belongs to the recorded branch; a second proof of the
      // same crash window here could disagree with the one that acts.
      const foreignBranch = branch.presence === "present"
        && (branch.identity === null || !sameWorkflowBranch(branch.identity, recorded));
      results.push({
        workflowId,
        disposition: foreignBranch ? "human-decision-required" : "resume",
      });
      continue;
    }

    if (branch.presence !== "present"
      || branch.identity === null
      || branch.ownerStatus !== "dead"
      || !sameWorkflowBranch(branch.identity, recorded)) {
      results.push({ workflowId, disposition: "human-decision-required" });
      continue;
    }
    const expectedHead = expectedWorkflowHead(state);
    if (expectedHead === null
      || !await activeBranchIsDirectlyObserved(
        branch.identity,
        expectedHead,
        dependencies.runGit,
      )) {
      results.push({ workflowId, disposition: "human-decision-required" });
      continue;
    }
    results.push({ workflowId, disposition: "resume" });
    } catch {
      results.push({ workflowId, disposition: "human-decision-required" });
    }
  }
  return results;
}
