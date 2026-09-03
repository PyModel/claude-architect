import { describe, expect, it, vi } from "vitest";
import { getPlatformServices } from "../../src/platform/select-platform.js";
import type { CandidateArtifact, CommandOutcome } from "../../src/protocol/attempt-result.js";
import type { DelegationSpec } from "../../src/protocol/delegation-spec.js";
import {
  AcceptanceVerifier,
  type AcceptanceVerifyArgs,
} from "../../src/verify/acceptance-verifier.js";
import type {
  ProjectCommandEvidence,
  ProjectVerifyResult,
} from "../../src/verify/project-verifier.js";
import type { StructuralVerifyResult } from "../../src/verify/structural-verifier.js";

const artifact: CandidateArtifact = {
  baseCommitOid: "a".repeat(40),
  candidateTreeOid: "b".repeat(40),
  candidateCommitOid: "c".repeat(40),
  anchorRef: "refs/claude-architect/candidates/acceptance-test",
  manifestHash: "d".repeat(64),
  changedPaths: [{
    path: "a.txt",
    changeType: "modified",
    mode: "100644",
    contentHash: "e".repeat(40),
  }],
  patch: "diff --git a/a.txt b/a.txt\n",
};

const spec: DelegationSpec = {
  specVersion: "1",
  objective: "verify the candidate",
  context: "test",
  writeAllowlist: ["a.txt"],
  forbiddenScope: [],
  successCriteria: ["verification passes"],
  verification: [{
    id: "check",
    executable: process.execPath,
    args: ["-e", "process.exit(0)"],
    cwd: ".",
    timeoutMs: 5_000,
    network: "denied",
    expectedExitCodes: [0],
  }],
  executionMode: "edit",
  timeoutMs: 10_000,
  producerPreferences: ["codex"],
  expectedOutput: "candidate-patch",
};

const outcome: CommandOutcome = {
  id: "check",
  executable: process.execPath,
  args: ["-e", "process.exit(0)"],
  exitCode: 0,
  timedOut: false,
  durationMs: 10,
  stdoutRef: "logs/verification-0-stdout.log",
  stderrRef: "logs/verification-0-stderr.log",
};

function args(writeLog = vi.fn(async (name: string) => `logs/${name}.log`)): AcceptanceVerifyArgs {
  return {
    repoRoot: "/repo",
    worktreePath: "/repo-worktree",
    baseCommitOid: artifact.baseCommitOid,
    artifact,
    spec,
    ps: getPlatformServices(),
    artifactStore: { writeLog },
  };
}

describe("AcceptanceVerifier", () => {
  it("short-circuits project verification when structural verification fails", async () => {
    const structuralResult: StructuralVerifyResult = {
      ok: false,
      failures: ["manifest-divergence"],
      manifestHash: "f".repeat(64),
    };
    const structural = vi.fn(async () => structuralResult);
    const project = vi.fn();
    const verifyArgs = args();

    const result = await new AcceptanceVerifier({ structural, project }).verify(verifyArgs);

    expect(project).not.toHaveBeenCalled();
    expect(verifyArgs.artifactStore.writeLog).not.toHaveBeenCalled();
    expect(result).toEqual({
      ok: false,
      failures: ["manifest-divergence"],
      evidence: {
        structural: {
          manifestHash: structuralResult.manifestHash,
          failures: structuralResult.failures,
        },
      },
      commandOutcomes: [],
    });
  });

  it("archives project logs and returns merged passing evidence", async () => {
    const structuralResult: StructuralVerifyResult = {
      ok: true,
      failures: [],
      manifestHash: artifact.manifestHash,
    };
    const projectResult: ProjectVerifyResult = {
      commandOutcomes: [outcome],
      mutated: false,
      failures: [],
      evidence: {
        commands: [{
          id: "check",
          confinement: "none",
          networkPolicy: "unenforced",
          requestedNetwork: "denied",
          skipped: false,
        }],
        dependencyLink: "inherited",
      },
      outputLogs: [
        { name: "verification-0-stdout", text: "passed\n" },
        { name: "verification-0-stderr", text: "" },
      ],
    };
    const structural = vi.fn(async () => structuralResult);
    const project = vi.fn(async () => projectResult);
    const writeLog = vi.fn(async (name: string) => `logs/${name}.log`);

    const result = await new AcceptanceVerifier({ structural, project }).verify(args(writeLog));

    expect(writeLog.mock.calls).toEqual([
      ["verification-0-stdout", "passed\n"],
      ["verification-0-stderr", ""],
    ]);
    expect(result).toEqual({
      ok: true,
      failures: [],
      evidence: {
        structural: { manifestHash: artifact.manifestHash, failures: [] },
        project: {
          mutated: false,
          failures: [],
          commands: projectResult.evidence.commands,
          dependencyLink: "inherited",
        },
        verificationPolicy: projectResult.evidence.commands,
      },
      commandOutcomes: [outcome],
    });
    expect(structural).toHaveBeenCalledWith(expect.objectContaining({
      writeAllowlist: spec.writeAllowlist,
      forbiddenScope: spec.forbiddenScope,
    }), "candidate");
    expect(project).toHaveBeenCalledWith(expect.objectContaining({
      commands: spec.verification,
    }));
    const evidence = result.evidence as {
      project: { commands: ProjectCommandEvidence[]; dependencyLink: string };
      verificationPolicy: ProjectCommandEvidence[];
    };
    expect(evidence.project.commands).not.toBe(evidence.verificationPolicy);
    expect(evidence.project.commands[0]).not.toBe(evidence.verificationPolicy[0]);
    expect(evidence.project.dependencyLink).toBe("inherited");
    evidence.project.commands[0]!.skipped = true;
    expect(evidence.verificationPolicy[0]!.skipped).toBe(false);
  });

  it("passes a distinct log namespace through to project verification", async () => {
    const structural = vi.fn(async (): Promise<StructuralVerifyResult> => ({
      ok: true,
      failures: [],
      manifestHash: artifact.manifestHash,
    }));
    const namespacedOutcome = {
      ...outcome,
      stdoutRef: "logs/pipeline-verification-0-stdout.log",
      stderrRef: "logs/pipeline-verification-0-stderr.log",
    };
    const project = vi.fn(async (): Promise<ProjectVerifyResult> => ({
      commandOutcomes: [namespacedOutcome],
      mutated: false,
      failures: [],
      evidence: {
        commands: [{
          id: "check",
          confinement: "none",
          networkPolicy: "unenforced",
          requestedNetwork: "denied",
          skipped: false,
        }],
        dependencyLink: "none",
      },
      outputLogs: [
        { name: "pipeline-verification-0-stdout", text: "" },
        { name: "pipeline-verification-0-stderr", text: "" },
      ],
    }));
    const verifyArgs = args();
    verifyArgs.logNamePrefix = "pipeline-verification";

    const result = await new AcceptanceVerifier({ structural, project }).verify(verifyArgs);

    expect(result.ok).toBe(true);
    expect(project).toHaveBeenCalledWith(expect.objectContaining({
      logNamePrefix: "pipeline-verification",
    }));
    expect(verifyArgs.artifactStore.writeLog).toHaveBeenCalledWith(
      "pipeline-verification-0-stdout",
      "",
    );
  });

  it("fails when project verification reports mutation without a failure string", async () => {
    const structural = vi.fn(async (): Promise<StructuralVerifyResult> => ({
      ok: true,
      failures: [],
      manifestHash: artifact.manifestHash,
    }));
    const project = vi.fn(async (): Promise<ProjectVerifyResult> => ({
      commandOutcomes: [outcome],
      mutated: true,
      failures: [],
      evidence: { commands: [], dependencyLink: "none" },
      outputLogs: [
        { name: "verification-0-stdout", text: "" },
        { name: "verification-0-stderr", text: "" },
      ],
    }));

    const result = await new AcceptanceVerifier({ structural, project }).verify(args());

    expect(result.ok).toBe(false);
    expect(result.failures).toContain("verification-mutated");
  });

  it("independently rejects an outcome outside its Host-declared exit contract", async () => {
    const structural = vi.fn(async (): Promise<StructuralVerifyResult> => ({
      ok: true,
      failures: [],
      manifestHash: artifact.manifestHash,
    }));
    const project = vi.fn(async (): Promise<ProjectVerifyResult> => ({
      commandOutcomes: [{ ...outcome, exitCode: 1 }],
      mutated: false,
      failures: [],
      evidence: { commands: [], dependencyLink: "none" },
      outputLogs: [
        { name: "verification-0-stdout", text: "" },
        { name: "verification-0-stderr", text: "" },
      ],
    }));

    const result = await new AcceptanceVerifier({ structural, project }).verify(args());

    expect(result.ok).toBe(false);
    expect(result.failures).toContain("command-outcome-mismatch");
  });

  it("independently rejects a missing outcome for a Host-declared command", async () => {
    const structural = vi.fn(async (): Promise<StructuralVerifyResult> => ({
      ok: true,
      failures: [],
      manifestHash: artifact.manifestHash,
    }));
    const project = vi.fn(async (): Promise<ProjectVerifyResult> => ({
      commandOutcomes: [],
      mutated: false,
      failures: [],
      evidence: { commands: [], dependencyLink: "none" },
      outputLogs: [],
    }));

    const result = await new AcceptanceVerifier({ structural, project }).verify(args());

    expect(result.failures).toContain("command-outcome-mismatch");
  });

  it("independently rejects duplicate outcomes for one Host-declared command", async () => {
    const structural = vi.fn(async (): Promise<StructuralVerifyResult> => ({
      ok: true,
      failures: [],
      manifestHash: artifact.manifestHash,
    }));
    const duplicate = {
      ...outcome,
      stdoutRef: "logs/verification-1-stdout.log",
      stderrRef: "logs/verification-1-stderr.log",
    };
    const project = vi.fn(async (): Promise<ProjectVerifyResult> => ({
      commandOutcomes: [outcome, duplicate],
      mutated: false,
      failures: [],
      evidence: { commands: [], dependencyLink: "none" },
      outputLogs: [
        { name: "verification-0-stdout", text: "" },
        { name: "verification-0-stderr", text: "" },
        { name: "verification-1-stdout", text: "" },
        { name: "verification-1-stderr", text: "" },
      ],
    }));

    const result = await new AcceptanceVerifier({ structural, project }).verify(args());

    expect(result.failures).toContain("command-outcome-mismatch");
  });

  // `command-outcome-mismatch` means the reported outcomes do not correspond to
  // the commands the host declared — a trust-boundary signal. A command that ran
  // and honestly reported a failing exit code corresponds perfectly; that is
  // `command-failed:<id>`. Conflating the two fired the mismatch alongside every
  // ordinary verification failure, which is 15 of 15 occurrences in the field.
  it("reports a failing command without claiming the outcomes mismatch the spec", async () => {
    const structural = vi.fn(async (): Promise<StructuralVerifyResult> => ({
      ok: true,
      failures: [],
      manifestHash: artifact.manifestHash,
    }));
    const project = vi.fn(async (): Promise<ProjectVerifyResult> => ({
      commandOutcomes: [{ ...outcome, exitCode: 1 }],
      mutated: false,
      failures: ["command-failed:check"],
      evidence: {
        commands: [{
          id: "check",
          confinement: "none",
          networkPolicy: "unenforced",
          requestedNetwork: "denied",
          skipped: false,
        }],
        dependencyLink: "none",
      },
      outputLogs: [
        { name: "verification-0-stdout", text: "" },
        { name: "verification-0-stderr", text: "" },
      ],
    }));

    const result = await new AcceptanceVerifier({ structural, project }).verify(args());

    expect(result.ok).toBe(false);
    expect(result.failures).toContain("command-failed:check");
    expect(result.failures).not.toContain("command-outcome-mismatch");
  });

  // The counterpart: removing the pass/fail term must not disarm the check.
  it("still reports a mismatch when a declared command has no outcome", async () => {
    const structural = vi.fn(async (): Promise<StructuralVerifyResult> => ({
      ok: true,
      failures: [],
      manifestHash: artifact.manifestHash,
    }));
    const project = vi.fn(async (): Promise<ProjectVerifyResult> => ({
      commandOutcomes: [],
      mutated: false,
      failures: [],
      evidence: {
        commands: [{
          id: "check",
          confinement: "none",
          networkPolicy: "unenforced",
          requestedNetwork: "denied",
          skipped: false,
        }],
        dependencyLink: "none",
      },
      outputLogs: [],
    }));

    const result = await new AcceptanceVerifier({ structural, project }).verify(args());

    expect(result.failures).toContain("command-outcome-mismatch");
  });

  it("accepts a platform-filtered command when skipped evidence accounts for it", async () => {
    const structural = vi.fn(async (): Promise<StructuralVerifyResult> => ({
      ok: true,
      failures: [],
      manifestHash: artifact.manifestHash,
    }));
    const skippedCommand = {
      ...spec.verification[0]!,
      id: "other-platform",
      platform: { arch: ["not-this-architecture"] },
    };
    const project = vi.fn(async (): Promise<ProjectVerifyResult> => ({
      commandOutcomes: [outcome],
      mutated: false,
      failures: [],
      evidence: {
        commands: [
          {
            id: "check",
            confinement: "none",
            networkPolicy: "unenforced",
            requestedNetwork: "denied",
            skipped: false,
          },
          {
            id: "other-platform",
            confinement: "none",
            networkPolicy: "unenforced",
            requestedNetwork: "denied",
            skipped: true,
            skipReason: "platform-arch",
          },
        ],
        dependencyLink: "none",
      },
      outputLogs: [
        { name: "verification-0-stdout", text: "" },
        { name: "verification-0-stderr", text: "" },
      ],
    }));
    const verifyArgs = args();
    verifyArgs.spec = {
      ...spec,
      verification: [spec.verification[0]!, skippedCommand],
    };

    const result = await new AcceptanceVerifier({ structural, project }).verify(verifyArgs);

    expect(result.ok).toBe(true);
    expect(result.failures).toEqual([]);
  });

  it("rejects an empty verification success", async () => {
    const structural = vi.fn(async (): Promise<StructuralVerifyResult> => ({
      ok: true,
      failures: [],
      manifestHash: artifact.manifestHash,
    }));
    const project = vi.fn(async (): Promise<ProjectVerifyResult> => ({
      commandOutcomes: [],
      mutated: false,
      failures: [],
      evidence: { commands: [], dependencyLink: "none" },
      outputLogs: [],
    }));

    const result = await new AcceptanceVerifier({ structural, project }).verify(args());

    expect(result.ok).toBe(false);
    expect(result.failures).toEqual(["empty-verification", "command-outcome-mismatch"]);
  });

  it("rejects mismatched project log refs before writing partial archive evidence", async () => {
    const structural = vi.fn(async (): Promise<StructuralVerifyResult> => ({
      ok: true,
      failures: [],
      manifestHash: artifact.manifestHash,
    }));
    const project = vi.fn(async (): Promise<ProjectVerifyResult> => ({
      commandOutcomes: [{ ...outcome, stdoutRef: "logs/wrong.log" }],
      mutated: false,
      failures: [],
      evidence: { commands: [], dependencyLink: "none" },
      outputLogs: [
        { name: "verification-0-stdout", text: "" },
        { name: "verification-0-stderr", text: "" },
      ],
    }));
    const verifyArgs = args();

    await expect(new AcceptanceVerifier({ structural, project }).verify(verifyArgs))
      .rejects.toThrow("log references do not match");
    expect(verifyArgs.artifactStore.writeLog).not.toHaveBeenCalled();
  });

  it("rejects an unexpected archive reference", async () => {
    const structural = vi.fn(async (): Promise<StructuralVerifyResult> => ({
      ok: true,
      failures: [],
      manifestHash: artifact.manifestHash,
    }));
    const project = vi.fn(async (): Promise<ProjectVerifyResult> => ({
      commandOutcomes: [outcome],
      mutated: false,
      failures: [],
      evidence: { commands: [], dependencyLink: "none" },
      outputLogs: [
        { name: "verification-0-stdout", text: "" },
        { name: "verification-0-stderr", text: "" },
      ],
    }));
    const writeLog = vi.fn(async () => "logs/unexpected.log");

    await expect(new AcceptanceVerifier({ structural, project }).verify(args(writeLog)))
      .rejects.toThrow("unexpected verification log reference");
  });
});
