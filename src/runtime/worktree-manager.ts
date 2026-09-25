import { randomUUID } from "node:crypto";
import { lstat, mkdir, readdir, realpath, rename, rmdir } from "node:fs/promises";
import path from "node:path";
import type { CheckoutLock, PlatformServices } from "../platform/platform-services.js";
import {
  emptyBoundDirectory,
  removeBoundEmptyDirectory,
  verifyBoundDirectoryCleanupSupport,
} from "../platform/bound-directory-cleanup.js";
import { getPlatformServices } from "../platform/select-platform.js";
import { PlatformSafety } from "../platform/platform-safety.js";
import { boundedRedactedDiagnostic, redact } from "./redaction.js";
import { resolveStateDir } from "./state-dir.js";
import {
  isManagedWorktreeRoot,
  prepareManagedWorktreeRoot as prepareCheckoutWorktreeRoot,
  repositoryNamespaceRoot,
} from "./managed-worktree-root.js";
import {
  coordinateWorktreeRemoval,
  type StagedWorktreeRegistration,
} from "./worktree-removal-coordinator.js";
import {
  assertNoPendingWorktreeRemovalForRepository,
  persistWorktreeRemovalManifest,
  removeWorktreeRemovalManifest,
  replaceWorktreeRemovalManifest,
  verifyWorktreeRemovalManifestStorage,
  type WorktreeRemovalManifest,
} from "./worktree-removal-manifest.js";
import {
  ensurePrivateDirectory,
  syncDirectoryMetadata,
  syncDirectoryTreeMetadata,
} from "../platform/durable-directory.js";
import { RuntimeError, errorCode } from "../util/errors.js";
import { logger } from "../util/logger.js";
import { platformPathsEqual } from "../util/platform-path.js";
import { readStableRegularFile } from "../util/stable-file.js";
import {
  git,
  type GitResult,
  pinnedWorktreeGitDirectory,
  pinWorktreeGitDirectory,
  unpinWorktreeGitDirectory,
} from "../git/git-exec.js";
import { gitNulRecords, gitPathOutput } from "../git/git-output.js";
import {
  canonicalizeWorktreePath,
  findWorktreeRegistration,
} from "../git/worktree-registration.js";

const MAX_DIAGNOSTIC_LENGTH = 2_000;
// A Producer's test children can briefly hold the worktree open after the
// process tree is terminated, which is not a Windows-only condition — one such
// race cost a whole slice result and left an orphan directory behind.
const REMOVE_ATTEMPTS = 5;
const REMOVE_RETRY_DELAY_MS = 250;
const SAFE_MANAGED_ID = /^[a-z0-9][a-z0-9._-]*$/;
const SAFE_QUARANTINE_TOKEN = /^[a-z0-9][a-z0-9-]{0,127}$/i;
export const WORKTREE_REGISTRATION_QUARANTINE_DIRECTORY = "claude-architect-quarantine";

export interface WorktreeManagerDependencies {
  git?: typeof git;
  delay?: (milliseconds: number) => Promise<void>;
  rename?: typeof rename;
  rmdir?: typeof rmdir;
  processSupervisor?: PlatformServices;
  syncDirectory?: (directory: string) => Promise<void>;
  uuid?: () => string;
  verifyRemovalStorage?: () => Promise<void>;
  /** Caller-owned repository lease held for this manager's complete operation. */
  borrowedCheckoutLease?: CheckoutLock;
}

export interface ManagedWorktreeDirectoryIdentity {
  dev: bigint;
  ino: bigint;
  birthtimeNs: bigint;
}


function delay(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

async function syncChangedDirectories(
  dependencies: WorktreeManagerDependencies,
  ...directories: string[]
): Promise<void> {
  const syncDirectory = dependencies.syncDirectory ?? syncDirectoryMetadata;
  for (const directory of new Set(directories.map(value => path.resolve(value)))) {
    await syncDirectory(directory);
  }
}

function failure(action: string, result: GitResult): RuntimeError {
  const output = (result.stderr || result.stdout).trim();
  const diagnostic = output === ""
    ? ""
    : boundedRedactedDiagnostic(output, MAX_DIAGNOSTIC_LENGTH);
  return new RuntimeError(`${action} failed${diagnostic ? `: ${diagnostic}` : ""}`);
}

function sameDirectoryIdentity(
  left: ManagedWorktreeDirectoryIdentity,
  right: ManagedWorktreeDirectoryIdentity,
): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.birthtimeNs === right.birthtimeNs;
}

async function quarantinedIdentityRemainsNamed(
  quarantineRoot: string,
  expectedIdentity: ManagedWorktreeDirectoryIdentity,
): Promise<boolean> {
  const entries = await readdir(quarantineRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const observed = await managedWorktreeDirectoryIdentity(path.join(quarantineRoot, entry.name));
    if (observed !== null && sameDirectoryIdentity(observed, expectedIdentity)) return true;
  }
  return false;
}

export async function managedWorktreeDirectoryIdentity(
  directory: string,
): Promise<ManagedWorktreeDirectoryIdentity | null> {
  try {
    const metadata = await lstat(directory, { bigint: true });
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new RuntimeError("managed worktree must be a plain directory");
    }
    if (metadata.birthtimeNs <= 0n) {
      throw new RuntimeError("managed worktree filesystem lacks stable birth-time identity");
    }
    return {
      dev: metadata.dev,
      ino: metadata.ino,
      birthtimeNs: metadata.birthtimeNs,
    };
  } catch (error) {
    if (errorCode(error) === "ENOENT") return null;
    throw error;
  }
}

async function requiredDirectoryIdentity(
  directory: string,
  description: string,
): Promise<ManagedWorktreeDirectoryIdentity> {
  const identity = await managedWorktreeDirectoryIdentity(directory);
  if (identity === null) throw new RuntimeError(`${description} disappeared`);
  return identity;
}

async function assertDirectoryIdentity(
  directory: string,
  expected: ManagedWorktreeDirectoryIdentity,
  description: string,
): Promise<void> {
  const observed = await managedWorktreeDirectoryIdentity(directory);
  if (observed === null || !sameDirectoryIdentity(observed, expected)) {
    throw new RuntimeError(`${description} identity changed`);
  }
}

export async function removeQuarantinedDirectory(
  quarantineRoot: string,
  quarantinePath: string,
  expectedIdentity: ManagedWorktreeDirectoryIdentity,
  options: WorktreeManagerDependencies,
): Promise<void> {
  const rootIdentity = await managedWorktreeDirectoryIdentity(quarantineRoot);
  const initialIdentity = await managedWorktreeDirectoryIdentity(quarantinePath);
  if (rootIdentity === null
    || initialIdentity === null
    || !sameDirectoryIdentity(initialIdentity, expectedIdentity)) {
    throw new RuntimeError("managed worktree identity changed before removal");
  }
  // The child binds its cwd to the validated directory inode before deleting
  // entries relative to it. If the quarantine pathname is replaced, the child
  // either rejects the identity before touching bytes or remains bound to the
  // original inode. The parent then uses non-recursive rmdir, which cannot
  // recursively delete replacement contents in the final check/use window.
  await emptyBoundDirectory(
    quarantinePath,
    expectedIdentity,
    options.processSupervisor ?? getPlatformServices(),
  );
  const emptiedIdentity = await managedWorktreeDirectoryIdentity(quarantinePath);
  const emptiedRootIdentity = await managedWorktreeDirectoryIdentity(quarantineRoot);
  if (emptiedIdentity === null
    || !sameDirectoryIdentity(emptiedIdentity, expectedIdentity)
    || emptiedRootIdentity === null
    || !sameDirectoryIdentity(emptiedRootIdentity, rootIdentity)) {
    throw new RuntimeError("managed worktree identity changed after emptying");
  }
  await removeBoundEmptyDirectory(
    quarantinePath,
    expectedIdentity,
    options.processSupervisor ?? getPlatformServices(),
    options.rmdir,
  );
  await syncChangedDirectories(options, quarantineRoot);
  const removedIdentity = await managedWorktreeDirectoryIdentity(quarantinePath);
  const remainingRootIdentity = await managedWorktreeDirectoryIdentity(quarantineRoot);
  if (removedIdentity !== null
    || remainingRootIdentity === null
    || !sameDirectoryIdentity(remainingRootIdentity, rootIdentity)
    || await quarantinedIdentityRemainsNamed(quarantineRoot, expectedIdentity)) {
    throw new RuntimeError("managed worktree removal did not settle safely");
  }
}

async function managedPath(worktreePath: string): Promise<{ root: string; target: string }> {
  const target = path.resolve(worktreePath);
  let canonicalTarget: string;
  try {
    canonicalTarget = await canonicalizeWorktreePath(target, true);
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
    const targetParent = path.dirname(target);
    canonicalTarget = path.join(
      await realpath(path.dirname(targetParent)),
      path.basename(targetParent),
      path.basename(target),
    );
  }
  const canonicalRoot = path.dirname(canonicalTarget);
  if (platformPathsEqual(canonicalTarget, canonicalRoot)
    || !await isManagedWorktreeRoot(canonicalRoot)) {
    throw new RuntimeError("refusing to remove unmanaged worktree path");
  }
  return { root: canonicalRoot, target: canonicalTarget };
}

type QuarantineRemovalOptions = WorktreeManagerDependencies & {
  expectedIdentity?: ManagedWorktreeDirectoryIdentity;
  beforeRemoval?: () => Promise<void>;
  afterQuarantine?: () => Promise<void>;
};

type DirectoryQuarantineOptions = QuarantineRemovalOptions & {
  quarantineRoot?: string;
  preserveQuarantine?: boolean;
};

/**
 * Move a proven directory to an unpredictable sibling before deleting it. A
 * pathname substitution can therefore move an unexpected inode, but the
 * post-rename identity check preserves it instead of recursively deleting it.
 */
async function removeDirectoryByQuarantine(
  root: string,
  target: string,
  quarantineLabel: string,
  options: DirectoryQuarantineOptions = {},
): Promise<boolean> {
  const rootIdentity = await managedWorktreeDirectoryIdentity(root);
  if (rootIdentity === null) throw new RuntimeError("managed worktree root disappeared");
  const quarantineRoot = options.quarantineRoot ?? root;
  const quarantineRootIdentity = await managedWorktreeDirectoryIdentity(quarantineRoot);
  if (quarantineRootIdentity === null) {
    throw new RuntimeError("managed worktree quarantine root disappeared");
  }
  const observedIdentity = await managedWorktreeDirectoryIdentity(target);
  if (observedIdentity === null) return false;
  const expectedIdentity = options.expectedIdentity ?? observedIdentity;
  if (!sameDirectoryIdentity(observedIdentity, expectedIdentity)) {
    throw new RuntimeError("managed worktree directory identity changed before quarantine");
  }

  const quarantineToken = (options.uuid ?? randomUUID)();
  if (!SAFE_QUARANTINE_TOKEN.test(quarantineToken)) {
    throw new RuntimeError("invalid managed worktree quarantine token");
  }
  const quarantinePath = path.join(
    quarantineRoot,
    `.remove-${quarantineLabel}-${quarantineToken}`,
  );
  if (path.dirname(quarantinePath) !== quarantineRoot) {
    throw new RuntimeError("managed worktree quarantine path escaped its root");
  }
  const move = options.rename ?? rename;
  const wait = options.delay ?? delay;
  let moveError: unknown;
  let moved = false;
  for (let attempt = 1; attempt <= REMOVE_ATTEMPTS; attempt += 1) {
    try {
      if (await managedWorktreeDirectoryIdentity(quarantinePath) !== null) {
        throw new RuntimeError("managed worktree quarantine path already exists");
      }
      await move(target, quarantinePath);
      moved = true;
      break;
    } catch (error) {
      moveError = error;
      if (attempt < REMOVE_ATTEMPTS) await wait(REMOVE_RETRY_DELAY_MS);
    }
  }
  if (!moved) {
    throw new RuntimeError("managed worktree could not be quarantined", { cause: moveError });
  }

  const quarantinedIdentity = await managedWorktreeDirectoryIdentity(quarantinePath);
  const settledRootIdentity = await managedWorktreeDirectoryIdentity(root);
  const settledQuarantineRootIdentity = await managedWorktreeDirectoryIdentity(quarantineRoot);
  if (quarantinedIdentity === null
    || !sameDirectoryIdentity(quarantinedIdentity, expectedIdentity)
    || settledRootIdentity === null
    || !sameDirectoryIdentity(settledRootIdentity, rootIdentity)
    || settledQuarantineRootIdentity === null
    || !sameDirectoryIdentity(settledQuarantineRootIdentity, quarantineRootIdentity)) {
    throw new RuntimeError("managed worktree identity changed during quarantine");
  }
  const rollbackQuarantine = async (
    operationError: unknown,
    message: string,
  ): Promise<never> => {
    try {
      const rollbackIdentity = await managedWorktreeDirectoryIdentity(quarantinePath);
      const rollbackRootIdentity = await managedWorktreeDirectoryIdentity(root);
      const rollbackQuarantineRootIdentity = await managedWorktreeDirectoryIdentity(quarantineRoot);
      if (rollbackIdentity === null
        || !sameDirectoryIdentity(rollbackIdentity, expectedIdentity)
        || rollbackRootIdentity === null
        || !sameDirectoryIdentity(rollbackRootIdentity, rootIdentity)
        || rollbackQuarantineRootIdentity === null
        || !sameDirectoryIdentity(rollbackQuarantineRootIdentity, quarantineRootIdentity)
        || await managedWorktreeDirectoryIdentity(target) !== null) {
        throw new RuntimeError("managed worktree quarantine rollback is unsafe");
      }
      await move(quarantinePath, target);
      await syncChangedDirectories(options, root, quarantineRoot);
      const restoredIdentity = await managedWorktreeDirectoryIdentity(target);
      const restoredRootIdentity = await managedWorktreeDirectoryIdentity(root);
      const restoredQuarantineRootIdentity = await managedWorktreeDirectoryIdentity(quarantineRoot);
      if (restoredIdentity === null
        || !sameDirectoryIdentity(restoredIdentity, expectedIdentity)
        || restoredRootIdentity === null
        || !sameDirectoryIdentity(restoredRootIdentity, rootIdentity)
        || restoredQuarantineRootIdentity === null
        || !sameDirectoryIdentity(restoredQuarantineRootIdentity, quarantineRootIdentity)) {
        throw new RuntimeError("managed worktree quarantine rollback changed identity");
      }
    } catch (rollbackError) {
      throw new AggregateError([operationError, rollbackError], message);
    }
    throw operationError;
  };

  try {
    await options.afterQuarantine?.();
  } catch (publicationError) {
    return await rollbackQuarantine(
      publicationError,
      "managed worktree removal publication failed and quarantine rollback did not complete",
    );
  }
  await syncChangedDirectories(options, root, quarantineRoot);

  // This callback performs repository metadata cleanup while the directory is
  // absent from its registered pathname and while the caller still owns the
  // checkout lease. Restore the same inode when metadata cleanup fails so the
  // registration does not become a dangling, pathless leak.
  try {
    await options.beforeRemoval?.();
  } catch (operationError) {
    return await rollbackQuarantine(
      operationError,
      "managed worktree metadata cleanup failed and quarantine rollback did not complete",
    );
  }

  if (options.preserveQuarantine === true) return true;

  const finalRootIdentity = await managedWorktreeDirectoryIdentity(root);
  const finalQuarantineRootIdentity = await managedWorktreeDirectoryIdentity(quarantineRoot);
  if (finalRootIdentity === null
    || !sameDirectoryIdentity(finalRootIdentity, rootIdentity)
    || finalQuarantineRootIdentity === null
    || !sameDirectoryIdentity(finalQuarantineRootIdentity, quarantineRootIdentity)) {
    throw new RuntimeError("managed worktree root identity changed before removal");
  }
  await removeQuarantinedDirectory(
    quarantineRoot,
    quarantinePath,
    expectedIdentity,
    options,
  );
  const [remainingRootIdentity, replacementIdentity] = await Promise.all([
    managedWorktreeDirectoryIdentity(root),
    managedWorktreeDirectoryIdentity(target),
  ]);
  if (remainingRootIdentity === null
    || !sameDirectoryIdentity(remainingRootIdentity, rootIdentity)
    || replacementIdentity !== null) {
    throw new RuntimeError("managed worktree root or target changed after removal");
  }
  return true;
}

export async function removeManagedWorktreeDirectory(
  worktreePath: string,
  options: QuarantineRemovalOptions = {},
): Promise<boolean> {
  const { root, target } = await managedPath(worktreePath);
  return await removeDirectoryByQuarantine(
    root,
    target,
    path.basename(target),
    options,
  );
}

async function isRegisteredWorktree(
  repoRoot: string,
  worktreePath: string,
  runGit: typeof git,
  allowMissing = false,
): Promise<boolean> {
  const listed = await runGit(repoRoot, ["worktree", "list", "--porcelain", "-z"]);
  if (listed.exitCode !== 0
    || listed.truncated?.stdout === true
    || listed.truncated?.stderr === true) {
    throw failure("git worktree list", listed);
  }
  return await findWorktreeRegistration(
    gitNulRecords(listed.stdout, "Git worktree list"),
    worktreePath,
    allowMissing,
  ) !== -1;
}

interface WorktreeRegistrationDirectory {
  commonDir: string;
  root: string;
  path: string;
  identity: ManagedWorktreeDirectoryIdentity;
}

async function boundPlainChildDirectory(
  root: string,
  candidate: string,
  description: string,
): Promise<{ path: string; identity: ManagedWorktreeDirectoryIdentity }> {
  const resolvedCandidate = path.resolve(candidate);
  if (!path.isAbsolute(candidate)
    || !platformPathsEqual(path.dirname(resolvedCandidate), root)) {
    throw new RuntimeError(`${description} escaped its root`);
  }
  const before = await lstat(resolvedCandidate, { bigint: true });
  if (!before.isDirectory() || before.isSymbolicLink() || before.birthtimeNs <= 0n) {
    throw new RuntimeError(`${description} is not a stable plain directory`);
  }
  const canonical = await realpath(resolvedCandidate);
  if (!platformPathsEqual(canonical, resolvedCandidate)
    || !platformPathsEqual(path.dirname(canonical), root)) {
    throw new RuntimeError(`${description} changed identity during canonicalization`);
  }
  const after = await lstat(resolvedCandidate, { bigint: true });
  if (!after.isDirectory()
    || after.isSymbolicLink()
    || after.dev !== before.dev
    || after.ino !== before.ino
    || after.birthtimeNs <= 0n
    || after.birthtimeNs !== before.birthtimeNs) {
    throw new RuntimeError(`${description} changed identity during validation`);
  }
  return {
    path: canonical,
    identity: {
      dev: after.dev,
      ino: after.ino,
      birthtimeNs: after.birthtimeNs,
    },
  };
}

async function worktreeMarkerRegistrationPath(
  worktreePath: string,
): Promise<string | null> {
  let contents: Buffer | null;
  try {
    contents = await readStableRegularFile(path.join(worktreePath, ".git"), 32_768n);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return null;
    throw error;
  }
  if (contents === null) return null;
  const marker = gitPathOutput(contents.toString("utf8"), "managed worktree marker");
  if (!marker.startsWith("gitdir: ")) {
    throw new RuntimeError("managed worktree marker is malformed");
  }
  const registrationPath = marker.slice("gitdir: ".length);
  if (!path.isAbsolute(registrationPath)) {
    throw new RuntimeError("managed worktree marker registration is not absolute");
  }
  return path.resolve(registrationPath);
}

async function worktreeRegistrationDirectory(
  repoRoot: string,
  worktreePath: string,
  runGit: typeof git,
): Promise<WorktreeRegistrationDirectory> {
  // A pinned worktree's registration was proven before any Producer ran; its
  // `.git` pointer is Producer-writable and may be missing or rewritten.
  const pinned = pinnedWorktreeGitDirectory(worktreePath);
  const markerRegistrationPath = pinned === undefined
    ? await worktreeMarkerRegistrationPath(worktreePath)
    : path.resolve(pinned.gitDir);
  const commonResult = await runGit(repoRoot, [
    "rev-parse", "--path-format=absolute", "--git-common-dir",
  ]);
  if (commonResult.exitCode !== 0
    || commonResult.truncated?.stdout === true
    || commonResult.truncated?.stderr === true) {
    throw failure("resolve Git common directory", commonResult);
  }
  const gitDirResult = await runGit(worktreePath, [
    "rev-parse", "--path-format=absolute", "--git-dir",
  ]);
  if (gitDirResult.exitCode !== 0
    || gitDirResult.truncated?.stdout === true
    || gitDirResult.truncated?.stderr === true) {
    const registrationPath = await discoverStaleWorktreeRegistration(
      repoRoot,
      worktreePath,
      runGit,
      markerRegistrationPath,
    );
    return await staleWorktreeRegistrationDirectory(
      repoRoot,
      worktreePath,
      registrationPath,
      null,
      runGit,
      "present",
    );
  }
  const reportedCommonDir = gitPathOutput(
    commonResult.stdout,
    "worktree registration common directory",
  );
  const reportedAdministrativePath = gitPathOutput(
    gitDirResult.stdout,
    "worktree administrative directory",
  );
  if (!path.isAbsolute(reportedCommonDir)
    || !path.isAbsolute(reportedAdministrativePath)) {
    throw new RuntimeError("worktree registration lookup returned a non-absolute path");
  }
  const commonDir = await realpath(reportedCommonDir);
  const expectedAdministrativeRoot = path.join(commonDir, "worktrees");
  const administrativeRoot = await realpath(expectedAdministrativeRoot);
  if (!platformPathsEqual(administrativeRoot, expectedAdministrativeRoot)) {
    throw new RuntimeError("worktree administrative root escaped its repository");
  }
  if (markerRegistrationPath === null
    || !platformPathsEqual(path.resolve(reportedAdministrativePath), markerRegistrationPath)) {
    throw new RuntimeError("worktree marker names a different administrative directory");
  }
  const administrative = await boundPlainChildDirectory(
    administrativeRoot,
    markerRegistrationPath,
    "worktree administrative directory",
  );

  const contents = await readStableRegularFile(
    path.join(administrative.path, "gitdir"),
    32_768n,
  );
  if (contents === null) {
    throw new RuntimeError("worktree registration backlink is not a stable regular file");
  }
  const backlink = gitPathOutput(
    contents.toString("utf8"),
    "worktree registration backlink",
  );
  const expectedBacklink = pinned === undefined
    ? await realpath(path.join(worktreePath, ".git"))
    : path.join(await canonicalizeWorktreePath(worktreePath, true), ".git");
  const actualBacklink = pinned === undefined
    ? await realpath(backlink)
    : path.join(await canonicalizeWorktreePath(path.dirname(backlink), true), ".git");
  if (!path.isAbsolute(backlink)
    || path.basename(backlink) !== ".git"
    || !platformPathsEqual(actualBacklink, expectedBacklink)) {
    throw new RuntimeError("worktree registration backlink does not match the managed path");
  }
  return {
    commonDir,
    root: administrativeRoot,
    path: administrative.path,
    identity: administrative.identity,
  };
}

async function registrationQuarantineRoot(
  commonDir: string,
  dependencies: WorktreeManagerDependencies,
): Promise<string> {
  const quarantineRoot = path.join(commonDir, WORKTREE_REGISTRATION_QUARANTINE_DIRECTORY);
  await ensurePrivateDirectory(quarantineRoot, {
    description: "worktree registration quarantine",
    migratePermissions: true,
    syncDirectory: dependencies.syncDirectory ?? syncDirectoryMetadata,
    ...(dependencies.processSupervisor === undefined
      ? {}
      : { platformServices: dependencies.processSupervisor }),
  });
  return quarantineRoot;
}

export async function restoreStagedRegistration(
  registrationRoot: string,
  registrationPath: string,
  quarantineRoot: string,
  quarantinePath: string,
  expectedIdentity: ManagedWorktreeDirectoryIdentity,
  expectedRegistrationRootIdentity: ManagedWorktreeDirectoryIdentity,
  expectedQuarantineRootIdentity: ManagedWorktreeDirectoryIdentity,
  dependencies: WorktreeManagerDependencies,
): Promise<void> {
  const registrationRootIdentity = await managedWorktreeDirectoryIdentity(registrationRoot);
  const quarantineRootIdentity = await managedWorktreeDirectoryIdentity(quarantineRoot);
  const sourceIdentity = await managedWorktreeDirectoryIdentity(quarantinePath);
  const destinationIdentity = await managedWorktreeDirectoryIdentity(registrationPath);
  if (registrationRootIdentity === null
    || !sameDirectoryIdentity(registrationRootIdentity, expectedRegistrationRootIdentity)
    || quarantineRootIdentity === null
    || !sameDirectoryIdentity(quarantineRootIdentity, expectedQuarantineRootIdentity)
    || sourceIdentity === null
    || !sameDirectoryIdentity(sourceIdentity, expectedIdentity)
    || destinationIdentity !== null) {
    throw new RuntimeError("staged worktree registration rollback is unsafe");
  }
  const move = dependencies.rename ?? rename;
  const wait = dependencies.delay ?? delay;
  let moveError: unknown;
  let restored = false;
  for (let attempt = 1; attempt <= REMOVE_ATTEMPTS; attempt += 1) {
    try {
      await move(quarantinePath, registrationPath);
      restored = true;
      break;
    } catch (error) {
      moveError = error;
      if (attempt < REMOVE_ATTEMPTS) await wait(REMOVE_RETRY_DELAY_MS);
    }
  }
  if (!restored) {
    throw new RuntimeError("staged worktree registration could not be restored", {
      cause: moveError,
    });
  }
  await syncChangedDirectories(dependencies, registrationRoot, quarantineRoot);
  const restoredIdentity = await managedWorktreeDirectoryIdentity(registrationPath);
  const settledRegistrationRoot = await managedWorktreeDirectoryIdentity(registrationRoot);
  const settledQuarantineRoot = await managedWorktreeDirectoryIdentity(quarantineRoot);
  if (restoredIdentity === null
    || !sameDirectoryIdentity(restoredIdentity, expectedIdentity)
    || await managedWorktreeDirectoryIdentity(quarantinePath) !== null
    || settledRegistrationRoot === null
    || !sameDirectoryIdentity(settledRegistrationRoot, expectedRegistrationRootIdentity)
    || settledQuarantineRoot === null
    || !sameDirectoryIdentity(settledQuarantineRoot, expectedQuarantineRootIdentity)) {
    throw new RuntimeError("staged worktree registration rollback changed identity");
  }
}

async function stageRegistrationDirectory(
  repoRoot: string,
  registration: WorktreeRegistrationDirectory,
  worktreePath: string,
  quarantineRoot: string,
  quarantinePath: string,
  transactionId: string,
  runGit: typeof git,
  dependencies: WorktreeManagerDependencies,
  allowMissingWorktree = false,
): Promise<StagedWorktreeRegistration> {
  const quarantineLabel = `registration-${path.basename(registration.path)}`;
  const [registrationRootIdentity, quarantineRootIdentity] = await Promise.all([
    requiredDirectoryIdentity(registration.root, "Git registration root"),
    requiredDirectoryIdentity(quarantineRoot, "Git registration quarantine root"),
  ]);
  try {
    const staged = await removeDirectoryByQuarantine(
      registration.root,
      registration.path,
      quarantineLabel,
      {
        ...dependencies,
        uuid: () => transactionId,
        expectedIdentity: registration.identity,
        quarantineRoot,
        preserveQuarantine: true,
        beforeRemoval: async () => {
          if (await isRegisteredWorktree(
            repoRoot,
            worktreePath,
            runGit,
            allowMissingWorktree,
          )) {
            throw new RuntimeError("targeted worktree registration remained visible");
          }
        },
      },
    );
    if (!staged) throw new RuntimeError("targeted worktree registration disappeared");
  } catch (stageError) {
    const originalIdentity = await managedWorktreeDirectoryIdentity(registration.path);
    const quarantineIdentity = await managedWorktreeDirectoryIdentity(quarantinePath);
    if (originalIdentity === null
      && quarantineIdentity !== null
      && sameDirectoryIdentity(quarantineIdentity, registration.identity)) {
      try {
        await restoreStagedRegistration(
          registration.root,
          registration.path,
          quarantineRoot,
          quarantinePath,
          registration.identity,
          registrationRootIdentity,
          quarantineRootIdentity,
          dependencies,
        );
      } catch (rollbackError) {
        throw new AggregateError(
          [stageError, rollbackError],
          "worktree registration staging failed and its rollback did not complete",
        );
      }
    }
    throw stageError;
  }
  return {
    async commit() {
      await Promise.all([
        assertDirectoryIdentity(
          registration.root,
          registrationRootIdentity,
          "Git registration root",
        ),
        assertDirectoryIdentity(
          quarantineRoot,
          quarantineRootIdentity,
          "Git registration quarantine root",
        ),
      ]);
      if (await managedWorktreeDirectoryIdentity(registration.path) !== null
        || await isRegisteredWorktree(repoRoot, worktreePath, runGit, true)) {
        throw new RuntimeError("staged worktree registration pathname reappeared before commit");
      }
      await removeQuarantinedDirectory(
        quarantineRoot,
        quarantinePath,
        registration.identity,
        dependencies,
      );
      if (await managedWorktreeDirectoryIdentity(registration.path) !== null) {
        throw new RuntimeError("staged worktree registration pathname reappeared during commit");
      }
      await assertDirectoryIdentity(
        registration.root,
        registrationRootIdentity,
        "Git registration root",
      );
    },
    async rollback() {
      await restoreStagedRegistration(
        registration.root,
        registration.path,
        quarantineRoot,
        quarantinePath,
        registration.identity,
        registrationRootIdentity,
        quarantineRootIdentity,
        dependencies,
      );
    },
  };
}

async function staleWorktreeRegistrationDirectory(
  repoRoot: string,
  worktreePath: string,
  worktreeGitDir: string,
  expectedBranchRef: string | null,
  runGit: typeof git,
  physicalState: "missing" | "present" = "missing",
): Promise<WorktreeRegistrationDirectory> {
  const commonResult = await runGit(repoRoot, [
    "rev-parse", "--path-format=absolute", "--git-common-dir",
  ]);
  if (commonResult.exitCode !== 0
    || commonResult.truncated?.stdout === true
    || commonResult.truncated?.stderr === true) {
    throw failure("resolve stale worktree common directory", commonResult);
  }
  const reportedCommonDir = gitPathOutput(
    commonResult.stdout,
    "stale worktree common directory",
  );
  if (!path.isAbsolute(reportedCommonDir) || !path.isAbsolute(worktreeGitDir)) {
    throw new RuntimeError("stale worktree registration paths must be absolute");
  }
  const commonDir = await realpath(reportedCommonDir);
  const expectedRegistrationRoot = path.join(commonDir, "worktrees");
  const registrationRoot = await realpath(expectedRegistrationRoot);
  if (!platformPathsEqual(registrationRoot, expectedRegistrationRoot)) {
    throw new RuntimeError("stale worktree administrative root escaped its repository");
  }
  const registration = await boundPlainChildDirectory(
    registrationRoot,
    worktreeGitDir,
    "stale worktree administrative directory",
  );
  const [gitdirContents, headContents] = await Promise.all([
    readStableRegularFile(path.join(registration.path, "gitdir"), 32_768n),
    readStableRegularFile(path.join(registration.path, "HEAD"), 32_768n),
  ]);
  if (gitdirContents === null || headContents === null) {
    throw new RuntimeError("stale worktree registration files are not stable");
  }
  const backlink = gitPathOutput(
    gitdirContents.toString("utf8"),
    "stale worktree registration backlink",
  );
  const head = gitPathOutput(headContents.toString("utf8"), "stale worktree HEAD");
  if (!path.isAbsolute(backlink)
    || path.basename(backlink) !== ".git"
    || (expectedBranchRef === null
      ? !(/^ref: refs\//u.test(head) || /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u.test(head))
      : head !== `ref: ${expectedBranchRef}`)) {
    throw new RuntimeError("stale worktree registration identity is inconsistent");
  }
  const { target } = await managedPath(worktreePath);
  const canonicalBacklinkWorktree = await canonicalizeWorktreePath(
    path.dirname(path.resolve(backlink)),
    true,
  );
  const canonicalExpectedWorktree = await canonicalizeWorktreePath(target, true);
  const physicalIdentity = await managedWorktreeDirectoryIdentity(target);
  if (!platformPathsEqual(canonicalBacklinkWorktree, canonicalExpectedWorktree)
    || (physicalState === "missing" ? physicalIdentity !== null : physicalIdentity === null)
    || !await isRegisteredWorktree(repoRoot, target, runGit, true)) {
    throw new RuntimeError("stale worktree registration does not match the missing managed path");
  }
  return {
    commonDir,
    root: registrationRoot,
    path: registration.path,
    identity: registration.identity,
  };
}

async function discoverStaleWorktreeRegistration(
  repoRoot: string,
  worktreePath: string,
  runGit: typeof git,
  expectedRegistrationPath: string | null = null,
): Promise<string> {
  const commonResult = await runGit(repoRoot, [
    "rev-parse", "--path-format=absolute", "--git-common-dir",
  ]);
  if (commonResult.exitCode !== 0
    || commonResult.truncated?.stdout === true
    || commonResult.truncated?.stderr === true) {
    throw failure("resolve missing worktree common directory", commonResult);
  }
  const reportedCommonDir = gitPathOutput(
    commonResult.stdout,
    "missing worktree common directory",
  );
  if (!path.isAbsolute(reportedCommonDir)) {
    throw new RuntimeError("missing worktree common directory is not absolute");
  }
  const commonDir = await realpath(reportedCommonDir);
  const expectedRegistrationRoot = path.join(commonDir, "worktrees");
  const registrationRoot = await realpath(expectedRegistrationRoot);
  if (!platformPathsEqual(registrationRoot, expectedRegistrationRoot)) {
    throw new RuntimeError("worktree administrative root escaped its repository");
  }
  const expectedWorktree = await canonicalizeWorktreePath(worktreePath, true);
  const matches: string[] = [];
  for (const entry of await readdir(registrationRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const registrationPath = path.join(registrationRoot, entry.name);
    if (expectedRegistrationPath !== null
      && !platformPathsEqual(registrationPath, expectedRegistrationPath)) {
      continue;
    }
    const contents = await readStableRegularFile(
      path.join(registrationPath, "gitdir"),
      32_768n,
    );
    if (contents === null) continue;
    let backlink: string;
    try {
      backlink = gitPathOutput(contents.toString("utf8"), "missing worktree backlink");
    } catch {
      continue;
    }
    if (!path.isAbsolute(backlink) || path.basename(backlink) !== ".git") continue;
    let candidateWorktree: string;
    try {
      candidateWorktree = await canonicalizeWorktreePath(path.dirname(backlink), true);
    } catch {
      continue;
    }
    if (platformPathsEqual(candidateWorktree, expectedWorktree)) {
      matches.push(await realpath(registrationPath));
    }
  }
  if (matches.length !== 1) {
    throw new RuntimeError("missing managed worktree registration is absent or ambiguous");
  }
  return matches[0]!;
}

export async function removeMissingRegisteredWorktree(
  repoRoot: string,
  worktreePath: string,
  dependencies: WorktreeManagerDependencies = {},
): Promise<void> {
  const runGit = dependencies.git ?? git;
  const registrationPath = await discoverStaleWorktreeRegistration(
    repoRoot,
    worktreePath,
    runGit,
  );
  await removeStaleWorktreeRegistration(
    repoRoot,
    worktreePath,
    registrationPath,
    null,
    dependencies,
  );
}

export async function removeStaleWorktreeRegistration(
  repoRoot: string,
  worktreePath: string,
  worktreeGitDir: string,
  expectedBranchRef: string | null,
  dependencies: WorktreeManagerDependencies = {},
): Promise<void> {
  const runGit = dependencies.git ?? git;
  const { root, target } = await managedPath(worktreePath);
  await ensurePrivateDirectory(root, {
    description: "managed worktree root",
    migratePermissions: true,
    syncDirectory: dependencies.syncDirectory ?? syncDirectoryMetadata,
    ...(dependencies.processSupervisor === undefined
      ? {}
      : { platformServices: dependencies.processSupervisor }),
  });
  const registration = await staleWorktreeRegistrationDirectory(
    repoRoot,
    target,
    worktreeGitDir,
    expectedBranchRef,
    runGit,
  );
  const transactionId = (dependencies.uuid ?? randomUUID)();
  if (!SAFE_QUARANTINE_TOKEN.test(transactionId)) {
    throw new RuntimeError("invalid stale worktree quarantine token");
  }
  const physicalQuarantinePath = path.join(
    root,
    `.remove-${path.basename(target)}-${transactionId}`,
  );
  const quarantineRoot = await registrationQuarantineRoot(
    registration.commonDir,
    dependencies,
  );
  const quarantinePath = path.join(
    quarantineRoot,
    `.remove-registration-${path.basename(registration.path)}-${transactionId}`,
  );
  const [commonDirIdentity, physicalRootIdentity, registrationRootIdentity,
    quarantineRootIdentity] = await Promise.all([
    requiredDirectoryIdentity(registration.commonDir, "Git common directory"),
    requiredDirectoryIdentity(root, "managed worktree root"),
    requiredDirectoryIdentity(registration.root, "Git registration root"),
    requiredDirectoryIdentity(quarantineRoot, "Git registration quarantine root"),
  ]);
  const assertRemovalRoots = async () => await Promise.all([
    assertDirectoryIdentity(registration.commonDir, commonDirIdentity, "Git common directory"),
    assertDirectoryIdentity(root, physicalRootIdentity, "managed worktree root"),
    assertDirectoryIdentity(registration.root, registrationRootIdentity, "Git registration root"),
    assertDirectoryIdentity(
      quarantineRoot,
      quarantineRootIdentity,
      "Git registration quarantine root",
    ),
  ]);
  await coordinateWorktreeRemoval({
    transaction: {
      transactionId,
      commonDir: registration.commonDir,
      commonDirDev: commonDirIdentity.dev.toString(),
      commonDirIno: commonDirIdentity.ino.toString(),
      commonDirBirthtimeNs: commonDirIdentity.birthtimeNs.toString(),
      physicalPresent: false,
      physicalPath: target,
      physicalQuarantinePath,
      physicalDev: "0",
      physicalIno: "0",
      physicalBirthtimeNs: "0",
      physicalRootDev: physicalRootIdentity.dev.toString(),
      physicalRootIno: physicalRootIdentity.ino.toString(),
      physicalRootBirthtimeNs: physicalRootIdentity.birthtimeNs.toString(),
      registrationRoot: registration.root,
      registrationRootDev: registrationRootIdentity.dev.toString(),
      registrationRootIno: registrationRootIdentity.ino.toString(),
      registrationRootBirthtimeNs: registrationRootIdentity.birthtimeNs.toString(),
      registrationPath: registration.path,
      quarantineRoot,
      quarantineRootDev: quarantineRootIdentity.dev.toString(),
      quarantineRootIno: quarantineRootIdentity.ino.toString(),
      quarantineRootBirthtimeNs: quarantineRootIdentity.birthtimeNs.toString(),
      quarantinePath,
      registrationDev: registration.identity.dev.toString(),
      registrationIno: registration.identity.ino.toString(),
      registrationBirthtimeNs: registration.identity.birthtimeNs.toString(),
    },
    stageRegistration: async () => {
      await assertRemovalRoots();
      return await stageRegistrationDirectory(
        repoRoot,
        registration,
        target,
        quarantineRoot,
        quarantinePath,
        transactionId,
        runGit,
        dependencies,
        true,
      );
    },
    stageFailureWasRolledBack: async () => {
      await assertRemovalRoots();
      await syncChangedDirectories(dependencies, registration.root, quarantineRoot);
      const restored = await managedWorktreeDirectoryIdentity(registration.path);
      return restored !== null
        && sameDirectoryIdentity(restored, registration.identity)
        && await managedWorktreeDirectoryIdentity(quarantinePath) === null;
    },
    removePhysical: async markRemovalStarted => {
      await assertRemovalRoots();
      if (await managedWorktreeDirectoryIdentity(target) !== null
        || await managedWorktreeDirectoryIdentity(physicalQuarantinePath) !== null) {
        throw new RuntimeError("stale worktree physical path reappeared during cleanup");
      }
      await markRemovalStarted();
    },
    physicalIsUnchanged: async () => {
      await assertRemovalRoots();
      return await managedWorktreeDirectoryIdentity(target) === null
        && await managedWorktreeDirectoryIdentity(physicalQuarantinePath) === null;
    },
  });
}

export async function removeRegisteredWorktree(
  repoRoot: string,
  worktreePath: string,
  dependencies: WorktreeManagerDependencies = {},
  expectedIdentity?: ManagedWorktreeDirectoryIdentity,
): Promise<void> {
  const runGit = dependencies.git ?? git;
  const observedIdentity = await managedWorktreeDirectoryIdentity(worktreePath);
  if (expectedIdentity !== undefined
    && (observedIdentity === null || !sameDirectoryIdentity(observedIdentity, expectedIdentity))) {
    throw new RuntimeError("managed worktree identity changed before registration removal");
  }
  const identity = expectedIdentity ?? observedIdentity;
  const registered = await isRegisteredWorktree(
    repoRoot,
    worktreePath,
    runGit,
    identity === null,
  );
  if (!registered) {
    if (identity === null) return;
    throw new RuntimeError("refusing to remove an unregistered managed directory");
  }
  if (identity === null) {
    await removeMissingRegisteredWorktree(repoRoot, worktreePath, dependencies);
    return;
  }
  const registration = await worktreeRegistrationDirectory(repoRoot, worktreePath, runGit);
  const settledIdentity = await managedWorktreeDirectoryIdentity(worktreePath);
  if (settledIdentity === null || !sameDirectoryIdentity(settledIdentity, identity)) {
    throw new RuntimeError("managed worktree identity changed before removal transaction");
  }

  // Never ask Git to recursively delete by the live registered pathname, and
  // never run repository-wide prune. Runtime-owned coordination durably stages
  // the exact registration before the physical pathname moves and recovers any
  // interruption on startup.
  const { root, target } = await managedPath(worktreePath);
  const transactionId = (dependencies.uuid ?? randomUUID)();
  if (!SAFE_QUARANTINE_TOKEN.test(transactionId)) {
    throw new RuntimeError("invalid physical worktree quarantine token");
  }
  const physicalQuarantinePath = path.join(
    root,
    `.remove-${path.basename(target)}-${transactionId}`,
  );
  const quarantineRoot = await registrationQuarantineRoot(
    registration.commonDir,
    dependencies,
  );
  const quarantinePath = path.join(
    quarantineRoot,
    `.remove-registration-${path.basename(registration.path)}-${transactionId}`,
  );
  const [commonDirIdentity, physicalRootIdentity, registrationRootIdentity,
    quarantineRootIdentity] = await Promise.all([
    requiredDirectoryIdentity(registration.commonDir, "Git common directory"),
    requiredDirectoryIdentity(root, "managed worktree root"),
    requiredDirectoryIdentity(registration.root, "Git registration root"),
    requiredDirectoryIdentity(quarantineRoot, "Git registration quarantine root"),
  ]);
  const assertRemovalRoots = async () => await Promise.all([
    assertDirectoryIdentity(registration.commonDir, commonDirIdentity, "Git common directory"),
    assertDirectoryIdentity(root, physicalRootIdentity, "managed worktree root"),
    assertDirectoryIdentity(registration.root, registrationRootIdentity, "Git registration root"),
    assertDirectoryIdentity(
      quarantineRoot,
      quarantineRootIdentity,
      "Git registration quarantine root",
    ),
  ]);
  await coordinateWorktreeRemoval({
    transaction: {
      transactionId,
      commonDir: registration.commonDir,
      commonDirDev: commonDirIdentity.dev.toString(),
      commonDirIno: commonDirIdentity.ino.toString(),
      commonDirBirthtimeNs: commonDirIdentity.birthtimeNs.toString(),
      physicalPresent: true,
      physicalPath: target,
      physicalQuarantinePath,
      physicalDev: identity.dev.toString(),
      physicalIno: identity.ino.toString(),
      physicalBirthtimeNs: identity.birthtimeNs.toString(),
      physicalRootDev: physicalRootIdentity.dev.toString(),
      physicalRootIno: physicalRootIdentity.ino.toString(),
      physicalRootBirthtimeNs: physicalRootIdentity.birthtimeNs.toString(),
      registrationRoot: registration.root,
      registrationRootDev: registrationRootIdentity.dev.toString(),
      registrationRootIno: registrationRootIdentity.ino.toString(),
      registrationRootBirthtimeNs: registrationRootIdentity.birthtimeNs.toString(),
      registrationPath: registration.path,
      quarantineRoot,
      quarantineRootDev: quarantineRootIdentity.dev.toString(),
      quarantineRootIno: quarantineRootIdentity.ino.toString(),
      quarantineRootBirthtimeNs: quarantineRootIdentity.birthtimeNs.toString(),
      quarantinePath,
      registrationDev: registration.identity.dev.toString(),
      registrationIno: registration.identity.ino.toString(),
      registrationBirthtimeNs: registration.identity.birthtimeNs.toString(),
    },
    stageRegistration: async () => {
      await assertRemovalRoots();
      return await stageRegistrationDirectory(
        repoRoot,
        registration,
        worktreePath,
        quarantineRoot,
        quarantinePath,
        transactionId,
        runGit,
        dependencies,
      );
    },
    stageFailureWasRolledBack: async () => {
      await assertRemovalRoots();
      await syncChangedDirectories(dependencies, registration.root, quarantineRoot);
      const restored = await managedWorktreeDirectoryIdentity(registration.path);
      return restored !== null
        && sameDirectoryIdentity(restored, registration.identity)
        && await managedWorktreeDirectoryIdentity(quarantinePath) === null;
    },
    removePhysical: async markRemovalStarted => {
      await assertRemovalRoots();
      const removed = await removeDirectoryByQuarantine(
        root,
        target,
        path.basename(target),
        {
          ...dependencies,
          uuid: () => transactionId,
          expectedIdentity: identity,
          afterQuarantine: markRemovalStarted,
        },
      );
      if (!removed) throw new RuntimeError("registered managed worktree disappeared during removal");
    },
    physicalIsUnchanged: async () => {
      await assertRemovalRoots();
      const physical = await managedWorktreeDirectoryIdentity(target);
      return physical !== null
        && sameDirectoryIdentity(physical, identity)
        && await managedWorktreeDirectoryIdentity(physicalQuarantinePath) === null;
    },
  });
}

class WorktreeRootChangedError extends RuntimeError {}

interface WorktreeCreationIntent {
  manifestPath: string;
  transactionId: string;
  physicalIdentity: ManagedWorktreeDirectoryIdentity;
}

export class WorktreeManager {
  constructor(
    private readonly repoRoot: string,
    private readonly runId: string,
    private readonly platformServices: Pick<PlatformServices, "os"> = getPlatformServices(),
    private readonly dependencies: WorktreeManagerDependencies = {},
  ) {}

  /** The repository this manager creates worktrees for. */
  get repositoryRoot(): string {
    return this.repoRoot;
  }

  private lockingPlatformServices(): PlatformServices {
    const supplied = this.platformServices as Partial<PlatformServices>;
    if (typeof supplied.acquireCheckoutLock === "function"
      && typeof supplied.canonicalizePath === "function") {
      return supplied as PlatformServices;
    }
    return this.dependencies.processSupervisor ?? getPlatformServices();
  }

  private async withCheckoutLease<T>(operation: (lease: CheckoutLock) => Promise<T>): Promise<T> {
    const platformServices = this.lockingPlatformServices();
    const borrowed = this.dependencies.borrowedCheckoutLease;
    if (borrowed !== undefined) {
      const canonical = await platformServices.canonicalizePath(this.repoRoot);
      const repositoryIdentity = canonical.gitCommonDir ?? canonical.canonical;
      if (borrowed.repositoryIdentity !== repositoryIdentity) {
        throw new RuntimeError("worktree manager checkout lease repository identity mismatch");
      }
      await assertNoPendingWorktreeRemovalForRepository(repositoryIdentity);
      return await operation(borrowed);
    }
    const safety = new PlatformSafety(platformServices);
    return await safety.withCheckoutLease(this.repoRoot, operation, {
      ...(this.runId === undefined ? {} : { runId: this.runId }),
    });
  }


  private namespaceRoot: string | undefined;

  private async managedRoot(): Promise<string> {
    // A read-only lookup of where the namespace lives; every mutating Git
    // call still goes through the injectable runner after validation.
    this.namespaceRoot ??= await repositoryNamespaceRoot(this.repoRoot, git);
    return this.namespaceRoot;
  }

  private managedWorktreePath(
    worktreesRoot: string,
  ): { worktreesRoot: string; worktreePath: string } {
    if (!SAFE_MANAGED_ID.test(this.runId)) {
      throw new RuntimeError("invalid worktree run id");
    }
    const worktreePath = path.resolve(worktreesRoot, this.runId);
    if (worktreePath === worktreesRoot || !worktreePath.startsWith(`${worktreesRoot}${path.sep}`)) {
      throw new RuntimeError("invalid worktree run id");
    }
    return { worktreesRoot, worktreePath };
  }

  private async prepareManagedWorktreeRoot() {
    await verifyBoundDirectoryCleanupSupport(this.lockingPlatformServices());
    const syncDirectory = this.dependencies.syncDirectory ?? syncDirectoryMetadata;
    // Removal manifests and root records live in the private state directory.
    await ensurePrivateDirectory(path.resolve(resolveStateDir()), {
      description: "runtime state root",
      migratePermissions: true,
      syncDirectory,
      ...(this.dependencies.processSupervisor === undefined
        ? {}
        : { platformServices: this.dependencies.processSupervisor }),
    });
    const { worktreesRoot, worktreePath } = this.managedWorktreePath(await this.managedRoot());
    const worktreesRootIdentity = await prepareCheckoutWorktreeRoot(worktreesRoot, {
      syncDirectory,
    });
    await (this.dependencies.verifyRemovalStorage
      ?? verifyWorktreeRemovalManifestStorage)();
    await assertDirectoryIdentity(worktreesRoot, worktreesRootIdentity, "managed worktree root");
    return {
      worktreesRoot,
      worktreePath,
      rootIdentity: worktreesRootIdentity,
    };
  }

  private async beginCreationIntent(
    worktreePath: string,
    worktreesRoot: string,
    rootIdentity: ManagedWorktreeDirectoryIdentity,
    runGit: typeof git,
  ): Promise<WorktreeCreationIntent> {
    const commonResult = await runGit(this.repoRoot, [
      "rev-parse", "--path-format=absolute", "--git-common-dir",
    ]);
    if (commonResult.exitCode !== 0
      || commonResult.truncated?.stdout === true
      || commonResult.truncated?.stderr === true) {
      throw failure("resolve worktree creation repository", commonResult);
    }
    const reportedCommonDir = gitPathOutput(
      commonResult.stdout,
      "worktree creation common directory",
    );
    if (!path.isAbsolute(reportedCommonDir)) {
      throw new RuntimeError("worktree creation common directory is not absolute");
    }
    const commonDir = await realpath(reportedCommonDir);
    const registrationRoot = path.join(commonDir, "worktrees");
    let registrationRootCreated = false;
    try {
      await mkdir(registrationRoot, { mode: 0o700 });
      registrationRootCreated = true;
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
    }
    if (registrationRootCreated) {
      await (this.dependencies.syncDirectory ?? syncDirectoryMetadata)(commonDir);
    }
    const registrationMetadata = await lstat(registrationRoot, { bigint: true });
    if (!registrationMetadata.isDirectory()
      || registrationMetadata.isSymbolicLink()
      || registrationMetadata.birthtimeNs <= 0n) {
      throw new RuntimeError("Git worktree registration root lacks stable identity");
    }
    const quarantineRoot = await registrationQuarantineRoot(
      commonDir,
      this.dependencies,
    );
    const [commonDirIdentity, registrationRootIdentity, quarantineRootIdentity] =
      await Promise.all([
        requiredDirectoryIdentity(commonDir, "Git common directory"),
        requiredDirectoryIdentity(registrationRoot, "Git registration root"),
        requiredDirectoryIdentity(quarantineRoot, "Git registration quarantine root"),
      ]);
    if (await managedWorktreeDirectoryIdentity(worktreePath) !== null) {
      throw new RuntimeError("git worktree add failed: managed worktree path already exists");
    }
    await this.lockingPlatformServices().assertDirectoryWriteIntegrity(
      registrationRoot,
      registrationRootIdentity,
    );
    const transactionId = (this.dependencies.uuid ?? randomUUID)();
    if (!SAFE_QUARANTINE_TOKEN.test(transactionId)) {
      throw new RuntimeError("invalid worktree creation transaction token");
    }
    const registrationPath = path.join(
      registrationRoot,
      `.creation-${transactionId}`,
    );
    const quarantinePath = path.join(
      quarantineRoot,
      `.remove-registration-creation-${transactionId}`,
    );
    const stagingPath = path.join(
      worktreesRoot,
      `.create-${path.basename(worktreePath)}-${transactionId}`,
    );
    let manifest: WorktreeRemovalManifest = {
      manifestVersion: "1",
      transactionId,
      phase: "creation-intent",
      commonDir,
      commonDirDev: commonDirIdentity.dev.toString(),
      commonDirIno: commonDirIdentity.ino.toString(),
      commonDirBirthtimeNs: commonDirIdentity.birthtimeNs.toString(),
      physicalPresent: false,
      physicalPath: worktreePath,
      physicalQuarantinePath: stagingPath,
      physicalDev: "0",
      physicalIno: "0",
      physicalBirthtimeNs: "0",
      physicalRootDev: rootIdentity.dev.toString(),
      physicalRootIno: rootIdentity.ino.toString(),
      physicalRootBirthtimeNs: rootIdentity.birthtimeNs.toString(),
      registrationRoot,
      registrationRootDev: registrationRootIdentity.dev.toString(),
      registrationRootIno: registrationRootIdentity.ino.toString(),
      registrationRootBirthtimeNs: registrationRootIdentity.birthtimeNs.toString(),
      registrationPath,
      quarantineRoot,
      quarantineRootDev: quarantineRootIdentity.dev.toString(),
      quarantineRootIno: quarantineRootIdentity.ino.toString(),
      quarantineRootBirthtimeNs: quarantineRootIdentity.birthtimeNs.toString(),
      quarantinePath,
      registrationDev: "0",
      registrationIno: "0",
      registrationBirthtimeNs: "0",
    };
    const manifestPath = await persistWorktreeRemovalManifest(manifest);
    await assertDirectoryIdentity(worktreesRoot, rootIdentity, "managed worktree root");
    await mkdir(stagingPath, { mode: 0o700 });
    await syncChangedDirectories(this.dependencies, worktreesRoot);
    const physicalIdentity = await requiredDirectoryIdentity(
      stagingPath,
      "worktree creation placeholder",
    );
    await assertDirectoryIdentity(worktreesRoot, rootIdentity, "managed worktree root");
    manifest = {
      ...manifest,
      physicalPresent: true,
      physicalDev: physicalIdentity.dev.toString(),
      physicalIno: physicalIdentity.ino.toString(),
      physicalBirthtimeNs: physicalIdentity.birthtimeNs.toString(),
    };
    await replaceWorktreeRemovalManifest(manifestPath, manifest);
    await assertDirectoryIdentity(worktreesRoot, rootIdentity, "managed worktree root");
    await (this.dependencies.rename ?? rename)(stagingPath, worktreePath);
    await syncChangedDirectories(this.dependencies, worktreesRoot);
    await Promise.all([
      assertDirectoryIdentity(worktreesRoot, rootIdentity, "managed worktree root"),
      assertDirectoryIdentity(worktreePath, physicalIdentity, "worktree creation placeholder"),
    ]);
    return { manifestPath, transactionId, physicalIdentity };
  }

  private async captureCreatedIdentity(
    worktreePath: string,
    worktreesRoot: string,
    expectedRootIdentity: ManagedWorktreeDirectoryIdentity,
  ): Promise<ManagedWorktreeDirectoryIdentity> {
    const settledRootIdentity = await managedWorktreeDirectoryIdentity(worktreesRoot);
    if (settledRootIdentity === null
      || !sameDirectoryIdentity(settledRootIdentity, expectedRootIdentity)) {
      throw new WorktreeRootChangedError(
        "managed worktree root identity changed during creation",
      );
    }
    const observed = await managedWorktreeDirectoryIdentity(worktreePath);
    if (observed === null) {
      const missingError = new RuntimeError("created worktree directory disappeared");
      try {
        await removeMissingRegisteredWorktree(this.repoRoot, worktreePath, this.dependencies);
      } catch (cleanupError) {
        throw new AggregateError(
          [missingError, cleanupError],
          "created worktree disappeared and its registration cleanup failed",
        );
      }
      throw missingError;
    }
    return observed;
  }

  private async failCreatedWorktree(
    worktreePath: string,
    identity: ManagedWorktreeDirectoryIdentity,
    primary: unknown,
  ): Promise<never> {
    try {
      await this.removeUnderLease(worktreePath, identity);
    } catch (cleanupError) {
      throw new AggregateError(
        [primary, cleanupError],
        "created worktree validation failed and cleanup did not complete",
      );
    }
    throw primary;
  }

  private async failCreationAttempt(
    creation: WorktreeCreationIntent,
    worktreePath: string,
    primary: unknown,
    runGit: typeof git,
  ): Promise<never> {
    try {
      if (await isRegisteredWorktree(this.repoRoot, worktreePath, runGit, true)) {
        await this.removeUnderLease(worktreePath, creation.physicalIdentity);
      } else {
        const removed = await removeManagedWorktreeDirectory(worktreePath, {
          ...this.dependencies,
          expectedIdentity: creation.physicalIdentity,
        });
        if (!removed) {
          throw new RuntimeError("failed worktree creation placeholder disappeared");
        }
      }
      await removeWorktreeRemovalManifest(creation.manifestPath, creation.transactionId);
    } catch (cleanupError) {
      throw new AggregateError(
        [primary, cleanupError],
        "git worktree creation failed and its durable placeholder cleanup did not complete",
      );
    }
    throw primary;
  }

  private async assertRegistrationIdentitySupport(runGit: typeof git): Promise<void> {
    const commonResult = await runGit(this.repoRoot, [
      "rev-parse", "--path-format=absolute", "--git-common-dir",
    ]);
    if (commonResult.exitCode !== 0
      || commonResult.truncated?.stdout === true
      || commonResult.truncated?.stderr === true) {
      throw failure("resolve worktree registration filesystem", commonResult);
    }
    const reported = gitPathOutput(
      commonResult.stdout,
      "worktree registration filesystem",
    );
    if (!path.isAbsolute(reported)) {
      throw new RuntimeError("worktree registration filesystem path is not absolute");
    }
    const commonDir = await realpath(reported);
    if (await managedWorktreeDirectoryIdentity(commonDir) === null) {
      throw new RuntimeError("worktree registration filesystem identity is unavailable");
    }
    const registrationRoot = path.join(commonDir, "worktrees");
    const existingRegistrationRoot = await managedWorktreeDirectoryIdentity(registrationRoot);
    if (existingRegistrationRoot !== null && existingRegistrationRoot.birthtimeNs <= 0n) {
      throw new RuntimeError("worktree registration root lacks stable identity");
    }
  }

  private async syncCreatedWorktree(
    worktreePath: string,
    worktreesRoot: string,
    rootIdentity: ManagedWorktreeDirectoryIdentity,
    identity: ManagedWorktreeDirectoryIdentity,
    runGit: typeof git,
  ): Promise<WorktreeRegistrationDirectory> {
    const registration = await worktreeRegistrationDirectory(
      this.repoRoot,
      worktreePath,
      runGit,
    );
    await syncDirectoryTreeMetadata(registration.path, {
      syncDirectory: this.dependencies.syncDirectory ?? syncDirectoryMetadata,
    });
    await syncChangedDirectories(
      this.dependencies,
      worktreesRoot,
      registration.root,
      registration.commonDir,
    );
    await Promise.all([
      assertDirectoryIdentity(worktreesRoot, rootIdentity, "managed worktree root"),
      assertDirectoryIdentity(worktreePath, identity, "created worktree"),
      assertDirectoryIdentity(
        registration.path,
        registration.identity,
        "created Git registration",
      ),
    ]);
    return registration;
  }

  private async finishCreatedWorktree(
    worktreePath: string,
    worktreesRoot: string,
    rootIdentity: ManagedWorktreeDirectoryIdentity,
    identity: ManagedWorktreeDirectoryIdentity,
  ) {
    const settled = await this.captureCreatedIdentity(
      worktreePath,
      worktreesRoot,
      rootIdentity,
    );
    if (!sameDirectoryIdentity(settled, identity)) {
      return await this.failCreatedWorktree(
        worktreePath,
        identity,
        new RuntimeError("created worktree identity changed during validation"),
      );
    }
    return {
      path: worktreePath,
      cleanup: () => this.remove(worktreePath, identity),
    };
  }

  private async createUnderLease(
    baseCommitOid: string,
  ): Promise<{ path: string; cleanup(): Promise<void> }> {
    const { worktreesRoot, worktreePath, rootIdentity } =
      await this.prepareManagedWorktreeRoot();
    const runGit = this.dependencies.git ?? git;
    await this.assertRegistrationIdentitySupport(runGit);
    const creation = await this.beginCreationIntent(
      worktreePath,
      worktreesRoot,
      rootIdentity,
      runGit,
    );
    let result: GitResult;
    try {
      result = await runGit(
        this.repoRoot,
        ["worktree", "add", "--detach", worktreePath, baseCommitOid],
      );
    } catch (error) {
      return await this.failCreationAttempt(creation, worktreePath, error, runGit);
    }
    if (result.exitCode !== 0) {
      return await this.failCreationAttempt(
        creation,
        worktreePath,
        failure("git worktree add", result),
        runGit,
      );
    }
    const identity = await this.captureCreatedIdentity(worktreePath, worktreesRoot, rootIdentity);
    if (!sameDirectoryIdentity(identity, creation.physicalIdentity)) {
      return await this.failCreatedWorktree(
        worktreePath,
        creation.physicalIdentity,
        new RuntimeError("created worktree replaced its durable placeholder"),
      );
    }
    let registration: WorktreeRegistrationDirectory;
    try {
      registration = await this.syncCreatedWorktree(
        worktreePath,
        worktreesRoot,
        rootIdentity,
        identity,
        runGit,
      );
      const head = await runGit(worktreePath, ["rev-parse", "--verify", "HEAD"]);
      const status = await runGit(worktreePath, [
        "status", "--porcelain=v1", "-z", "--untracked-files=all",
      ]);
      if (head.exitCode !== 0
        || head.truncated?.stdout === true
        || head.truncated?.stderr === true
        || head.stdout.trim() !== baseCommitOid
        || status.exitCode !== 0
        || status.truncated?.stdout === true
        || status.truncated?.stderr === true
        || status.stdout !== "") {
        throw new RuntimeError("created detached worktree identity did not match");
      }
    } catch (error) {
      return await this.failCreatedWorktree(worktreePath, identity, error);
    }
    const created = await this.finishCreatedWorktree(
      worktreePath,
      worktreesRoot,
      rootIdentity,
      identity,
    );
    pinWorktreeGitDirectory(worktreePath, {
      gitDir: registration.path,
      commonDir: registration.commonDir,
    });
    await removeWorktreeRemovalManifest(creation.manifestPath, creation.transactionId);
    return created;
  }

  private async createAttachedUnderLease(
    branch: string,
    expectedCommitOid: string,
  ): Promise<{ path: string; cleanup(): Promise<void> }> {
    if (branch === "" || branch.startsWith("-")) {
      throw new RuntimeError("refusing to create a worktree for an option-like branch name");
    }
    const { worktreesRoot, worktreePath, rootIdentity } =
      await this.prepareManagedWorktreeRoot();
    const runGit = this.dependencies.git ?? git;
    await this.assertRegistrationIdentitySupport(runGit);
    const creation = await this.beginCreationIntent(
      worktreePath,
      worktreesRoot,
      rootIdentity,
      runGit,
    );
    let result: GitResult;
    try {
      result = await runGit(
        this.repoRoot,
        ["worktree", "add", "--no-guess-remote", worktreePath, branch],
      );
    } catch (error) {
      return await this.failCreationAttempt(creation, worktreePath, error, runGit);
    }
    if (result.exitCode !== 0) {
      return await this.failCreationAttempt(
        creation,
        worktreePath,
        failure("git worktree add", result),
        runGit,
      );
    }
    const identity = await this.captureCreatedIdentity(worktreePath, worktreesRoot, rootIdentity);
    if (!sameDirectoryIdentity(identity, creation.physicalIdentity)) {
      return await this.failCreatedWorktree(
        worktreePath,
        creation.physicalIdentity,
        new RuntimeError("created worktree replaced its durable placeholder"),
      );
    }
    let registration: WorktreeRegistrationDirectory;
    try {
      registration = await this.syncCreatedWorktree(
        worktreePath,
        worktreesRoot,
        rootIdentity,
        identity,
        runGit,
      );
      const symbolicBranch = await runGit(worktreePath, [
        "symbolic-ref", "--quiet", "--short", "HEAD",
      ]);
      const head = await runGit(worktreePath, ["rev-parse", "--verify", "HEAD"]);
      if (symbolicBranch.exitCode !== 0
        || symbolicBranch.truncated?.stdout === true
        || symbolicBranch.truncated?.stderr === true
        || symbolicBranch.stdout.trim() !== branch
        || head.exitCode !== 0
        || head.truncated?.stdout === true
        || head.truncated?.stderr === true
        || head.stdout.trim() !== expectedCommitOid) {
        throw new RuntimeError("created attached worktree identity did not match");
      }
    } catch (error) {
      return await this.failCreatedWorktree(worktreePath, identity, error);
    }
    const created = await this.finishCreatedWorktree(
      worktreePath,
      worktreesRoot,
      rootIdentity,
      identity,
    );
    pinWorktreeGitDirectory(worktreePath, {
      gitDir: registration.path,
      commonDir: registration.commonDir,
    });
    await removeWorktreeRemovalManifest(creation.manifestPath, creation.transactionId);
    return created;
  }

  private async removeUnderLease(
    worktreePath: string,
    expectedIdentity?: ManagedWorktreeDirectoryIdentity,
  ): Promise<void> {
    const managedRoot = await this.managedRoot();
    const expectedWorktreePath = this.managedWorktreePath(managedRoot).worktreePath;
    const canonicalWorktreePath = await canonicalizeWorktreePath(worktreePath, true);
    let canonicalExpectedPath: string;
    try {
      canonicalExpectedPath = await canonicalizeWorktreePath(expectedWorktreePath, true);
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
      canonicalExpectedPath = path.join(managedRoot, path.basename(expectedWorktreePath));
    }
    if (!platformPathsEqual(canonicalWorktreePath, canonicalExpectedPath)) {
      throw new RuntimeError("refusing to remove unmanaged worktree path");
    }
    await removeRegisteredWorktree(
      this.repoRoot,
      expectedWorktreePath,
      this.dependencies,
      expectedIdentity,
    );
  }

  async create(baseCommitOid: string): Promise<{ path: string; cleanup(): Promise<void> }> {
    // Publish the private state namespace before lock creation can create it
    // implicitly without the parent-directory durability sync.
    await this.prepareManagedWorktreeRoot();
    return await this.withCheckoutLease(async () => await this.createUnderLease(baseCommitOid));
  }

  async createAttached(
    branch: string,
    expectedCommitOid: string,
  ): Promise<{ path: string; cleanup(): Promise<void> }> {
    await this.prepareManagedWorktreeRoot();
    return await this.withCheckoutLease(async () =>
      await this.createAttachedUnderLease(branch, expectedCommitOid));
  }

  async remove(
    worktreePath: string,
    expectedIdentity?: ManagedWorktreeDirectoryIdentity,
  ): Promise<void> {
    await this.withCheckoutLease(async () =>
      await this.removeUnderLease(worktreePath, expectedIdentity));
    unpinWorktreeGitDirectory(worktreePath);
  }
}

/**
 * A worktree handed out by {@link WorktreeManager.create}: a path plus the only
 * supported way to give it back.
 */
export interface ManagedWorktree {
  path: string;
  cleanup(): Promise<void>;
}

/**
 * Removal itself retries and falls back inside WorktreeManager. What matters
 * here is the disposition: a worktree that still cannot be removed is reported,
 * never substituted for the outcome of the work it held. The Producer's process
 * tree is already terminated by `supervise` before this runs.
 */
export async function cleanupWorktree(worktree: ManagedWorktree): Promise<unknown | null> {
  try {
    await worktree.cleanup();
    return null;
  } catch (error) {
    return error;
  }
}

/**
 * `git worktree add` mutates shared repository state, so concurrent slices are
 * given their worktrees one at a time even though their Producers then run in
 * parallel. Creation is a fraction of a slice's runtime; a lock collision costs
 * the whole attempt.
 *
 * The queue is per repository. One process-wide queue would make an unrelated
 * repository's creation wait behind this one — head-of-line blocking that buys
 * nothing, because the contention being avoided is over a single repository's
 * worktree state.
 */
const worktreeCreation = new Map<string, Promise<unknown>>();

function createWorktreeSerially(
  manager: WorktreeManager,
  commit: string,
): Promise<ManagedWorktree> {
  const key = manager.repositoryRoot;
  const created = (worktreeCreation.get(key) ?? Promise.resolve())
    .catch(() => {})
    .then(async () => await manager.create(commit));
  const settled = created.catch(() => {});
  worktreeCreation.set(key, settled);
  // Drop the entry once it is the tail, so a long-lived process does not
  // accumulate one resolved promise per repository it ever touched.
  void settled.then(() => {
    if (worktreeCreation.get(key) === settled) worktreeCreation.delete(key);
  });
  return created;
}

/**
 * Borrow a managed worktree for the duration of `run`. Every caller in the
 * pipeline goes through here so that creation serialization and the
 * cleanup-failure disposition have exactly one implementation.
 */
export async function withManagedWorktree<T>(args: {
  manager: WorktreeManager;
  commit: string;
  cleanupFailureMessage: string;
  run: (worktreePath: string) => Promise<T>;
  onCleanupFailure?: (error: unknown) => void;
}): Promise<T> {
  const worktree = await createWorktreeSerially(args.manager, args.commit);
  try {
    return await args.run(worktree.path);
  } finally {
    // A cleanup failure must stay visible without erasing the primary outcome.
    // Replacing a graceful slice timeout with a hard runtime error loses the
    // whole slice result and the salvage that goes with it.
    const cleanupError = await cleanupWorktree(worktree);
    if (cleanupError !== null) {
      logger.warn(args.cleanupFailureMessage, {
        error: redact(cleanupError instanceof Error ? cleanupError.message : String(cleanupError)),
      });
      args.onCleanupFailure?.(cleanupError);
    }
  }
}
