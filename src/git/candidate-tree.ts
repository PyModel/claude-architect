import { lstat, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { CandidateArtifact } from "../protocol/attempt-result.js";
import { redact } from "../runtime/redaction.js";
import { globMatches } from "../util/glob.js";
import { isMissing } from "../util/errors.js";
import { gitChecked, reviewDiffArgs } from "./checked-git.js";
import type { GitExecOptions } from "./git-exec.js";
import { computeChangedPathManifest, parseRawDiff, splitNul } from "./changed-path-manifest.js";

const MAX_REJECT_PATHS = 25;
const BINARY_PATCH_PAYLOAD_MARKER = "[[BINARY_PATCH_PAYLOAD_OMITTED]]";

export type FreezeReject = "out-of-scope-write" | "modified-symlink" | "empty-candidate";

export interface FreezeCandidateArgs {
  repoRoot: string;
  worktreePath: string;
  baseCommitOid: string;
  runId: string;
  writeAllowlist: string[];
  forbiddenScope: string[];
}

export interface FreezeEvidence {
  ignoredPaths: string[];
}

export type FreezeCandidateResult =
  | { ok: true; artifact: CandidateArtifact; evidence: FreezeEvidence }
  | { ok: false; reason: FreezeReject; paths?: string[] };

interface WorktreeInventory {
  changedPaths: string[];
  ignoredPaths: string[];
}

async function checkedGit(
  cwd: string,
  args: string[],
  indexFile?: string,
): Promise<string> {
  return await gitChecked(cwd, args, indexFile === undefined ? undefined : { indexFile });
}

function parsePorcelainPaths(output: string, kind: "changed" | "ignored"): string[] {
  const fields = splitNul(output);
  const paths: string[] = [];
  for (let index = 0; index < fields.length; index += 1) {
    const entry = fields[index]!;
    const status = entry.slice(0, 2);
    const entryPath = entry.slice(3);
    if ((kind === "ignored") !== (status === "!!")) {
      if (status.includes("R")) index += 1;
      continue;
    }
    paths.push(entryPath);
    if (status.includes("R")) {
      const sourcePath = fields[index + 1];
      if (sourcePath !== undefined) paths.push(sourcePath);
      index += 1;
    }
  }
  return [...new Set(paths)];
}

async function inventoryWorktree(worktreePath: string): Promise<WorktreeInventory> {
  const changed = await checkedGit(worktreePath, [
    "status",
    "--porcelain=v1",
    "-z",
    "--untracked-files=all",
  ]);
  const ignored = await checkedGit(worktreePath, [
    "status",
    "--porcelain=v1",
    "-z",
    "--ignored",
    "--untracked-files=all",
  ]);
  return {
    changedPaths: parsePorcelainPaths(changed, "changed"),
    ignoredPaths: parsePorcelainPaths(ignored, "ignored"),
  };
}



function isAllowed(
  pathname: string,
  writeAllowlist: string[],
  forbiddenScope: string[],
  opaqueDirectory = false,
): boolean {
  const scopePaths = opaqueDirectory ? [pathname, `${pathname}/`] : [pathname];
  return writeAllowlist.some(pattern => scopePaths.some(candidate => globMatches(pattern, candidate)))
    && !forbiddenScope.some(pattern =>
      scopePaths.some(candidate => globMatches(pattern, candidate, true)));
}

async function advisoryLstatScan(worktreePath: string, changedPaths: string[]): Promise<boolean> {
  const symlinkResults = await Promise.all(changedPaths.map(async changedPath => {
    try {
      return (await lstat(path.resolve(worktreePath, changedPath))).isSymbolicLink();
    } catch (error) {
      if (isMissing(error)) return false;
      throw error;
    }
  }));
  return symlinkResults.some(Boolean);
}

export function sanitizeReviewPatch(patch: string): string {
  const sanitizedLines: string[] = [];
  let omittingBinaryPayload = false;
  for (const line of patch.split(/\r?\n/)) {
    if (line === "GIT binary patch") {
      sanitizedLines.push(line, BINARY_PATCH_PAYLOAD_MARKER);
      omittingBinaryPayload = true;
      continue;
    }
    if (omittingBinaryPayload) {
      if (!line.startsWith("diff --git ")) continue;
      omittingBinaryPayload = false;
    }
    sanitizedLines.push(line);
  }
  return redact(sanitizedLines.join("\n"));
}

/**
 * The archived, human-reviewed patch of a candidate: attributes from the
 * trusted base (see `reviewDiffArgs`), binary payloads omitted, secrets
 * redacted. Every producer of `CandidateArtifact.patch` uses this.
 */
export async function candidateReviewPatch(
  cwd: string,
  baseCommitOid: string,
  candidate: string,
  options?: GitExecOptions,
): Promise<string> {
  return sanitizeReviewPatch(await gitChecked(
    cwd,
    reviewDiffArgs(baseCommitOid, candidate, ["--binary", "--full-index"]),
    options,
  ));
}

export async function freezeCandidate(args: FreezeCandidateArgs): Promise<FreezeCandidateResult> {
  const inventory = await inventoryWorktree(args.worktreePath);
  const outOfScope = inventory.changedPaths.filter(changedPath =>
    !isAllowed(changedPath, args.writeAllowlist, args.forbiddenScope));
  if (outOfScope.length > 0) {
    // Name the offending paths (bounded) so a rejected freeze is diagnosable.
    return { ok: false, reason: "out-of-scope-write", paths: outOfScope.slice(0, MAX_REJECT_PATHS) };
  }

  if (await advisoryLstatScan(args.worktreePath, inventory.changedPaths)) {
    return { ok: false, reason: "modified-symlink" };
  }

  const indexDirectory = await mkdtemp(path.join(tmpdir(), "claude-architect-index-"));
  const indexFile = path.join(indexDirectory, "index");
  try {
    await checkedGit(args.worktreePath, ["read-tree", args.baseCommitOid], indexFile);
    if (inventory.changedPaths.length > 0) {
      const literalPathspecs = inventory.changedPaths.map(changedPath => `:(literal)${changedPath}`);
      await checkedGit(args.worktreePath, ["add", "--all", "--", ...literalPathspecs], indexFile);
    }

    const candidateTreeOid = (await checkedGit(args.worktreePath, ["write-tree"], indexFile)).trim();
    const baseTreeOid = (await checkedGit(
      args.worktreePath,
      ["rev-parse", `${args.baseCommitOid}^{tree}`],
    )).trim();
    if (candidateTreeOid === baseTreeOid) return { ok: false, reason: "empty-candidate" };

    const rawDiff = parseRawDiff(await checkedGit(args.worktreePath, [
      "diff-tree",
      "-r",
      "--no-commit-id",
      "--no-renames",
      "--raw",
      "-z",
      args.baseCommitOid,
      candidateTreeOid,
    ]));
    const frozenOutOfScope = rawDiff.filter(entry =>
      !isAllowed(
        entry.path,
        args.writeAllowlist,
        args.forbiddenScope,
        entry.oldMode === "160000" || entry.newMode === "160000",
      )).map(entry => entry.path);
    if (frozenOutOfScope.length > 0) {
      return {
        ok: false,
        reason: "out-of-scope-write",
        paths: frozenOutOfScope.slice(0, MAX_REJECT_PATHS),
      };
    }
    if (rawDiff.some(entry =>
      [entry.oldMode, entry.newMode].some(mode => mode === "120000" || mode === "160000"))) {
      return { ok: false, reason: "modified-symlink" };
    }

    const nameStatusOutput = await checkedGit(args.repoRoot, [
      "diff-tree",
      "-r",
      "--no-commit-id",
      "--no-renames",
      "--name-status",
      "-z",
      args.baseCommitOid,
      candidateTreeOid,
    ]);
    const treeOutput = await checkedGit(
      args.repoRoot,
      ["ls-tree", "-r", "-z", candidateTreeOid],
    );
    const { changedPaths, manifestHash } = computeChangedPathManifest({
      rawDiff,
      nameStatusOutput,
      treeOutput,
    });
    const patch = await candidateReviewPatch(args.repoRoot, args.baseCommitOid, candidateTreeOid);
    const anchorRef = `refs/claude-architect/candidates/${args.runId}`;
    const candidateCommitOid = (await checkedGit(args.repoRoot, [
      "commit-tree",
      candidateTreeOid,
      "-p",
      args.baseCommitOid,
      "-m",
      `candidate ${args.runId}`,
    ])).trim();
    await checkedGit(args.repoRoot, ["update-ref", anchorRef, candidateCommitOid]);

    return {
      ok: true,
      artifact: {
        baseCommitOid: args.baseCommitOid,
        candidateTreeOid,
        candidateCommitOid,
        anchorRef,
        manifestHash,
        changedPaths,
        patch,
      },
      evidence: {
        ignoredPaths: inventory.ignoredPaths
          .map(ignoredPath => redact(ignoredPath))
          .sort((left, right) => left < right ? -1 : left > right ? 1 : 0),
      },
    };
  } finally {
    await rm(indexDirectory, { recursive: true, force: true });
  }
}
