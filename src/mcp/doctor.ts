import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir, realpath, type FileHandle } from "node:fs/promises";
import path from "node:path";
import nodeProcess from "node:process";
import type {
  WorkflowBranchBootstrapOwnerRecord,
  WorkflowBranchIdentity,
} from "../autopilot/branch-manager.js";
import type { AutopilotWorkflowState } from "../autopilot/types.js";
import {
  WorkflowStore,
  type WorkflowOwnerRecord,
} from "../autopilot/workflow-store.js";
import { git as runGit } from "../git/git-exec.js";
import { gitNulRecords, gitPathOutput } from "../git/git-output.js";
import { findWorktreeRegistration } from "../git/worktree-registration.js";
import type { PlatformServices } from "../platform/platform-services.js";
import { CLEANUP_JOURNAL_LOCK_KEY } from "../platform/posix-platform-services.js";
import { SANDBOX_BACKENDS } from "../platform/sandbox/backends.js";
import { getPlatformServices } from "../platform/select-platform.js";
import { probeAll as probeProducers } from "../producers/capability-probe.js";
import {
  detectEnvironmentType,
  type CapabilityReport,
  type EnvironmentType,
} from "../producers/producer-adapter.js";
import {
  DELEGATION_SPEC_VERSION,
  PROTOCOL_VERSION,
  RUNTIME_VERSION,
} from "../protocol/versions.js";
import { redact, redactRecord } from "../runtime/redaction.js";
import { probeCowSupport } from "../verify/dependency-link.js";
import { checkLiveBundle, type LiveBundleStatus } from "./live-bundle.js";

import { CHECKOUT_LOCK_NAME_PATTERN } from "../platform/lock-ownership.js";

const POSIX_HOME_PATH = /\/(?:Users|home)\/[^/\\\s"']+(?:\/[^/\\\s"']+)*/g;
const WINDOWS_HOME_PATH = /[A-Za-z]:\\Users\\[^/\\\s"']+(?:\\[^/\\\s"']+)*/gi;
const CHECKOUT_LOCK_NAME = CHECKOUT_LOCK_NAME_PATTERN;
const MAX_CHECKOUT_LOCK_BYTES = 4_096;
const MAX_AUTOPILOT_OWNER_BYTES = 1_024;
const MAX_AUTOPILOT_REGISTRATION_BYTES = 32_768;
const MAX_AUTOPILOT_SCAN_ENTRIES = 1_024;
const NO_FOLLOW = constants.O_NOFOLLOW ?? 0;
const WORKFLOW_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const OID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u;

const AUTOPILOT_ISSUE_ORDER = [
  "autopilot-lock-held",
  "autopilot-lock-leaked",
  "autopilot-worktree-orphaned",
  "autopilot-branch-mismatch",
  "autopilot-promotion-incomplete",
  "autopilot-remote-recovery-required",
  "autopilot-pr-recovery-required",
  "autopilot-state-malformed",
  "autopilot-scan-truncated",
] as const;

// `observedBranchMatches` issues six supervised git invocations plus realpath
// calls, each with its own timeout. Left unbounded, one diagnostic call could
// serialize several thousand spawns and become the slowest tool on the surface,
// so cap the git-probing fan-out and say so rather than truncating silently.
const MAX_AUTOPILOT_BRANCH_PROBES = 64;

interface CheckoutLockOwner {
  pid: number;
  processToken: string | null;
}

function redactAbsoluteHomePaths(text: string): string {
  return redact(text)
    .replace(WINDOWS_HOME_PATH, match => `[path]\\${match.split("\\").at(-1) ?? ""}`)
    .replace(POSIX_HOME_PATH, match => `[path]/${match.split("/").at(-1) ?? ""}`);
}

function sanitizeDoctorValue(value: unknown): unknown {
  if (typeof value === "string") return redactAbsoluteHomePaths(value);
  if (Array.isArray(value)) return value.map(sanitizeDoctorValue);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [
    key,
    sanitizeDoctorValue(child),
  ]));
}

function sanitizeCapabilityReports(reports: CapabilityReport[]): CapabilityReport[] {
  return sanitizeDoctorValue(redactRecord(reports)) as CapabilityReport[];
}

export interface DoctorResult {
  node: { version: string; ok: boolean };
  git: { version: string | null; ok: boolean; path: string | null };
  producers: CapabilityReport[];
  sandboxBackends: Array<{
    id: string;
    kind: string;
    state: "certified" | "tested" | "unsupported";
  }>;
  dependencyClone: { cowSupported: boolean; strategy: string };
  liveBundle: LiveBundleStatus;
  runtimeVersion: string;
  schemaVersion: string;
  protocolVersion: string;
  issues: string[];
}

export interface DoctorDependencies {
  ps?: PlatformServices;
  git?: typeof runGit;
  probeAll?: typeof probeProducers;
  probeCowSupport?: typeof probeCowSupport;
  env?: NodeJS.ProcessEnv;
  nodeVersion?: string;
  arch?: string;
  environmentType?: EnvironmentType;
  /** Checkout the caller intends to delegate against; defaults to the server's cwd. */
  checkoutPath?: string;
  checkLiveBundle?: typeof checkLiveBundle;
  isProcessAlive?: (pid: number) => boolean;
}

function nodeIsSupported(version: string): boolean {
  const major = Number.parseInt(version.split(".", 1)[0] ?? "", 10);
  return Number.isInteger(major) && major >= 22;
}

function gitVersion(stdout: string): string | null {
  return /^git version ([^\s]+)(?:\s|$)/u.exec(stdout.trim())?.[1] ?? null;
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code;
}

function defaultIsProcessAlive(pid: number): boolean {
  try {
    nodeProcess.kill(pid, 0);
    return true;
  } catch (error) {
    if (errorCode(error) === "EPERM") return true;
    if (errorCode(error) === "ESRCH") return false;
    throw error;
  }
}

function parseCheckoutLockOwner(contents: string): CheckoutLockOwner | null {
  let value: unknown;
  try {
    value = JSON.parse(contents);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const owner = value as { pid?: unknown; processToken?: unknown };
  const processToken = owner.processToken;
  if (typeof owner.pid !== "number" || !Number.isSafeInteger(owner.pid) || owner.pid < 1
    || (processToken !== null
      && (typeof processToken !== "string" || processToken.length === 0))) {
    return null;
  }
  return { pid: owner.pid, processToken };
}

async function readCheckoutLock(handle: FileHandle): Promise<string | null> {
  const buffer = Buffer.alloc(MAX_CHECKOUT_LOCK_BYTES + 1);
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesRead } = await handle.read(
      buffer,
      offset,
      buffer.length - offset,
      offset,
    );
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  return offset > MAX_CHECKOUT_LOCK_BYTES
    ? null
    : buffer.subarray(0, offset).toString("utf8");
}

async function checkoutLockIssues(
  stateDir: string | undefined,
  ps: PlatformServices,
  isProcessAlive: (pid: number) => boolean,
): Promise<string[]> {
  if (stateDir === undefined) return [];
  const locksRoot = path.join(stateDir, "locks");
  let entries;
  try {
    entries = await readdir(locksRoot, { withFileTypes: true });
  } catch (error) {
    return errorCode(error) === "ENOENT" ? [] : ["checkout-lock-scan-failed"];
  }

  const issues = new Set<string>();
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const match = CHECKOUT_LOCK_NAME.exec(entry.name);
    if (match === null || match[1] === CLEANUP_JOURNAL_LOCK_KEY) continue;
    if (!entry.isFile() || entry.isSymbolicLink()) {
      issues.add("checkout-lock-malformed");
      continue;
    }

    let handle;
    try {
      handle = await open(path.join(locksRoot, entry.name), constants.O_RDONLY | NO_FOLLOW);
      const metadataBeforeRead = await handle.stat();
      if (!metadataBeforeRead.isFile() || metadataBeforeRead.size > MAX_CHECKOUT_LOCK_BYTES) {
        issues.add("checkout-lock-malformed");
        continue;
      }
      const contents = await readCheckoutLock(handle);
      const metadataAfterRead = await handle.stat();
      if (contents === null
        || metadataAfterRead.size !== metadataBeforeRead.size
        || metadataAfterRead.mtimeMs !== metadataBeforeRead.mtimeMs
        || metadataAfterRead.ctimeMs !== metadataBeforeRead.ctimeMs) {
        issues.add("checkout-lock-malformed");
        continue;
      }
      const owner = parseCheckoutLockOwner(contents);
      if (owner === null) {
        issues.add("checkout-lock-malformed");
        continue;
      }
      if (!isProcessAlive(owner.pid)) {
        issues.add("checkout-lock-leaked");
        continue;
      }
      const liveToken = owner.processToken === null
        ? null
        : await ps.getProcessStartToken(owner.pid);
      issues.add(owner.processToken !== null
        && liveToken !== null
        && liveToken !== owner.processToken
        ? "checkout-lock-leaked"
        : "checkout-lock-held");
    } catch (error) {
      if (errorCode(error) !== "ENOENT") issues.add("checkout-lock-malformed");
    } finally {
      try {
        await handle?.close();
      } catch {
        issues.add("checkout-lock-malformed");
      }
    }
  }
  return [...issues];
}

type AutopilotIssue = typeof AUTOPILOT_ISSUE_ORDER[number];
type OwnerStatus = "live" | "dead" | "unverifiable";
type BoundedRead =
  | { status: "missing" }
  | { status: "malformed" }
  | { status: "ok"; text: string };

interface WorkflowBranchRegistration extends WorkflowBranchIdentity {
  bootstrapOwner: WorkflowBranchBootstrapOwnerRecord;
}

interface RegistrationScan {
  registrations: Map<string, WorkflowBranchRegistration>;
  filenames: Set<string>;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return actual.length === sortedExpected.length
    && actual.every((key, index) => key === sortedExpected[index]);
}

async function readBoundedRegularFile(filename: string, maxBytes: number): Promise<BoundedRead> {
  let handle: FileHandle | undefined;
  let outcome: BoundedRead = { status: "malformed" };
  try {
    handle = await open(filename, constants.O_RDONLY | NO_FOLLOW);
    const before = await handle.stat();
    const named = await lstat(filename);
    if (!before.isFile()
      || before.nlink !== 1
      || before.size > maxBytes
      || !named.isFile()
      || named.isSymbolicLink()
      || named.nlink !== 1
      || named.dev !== before.dev
      || named.ino !== before.ino
      || named.size !== before.size) return outcome;
    const bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    const after = await handle.stat();
    const settledNamed = await lstat(filename);
    if (offset !== before.size
      || after.dev !== before.dev
      || after.ino !== before.ino
      || after.nlink !== 1
      || after.size !== before.size
      || after.mtimeMs !== before.mtimeMs
      || after.ctimeMs !== before.ctimeMs
      || settledNamed.dev !== before.dev
      || settledNamed.ino !== before.ino
      || settledNamed.nlink !== 1
      || settledNamed.size !== before.size) return outcome;
    outcome = { status: "ok", text: bytes.toString("utf8") };
  } catch (error) {
    if (errorCode(error) === "ENOENT") outcome = { status: "missing" };
  } finally {
    try {
      await handle?.close();
    } catch {
      outcome = { status: "malformed" };
    }
  }
  return outcome;
}

function parseOwner(
  text: string,
  workflowId: string,
  timestampKey: "acquiredAt" | "createdAt",
): WorkflowOwnerRecord | WorkflowBranchBootstrapOwnerRecord | null {
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (!exactKeys(record, ["workflowId", "pid", "processToken", timestampKey])
    || record.workflowId !== workflowId
    || !Number.isSafeInteger(record.pid)
    || (record.pid as number) < 1
    || (record.processToken !== null
      && (typeof record.processToken !== "string"
        || record.processToken.length < 1
        || record.processToken.length > 256))
    || typeof record[timestampKey] !== "string"
    || Number.isNaN(Date.parse(record[timestampKey] as string))) return null;
  return record as unknown as WorkflowOwnerRecord | WorkflowBranchBootstrapOwnerRecord;
}

function isBootstrapOwner(
  value: unknown,
  workflowId: string,
): value is WorkflowBranchBootstrapOwnerRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const owner = value as Partial<WorkflowBranchBootstrapOwnerRecord>;
  return owner.workflowId === workflowId
    && Number.isSafeInteger(owner.pid)
    && owner.pid! > 0
    && (owner.processToken === null
      || (typeof owner.processToken === "string"
        && owner.processToken.length > 0
        && owner.processToken.length <= 256))
    && typeof owner.createdAt === "string"
    && !Number.isNaN(Date.parse(owner.createdAt));
}

function parseRegistration(text: string): WorkflowBranchRegistration | null {
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Partial<WorkflowBranchRegistration>;
  if (record.ownershipVersion !== "1"
    || typeof record.workflowId !== "string"
    || !WORKFLOW_ID.test(record.workflowId)
    || typeof record.checkoutPath !== "string"
    || !path.isAbsolute(record.checkoutPath)
    || typeof record.gitCommonDir !== "string"
    || !path.isAbsolute(record.gitCommonDir)
    || typeof record.repositoryIdentity !== "string"
    || typeof record.worktreePath !== "string"
    || !path.isAbsolute(record.worktreePath)
    || typeof record.worktreeGitDir !== "string"
    || !path.isAbsolute(record.worktreeGitDir)
    || typeof record.branch !== "string"
    || record.branchRef !== `refs/heads/${record.branch}`
    || record.baseRef !== `refs/claude-architect/autopilot/${record.workflowId}/base`
    || typeof record.baseBranch !== "string"
    || typeof record.baseCommitOid !== "string"
    || !OID.test(record.baseCommitOid)
    || record.remote !== "origin"
    || typeof record.remoteUrl !== "string"
    || typeof record.ownerRepo !== "string"
    || !isBootstrapOwner(record.bootstrapOwner, record.workflowId)) return null;
  return record as WorkflowBranchRegistration;
}

async function ownerStatus(
  owner: { pid: number; processToken: string | null },
  ps: PlatformServices,
  isProcessAlive: (pid: number) => boolean,
): Promise<OwnerStatus> {
  let alive: boolean;
  try {
    alive = isProcessAlive(owner.pid);
  } catch {
    return "unverifiable";
  }
  if (!alive) return "dead";
  if (owner.processToken === null) return "unverifiable";
  const token = await ps.getProcessStartToken(owner.pid).catch(() => null);
  if (token === null) return "unverifiable";
  return token === owner.processToken ? "live" : "dead";
}

function sameOwner(
  lease: WorkflowOwnerRecord,
  bootstrap: WorkflowBranchBootstrapOwnerRecord,
): boolean {
  return lease.workflowId === bootstrap.workflowId
    && lease.pid === bootstrap.pid
    && lease.processToken === bootstrap.processToken;
}

function registrationFilename(workflowId: string): string {
  return `${createHash("sha256").update(workflowId).digest("hex")}.json`;
}

async function safeDirectoryEntries(
  directory: string,
  issues: Set<AutopilotIssue>,
) {
  try {
    const metadata = await lstat(directory);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      issues.add("autopilot-state-malformed");
      return [];
    }
    const entries = await readdir(directory, { withFileTypes: true });
    if (entries.length > MAX_AUTOPILOT_SCAN_ENTRIES) {
      issues.add("autopilot-state-malformed");
    }
    return entries
      .sort((left, right) => left.name.localeCompare(right.name))
      .slice(0, MAX_AUTOPILOT_SCAN_ENTRIES);
  } catch (error) {
    if (errorCode(error) !== "ENOENT") issues.add("autopilot-state-malformed");
    return [];
  }
}

async function scanRegistrations(
  stateRoot: string,
  issues: Set<AutopilotIssue>,
): Promise<RegistrationScan> {
  const root = path.join(stateRoot, "autopilot-branches");
  const entries = await safeDirectoryEntries(root, issues);
  const registrations = new Map<string, WorkflowBranchRegistration>();
  const filenames = new Set<string>();
  for (const entry of entries) {
    filenames.add(entry.name);
    if (!entry.isFile()
      || entry.isSymbolicLink()
      || !/^[0-9a-f]{64}\.json$/u.test(entry.name)) {
      issues.add("autopilot-state-malformed");
      continue;
    }
    const read = await readBoundedRegularFile(
      path.join(root, entry.name),
      MAX_AUTOPILOT_REGISTRATION_BYTES,
    );
    if (read.status !== "ok") {
      issues.add("autopilot-state-malformed");
      continue;
    }
    const registration = parseRegistration(read.text);
    if (registration === null
      || entry.name !== registrationFilename(registration.workflowId)
      || registrations.has(registration.workflowId)) {
      issues.add("autopilot-state-malformed");
      continue;
    }
    registrations.set(registration.workflowId, registration);
  }
  return { registrations, filenames };
}

function branchMatchesState(
  registration: WorkflowBranchRegistration,
  state: AutopilotWorkflowState,
): boolean {
  return registration.workflowId === state.workflowId
    && registration.repositoryIdentity === state.repositoryIdentity
    && registration.baseCommitOid === state.baseCommitOid
    && registration.branchRef === state.workflowRef
    && registration.worktreePath === state.worktreePath
    && registration.branch === state.shipping.branch;
}

function expectedHead(state: AutopilotWorkflowState | null, registration: WorkflowBranchIdentity) {
  if (state === null) return null;
  const head = state.tasks
    .slice(0, state.currentTaskIndex + 1)
    .reduce((current, task) => task.promotionCommitOid ?? current, state.baseCommitOid);
  return OID.test(head) ? head : registration.baseCommitOid;
}

async function observedBranchMatches(
  registration: WorkflowBranchRegistration,
  state: AutopilotWorkflowState | null,
  git: typeof runGit,
): Promise<boolean> {
  try {
    const [checkoutMetadata, worktreeMetadata] = await Promise.all([
      lstat(registration.checkoutPath),
      lstat(registration.worktreePath),
    ]);
    if (!checkoutMetadata.isDirectory()
      || checkoutMetadata.isSymbolicLink()
      || !worktreeMetadata.isDirectory()
      || worktreeMetadata.isSymbolicLink()) return false;
    const [checkout, worktree, common] = await Promise.all([
      realpath(registration.checkoutPath),
      realpath(registration.worktreePath),
      realpath(registration.gitCommonDir),
    ]);
    if (checkout !== registration.checkoutPath
      || worktree !== registration.worktreePath
      || common !== registration.gitCommonDir) return false;

    const [observedCommon, worktrees, symbolic, head, branchRef, baseRef] = await Promise.all([
      git(registration.checkoutPath, ["rev-parse", "--path-format=absolute", "--git-common-dir"]),
      git(registration.checkoutPath, ["worktree", "list", "--porcelain", "-z"]),
      git(registration.worktreePath, ["symbolic-ref", "--quiet", "--short", "HEAD"]),
      git(registration.worktreePath, ["rev-parse", "--verify", "HEAD"]),
      git(registration.checkoutPath, ["rev-parse", "--verify", registration.branchRef]),
      git(registration.checkoutPath, ["rev-parse", "--verify", registration.baseRef]),
    ]);
    if ([observedCommon, worktrees, symbolic, head, branchRef, baseRef].some(result =>
      result.exitCode !== 0
      || result.truncated?.stdout === true
      || result.truncated?.stderr === true)) return false;
    if (await realpath(gitPathOutput(
      observedCommon.stdout,
      "workflow common directory",
    )) !== registration.gitCommonDir
      || symbolic.stdout.trim() !== registration.branch
      || head.stdout.trim() !== branchRef.stdout.trim()
      || baseRef.stdout.trim() !== registration.baseCommitOid) return false;
    const stateHead = expectedHead(state, registration);
    if (stateHead !== null && head.stdout.trim() !== stateHead) return false;
    const fields = gitNulRecords(worktrees.stdout, "doctor Git worktree list");
    const index = await findWorktreeRegistration(fields, registration.worktreePath);
    if (index === -1) return false;
    const next = fields.findIndex((field, fieldIndex) =>
      fieldIndex > index && field.startsWith("worktree "));
    const record = fields.slice(index + 1, next === -1 ? undefined : next);
    return record.includes(`HEAD ${head.stdout.trim()}`)
      && record.includes(`branch ${registration.branchRef}`);
  } catch {
    return false;
  }
}

async function autopilotIssues(
  stateDir: string | undefined,
  ps: PlatformServices,
  isProcessAlive: (pid: number) => boolean,
  git: typeof runGit,
): Promise<string[]> {
  if (stateDir === undefined) return [];
  const stateRoot = path.resolve(stateDir);
  const issues = new Set<AutopilotIssue>();
  let probes = 0;
  const registrationScan = await scanRegistrations(stateRoot, issues);
  const workflowsRoot = path.join(stateRoot, "workflows");
  const workflowEntries = await safeDirectoryEntries(workflowsRoot, issues);
  const states = new Map<string, AutopilotWorkflowState>();

  for (const entry of workflowEntries) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || !WORKFLOW_ID.test(entry.name)) {
      issues.add("autopilot-state-malformed");
      continue;
    }
    const workflowId = entry.name;
    const store = new WorkflowStore(workflowId, { stateDirectory: stateRoot });
    let state: AutopilotWorkflowState;
    let journal;
    try {
      [state, journal] = await Promise.all([store.read(), store.readIntentJournal()]);
      states.set(workflowId, state);
    } catch {
      issues.add("autopilot-state-malformed");
      continue;
    }
    if (journal.tornTail) issues.add("autopilot-state-malformed");

    if (journal.intents.some(intent =>
      intent.intent.operation === "promote-candidate" && intent.completion === null)) {
      issues.add("autopilot-promotion-incomplete");
    }

    const ownerRead = await readBoundedRegularFile(store.ownerPath, MAX_AUTOPILOT_OWNER_BYTES);
    let lease: WorkflowOwnerRecord | null = null;
    let leaseStatus: OwnerStatus | null = null;
    if (ownerRead.status === "ok") {
      const parsed = parseOwner(ownerRead.text, workflowId, "acquiredAt");
      if (parsed === null || !("acquiredAt" in parsed)) {
        issues.add("autopilot-state-malformed");
      } else {
        lease = parsed;
        leaseStatus = await ownerStatus(lease, ps, isProcessAlive);
        if (leaseStatus === "live") issues.add("autopilot-lock-held");
        if (leaseStatus === "dead") issues.add("autopilot-lock-leaked");
      }
    } else if (ownerRead.status === "malformed") {
      issues.add("autopilot-state-malformed");
    }

    const registration = registrationScan.registrations.get(workflowId) ?? null;
    const expectedRegistrationName = registrationFilename(workflowId);
    const registrationMissing = !registrationScan.filenames.has(expectedRegistrationName);
    if (registration !== null && lease !== null && !sameOwner(lease, registration.bootstrapOwner)) {
      issues.add("autopilot-state-malformed");
    }
    if (registration !== null && leaseStatus !== null) {
      const bootstrapStatus = await ownerStatus(
        registration.bootstrapOwner,
        ps,
        isProcessAlive,
      );
      if (bootstrapStatus !== leaseStatus) issues.add("autopilot-state-malformed");
    }
    if (leaseStatus === "dead" && state.phase === "pushing") {
      issues.add("autopilot-remote-recovery-required");
    }
    if (leaseStatus === "dead"
      && (state.phase === "creating-draft-pr" || state.phase === "marking-ready")) {
      issues.add("autopilot-pr-recovery-required");
    }

    let worktreeExists = false;
    try {
      const metadata = await lstat(state.worktreePath);
      worktreeExists = metadata.isDirectory() && !metadata.isSymbolicLink();
      if (!worktreeExists) issues.add("autopilot-state-malformed");
    } catch (error) {
      if (errorCode(error) !== "ENOENT") issues.add("autopilot-state-malformed");
    }
    if (worktreeExists && registrationMissing) {
      issues.add("autopilot-worktree-orphaned");
    } else if (registration !== null && !branchMatchesState(registration, state)) {
      issues.add("autopilot-branch-mismatch");
    } else if (registration !== null) {
      if (probes >= MAX_AUTOPILOT_BRANCH_PROBES) issues.add("autopilot-scan-truncated");
      else {
        probes += 1;
        if (!await observedBranchMatches(registration, state, git)) {
          issues.add("autopilot-branch-mismatch");
        }
      }
    }
  }

  for (const [workflowId, registration] of registrationScan.registrations) {
    if (states.has(workflowId)) continue;
    if (probes >= MAX_AUTOPILOT_BRANCH_PROBES) {
      issues.add("autopilot-scan-truncated");
      break;
    }
    probes += 1;
    if (!await observedBranchMatches(registration, null, git)) {
      issues.add("autopilot-branch-mismatch");
    }
  }
  return AUTOPILOT_ISSUE_ORDER.filter(issue => issues.has(issue));
}

export async function doctor(deps: DoctorDependencies = {}): Promise<DoctorResult> {
  const ps = deps.ps ?? getPlatformServices();
  const env = deps.env ?? process.env;
  const nodeVersion = deps.nodeVersion ?? process.versions.node;
  const arch = deps.arch ?? process.arch;
  const environmentType = deps.environmentType ?? detectEnvironmentType();
  const issues: string[] = [];
  const gitRunner = deps.git ?? runGit;
  const sandboxBackends = SANDBOX_BACKENDS.map(backend => ({
    id: backend.id,
    kind: backend.kind,
    state: backend.platforms.find(candidate =>
      candidate.os === ps.os
      && candidate.environmentType === environmentType
      && (candidate.arch === undefined || candidate.arch === arch))?.state ?? "unsupported",
  }));

  const supportedNodeVersion = nodeIsSupported(nodeVersion);
  let initialNodeAvailable = false;
  try {
    await ps.resolveExecutable({ name: "node" });
    initialNodeAvailable = true;
  } catch {
    issues.push("initial-node-unavailable");
  }
  const node = { version: nodeVersion, ok: supportedNodeVersion && initialNodeAvailable };
  if (!supportedNodeVersion) issues.push("unsupported-node-version");
  if (!env.CLAUDE_PLUGIN_DATA) issues.push("missing-claude-plugin-data");
  if (env.CLAUDE_ARCHITECT_DELEGATED !== undefined) {
    issues.push("nested-delegation-marker-present");
  }
  const stateDir = env.CLAUDE_PLUGIN_DATA
    ?? (env.NODE_ENV === "test" ? env.CLAUDE_ARCHITECT_STATE_DIR : undefined);
  issues.push(...await checkoutLockIssues(
    stateDir,
    ps,
    deps.isProcessAlive ?? defaultIsProcessAlive,
  ));
  issues.push(...await autopilotIssues(
    stateDir,
    ps,
    deps.isProcessAlive ?? defaultIsProcessAlive,
    gitRunner,
  ));

  let git: DoctorResult["git"] = { version: null, ok: false, path: null };
  try {
    const result = await gitRunner(process.cwd(), ["--version"]);
    const version = result.exitCode === 0 && result.truncated?.stdout !== true
      ? gitVersion(result.stdout)
      : null;
    // Report which git actually resolved. A host whose PATH selects a wrapper
    // rather than a real git behaves very differently under load, and that is
    // invisible from a version string alone.
    let path: string | null = null;
    try {
      path = (await ps.resolveExecutable({ name: "git" })).command;
    } catch {
      // Resolution failure is already covered by the git-unavailable issue.
    }
    git = { version, ok: version !== null, path };
  } catch {
    // The issue code below is the actionable diagnostic; external error text is not exposed.
  }
  if (!git.ok) issues.push("git-unavailable");

  let dependencyClone: DoctorResult["dependencyClone"];
  try {
    dependencyClone = await (deps.probeCowSupport ?? probeCowSupport)();
  } catch {
    dependencyClone = { cowSupported: false, strategy: "unsupported" };
    issues.push("dependency-clone-probe-failed");
  }

  let liveBundle: LiveBundleStatus;
  try {
    liveBundle = await (deps.checkLiveBundle ?? checkLiveBundle)(
      deps.checkoutPath ?? process.cwd(),
    );
  } catch {
    liveBundle = {
      selfHosted: false,
      runningVersion: RUNTIME_VERSION,
      repositoryVersion: null,
      bundleMatches: null,
      stale: false,
    };
    issues.push("live-bundle-probe-failed");
  }
  if (liveBundle.stale) issues.push("stale-live-bundle");

  let producers: CapabilityReport[] = [];
  try {
    producers = sanitizeCapabilityReports(await (deps.probeAll ?? probeProducers)({
      ps,
      os: ps.os,
      arch,
      environmentType,
    }, undefined, { fresh: true }));
    for (const producer of producers) {
      if (!producer.available && producer.reason !== null) {
        issues.push(redact(`producer:${producer.producerId}:${producer.reason}`));
      }
    }
  } catch {
    issues.push("producer-probe-failed");
  }

  return {
    node,
    git,
    producers,
    sandboxBackends,
    dependencyClone,
    liveBundle,
    runtimeVersion: RUNTIME_VERSION,
    schemaVersion: DELEGATION_SPEC_VERSION,
    protocolVersion: PROTOCOL_VERSION,
    issues,
  };
}
