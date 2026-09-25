import { redact } from "../runtime/redaction.js";
import { RuntimeError } from "../util/errors.js";
import { git, gitSubcommand, type GitExecOptions, type GitResult } from "./git-exec.js";

const MAX_DIAGNOSTIC_LENGTH = 2_000;

export function gitFailure(action: string, result: GitResult): RuntimeError {
  const diagnostic = redact(result.stderr || result.stdout).trim().slice(0, MAX_DIAGNOSTIC_LENGTH);
  return new RuntimeError(`${action} failed${diagnostic ? `: ${diagnostic}` : ""}`);
}

/** Exit 0 with complete output — the only Git result any caller may trust. */
export function gitSucceeded(result: GitResult): boolean {
  return result.exitCode === 0
    && result.truncated?.stdout !== true
    && result.truncated?.stderr !== true;
}

/**
 * Run Git and return stdout only when the command succeeded and its output is
 * complete. Every caller treats the result as the whole answer — a clipped
 * diff or path list would silently hide candidate content — so truncation is a
 * failure, never a partial success.
 */
export async function gitChecked(
  cwd: string,
  args: string[],
  options?: GitExecOptions,
): Promise<string> {
  const result = await git(cwd, args, options);
  const command = gitSubcommand(args) ?? "command";
  if (result.exitCode !== 0) throw gitFailure(`git ${command}`, result);
  if (!gitSucceeded(result)) {
    throw new RuntimeError(`git ${command} output exceeded the runtime bound`, {
      command,
      truncated: result.truncated,
    });
  }
  return result.stdout;
}

/**
 * The diff a reviewer reads. Attributes come from the trusted base commit, so a
 * Producer-committed `.gitattributes` cannot mark source as binary (`-diff`)
 * and hide it; genuinely binary content is still detected from its bytes.
 * Diff drivers never run on Producer bytes.
 */
export function reviewDiffArgs(base: string, head: string, extra: string[] = []): string[] {
  return [
    `--attr-source=${base}`,
    "diff",
    "--no-color",
    "--no-ext-diff",
    "--no-textconv",
    ...extra,
    base,
    head,
    "--",
  ];
}

export async function reviewDiff(
  cwd: string,
  base: string,
  head: string,
  options?: GitExecOptions,
): Promise<string> {
  return await gitChecked(cwd, reviewDiffArgs(base, head), options);
}
