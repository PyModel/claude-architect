import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { DelegationSpec, Slice } from "../../src/protocol/delegation-spec.js";
import { composeProgressNotes, detectWeakenedTests, runIncrement, runReviews, scopeSpecToSlice, verifyCandidate } from "../../src/pipeline/pipeline-runtime.js";
import { type LinkedWorktreeGitAccess } from "../../src/pipeline/git-writable-roots.js";
import type { IncrementReport } from "../../src/pipeline/report-types.js";
import type { RolePackage } from "../../src/pipeline/role-prompts.js";
import type { RoleRunArgs, RoleRunResult } from "../../src/pipeline/role-runner.js";
import { ArtifactStore } from "../../src/runtime/artifact-store.js";
import { registerSecretValue } from "../../src/runtime/redaction.js";
import { AcceptanceVerifier } from "../../src/verify/acceptance-verifier.js";
import { runGit, initRepo, validSpec, fenced, success, approve, artifactFor, attemptResult, dependencies, implementationSpec, installPipelineRuntimeHooks } from "../support/pipeline-runtime-harness.js";

installPipelineRuntimeHooks();

describe("composeProgressNotes", () => {
  it("renders only the provided report deterministically and redacts secrets", () => {
    registerSecretValue("increment-secret-value");
    const earlier: IncrementReport = {
      reportVersion: "1",
      candidateCommit: "a".repeat(40),
      status: "continue",
      summary: "increment two marker increment-secret-value",
      nextSteps: "continue increment two",
    };
    const latest: IncrementReport = {
      reportVersion: "1",
      candidateCommit: "b".repeat(40),
      status: "continue",
      summary: "increment three marker",
      nextSteps: "continue increment three",
    };

    const first = composeProgressNotes(earlier);
    const second = composeProgressNotes(latest);

    expect(first).not.toContain("increment-secret-value");
    expect(first).toContain("[s]");
    expect(second).not.toContain("increment two marker");
    expect(second).toContain("increment three marker");
    expect(composeProgressNotes(latest)).toBe(second);
  });

  it("caps schema-valid summary and next steps at 8000 characters", () => {
    const notes = composeProgressNotes({
      reportVersion: "1",
      candidateCommit: "c".repeat(40),
      status: "continue",
      summary: "a".repeat(4_000),
      nextSteps: "b".repeat(4_000),
    });

    expect(notes).toHaveLength(8_000);
    expect(notes).toMatch(/\[progress notes truncated\]$/);
  });
});

describe("scopeSpecToSlice", () => {
  it("clones the parent with only slice-owned fields replaced and slices removed", async () => {
    const slice: Slice = {
      objective: "Implement only the first slice.",
      context: "The slice context is authoritative.",
      writeAllowlist: ["src/slice/**"],
      forbiddenScope: ["src/slice/private/**"],
      successCriteria: ["The slice is independently complete."],
      verification: [{
        id: "slice-check",
        executable: "node",
        args: ["-e", "process.exit(0)"],
        cwd: ".",
        environment: { SLICE_CHECK: "true" },
        timeoutMs: 30_000,
        network: "denied",
        expectedExitCodes: [0],
        platform: { os: ["darwin", "linux", "win32"] },
      }],
    };
    const parent: DelegationSpec = {
      ...validSpec({ reviewers: ["correctness"], maxRounds: 1, focus: ["security"] }),
      objective: "Complete the whole delegation.",
      context: "Parent context.",
      writeAllowlist: ["src/**"],
      forbiddenScope: ["src/private/**"],
      successCriteria: ["The entire delegation is complete."],
      producerOverrides: { model: "trusted-model", reasoningEffort: "high" },
      implementation: { maxIncrements: 2 },
      slices: [structuredClone(slice)],
    };
    const parentSnapshot = structuredClone(parent);
    const sliceSnapshot = structuredClone(slice);

    const scoped = scopeSpecToSlice(parent, slice);
    const expected = structuredClone(parent);
    Object.assign(expected, slice);
    delete expected.slices;

    expect(scoped).toEqual(expected);
    expect(scoped).not.toHaveProperty("slices");
    scoped.writeAllowlist.push("result-only/**");
    scoped.verification[0]!.args.push("result-only");
    scoped.producerPreferences.push("result-only");
    expect(parent).toEqual(parentSnapshot);
    expect(slice).toEqual(sliceSnapshot);
  });

  it("inherits parent test-deletion globs unless the slice overrides them", () => {
    const parent = validSpec();
    parent.allowedTestDeletions = ["tests/inherited/**"];
    const inheritedSlice: Slice = {
      objective: "Inherited deletion scope.",
      context: "Use the parent deletion authority.",
      writeAllowlist: ["a.txt"],
      forbiddenScope: [],
      successCriteria: ["Done."],
      verification: parent.verification,
    };
    const overrideSlice: Slice = {
      ...inheritedSlice,
      allowedTestDeletions: ["tests/override/**"],
    };

    const inherited = scopeSpecToSlice(parent, inheritedSlice);
    const overridden = scopeSpecToSlice(parent, overrideSlice);
    expect(inherited.allowedTestDeletions).toEqual(["tests/inherited/**"]);
    expect(overridden.allowedTestDeletions).toEqual(["tests/override/**"]);

    const diff = [
      "diff --git a/tests/inherited/old.test.ts b/tests/inherited/old.test.ts",
      "deleted file mode 100644",
    ].join("\n");
    expect(detectWeakenedTests(diff, inherited.allowedTestDeletions).testsDeleted).toBe(0);
    expect(detectWeakenedTests(diff, overridden.allowedTestDeletions).testsDeleted).toBe(1);
  });
});

describe("pipeline runtime namespaces", () => {
  it("derives distinct implementer and reviewer log names from a trusted namespace", async () => {
    const runId = "pipeline-namespaced-roles";
    const spec = implementationSpec(2);
    const pkg: RolePackage = {
      spec,
      baselineCommit: "a".repeat(40),
      candidateCommit: "b".repeat(40),
      candidateDiff: "",
      testEvidence: "[]",
    };
    const roleRunner = async (args: RoleRunArgs): Promise<RoleRunResult> => args.role === "implementer"
      ? success(fenced({
        reportVersion: "1",
        candidateCommit: pkg.candidateCommit,
        status: "complete",
        summary: "slice complete",
      }))
      : success(fenced(approve));
    const deps = dependencies({ runId, roleRunner });
    const store = new ArtifactStore(runId);
    const gitObjectAccess: LinkedWorktreeGitAccess = {
      gitDir: "/git-dir",
      privateObjectsDir: "/private-objects",
      sharedObjectsDir: "/shared-objects",
      writableRoots: [],
    };
    const increment = await runIncrement({
      spec,
      pkg,
      worktreePath: "/worktree",
      deps,
      runId,
      increment: 2,
      store,
      gitObjectAccess,
      logNameNamespace: "slice1-attempt0",
    });
    const reviews = await runReviews({
      reviewers: ["correctness"],
      spec,
      pkg,
      worktreePath: "/worktree",
      deps,
      runId,
      round: 1,
      store,
      logNameNamespace: "slice1-attempt1",
    });

    expect(increment.roleLogRefs).toEqual([
      "logs/role-implementer-slice1-attempt0-increment2.log",
    ]);
    expect(reviews.roleLogRefs).toEqual([
      "logs/role-reviewer-correctness-slice1-attempt1-round1.log",
    ]);
  });

  it("derives verification worktree, verifier, and log identities from one namespace", async () => {
    const repo = await initRepo();
    const runId = "pipeline-namespaced-verification";
    const baselineCommit = await runGit(repo, ["rev-parse", "HEAD"]);
    await writeFile(path.join(repo, "a.txt"), "candidate\n");
    await runGit(repo, ["add", "a.txt"]);
    await runGit(repo, ["commit", "-q", "-m", "candidate"]);
    const candidateCommit = await runGit(repo, ["rev-parse", "HEAD"]);
    const candidate = await artifactFor(repo, runId, baselineCommit, candidateCommit);
    const attempt = attemptResult(runId, candidate);
    const spec = validSpec({ reviewers: ["correctness"], maxRounds: 1 });
    spec.verification = [{
      ...spec.verification[0]!,
      args: [
        "-e",
        [
          "const fs = require('node:fs');",
          "const path = require('node:path');",
          "process.stdout.write(fs.readdirSync(path.dirname(process.cwd())).sort().join('\\n'));",
        ].join(" "),
      ],
    }];
    const store = new ArtifactStore(runId);
    const verifierSpy = vi.spyOn(AcceptanceVerifier.prototype, "verify");

    const result = await verifyCandidate({
      checkoutPath: repo,
      spec,
      deps: dependencies({
        runId,
        roleRunner: async () => { throw new Error("role runner must not run"); },
      }),
      attempt,
      baselineCommit,
      candidateCommit,
      store,
      namespace: "slice1-attempt0",
    });
    const stdoutRef = result.verification.evidence.commandOutcomes[0]?.stdoutRef;
    const verifierArgs = verifierSpy.mock.calls[0]?.[0];

    expect(stdoutRef).toBe("logs/slice1-attempt0-pipeline-verification-0-stdout.log");
    expect(verifierArgs?.verificationId?.()).toBe(
      `${runId}-slice1-attempt0-pipeline`,
    );
    const worktrees = (await readFile(path.join(store.runDirectory, stdoutRef!), "utf8"))
      .split("\n");
    expect(worktrees).toContain(`${runId}-slice1-attempt0-verify`);
  });
});

describe("detectWeakenedTests", () => {
  it("counts deleted test files and added .skip calls", () => {
    const diff = [
      "diff --git a/tests/foo.test.ts b/tests/foo.test.ts",
      "deleted file mode 100644",
      "diff --git a/tests/bar.test.ts b/tests/bar.test.ts",
      "+it.skip(\"was passing\", () => {});",
    ].join("\n");
    expect(detectWeakenedTests(diff)).toEqual({ testsDeleted: 1, testsSkipped: 1 });
  });

  it.each([
    ["tests/test_api.py", "@pytest.mark.skip(reason=\"flaky\")"],
    ["tests/test_api.py", "    self.skipTest(\"later\")"],
    ["pkg/api_test.go", "\tt.Skip(\"later\")"],
    ["tests/api.rs", "#[ignore]"],
    ["src/test/java/ApiTest.java", "  @Disabled"],
    ["Tests/ApiTests.cs", "  [Ignore(\"later\")]"],
    ["spec/api_spec.rb", "    skip \"later\""],
    ["tests/api.test.ts", "xdescribe(\"api\", () => {"],
  ])("counts a skip added to %s", (file, added) => {
    const diff = [`diff --git a/${file} b/${file}`, `+${added}`].join("\n");
    expect(detectWeakenedTests(diff)).toEqual({ testsDeleted: 0, testsSkipped: 1 });
  });

  it("does not count ordinary identifiers that resemble skip markers", () => {
    const diff = [
      "diff --git a/pkg/api_test.go b/pkg/api_test.go",
      "+\tskip := len(cases) == 0",
      "+\tpending := 3",
    ].join("\n");
    expect(detectWeakenedTests(diff)).toEqual({ testsDeleted: 0, testsSkipped: 0 });
  });

  it("ignores skips in non-test files", () => {
    const diff = ["diff --git a/src/foo.ts b/src/foo.ts", "+it.skip(", ""].join("\n");
    expect(detectWeakenedTests(diff)).toEqual({ testsDeleted: 0, testsSkipped: 0 });
  });

  it("excludes only authorized deleted tests and records their paths", () => {
    const diff = [
      "diff --git a/tests/authorized.test.ts b/tests/authorized.test.ts",
      "deleted file mode 100644",
      "diff --git a/tests/unauthorized.test.ts b/tests/unauthorized.test.ts",
      "deleted file mode 100644",
    ].join("\n");

    expect(detectWeakenedTests(diff, ["tests/authorized.*"])).toEqual({
      testsDeleted: 1,
      testsSkipped: 0,
    });
    expect(detectWeakenedTests(diff, [])).toEqual({
      testsDeleted: 2,
      testsSkipped: 0,
    });
  });

  it("judges NUL-safe deleted paths without relying on quoted patch headers", () => {
    const diff = 'diff --git "a/tests/old test.test.ts" "b/tests/old test.test.ts"';

    expect(detectWeakenedTests(
      diff,
      ["tests/old *.test.ts"],
      ["tests/old test.test.ts", "tests/not-authorized.test.ts"],
    )).toEqual({
      testsDeleted: 1,
      testsSkipped: 0,
    });
  });
});
