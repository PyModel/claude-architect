import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  link,
  lstat,
  open,
  readdir,
  realpath,
  rename,
  rm,
  type FileHandle,
} from "node:fs/promises";
import path from "node:path";
import {
  ensurePrivateDirectory as ensurePlatformPrivateDirectory,
  syncDirectoryMetadata,
} from "../platform/durable-directory.js";
import { RuntimeError, errorCode } from "../util/errors.js";
import { platformPathsEqual } from "../util/platform-path.js";
import { readStableRegularFile } from "../util/stable-file.js";
import { resolveStateDir } from "./state-dir.js";

const MANIFEST_DIRECTORY = "worktree-removals";
const MANIFEST_NAME = /^([a-z0-9][a-z0-9-]{0,127})\.json$/i;
const TEMPORARY_MANIFEST_NAME = /^\.([a-z0-9][a-z0-9-]{0,127})\.[0-9a-f-]{36}\.tmp$/i;
const HARDLINK_PROBE_NAME = /^\.hardlink-probe-([0-9a-f-]{36})\.(source|linked)$/i;
const MANIFEST_REMOVAL_GUARD = /^\.remove-manifest-([a-z0-9][a-z0-9-]{0,127})\.[0-9a-f-]{36}\.guard$/i;
const MANIFEST_VERSION = "1";
const MAX_MANIFEST_BYTES = 32_768n;

export interface WorktreeRemovalManifest {
  manifestVersion: "1";
  transactionId: string;
  phase: "registration-intent" | "registration-staged" | "physical-removal-intent"
    | "physical-removal-started" | "physical-removed" | "creation-intent"
    | "creation-root-changed";
  commonDir: string;
  commonDirDev: string;
  commonDirIno: string;
  commonDirBirthtimeNs: string;
  physicalPresent: boolean;
  physicalPath: string;
  physicalQuarantinePath: string;
  physicalDev: string;
  physicalIno: string;
  physicalBirthtimeNs: string;
  physicalRootDev: string;
  physicalRootIno: string;
  physicalRootBirthtimeNs: string;
  registrationRoot: string;
  registrationRootDev: string;
  registrationRootIno: string;
  registrationRootBirthtimeNs: string;
  registrationPath: string;
  quarantineRoot: string;
  quarantineRootDev: string;
  quarantineRootIno: string;
  quarantineRootBirthtimeNs: string;
  quarantinePath: string;
  registrationDev: string;
  registrationIno: string;
  registrationBirthtimeNs: string;
}

export interface PendingWorktreeRemovalManifest {
  manifestPath: string;
  manifest: WorktreeRemovalManifest;
  temporaryPath?: string;
  temporaryKind?: "linked";
}

export interface WorktreeRemovalManifestIssue {
  manifestPath: string;
  error: unknown;
  repositoryIdentity?: string;
}

interface FilesystemIdentity {
  dev: bigint;
  ino: bigint;
  birthtimeNs: bigint;
}

function sameIdentity(
  metadata: { dev: bigint; ino: bigint; birthtimeNs: bigint },
  expected: FilesystemIdentity,
): boolean {
  return metadata.dev === expected.dev
    && metadata.ino === expected.ino
    && metadata.birthtimeNs > 0n
    && metadata.birthtimeNs === expected.birthtimeNs;
}

function manifestRoot(): string {
  return path.join(resolveStateDir(), MANIFEST_DIRECTORY);
}

async function ensurePrivateDirectory(directory: string): Promise<FilesystemIdentity> {
  return await ensurePlatformPrivateDirectory(directory, {
    description: "worktree removal manifest directory",
  });
}

async function assertDirectoryIdentity(
  directory: string,
  expected: FilesystemIdentity,
): Promise<void> {
  const metadata = await lstat(directory, { bigint: true });
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || !sameIdentity(metadata, expected)) {
    throw new RuntimeError("worktree removal manifest directory identity changed");
  }
}

async function assertMissing(filename: string, description: string): Promise<void> {
  try {
    await lstat(filename);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return;
    throw error;
  }
  throw new RuntimeError(`${description} unexpectedly remains`);
}

async function assertManifestIdentity(
  manifestPath: string,
  expected: FilesystemIdentity,
  expectedLinks: bigint,
): Promise<void> {
  const metadata = await lstat(manifestPath, { bigint: true });
  if (!metadata.isFile()
    || metadata.isSymbolicLink()
    || metadata.nlink !== expectedLinks
    || !sameIdentity(metadata, expected)) {
    throw new RuntimeError("worktree removal manifest publication identity changed");
  }
}

async function writeSyncedManifest(
  handle: FileHandle,
  manifest: WorktreeRemovalManifest,
): Promise<FilesystemIdentity> {
  let primaryError: unknown;
  let identity: FilesystemIdentity | undefined;
  try {
    await handle.writeFile(`${JSON.stringify(manifest)}\n`);
    await handle.sync();
    const metadata = await handle.stat({ bigint: true });
    if (!metadata.isFile() || metadata.birthtimeNs <= 0n) {
      throw new RuntimeError("worktree removal manifest temporary file lacks stable identity");
    }
    identity = {
      dev: metadata.dev,
      ino: metadata.ino,
      birthtimeNs: metadata.birthtimeNs,
    };
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    try {
      await handle.close();
    } catch (closeError) {
      if (primaryError === undefined) throw closeError;
      throw new AggregateError(
        [primaryError, closeError],
        "manifest write failed and its handle could not be closed",
      );
    }
  }
  if (identity === undefined) {
    throw new RuntimeError("worktree removal manifest temporary identity is unavailable");
  }
  return identity;
}

function validateManifestPath(manifestPath: string, transactionId: string): string {
  const root = manifestRoot();
  const expected = path.join(root, `${transactionId}.json`);
  if (!MANIFEST_NAME.test(path.basename(manifestPath)) || manifestPath !== expected) {
    throw new RuntimeError("worktree removal manifest path is invalid");
  }
  return root;
}

function parseManifest(contents: Buffer, transactionId: string): WorktreeRemovalManifest {
  let value: unknown;
  try {
    value = JSON.parse(contents.toString("utf8")) as unknown;
  } catch {
    throw new RuntimeError("worktree removal manifest is invalid JSON");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new RuntimeError("worktree removal manifest is malformed");
  }
  const record = value as Record<string, unknown>;
  const expectedKeys = [
    "commonDir",
    "commonDirBirthtimeNs",
    "commonDirDev",
    "commonDirIno",
    "manifestVersion",
    "phase",
    "physicalBirthtimeNs",
    "physicalDev",
    "physicalIno",
    "physicalPath",
    "physicalPresent",
    "physicalQuarantinePath",
    "physicalRootBirthtimeNs",
    "physicalRootDev",
    "physicalRootIno",
    "quarantinePath",
    "quarantineRoot",
    "quarantineRootBirthtimeNs",
    "quarantineRootDev",
    "quarantineRootIno",
    "registrationBirthtimeNs",
    "registrationDev",
    "registrationIno",
    "registrationPath",
    "registrationRoot",
    "registrationRootBirthtimeNs",
    "registrationRootDev",
    "registrationRootIno",
    "transactionId",
  ].sort();
  const keys = Object.keys(record).sort();
  if (keys.length !== expectedKeys.length
    || keys.some((key, index) => key !== expectedKeys[index])
    || record.manifestVersion !== MANIFEST_VERSION
    || record.transactionId !== transactionId
    || typeof record.phase !== "string"
    || ![
      "registration-intent",
      "registration-staged",
      "physical-removal-intent",
      "physical-removal-started",
      "physical-removed",
      "creation-intent",
      "creation-root-changed",
    ].includes(record.phase)
    || typeof record.commonDir !== "string"
    || typeof record.commonDirBirthtimeNs !== "string"
    || !/^\d+$/u.test(record.commonDirBirthtimeNs)
    || typeof record.commonDirDev !== "string"
    || !/^\d+$/u.test(record.commonDirDev)
    || typeof record.commonDirIno !== "string"
    || !/^\d+$/u.test(record.commonDirIno)
    || typeof record.physicalPresent !== "boolean"
    || typeof record.physicalPath !== "string"
    || typeof record.physicalQuarantinePath !== "string"
    || typeof record.physicalBirthtimeNs !== "string"
    || !/^\d+$/u.test(record.physicalBirthtimeNs)
    || typeof record.physicalDev !== "string"
    || !/^\d+$/u.test(record.physicalDev)
    || typeof record.physicalIno !== "string"
    || !/^\d+$/u.test(record.physicalIno)
    || typeof record.physicalRootBirthtimeNs !== "string"
    || !/^\d+$/u.test(record.physicalRootBirthtimeNs)
    || typeof record.physicalRootDev !== "string"
    || !/^\d+$/u.test(record.physicalRootDev)
    || typeof record.physicalRootIno !== "string"
    || !/^\d+$/u.test(record.physicalRootIno)
    || typeof record.registrationRoot !== "string"
    || typeof record.registrationRootBirthtimeNs !== "string"
    || !/^\d+$/u.test(record.registrationRootBirthtimeNs)
    || typeof record.registrationRootDev !== "string"
    || !/^\d+$/u.test(record.registrationRootDev)
    || typeof record.registrationRootIno !== "string"
    || !/^\d+$/u.test(record.registrationRootIno)
    || typeof record.registrationPath !== "string"
    || typeof record.quarantineRoot !== "string"
    || typeof record.quarantineRootBirthtimeNs !== "string"
    || !/^\d+$/u.test(record.quarantineRootBirthtimeNs)
    || typeof record.quarantineRootDev !== "string"
    || !/^\d+$/u.test(record.quarantineRootDev)
    || typeof record.quarantineRootIno !== "string"
    || !/^\d+$/u.test(record.quarantineRootIno)
    || typeof record.quarantinePath !== "string"
    || typeof record.registrationBirthtimeNs !== "string"
    || !/^\d+$/u.test(record.registrationBirthtimeNs)
    || typeof record.registrationDev !== "string"
    || !/^\d+$/u.test(record.registrationDev)
    || typeof record.registrationIno !== "string"
    || !/^\d+$/u.test(record.registrationIno)
    || ![
      record.commonDir,
      record.physicalPath,
      record.physicalQuarantinePath,
      record.registrationRoot,
      record.registrationPath,
      record.quarantineRoot,
      record.quarantinePath,
    ].every(value => typeof value === "string" && path.isAbsolute(value))
    || (record.physicalPresent === false
      && (record.physicalDev !== "0"
        || record.physicalIno !== "0"
        || record.physicalBirthtimeNs !== "0"))) {
    throw new RuntimeError("worktree removal manifest is malformed");
  }
  return record as unknown as WorktreeRemovalManifest;
}

export async function verifyWorktreeRemovalManifestStorage(): Promise<void> {
  const root = manifestRoot();
  const rootIdentity = await ensurePrivateDirectory(root);
  const token = randomUUID();
  const sourcePath = path.join(root, `.hardlink-probe-${token}.source`);
  const linkedPath = path.join(root, `.hardlink-probe-${token}.linked`);
  let sourceExists = false;
  let linkedExists = false;
  let primaryError: unknown;
  try {
    const handle = await open(
      sourcePath,
      constants.O_WRONLY
        | constants.O_CREAT
        | constants.O_EXCL
        | (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    sourceExists = true;
    let identity: FilesystemIdentity;
    try {
      await handle.writeFile("claude-architect hard-link capability probe\n");
      await handle.sync();
      const metadata = await handle.stat({ bigint: true });
      if (!metadata.isFile() || metadata.birthtimeNs <= 0n) {
        throw new RuntimeError("manifest hard-link probe identity is unavailable");
      }
      identity = {
        dev: metadata.dev,
        ino: metadata.ino,
        birthtimeNs: metadata.birthtimeNs,
      };
    } finally {
      await handle.close();
    }
    await assertDirectoryIdentity(root, rootIdentity);
    await link(sourcePath, linkedPath);
    linkedExists = true;
    await Promise.all([
      assertManifestIdentity(sourcePath, identity, 2n),
      assertManifestIdentity(linkedPath, identity, 2n),
    ]);
  } catch (error) {
    primaryError = error;
  }
  const cleanupErrors: unknown[] = [];
  try {
    await assertDirectoryIdentity(root, rootIdentity);
    if (linkedExists) await rm(linkedPath, { force: false });
    if (sourceExists) await rm(sourcePath, { force: false });
    await syncDirectoryMetadata(root);
    await assertDirectoryIdentity(root, rootIdentity);
  } catch (error) {
    cleanupErrors.push(error);
  }
  if (primaryError !== undefined || cleanupErrors.length > 0) {
    throw new AggregateError(
      [primaryError, ...cleanupErrors].filter(error => error !== undefined),
      "worktree removal manifest storage does not support durable hard links",
    );
  }
}

function validateManifestForWrite(manifest: WorktreeRemovalManifest): void {
  const bytes = Buffer.from(`${JSON.stringify(manifest)}\n`);
  if (BigInt(bytes.byteLength) > MAX_MANIFEST_BYTES) {
    throw new RuntimeError("worktree removal manifest exceeds its recovery size limit");
  }
  parseManifest(bytes, manifest.transactionId);
}

export async function persistWorktreeRemovalManifest(
  manifest: WorktreeRemovalManifest,
): Promise<string> {
  if (!MANIFEST_NAME.test(`${manifest.transactionId}.json`)) {
    throw new RuntimeError("worktree removal transaction id is invalid");
  }
  validateManifestForWrite(manifest);
  const root = manifestRoot();
  const rootIdentity = await ensurePrivateDirectory(root);
  const manifestPath = path.join(root, `${manifest.transactionId}.json`);
  const temporaryPath = path.join(
    root,
    `.${manifest.transactionId}.${randomUUID()}.tmp`,
  );
  let temporaryExists = false;
  let manifestExists = false;
  try {
    const handle = await open(
      temporaryPath,
      constants.O_WRONLY
        | constants.O_CREAT
        | constants.O_EXCL
        | (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    temporaryExists = true;
    const temporaryIdentity = await writeSyncedManifest(handle, manifest);
    await assertDirectoryIdentity(root, rootIdentity);
    await assertManifestIdentity(temporaryPath, temporaryIdentity, 1n);
    await link(temporaryPath, manifestPath);
    manifestExists = true;
    await assertDirectoryIdentity(root, rootIdentity);
    await Promise.all([
      assertManifestIdentity(temporaryPath, temporaryIdentity, 2n),
      assertManifestIdentity(manifestPath, temporaryIdentity, 2n),
    ]);
    await rm(temporaryPath);
    temporaryExists = false;
    await assertDirectoryIdentity(root, rootIdentity);
    await assertManifestIdentity(manifestPath, temporaryIdentity, 1n);
    await syncDirectoryMetadata(root);
    await assertDirectoryIdentity(root, rootIdentity);
    await assertManifestIdentity(manifestPath, temporaryIdentity, 1n);
    return manifestPath;
  } catch (error) {
    const cleanupErrors: unknown[] = [];
    try {
      await assertDirectoryIdentity(root, rootIdentity);
    } catch (identityError) {
      cleanupErrors.push(identityError);
      temporaryExists = false;
      manifestExists = false;
    }
    if (temporaryExists) {
      try { await rm(temporaryPath, { force: true }); }
      catch (cleanupError) { cleanupErrors.push(cleanupError); }
    }
    if (manifestExists) {
      try { await rm(manifestPath, { force: true }); }
      catch (cleanupError) { cleanupErrors.push(cleanupError); }
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        [error, ...cleanupErrors],
        "worktree removal manifest persistence and rollback failed",
      );
    }
    throw error;
  }
}

export async function replaceWorktreeRemovalManifest(
  manifestPath: string,
  manifest: WorktreeRemovalManifest,
): Promise<void> {
  validateManifestForWrite(manifest);
  const root = validateManifestPath(manifestPath, manifest.transactionId);
  const rootIdentity = await ensurePrivateDirectory(root);
  const temporaryPath = path.join(
    root,
    `.${manifest.transactionId}.${randomUUID()}.tmp`,
  );
  let temporaryExists = false;
  let primaryError: unknown;
  try {
    const handle = await open(
      temporaryPath,
      constants.O_WRONLY
        | constants.O_CREAT
        | constants.O_EXCL
        | (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    temporaryExists = true;
    const temporaryIdentity = await writeSyncedManifest(handle, manifest);
    await assertDirectoryIdentity(root, rootIdentity);
    await assertManifestIdentity(temporaryPath, temporaryIdentity, 1n);
    await rename(temporaryPath, manifestPath);
    temporaryExists = false;
    await assertDirectoryIdentity(root, rootIdentity);
    await assertManifestIdentity(manifestPath, temporaryIdentity, 1n);
    await syncDirectoryMetadata(root);
    await assertDirectoryIdentity(root, rootIdentity);
    await assertManifestIdentity(manifestPath, temporaryIdentity, 1n);
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    if (temporaryExists) {
      try {
        await assertDirectoryIdentity(root, rootIdentity);
        await rm(temporaryPath, { force: true });
      } catch (cleanupError) {
        if (primaryError === undefined) throw cleanupError;
        throw new AggregateError(
          [primaryError, cleanupError],
          "worktree removal manifest replacement and rollback failed",
        );
      }
    }
  }
}

export async function removeWorktreeRemovalManifest(
  manifestPath: string,
  transactionId: string,
): Promise<void> {
  const root = validateManifestPath(manifestPath, transactionId);
  const rootIdentity = await ensurePrivateDirectory(root);
  const manifestMetadata = await lstat(manifestPath, { bigint: true });
  if (!manifestMetadata.isFile()
    || manifestMetadata.isSymbolicLink()
    || manifestMetadata.nlink !== 1n
    || manifestMetadata.birthtimeNs <= 0n) {
    throw new RuntimeError("worktree removal manifest identity is ambiguous before removal");
  }
  const identity = {
    dev: manifestMetadata.dev,
    ino: manifestMetadata.ino,
    birthtimeNs: manifestMetadata.birthtimeNs,
  };
  const guardPath = path.join(
    root,
    `.remove-manifest-${transactionId}.${randomUUID()}.guard`,
  );
  await assertDirectoryIdentity(root, rootIdentity);
  await link(manifestPath, guardPath);
  await Promise.all([
    assertManifestIdentity(manifestPath, identity, 2n),
    assertManifestIdentity(guardPath, identity, 2n),
  ]);
  await rm(manifestPath, { force: false });
  await assertDirectoryIdentity(root, rootIdentity);
  await assertMissing(manifestPath, "worktree removal manifest");
  await assertManifestIdentity(guardPath, identity, 1n);
  await rm(guardPath, { force: false });
  await syncDirectoryMetadata(root);
  await assertDirectoryIdentity(root, rootIdentity);
  await Promise.all([
    assertMissing(manifestPath, "worktree removal manifest"),
    assertMissing(guardPath, "worktree removal manifest guard"),
  ]);
}

async function readLinkedManifest(
  temporaryPath: string,
  manifestPath: string,
): Promise<Buffer> {
  const handle = await open(
    manifestPath,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  let primaryError: unknown;
  try {
    const [opened, temporary, published] = await Promise.all([
      handle.stat({ bigint: true }),
      lstat(temporaryPath, { bigint: true }),
      lstat(manifestPath, { bigint: true }),
    ]);
    if (!opened.isFile()
      || opened.nlink !== 2n
      || opened.size > MAX_MANIFEST_BYTES
      || !temporary.isFile()
      || temporary.isSymbolicLink()
      || temporary.nlink !== 2n
      || !published.isFile()
      || published.isSymbolicLink()
      || published.nlink !== 2n
      || !sameIdentity(temporary, opened)
      || !sameIdentity(published, opened)
      || temporary.size !== opened.size
      || published.size !== opened.size) {
      throw new RuntimeError("linked worktree removal manifest residue is ambiguous");
    }
    const size = Number(opened.size);
    const contents = Buffer.alloc(size);
    let offset = 0;
    while (offset < size) {
      const { bytesRead } = await handle.read(contents, offset, size - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    const [settled, settledTemporary, settledPublished] = await Promise.all([
      handle.stat({ bigint: true }),
      lstat(temporaryPath, { bigint: true }),
      lstat(manifestPath, { bigint: true }),
    ]);
    if (offset !== size
      || !sameIdentity(settled, opened)
      || settled.nlink !== 2n
      || settled.size !== opened.size
      || settled.mtimeNs !== opened.mtimeNs
      || settled.ctimeNs !== opened.ctimeNs
      || !sameIdentity(settledTemporary, opened)
      || settledTemporary.nlink !== 2n
      || !sameIdentity(settledPublished, opened)
      || settledPublished.nlink !== 2n) {
      throw new RuntimeError("linked worktree removal manifest residue changed while reading");
    }
    return contents;
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    try {
      await handle.close();
    } catch (closeError) {
      if (primaryError === undefined) throw closeError;
      throw new AggregateError(
        [primaryError, closeError],
        "linked manifest read failed and its handle could not be closed",
      );
    }
  }
}

export async function settleLinkedWorktreeRemovalManifest(
  manifestPath: string,
  temporaryPath: string,
  transactionId: string,
): Promise<void> {
  const root = validateManifestPath(manifestPath, transactionId);
  const temporaryMatch = TEMPORARY_MANIFEST_NAME.exec(path.basename(temporaryPath));
  if (temporaryMatch?.[1] !== transactionId || path.dirname(temporaryPath) !== root) {
    throw new RuntimeError("temporary worktree removal manifest path is invalid");
  }
  const rootIdentity = await ensurePrivateDirectory(root);
  let temporary;
  let published;
  try {
    [temporary, published] = await Promise.all([
      lstat(temporaryPath, { bigint: true }),
      lstat(manifestPath, { bigint: true }),
    ]);
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      const remaining = await lstat(manifestPath, { bigint: true }).catch(() => null);
      if (remaining !== null && remaining.isFile() && remaining.nlink === 1n) return;
    }
    throw error;
  }
  if (!temporary.isFile()
    || temporary.isSymbolicLink()
    || temporary.nlink !== 2n
    || !published.isFile()
    || published.isSymbolicLink()
    || published.nlink !== 2n
    || !sameIdentity(temporary, published)) {
    throw new RuntimeError("linked worktree removal manifest residue is ambiguous");
  }
  const publishedIdentity = {
    dev: published.dev,
    ino: published.ino,
    birthtimeNs: published.birthtimeNs,
  };
  await assertDirectoryIdentity(root, rootIdentity);
  await rm(temporaryPath, { force: false });
  await assertDirectoryIdentity(root, rootIdentity);
  await assertManifestIdentity(manifestPath, publishedIdentity, 1n);
  await syncDirectoryMetadata(root);
  await assertDirectoryIdentity(root, rootIdentity);
  await assertManifestIdentity(manifestPath, publishedIdentity, 1n);
}

export async function readWorktreeRemovalManifest(
  manifestPath: string,
  transactionId: string,
): Promise<WorktreeRemovalManifest | null> {
  const root = validateManifestPath(manifestPath, transactionId);
  const rootIdentity = await ensurePrivateDirectory(root);
  let contents: Buffer | null;
  try {
    contents = await readStableRegularFile(manifestPath, MAX_MANIFEST_BYTES);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return null;
    throw error;
  }
  await assertDirectoryIdentity(root, rootIdentity);
  if (contents === null) {
    throw new RuntimeError("worktree removal manifest is not stable");
  }
  return parseManifest(contents, transactionId);
}

export async function assertNoPendingWorktreeRemovalForRepository(
  repositoryIdentity: string,
): Promise<void> {
  const root = manifestRoot();
  let rootIdentity: FilesystemIdentity;
  let entries;
  try {
    rootIdentity = await ensurePlatformPrivateDirectory(root, {
      description: "worktree removal manifest root",
      create: false,
    });
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (errorCode(error) === "ENOENT") return;
    throw error;
  }
  for (const entry of entries) {
    if (HARDLINK_PROBE_NAME.test(entry.name)
      || TEMPORARY_MANIFEST_NAME.test(entry.name)
      || MANIFEST_REMOVAL_GUARD.test(entry.name)) {
      continue;
    }
    const match = MANIFEST_NAME.exec(entry.name);
    if (match === null || !entry.isFile() || entry.isSymbolicLink()) {
      throw new RuntimeError("worktree removal manifest root contains ambiguous residue");
    }
    const manifestPath = path.join(root, entry.name);
    const manifest = await readWorktreeRemovalManifest(manifestPath, match[1]!);
    if (manifest === null) {
      throw new RuntimeError("worktree removal manifest changed during lease validation");
    }
    let canonicalCommonDir: string;
    try {
      canonicalCommonDir = await realpath(manifest.commonDir);
    } catch (error) {
      throw new RuntimeError("worktree removal repository identity is unavailable", {
        cause: error,
      });
    }
    if (platformPathsEqual(canonicalCommonDir, repositoryIdentity)) {
      throw new RuntimeError("repository has a pending worktree removal transaction");
    }
  }
  await assertDirectoryIdentity(root, rootIdentity);
}

export async function readPendingWorktreeRemovalManifests(): Promise<{
  pending: PendingWorktreeRemovalManifest[];
  issues: WorktreeRemovalManifestIssue[];
}> {
  const root = manifestRoot();
  let initialMetadata;
  try {
    initialMetadata = await lstat(root, { bigint: true });
  } catch (error) {
    if (errorCode(error) === "ENOENT") return { pending: [], issues: [] };
    return { pending: [], issues: [{ manifestPath: root, error }] };
  }
  if (!initialMetadata.isDirectory() || initialMetadata.isSymbolicLink()) {
    return {
      pending: [],
      issues: [{
        manifestPath: root,
        error: new RuntimeError("worktree removal manifest directory must be plain"),
      }],
    };
  }
  let rootIdentity: FilesystemIdentity;
  let entries;
  try {
    rootIdentity = await ensurePrivateDirectory(root);
    entries = await readdir(root, { withFileTypes: true });
    await assertDirectoryIdentity(root, rootIdentity);
  } catch (error) {
    return { pending: [], issues: [{ manifestPath: root, error }] };
  }

  const pending: PendingWorktreeRemovalManifest[] = [];
  const issues: WorktreeRemovalManifestIssue[] = [];
  const linkedPublishedPaths = new Set<string>();
  const sortedEntries = entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of sortedEntries) {
    const guardMatch = MANIFEST_REMOVAL_GUARD.exec(entry.name);
    if (guardMatch === null) continue;
    const guardPath = path.join(root, entry.name);
    const publishedPath = path.join(root, `${guardMatch[1]!}.json`);
    try {
      await assertDirectoryIdentity(root, rootIdentity);
      const guard = await lstat(guardPath, { bigint: true });
      if (!guard.isFile()
        || guard.isSymbolicLink()
        || guard.birthtimeNs <= 0n
        || (guard.nlink !== 1n && guard.nlink !== 2n)) {
        throw new RuntimeError("worktree removal manifest guard is malformed");
      }
      if (guard.nlink === 2n) {
        const published = await lstat(publishedPath, { bigint: true });
        if (!published.isFile()
          || published.isSymbolicLink()
          || published.nlink !== 2n
          || !sameIdentity(published, guard)) {
          throw new RuntimeError("worktree removal manifest guard pair is inconsistent");
        }
      } else {
        await assertMissing(publishedPath, "removed worktree manifest");
      }
      await rm(guardPath, { force: false });
      await syncDirectoryMetadata(root);
      await assertDirectoryIdentity(root, rootIdentity);
    } catch (error) {
      issues.push({ manifestPath: guardPath, error });
    }
  }
  const probeEntries = new Map<string, { source?: string; linked?: string }>();
  for (const entry of sortedEntries) {
    const match = HARDLINK_PROBE_NAME.exec(entry.name);
    if (match === null) continue;
    const pair = probeEntries.get(match[1]!) ?? {};
    pair[match[2] as "source" | "linked"] = path.join(root, entry.name);
    probeEntries.set(match[1]!, pair);
  }
  for (const pair of probeEntries.values()) {
    const paths = [pair.source, pair.linked].filter((value): value is string => value !== undefined);
    try {
      await assertDirectoryIdentity(root, rootIdentity);
      const metadata = await Promise.all(paths.map(async probePath => ({
        path: probePath,
        metadata: await lstat(probePath, { bigint: true }),
      })));
      if (metadata.some(({ metadata: value }) =>
        !value.isFile() || value.isSymbolicLink() || value.birthtimeNs <= 0n)) {
        throw new RuntimeError("manifest hard-link probe residue is malformed");
      }
      if (metadata.length === 1) {
        if (metadata[0]!.metadata.nlink !== 1n) {
          throw new RuntimeError("manifest hard-link probe residue has an external alias");
        }
      } else if (metadata.length !== 2
        || metadata.some(({ metadata: value }) => value.nlink !== 2n)
        || !sameIdentity(metadata[0]!.metadata, metadata[1]!.metadata)) {
        throw new RuntimeError("manifest hard-link probe pair is inconsistent");
      }
      for (const { path: probePath } of metadata.reverse()) {
        await rm(probePath, { force: false });
      }
      await syncDirectoryMetadata(root);
      await assertDirectoryIdentity(root, rootIdentity);
    } catch (error) {
      issues.push({ manifestPath: paths[0] ?? root, error });
    }
  }
  for (const entry of sortedEntries) {
    const temporaryMatch = TEMPORARY_MANIFEST_NAME.exec(entry.name);
    if (temporaryMatch === null) continue;
    const temporaryPath = path.join(root, entry.name);
    if (!entry.isFile() || entry.isSymbolicLink()) {
      issues.push({
        manifestPath: temporaryPath,
        error: new RuntimeError("temporary worktree removal manifest entry is malformed"),
      });
      continue;
    }
    const transactionId = temporaryMatch[1]!;
    const publishedPath = path.join(root, `${transactionId}.json`);
    try {
      await assertDirectoryIdentity(root, rootIdentity);
      const temporaryMetadata = await lstat(temporaryPath, { bigint: true });
      if (temporaryMetadata.nlink === 1n) {
        const contents = await readStableRegularFile(temporaryPath, MAX_MANIFEST_BYTES);
        if (contents === null) {
          throw new RuntimeError("unpublished worktree removal manifest is not stable");
        }
        await rm(temporaryPath, { force: false });
        await syncDirectoryMetadata(root);
        await assertDirectoryIdentity(root, rootIdentity);
      } else {
        const contents = await readLinkedManifest(temporaryPath, publishedPath);
        pending.push({
          manifestPath: publishedPath,
          manifest: parseManifest(contents, transactionId),
          temporaryPath,
          temporaryKind: "linked",
        });
        linkedPublishedPaths.add(publishedPath);
      }
    } catch (error) {
      issues.push({ manifestPath: temporaryPath, error });
    }
  }

  for (const entry of sortedEntries) {
    if (TEMPORARY_MANIFEST_NAME.test(entry.name)
      || HARDLINK_PROBE_NAME.test(entry.name)
      || MANIFEST_REMOVAL_GUARD.test(entry.name)) continue;
    const manifestPath = path.join(root, entry.name);
    const match = MANIFEST_NAME.exec(entry.name);
    if (match === null || !entry.isFile() || entry.isSymbolicLink()) {
      issues.push({
        manifestPath,
        error: new RuntimeError("worktree removal manifest entry is malformed"),
      });
      continue;
    }
    if (linkedPublishedPaths.has(manifestPath)) continue;
    try {
      await assertDirectoryIdentity(root, rootIdentity);
      const contents = await readStableRegularFile(manifestPath, MAX_MANIFEST_BYTES);
      if (contents === null) throw new RuntimeError("worktree removal manifest is not stable");
      pending.push({ manifestPath, manifest: parseManifest(contents, match[1]!) });
    } catch (error) {
      issues.push({ manifestPath, error });
    }
  }
  try {
    await assertDirectoryIdentity(root, rootIdentity);
  } catch (error) {
    return { pending: [], issues: [...issues, { manifestPath: root, error }] };
  }
  return { pending, issues };
}
