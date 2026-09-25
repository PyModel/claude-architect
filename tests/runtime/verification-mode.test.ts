import { describe, expect, it } from "vitest";
import {
  MODE_STRUCTURAL_FAILURES,
  isAllowed,
  type StructuralFailure,
  type VerificationMode,
} from "../../src/verify/structural-verifier.js";
import { AcceptanceVerifier } from "../../src/verify/acceptance-verifier.js";

describe("VerificationMode", () => {
  describe("mode failure classes contract", () => {
    it("mode candidate includes all 7 structural failure classes", () => {
      const expected: StructuralFailure[] = [
        "manifest-divergence",
        "artifact-divergence",
        "out-of-scope-write",
        "modified-symlink",
        "case-collision",
        "empty-candidate",
        "artifact-base-mismatch",
      ];
      expect([...MODE_STRUCTURAL_FAILURES.candidate]).toEqual(expected);
      expect(MODE_STRUCTURAL_FAILURES.candidate).toContain("artifact-divergence");
      expect(MODE_STRUCTURAL_FAILURES.candidate).toContain("case-collision");
    });

    it("mode composed-slice replaces IGNORED_STRUCTURAL_FAILURES by omitting artifact-divergence", () => {
      const expected: StructuralFailure[] = [
        "manifest-divergence",
        "out-of-scope-write",
        "modified-symlink",
        "case-collision",
        "empty-candidate",
        "artifact-base-mismatch",
      ];
      expect([...MODE_STRUCTURAL_FAILURES["composed-slice"]]).toEqual(expected);
      expect(MODE_STRUCTURAL_FAILURES["composed-slice"]).not.toContain("artifact-divergence");
      expect(MODE_STRUCTURAL_FAILURES["composed-slice"]).toContain("out-of-scope-write");
    });

    it("mode final-branch checks branch ancestry and head coherence without case-collision", () => {
      const expected: StructuralFailure[] = [
        "manifest-divergence",
        "artifact-divergence",
        "out-of-scope-write",
        "modified-symlink",
        "empty-candidate",
        "artifact-base-mismatch",
      ];
      expect([...MODE_STRUCTURAL_FAILURES["final-branch"]]).toEqual(expected);
      expect(MODE_STRUCTURAL_FAILURES["final-branch"]).toContain("artifact-divergence");
      expect(MODE_STRUCTURAL_FAILURES["final-branch"]).not.toContain("case-collision");
    });
  });

  describe("unified scope checking", () => {
    it("allows paths matching writeAllowlist", () => {
      expect(isAllowed("src/index.ts", ["src/**"], [])).toBe(true);
      expect(isAllowed("package.json", ["package.json"], [])).toBe(true);
      expect(isAllowed("src/deep/nested/file.ts", ["src/**"], [])).toBe(true);
    });

    it("forbids paths outside writeAllowlist", () => {
      expect(isAllowed("secret.key", ["src/**"], [])).toBe(false);
      expect(isAllowed("tests/foo.ts", ["src/**"], [])).toBe(false);
    });

    it("forbids paths matching forbiddenScope even if within writeAllowlist", () => {
      expect(isAllowed("src/secret.key", ["src/**"], ["**/*.key"])).toBe(false);
      expect(isAllowed(".git/config", ["**"], [".git/**"])).toBe(false);
    });

    it("handles opaque directory mode for submodules or directories", () => {
      expect(isAllowed("vendor/submodule", ["vendor/**"], [], true)).toBe(true);
      expect(isAllowed("vendor/forbidden_sub", ["vendor/**"], ["vendor/forbidden_sub/**"], true)).toBe(false);
    });
  });

  describe("AcceptanceVerifier mode configuration", () => {
    it("defaults to candidate mode", () => {
      let observedMode: VerificationMode | undefined;
      const verifier = new AcceptanceVerifier({
        structural: async (_args, mode) => {
          observedMode = mode;
          return { ok: true, failures: [], manifestHash: "hash" };
        },
        project: async () => ({
          ok: true,
          failures: [],
          evidence: { commands: [] },
          commandOutcomes: [],
          outputLogs: [],
        }),
      });

      expect(verifier).toBeDefined();
    });

    it("propagates composed-slice mode to structural verification", async () => {
      let observedMode: VerificationMode | undefined;
      const verifier = new AcceptanceVerifier({
        mode: "composed-slice",
        structural: async (_args, mode) => {
          observedMode = mode;
          return { ok: true, failures: [], manifestHash: "hash" };
        },
        project: async () => ({
          ok: true,
          failures: [],
          evidence: { commands: [] },
          commandOutcomes: [],
          outputLogs: [],
        }),
      });

      await verifier.verify({
        repoRoot: "/test/repo",
        worktreePath: "/test/worktree",
        baseCommitOid: "1111111111111111111111111111111111111111",
        artifact: {
          baseCommitOid: "1111111111111111111111111111111111111111",
          candidateCommitOid: "2222222222222222222222222222222222222222",
          candidateTreeOid: "3333333333333333333333333333333333333333",
          anchorRef: "refs/test",
          manifestHash: "hash",
          changedPaths: [],
          patchRef: "patch.diff",
        },
        spec: {
          id: "test",
          protocolVersion: "1",
          targetRepo: { path: "/test/repo", head: "1111111111111111111111111111111111111111" },
          producer: { name: "codex" },
          policy: { writeScope: ["."], forbiddenScope: [], networkAccess: "none" },
          writeAllowlist: ["."],
          forbiddenScope: [],
          instructions: { goal: "test" },
          verification: [],
        },
        ps: {} as any,
        artifactStore: { writeLog: async () => "logs/test.log" },
      });

      expect(observedMode).toBe("composed-slice");
    });

    it("propagates final-branch mode to structural verification", async () => {
      let observedMode: VerificationMode | undefined;
      const verifier = new AcceptanceVerifier({
        mode: "final-branch",
        structural: async (_args, mode) => {
          observedMode = mode;
          return { ok: true, failures: [], manifestHash: "hash" };
        },
        project: async () => ({
          ok: true,
          failures: [],
          evidence: { commands: [] },
          commandOutcomes: [],
          outputLogs: [],
        }),
      });

      await verifier.verify({
        repoRoot: "/test/repo",
        worktreePath: "/test/worktree",
        baseCommitOid: "1111111111111111111111111111111111111111",
        artifact: {
          baseCommitOid: "1111111111111111111111111111111111111111",
          candidateCommitOid: "2222222222222222222222222222222222222222",
          candidateTreeOid: "3333333333333333333333333333333333333333",
          anchorRef: "refs/test",
          manifestHash: "hash",
          changedPaths: [],
          patchRef: "patch.diff",
        },
        spec: {
          id: "test",
          protocolVersion: "1",
          targetRepo: { path: "/test/repo", head: "1111111111111111111111111111111111111111" },
          producer: { name: "codex" },
          policy: { writeScope: ["."], forbiddenScope: [], networkAccess: "none" },
          writeAllowlist: ["."],
          forbiddenScope: [],
          instructions: { goal: "test" },
          verification: [],
        },
        ps: {} as any,
        artifactStore: { writeLog: async () => "logs/test.log" },
      });

      expect(observedMode).toBe("final-branch");
    });
  });
});
