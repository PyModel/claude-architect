import { git } from "../git/git-exec.js";
import { gitChecked as checkedGit } from "../git/checked-git.js";
import {
  foldPathForCollision,
  inspectChangedPathManifest,
  parseRawDiff,
  splitNul,
  type RawDiffEntry,
} from "../git/changed-path-manifest.js";
import type { CandidateArtifact, ChangedPath } from "../protocol/attempt-result.js";
import { globMatches } from "../util/glob.js";


export type StructuralFailure =
  | "manifest-divergence"
  | "artifact-divergence"
  | "out-of-scope-write"
  | "modified-symlink"
  | "case-collision"
  | "empty-candidate"
  /**
   * The frozen artifact does not match the base it claims to be built from.
   * Intrinsic to the candidate, so it is a verification failure.
   *
   * Renamed from `base-changed`, which also covered two properties of the
   * *shared checkout* — that its HEAD had moved and that it was dirty. Those are
   * mutable, extrinsic to a frozen artifact, re-checked authoritatively under
   * the repository lock at integration, and can change again in between, so
   * failing verification on them discarded valid candidates and proved nothing.
   * They are reported as `checkoutDrift` evidence instead.
   */
  | "artifact-base-mismatch";

export type VerificationMode = "candidate" | "composed-slice" | "final-branch";

/**
 * The failure classes each mode may report. A mode never reports a class absent
 * from its list, and `structuralVerify` skips the work that proves one. This
 * table is the only place a mode's scope is written down: an omission here is
 * the whole difference between the modes, so two modes cannot drift apart in
 * one branch and agree in another.
 *
 * `composed-slice` omits `artifact-divergence` because a composed slice's
 * commit is replayed onto the wave head and no longer has the base as its
 * parent. `final-branch` omits `case-collision` because the branch is proven
 * against a materialized worktree the host already checked out, and proves
 * `artifact-divergence` over a multi-commit range instead of a single parent.
 */
export const MODE_STRUCTURAL_FAILURES: Record<VerificationMode, readonly StructuralFailure[]> = {
  candidate: [
    "manifest-divergence",
    "artifact-divergence",
    "out-of-scope-write",
    "modified-symlink",
    "case-collision",
    "empty-candidate",
    "artifact-base-mismatch",
  ],
  "composed-slice": [
    "manifest-divergence",
    "out-of-scope-write",
    "modified-symlink",
    "case-collision",
    "empty-candidate",
    "artifact-base-mismatch",
  ],
  "final-branch": [
    "manifest-divergence",
    "artifact-divergence",
    "out-of-scope-write",
    "modified-symlink",
    "empty-candidate",
    "artifact-base-mismatch",
  ],
} as const;

/** Observed state of the shared checkout. Never a verification failure. */
export interface CheckoutDrift {
  headMoved: boolean;
  dirty: boolean;
}

export interface StructuralVerifyArgs {
  repoRoot: string;
  worktreePath: string;
  baseCommitOid: string;
  artifact: CandidateArtifact;
  writeAllowlist: string[];
  forbiddenScope: string[];
}

export interface StructuralVerifyResult {
  ok: boolean;
  failures: StructuralFailure[];
  /**
   * The INDEPENDENTLY recomputed manifest hash, never the candidate's own
   * claim. `null` when colliding paths make the manifest uncomputable — a
   * missing proof must read as missing, not as the Producer's assertion.
   */
  manifestHash: string | null;
  /** Recorded so a human sees the checkout moved; does not affect `ok`. */
  checkoutDrift?: CheckoutDrift;
}





export function isAllowed(
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

export function pathsCaseCollide(changedPaths: string[], treePaths: string[]): boolean {
  const changedByFold = new Map<string, string>();
  for (const changedPath of changedPaths) {
    const { exact, folded } = foldPathForCollision(changedPath);
    const existing = changedByFold.get(folded);
    if (existing !== undefined && existing !== exact) return true;
    changedByFold.set(folded, exact);
  }
  for (const treePath of treePaths) {
    const { exact, folded } = foldPathForCollision(treePath);
    const changed = changedByFold.get(folded);
    if (changed !== undefined && changed !== exact) return true;
  }
  return false;
}

async function candidateHasCaseCollision(args: Pick<
  StructuralVerifyArgs,
  "worktreePath" | "baseCommitOid" | "artifact"
>): Promise<boolean> {
  const [changedOutput, treeOutput] = await Promise.all([
    checkedGit(args.worktreePath, [
      "diff-tree", "-r", "--no-commit-id", "--no-renames", "--name-only", "-z",
      args.baseCommitOid, args.artifact.candidateTreeOid,
    ]),
    checkedGit(args.worktreePath, [
      "ls-tree", "-r", "--name-only", "-z", args.artifact.candidateTreeOid,
    ]),
  ]);
  return pathsCaseCollide(splitNul(changedOutput), splitNul(treeOutput));
}

export async function recomputeManifest(args: Pick<
  StructuralVerifyArgs,
  "worktreePath" | "baseCommitOid" | "artifact"
>): Promise<{
  changedPaths: ChangedPath[];
  manifestHash: string | null;
  rawDiff: RawDiffEntry[];
}> {
  const [rawOutput, nameStatusOutput, treeOutput] = await Promise.all([
    checkedGit(args.worktreePath, [
      "diff-tree",
      "-r",
      "--no-commit-id",
      "--no-renames",
      "--raw",
      "-z",
      args.baseCommitOid,
      args.artifact.candidateTreeOid,
    ]),
    checkedGit(args.worktreePath, [
      "diff-tree",
      "-r",
      "--no-commit-id",
      "--no-renames",
      "--name-status",
      "-z",
      args.baseCommitOid,
      args.artifact.candidateTreeOid,
    ]),
    checkedGit(args.worktreePath, ["ls-tree", "-r", "-z", args.artifact.candidateTreeOid]),
  ]);
  const rawDiff = parseRawDiff(rawOutput);
  const { changedPaths, manifestHash } = inspectChangedPathManifest({
    rawDiff,
    nameStatusOutput,
    treeOutput,
  });
  return { changedPaths, manifestHash, rawDiff };
}

/**
 * Proves the candidate commit is exactly the artifact the run froze, for a
 * single-commit candidate whose parent must be the base.
 */
async function singleCommitIdentityMatches(args: StructuralVerifyArgs): Promise<boolean> {
  const [anchorResult, treeResult, parentResult] = await Promise.all([
    git(args.repoRoot, ["rev-parse", "--verify", `${args.artifact.anchorRef}^{commit}`]),
    git(args.repoRoot, [
      "rev-parse",
      "--verify",
      `${args.artifact.candidateCommitOid}^{tree}`,
    ]),
    git(args.repoRoot, [
      "rev-list",
      "--parents",
      "-n",
      "1",
      args.artifact.candidateCommitOid,
    ]),
  ]);
  if (anchorResult.exitCode !== 0 || treeResult.exitCode !== 0 || parentResult.exitCode !== 0) {
    return false;
  }
  const commitAndParents = parentResult.stdout.trim().split(/\s+/);
  return anchorResult.stdout.trim() === args.artifact.candidateCommitOid
    && treeResult.stdout.trim() === args.artifact.candidateTreeOid
    && commitAndParents.length === 2
    && commitAndParents[0] === args.artifact.candidateCommitOid
    && commitAndParents[1] === args.baseCommitOid;
}

/**
 * The same proof for a linear, multi-commit base-to-head branch: the branch has
 * no single parent commit to compare, so identity rests on both the source
 * repository and the materialized worktree standing at the candidate commit
 * with clean trees, and on the base being an ancestor of it.
 */
async function branchIdentityMatches(args: StructuralVerifyArgs): Promise<boolean> {
  const [sourceHead, materializedHead, candidateTree, sourceStatus, materializedStatus] =
    await Promise.all([
      checkedGit(args.repoRoot, ["rev-parse", "--verify", "HEAD^{commit}"]),
      checkedGit(args.worktreePath, ["rev-parse", "--verify", "HEAD^{commit}"]),
      checkedGit(args.repoRoot, [
        "rev-parse", "--verify", `${args.artifact.candidateCommitOid}^{tree}`,
      ]),
      checkedGit(args.repoRoot, [
        "status", "--porcelain=v1", "-z", "--untracked-files=all",
      ]),
      checkedGit(args.worktreePath, [
        "status", "--porcelain=v1", "-z", "--untracked-files=all",
      ]),
    ]);
  const ancestry = await git(args.repoRoot, [
    "merge-base", "--is-ancestor", args.baseCommitOid, args.artifact.candidateCommitOid,
  ]);
  return sourceHead.trim() === args.artifact.candidateCommitOid
    && materializedHead.trim() === args.artifact.candidateCommitOid
    && candidateTree.trim() === args.artifact.candidateTreeOid
    && ancestry.exitCode === 0
    && ancestry.truncated?.stdout !== true
    && ancestry.truncated?.stderr !== true
    && sourceStatus === ""
    && materializedStatus === "";
}

/**
 * Independent structural proof of a frozen candidate. `mode` selects which
 * failure classes apply (see `MODE_STRUCTURAL_FAILURES`) and which identity
 * proof the artifact shape calls for; every mode shares one manifest
 * recomputation, one scope rule, and one symlink rule, so no two modes can
 * disagree about what "out of scope" or "modified symlink" means.
 */
export async function structuralVerify(
  args: StructuralVerifyArgs,
  mode: VerificationMode = "candidate",
): Promise<StructuralVerifyResult> {
  const applicable = new Set<StructuralFailure>(MODE_STRUCTURAL_FAILURES[mode]);
  const failures = new Set<StructuralFailure>();
  const record = (failure: StructuralFailure, failed: boolean): void => {
    if (failed && applicable.has(failure)) failures.add(failure);
  };
  // A branch candidate stands at its own HEAD by construction, so shared-checkout
  // drift is neither observable nor meaningful for it.
  const observesCheckoutDrift = mode !== "final-branch";

  const [
    manifest,
    baseTreeOid,
    currentHead,
    mainStatus,
    identityValid,
    caseCollision,
  ] = await Promise.all([
    recomputeManifest(args),
    checkedGit(args.repoRoot, ["rev-parse", `${args.baseCommitOid}^{tree}`]),
    observesCheckoutDrift
      ? checkedGit(args.repoRoot, ["rev-parse", "--verify", "HEAD"])
      : Promise.resolve(""),
    observesCheckoutDrift
      ? checkedGit(args.repoRoot, [
        "status",
        "--porcelain=v1",
        "--untracked-files=all",
        "--ignore-submodules=none",
      ])
      : Promise.resolve(""),
    !applicable.has("artifact-divergence")
      ? Promise.resolve(true)
      : mode === "final-branch"
        ? branchIdentityMatches(args)
        : singleCommitIdentityMatches(args),
    applicable.has("case-collision")
      ? candidateHasCaseCollision(args)
      : Promise.resolve(false),
  ]);

  record("case-collision", caseCollision);
  record("artifact-base-mismatch", args.artifact.baseCommitOid !== args.baseCommitOid);
  record(
    "manifest-divergence",
    manifest.manifestHash === null
      || JSON.stringify(args.artifact.changedPaths) !== JSON.stringify(manifest.changedPaths)
      || args.artifact.manifestHash !== manifest.manifestHash,
  );
  record("artifact-divergence", !identityValid);
  record("out-of-scope-write", manifest.changedPaths.some(change =>
    !isAllowed(
      change.path,
      args.writeAllowlist,
      args.forbiddenScope,
      change.mode === "160000",
    )));
  record("modified-symlink", manifest.rawDiff.some(entry =>
    [entry.oldMode, entry.newMode].some(entryMode =>
      entryMode === "120000" || entryMode === "160000")));
  record(
    "empty-candidate",
    manifest.changedPaths.length === 0
      || args.artifact.candidateTreeOid === baseTreeOid.trim(),
  );

  const checkoutDrift: CheckoutDrift = {
    headMoved: currentHead.trim() !== args.baseCommitOid,
    dirty: mainStatus.length > 0,
  };
  return {
    ok: failures.size === 0,
    failures: [...failures],
    manifestHash: manifest.manifestHash,
    ...(observesCheckoutDrift ? { checkoutDrift } : {}),
  };
}
