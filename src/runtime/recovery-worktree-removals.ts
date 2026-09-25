import { lstat, readdir, realpath, rename } from "node:fs/promises";
import path from "node:path";
import { gitPathOutput } from "../git/git-output.js";
import { canonicalizeWorktreePath } from "../git/worktree-registration.js";
import {
  managedWorktreeDirectoryIdentity,
  removeQuarantinedDirectory,
  restoreStagedRegistration,
  WORKTREE_REGISTRATION_QUARANTINE_DIRECTORY,
  type ManagedWorktreeDirectoryIdentity,
} from "./worktree-manager.js";
import { platformSafety } from "../platform/platform-safety.js";
import type { PlatformServices } from "../platform/platform-services.js";
import { getPlatformServices } from "../platform/select-platform.js";
import {
  emptyBoundDirectory,
  removeBoundEmptyDirectory,
} from "../platform/bound-directory-cleanup.js";
import {
  assertWindowsPrivateDirectory,
  syncDirectoryMetadata,
} from "../platform/durable-directory.js";
import { RuntimeError } from "../util/errors.js";
import { platformPathsEqual } from "../util/platform-path.js";
import { readStableRegularFile } from "../util/stable-file.js";
import { boundedRedactedDiagnostic } from "./redaction.js";
import { isManagedWorktreeRoot } from "./managed-worktree-root.js";
import {
  readPendingWorktreeRemovalManifests,
  readWorktreeRemovalManifest,
  removeWorktreeRemovalManifest,
  settleLinkedWorktreeRemovalManifest,
  type WorktreeRemovalManifest,
  type WorktreeRemovalManifestIssue,
} from "./worktree-removal-manifest.js";
import { sameManagedIdentity, stateRoot } from "./recovery-shared.js";

async function assertRegistrationBacklink(
  registrationPath: string,
  expectedPhysicalPath: string,
): Promise<void> {
  const backlink = await readStableRegularFile(path.join(registrationPath, "gitdir"), 32_768n);
  if (backlink === null) {
    throw new RuntimeError("worktree registration backlink is absent or unstable");
  }
  const reportedDotGit = gitPathOutput(
    backlink.toString("utf8"),
    "worktree registration backlink",
  );
  if (!path.isAbsolute(reportedDotGit) || path.basename(reportedDotGit) !== ".git") {
    throw new RuntimeError("worktree registration backlink is malformed");
  }
  const [reportedPhysicalPath, canonicalExpectedPhysicalPath] = await Promise.all([
    canonicalizeWorktreePath(path.dirname(reportedDotGit), true),
    canonicalizeWorktreePath(expectedPhysicalPath, true),
  ]);
  if (!platformPathsEqual(reportedPhysicalPath, canonicalExpectedPhysicalPath)) {
    throw new RuntimeError("worktree registration backlink names a different physical worktree");
  }
}

async function findCreationRegistration(
  registrationRoot: string,
  physicalPath: string,
): Promise<string | null> {
  const matches: string[] = [];
  for (const entry of await readdir(registrationRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const registrationPath = path.join(registrationRoot, entry.name);
    const contents = await readStableRegularFile(
      path.join(registrationPath, "gitdir"),
      32_768n,
    );
    if (contents === null) continue;
    let backlink: string;
    try {
      backlink = gitPathOutput(contents.toString("utf8"), "creation registration backlink");
    } catch {
      continue;
    }
    if (path.isAbsolute(backlink)
      && path.basename(backlink) === ".git"
      && platformPathsEqual(path.resolve(path.dirname(backlink)), physicalPath)) {
      matches.push(registrationPath);
    }
  }
  if (matches.length > 1) {
    throw new RuntimeError("worktree creation registration is ambiguous");
  }
  return matches[0] ?? null;
}

async function findCreationPhysicalRoot(
  expectedRoot: string,
  expected: ManagedWorktreeDirectoryIdentity,
): Promise<string | null> {
  const identity = await managedWorktreeDirectoryIdentity(expectedRoot);
  if (identity !== null && sameManagedIdentity(identity, expected)) return expectedRoot;
  // The root may have been renamed within its parent. Only the recorded
  // identity can select a sibling, so a same-named substitute never matches.
  const stateDirectory = path.dirname(expectedRoot);
  const matches: string[] = [];
  for (const entry of await readdir(stateDirectory, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const candidate = path.join(stateDirectory, entry.name);
    const candidateIdentity = await managedWorktreeDirectoryIdentity(candidate);
    if (candidateIdentity !== null && sameManagedIdentity(candidateIdentity, expected)) {
      matches.push(candidate);
    }
  }
  if (matches.length > 1) {
    throw new RuntimeError("worktree creation root identity is ambiguous");
  }
  return matches[0] ?? null;
}

async function findManagedChildByIdentity(
  root: string,
  expected: ManagedWorktreeDirectoryIdentity,
): Promise<string | null> {
  const matches: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const candidate = path.join(root, entry.name);
    const identity = await managedWorktreeDirectoryIdentity(candidate);
    if (identity !== null && sameManagedIdentity(identity, expected)) matches.push(candidate);
  }
  if (matches.length > 1) {
    throw new RuntimeError("managed directory identity appears at multiple paths");
  }
  return matches[0] ?? null;
}

async function recoverWorktreeCreationIntent(
  manifestPath: string,
  manifest: WorktreeRemovalManifest,
  platformServices: PlatformServices,
  syncDirectory: (directory: string) => Promise<void>,
  temporaryPath?: string,
  temporaryKind?: "linked",
): Promise<void> {
  const root = await stateRoot();
  if (root === null) throw new RuntimeError("runtime state root is unavailable");
  const expectedPhysicalRootPath = path.dirname(manifest.physicalPath);
  if (!await isManagedWorktreeRoot(expectedPhysicalRootPath)) {
    throw new RuntimeError("worktree creation intent names an unmanaged root");
  }
  if (!path.isAbsolute(manifest.physicalPath)
    || path.resolve(manifest.physicalPath) !== manifest.physicalPath
    || !platformPathsEqual(path.dirname(manifest.physicalPath), expectedPhysicalRootPath)
    || path.basename(manifest.physicalPath) === ""
    || !path.isAbsolute(manifest.physicalQuarantinePath)
    || path.resolve(manifest.physicalQuarantinePath) !== manifest.physicalQuarantinePath
    || !platformPathsEqual(
      path.dirname(manifest.physicalQuarantinePath),
      expectedPhysicalRootPath,
    )
    || path.basename(manifest.physicalQuarantinePath)
      !== `.create-${path.basename(manifest.physicalPath)}-${manifest.transactionId}`
    || !path.isAbsolute(manifest.commonDir)
    || !path.isAbsolute(manifest.registrationRoot)
    || !path.isAbsolute(manifest.quarantineRoot)
    || !path.isAbsolute(manifest.quarantinePath)
    || !platformPathsEqual(
      manifest.registrationRoot,
      path.join(manifest.commonDir, "worktrees"),
    )
    || !platformPathsEqual(path.dirname(manifest.quarantinePath), manifest.quarantineRoot)
    || path.basename(manifest.quarantinePath)
      !== `.remove-registration-creation-${manifest.transactionId}`) {
    throw new RuntimeError("worktree creation intent paths are inconsistent");
  }
  const expectedCommonDir = {
    dev: BigInt(manifest.commonDirDev),
    ino: BigInt(manifest.commonDirIno),
    birthtimeNs: BigInt(manifest.commonDirBirthtimeNs),
  };
  const expectedPhysicalRoot = {
    dev: BigInt(manifest.physicalRootDev),
    ino: BigInt(manifest.physicalRootIno),
    birthtimeNs: BigInt(manifest.physicalRootBirthtimeNs),
  };
  const expectedRegistrationRoot = {
    dev: BigInt(manifest.registrationRootDev),
    ino: BigInt(manifest.registrationRootIno),
    birthtimeNs: BigInt(manifest.registrationRootBirthtimeNs),
  };
  const expectedQuarantineRoot = {
    dev: BigInt(manifest.quarantineRootDev),
    ino: BigInt(manifest.quarantineRootIno),
    birthtimeNs: BigInt(manifest.quarantineRootBirthtimeNs),
  };
  const commonDir = await realpath(manifest.commonDir);
  const registrationRoot = await realpath(manifest.registrationRoot);
  const quarantineRoot = await realpath(manifest.quarantineRoot);
  const [commonIdentity, registrationRootIdentity, quarantineRootIdentity] =
    await Promise.all([
      managedWorktreeDirectoryIdentity(commonDir),
      managedWorktreeDirectoryIdentity(registrationRoot),
      managedWorktreeDirectoryIdentity(quarantineRoot),
    ]);
  if (!platformPathsEqual(commonDir, manifest.commonDir)
    || !platformPathsEqual(registrationRoot, manifest.registrationRoot)
    || !platformPathsEqual(quarantineRoot, manifest.quarantineRoot)
    || commonIdentity === null
    || !sameManagedIdentity(commonIdentity, expectedCommonDir)
    || registrationRootIdentity === null
    || !sameManagedIdentity(registrationRootIdentity, expectedRegistrationRoot)
    || quarantineRootIdentity === null
    || !sameManagedIdentity(quarantineRootIdentity, expectedQuarantineRoot)) {
    throw new RuntimeError("worktree creation intent repository identity changed");
  }

  await platformSafety.withRecoveryLease(commonDir, async (lease) => {
    if (!platformPathsEqual(lease.repositoryIdentity, commonDir)) {
      throw new RuntimeError("worktree creation recovery lease identity mismatch");
    }
    if (temporaryPath !== undefined && temporaryKind === "linked") {
      await settleLinkedWorktreeRemovalManifest(
        manifestPath,
        temporaryPath,
        manifest.transactionId,
      );
    }
    const lockedManifest = await readWorktreeRemovalManifest(
      manifestPath,
      manifest.transactionId,
    );
    if (lockedManifest === null
      || JSON.stringify(lockedManifest) !== JSON.stringify(manifest)) {
      throw new RuntimeError("worktree creation intent changed before recovery lease");
    }
    const physicalRoot = await findCreationPhysicalRoot(
      expectedPhysicalRootPath,
      expectedPhysicalRoot,
    );
    if (physicalRoot === null) {
      throw new RuntimeError("worktree creation root moved outside its managed namespace");
    }
    const expectedPhysical = manifest.physicalPresent
      ? {
        dev: BigInt(manifest.physicalDev),
        ino: BigInt(manifest.physicalIno),
        birthtimeNs: BigInt(manifest.physicalBirthtimeNs),
      }
      : null;
    const finalPhysicalPath = physicalRoot === null
      ? null
      : path.join(physicalRoot, path.basename(manifest.physicalPath));
    const stagedPhysicalPath = physicalRoot === null
      ? null
      : path.join(physicalRoot, path.basename(manifest.physicalQuarantinePath));
    const [finalPhysicalIdentity, stagedPhysicalIdentity] = await Promise.all([
      finalPhysicalPath === null
        ? null
        : managedWorktreeDirectoryIdentity(finalPhysicalPath),
      stagedPhysicalPath === null
        ? null
        : managedWorktreeDirectoryIdentity(stagedPhysicalPath),
    ]);
    if (finalPhysicalIdentity !== null && stagedPhysicalIdentity !== null) {
      throw new RuntimeError("worktree creation placeholder exists at two paths");
    }
    const physicalPath = finalPhysicalIdentity !== null
      ? finalPhysicalPath
      : stagedPhysicalIdentity !== null
        ? stagedPhysicalPath
        : null;
    const physicalIdentity = finalPhysicalIdentity ?? stagedPhysicalIdentity;
    if (expectedPhysical === null) {
      if (finalPhysicalIdentity !== null) {
        throw new RuntimeError("unbound final worktree creation path appeared");
      }
    } else if (physicalIdentity !== null
      && !sameManagedIdentity(physicalIdentity, expectedPhysical)) {
      throw new RuntimeError("worktree creation physical identity changed");
    }

    const activeRegistration = await findCreationRegistration(
      registrationRoot,
      manifest.physicalPath,
    );
    let quarantineIdentity = await managedWorktreeDirectoryIdentity(manifest.quarantinePath);
    if (activeRegistration !== null && quarantineIdentity !== null) {
      throw new RuntimeError("worktree creation registration exists at two paths");
    }
    if (expectedPhysical === null
      && (activeRegistration !== null || quarantineIdentity !== null)) {
      throw new RuntimeError("unbound worktree creation acquired a Git registration");
    }
    if (activeRegistration !== null) {
      const registrationIdentity = await managedWorktreeDirectoryIdentity(activeRegistration);
      if (registrationIdentity === null) {
        throw new RuntimeError("worktree creation registration disappeared");
      }
      await assertRegistrationBacklink(activeRegistration, manifest.physicalPath);
      await rename(activeRegistration, manifest.quarantinePath);
      await Promise.all([syncDirectory(registrationRoot), syncDirectory(quarantineRoot)]);
      if (await managedWorktreeDirectoryIdentity(activeRegistration) !== null) {
        throw new RuntimeError("worktree creation registration reappeared after staging");
      }
      quarantineIdentity = await managedWorktreeDirectoryIdentity(manifest.quarantinePath);
      if (quarantineIdentity === null
        || !sameManagedIdentity(quarantineIdentity, registrationIdentity)) {
        throw new RuntimeError("worktree creation registration changed during staging");
      }
    }
    if (quarantineIdentity !== null) {
      await assertRegistrationBacklink(manifest.quarantinePath, manifest.physicalPath);
    }

    const removalIdentity = expectedPhysical ?? stagedPhysicalIdentity;
    if (physicalPath !== null && physicalIdentity !== null && removalIdentity !== null) {
      if (expectedPhysical !== null) {
        await emptyBoundDirectory(physicalPath, removalIdentity, platformServices);
      }
      await removeBoundEmptyDirectory(physicalPath, removalIdentity, platformServices);
      await syncDirectory(physicalRoot);
      const settledRoot = await managedWorktreeDirectoryIdentity(physicalRoot!);
      if (settledRoot === null || !sameManagedIdentity(settledRoot, expectedPhysicalRoot)) {
        throw new RuntimeError("worktree creation root changed during recovery");
      }
    }
    if (quarantineIdentity !== null) {
      await removeQuarantinedDirectory(
        quarantineRoot,
        manifest.quarantinePath,
        quarantineIdentity,
        { processSupervisor: platformServices },
      );
    }
    await Promise.all([syncDirectory(registrationRoot), syncDirectory(quarantineRoot)]);
    await removeWorktreeRemovalManifest(manifestPath, manifest.transactionId);
  });
}


export async function recoverPendingWorktreeRemovals(
  platformServices: PlatformServices = getPlatformServices(),
  syncDirectory: (directory: string) => Promise<void> = syncDirectoryMetadata,
): Promise<WorktreeRemovalManifestIssue[]> {
  const { pending, issues } = await readPendingWorktreeRemovalManifests();
  for (const { manifestPath, manifest, temporaryPath, temporaryKind } of pending) {
    let recoveryError: unknown;
    let repositoryIdentity: string | undefined;
    try {
      if (manifest.phase === "creation-intent") {
        repositoryIdentity = await realpath(manifest.commonDir);
        await recoverWorktreeCreationIntent(
          manifestPath,
          manifest,
          platformServices,
          syncDirectory,
          temporaryPath,
          temporaryKind,
        );
        continue;
      }
      const commonDir = await realpath(manifest.commonDir);
      repositoryIdentity = commonDir;
      const expectedRegistrationRoot = path.join(commonDir, "worktrees");
      const registrationRoot = await realpath(expectedRegistrationRoot);
      const expectedQuarantineRoot = path.join(
        commonDir,
        WORKTREE_REGISTRATION_QUARANTINE_DIRECTORY,
      );
      const quarantineRoot = await realpath(expectedQuarantineRoot);
      const quarantineMetadata = await lstat(quarantineRoot, { bigint: true });
      const physicalRoot = await realpath(path.dirname(manifest.physicalPath));
      if (!await isManagedWorktreeRoot(physicalRoot)) {
        throw new RuntimeError("worktree removal manifest names an unmanaged root");
      }
      const commonDirIdentity = await managedWorktreeDirectoryIdentity(commonDir);
      const registrationRootIdentity = await managedWorktreeDirectoryIdentity(registrationRoot);
      const quarantineRootIdentity = await managedWorktreeDirectoryIdentity(quarantineRoot);
      const physicalRootIdentity = await managedWorktreeDirectoryIdentity(physicalRoot);
      const expectedCommonDirIdentity: ManagedWorktreeDirectoryIdentity = {
        dev: BigInt(manifest.commonDirDev),
        ino: BigInt(manifest.commonDirIno),
        birthtimeNs: BigInt(manifest.commonDirBirthtimeNs),
      };
      const expectedRegistrationRootIdentity: ManagedWorktreeDirectoryIdentity = {
        dev: BigInt(manifest.registrationRootDev),
        ino: BigInt(manifest.registrationRootIno),
        birthtimeNs: BigInt(manifest.registrationRootBirthtimeNs),
      };
      const expectedQuarantineRootIdentity: ManagedWorktreeDirectoryIdentity = {
        dev: BigInt(manifest.quarantineRootDev),
        ino: BigInt(manifest.quarantineRootIno),
        birthtimeNs: BigInt(manifest.quarantineRootBirthtimeNs),
      };
      const expectedPhysicalRootIdentity: ManagedWorktreeDirectoryIdentity = {
        dev: BigInt(manifest.physicalRootDev),
        ino: BigInt(manifest.physicalRootIno),
        birthtimeNs: BigInt(manifest.physicalRootBirthtimeNs),
      };
      if (process.platform === "win32") {
        if (registrationRootIdentity === null
          || quarantineRootIdentity === null
          || physicalRootIdentity === null) {
          throw new RuntimeError("worktree removal root identity is unavailable on Windows");
        }
        await Promise.all([
          assertWindowsPrivateDirectory(
            quarantineRoot,
            quarantineRootIdentity,
            platformServices,
          ),
          assertWindowsPrivateDirectory(
            physicalRoot,
            physicalRootIdentity,
            platformServices,
          ),
        ]);
      }
      const manifestPhysicalRoot = await realpath(path.dirname(manifest.physicalPath));
      const manifestPhysicalQuarantineRoot = await realpath(
        path.dirname(manifest.physicalQuarantinePath),
      );
      const assertRemovalRootsUnchanged = async () => {
        const currentCommonDir = await managedWorktreeDirectoryIdentity(commonDir);
        const currentRegistrationRoot = await managedWorktreeDirectoryIdentity(registrationRoot);
        const currentQuarantineRoot = await managedWorktreeDirectoryIdentity(quarantineRoot);
        const currentPhysicalRoot = await managedWorktreeDirectoryIdentity(physicalRoot);
        if (commonDirIdentity === null
          || currentCommonDir === null
          || !sameManagedIdentity(currentCommonDir, commonDirIdentity)
          || registrationRootIdentity === null
          || quarantineRootIdentity === null
          || physicalRootIdentity === null
          || currentRegistrationRoot === null
          || currentQuarantineRoot === null
          || currentPhysicalRoot === null
          || !sameManagedIdentity(currentRegistrationRoot, registrationRootIdentity)
          || !sameManagedIdentity(currentQuarantineRoot, quarantineRootIdentity)
          || !sameManagedIdentity(currentPhysicalRoot, physicalRootIdentity)) {
          throw new RuntimeError("worktree removal root identity changed");
        }
      };
      const syncRemovalRoots = async () => {
        for (const directory of [physicalRoot, registrationRoot, quarantineRoot]) {
          await syncDirectory(directory);
        }
        await assertRemovalRootsUnchanged();
      };
      const uid = process.getuid?.();
      const checkManifestConsistency = (
        tag: string,
        ok: boolean,
        ...operands: unknown[]
      ) => {
        if (ok) return;
        const detail = operands.length === 0
          ? ""
          : ` (${operands.map(operand => boundedRedactedDiagnostic(
            JSON.stringify(operand, (_key, value) =>
              typeof value === "bigint" ? value.toString() : value),
            256,
          )).join(" vs ")})`;
        throw new RuntimeError(
          `worktree removal manifest paths are inconsistent: ${tag}${detail}`,
        );
      };
      checkManifestConsistency(
        "quarantineRoot directory mismatch",
        quarantineMetadata.isDirectory(),
        quarantineMetadata.isDirectory(),
        true,
      );
      checkManifestConsistency(
        "quarantineRoot symlink mismatch",
        !quarantineMetadata.isSymbolicLink(),
        quarantineMetadata.isSymbolicLink(),
        false,
      );
      if (process.platform !== "win32") {
        checkManifestConsistency("quarantineRoot owner unavailable", uid !== undefined, uid);
        checkManifestConsistency(
          "quarantineRoot owner mismatch",
          quarantineMetadata.uid === BigInt(uid!),
          quarantineMetadata.uid,
          uid,
        );
        checkManifestConsistency(
          "quarantineRoot mode mismatch",
          (quarantineMetadata.mode & 0o077n) === 0n,
          quarantineMetadata.mode & 0o077n,
          0,
        );
      }
      checkManifestConsistency(
        "commonDir identity unavailable",
        commonDirIdentity !== null,
        commonDirIdentity,
      );
      checkManifestConsistency(
        "commonDir identity mismatch",
        sameManagedIdentity(commonDirIdentity!, expectedCommonDirIdentity),
        commonDirIdentity,
        expectedCommonDirIdentity,
      );
      checkManifestConsistency(
        "registrationRoot identity unavailable",
        registrationRootIdentity !== null,
        registrationRootIdentity,
      );
      checkManifestConsistency(
        "registrationRoot identity mismatch",
        sameManagedIdentity(registrationRootIdentity!, expectedRegistrationRootIdentity),
        registrationRootIdentity,
        expectedRegistrationRootIdentity,
      );
      checkManifestConsistency(
        "quarantineRoot identity unavailable",
        quarantineRootIdentity !== null,
        quarantineRootIdentity,
      );
      checkManifestConsistency(
        "quarantineRoot identity mismatch",
        sameManagedIdentity(quarantineRootIdentity!, expectedQuarantineRootIdentity),
        quarantineRootIdentity,
        expectedQuarantineRootIdentity,
      );
      checkManifestConsistency(
        "physicalRoot identity unavailable",
        physicalRootIdentity !== null,
        physicalRootIdentity,
      );
      checkManifestConsistency(
        "physicalRoot identity mismatch",
        sameManagedIdentity(physicalRootIdentity!, expectedPhysicalRootIdentity),
        physicalRootIdentity,
        expectedPhysicalRootIdentity,
      );
      checkManifestConsistency(
        "commonDir mismatch",
        platformPathsEqual(commonDir, manifest.commonDir),
        commonDir,
        manifest.commonDir,
      );
      checkManifestConsistency(
        "derived registrationRoot mismatch",
        platformPathsEqual(registrationRoot, expectedRegistrationRoot),
        registrationRoot,
        expectedRegistrationRoot,
      );
      checkManifestConsistency(
        "derived quarantineRoot mismatch",
        platformPathsEqual(quarantineRoot, expectedQuarantineRoot),
        quarantineRoot,
        expectedQuarantineRoot,
      );
      checkManifestConsistency(
        "registrationRoot mismatch",
        platformPathsEqual(registrationRoot, manifest.registrationRoot),
        registrationRoot,
        manifest.registrationRoot,
      );
      checkManifestConsistency(
        "quarantineRoot mismatch",
        platformPathsEqual(quarantineRoot, manifest.quarantineRoot),
        quarantineRoot,
        manifest.quarantineRoot,
      );
      checkManifestConsistency(
        "registrationPath is not absolute",
        path.isAbsolute(manifest.registrationPath),
        manifest.registrationPath,
      );
      checkManifestConsistency(
        "registrationPath is not normalized",
        path.resolve(manifest.registrationPath) === manifest.registrationPath,
        path.resolve(manifest.registrationPath),
        manifest.registrationPath,
      );
      checkManifestConsistency(
        "registrationPath equals registrationRoot",
        !platformPathsEqual(manifest.registrationPath, registrationRoot),
        manifest.registrationPath,
        registrationRoot,
      );
      checkManifestConsistency(
        "quarantinePath is not absolute",
        path.isAbsolute(manifest.quarantinePath),
        manifest.quarantinePath,
      );
      checkManifestConsistency(
        "quarantinePath is not normalized",
        path.resolve(manifest.quarantinePath) === manifest.quarantinePath,
        path.resolve(manifest.quarantinePath),
        manifest.quarantinePath,
      );
      checkManifestConsistency(
        "quarantinePath equals quarantineRoot",
        !platformPathsEqual(manifest.quarantinePath, quarantineRoot),
        manifest.quarantinePath,
        quarantineRoot,
      );
      checkManifestConsistency(
        "physicalPath is not absolute",
        path.isAbsolute(manifest.physicalPath),
        manifest.physicalPath,
      );
      checkManifestConsistency(
        "physicalPath is not normalized",
        path.resolve(manifest.physicalPath) === manifest.physicalPath,
        path.resolve(manifest.physicalPath),
        manifest.physicalPath,
      );
      checkManifestConsistency(
        "physicalPath equals physicalRoot",
        !platformPathsEqual(manifest.physicalPath, physicalRoot),
        manifest.physicalPath,
        physicalRoot,
      );
      checkManifestConsistency(
        "physicalQuarantinePath is not absolute",
        path.isAbsolute(manifest.physicalQuarantinePath),
        manifest.physicalQuarantinePath,
      );
      checkManifestConsistency(
        "physicalQuarantinePath is not normalized",
        path.resolve(manifest.physicalQuarantinePath) === manifest.physicalQuarantinePath,
        path.resolve(manifest.physicalQuarantinePath),
        manifest.physicalQuarantinePath,
      );
      checkManifestConsistency(
        "physicalQuarantinePath equals physicalRoot",
        !platformPathsEqual(manifest.physicalQuarantinePath, physicalRoot),
        manifest.physicalQuarantinePath,
        physicalRoot,
      );
      checkManifestConsistency(
        "registrationPath parent mismatch",
        platformPathsEqual(path.dirname(manifest.registrationPath), registrationRoot),
        path.dirname(manifest.registrationPath),
        registrationRoot,
      );
      checkManifestConsistency(
        "quarantinePath parent mismatch",
        platformPathsEqual(path.dirname(manifest.quarantinePath), quarantineRoot),
        path.dirname(manifest.quarantinePath),
        quarantineRoot,
      );
      checkManifestConsistency(
        "quarantinePath name mismatch",
        path.basename(manifest.quarantinePath)
          === `.remove-registration-${path.basename(manifest.registrationPath)}-${manifest.transactionId}`,
        path.basename(manifest.quarantinePath),
        `.remove-registration-${path.basename(manifest.registrationPath)}-${manifest.transactionId}`,
      );
      checkManifestConsistency(
        "physicalPath parent mismatch",
        platformPathsEqual(manifestPhysicalRoot, physicalRoot),
        manifestPhysicalRoot,
        physicalRoot,
      );
      checkManifestConsistency(
        "physicalQuarantinePath parent mismatch",
        platformPathsEqual(manifestPhysicalQuarantineRoot, physicalRoot),
        manifestPhysicalQuarantineRoot,
        physicalRoot,
      );
      checkManifestConsistency(
        "physicalQuarantinePath name mismatch",
        path.basename(manifest.physicalQuarantinePath)
          === `.remove-${path.basename(manifest.physicalPath)}-${manifest.transactionId}`,
        path.basename(manifest.physicalQuarantinePath),
        `.remove-${path.basename(manifest.physicalPath)}-${manifest.transactionId}`,
      );
      if (manifest.phase === "creation-root-changed") {
        throw new RuntimeError("worktree creation root changed and requires manual resolution");
      }
      const expectedRegistrationIdentity = {
        dev: BigInt(manifest.registrationDev),
        ino: BigInt(manifest.registrationIno),
        birthtimeNs: BigInt(manifest.registrationBirthtimeNs),
      };
      const expectedPhysicalIdentity = manifest.physicalPresent
        ? {
          dev: BigInt(manifest.physicalDev),
          ino: BigInt(manifest.physicalIno),
          birthtimeNs: BigInt(manifest.physicalBirthtimeNs),
        }
        : null;
      await platformSafety.withRecoveryLease(commonDir, async (lease) => {
        if (lease.repositoryIdentity !== commonDir) {
          throw new RuntimeError("worktree removal recovery lease identity mismatch");
        }

      if (temporaryPath !== undefined && temporaryKind === "linked") {
        await settleLinkedWorktreeRemovalManifest(
          manifestPath,
          temporaryPath,
          manifest.transactionId,
        );
      }
      const lockedManifest = await readWorktreeRemovalManifest(
        manifestPath,
        manifest.transactionId,
      );
      if (lockedManifest === null) return;
      if (JSON.stringify(lockedManifest) !== JSON.stringify(manifest)) {
        throw new RuntimeError("worktree removal manifest changed before recovery lease");
      }
      const registrationIdentity = await managedWorktreeDirectoryIdentity(
        manifest.registrationPath,
      );
      const quarantineIdentity = await managedWorktreeDirectoryIdentity(manifest.quarantinePath);
      let physicalIdentity = await managedWorktreeDirectoryIdentity(manifest.physicalPath);
      let physicalQuarantineIdentity = await managedWorktreeDirectoryIdentity(
        manifest.physicalQuarantinePath,
      );
      await assertRemovalRootsUnchanged();
      if (registrationIdentity !== null && quarantineIdentity !== null) {
        throw new RuntimeError("worktree removal registration exists at two paths");
      }
      if (physicalIdentity !== null && physicalQuarantineIdentity !== null) {
        throw new RuntimeError("physical worktree exists at two paths during removal recovery");
      }
      if (registrationIdentity !== null
        && (registrationIdentity.dev !== expectedRegistrationIdentity.dev
          || registrationIdentity.ino !== expectedRegistrationIdentity.ino
          || registrationIdentity.birthtimeNs !== expectedRegistrationIdentity.birthtimeNs)) {
        throw new RuntimeError("worktree removal registration identity changed");
      }
      if (quarantineIdentity !== null
        && (quarantineIdentity.dev !== expectedRegistrationIdentity.dev
          || quarantineIdentity.ino !== expectedRegistrationIdentity.ino
          || quarantineIdentity.birthtimeNs !== expectedRegistrationIdentity.birthtimeNs)) {
        throw new RuntimeError("worktree removal quarantine identity changed");
      }
      if (expectedPhysicalIdentity === null) {
        if (physicalIdentity !== null || physicalQuarantineIdentity !== null) {
          throw new RuntimeError("stale worktree physical path reappeared during removal recovery");
        }
      } else {
        if (physicalIdentity !== null
          && (physicalIdentity.dev !== expectedPhysicalIdentity.dev
            || physicalIdentity.ino !== expectedPhysicalIdentity.ino
            || physicalIdentity.birthtimeNs !== expectedPhysicalIdentity.birthtimeNs)) {
          throw new RuntimeError("physical worktree identity changed during removal recovery");
        }
        if (physicalQuarantineIdentity !== null
          && (physicalQuarantineIdentity.dev !== expectedPhysicalIdentity.dev
            || physicalQuarantineIdentity.ino !== expectedPhysicalIdentity.ino
            || physicalQuarantineIdentity.birthtimeNs !== expectedPhysicalIdentity.birthtimeNs)) {
          throw new RuntimeError("physical worktree quarantine identity changed");
        }
        if (physicalIdentity === null && physicalQuarantineIdentity === null) {
          const displacedPhysicalPath = await findManagedChildByIdentity(
            physicalRoot,
            expectedPhysicalIdentity,
          );
          if (displacedPhysicalPath !== null) {
            throw new RuntimeError(
              "physical worktree moved away from both recorded removal paths",
            );
          }
        }
      }

      const activeRegistrationPath = quarantineIdentity !== null
        ? manifest.quarantinePath
        : registrationIdentity !== null
          ? manifest.registrationPath
          : null;
      if (activeRegistrationPath === null && manifest.phase !== "physical-removed") {
        throw new RuntimeError("worktree removal registration disappeared before commit");
      }
      if (activeRegistrationPath !== null && manifest.phase !== "physical-removed") {
        await assertRegistrationBacklink(activeRegistrationPath, manifest.physicalPath);
      }

      if (manifest.phase === "physical-removed"
        && (physicalIdentity !== null || physicalQuarantineIdentity !== null)) {
        throw new RuntimeError("committed physical worktree removal reappeared");
      }
      if (manifest.phase === "physical-removal-intent"
        && manifest.physicalPresent
        && physicalIdentity === null
        && physicalQuarantineIdentity === null) {
        throw new RuntimeError(
          "intended physical worktree removal has no provable original or quarantine",
        );
      }
      const rollback = manifest.phase === "registration-intent"
        ? !manifest.physicalPresent || physicalIdentity !== null
        : manifest.phase === "physical-removal-intent"
          ? (manifest.physicalPresent
            ? physicalIdentity !== null || physicalQuarantineIdentity !== null
            : physicalIdentity === null && physicalQuarantineIdentity === null)
          : manifest.phase === "registration-staged"
            && (manifest.physicalPresent
              ? physicalIdentity !== null
              : physicalIdentity === null && physicalQuarantineIdentity === null);
      if (rollback) {
        if (manifest.phase === "physical-removal-intent"
          && physicalQuarantineIdentity !== null) {
          if (expectedPhysicalIdentity === null || physicalIdentity !== null) {
            throw new RuntimeError("physical worktree rollback state is inconsistent");
          }
          await assertRemovalRootsUnchanged();
          await rename(manifest.physicalQuarantinePath, manifest.physicalPath);
          const restoredPhysical = await managedWorktreeDirectoryIdentity(manifest.physicalPath);
          const settledPhysicalQuarantine = await managedWorktreeDirectoryIdentity(
            manifest.physicalQuarantinePath,
          );
          if (restoredPhysical === null
            || !sameManagedIdentity(restoredPhysical, expectedPhysicalIdentity)
            || settledPhysicalQuarantine !== null) {
            throw new RuntimeError("physical worktree rollback identity changed");
          }
          await syncDirectory(physicalRoot);
          await assertRemovalRootsUnchanged();
        }
        if (quarantineIdentity !== null) {
          await restoreStagedRegistration(
            registrationRoot,
            manifest.registrationPath,
            quarantineRoot,
            manifest.quarantinePath,
            expectedRegistrationIdentity,
            expectedRegistrationRootIdentity,
            expectedQuarantineRootIdentity,
            { processSupervisor: platformServices },
          );
        } else if (registrationIdentity === null) {
          throw new RuntimeError("pre-commit worktree registration disappeared");
        }
        await syncRemovalRoots();
        await removeWorktreeRemovalManifest(manifestPath, manifest.transactionId);
      } else {
        if (manifest.phase === "registration-staged") {
          throw new RuntimeError("staged worktree removal physical state is inconsistent");
        }
        if (manifest.phase === "physical-removal-started"
          && physicalIdentity !== null) {
          if (registrationIdentity !== null
            || expectedPhysicalIdentity === null
            || physicalQuarantineIdentity !== null) {
            throw new RuntimeError("started worktree removal state is inconsistent");
          }
          await assertRemovalRootsUnchanged();
          await rename(manifest.physicalPath, manifest.physicalQuarantinePath);
          physicalIdentity = await managedWorktreeDirectoryIdentity(manifest.physicalPath);
          physicalQuarantineIdentity = await managedWorktreeDirectoryIdentity(
            manifest.physicalQuarantinePath,
          );
          if (physicalIdentity !== null
            || physicalQuarantineIdentity === null
            || !sameManagedIdentity(physicalQuarantineIdentity, expectedPhysicalIdentity)) {
            throw new RuntimeError("started worktree removal quarantine identity changed");
          }
          await syncDirectory(physicalRoot);
          await assertRemovalRootsUnchanged();
        }
        if (physicalQuarantineIdentity !== null) {
          if (registrationIdentity !== null || expectedPhysicalIdentity === null) {
            throw new RuntimeError("quarantined worktree removal state is inconsistent");
          }
          await removeQuarantinedDirectory(
            physicalRoot,
            manifest.physicalQuarantinePath,
            expectedPhysicalIdentity,
            { processSupervisor: platformServices },
          );
          physicalQuarantineIdentity = null;
        }
        if (registrationIdentity !== null) {
          throw new RuntimeError("removed physical worktree retained a live registration");
        }
        if (quarantineIdentity !== null) {
          await removeQuarantinedDirectory(
            quarantineRoot,
            manifest.quarantinePath,
            expectedRegistrationIdentity,
            { processSupervisor: platformServices },
          );
        }
        await syncRemovalRoots();
        await removeWorktreeRemovalManifest(manifestPath, manifest.transactionId);
      }
    });
  } catch (error) {
    recoveryError = error;
  }


    if (recoveryError !== undefined) {
      issues.push({
        manifestPath,
        error: recoveryError,
        ...(repositoryIdentity === undefined ? {} : { repositoryIdentity }),
      });
    }
  }
  return issues;
}
