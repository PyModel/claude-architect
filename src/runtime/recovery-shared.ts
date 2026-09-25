import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";
import nodeProcess from "node:process";
import { git, type GitResult } from "../git/git-exec.js";
import { gitPathOutput } from "../git/git-output.js";
import type { ManagedWorktreeDirectoryIdentity } from "./worktree-manager.js";
import { ensurePrivateDirectory, sameDirectoryIdentity } from "../platform/durable-directory.js";
import { RuntimeError, isMissing } from "../util/errors.js";
import { readStableRegularFile } from "../util/stable-file.js";
import { boundedRedactedDiagnostic } from "./redaction.js";
import { resolveStateDir } from "./state-dir.js";

export const NO_FOLLOW = constants.O_NOFOLLOW ?? 0;
export const MAX_STATE_FILE_BYTES = 8_000_000;
export const MAX_STATE_FILE_BYTES_BIGINT = BigInt(MAX_STATE_FILE_BYTES);
export const SAFE_RUN_ID = /^[a-z0-9][a-z0-9._-]*$/;
export const WORKFLOW_WORKTREE_NAME = /^workflow-([0-9a-f]{32})(?:-final)?$/;
export const LEGACY_FINAL_WORKTREE_NAME = /^final-([0-9a-f]{24})$/;
export const WORKFLOW_OWNERSHIP_NAME = /^([0-9a-f]{64})\.json$/;
export const OID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
export const CANDIDATE_REF_PREFIX = "refs/claude-architect/candidates/";
export const BACKUP_REF_PREFIX = "refs/claude-architect/prune-backups/";
export const MAX_QUARANTINE_REASON_BYTES = 2_000;
export const MAX_QUARANTINE_RECORD_BYTES = 4_096;
const MAX_WORKTREE_SWEEP_ISSUES = 100;

export interface RunStartRecord {
  runId: string;
  lockKey: string;
  canonicalCommonDir: string;
  pid: number | null;
  processToken: string | null;
  startedAt: string;
}

export interface DirectoryIdentity {
  dev: bigint;
  ino: bigint;
  birthtimeNs: bigint;
}

export interface WorktreeSweepIssue {
  worktreePath: string;
  reason: string;
  repositoryIdentity?: string;
}


export function isPlainDirectory(metadata: {
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}): boolean {
  return metadata.isDirectory() && !metadata.isSymbolicLink();
}

export function sameManagedIdentity(
  left: ManagedWorktreeDirectoryIdentity,
  right: ManagedWorktreeDirectoryIdentity,
): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.birthtimeNs === right.birthtimeNs;
}

export function validateRunId(runId: unknown): asserts runId is string {
  if (typeof runId !== "string" || !SAFE_RUN_ID.test(runId)) {
    throw new RuntimeError("recovery record has an invalid run id");
  }
}

export async function stateRoot(): Promise<string | null> {
  const configured = nodeProcess.env.CLAUDE_PLUGIN_DATA
    ?? (nodeProcess.env.NODE_ENV === "test"
      ? nodeProcess.env.CLAUDE_ARCHITECT_STATE_DIR
      : undefined);
  if (configured === undefined) return null;
  const root = path.resolve(resolveStateDir());
  try {
    const metadata = await lstat(root, { bigint: true });
    if (!isPlainDirectory(metadata) || metadata.birthtimeNs <= 0n) {
      throw new RuntimeError("plugin data directory must be a stable plain directory during recovery");
    }
    const canonicalRoot = await realpath(root);
    const settled = await lstat(canonicalRoot, { bigint: true });
    if (!isPlainDirectory(settled)
      || settled.dev !== metadata.dev
      || settled.ino !== metadata.ino
      || settled.birthtimeNs !== metadata.birthtimeNs) {
      throw new RuntimeError("plugin data directory identity changed during canonicalization");
    }
    const privateIdentity = await assertPrivateRecoveryDirectory(canonicalRoot);
    if (!sameDirectoryIdentity(privateIdentity, {
      dev: metadata.dev,
      ino: metadata.ino,
      birthtimeNs: metadata.birthtimeNs,
    })) {
      throw new RuntimeError("plugin data directory identity changed during privacy validation");
    }
    return canonicalRoot;
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

export async function readBoundedRegularFile(filename: string): Promise<string | null> {
  try {
    const contents = await readStableRegularFile(filename, MAX_STATE_FILE_BYTES_BIGINT);
    if (contents === null) {
      throw new RuntimeError("recovery state entry is not a stable bounded regular file");
    }
    return contents.toString("utf8");
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

export async function assertPrivateRecoveryDirectory(directory: string): Promise<DirectoryIdentity> {
  return await ensurePrivateDirectory(directory, {
    description: "recovery directory",
    create: false,
    migratePermissions: true,
  });
}

export async function plainDirectoryIdentity(directory: string): Promise<DirectoryIdentity | null> {
  try {
    const metadata = await lstat(directory, { bigint: true });
    if (!isPlainDirectory(metadata)) {
      throw new RuntimeError("recovery directory must not be a symbolic link");
    }
    return {
      dev: metadata.dev,
      ino: metadata.ino,
      birthtimeNs: metadata.birthtimeNs,
    };
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

export function parseRunStart(text: string, expectedRunId: string): RunStartRecord {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (cause) {
    throw new RuntimeError("run-start recovery record is invalid JSON", { cause });
  }
  if (typeof value !== "object" || value === null) {
    throw new RuntimeError("run-start recovery record must be an object");
  }
  const record = value as Partial<RunStartRecord>;
  validateRunId(record.runId);
  if (record.runId !== expectedRunId
    || typeof record.lockKey !== "string"
    || !/^[0-9a-f]{64}$/.test(record.lockKey)
    || typeof record.canonicalCommonDir !== "string"
    || !path.isAbsolute(record.canonicalCommonDir)
    || (record.pid !== null
      && (record.pid === undefined || !Number.isSafeInteger(record.pid) || record.pid <= 1))
    || (record.processToken !== undefined
      && record.processToken !== null
      && typeof record.processToken !== "string")
    || typeof record.startedAt !== "string"
    || !Number.isFinite(Date.parse(record.startedAt))) {
    throw new RuntimeError("run-start recovery record is malformed");
  }
  const expectedLockKey = createHash("sha256")
    .update(record.canonicalCommonDir)
    .digest("hex");
  if (record.lockKey !== expectedLockKey) {
    throw new RuntimeError("run-start lock key does not match its canonical common directory");
  }
  return { ...record, processToken: record.processToken ?? null } as RunStartRecord;
}

export function validateTerminalResult(result: unknown, runId: string): void {
  if (typeof result !== "object" || result === null) {
    throw new RuntimeError("terminal attempt result is malformed during recovery");
  }
  const value = result as { resultVersion?: unknown; runId?: unknown; status?: unknown };
  if (value.resultVersion !== "1"
    || value.runId !== runId
    || typeof value.status !== "string"
    || !["unavailable", "failed", "cancelled", "verified-candidate"].includes(value.status)) {
    throw new RuntimeError("terminal attempt result is malformed during recovery");
  }
}

export function runGitError(action: string, result: GitResult): RuntimeError {
  const diagnostic = (result.stderr || result.stdout).trim().slice(0, 2_000);
  return new RuntimeError(`${action} failed${diagnostic ? `: ${diagnostic}` : ""}`);
}

export async function validateGitCommonDir(commonDir: string): Promise<string> {
  const canonical = await realpath(commonDir);
  if (canonical !== commonDir) {
    throw new RuntimeError("recorded Git common directory is no longer canonical");
  }
  const result = await git(canonical, [
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir",
  ]);
  if (result.exitCode !== 0) throw runGitError("validate Git common directory", result);
  const reported = await realpath(gitPathOutput(
    result.stdout,
    "Git common directory",
  ));
  if (reported !== canonical) {
    throw new RuntimeError("recorded Git common directory no longer identifies the repository");
  }
  return canonical;
}

export async function validateRepositoryRoot(repoRoot: string): Promise<string> {
  if (!path.isAbsolute(repoRoot)) {
    throw new RuntimeError("cleanup journal repository root is not absolute");
  }
  const canonical = await realpath(repoRoot);
  if (canonical !== repoRoot) {
    throw new RuntimeError("cleanup journal repository root is no longer canonical");
  }
  const result = await git(canonical, ["rev-parse", "--show-toplevel"]);
  if (result.exitCode !== 0) throw runGitError("validate cleanup repository", result);
  if (await realpath(gitPathOutput(result.stdout, "Git repository root")) !== canonical) {
    throw new RuntimeError("cleanup journal repository root is not the repository top level");
  }
  return canonical;
}

export async function readDirectRef(
  repoRoot: string,
  ref: string,
  runGit: typeof git = git,
): Promise<string | null> {
  const symbolic = await runGit(repoRoot, ["symbolic-ref", "--quiet", ref]);
  if (symbolic.exitCode === 0) {
    throw new RuntimeError("recovery refuses to mutate a symbolic Git ref");
  }
  if (symbolic.exitCode !== 1) throw runGitError("inspect symbolic Git ref", symbolic);
  const direct = await runGit(repoRoot, ["rev-parse", "--verify", "--quiet", ref]);
  if (direct.exitCode === 1) return null;
  if (direct.exitCode !== 0 || !OID.test(direct.stdout.trim())) {
    throw runGitError("inspect Git ref", direct);
  }
  return direct.stdout.trim();
}

export async function deleteExactRef(
  repoRoot: string,
  ref: string,
  oid: string,
  runGit: typeof git = git,
): Promise<void> {
  const result = await runGit(repoRoot, ["update-ref", "--no-deref", "-d", ref, oid]);
  if (result.exitCode !== 0) throw runGitError("delete recovery Git ref", result);
}

export async function readHandleBytes(
  handle: Awaited<ReturnType<typeof open>>,
  size: number,
): Promise<Buffer> {
  const contents = Buffer.alloc(size);
  let offset = 0;
  while (offset < size) {
    const { bytesRead } = await handle.read(
      contents,
      offset,
      size - offset,
      offset,
    );
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  return contents.subarray(0, offset);
}


export function worktreeSweepIssue(
  worktreePath: string,
  error: unknown,
  repositoryIdentity?: string,
): WorktreeSweepIssue {
  return {
    worktreePath,
    reason: boundedRedactedDiagnostic(error, MAX_QUARANTINE_REASON_BYTES),
    ...(repositoryIdentity === undefined ? {} : { repositoryIdentity }),
  };
}

export function boundedWorktreeSweepIssues(
  issues: WorktreeSweepIssue[],
  worktreesRoot: string,
): WorktreeSweepIssue[] {
  if (issues.length <= MAX_WORKTREE_SWEEP_ISSUES) return issues;
  const retained = issues.slice(0, MAX_WORKTREE_SWEEP_ISSUES - 1);
  return [...retained, {
    worktreePath: worktreesRoot,
    reason: `${issues.length - retained.length} additional worktree sweep issues omitted`,
  }];
}
