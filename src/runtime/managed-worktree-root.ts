import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { ensurePrivateDirectory, syncDirectoryMetadata } from "../platform/durable-directory.js";
import { openDurableDirectorySession, writeAtomic } from "../platform/durable-write.js";
import { RuntimeError, errorCode, isMissing } from "../util/errors.js";
import { platformPathsEqual } from "../util/platform-path.js";
import { readStableRegularFile } from "../util/stable-file.js";
import type { git } from "../git/git-exec.js";
import { resolveStateDir } from "./state-dir.js";

/**
 * Managed worktrees live beside the checkout they were made from, in a
 * namespace the runtime owns exclusively:
 *
 *     <checkout>/.worktrees/claude-architect/<managed-id>
 *
 * `.worktrees/` itself is shared with the user and never modified beyond being
 * created; only the `claude-architect` namespace is private, self-ignoring, and
 * swept by recovery. Each namespace is recorded in the state directory so
 * startup recovery can find orphans without knowing which checkouts exist.
 */
export const WORKTREES_DIRECTORY = ".worktrees";
export const WORKTREE_NAMESPACE = "claude-architect";

const IGNORE_FILE = ".gitignore";
const IGNORE_CONTENTS = "*\n";
const ROOT_RECORDS_DIRECTORY = "worktree-roots";
const MAX_ROOT_RECORD_BYTES = 4_096n;
const ROOT_RECORD_NAME = /^[0-9a-f]{64}$/u;

export function managedWorktreeRootFor(checkoutRoot: string): string {
  return path.join(path.resolve(checkoutRoot), WORKTREES_DIRECTORY, WORKTREE_NAMESPACE);
}

/**
 * One namespace per repository, in its main checkout, so a delegation started
 * from a linked worktree (including a managed one) never nests worktrees
 * inside another checkout. Git lists the main worktree first; a bare
 * repository has none, so its namespace stays beside the given checkout.
 */
export async function repositoryNamespaceRoot(
  checkoutRoot: string,
  runGit: typeof git,
): Promise<string> {
  const listed = await runGit(checkoutRoot, ["worktree", "list", "--porcelain", "-z"]);
  if (listed.exitCode !== 0
    || listed.truncated?.stdout === true
    || listed.truncated?.stderr === true) {
    throw new RuntimeError("repository worktrees could not be listed");
  }
  const records = listed.stdout.split("\0");
  const main = records[0];
  if (main === undefined || !main.startsWith("worktree ")) {
    throw new RuntimeError("repository main worktree could not be identified");
  }
  const firstBlockEnd = records.indexOf("");
  const firstBlock = records.slice(0, firstBlockEnd === -1 ? records.length : firstBlockEnd);
  const base = firstBlock.includes("bare") ? checkoutRoot : main.slice("worktree ".length);
  return managedWorktreeRootFor(await realpath(base));
}

/** Pre-0.53 runtimes kept every managed worktree under the state directory. */
export function legacyManagedWorktreeRoot(stateRoot: string = resolveStateDir()): string {
  return path.join(path.resolve(stateRoot), "worktrees");
}

export function isManagedWorktreeNamespace(root: string): boolean {
  return path.basename(root) === WORKTREE_NAMESPACE
    && path.basename(path.dirname(root)) === WORKTREES_DIRECTORY;
}

/** Entries in a managed root that are part of the namespace, not worktrees. */
export function isNamespaceControlEntry(name: string): boolean {
  return name === IGNORE_FILE;
}

function rootRecordName(root: string): string {
  return createHash("sha256").update(root).digest("hex");
}

async function plainDirectory(directory: string, description: string): Promise<void> {
  const metadata = await lstat(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new RuntimeError(`${description} must be a plain directory`);
  }
}

/**
 * Create (or validate) the private namespace for one checkout, make it ignore
 * itself so the checkout stays clean, and record it for recovery. Idempotent.
 */
export async function prepareManagedWorktreeRoot(
  root: string,
  options: { syncDirectory?: (directory: string) => Promise<void> } = {},
) {
  if (!isManagedWorktreeNamespace(root) || !path.isAbsolute(root)) {
    throw new RuntimeError("managed worktree root is outside the managed namespace");
  }
  const shared = path.dirname(root);
  try {
    await mkdir(shared);
  } catch (error) {
    if (errorCode(error) !== "EEXIST") throw error;
  }
  await plainDirectory(shared, "checkout worktrees directory");
  const identity = await ensurePrivateDirectory(root, {
    description: "managed worktree root",
    migratePermissions: true,
    ...(options.syncDirectory === undefined ? {} : { syncDirectory: options.syncDirectory }),
  });
  await ensureNamespaceIgnored(root, options.syncDirectory ?? syncDirectoryMetadata);
  await recordManagedWorktreeRoot(root, options);
  return identity;
}

async function ensureNamespaceIgnored(
  root: string,
  syncDirectory: (directory: string) => Promise<void>,
): Promise<void> {
  const ignorePath = path.join(root, IGNORE_FILE);
  try {
    const handle = await open(
      ignorePath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    try {
      await handle.writeFile(IGNORE_CONTENTS, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await syncDirectory(root);
  } catch (error) {
    if (errorCode(error) !== "EEXIST") throw error;
  }
  const existing = await readStableRegularFile(ignorePath, MAX_ROOT_RECORD_BYTES);
  if (existing === null || existing.toString("utf8") !== IGNORE_CONTENTS) {
    throw new RuntimeError("managed worktree root ignore file was replaced");
  }
}

async function recordManagedWorktreeRoot(
  root: string,
  options: { syncDirectory?: (directory: string) => Promise<void> },
): Promise<void> {
  const session = await openDurableDirectorySession(
    path.join(resolveStateDir(), ROOT_RECORDS_DIRECTORY),
    {
      description: "managed worktree root records",
      privateDirectory: true,
      create: true,
      ...(options.syncDirectory === undefined
        ? {}
        : { policy: { syncDirectory: options.syncDirectory } }),
    },
  );
  try {
    await writeAtomic(session, rootRecordName(root), `${root}\n`, "immutable");
  } finally {
    await session.close();
  }
}

/**
 * Every managed worktree root recovery must sweep: the legacy state-directory
 * root plus each recorded checkout namespace that still exists. A record that
 * does not name its own key, or names a path outside the namespace, is
 * reported rather than trusted.
 */
export async function managedWorktreeRoots(): Promise<{ roots: string[]; malformed: string[] }> {
  const roots = [legacyManagedWorktreeRoot()];
  const malformed: string[] = [];
  const recordsDirectory = path.join(resolveStateDir(), ROOT_RECORDS_DIRECTORY);
  let names: string[];
  try {
    names = await readdir(recordsDirectory);
  } catch (error) {
    if (isMissing(error)) return { roots, malformed };
    throw error;
  }
  for (const name of names.sort()) {
    if (name.startsWith(".")) continue;
    const recordPath = path.join(recordsDirectory, name);
    const bytes = ROOT_RECORD_NAME.test(name)
      ? await readStableRegularFile(recordPath, MAX_ROOT_RECORD_BYTES)
      : null;
    const root = bytes?.toString("utf8").replace(/\n$/u, "") ?? "";
    if (bytes === null
      || !path.isAbsolute(root)
      || path.resolve(root) !== root
      || !isManagedWorktreeNamespace(root)
      || rootRecordName(root) !== name) {
      malformed.push(recordPath);
      continue;
    }
    roots.push(root);
  }
  return { roots, malformed };
}

/** True when `root` is the legacy root or a recorded checkout namespace. */
export async function isManagedWorktreeRoot(root: string): Promise<boolean> {
  const legacy = legacyManagedWorktreeRoot();
  const canonicalLegacy = await realpath(legacy).catch(() => legacy);
  if (platformPathsEqual(root, legacy) || platformPathsEqual(root, canonicalLegacy)) return true;
  if (!isManagedWorktreeNamespace(root)) return false;
  const { roots } = await managedWorktreeRoots();
  return roots.some(candidate => platformPathsEqual(candidate, root));
}
