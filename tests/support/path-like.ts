import type { PathLike } from "node:fs";

/** Filesystem seams are typed `PathLike`; the code under test only ever passes strings. */
export function pathText(path: PathLike): string {
  return typeof path === "string" ? path : path.toString();
}
