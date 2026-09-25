import path from "node:path";
import { getPlatformServices } from "../platform/select-platform.js";
import type { PlatformServices, ResolvedExecutable } from "../platform/platform-services.js";
import { supervise } from "../platform/process-supervisor.js";

export interface GitResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  truncated?: { stdout: boolean; stderr: boolean };
}

export interface GitExecOptions {
  indexFile?: string;
  env?: Record<string, string>;
  stdin?: string;
  maxOutputBytes?: number;
  /**
   * Read the user's configured identity instead of the runtime's fixed one.
   * Only `git var GIT_AUTHOR_IDENT|GIT_COMMITTER_IDENT` may use it: those read
   * configuration and execute nothing, so user and system config are safe to
   * consult for them and for nothing else.
   */
  userIdentity?: boolean;
}

const RUNTIME_IDENTITY = {
  GIT_AUTHOR_NAME: "claude-architect",
  GIT_AUTHOR_EMAIL: "runtime@claude-architect.invalid",
  GIT_COMMITTER_NAME: "claude-architect",
  GIT_COMMITTER_EMAIL: "runtime@claude-architect.invalid",
  GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z",
  GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z",
};
/** The caller's own config selection, honored where user config is read. */
function userConfigEnvironment(): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const key of ["GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM", "GIT_CONFIG_NOSYSTEM"]) {
    const value = process.env[key];
    if (value !== undefined) environment[key] = value;
  }
  return environment;
}

const IDENTITY_VARIABLES = new Set(["GIT_AUTHOR_IDENT", "GIT_COMMITTER_IDENT"]);
const IDENT_LINE = /^([^<>\n]+) <([^<>\n]*)> (\d+ [+-]\d{4})$/;

/**
 * Commit environment for a commit that leaves the runtime (a promotion on the
 * workflow branch): the user's own author and committer, dated now. Internal
 * commits keep the fixed deterministic identity. `null` means Git has no usable
 * identity.
 */
export async function userCommitEnvironment(
  cwd: string,
  run: typeof git = git,
): Promise<Record<string, string> | null> {
  const environment: Record<string, string> = {};
  for (const [role, variable] of [
    ["AUTHOR", "GIT_AUTHOR_IDENT"],
    ["COMMITTER", "GIT_COMMITTER_IDENT"],
  ] as const) {
    const result = await run(cwd, ["var", variable], { userIdentity: true });
    const match = result.exitCode === 0 && result.truncated?.stdout !== true
      ? IDENT_LINE.exec(result.stdout.trim())
      : null;
    if (match === null) return null;
    environment[`GIT_${role}_NAME`] = match[1]!.trim();
    environment[`GIT_${role}_EMAIL`] = match[2]!;
    environment[`GIT_${role}_DATE`] = match[3]!;
  }
  return environment;
}

/**
 * The Git administrative directories of a linked worktree, captured by the
 * trusted runtime before any Producer runs in it.
 */
export interface PinnedGitDirectory {
  gitDir: string;
  commonDir: string;
}

/**
 * A linked worktree finds its repository through the `.git` pointer file inside
 * the checkout, and a Producer can rewrite that file to aim Git at a repository
 * whose configuration runs commands. Once a worktree is pinned, every Git call
 * whose cwd lies inside it names its administrative directories explicitly, so
 * the pointer is never consulted again. Keys are resolved worktree paths.
 */
const pinnedWorktrees = new Map<string, PinnedGitDirectory>();

export function pinWorktreeGitDirectory(worktreePath: string, pin: PinnedGitDirectory): void {
  pinnedWorktrees.set(path.resolve(worktreePath), { ...pin });
}

export function unpinWorktreeGitDirectory(worktreePath: string): void {
  pinnedWorktrees.delete(path.resolve(worktreePath));
}

/** The pinned administrative directories of a managed worktree, if any. */
export function pinnedWorktreeGitDirectory(worktreePath: string): PinnedGitDirectory | undefined {
  const pin = pinnedWorktrees.get(path.resolve(worktreePath));
  return pin === undefined ? undefined : { ...pin };
}

function pinnedEnvironment(cwd: string): Record<string, string> {
  const resolved = path.resolve(cwd);
  for (const [workTree, pin] of pinnedWorktrees) {
    if (resolved === workTree || resolved.startsWith(`${workTree}${path.sep}`)) {
      return { GIT_DIR: pin.gitDir, GIT_COMMON_DIR: pin.commonDir, GIT_WORK_TREE: workTree };
    }
  }
  return {};
}

/**
 * Porcelain commands that honor `diff.<driver>.textconv` or an external diff.
 * A Producer can bind any path to a configured driver through `.gitattributes`,
 * so these never run a driver on the runtime's behalf.
 */
const DRIVER_HONORING_COMMANDS = new Set(["diff", "log", "show", "format-patch", "blame"]);

const DEFAULT_MAX_OUTPUT_BYTES = 8_000_000;
/**
 * Index listings scale with the repository (~60 bytes per tracked file), so
 * the default bound truncated them past ~150k files and every caller failed
 * closed on large monorepos. Truncation still fails closed above this bound.
 */
const INDEX_LISTING_MAX_BYTES = 512 * 1024 * 1024;

/** Index of the Git subcommand, past global options (`-c`/`-C` take a value). */
function subcommandIndex(args: readonly string[]): number {
  let index = 0;
  while (index < args.length && args[index]!.startsWith("-")) {
    index += args[index] === "-c" || args[index] === "-C" ? 2 : 1;
  }
  return index;
}

export function gitSubcommand(args: readonly string[]): string | undefined {
  return args[subcommandIndex(args)];
}

function withoutDiffDrivers(args: string[]): string[] {
  const index = subcommandIndex(args);
  const command = args[index];
  if (command === undefined || !DRIVER_HONORING_COMMANDS.has(command)) return args;
  const flags = command === "blame" ? ["--no-textconv"] : ["--no-textconv", "--no-ext-diff"];
  const missing = flags.filter(flag => !args.includes(flag));
  return [...args.slice(0, index + 1), ...missing, ...args.slice(index + 1)];
}

const FILTER_KEY_PATTERN = "^filter\\..*\\.(clean|smudge|process|required)$";
const LOCAL_DISCOVERY_PATTERN =
  "^(extensions\\.worktreeconfig|filter\\..*\\.(clean|smudge|process|required))$";

function toGitResult(exit: Awaited<ReturnType<typeof supervise>>): GitResult {
  return {
    stdout: exit.stdout,
    stderr: exit.stderr,
    exitCode: exit.exitCode,
    truncated: { ...exit.truncated },
  };
}

function parseLocalDiscovery(stdout: string): {
  filterKeys: string[];
  worktreeConfigEnabled: boolean;
} {
  const filterKeys: string[] = [];
  let worktreeConfigEnabled = false;

  for (const record of stdout.split("\0")) {
    if (record.length === 0) continue;
    const separator = record.indexOf("\n");
    const key = separator === -1 ? record : record.slice(0, separator);
    const value = separator === -1 ? "" : record.slice(separator + 1).trim().toLowerCase();
    if (key.toLowerCase() === "extensions.worktreeconfig") {
      worktreeConfigEnabled = ["true", "yes", "on", "1"].includes(value);
    } else {
      filterKeys.push(key);
    }
  }

  return { filterKeys, worktreeConfigEnabled };
}

function parseNameOnlyDiscovery(stdout: string): string[] {
  return stdout.split("\0").filter(key => key.length > 0);
}

function filterNeutralizations(keys: string[]): { args?: string[]; error?: GitResult } {
  const drivers = new Set<string>();
  for (const key of keys) {
    const match = /^filter\.(.*)\.(clean|smudge|process|required)$/i.exec(key);
    if (match === null) continue;
    const driver = match[1];
    if (driver === undefined || /[=.\n\0]/.test(driver)) {
      return {
        error: {
          stdout: "",
          stderr: "Refusing unsafe Git filter driver name\n",
          exitCode: 2,
        },
      };
    }
    drivers.add(driver);
  }

  const args: string[] = [];
  for (const driver of drivers) {
    args.push(
      "-c", `filter.${driver}.clean=`,
      "-c", `filter.${driver}.smudge=`,
      "-c", `filter.${driver}.process=`,
      "-c", `filter.${driver}.required=false`,
    );
  }
  return { args };
}

/**
 * `git` is the hottest path in the runtime, and resolution walks every PATH
 * entry with an `fs.access` probe per candidate. Cache the result, keyed on the
 * search environment itself so a caller that changes PATH — a test installing a
 * shim, a differently configured host — still resolves afresh.
 */
let resolvedGit: { key: string; executable: ResolvedExecutable } | null = null;

function gitSearchKey(): string {
  // Windows resolution consults `Path` and `PATHEXT` as well as `PATH`.
  return [process.env.PATH, process.env.Path, process.env.PATHEXT].join("\0");
}

async function resolveGit(platformServices: PlatformServices): Promise<ResolvedExecutable> {
  const key = gitSearchKey();
  if (resolvedGit !== null && resolvedGit.key === key) return resolvedGit.executable;
  const executable = await platformServices.resolveExecutable({ name: "git" });
  resolvedGit = { key, executable };
  return executable;
}

export async function git(
  cwd: string,
  args: string[],
  indexFileOrOptions?: string | GitExecOptions,
): Promise<GitResult> {
  const platformServices = getPlatformServices();
  const executable = await resolveGit(platformServices);
  const nullDevice = process.platform === "win32" ? "NUL" : "/dev/null";
  const options = typeof indexFileOrOptions === "string"
    ? { indexFile: indexFileOrOptions }
    : indexFileOrOptions ?? {};
  if (options.userIdentity === true
    && !(args.length === 2 && args[0] === "var" && IDENTITY_VARIABLES.has(args[1]!))) {
    return {
      stdout: "",
      stderr: "userIdentity is limited to git var of a commit identity\n",
      exitCode: 2,
    };
  }
  const maxOutputBytes = options.maxOutputBytes
    ?? (gitSubcommand(args) === "ls-files" ? INDEX_LISTING_MAX_BYTES : DEFAULT_MAX_OUTPUT_BYTES);
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "",
    // Git for Windows special-cases "/dev/null" for config paths; "NUL" is
    // an unreadable file to some builds (Windows ARM64 Git fails on it).
    ...(options.userIdentity === true ? userConfigEnvironment() : {
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
    }),
    GIT_ATTR_NOSYSTEM: "1",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_TERMINAL_PROMPT: "0",
    ...(process.env.HOME ? { HOME: process.env.HOME } : {}),
    ...(process.env.XDG_CONFIG_HOME ? { XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME } : {}),
    ...(options.userIdentity === true ? {} : RUNTIME_IDENTITY),
    ...(options.indexFile ? { GIT_INDEX_FILE: options.indexFile } : {}),
    ...options.env,
    ...pinnedEnvironment(cwd),
  };
  const hardeningArgs = [
    "-c", `core.hooksPath=${nullDevice}`,
    "-c", "core.fsmonitor=false",
    "-c", `core.attributesFile=${nullDevice}`,
    "-c", "core.autocrlf=false",
  ];

  let discoveredFilterKeys: string[] = [];
  if (args[0] !== "init") {
    const localDiscovery = await supervise(platformServices, {
      executable,
      args: [
        ...hardeningArgs,
        "config", "--local", "--includes", "--null", "--get-regexp", LOCAL_DISCOVERY_PATTERN,
      ],
      cwd,
      env,
      timeoutMs: 60_000,
      maxOutputBytes,
    }, {});
    if (localDiscovery.exitCode !== 0 && !(localDiscovery.exitCode === 1 && localDiscovery.stdout === "")) {
      return toGitResult(localDiscovery);
    }

    const local = parseLocalDiscovery(localDiscovery.stdout);
    discoveredFilterKeys = local.filterKeys;
    if (local.worktreeConfigEnabled) {
      const worktreeDiscovery = await supervise(platformServices, {
        executable,
        args: [
          ...hardeningArgs,
          "config", "--worktree", "--includes", "--name-only", "--null",
          "--get-regexp", FILTER_KEY_PATTERN,
        ],
        cwd,
        env,
        timeoutMs: 60_000,
        maxOutputBytes,
      }, {});
      if (worktreeDiscovery.exitCode !== 0
        && !(worktreeDiscovery.exitCode === 1 && worktreeDiscovery.stdout === "")) {
        return toGitResult(worktreeDiscovery);
      }
      discoveredFilterKeys.push(...parseNameOnlyDiscovery(worktreeDiscovery.stdout));
    }
  }

  const neutralizations = filterNeutralizations(discoveredFilterKeys);
  if (neutralizations.error !== undefined) return neutralizations.error;
  const exit = await supervise(platformServices, {
    executable,
    args: [
      ...hardeningArgs,
      ...(neutralizations.args ?? []),
      // Never let Git guess `user@host` from the machine: an identity the user
      // did not configure must surface as missing.
      ...(options.userIdentity === true ? ["-c", "user.useConfigOnly=true"] : []),
      ...withoutDiffDrivers(args),
    ],
    cwd,
    env,
    ...(options.stdin === undefined ? {} : { stdin: options.stdin }),
    timeoutMs: 60_000,
    maxOutputBytes,
  }, {});
  return toGitResult(exit);
}
