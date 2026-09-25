import { access, lstat, opendir, readlink, realpath } from "node:fs/promises";
import { gitSucceeded as succeeded } from "./checked-git.js";
import path from "node:path";
import { getPlatformServices } from "../platform/select-platform.js";
import { canonicalizeForScope } from "../platform/windows-platform-services.js";
import { git } from "./git-exec.js";
import { gitPathOutput } from "./git-output.js";

export interface PreconditionOptions {
  writeAllowlist?: string[];
}

export type PreconditionResult =
  | { ok: true; baseCommitOid: string; gitCommonDir: string }
  | { ok: false; reason: string; detail?: string[] };

const MAX_DETAIL_ENTRIES = 20;

function boundedDetail(lines: string[]): string[] {
  if (lines.length <= MAX_DETAIL_ENTRIES) return lines;
  return [...lines.slice(0, MAX_DETAIL_ENTRIES), `… and ${lines.length - MAX_DETAIL_ENTRIES} more`];
}

const IN_PROGRESS_PATHS = [
  "MERGE_HEAD",
  "rebase-merge",
  "rebase-apply",
  "CHERRY_PICK_HEAD",
  "REVERT_HEAD",
  "sequencer",
  "BISECT_LOG",
] as const;
const MAX_NESTED_REPOSITORY_SCAN_ENTRIES = 10_000;

export type InProgressOperationResult = "clear" | "in-progress" | "scan-failed";


async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

export async function checkInProgressOperation(
  checkoutPath: string,
  runGit: typeof git = git,
): Promise<InProgressOperationResult> {
  const gitDirectoryResult = await runGit(checkoutPath, [
    "rev-parse",
    "--path-format=absolute",
    "--git-dir",
  ]);
  if (!succeeded(gitDirectoryResult)) return "scan-failed";
  try {
    const gitDirectory = gitPathOutput(gitDirectoryResult.stdout, "Git directory");
    return (await Promise.all(IN_PROGRESS_PATHS.map(relative =>
      exists(path.join(gitDirectory, relative))))).some(Boolean)
      ? "in-progress"
      : "clear";
  } catch {
    return "scan-failed";
  }
}

function segmentMatches(pattern: string, value: string): boolean {
  const expression = pattern
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\*+/g, ".*");
  return new RegExp(`^${expression}$`).test(value);
}

function patternOverlapsRepository(pattern: string, repositoryRoot: string): boolean {
  const patternSegments = pattern.replace(/\\/g, "/").replace(/^\.\//, "").split("/").filter(Boolean);
  const rootSegments = repositoryRoot.split("/").filter(Boolean);
  const visited = new Set<string>();

  function overlaps(patternIndex: number, rootIndex: number): boolean {
    if (rootIndex === rootSegments.length) return true;
    if (patternIndex === patternSegments.length) return false;
    const key = `${patternIndex}:${rootIndex}`;
    if (visited.has(key)) return false;
    visited.add(key);

    const patternSegment = patternSegments[patternIndex]!;
    if (patternSegment === "**") {
      return overlaps(patternIndex + 1, rootIndex) || overlaps(patternIndex, rootIndex + 1);
    }
    return segmentMatches(patternSegment, rootSegments[rootIndex]!)
      && overlaps(patternIndex + 1, rootIndex + 1);
  }

  return overlaps(0, 0);
}

function indexPathsWithMode(output: string, mode: "120000" | "160000"): Set<string> {
  const paths = new Set<string>();
  for (const record of output.split("\0")) {
    if (!record.startsWith(`${mode} `)) continue;
    const separator = record.indexOf("\t");
    if (separator !== -1) paths.add(record.slice(separator + 1).split(path.sep).join("/"));
  }
  return paths;
}

function pathIsWithin(root: string, candidate: string): boolean {
  if (getPlatformServices().os === "win32") {
    return canonicalizeForScope(candidate, root);
  }
  const relative = path.relative(root, candidate);
  return relative === "" || (
    relative !== ".."
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative)
  );
}

function pathsIdentifySameLocation(left: string, right: string): boolean {
  if (getPlatformServices().os === "win32") {
    return canonicalizeForScope(left, right) && canonicalizeForScope(right, left);
  }
  return left === right;
}

function hasCode(error: unknown, codes: readonly string[]): boolean {
  return typeof error === "object" && error !== null && "code" in error
    && codes.includes(String(error.code));
}

async function isSafeTrackedFileSymlink(
  repositoryRoot: string,
  symlinkPath: string,
  relativePath: string,
  trackedSymlinks: Set<string>,
): Promise<boolean> {
  if (!trackedSymlinks.has(relativePath)) return false;

  let linkTarget: string;
  try {
    linkTarget = await readlink(symlinkPath);
  } catch (error) {
    if (hasCode(error, ["ENOENT", "ENOTDIR", "ELOOP"])) return false;
    throw error;
  }
  if (path.isAbsolute(linkTarget)) return false;

  const lexicalTarget = path.resolve(path.dirname(symlinkPath), linkTarget);
  if (!pathIsWithin(repositoryRoot, lexicalTarget)) return false;
  if (pathIsWithin(path.join(repositoryRoot, ".git"), lexicalTarget)) return false;

  let target: string;
  try {
    target = await realpath(symlinkPath);
  } catch (error) {
    if (hasCode(error, ["ENOENT", "ENOTDIR", "ELOOP"])) return false;
    throw error;
  }

  if (!pathsIdentifySameLocation(lexicalTarget, target)) return false;
  if (!pathIsWithin(repositoryRoot, target)) return false;
  if (pathIsWithin(path.join(repositoryRoot, ".git"), target)) return false;
  return (await lstat(target)).isFile();
}

async function findNestedRepositories(
  repositoryRoot: string,
  registeredSubmodules: Set<string>,
  trackedSymlinks: Set<string>,
  writeAllowlist: string[],
): Promise<string[]> {
  const nested = [...registeredSubmodules].filter(submodulePath =>
    writeAllowlist.some(pattern => patternOverlapsRepository(pattern, submodulePath)));
  let scannedEntries = 0;
  const pendingDirectories = [{ path: repositoryRoot, relativePath: "" }];

  while (pendingDirectories.length > 0) {
    const directory = pendingDirectories.pop()!;
    if (directory.relativePath !== "") {
      try {
        await lstat(path.join(directory.path, ".git"));
        nested.push(directory.relativePath);
        continue;
      } catch (error) {
        if (typeof error !== "object" || error === null || !("code" in error)
          || !["ENOENT", "ENOTDIR"].includes(String(error.code))) throw error;
      }
    }

    const childDirectories: { path: string; relativePath: string }[] = [];
    const entries = await opendir(directory.path);
    for await (const entry of entries) {
      scannedEntries += 1;
      if (scannedEntries > MAX_NESTED_REPOSITORY_SCAN_ENTRIES) {
        throw new Error("nested repository scan entry budget exceeded");
      }
      if (entry.name === ".git") continue;
      const child = path.join(directory.path, entry.name);
      const relativeChild = path.relative(repositoryRoot, child).split(path.sep).join("/");
      if (registeredSubmodules.has(relativeChild)) continue;
      if (!writeAllowlist.some(pattern => patternOverlapsRepository(pattern, relativeChild))) continue;
      if (entry.isSymbolicLink()) {
        if (!await isSafeTrackedFileSymlink(
          repositoryRoot,
          child,
          relativeChild,
          trackedSymlinks,
        )) {
          nested.push(relativeChild);
        }
        continue;
      }
      if (!entry.isDirectory()) continue;
      childDirectories.push({ path: child, relativePath: relativeChild });
    }

    for (let index = childDirectories.length - 1; index >= 0; index -= 1) {
      pendingDirectories.push(childDirectories[index]!);
    }
  }

  return nested;
}

export async function checkPreconditions(
  repoRoot: string,
  options: PreconditionOptions = {},
): Promise<PreconditionResult> {
  const { canonical } = await getPlatformServices().canonicalizePath(repoRoot);

  const bare = await git(canonical, ["rev-parse", "--is-bare-repository"]);
  if (!succeeded(bare)) return { ok: false, reason: "not-a-repository" };
  if (bare.stdout.trim() === "true") return { ok: false, reason: "bare-repository" };

  const head = await git(canonical, ["rev-parse", "--verify", "HEAD"]);
  if (!succeeded(head)) return { ok: false, reason: "unborn-repository" };
  const baseCommitOid = head.stdout.trim();

  const inProgress = await checkInProgressOperation(canonical);
  if (inProgress === "in-progress") return { ok: false, reason: "in-progress-operation" };
  if (inProgress === "scan-failed") {
    return { ok: false, reason: "in-progress-operation-scan-failed" };
  }

  const submodules = await git(canonical, ["submodule", "status", "--recursive"]);
  if (!succeeded(submodules)) return { ok: false, reason: "git-command-failed" };
  if (/^[+-]/m.test(submodules.stdout)) {
    return {
      ok: false,
      reason: "changed-submodule",
      detail: boundedDetail(submodules.stdout.split("\n").filter(line => /^[+-]/.test(line))),
    };
  }

  const status = await git(canonical, [
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
    "--ignore-submodules=none",
  ]);
  if (!succeeded(status)) return { ok: false, reason: "git-command-failed" };
  if (status.stdout.length > 0) {
    return {
      ok: false,
      reason: "dirty-checkout",
      detail: boundedDetail(status.stdout.split("\n").filter(line => line.length > 0)),
    };
  }

  const sparseCheckout = await git(canonical, ["config", "--bool", "core.sparseCheckout"]);
  if (sparseCheckout.exitCode !== 0 && sparseCheckout.exitCode !== 1) {
    return { ok: false, reason: "git-command-failed" };
  }
  if (sparseCheckout.stdout.trim() === "true") return { ok: false, reason: "sparse-checkout" };

  const indexEntries = await git(canonical, ["ls-files", "-v"]);
  if (!succeeded(indexEntries)) return { ok: false, reason: "git-command-failed" };
  if (/^[Ssh] /m.test(indexEntries.stdout)) return { ok: false, reason: "skip-worktree-entries" };

  if (options.writeAllowlist !== undefined && options.writeAllowlist.length > 0) {
    const stagedEntries = await git(canonical, ["ls-files", "--stage", "-z"]);
    if (!succeeded(stagedEntries)) return { ok: false, reason: "git-command-failed" };
    const registeredSubmodules = indexPathsWithMode(stagedEntries.stdout, "160000");
    const trackedSymlinks = indexPathsWithMode(stagedEntries.stdout, "120000");
    let nestedRepositories: string[];
    try {
      nestedRepositories = await findNestedRepositories(
        canonical,
        registeredSubmodules,
        trackedSymlinks,
        options.writeAllowlist,
      );
    } catch {
      return { ok: false, reason: "nested-repository-scan-failed" };
    }
    const offending = nestedRepositories.filter(nestedRoot =>
      options.writeAllowlist!.some(pattern => patternOverlapsRepository(pattern, nestedRoot)));
    if (offending.length > 0) {
      return { ok: false, reason: "nested-repository", detail: boundedDetail(offending) };
    }
  }

  const commonDirectoryResult = await git(canonical, [
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir",
  ]);
  if (!succeeded(commonDirectoryResult)) return { ok: false, reason: "git-command-failed" };
  const gitCommonDir = await realpath(gitPathOutput(
    commonDirectoryResult.stdout,
    "Git common directory",
  ));
  return { ok: true, baseCommitOid, gitCommonDir };
}
