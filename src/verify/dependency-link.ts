import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

export type DependencyLink =
  | "inherited"
  | "skipped-lockfile-mismatch"
  | "skipped-cow-unsupported"
  | "none";

const execFileAsync = promisify(execFile);

type DependencyExecFile = (
  file: string,
  args: readonly string[],
  options: { timeout: number },
) => Promise<unknown>;

export interface DependencyLinkDependencies {
  execFile?: DependencyExecFile;
  platform?: NodeJS.Platform;
}

const LOCKFILES = ["package-lock.json", "bun.lockb", "pnpm-lock.yaml", "yarn.lock"] as const;
const COPY_TIMEOUT_MS = 120_000;
const MAX_LOCKFILE_BYTES = 64 * 1024 * 1024;
// The system `cp` by absolute path: a PATH lookup would let the checkout's
// environment choose the program that copies the dependency tree.
const SYSTEM_CP = ["/bin/cp", "/usr/bin/cp"] as const;

async function systemCp(): Promise<string> {
  for (const candidate of SYSTEM_CP) {
    if (await exists(candidate)) return candidate;
  }
  throw new Error("system cp is unavailable");
}

type CowStrategy = "clonefile" | "reflink" | "unsupported";

function cowClone(
  platform: NodeJS.Platform,
  source: string,
  target: string,
): { args: string[]; strategy: Exclude<CowStrategy, "unsupported"> } | null {
  if (platform === "darwin") {
    return { args: ["-Rc", source, target], strategy: "clonefile" };
  }
  if (platform === "linux") {
    return { args: ["-a", "--reflink=always", source, target], strategy: "reflink" };
  }
  return null;
}

async function exists(candidate: string): Promise<boolean> {
  try {
    await access(candidate);
    return true;
  } catch {
    return false;
  }
}

export async function probeCowSupport(
  dependencies: DependencyLinkDependencies = {},
): Promise<{ cowSupported: boolean; strategy: CowStrategy }> {
  const platform = dependencies.platform ?? process.platform;
  if (platform !== "darwin" && platform !== "linux") {
    return { cowSupported: false, strategy: "unsupported" };
  }
  const probeRoot = await mkdtemp(path.join(tmpdir(), "ca-cow-probe-"));
  try {
    const source = path.join(probeRoot, "source");
    const target = path.join(probeRoot, "target");
    const clone = cowClone(platform, source, target);
    if (clone === null) return { cowSupported: false, strategy: "unsupported" };

    await mkdir(source);
    await writeFile(path.join(source, "sentinel"), "probe\n");
    try {
      await (dependencies.execFile ?? execFileAsync)(await systemCp(), clone.args, {
        timeout: COPY_TIMEOUT_MS,
      });
      return { cowSupported: true, strategy: clone.strategy };
    } catch {
      return { cowSupported: false, strategy: clone.strategy };
    }
  } finally {
    await rm(probeRoot, { recursive: true, force: true });
  }
}

export async function linkPrimaryDependencies(
  primaryRepo: string,
  worktreePath: string,
  dependencies: DependencyLinkDependencies = {},
): Promise<DependencyLink> {
  const primaryModules = path.join(primaryRepo, "node_modules");
  if (!await exists(primaryModules)) return "none";

  const [primaryLockfiles, worktreeLockfiles] = await Promise.all([
    Promise.all(LOCKFILES.map(lockfile => exists(path.join(primaryRepo, lockfile)))),
    Promise.all(LOCKFILES.map(lockfile => exists(path.join(worktreePath, lockfile)))),
  ]);
  if (!primaryLockfiles.some(Boolean)) return "none";
  if (primaryLockfiles.some((present, index) => present !== worktreeLockfiles[index])) {
    return "skipped-lockfile-mismatch";
  }

  try {
    const comparisons = await Promise.all(LOCKFILES.map(async (lockfile, index) => {
      if (!primaryLockfiles[index]) return true;
      const sizes = await Promise.all([
        stat(path.join(primaryRepo, lockfile)),
        stat(path.join(worktreePath, lockfile)),
      ]);
      if (sizes.some(entry => entry.size > MAX_LOCKFILE_BYTES)
        || sizes[0].size !== sizes[1].size) return false;
      const [primaryLock, worktreeLock] = await Promise.all([
        readFile(path.join(primaryRepo, lockfile)),
        readFile(path.join(worktreePath, lockfile)),
      ]);
      return primaryLock.equals(worktreeLock);
    }));
    if (comparisons.some(matches => !matches)) return "skipped-lockfile-mismatch";
  } catch {
    return "skipped-lockfile-mismatch";
  }

  const targetModules = path.join(worktreePath, "node_modules");
  const platform = dependencies.platform ?? process.platform;
  const clone = cowClone(platform, primaryModules, targetModules);
  if (clone === null) return "skipped-cow-unsupported";

  try {
    await (dependencies.execFile ?? execFileAsync)(await systemCp(), clone.args, {
      timeout: COPY_TIMEOUT_MS,
    });
    return "inherited";
  } catch {
    await rm(targetModules, { recursive: true, force: true });
    return "skipped-cow-unsupported";
  }
}
