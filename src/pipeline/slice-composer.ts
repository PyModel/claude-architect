import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { git, type GitExecOptions, type GitResult } from "../git/git-exec.js";
import { RuntimeError } from "../util/errors.js";

/**
 * Replays one slice's changes onto the head composed from its wave siblings.
 *
 * Slices only share a wave when their write allowlists are pairwise disjoint,
 * and structural verification confines each slice's changes to its own
 * allowlist. Disjoint allowlists therefore imply disjoint changed paths, so the
 * composition is a union and cannot conflict — there is no merge here and no
 * conflict resolution to get wrong. The overlap check below is not the mechanism
 * that makes this safe; it is the assertion that the mechanism held, and it
 * fails closed if confinement was ever broken.
 */
const NULL_OID = "0000000000000000000000000000000000000000";

export interface ComposedSliceChange {
  path: string;
  mode: string;
  oid: string;
  deleted: boolean;
}

export function parseRawDiffEntries(raw: string): ComposedSliceChange[] {
  // `git diff --raw -z` emits ":<srcmode> <dstmode> <srcoid> <dstoid> <status>\0<path>\0",
  // with a second path field for renames — which --no-renames rules out.
  const fields = raw.split("\0");
  const changes: ComposedSliceChange[] = [];
  for (let index = 0; index < fields.length; index += 1) {
    const meta = fields[index];
    if (meta === undefined || !meta.startsWith(":")) continue;
    const parts = meta.slice(1).split(/\s+/u);
    const changed = fields[index + 1];
    if (parts.length < 5 || changed === undefined || changed.length === 0) continue;
    index += 1;
    const [, dstMode, , dstOid, status] = parts as [string, string, string, string, string];
    changes.push({
      path: changed,
      mode: dstMode,
      oid: dstOid,
      deleted: status.startsWith("D") || dstOid === NULL_OID,
    });
  }
  return changes;
}

function failure(action: string, result: GitResult): RuntimeError {
  const diagnostic = (result.stderr || result.stdout).trim();
  return new RuntimeError(`${action} failed${diagnostic ? `: ${diagnostic}` : ""}`);
}

async function checked(
  cwd: string,
  args: string[],
  options?: GitExecOptions,
  runGit: typeof git = git,
): Promise<string> {
  const result = await runGit(cwd, args, options);
  if (result.exitCode !== 0) throw failure(`git ${args[0] ?? ""}`, result);
  return result.stdout;
}

export interface ComposeSliceArgs {
  checkoutPath: string;
  /** Commit the wave's earlier slices have already been composed onto. */
  head: string;
  /** Commit every slice in the wave started from. */
  base: string;
  sliceCommit: string;
  sliceIndex: number;
  runId: string;
  objectReadOptions?: GitExecOptions;
  git?: typeof git;
}

export async function composeSliceOntoHead(args: ComposeSliceArgs): Promise<string> {
  const runGit = args.git ?? git;
  if (args.head === args.base) return args.sliceCommit;

  const changes = parseRawDiffEntries(await checked(
    args.checkoutPath,
    // Raw output abbreviates object ids by default; update-index needs them whole.
    ["diff", "--raw", "-z", "--no-abbrev", "--no-renames", `${args.base}..${args.sliceCommit}`, "--"],
    args.objectReadOptions,
    runGit,
  ));
  if (changes.length === 0) return args.head;

  const occupied = new Set((await checked(
    args.checkoutPath,
    ["diff", "--name-only", "-z", "--no-renames", `${args.base}..${args.head}`, "--"],
    args.objectReadOptions,
    runGit,
  )).split("\0").filter(entry => entry.length > 0));
  const collisions = changes.filter(change => occupied.has(change.path)).map(change => change.path);
  if (collisions.length > 0) {
    // Wave scheduling promised these slices could not touch the same paths. If
    // they did, confinement failed somewhere upstream and composing would pick a
    // winner silently.
    throw new RuntimeError(
      `slice ${args.sliceIndex} changed paths already written by its wave: ${collisions.join(", ")}`,
    );
  }

  const indexRoot = await mkdtemp(path.join(tmpdir(), "ca-compose-"));
  const indexFile = path.join(indexRoot, "index");
  try {
    const options: GitExecOptions = { ...args.objectReadOptions, indexFile };
    await checked(args.checkoutPath, ["read-tree", args.head], options, runGit);
    const instructions = changes.map(change =>
      change.deleted
        ? `0 ${NULL_OID}\t${change.path}`
        : `${change.mode} ${change.oid}\t${change.path}`).join("\n");
    await checked(
      args.checkoutPath,
      ["update-index", "--index-info"],
      { ...options, stdin: `${instructions}\n` },
      runGit,
    );
    const tree = (await checked(args.checkoutPath, ["write-tree"], options, runGit)).trim();
    return (await checked(
      args.checkoutPath,
      ["commit-tree", tree, "-p", args.head, "-m", `slice ${args.sliceIndex} ${args.runId}`],
      args.objectReadOptions,
      runGit,
    )).trim();
  } finally {
    await rm(indexRoot, { recursive: true, force: true });
  }
}
