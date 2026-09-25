import { realpath } from "node:fs/promises";
import path from "node:path";
import { RuntimeError, isMissing } from "../util/errors.js";
import { platformPathsEqual } from "../util/platform-path.js";

export async function canonicalizeWorktreePath(
  pathname: string,
  allowMissing: boolean,
): Promise<string> {
  if (!path.isAbsolute(pathname)) {
    throw new RuntimeError("worktree registration path is not absolute");
  }
  const resolved = path.resolve(pathname);
  try {
    return await realpath(resolved);
  } catch (error) {
    if (!allowMissing || !isMissing(error)) throw error;
  }
  const missingSegments: string[] = [];
  let ancestor = resolved;
  for (;;) {
    const parent = path.dirname(ancestor);
    if (parent === ancestor) {
      throw new RuntimeError("worktree registration path has no existing ancestor");
    }
    missingSegments.unshift(path.basename(ancestor));
    ancestor = parent;
    try {
      return path.join(await realpath(ancestor), ...missingSegments);
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
  }
}

/**
 * Finds one worktree record after canonicalizing both its Git-reported path and
 * the expected path. `allowMissing` is for stale registrations whose physical
 * checkout or managed-root suffix has already disappeared while a canonical
 * ancestor still exists.
 */
export async function findWorktreeRegistration(
  fields: readonly string[],
  worktreePath: string,
  allowMissing = false,
): Promise<number> {
  const expected = await canonicalizeWorktreePath(worktreePath, allowMissing);
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index]!;
    if (!field.startsWith("worktree ")) continue;
    let reported: string;
    try {
      reported = await canonicalizeWorktreePath(
        field.slice("worktree ".length),
        allowMissing,
      );
    } catch (error) {
      if (isMissing(error)) continue;
      throw error;
    }
    if (platformPathsEqual(reported, expected)) return index;
  }
  return -1;
}
