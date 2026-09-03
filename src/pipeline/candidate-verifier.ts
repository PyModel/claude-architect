import { git, type GitExecOptions, type GitResult } from "../git/git-exec.js";
import { RuntimeError } from "../util/errors.js";
import { globMatches } from "../util/glob.js";
import type { DelegationSpec } from "../protocol/delegation-spec.js";
import type { AttemptResult, CandidateArtifact } from "../protocol/attempt-result.js";
import type { ArtifactStore } from "../runtime/artifact-store.js";
import type { CheckoutLock, PlatformServices } from "../platform/platform-services.js";
import { getPlatformServices } from "../platform/select-platform.js";
import type { PipelineVerificationReport } from "./pipeline-runtime.js";
import { WorktreeManager, withManagedWorktree } from "../runtime/worktree-manager.js";
import {
  isAllowed,
  recomputeManifest,
} from "../verify/structural-verifier.js";
import { AcceptanceVerifier } from "../verify/acceptance-verifier.js";
import type { VerificationReport } from "./report-types.js";

export interface WeakenedTestEvidence {
  testsDeleted: number;
  testsSkipped: number;
  authorizedTestDeletions: string[];
}

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

export function analyzeWeakenedTests(
  diff: string,
  allowedTestDeletions: string[] = [],
  deletedPaths?: string[],
): WeakenedTestEvidence {
  let testsDeleted = 0;
  let testsSkipped = 0;
  const authorizedTestDeletions: string[] = [];
  let currentFileIsTest = false;
  let currentPath: string | null = null;
  for (const line of diff.split("\n")) {
    if (deletedPaths === undefined && /^deleted file mode/.test(line)) {
      if (currentFileIsTest && currentPath !== null) {
        const deletedPath = currentPath;
        if (allowedTestDeletions.some(pattern => globMatches(pattern, deletedPath))) {
          authorizedTestDeletions.push(deletedPath);
        } else {
          testsDeleted++;
        }
      }
    }
    const diffHeader = /^diff --git a\/(\S+) b\/\S+$/.exec(line);
    if (diffHeader !== null) {
      currentPath = diffHeader[1] ?? null;
      currentFileIsTest = currentPath !== null
        && /(^|\/)tests?\/|\.test\.|\.spec\./.test(currentPath);
    } else if (/^diff --git /.test(line)) {
      currentPath = null;
      currentFileIsTest = /(^|\/)tests?\/|\.test\.|\.spec\./.test(line);
    }
    if (currentFileIsTest && /^\+.*\b(it|test|describe)\.(skip|todo)\(/.test(line)) testsSkipped++;
    if (currentFileIsTest && /^\+.*\bxit\(|^\+.*\bxdescribe\(/.test(line)) testsSkipped++;
  }
  for (const deletedPath of deletedPaths ?? []) {
    if (!/(^|\/)tests?\/|\.test\.|\.spec\./.test(deletedPath)) continue;
    if (allowedTestDeletions.some(pattern => globMatches(pattern, deletedPath))) {
      authorizedTestDeletions.push(deletedPath);
    } else {
      testsDeleted++;
    }
  }
  return { testsDeleted, testsSkipped, authorizedTestDeletions };
}

export function detectWeakenedTests(
  diff: string,
  allowedTestDeletions: string[] = [],
  deletedPaths?: string[],
): { testsDeleted: number; testsSkipped: number } {
  const { testsDeleted, testsSkipped } = analyzeWeakenedTests(
    diff,
    allowedTestDeletions,
    deletedPaths,
  );
  return { testsDeleted, testsSkipped };
}

export function parseDeletedPaths(nameStatus: string): string[] {
  const fields = nameStatus.split("\0");
  const deletedPaths: string[] = [];
  for (let index = 0; index < fields.length; index += 1) {
    const entry = fields[index] ?? "";
    if (entry === "D") {
      const pathname = fields[index + 1];
      if (pathname !== undefined && pathname !== "") deletedPaths.push(pathname);
      index += 1;
      continue;
    }
    const separator = entry.indexOf("\t");
    if (separator >= 0 && entry.slice(0, separator) === "D") {
      deletedPaths.push(entry.slice(separator + 1));
    }
  }
  return deletedPaths;
}

async function candidateArtifact(args: {
  worktreePath: string;
  baselineCommit: string;
  candidateCommit: string;
  anchorRef: string;
  diffText: string;
}): Promise<CandidateArtifact> {
  const artifact: CandidateArtifact = {
    baseCommitOid: args.baselineCommit,
    candidateTreeOid: (await checkedGit(
      args.worktreePath,
      ["rev-parse", `${args.candidateCommit}^{tree}`],
    )).trim(),
    candidateCommitOid: args.candidateCommit,
    anchorRef: args.anchorRef,
    manifestHash: "",
    changedPaths: [],
    patch: args.diffText,
  };
  const canonical = await recomputeManifest({
    worktreePath: args.worktreePath,
    baseCommitOid: args.baselineCommit,
    artifact,
  });
  if (canonical.manifestHash === null) {
    throw new RuntimeError("final candidate paths collide under case folding");
  }
  return {
    ...artifact,
    changedPaths: canonical.changedPaths,
    manifestHash: canonical.manifestHash,
  };
}

export interface VerifyCandidateDependencies {
  ps?: PlatformServices | undefined;
  borrowedCheckoutLease?: CheckoutLock | undefined;
}

export async function verifyCandidate(args: {
  checkoutPath: string;
  spec: DelegationSpec;
  deps?: VerifyCandidateDependencies | undefined;
  attempt: AttemptResult;
  baselineCommit: string;
  candidateCommit: string;
  store: ArtifactStore;
  namespace?: string | undefined;
}): Promise<{ verification: PipelineVerificationReport; baselineDrift: boolean }> {
  const ps = args.deps?.ps ?? getPlatformServices();
  const namespace = args.namespace === undefined ? "" : `${args.namespace}-`;
  const manager = new WorktreeManager(
    args.checkoutPath,
    `${args.attempt.runId}-${namespace}verify`,
    ps,
    args.deps?.borrowedCheckoutLease === undefined
      ? {}
      : { borrowedCheckoutLease: args.deps.borrowedCheckoutLease },
  );
  return await withManagedWorktree({
    manager,
    commit: args.candidateCommit,
    cleanupFailureMessage: "pipeline verification worktree could not be cleaned up",
    run: async worktreePath => {
      const [diffText, , nameStatus, status, ancestry] = await Promise.all([
        checkedGit(worktreePath, ["diff", `${args.baselineCommit}..${args.candidateCommit}`]),
        checkedGit(worktreePath, [
          "diff",
          "--name-only",
          `${args.baselineCommit}..${args.candidateCommit}`,
        ]),
        checkedGit(worktreePath, [
          "diff",
          "--name-status",
          "--no-renames",
          "-z",
          `${args.baselineCommit}..${args.candidateCommit}`,
        ]),
        checkedGit(worktreePath, ["status", "--porcelain"]),
        git(worktreePath, [
          "merge-base",
          "--is-ancestor",
          args.baselineCommit,
          args.candidateCommit,
        ]),
      ]);
      const artifact = await candidateArtifact({
        worktreePath: worktreePath,
        baselineCommit: args.baselineCommit,
        candidateCommit: args.candidateCommit,
        anchorRef: args.attempt.candidate?.anchorRef ?? "",
        diffText,
      });
      const verifier = new AcceptanceVerifier({ mode: "composed-slice" });
      const acceptance = await verifier.verify({
        repoRoot: args.checkoutPath,
        worktreePath: worktreePath,
        baseCommitOid: args.baselineCommit,
        artifact,
        spec: args.spec,
        ps,
        artifactStore: args.store,
        ...(args.deps?.borrowedCheckoutLease === undefined
          ? {}
          : { borrowedCheckoutLease: args.deps.borrowedCheckoutLease }),
        verificationId: () => `${args.attempt.runId}-${namespace}pipeline`,
        logNamePrefix: `${namespace}pipeline-verification`,
      });
      const scopeViolations = artifact.changedPaths
        .filter((change: { path: string; mode: string }) => !isAllowed(
          change.path,
          args.spec.writeAllowlist,
          args.spec.forbiddenScope,
          change.mode === "160000",
        ))
        .map((change: { path: string }) => change.path);
      const weakened = analyzeWeakenedTests(
        diffText,
        args.spec.allowedTestDeletions,
        parseDeletedPaths(nameStatus),
      );
      const workspaceClean = status === "";
      const verificationCommands = new Map(
        args.spec.verification.map(command => [command.id, command]),
      );
      return {
        verification: {
          reportVersion: "1",
          pass: acceptance.ok
            && workspaceClean
            && scopeViolations.length === 0,
          commandResults: acceptance.commandOutcomes.map(command => ({
            id: command.id,
            exitCode: command.exitCode ?? -1,
            ok: command.exitCode !== null
              && !command.timedOut
              && (verificationCommands.get(command.id)?.expectedExitCodes.includes(
                command.exitCode,
              ) ?? false),
          })),
          workspaceClean,
          testsDeleted: weakened.testsDeleted,
          testsSkipped: weakened.testsSkipped,
          scopeViolations,
          evidence: {
            failures: [...acceptance.failures],
            acceptance: acceptance.evidence,
            commandOutcomes: acceptance.commandOutcomes.map(outcome => ({
              ...outcome,
              args: [...outcome.args],
            })),
            ...(args.spec.allowedTestDeletions === undefined
              ? {}
              : { authorizedTestDeletions: [...weakened.authorizedTestDeletions] }),
          },
        },
        baselineDrift: ancestry.exitCode !== 0,
      };
    },
  });
}
