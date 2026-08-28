import { realpathSync } from "node:fs";
import type { ProducerInvocation } from "../../producers/producer-adapter.js";

export interface SeatbeltPolicy {
  worktreePath: string;
  tempHome: string | null;
  allowNetwork: boolean;
  extraWritableRoots?: string[];
}

/**
 * Builds a policy for read-only roles such as reviewers and clean-room verifiers.
 * The producer may write only to its temp home; the worktree and repo remain read-only.
 */
export function buildReadOnlySeatbeltPolicy(
  args: { tempHome: string | null },
): SeatbeltPolicy {
  return {
    worktreePath: "",
    tempHome: args.tempHome,
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
}): SeatbeltPolicy {
  return {
    worktreePath: args.worktreePath,
    tempHome: args.tempHome,
    allowNetwork: true,
    extraWritableRoots: [...args.extraWritableRoots],
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
 * State the Producer declared it must write while running with the real HOME.
 * A temporary home replaces that state wholesale, so the declaration is moot.
 */
function inheritedStateWritablePaths(
  invocation: ProducerInvocation,
  policy: SeatbeltPolicy,
): string[] {
  if (policy.tempHome !== null) return [];
  return [...(invocation.inheritedStateWritablePaths ?? [])];
}

function buildProfile(policy: SeatbeltPolicy, additionalWritable: string[]): string {
  const writable = [...new Set([
    policy.worktreePath,
    policy.tempHome,
    process.env.TMPDIR ?? "/private/tmp",
    "/private/tmp",
    "/dev",
    ...(policy.extraWritableRoots ?? []),
    ...additionalWritable,
  ]
    .filter((path): path is string => typeof path === "string" && path.length > 0)
    .flatMap(path => {
      try {
        return [path, realpathSync(path)];
      } catch {
        return [path];
      }
    }))];
  const lines = [
    "(version 1)",
    "(allow default)",
    "(deny file-write*)",
    ...writable.map(path => `(allow file-write* (subpath ${sbPath(path)}))`),
    '(allow file-write* (literal "/dev/null") (literal "/dev/tty"))',
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
