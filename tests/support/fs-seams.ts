import type { BigIntStats, PathLike, StatOptions, Stats } from "node:fs";
import type { lstat } from "node:fs/promises";

/**
 * A `lstat` seam for code that only ever asks for `{ bigint: true }` identity.
 *
 * `typeof lstat` is an overload set, which neither a plain async function nor
 * a `vi.fn` can satisfy structurally, so this declares the same overloads. The
 * one cast is `Partial<BigIntStats>` to `BigIntStats`: a double supplies only
 * the members the code under test reads.
 */
export function lstatDouble(
  answer: (path: PathLike) => Promise<Partial<BigIntStats>>,
): typeof lstat {
  async function double(path: PathLike, options?: StatOptions & { bigint?: false | undefined }): Promise<Stats>;
  async function double(path: PathLike, options: StatOptions & { bigint: true }): Promise<BigIntStats>;
  async function double(path: PathLike, options?: StatOptions): Promise<Stats | BigIntStats>;
  async function double(path: PathLike): Promise<Stats | BigIntStats> {
    return await answer(path) as BigIntStats;
  }
  return double;
}
