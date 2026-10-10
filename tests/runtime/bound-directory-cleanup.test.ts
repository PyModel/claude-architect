import { describe, expect, it } from "vitest";
import {
  CHILD_SAME_IDENTITY_SOURCE,
  EMPTY_DIRECTORY_TIMEOUT_ENV,
  resolveEmptyDirectoryTimeoutMs,
} from "../../src/platform/bound-directory-cleanup.js";
import { sameDirectoryIdentity, type DirectoryIdentity } from "../../src/platform/durable-directory.js";

describe("resolveEmptyDirectoryTimeoutMs", () => {
  it("defaults to 120000ms when unset or empty", () => {
    expect(resolveEmptyDirectoryTimeoutMs({})).toBe(120_000);
    expect(resolveEmptyDirectoryTimeoutMs({ [EMPTY_DIRECTORY_TIMEOUT_ENV]: "" })).toBe(120_000);
  });

  it("honors a positive integer override", () => {
    // A large disposable worktree (big node_modules / monorepo checkout) can
    // routinely exceed the default budget; this is the override that lets an
    // operator raise it instead of eating a teardown failure on every attempt.
    expect(resolveEmptyDirectoryTimeoutMs({ [EMPTY_DIRECTORY_TIMEOUT_ENV]: "600000" }))
      .toBe(600_000);
  });

  it("fails closed to the default and warns on a non-positive-integer value", () => {
    // A typo (or an attempt to disable the bound with 0/negative/non-numeric)
    // must not silently produce an unbounded or nonsensical timeout — a wedged
    // Producer process would then never be cleaned up.
    const warnings: string[] = [];
    expect(resolveEmptyDirectoryTimeoutMs(
      { [EMPTY_DIRECTORY_TIMEOUT_ENV]: "not-a-number" },
      message => warnings.push(message),
    )).toBe(120_000);
    expect(warnings).toEqual([expect.stringContaining("is not a positive integer")]);
  });

  it.each(["0", "-1", "1.5"])("rejects the non-positive-integer value %s", value => {
    const warnings: string[] = [];
    expect(resolveEmptyDirectoryTimeoutMs(
      { [EMPTY_DIRECTORY_TIMEOUT_ENV]: value },
      message => warnings.push(message),
    )).toBe(120_000);
    expect(warnings).toHaveLength(1);
  });
});

describe("cleanup child identity rule", () => {
  it("agrees with the canonical comparator", () => {
    // The child script cannot import modules; evaluate its shipped inline rule.
    const childSameIdentity = new Function(`return ${CHILD_SAME_IDENTITY_SOURCE};`)() as (
      left: unknown,
      right: unknown,
    ) => boolean;
    const directory = (identity: DirectoryIdentity) => ({
      ...identity,
      isDirectory: () => true,
      isSymbolicLink: () => false,
    });
    const base = { dev: 2n ** 60n, ino: 7n, birthtimeNs: 1_700_000_000_000_000_000n };
    const cases: Array<[string, DirectoryIdentity, DirectoryIdentity, boolean]> = [
      ["equal", base, { ...base }, true],
      ["different inode", base, { ...base, ino: 8n }, false],
      ["different device above 2^53", base, { ...base, dev: base.dev + 1n }, false],
      ["different birth time", base, { ...base, birthtimeNs: base.birthtimeNs + 1n }, false],
      ["zero birth time on one side", base, { ...base, birthtimeNs: 0n }, false],
      ["zero birth time on the other side", { ...base, birthtimeNs: 0n }, base, false],
      ["zero birth time on both sides", { ...base, birthtimeNs: 0n }, { ...base, birthtimeNs: 0n }, true],
    ];
    for (const [label, left, right, expected] of cases) {
      expect(sameDirectoryIdentity(left, right), label).toBe(expected);
      expect(childSameIdentity(directory(left), directory(right)), label).toBe(expected);
    }
  });
});
