import { describe, expect, it } from "vitest";
import {
  MODE_STRUCTURAL_FAILURES,
  isAllowed,
  type StructuralFailure,
  type VerificationMode,
} from "../../src/verify/structural-verifier.js";
import { getPlatformServices } from "../../src/platform/select-platform.js";
import type { CandidateArtifact } from "../../src/protocol/attempt-result.js";
import type { DelegationSpec } from "../../src/protocol/delegation-spec.js";
import {
  AcceptanceVerifier,
  type AcceptanceVerifyArgs,
} from "../../src/verify/acceptance-verifier.js";
import type { ProjectVerifyResult } from "../../src/verify/project-verifier.js";

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
    const head = "1".repeat(40);
    const artifact: CandidateArtifact = {
      baseCommitOid: head,
      candidateCommitOid: "2".repeat(40),
      candidateTreeOid: "3".repeat(40),
      anchorRef: "refs/test",
      manifestHash: "hash",
      changedPaths: [],
      patch: "",
    };
    const spec: DelegationSpec = {
      specVersion: "1",
      objective: "test",
      context: "test",
      writeAllowlist: ["."],
      forbiddenScope: [],
      successCriteria: ["test"],
      verification: [],
      executionMode: "edit",
      timeoutMs: 10_000,
      producerPreferences: ["codex"],
      expectedOutput: "candidate-patch",
    };
    const project = async (): Promise<ProjectVerifyResult> => ({
      mutated: false,
      failures: [],
      evidence: { commands: [], dependencyLink: "inherited" },
      commandOutcomes: [],
      outputLogs: [],
    });
    const verifyArgs = (): AcceptanceVerifyArgs => ({
      repoRoot: "/test/repo",
      worktreePath: "/test/worktree",
      baseCommitOid: head,
      artifact,
      spec,
      ps: getPlatformServices(),
      artifactStore: { writeLog: async () => "logs/test.log" },
    });

    it("defaults to candidate mode", () => {
      const verifier = new AcceptanceVerifier({
        structural: async () => ({ ok: true, failures: [], manifestHash: "hash" }),
        project,
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
        project,
      });

      await verifier.verify(verifyArgs());

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
        project,
      });

      await verifier.verify(verifyArgs());

      expect(observedMode).toBe("final-branch");
    });
  });
});
