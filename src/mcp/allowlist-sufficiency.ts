import { readFile } from "node:fs/promises";
import path from "node:path";
import { gitSucceeded } from "../git/checked-git.js";
import { git as runGit } from "../git/git-exec.js";
import { gitNulRecords } from "../git/git-output.js";
import type { DelegationSpec } from "../protocol/delegation-spec.js";
import { globMatches } from "../util/glob.js";

/**
 * The recurring integration tax: a delegation changes an exported contract, but
 * the files that consume that contract sit outside the write allowlist, so the
 * Producer cannot repair them and neither focused verification nor the clean room
 * ever compiles them. The breakage surfaces only in the architect's full suite,
 * as hand-fixing at integration time (dogfood findings 22, 0.27.0 #1, autopilot #2).
 *
 * This is advisory spec-authoring feedback, not a gate: it reports which tracked
 * files import the allowlisted ones, so the architect can widen the allowlist or
 * add a repo-wide verification command before dispatch.
 */
export interface AllowlistGap {
  path: string;
  imports: string[];
}

export interface AllowlistSufficiency {
  allowlisted: number;
  gaps: AllowlistGap[];
  omitted: number;
}

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]);
const MAX_GAPS = 25;
const MAX_FILE_BYTES = 512 * 1024;
const IMPORT_SPECIFIER =
  /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*)["']([^"']+)["']/gu;

export interface AllowlistSufficiencyDependencies {
  git?: typeof runGit;
  readFile?: (target: string) => Promise<string>;
}

function toPosix(candidate: string): string {
  return candidate.split(path.sep).join("/");
}

function isTestPath(candidate: string): boolean {
  return /(?:^|\/)tests?\//u.test(candidate) || /\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(candidate);
}

/**
 * Map an import specifier back to the repository file it names. TypeScript's
 * ESM output imports `./x.js` for `./x.ts`, so the emitted extension has to be
 * translated back before the paths can be compared.
 */
export function resolveImport(fromPath: string, specifier: string, tracked: Set<string>): string | null {
  if (!specifier.startsWith(".")) return null;
  const base = toPosix(path.posix.normalize(
    path.posix.join(path.posix.dirname(toPosix(fromPath)), specifier),
  ));
  if (base.startsWith("..")) return null;
  const rewrites = [
    base,
    base.replace(/\.js$/u, ".ts"),
    base.replace(/\.jsx$/u, ".tsx"),
    base.replace(/\.mjs$/u, ".mts"),
    base.replace(/\.cjs$/u, ".cts"),
  ];
  const candidates = [
    ...rewrites,
    ...[...SOURCE_EXTENSIONS].map(extension => `${base}${extension}`),
    ...[...SOURCE_EXTENSIONS].map(extension => `${base}/index${extension}`),
  ];
  return candidates.find(candidate => tracked.has(candidate)) ?? null;
}

export async function checkAllowlistSufficiency(
  repoRoot: string,
  spec: DelegationSpec,
  deps: AllowlistSufficiencyDependencies = {},
): Promise<AllowlistSufficiency> {
  const listed = await (deps.git ?? runGit)(repoRoot, ["ls-files", "-z"]);
  // A truncated listing would silently hide gaps; treat it like a failure.
  if (!gitSucceeded(listed)) return { allowlisted: 0, gaps: [], omitted: 0 };
  const tracked = new Set(
    gitNulRecords(listed.stdout, "Git tracked-file list").filter(entry => entry.length > 0),
  );

  const inScope = (candidate: string): boolean =>
    spec.writeAllowlist.some(pattern => globMatches(pattern, candidate))
    && !spec.forbiddenScope.some(pattern => globMatches(pattern, candidate));
  const allowlisted = new Set([...tracked].filter(inScope));
  if (allowlisted.size === 0) return { allowlisted: 0, gaps: [], omitted: 0 };

  const read = deps.readFile ?? (async target => readFile(target, "utf8"));
  const gaps: AllowlistGap[] = [];
  for (const candidate of tracked) {
    if (allowlisted.has(candidate)) continue;
    if (!SOURCE_EXTENSIONS.has(path.posix.extname(candidate))) continue;
    let contents: string;
    try {
      contents = (await read(path.join(repoRoot, candidate))).slice(0, MAX_FILE_BYTES);
    } catch {
      continue;
    }
    const imports = new Set<string>();
    for (const match of contents.matchAll(IMPORT_SPECIFIER)) {
      const resolved = resolveImport(candidate, match[1] ?? "", tracked);
      if (resolved !== null && allowlisted.has(resolved)) imports.add(resolved);
    }
    if (imports.size > 0) gaps.push({ path: candidate, imports: [...imports].sort() });
  }

  // Test files first: a consumer test asserting on a contract this run widens is
  // the shape that actually keeps costing an integration fix.
  gaps.sort((left, right) => {
    const byKind = Number(isTestPath(right.path)) - Number(isTestPath(left.path));
    return byKind !== 0 ? byKind : left.path.localeCompare(right.path);
  });
  return {
    allowlisted: allowlisted.size,
    gaps: gaps.slice(0, MAX_GAPS),
    omitted: Math.max(0, gaps.length - MAX_GAPS),
  };
}

export function allowlistSufficiencyDiagnostic(result: AllowlistSufficiency): string | null {
  if (result.gaps.length === 0) return null;
  const shown = result.gaps.slice(0, 5).map(gap => gap.path).join(", ");
  const rest = result.gaps.length + result.omitted - Math.min(5, result.gaps.length);
  return `allowlist-consumers: ${result.gaps.length + result.omitted} tracked file(s) import the `
    + `write allowlist but cannot be edited by the Producer (${shown}`
    + `${rest > 0 ? `, +${rest} more` : ""}). If this delegation changes an exported contract, `
    + `widen writeAllowlist to the consumers or add a repository-wide verification command.`;
}
