import path from "node:path";
import { git, type GitExecOptions, type GitResult } from "../git/git-exec.js";
import { RuntimeError } from "../util/errors.js";
import type { FailureClassification } from "../protocol/attempt-result.js";
import type { LinkedWorktreeGitAccess } from "./git-writable-roots.js";
import type { FixReport } from "./report-types.js";

function gitFailure(action: string, result: GitResult): RuntimeError {
  const diagnostic = (result.stderr || result.stdout).trim().slice(0, 2_000);
  return new RuntimeError(`${action} failed${diagnostic ? `: ${diagnostic}` : ""}`);
}

async function checkedGit(
  cwd: string,
  args: string[],
  options?: GitExecOptions,
): Promise<string> {
  const result = await git(cwd, args, options);
  if (result.exitCode !== 0) throw gitFailure(`git ${args[0] ?? "command"}`, result);
  return result.stdout;
}

export function privateObjectReadOptions(access: LinkedWorktreeGitAccess): {
  env: { GIT_ALTERNATE_OBJECT_DIRECTORIES: string };
} {
  return {
    env: { GIT_ALTERNATE_OBJECT_DIRECTORIES: access.privateObjectsDir },
  };
}

export async function importPromotedObjects(args: {
  checkoutPath: string;
  baselineCommit: string;
  promotedCommit: string;
  access: LinkedWorktreeGitAccess;
}): Promise<void> {
  const privateObjects = privateObjectReadOptions(args.access);
  const packPrefix = path.join(args.access.sharedObjectsDir, "pack", "pack");
  await checkedGit(
    args.checkoutPath,
    ["pack-objects", "--revs", packPrefix],
    {
      ...privateObjects,
      stdin: `${args.promotedCommit}\n^${args.baselineCommit}\n`,
    },
  );

  await checkedGit(args.checkoutPath, ["cat-file", "-e", `${args.promotedCommit}^{commit}`]);
  await checkedGit(args.checkoutPath, ["rev-parse", `${args.promotedCommit}^{tree}`]);
  await checkedGit(args.checkoutPath, [
    "rev-list",
    "--objects",
    args.promotedCommit,
    "--not",
    args.baselineCommit,
  ]);
}

export interface CandidateProvenanceFailure {
  failure: FailureClassification;
  reason: string;
}

export async function validateCandidateProvenance(args: {
  worktreePath: string;
  previousCandidateCommit: string;
  candidateCommit: string;
  gitObjectAccess: LinkedWorktreeGitAccess;
  phaseLabel?: string;
}): Promise<CandidateProvenanceFailure | null> {
  const phaseLabel = args.phaseLabel ?? "fix phase";
  const privateObjects = privateObjectReadOptions(args.gitObjectAccess);
  const candidateObject = await git(args.worktreePath, [
    "cat-file",
    "-e",
    `${args.candidateCommit}^{commit}`,
  ], privateObjects);
  if (candidateObject.exitCode !== 0) {
    return {
      failure: "producer-failure",
      reason: `${phaseLabel} reported a missing candidate commit`,
    };
  }

  const head = await git(
    args.worktreePath,
    ["rev-parse", "--verify", "HEAD^{commit}"],
    privateObjects,
  );
  if (head.exitCode !== 0 || head.stdout.trim() !== args.candidateCommit) {
    return {
      failure: "producer-failure",
      reason: `${phaseLabel} reported a candidate commit that does not match its worktree HEAD`,
    };
  }

  const candidateAncestry = await git(args.worktreePath, [
    "merge-base",
    "--is-ancestor",
    args.previousCandidateCommit,
    args.candidateCommit,
  ], privateObjects);
  if (candidateAncestry.exitCode !== 0) {
    return {
      failure: "sandbox-violation",
      reason: `${phaseLabel} candidate commit is not descended from the reviewed candidate`,
    };
  }

  const worktreeStatus = await git(args.worktreePath, [
    "status",
    "--porcelain",
    "--untracked-files=all",
  ], privateObjects);
  if (worktreeStatus.exitCode !== 0) {
    return {
      failure: "sandbox-violation",
      reason: `${phaseLabel} candidate worktree cleanliness could not be verified`,
    };
  }
  if (worktreeStatus.stdout.length > 0) {
    return {
      failure: "sandbox-violation",
      reason: `${phaseLabel} candidate worktree contains uncommitted state`,
    };
  }

  return null;
}

export async function validateFixProvenance(args: {
  worktreePath: string;
  previousCandidateCommit: string;
  fix: FixReport;
  gitObjectAccess: LinkedWorktreeGitAccess;
}): Promise<CandidateProvenanceFailure | null> {
  const provenanceFailure = await validateCandidateProvenance({
    worktreePath: args.worktreePath,
    previousCandidateCommit: args.previousCandidateCommit,
    candidateCommit: args.fix.candidateCommit,
    gitObjectAccess: args.gitObjectAccess,
  });
  if (provenanceFailure !== null) return provenanceFailure;

  const privateObjects = privateObjectReadOptions(args.gitObjectAccess);
  const dispositionCommits = new Set(args.fix.dispositions.flatMap(disposition =>
    disposition.commit === undefined ? [] : [disposition.commit]));
  for (const dispositionCommit of dispositionCommits) {
    const object = await git(args.worktreePath, [
      "cat-file",
      "-e",
      `${dispositionCommit}^{commit}`,
    ], privateObjects);
    if (object.exitCode !== 0) {
      return {
        failure: "producer-failure",
        reason: "fix phase disposition reported a missing commit object",
      };
    }
    const [afterPrevious, beforeCandidate] = await Promise.all([
      git(args.worktreePath, [
        "merge-base",
        "--is-ancestor",
        args.previousCandidateCommit,
        dispositionCommit,
      ], privateObjects),
      git(args.worktreePath, [
        "merge-base",
        "--is-ancestor",
        dispositionCommit,
        args.fix.candidateCommit,
      ], privateObjects),
    ]);
    if (afterPrevious.exitCode !== 0 || beforeCandidate.exitCode !== 0) {
      return {
        failure: "producer-failure",
        reason: "fix phase disposition commit is outside the produced candidate lineage",
      };
    }
  }
  return null;
}
