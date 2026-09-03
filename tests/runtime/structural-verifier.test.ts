import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { freezeCandidate } from "../../src/git/candidate-tree.js";
import { git } from "../../src/git/git-exec.js";
import type { CandidateArtifact } from "../../src/protocol/attempt-result.js";
import { isWithinScope } from "../../src/verify/project-verifier.js";
import {
  MODE_STRUCTURAL_FAILURES,
  pathsCaseCollide,
  structuralVerify,
  type VerificationMode,
} from "../../src/verify/structural-verifier.js";

interface Fixture {
  repoRoot: string;
  worktreePath: string;
  baseCommitOid: string;
  artifact: CandidateArtifact;
}

const temporaryPaths: string[] = [];

async function runGit(cwd: string, args: string[], indexFile?: string): Promise<string> {
  const result = await git(cwd, args, indexFile);
  expect(result.exitCode, result.stderr).toBe(0);
  return result.stdout.trim();
}

async function frozenFixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "ca-structural-verifier-"));
  temporaryPaths.push(root);
  const repoRoot = join(root, "repo");
  const worktreePath = join(root, "worktree");
  await mkdir(repoRoot);
  await runGit(repoRoot, ["init", "-q"]);
  await writeFile(join(repoRoot, "a.txt"), "hello\n");
  await runGit(repoRoot, ["add", "-A"]);
  await runGit(repoRoot, ["commit", "-q", "-m", "initial"]);
  const baseCommitOid = await runGit(repoRoot, ["rev-parse", "HEAD"]);
  await runGit(repoRoot, ["worktree", "add", "--detach", "-q", worktreePath, baseCommitOid]);
  await writeFile(join(worktreePath, "a.txt"), "updated\n");

  const frozen = await freezeCandidate({
    repoRoot,
    worktreePath,
    baseCommitOid,
    runId: "structural-test",
    writeAllowlist: ["a.txt"],
    forbiddenScope: [],
  });
  expect(frozen.ok).toBe(true);
  if (!frozen.ok) throw new Error(`freeze failed: ${frozen.reason}`);
  return { repoRoot, worktreePath, baseCommitOid, artifact: frozen.artifact };
}

function manifestHash(changedPaths: CandidateArtifact["changedPaths"]): string {
  return createHash("sha256").update(JSON.stringify(changedPaths)).digest("hex");
}

function verify(
  fixture: Fixture,
  artifact = fixture.artifact,
  scope: { writeAllowlist: string[]; forbiddenScope: string[] } = {
    writeAllowlist: ["a.txt"],
    forbiddenScope: [],
  },
  mode: VerificationMode = "candidate",
) {
  return structuralVerify({
    repoRoot: fixture.repoRoot,
    worktreePath: fixture.worktreePath,
    baseCommitOid: fixture.baseCommitOid,
    artifact,
    ...scope,
  }, mode);
}

async function candidateWithAddedPaths(
  fixture: Fixture,
  paths: string[],
): Promise<CandidateArtifact> {
  const indexFile = join(fixture.repoRoot, ".git", `structural-case-${paths.length}-index`);
  const blobOid = await runGit(fixture.repoRoot, [
    "hash-object", "-w", join(fixture.worktreePath, "a.txt"),
  ]);
  await runGit(fixture.repoRoot, ["read-tree", fixture.baseCommitOid], indexFile);
  for (const candidatePath of paths) {
    await runGit(fixture.repoRoot, [
      "update-index", "--add", "--cacheinfo", `100644,${blobOid},${candidatePath}`,
    ], indexFile);
  }
  const candidateTreeOid = await runGit(fixture.repoRoot, ["write-tree"], indexFile);
  const candidateCommitOid = await runGit(fixture.repoRoot, [
    "commit-tree", candidateTreeOid, "-p", fixture.baseCommitOid, "-m", "case candidate",
  ]);
  await runGit(fixture.repoRoot, [
    "update-ref", fixture.artifact.anchorRef, candidateCommitOid,
  ]);
  const changedPaths: CandidateArtifact["changedPaths"] = paths.map(candidatePath => ({
    path: candidatePath,
    changeType: "added",
    mode: "100644",
    contentHash: blobOid,
  })).sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  return {
    ...fixture.artifact,
    candidateTreeOid,
    candidateCommitOid,
    changedPaths,
    manifestHash: manifestHash(changedPaths),
  };
}

afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

describe("scope containment", () => {
  it("prevents drive-letter case evasion under win32 semantics", () => {
    expect(isWithinScope(
      "C:\\repo\\secret",
      "c:\\repo\\secret\\file.ts",
      "win32",
    )).toBe(true);
  });

  it("contains UNC descendants without accepting false prefix matches", () => {
    const root = "\\\\server\\share\\repo";

    expect(isWithinScope(root, "\\\\server\\share\\repo\\src\\a.ts", "win32")).toBe(true);
    expect(isWithinScope(root, "\\\\server\\share\\repository\\x.ts", "win32")).toBe(false);
  });

  it("normalizes win32 extended-length drive prefixes", () => {
    expect(isWithinScope(
      "\\\\?\\C:\\repo",
      "C:\\repo\\src\\a.ts",
      "win32",
    )).toBe(true);
  });

  it("keeps POSIX containment case-sensitive", () => {
    expect(isWithinScope("/repo/Secret", "/repo/secret/file.ts", "linux")).toBe(false);
    expect(isWithinScope("/repo/Secret", "/repo/Secret/file.ts", "linux")).toBe(true);
  });
});

describe("structuralVerify", () => {
  it("accepts an unchanged frozen artifact", async () => {
    const fixture = await frozenFixture();

    await expect(verify(fixture)).resolves.toEqual({
      ok: true,
      failures: [],
      manifestHash: fixture.artifact.manifestHash,
      // Exact, not partial: an unexpected key here is a change to what the
      // trust boundary reports.
      checkoutDrift: { headMoved: false, dirty: false },
    });
  });

  it("rejects a tampered manifest hash", async () => {
    const fixture = await frozenFixture();

    const result = await verify(fixture, {
      ...fixture.artifact,
      manifestHash: "0".repeat(64),
    });

    expect(result.ok).toBe(false);
    expect(result.failures).toContain("manifest-divergence");
    expect(result.manifestHash).toBe(fixture.artifact.manifestHash);
  });

  it("rejects a tampered changed-path manifest even with a matching claimed hash", async () => {
    const fixture = await frozenFixture();
    const changedPaths = fixture.artifact.changedPaths.map(change => ({
      ...change,
      contentHash: "f".repeat(40),
    }));

    const result = await verify(fixture, {
      ...fixture.artifact,
      changedPaths,
      manifestHash: manifestHash(changedPaths),
    });

    expect(result.failures).toContain("manifest-divergence");
    expect(result.manifestHash).toBe(fixture.artifact.manifestHash);
  });

  it("rejects a candidate whose anchor no longer resolves to its candidate commit", async () => {
    const fixture = await frozenFixture();
    await runGit(fixture.repoRoot, [
      "update-ref",
      fixture.artifact.anchorRef,
      fixture.baseCommitOid,
    ]);

    const result = await verify(fixture);

    expect(result.failures).toContain("artifact-divergence");
  });

  it("rejects a candidate commit whose tree differs from the claimed candidate tree", async () => {
    const fixture = await frozenFixture();
    const baseTreeOid = await runGit(
      fixture.repoRoot,
      ["rev-parse", `${fixture.baseCommitOid}^{tree}`],
    );
    const divergentCommitOid = await runGit(fixture.repoRoot, [
      "commit-tree",
      baseTreeOid,
      "-p",
      fixture.baseCommitOid,
      "-m",
      "divergent candidate",
    ]);
    await runGit(fixture.repoRoot, [
      "update-ref",
      fixture.artifact.anchorRef,
      divergentCommitOid,
    ]);

    const result = await verify(fixture, {
      ...fixture.artifact,
      candidateCommitOid: divergentCommitOid,
    });

    expect(result.failures).toContain("artifact-divergence");
  });

  it("rejects a candidate commit without the claimed base as its sole parent", async () => {
    const fixture = await frozenFixture();
    const parentlessCommitOid = await runGit(fixture.repoRoot, [
      "commit-tree",
      fixture.artifact.candidateTreeOid,
      "-m",
      "parentless candidate",
    ]);
    await runGit(fixture.repoRoot, [
      "update-ref",
      fixture.artifact.anchorRef,
      parentlessCommitOid,
    ]);

    const result = await verify(fixture, {
      ...fixture.artifact,
      candidateCommitOid: parentlessCommitOid,
    });

    expect(result.failures).toContain("artifact-divergence");
  });

  it("rechecks allowlist and case-insensitive forbidden scope against the frozen tree", async () => {
    const fixture = await frozenFixture();

    const outsideAllowlist = await verify(fixture, fixture.artifact, {
      writeAllowlist: ["src/**"],
      forbiddenScope: [],
    });
    const forbidden = await verify(fixture, fixture.artifact, {
      writeAllowlist: ["a.txt"],
      forbiddenScope: ["A.TXT"],
    });

    expect(outsideAllowlist.failures).toContain("out-of-scope-write");
    expect(forbidden.failures).toContain("out-of-scope-write");
  });

  it("rejects a symlink encoded directly in the immutable candidate tree", async () => {
    const fixture = await frozenFixture();
    const indexFile = join(fixture.repoRoot, ".git", "structural-symlink-index");
    const blobOid = await runGit(fixture.repoRoot, [
      "hash-object",
      "-w",
      join(fixture.worktreePath, "a.txt"),
    ]);
    await runGit(fixture.repoRoot, ["read-tree", fixture.baseCommitOid], indexFile);
    await runGit(fixture.repoRoot, [
      "update-index",
      "--add",
      "--cacheinfo",
      `120000,${blobOid},link.txt`,
    ], indexFile);
    const candidateTreeOid = await runGit(fixture.repoRoot, ["write-tree"], indexFile);
    const changedPaths: CandidateArtifact["changedPaths"] = [{
      path: "link.txt",
      changeType: "added",
      mode: "120000",
      contentHash: blobOid,
    }];

    const result = await verify(fixture, {
      ...fixture.artifact,
      candidateTreeOid,
      changedPaths,
      manifestHash: manifestHash(changedPaths),
    }, {
      writeAllowlist: ["link.txt"],
      forbiddenScope: [],
    });

    expect(result.failures).toContain("modified-symlink");
  });

  it("independently rejects collisions among changed paths", async () => {
    const fixture = await frozenFixture();
    const artifact = await candidateWithAddedPaths(fixture, ["Case.txt", "case.txt"]);

    const result = await verify(fixture, artifact, {
      writeAllowlist: ["**"], forbiddenScope: [],
    });

    expect(result.failures).toContain("case-collision");
    // Asserting the finding alone would still pass if the verifier reported it
    // alongside ok:true -- the fail-open regression this test exists to catch.
    expect(result.ok).toBe(false);
  });

  it("rejects a changed path colliding with an untouched candidate-tree path", async () => {
    const fixture = await frozenFixture();
    const artifact = await candidateWithAddedPaths(fixture, ["A.TXT"]);

    const result = await verify(fixture, artifact, {
      writeAllowlist: ["**"], forbiddenScope: [],
    });

    expect(result.failures).toContain("case-collision");
    // Asserting the finding alone would still pass if the verifier reported it
    // alongside ok:true -- the fail-open regression this test exists to catch.
    expect(result.ok).toBe(false);
  });

  it("reports a case collision together with independent scope failures", async () => {
    const fixture = await frozenFixture();
    const artifact = await candidateWithAddedPaths(fixture, ["A.TXT"]);

    const result = await verify(fixture, artifact, {
      writeAllowlist: ["elsewhere/**"], forbiddenScope: [],
    });

    expect(result.failures).toEqual(expect.arrayContaining([
      "case-collision",
      "out-of-scope-write",
    ]));
    expect(result.checkoutDrift).toEqual({ headMoved: false, dirty: false });
  });

  it("normalizes NFC and NFD paths before exact and folded comparisons", () => {
    expect(pathsCaseCollide(["É.txt", "e\u0301.txt"], [])).toBe(true);
    expect(pathsCaseCollide(["é.txt"], ["e\u0301.txt"])).toBe(false);
  });

  it("folds Greek sigma and final sigma as one filesystem path", () => {
    expect(pathsCaseCollide(["Σ.txt", "ς.txt", "σ.txt"], [])).toBe(true);
  });

  it("rejects a gitlink encoded directly in the immutable candidate tree", async () => {
    const fixture = await frozenFixture();
    const indexFile = join(fixture.repoRoot, ".git", "structural-gitlink-index");
    await runGit(fixture.repoRoot, ["read-tree", fixture.baseCommitOid], indexFile);
    await runGit(fixture.repoRoot, [
      "update-index",
      "--add",
      "--cacheinfo",
      `160000,${fixture.baseCommitOid},nested`,
    ], indexFile);
    const candidateTreeOid = await runGit(fixture.repoRoot, ["write-tree"], indexFile);
    const changedPaths: CandidateArtifact["changedPaths"] = [{
      path: "nested",
      changeType: "added",
      mode: "160000",
      contentHash: fixture.baseCommitOid,
    }];

    const result = await verify(fixture, {
      ...fixture.artifact,
      candidateTreeOid,
      changedPaths,
      manifestHash: manifestHash(changedPaths),
    }, {
      writeAllowlist: ["nested"],
      forbiddenScope: [],
    });

    expect(result.failures).toContain("modified-symlink");
  });

  it("enforces forbidden scope against an opaque nested-repository path", async () => {
    const fixture = await frozenFixture();
    const indexFile = join(fixture.repoRoot, ".git", "structural-forbidden-index");
    await runGit(fixture.repoRoot, ["read-tree", fixture.baseCommitOid], indexFile);
    await runGit(fixture.repoRoot, [
      "update-index",
      "--add",
      "--cacheinfo",
      `160000,${fixture.baseCommitOid},vendor`,
    ], indexFile);
    const candidateTreeOid = await runGit(fixture.repoRoot, ["write-tree"], indexFile);
    const changedPaths: CandidateArtifact["changedPaths"] = [{
      path: "vendor",
      changeType: "added",
      mode: "160000",
      contentHash: fixture.baseCommitOid,
    }];

    const result = await verify(fixture, {
      ...fixture.artifact,
      candidateTreeOid,
      changedPaths,
      manifestHash: manifestHash(changedPaths),
    }, {
      writeAllowlist: ["vendor"],
      forbiddenScope: ["vendor/**"],
    });

    expect(result.failures).toContain("out-of-scope-write");
  });

  it("rejects a candidate tree identical to the base tree", async () => {
    const fixture = await frozenFixture();
    const candidateTreeOid = await runGit(
      fixture.repoRoot,
      ["rev-parse", `${fixture.baseCommitOid}^{tree}`],
    );

    const result = await verify(fixture, {
      ...fixture.artifact,
      candidateTreeOid,
      changedPaths: [],
      manifestHash: manifestHash([]),
    });

    expect(result.failures).toContain("empty-candidate");
  });

  it("does not reject a frozen candidate because the main checkout advanced", async () => {
    // The candidate is frozen and verified in an isolated worktree; the shared
    // checkout's HEAD is mutable, extrinsic to it, re-checked under the
    // repository lock at integration, and can move again in between — so
    // failing here discarded valid work and proved nothing.
    const fixture = await frozenFixture();
    await writeFile(join(fixture.repoRoot, "a.txt"), "new base\n");
    await runGit(fixture.repoRoot, ["add", "a.txt"]);
    await runGit(fixture.repoRoot, ["commit", "-q", "-m", "advance base"]);

    const result = await verify(fixture);

    expect(result.ok).toBe(true);
    expect(result.failures).toEqual([]);
    // Still visible to a human deciding integration.
    expect(result.checkoutDrift).toMatchObject({ headMoved: true });
  });

  it("does not reject a frozen candidate because the main checkout is dirty", async () => {
    const fixture = await frozenFixture();
    await writeFile(join(fixture.repoRoot, "untracked.txt"), "host edit\n");

    const result = await verify(fixture);

    expect(result.ok).toBe(true);
    expect(result.checkoutDrift).toMatchObject({ dirty: true });
  });

  it("still rejects an artifact that does not match the base it claims", async () => {
    // The integrity half of the old check: intrinsic to the frozen artifact.
    const fixture = await frozenFixture();
    const result = await verify({
      ...fixture,
      artifact: { ...fixture.artifact, baseCommitOid: "0".repeat(40) },
    });

    expect(result.ok).toBe(false);
    expect(result.failures).toContain("artifact-base-mismatch");
  });
});

describe("verification modes", () => {
  const modes: VerificationMode[] = ["candidate", "composed-slice", "final-branch"];

  // The declared table is only a contract if the implementation cannot report
  // outside it. Asserting the table's contents alone passes even when
  // `structuralVerify` ignores the table entirely.
  it.each(modes)("mode %s reports no failure class outside its declared set", async mode => {
    const fixture = await frozenFixture();
    const artifact = await candidateWithAddedPaths(fixture, ["Case.txt", "case.txt"]);

    const result = await verify(
      fixture,
      artifact,
      { writeAllowlist: ["elsewhere/**"], forbiddenScope: [] },
      mode,
    );

    const declared = new Set<string>(MODE_STRUCTURAL_FAILURES[mode]);
    expect(result.failures.filter(failure => !declared.has(failure))).toEqual([]);
  });

  it("mode candidate reports a case collision that mode final-branch does not", async () => {
    const fixture = await frozenFixture();
    const artifact = await candidateWithAddedPaths(fixture, ["Case.txt", "case.txt"]);
    const scope = { writeAllowlist: ["**"], forbiddenScope: [] };

    const asCandidate = await verify(fixture, artifact, scope, "candidate");
    const asFinalBranch = await verify(fixture, artifact, scope, "final-branch");

    expect(asCandidate.failures).toContain("case-collision");
    expect(asFinalBranch.failures).not.toContain("case-collision");
  });

  it("mode composed-slice accepts a replayed commit that mode candidate rejects", async () => {
    const fixture = await frozenFixture();
    // A composed slice's commit has been replayed onto the wave head, so its
    // parent is no longer the base -- the single-commit identity proof that
    // `candidate` mode applies cannot hold for it.
    const replayed = await runGit(fixture.repoRoot, [
      "commit-tree", fixture.artifact.candidateTreeOid,
      "-p", fixture.artifact.candidateCommitOid,
      "-m", "replayed",
    ]);
    const artifact = { ...fixture.artifact, candidateCommitOid: replayed };

    const asCandidate = await verify(fixture, artifact, undefined, "candidate");
    const asComposedSlice = await verify(fixture, artifact, undefined, "composed-slice");

    expect(asCandidate.failures).toContain("artifact-divergence");
    expect(asComposedSlice.failures).not.toContain("artifact-divergence");
  });

  it("mode final-branch omits checkout drift, which it cannot observe", async () => {
    const fixture = await frozenFixture();

    const asCandidate = await verify(fixture, undefined, undefined, "candidate");
    const asFinalBranch = await verify(fixture, undefined, undefined, "final-branch");

    expect(asCandidate.checkoutDrift).toEqual({ headMoved: false, dirty: false });
    expect(asFinalBranch.checkoutDrift).toBeUndefined();
  });
});
