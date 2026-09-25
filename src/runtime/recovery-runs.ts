import { lstat, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { git } from "../git/git-exec.js";
import { SLICE_REF_PREFIX } from "../git/ref-namespace.js";
import { gitNulRecords, gitPathOutput } from "../git/git-output.js";
import {
  canonicalizeWorktreePath,
  findWorktreeRegistration,
} from "../git/worktree-registration.js";
import {
  managedWorktreeDirectoryIdentity,
  removeMissingRegisteredWorktree,
  removeRegisteredWorktree,
  type ManagedWorktreeDirectoryIdentity,
} from "./worktree-manager.js";
import type { PlatformServices } from "../platform/platform-services.js";
import type { AttemptResult } from "../protocol/attempt-result.js";
import { RuntimeError, isMissing } from "../util/errors.js";
import { platformPathsEqual } from "../util/platform-path.js";
import { ArtifactStore } from "./artifact-store.js";
import { managedWorktreeRoots } from "./managed-worktree-root.js";
import {
  OID,
  CANDIDATE_REF_PREFIX,
  type RunStartRecord,
  plainDirectoryIdentity,
  runGitError,
  validateGitCommonDir,
  readDirectRef,
  deleteExactRef,
} from "./recovery-shared.js";

async function removeStaleCandidateAnchor(repoRoot: string, runId: string): Promise<void> {
  const ref = `${CANDIDATE_REF_PREFIX}${runId}`;
  const oid = await readDirectRef(repoRoot, ref);
  if (oid !== null) await deleteExactRef(repoRoot, ref, oid);
}

export async function archiveInterruptedPipeline(
  store: ArtifactStore,
  result: AttemptResult,
): Promise<void> {
  if (result.status !== "verified-candidate") return;
  const manifest = await store.readManifest();
  if (manifest === null) {
    throw new RuntimeError("run manifest is missing while recovering interrupted pipeline");
  }
  const failed: AttemptResult = {
    ...result,
    status: "failed",
    failure: "verification-failure",
    summary: "Delegation pipeline was interrupted before trusted gates completed.",
    unresolvedIssues: [
      ...result.unresolvedIssues,
      "pipeline-interrupted-before-terminal-cleanup",
    ],
    evidence: {
      ...result.evidence,
      pipelineRecovery: "interrupted-before-terminal-cleanup",
    },
  };
  await store.promoteTerminalArtifacts({ result: failed, manifest });
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

interface TemporarySliceRef {
  ref: string;
  oid: string;
}

async function temporarySliceRefs(
  repoRoot: string,
  runId: string,
  runGit: typeof git,
): Promise<TemporarySliceRef[]> {
  const prefix = `${SLICE_REF_PREFIX}${runId}/`;
  const listed = await runGit(repoRoot, [
    "for-each-ref",
    "--format=%(refname)%09%(objectname)",
    prefix,
  ]);
  if (listed.exitCode !== 0) throw runGitError("enumerate temporary slice refs", listed);
  const expectedName = new RegExp(
    `^${escapeRegex(prefix)}slice-[1-9][0-9]*-attempt-(?:0|[1-9][0-9]*)$`,
  );
  const refs: TemporarySliceRef[] = [];
  for (const line of listed.stdout.split("\n").filter(Boolean)) {
    const fields = line.split("\t");
    if (fields.length !== 2 || fields[0] === undefined || !expectedName.test(fields[0])) {
      throw new RuntimeError("temporary slice ref name is malformed during recovery");
    }
    if (fields[1] === undefined || !OID.test(fields[1])) {
      throw new RuntimeError("temporary slice ref OID is malformed during recovery");
    }
    const object = await runGit(repoRoot, ["cat-file", "-t", fields[1]], {
      env: { GIT_NO_REPLACE_OBJECTS: "1" },
    });
    if (object.exitCode !== 0 || object.stdout.trim() !== "commit") {
      throw new RuntimeError("temporary slice ref does not identify a commit during recovery");
    }
    refs.push({ ref: fields[0], oid: fields[1] });
  }
  for (const temporaryRef of refs) {
    const current = await readDirectRef(repoRoot, temporaryRef.ref, runGit);
    if (current !== temporaryRef.oid) {
      throw new RuntimeError("temporary slice ref moved during recovery");
    }
  }
  return refs;
}

export async function cleanupTemporarySliceRefs(
  repoRoot: string,
  runId: string,
  runGit: typeof git,
): Promise<void> {
  const refs = await temporarySliceRefs(repoRoot, runId, runGit);
  for (const temporaryRef of refs) {
    await deleteExactRef(repoRoot, temporaryRef.ref, temporaryRef.oid, runGit);
  }
}

export async function managedWorktreeMarkerIsPresent(worktreePath: string): Promise<boolean> {
  let marker;
  try {
    marker = await lstat(path.join(worktreePath, ".git"), { bigint: true });
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
  if (!marker.isFile() || marker.isSymbolicLink() || marker.nlink !== 1n) {
    throw new RuntimeError("managed worktree repository marker is ambiguous");
  }
  return true;
}

export async function removeManagedWorktreeUnderLease(
  commonDir: string,
  worktreePath: string,
  expectedIdentity: ManagedWorktreeDirectoryIdentity,
  runGit: typeof git,
): Promise<void> {
  const currentIdentity = await managedWorktreeDirectoryIdentity(worktreePath);
  if (currentIdentity === null) return;
  if (currentIdentity.dev !== expectedIdentity.dev
    || currentIdentity.ino !== expectedIdentity.ino
    || currentIdentity.birthtimeNs !== expectedIdentity.birthtimeNs) {
    throw new RuntimeError("worktree directory identity changed under checkout lease");
  }
  if (await managedWorktreeMarkerIsPresent(worktreePath)) {
    const resolved = await runGit(worktreePath, [
      "rev-parse", "--path-format=absolute", "--git-common-dir",
    ]);
    if (resolved.truncated?.stdout === true || resolved.truncated?.stderr === true) {
      throw new RuntimeError("worktree repository lookup was truncated under checkout lease");
    }
    if (resolved.exitCode !== 0) {
      throw runGitError("resolve worktree repository under checkout lease", resolved);
    }
    const reportedCommonDir = gitPathOutput(
      resolved.stdout,
      "managed worktree common directory",
    );
    if (!path.isAbsolute(reportedCommonDir)
      || await realpath(reportedCommonDir) !== commonDir) {
      throw new RuntimeError("managed worktree belongs to a different repository");
    }
  }
  const listed = await runGit(commonDir, ["worktree", "list", "--porcelain", "-z"]);
  if (listed.exitCode !== 0
    || listed.truncated?.stdout === true
    || listed.truncated?.stderr === true) {
    throw runGitError("recheck worktree registration", listed);
  }
  const registered = await findWorktreeRegistration(
    gitNulRecords(listed.stdout, "rechecked Git worktree list"),
    worktreePath,
  ) !== -1;
  if (!registered) {
    throw new RuntimeError("managed worktree registration is absent");
  }
  await removeRegisteredWorktree(
    commonDir,
    worktreePath,
    { git: runGit },
    expectedIdentity,
  );
}

function mostSpecificKnownRunClaim(
  knownRunIds: ReadonlySet<string>,
  managedId: string,
): string | undefined {
  let owner: string | undefined;
  for (const runId of knownRunIds) {
    if (runClaimsWorktree(runId, managedId)
      && (owner === undefined || runId.length > owner.length)) owner = runId;
  }
  return owner;
}

async function canonicalManagedRoots(): Promise<string[]> {
  const { roots } = await managedWorktreeRoots();
  const canonical: string[] = [];
  for (const root of roots) {
    try {
      // A vanished root still anchors its stale registrations.
      canonical.push(await canonicalizeWorktreePath(root, true));
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
  }
  return canonical;
}

export async function cleanupRunWorktreesUnderLease(
  commonDir: string,
  runId: string,
  runGit: typeof git,
  knownRunIds: ReadonlySet<string>,
): Promise<void> {
  const managedRoots = await canonicalManagedRoots();
  for (const worktreesRoot of managedRoots) {
    if (await plainDirectoryIdentity(worktreesRoot) === null) continue;
    const entries = await readdir(worktreesRoot, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (!entry.isDirectory()
        || entry.isSymbolicLink()
        || !runClaimsWorktree(runId, entry.name)
        || mostSpecificKnownRunClaim(knownRunIds, entry.name) !== runId) continue;
      const worktreePath = path.join(worktreesRoot, entry.name);
      const identity = await managedWorktreeDirectoryIdentity(worktreePath);
      if (identity !== null) {
        await removeManagedWorktreeUnderLease(commonDir, worktreePath, identity, runGit);
      }
    }
  }

  // A crash or external removal can erase the physical directory before its
  // exact Git registration is cleaned. Such a path cannot be discovered by
  // scanning the managed roots, so inspect this run's known repository while
  // its checkout lease is held and remove only registrations in a managed
  // root whose complete run-id boundary matches.
  const listed = await runGit(commonDir, ["worktree", "list", "--porcelain", "-z"]);
  if (listed.exitCode !== 0
    || listed.truncated?.stdout === true
    || listed.truncated?.stderr === true) {
    throw runGitError("enumerate missing run worktree registrations", listed);
  }
  for (const field of gitNulRecords(listed.stdout, "missing-run Git worktree list")) {
    if (!field.startsWith("worktree ")) continue;
    const worktreePath = await canonicalizeWorktreePath(
      path.resolve(field.slice("worktree ".length)),
      true,
    ).catch((error: unknown) => {
      if (isMissing(error)) return null;
      throw error;
    });
    if (worktreePath === null
      || !managedRoots.some(root => platformPathsEqual(path.dirname(worktreePath), root))
      || !runClaimsWorktree(runId, path.basename(worktreePath))
      || mostSpecificKnownRunClaim(knownRunIds, path.basename(worktreePath)) !== runId
      || await managedWorktreeDirectoryIdentity(worktreePath) !== null) continue;
    await removeMissingRegisteredWorktree(commonDir, worktreePath, { git: runGit });
  }
}

export async function recoverRun(
  record: RunStartRecord,
  root: string,
  ps: Pick<PlatformServices, "getProcessStartToken" | "terminateProcessTreeByPid">,
  isProcessAlive: (pid: number) => boolean,
  runGit: typeof git = git,
  worktreeCleanupAllowed = true,
  knownRunIds: ReadonlySet<string> = new Set([record.runId]),
): Promise<"recovered" | "live-preserve"> {
  if (record.pid !== null && isProcessAlive(record.pid)) {
    if (record.processToken === null) return "live-preserve";
    let observedToken: string | null;
    try {
      observedToken = await ps.getProcessStartToken(record.pid);
    } catch {
      return "live-preserve";
    }
    if (observedToken === null) return "live-preserve";
    if (observedToken === record.processToken) {
      await ps.terminateProcessTreeByPid(record.pid, record.processToken);
    }
  }
  if (!worktreeCleanupAllowed) {
    throw new RuntimeError("pending worktree removal ambiguity deferred stale-run cleanup");
  }
  const commonDir = await validateGitCommonDir(record.canonicalCommonDir);
  const store = new ArtifactStore(record.runId);
  const logsRef = await store.writeLog(
    "recovery",
    "startup recovery reclaimed unfinished run\n",
  );
  await cleanupRunWorktreesUnderLease(commonDir, record.runId, runGit, knownRunIds);
  await cleanupTemporarySliceRefs(commonDir, record.runId, runGit);
  await removeStaleCandidateAnchor(commonDir, record.runId);
  await store.writeResult({
    resultVersion: "1",
    runId: record.runId,
    status: "cancelled",
    failure: "cancelled",
    summary: "Interrupted attempt was cancelled during startup recovery.",
    producerSummary: null,
    candidate: null,
    requestedVerification: [],
    executedVerification: [],
    unresolvedIssues: ["attempt-interrupted-before-terminal-result"],
    evidence: {
      recovery: "startup-stale-run",
      originalStartedAt: record.startedAt,
    },
    logsRef,
    producerId: null,
    producerVersion: null,
    producerModel: null,
    durationMs: 0,
    sessionId: null,
  });
  return "recovered";
}

export function runClaimsWorktree(runId: string, managedId: string): boolean {
  // Worktree phase names are intentionally open-ended: adding a new trusted
  // phase must not make recovery delete it merely because this scanner's enum
  // was not updated. Run IDs are safe, collision-resistant identifiers, and
  // each supported namespace uses an explicit boundary after the full ID.
  return managedId === runId
    || managedId.startsWith(`${runId}-`)
    || managedId === `baseline-${runId}`
    || managedId.startsWith(`baseline-${runId}-`)
    || managedId === `verify-${runId}`
    || managedId.startsWith(`verify-${runId}-`);
}
