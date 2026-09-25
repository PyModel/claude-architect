import { describe, expect, it } from "vitest";
import { PosixPlatformServices } from "../../src/platform/posix-platform-services.js";
import type { DelegationSpec } from "../../src/protocol/delegation-spec.js";
import { producerRuntime } from "../../src/producers/producer-runtime.js";
import { registry } from "../../src/producers/producer-registry.js";
import { RuntimeError } from "../../src/util/errors.js";

const LANES = ["agy", "claude", "codex", "opencode", "pi", "pythinker"] as const;

function sampleSpec(lane: string): DelegationSpec {
  return {
    schemaVersion: 1,
    producer: lane,
    executionMode: "edit",
    objective: "Implement feature X in src/lib.ts",
    context: "Unit tests are failing",
    writeAllowlist: ["src/**"],
    forbiddenScope: ["dist/**"],
    successCriteria: ["Unit tests pass"],
    timeoutMs: 60_000,
  };
}

describe("cross-lane launch consistency", () => {
  it("proves each lane produces identical invocation, environment, and sandbox policy for equivalent edit runs", async () => {
    const ps = new PosixPlatformServices();
    const worktreePath = "/tmp/claude-architect-test-worktree";

    for (const lane of LANES) {
      const adapter = registry.get(lane);
      expect(adapter).toBeDefined();

      const report = await adapter!.probe({
        ps,
        os: "darwin",
        arch: "arm64",
        environmentType: "native",
      });

      // Ensure capability report is eligible for edit test
      const testReport = {
        ...report,
        resolvedExecutable: report.resolvedExecutable ?? {
          kind: "native" as const,
          command: `/usr/local/bin/${lane}`,
          prefixArgs: [],
          resolvedFrom: "test",
        },
        writeConfinementBackend: lane === "codex" ? "codex-native-sandbox" : "macos-seatbelt",
        laneEligibility: { edit: true },
      };

      const spec = sampleSpec(lane);
      const tempHome = (lane === "codex" || lane === "opencode") ? "/tmp/test-temp-home" : null;

      // Launch plan 1: standard attempt runtime intent
      const planAttempt = await producerRuntime.planLaunch({
        producerId: lane,
        spec,
        worktreePath,
        intent: "edit",
        ps,
        runId: "run-attempt-consistency",
        tempHome,
        capabilityReport: testReport,
      });

      // Launch plan 2: pipeline role runner intent
      const planPipeline = await producerRuntime.planLaunch({
        producerId: lane,
        spec,
        worktreePath,
        intent: "edit",
        ps,
        runId: "run-pipeline-consistency",
        tempHome,
        capabilityReport: testReport,
      });

      // Verify identical executable and arguments
      expect(planAttempt.supervisedInvocation.executable).toEqual(planPipeline.supervisedInvocation.executable);
      expect(planAttempt.supervisedInvocation.args).toEqual(planPipeline.supervisedInvocation.args);

      // Verify identical confinement backend and policy
      expect(planAttempt.confinementBackend).toEqual(planPipeline.confinementBackend);

      // Verify identical environment keys
      expect(Object.keys(planAttempt.builtEnvironment.env).sort()).toEqual(
        Object.keys(planPipeline.builtEnvironment.env).sort(),
      );

      // Verify identical tempHome allocation behavior
      expect(planAttempt.tempHome !== null).toBe(planPipeline.tempHome !== null);
    }
  });

  it("refuses declared-writable-state combined with temporary HOME for inherited-config lanes", async () => {
    const ps = new PosixPlatformServices();
    const inheritedLanes = ["agy", "claude", "pi", "pythinker"] as const;

    for (const lane of inheritedLanes) {
      const adapter = registry.get(lane);
      expect(adapter).toBeDefined();

      const testReport = {
        producerId: lane,
        available: true,
        reason: null,
        os: "darwin" as const,
        arch: "arm64",
        environmentType: "native" as const,
        resolvedExecutable: {
          kind: "native" as const,
          command: `/usr/local/bin/${lane}`,
          prefixArgs: [],
          resolvedFrom: "test",
        },
        version: "1.0.0",
        authState: "unknown" as const,
        executionModes: ["edit" as const],
        structuredOutput: true,
        writeConfinementBackend: "macos-seatbelt",
        laneEligibility: { edit: true },
      };

      await expect(
        producerRuntime.planLaunch({
          producerId: lane,
          spec: sampleSpec(lane),
          worktreePath: "/tmp/worktree",
          intent: "edit",
          ps,
          tempHome: "/tmp/forced-temp-home",
          capabilityReport: testReport,
        }),
      ).rejects.toThrow(RuntimeError);

      await expect(
        producerRuntime.planLaunch({
          producerId: lane,
          spec: sampleSpec(lane),
          worktreePath: "/tmp/worktree",
          intent: "edit",
          ps,
          tempHome: "/tmp/forced-temp-home",
          capabilityReport: testReport,
        }),
      ).rejects.toThrow(
        `Declared writable state cannot be combined with temporary HOME isolation for producer '${lane}'`,
      );
    }
  });

  it("allows temporary HOME for controlled-config lanes", async () => {
    const ps = new PosixPlatformServices();
    const controlledLanes = ["codex", "opencode"] as const;

    for (const lane of controlledLanes) {
      const testReport = {
        producerId: lane,
        available: true,
        reason: null,
        os: "darwin" as const,
        arch: "arm64",
        environmentType: "native" as const,
        resolvedExecutable: {
          kind: "native" as const,
          command: `/usr/local/bin/${lane}`,
          prefixArgs: [],
          resolvedFrom: "test",
        },
        version: "1.0.0",
        authState: "unknown" as const,
        executionModes: ["edit" as const],
        structuredOutput: true,
        writeConfinementBackend: lane === "codex" ? "codex-native-sandbox" : "macos-seatbelt",
        laneEligibility: { edit: true },
      };

      const plan = await producerRuntime.planLaunch({
        producerId: lane,
        spec: sampleSpec(lane),
        worktreePath: "/tmp/worktree",
        intent: "edit",
        ps,
        tempHome: "/tmp/forced-temp-home",
        capabilityReport: testReport,
      });

      expect(plan.tempHome).toBe("/tmp/forced-temp-home");
    }
  });
});
