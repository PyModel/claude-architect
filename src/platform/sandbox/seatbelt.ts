import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, normalize, parse, relative, resolve } from "node:path";
import type { ProducerInvocation } from "../../producers/producer-adapter.js";

export interface SeatbeltPolicy {
  worktreePath: string;
  tempHome: string | null;
  allowNetwork: boolean;
  extraWritableRoots?: string[];
  /** false confines temporary files to `tempHome` instead of the shared tmp roots. */
  sharedTemp?: boolean;
  /**
   * Roots no grant may reach (the runtime-owned Producer HOME root): denied
   * after every allow, then only `tempHome` is reopened. SBPL applies the last
   * matching rule, so this holds even when a root sits under shared temp or an
   * inherited-state grant.
   */
  protectedRoots?: string[];
}

/**
 * Builds a policy for read-only roles such as reviewers and clean-room verifiers.
 * The producer may write only to its temp home; the worktree and repo remain read-only.
 */
export function buildReadOnlySeatbeltPolicy(
  args: { tempHome: string | null; protectedRoots?: string[] },
): SeatbeltPolicy {
  return {
    worktreePath: "",
    tempHome: args.tempHome,
    protectedRoots: [...(args.protectedRoots ?? [])],
    // Read-only roles ARE model sessions: they must reach the provider API.
    // The confinement goal here is write-protection, not offline isolation —
    // matching the edit lane, where Codex's native sandbox permits its own
    // API traffic while denying out-of-worktree writes.
    allowNetwork: true,
  };
}

export function buildWriteSeatbeltPolicy(args: {
  worktreePath: string;
  tempHome: string | null;
  extraWritableRoots: string[];
  protectedRoots?: string[];
}): SeatbeltPolicy {
  return {
    worktreePath: args.worktreePath,
    tempHome: args.tempHome,
    allowNetwork: true,
    extraWritableRoots: [...args.extraWritableRoots],
    protectedRoots: [...(args.protectedRoots ?? [])],
  };
}

function sbPath(path: string): string {
  for (const character of path) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint < 0x20 || codePoint === 0x7f)) {
      throw new Error(`seatbelt: control character in path: ${JSON.stringify(path)}`);
    }
  }
  return `"${path.replace(/\\/gu, "\\\\").replace(/"/gu, '\\"')}"`;
}

/**
 * A regex matching only entries strictly beneath `path`. Reopening a HOME with
 * `subpath` would also match the HOME pathname itself, letting the Producer
 * rename its HOME out of the protected root or recreate it.
 */
function sbContentsRegex(path: string): string {
  sbPath(path);
  if (path.includes('"')) throw new Error(`seatbelt: quote in path: ${JSON.stringify(path)}`);
  const escaped = path.replace(/\/+$/u, "").replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return `#"^${escaped}/"`;
}

function isDeclaredStateRoot(
  normalized: string,
  invocation: ProducerInvocation,
  policy: SeatbeltPolicy,
): boolean {
  const roots: string[] = [];

  const homeCandidates = [
    invocation.env?.HOME,
    invocation.env?.USERPROFILE,
    process.env.HOME,
    process.env.USERPROFILE,
  ];
  try {
    homeCandidates.push(homedir());
  } catch {}

  for (const candidate of homeCandidates) {
    if (typeof candidate === "string" && candidate.length > 0 && candidate !== "/") {
      roots.push(resolve(candidate));
    }
  }

  const stateEnvs = [
    "CLAUDE_CONFIG_DIR",
    "OPENCODE_CONFIG_DIR",
    "XDG_DATA_HOME",
    "XDG_STATE_HOME",
    "XDG_CONFIG_HOME",
    "PI_CONFIG_DIR",
    "PYTHINKER_SHARE_DIR",
    "GEMINI_CLI_HOME",
  ];
  for (const envKey of stateEnvs) {
    const val = invocation.env?.[envKey] ?? process.env[envKey];
    if (typeof val === "string" && val.length > 0 && val !== "/") {
      roots.push(resolve(val));
    }
  }

  if (policy.extraWritableRoots) {
    for (const root of policy.extraWritableRoots) {
      if (typeof root === "string" && root.length > 0 && root !== "/") {
        roots.push(resolve(root));
      }
    }
  }

  for (const root of roots) {
    if (normalized === root) return true;
    const rel = relative(root, normalized);
    if (!rel.startsWith("..") && !isAbsolute(rel)) return true;
  }

  const userHomePattern = /^(\/Users\/[^/]+|\/home\/[^/]+|\/root)(?:\/.*)?$/u;
  const winUserHomePattern = /^(?:[a-zA-Z]:)?\\Users\\[^\\]+(?:\\.*)?$/u;
  return userHomePattern.test(normalized) || winUserHomePattern.test(normalized);
}

function isValidInheritedStatePath(
  path: string,
  invocation: ProducerInvocation,
  policy: SeatbeltPolicy,
): boolean {
  if (typeof path !== "string" || path.trim().length === 0) return false;
  if (!isAbsolute(path)) return false;
  const parsed = parse(path);
  if (path === "/" || path === parsed.root) return false;
  const normalized = normalize(path);
  if (normalized === "/" || normalized === parsed.root) return false;
  if (resolve(path) === "/" || resolve(path) === parsed.root) return false;
  return isDeclaredStateRoot(normalized, invocation, policy);
}

/**
 * State the Producer declared it must write while running with the real HOME.
 * A temporary home replaces that state wholesale, so the declaration is moot.
 * Every entry must be absolute, under home or a declared state root, and never root (`/`).
 * Any invalid entry fails closed: no grants are emitted.
 */
function inheritedStateWritablePaths(
  invocation: ProducerInvocation,
  policy: SeatbeltPolicy,
): string[] {
  if (policy.tempHome !== null) return [];
  const declared = invocation.inheritedStateWritablePaths;
  if (!declared || declared.length === 0) return [];

  for (const entry of declared) {
    if (!isValidInheritedStatePath(entry, invocation, policy)) {
      return [];
    }
  }

  return [...declared];
}

/**
 * Credential stores an untrusted process never needs. Reads are otherwise
 * allowed (toolchains, caches, the Producer's own login state), and network is
 * allowed for model traffic, so these are the secrets that would be worth
 * exfiltrating. A tool that needs one of them is not a delegated workload.
 */
const CREDENTIAL_PATHS = [
  ".ssh",
  ".aws",
  ".azure",
  ".gnupg",
  ".kube",
  ".docker",
  ".netrc",
  ".git-credentials",
  ".config/gh",
  ".config/gcloud",
];

function credentialReadDenials(): string[] {
  const home = process.env.HOME ?? homedir();
  if (!isAbsolute(home) || resolve(home) === "/") return [];
  return [...new Set(CREDENTIAL_PATHS.flatMap(entry => {
    const candidate = resolve(home, entry);
    try {
      return [candidate, realpathSync(candidate)];
    } catch {
      return [candidate];
    }
  }))];
}

function withRealpaths(paths: Array<string | null | undefined>): string[] {
  return [...new Set(paths
    .filter((path): path is string => typeof path === "string" && path.length > 0)
    .flatMap(path => {
      try {
        return [path, realpathSync(path)];
      } catch {
        return [path];
      }
    }))];
}

function buildProfile(policy: SeatbeltPolicy, additionalWritable: string[]): string {
  const writable = withRealpaths([
    policy.worktreePath,
    policy.tempHome,
    ...(policy.sharedTemp === false ? [] : [process.env.TMPDIR ?? "/private/tmp", "/private/tmp"]),
    "/dev",
    ...(policy.extraWritableRoots ?? []),
    ...additionalWritable,
  ]);
  const protectedRoots = withRealpaths(policy.protectedRoots ?? []);
  const lines = [
    "(version 1)",
    "(allow default)",
    "(deny file-write*)",
    ...writable.map(path => `(allow file-write* (subpath ${sbPath(path)}))`),
    '(allow file-write* (literal "/dev/null") (literal "/dev/tty"))',
    ...protectedRoots.map(path => `(deny file-write* (subpath ${sbPath(path)}))`),
    ...(protectedRoots.length === 0
      ? []
      : withRealpaths([policy.tempHome]).map(path => `(allow file-write* (regex ${sbContentsRegex(path)}))`)),
    ...credentialReadDenials().map(path => `(deny file-read* (subpath ${sbPath(path)}))`),
  ];
  if (!policy.allowNetwork) lines.push("(deny network*)");
  return lines.join("\n");
}

export function buildSeatbeltProfile(policy: SeatbeltPolicy): string {
  return buildProfile(policy, []);
}

export function wrapInvocationWithSeatbelt(
  invocation: ProducerInvocation,
  policy: SeatbeltPolicy,
): ProducerInvocation {
  const profile = buildProfile(policy, inheritedStateWritablePaths(invocation, policy));
  const inner = [
    invocation.executable.command,
    ...invocation.executable.prefixArgs,
    ...invocation.args,
  ];
  return {
    ...invocation,
    executable: {
      kind: "native",
      command: "/usr/bin/sandbox-exec",
      prefixArgs: [],
      resolvedFrom: `seatbelt:${invocation.executable.resolvedFrom}`,
    },
    args: ["-p", profile, ...inner],
  };
}

/**
 * Confine a trusted-runtime command (project verification) that executes
 * Producer-authored code: writes only to its worktree and scratch directory.
 */
export function seatbeltArgv(
  policy: { worktreePath: string; scratchDir: string; protectedRoots?: string[] },
  argv: readonly string[],
): { command: string; args: string[] } {
  const profile = buildProfile({
    worktreePath: policy.worktreePath,
    tempHome: policy.scratchDir,
    allowNetwork: true,
    sharedTemp: false,
    protectedRoots: [...(policy.protectedRoots ?? [])],
  }, []);
  return { command: "/usr/bin/sandbox-exec", args: ["-p", profile, ...argv] };
}
