import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  link,
  lstat,
  open,
  readdir,
  realpath,
  rm,
} from "node:fs/promises";
import path from "node:path";
import {
  NO_FOLLOW,
  ensurePrivateDirectory as ensurePlatformPrivateDirectory,
  sameDirectoryIdentity,
  syncDirectoryMetadata,
  type DirectoryIdentity,
} from "../platform/durable-directory.js";
import {
  DurableDirectorySession,
  publishExclusive,
  writeAtomic,
} from "../platform/durable-write.js";
import { RuntimeError, errorCode } from "../util/errors.js";
import { platformPathsEqual } from "../util/platform-path.js";
import { readStableRegularFile } from "../util/stable-file.js";
import { resolveStateDir } from "./state-dir.js";

const MANIFEST_DIRECTORY = "worktree-removals";
const MANIFEST_NAME = /^([a-z0-9][a-z0-9-]{0,127})\.json$/i;
// `.<id>.json.<uuid>.tmp` is the shared durable primitives' temporary;
// `.<id>.<uuid>.tmp` is the residue a crash left before they were adopted.
const TEMPORARY_MANIFEST_NAME = /^\.([a-z0-9][a-z0-9-]{0,127})(?:\.json)?\.[0-9a-f-]{36}\.tmp$/i;
const HARDLINK_PROBE_NAME = /^\.hardlink-probe-([0-9a-f-]{36})\.(source|linked)$/i;
const MANIFEST_REMOVAL_GUARD = /^\.remove-manifest-([a-z0-9][a-z0-9-]{0,127})\.[0-9a-f-]{36}\.guard$/i;
const MANIFEST_VERSION = "1";
const MAX_MANIFEST_BYTES = 32_768n;

/**
 * Every phase a Worktree Transaction writes. This module is the only writer
 * and the only interpreter of these names; a manifest naming anything else is
 * malformed and recovery fails closed on it.
 */
const WORKTREE_TRANSACTION_PHASES = [
  "registration-intent",
  "registration-staged",
  "physical-removal-intent",
  "physical-removal-started",
  "physical-removed",
  "creation-intent",
] as const;

export type WorktreeTransactionPhase = typeof WORKTREE_TRANSACTION_PHASES[number];

/** Called after each phase is durably recorded; a test seam for crash cut-points. */
export type WorktreeTransactionPhaseObserver = (phase: WorktreeTransactionPhase) => Promise<void>;

export interface WorktreeRemovalManifest {
  manifestVersion: "1";
  transactionId: string;
  phase: WorktreeTransactionPhase;
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

/** Exact device, inode and birth time of a manifest file. */
interface ManifestFileIdentity {
  dev: bigint;
  ino: bigint;
  birthtimeNs: bigint;
}

/** Manifest-file identity; file identity checks keep their own rule. */
function sameFileIdentity(
  metadata: ManifestFileIdentity,
  expected: ManifestFileIdentity,
): boolean {
  return metadata.dev === expected.dev
    && metadata.ino === expected.ino
    && metadata.birthtimeNs > 0n
    && metadata.birthtimeNs === expected.birthtimeNs;
}

function manifestRoot(): string {
  return path.join(resolveStateDir(), MANIFEST_DIRECTORY);
}

async function ensurePrivateDirectory(directory: string): Promise<DirectoryIdentity> {
  return await ensurePlatformPrivateDirectory(directory, {
    description: "worktree removal manifest directory",
  });
}

async function assertDirectoryIdentity(
  directory: string,
  expected: DirectoryIdentity,
): Promise<void> {
  const metadata = await lstat(directory, { bigint: true });
  if (!metadata.isDirectory()
    || metadata.isSymbolicLink()
    || !sameDirectoryIdentity(metadata, expected)) {
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
  expected: ManifestFileIdentity,
  expectedLinks: bigint,
): Promise<void> {
  const metadata = await lstat(manifestPath, { bigint: true });
  if (!metadata.isFile()
    || metadata.isSymbolicLink()
    || metadata.nlink !== expectedLinks
    || !sameFileIdentity(metadata, expected)) {
    throw new RuntimeError("worktree removal manifest publication identity changed");
  }
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
    || !(WORKTREE_TRANSACTION_PHASES as readonly string[]).includes(record.phase)
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
        | NO_FOLLOW,
      0o600,
    );
    sourceExists = true;
    let identity: ManifestFileIdentity;
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

function manifestBytes(manifest: WorktreeRemovalManifest): Buffer {
  const bytes = Buffer.from(`${JSON.stringify(manifest)}\n`);
  if (BigInt(bytes.byteLength) > MAX_MANIFEST_BYTES) {
    throw new RuntimeError("worktree removal manifest exceeds its recovery size limit");
  }
  parseManifest(bytes, manifest.transactionId);
  return bytes;
}

async function manifestSession(root: string): Promise<DurableDirectorySession> {
  return new DurableDirectorySession(root, await ensurePrivateDirectory(root));
}

export async function persistWorktreeRemovalManifest(
  manifest: WorktreeRemovalManifest,
): Promise<string> {
  if (!MANIFEST_NAME.test(`${manifest.transactionId}.json`)) {
    throw new RuntimeError("worktree removal transaction id is invalid");
  }
  const bytes = manifestBytes(manifest);
  const root = manifestRoot();
  await publishExclusive(await manifestSession(root), `${manifest.transactionId}.json`, bytes);
  return path.join(root, `${manifest.transactionId}.json`);
}

export async function replaceWorktreeRemovalManifest(
  manifestPath: string,
  manifest: WorktreeRemovalManifest,
): Promise<void> {
  const bytes = manifestBytes(manifest);
  const root = validateManifestPath(manifestPath, manifest.transactionId);
  await writeAtomic(await manifestSession(root), path.basename(manifestPath), bytes, "replace");
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
    constants.O_RDONLY | NO_FOLLOW,
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
      || !sameFileIdentity(temporary, opened)
      || !sameFileIdentity(published, opened)
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
      || !sameFileIdentity(settled, opened)
      || settled.nlink !== 2n
      || settled.size !== opened.size
      || settled.mtimeNs !== opened.mtimeNs
      || settled.ctimeNs !== opened.ctimeNs
      || !sameFileIdentity(settledTemporary, opened)
      || settledTemporary.nlink !== 2n
      || !sameFileIdentity(settledPublished, opened)
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
    || !sameFileIdentity(temporary, published)) {
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
  let rootIdentity: DirectoryIdentity;
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
  let rootIdentity: DirectoryIdentity;
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
          || !sameFileIdentity(published, guard)) {
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
        || !sameFileIdentity(metadata[0]!.metadata, metadata[1]!.metadata)) {
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

/** The recorded fields of a transaction; the module owns version and phase. */
export type WorktreeTransactionRecord = Omit<WorktreeRemovalManifest, "manifestVersion" | "phase">;

export interface WorktreeCreationTransaction {
  manifestPath: string;
  manifest: WorktreeRemovalManifest;
}

/** Record a creation intent before anything exists on disk. */
export async function beginWorktreeCreation(
  record: WorktreeTransactionRecord,
  afterPhase?: WorktreeTransactionPhaseObserver,
): Promise<WorktreeCreationTransaction> {
  if (record.physicalPresent) {
    throw new RuntimeError("worktree creation intent must start without a placeholder");
  }
  // Same key order as every creation manifest written before this module.
  const { transactionId, ...fields } = record;
  const manifest: WorktreeRemovalManifest = {
    manifestVersion: MANIFEST_VERSION,
    transactionId,
    phase: "creation-intent",
    ...fields,
  };
  const manifestPath = await persistWorktreeRemovalManifest(manifest);
  await afterPhase?.(manifest.phase);
  return { manifestPath, manifest };
}

/** Bind the creation intent to the placeholder directory it just created. */
export async function bindWorktreeCreationPlaceholder(
  creation: WorktreeCreationTransaction,
  placeholder: DirectoryIdentity,
  afterPhase?: WorktreeTransactionPhaseObserver,
): Promise<WorktreeCreationTransaction> {
  if (creation.manifest.phase !== "creation-intent" || creation.manifest.physicalPresent) {
    throw new RuntimeError("worktree creation placeholder is already bound");
  }
  const manifest: WorktreeRemovalManifest = {
    ...creation.manifest,
    physicalPresent: true,
    physicalDev: placeholder.dev.toString(),
    physicalIno: placeholder.ino.toString(),
    physicalBirthtimeNs: placeholder.birthtimeNs.toString(),
  };
  await replaceWorktreeRemovalManifest(creation.manifestPath, manifest);
  await afterPhase?.(manifest.phase);
  return { manifestPath: creation.manifestPath, manifest };
}

export interface StagedWorktreeRegistration {
  commit(): Promise<void>;
  rollback(): Promise<void>;
}

export interface WorktreeRemovalCoordination {
  transaction: WorktreeTransactionRecord;
  stageRegistration(): Promise<StagedWorktreeRegistration>;
  stageFailureWasRolledBack(): Promise<boolean>;
  removePhysical(markRemovalStarted: () => Promise<void>): Promise<void>;
  physicalIsUnchanged(): Promise<boolean>;
  afterPhase?: WorktreeTransactionPhaseObserver | undefined;
}

async function rollbackPrecommit(
  manifestPath: string,
  transactionId: string,
  staged: StagedWorktreeRegistration,
  primaryError: unknown,
): Promise<never> {
  try {
    await staged.rollback();
    await removeWorktreeRemovalManifest(manifestPath, transactionId);
  } catch (rollbackError) {
    throw new AggregateError(
      [primaryError, rollbackError],
      "worktree removal failed before commit and its rollback did not complete",
    );
  }
  throw primaryError;
}

export async function coordinateWorktreeRemoval(
  coordination: WorktreeRemovalCoordination,
): Promise<void> {
  let manifest: WorktreeRemovalManifest = {
    manifestVersion: MANIFEST_VERSION,
    phase: "registration-intent",
    ...coordination.transaction,
  };
  const manifestPath = await persistWorktreeRemovalManifest(manifest);
  const record = async (next: WorktreeRemovalManifest) => {
    await replaceWorktreeRemovalManifest(manifestPath, next);
    manifest = next;
    await coordination.afterPhase?.(next.phase);
  };
  await coordination.afterPhase?.(manifest.phase);
  let staged: StagedWorktreeRegistration;
  try {
    staged = await coordination.stageRegistration();
  } catch (stageError) {
    let rolledBack: boolean;
    try {
      rolledBack = await coordination.stageFailureWasRolledBack();
    } catch (observationError) {
      throw new AggregateError(
        [stageError, observationError],
        "worktree registration staging failed and rollback state is ambiguous",
      );
    }
    if (rolledBack) {
      try {
        await removeWorktreeRemovalManifest(manifestPath, manifest.transactionId);
      } catch (manifestError) {
        throw new AggregateError(
          [stageError, manifestError],
          "worktree registration staging failed and its manifest could not be removed",
        );
      }
    }
    throw stageError;
  }

  try {
    await record({ ...manifest, phase: "registration-staged" });
    await record({ ...manifest, phase: "physical-removal-intent" });
    await coordination.removePhysical(async () => {
      await record({ ...manifest, phase: "physical-removal-started" });
    });
  } catch (precommitError) {
    if (manifest.phase === "physical-removal-started") throw precommitError;
    let unchanged: boolean;
    try {
      unchanged = await coordination.physicalIsUnchanged();
    } catch (observationError) {
      throw new AggregateError(
        [precommitError, observationError],
        "worktree removal failed and physical rollback state is ambiguous",
      );
    }
    if (unchanged) {
      return await rollbackPrecommit(
        manifestPath,
        manifest.transactionId,
        staged,
        precommitError,
      );
    }
    throw precommitError;
  }

  await record({ ...manifest, phase: "physical-removed" });
  await staged.commit();
  await removeWorktreeRemovalManifest(manifestPath, manifest.transactionId);
}

/** Creation transactions replay by rollback; everything else is a removal. */
export function isWorktreeCreationTransaction(manifest: WorktreeRemovalManifest): boolean {
  return manifest.phase === "creation-intent";
}

/** What recovery observed for a removal transaction's recorded paths. */
export interface WorktreeRemovalObservation {
  registrationActive: boolean;
  physicalAtPath: boolean;
  physicalInQuarantine: boolean;
}

export interface WorktreeRemovalReplay {
  /** Restore the worktree, or finish removing it. */
  action: "rollback" | "complete";
  /** The live registration must still point at the recorded physical path. */
  verifyRegistrationBacklink: boolean;
  /** Removal started but the physical directory is still at its path: quarantine it first. */
  quarantinePhysical: boolean;
}

/**
 * Decide how a removal transaction interrupted at its recorded phase replays.
 * Throws when the observed state is not one a crash at that phase can leave.
 */
export function planWorktreeRemovalReplay(
  manifest: WorktreeRemovalManifest,
  observed: WorktreeRemovalObservation,
): WorktreeRemovalReplay {
  const { phase, physicalPresent } = manifest;
  const { registrationActive, physicalAtPath, physicalInQuarantine } = observed;
  if (phase === "creation-intent") {
    throw new RuntimeError("worktree creation transaction is not a removal");
  }
  const committed = phase === "physical-removed";
  if (!registrationActive && !committed) {
    throw new RuntimeError("worktree removal registration disappeared before commit");
  }
  if (committed && (physicalAtPath || physicalInQuarantine)) {
    throw new RuntimeError("committed physical worktree removal reappeared");
  }
  if (phase === "physical-removal-intent"
    && physicalPresent
    && !physicalAtPath
    && !physicalInQuarantine) {
    throw new RuntimeError(
      "intended physical worktree removal has no provable original or quarantine",
    );
  }
  const physicalGone = !physicalAtPath && !physicalInQuarantine;
  const rollback = phase === "registration-intent"
    ? !physicalPresent || physicalAtPath
    : phase === "physical-removal-intent"
      ? (physicalPresent ? !physicalGone : physicalGone)
      : phase === "registration-staged"
        && (physicalPresent ? physicalAtPath : physicalGone);
  if (!rollback && phase === "registration-staged") {
    throw new RuntimeError("staged worktree removal physical state is inconsistent");
  }
  return {
    action: rollback ? "rollback" : "complete",
    verifyRegistrationBacklink: registrationActive && !committed,
    quarantinePhysical: !rollback && phase === "physical-removal-started" && physicalAtPath,
  };
}
