import { describe, expect, it } from "vitest";
import type { PlatformServices, ResolvedExecutable } from "../../src/platform/platform-services.js";
import type { DelegationSpec } from "../../src/protocol/delegation-spec.js";
import {
  detectEnvironmentType,
  DescriptorAdapter,
  type CapabilityReport,
  type InvocationContext,
  type ProbeContext,
  type ProducerAdapter,
  type ProducerConfigurationProfile,
  type ProducerDescriptor,
  type ProducerInvocation,
} from "../../src/producers/producer-adapter.js";
import {
  isProducerAuthenticated,
  resolveDefaultEnv,
  resolveInheritedWritablePaths,
} from "../../src/producers/host-store.js";
import {
  EDIT_ACTION_PREAMBLE,
  LINT_BEFORE_TYPECHECK_INSTRUCTION,
} from "../../src/producers/prompt-renderer.js";

const executable: ResolvedExecutable = {
  kind: "native",
  command: "/usr/local/bin/fake",
  prefixArgs: [],
  resolvedFrom: "test",
};

class FakeAdapter implements ProducerAdapter {
  readonly producerId = "fake";

  async probe(ctx: ProbeContext): Promise<CapabilityReport> {
    return {
      producerId: this.producerId,
      available: true,
      reason: null,
      os: ctx.os,
      arch: ctx.arch,
      environmentType: ctx.environmentType,
      resolvedExecutable: executable,
      version: "1.0.0",
      authState: "unknown",
      executionModes: ["edit"],
      structuredOutput: true,
      writeConfinementBackend: "fake-sandbox",
      laneEligibility: { edit: true },
    };
  }

  buildInvocation(_spec: DelegationSpec, ctx: InvocationContext): ProducerInvocation {
    return {
      executable: ctx.executable,
      args: [],
      requiredEnv: [],
      network: "denied",
    };
  }

  normalizeEvents(
    _raw: Parameters<ProducerAdapter["normalizeEvents"]>[0],
  ): ReturnType<ProducerAdapter["normalizeEvents"]> {
    return { events: [], producerSummary: null, ok: true };
  }

  configurationProfile(): ProducerConfigurationProfile {
    return {
      isolationState: "controlled-config-supported",
      credentialSources: [],
      behavioralConfigSources: [],
      repositoryInstructionSources: [],
      environmentDependencies: [],
      temporaryHomeStrategy: "none",
    };
  }
}

describe("ProducerAdapter", () => {
  it("detects the certified macOS host as a native environment", () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { configurable: true, value: "darwin" });
    try {
      expect(detectEnvironmentType()).toBe("native");
    } finally {
      Object.defineProperty(process, "platform", {
        configurable: true,
        value: originalPlatform,
      });
    }
  });

  it("fails closed for uncertain Linux WSL probes while preserving clear native detection", () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { configurable: true, value: "linux" });
    try {
      expect(detectEnvironmentType(() => "Linux version 6.8.0-generic")).toBe("native");
      expect(detectEnvironmentType(() => "")).toBe("wsl");
      expect(detectEnvironmentType(() => {
        throw new Error("unreadable /proc/version");
      })).toBe("wsl");
    } finally {
      Object.defineProperty(process, "platform", {
        configurable: true,
        value: originalPlatform,
      });
    }
  });

  it("supports a shared adapter contract with boolean edit eligibility", async () => {
    const adapter: ProducerAdapter = new FakeAdapter();
    const report = await adapter.probe({
      ps: {} as PlatformServices,
      os: "darwin",
      arch: "arm64",
      environmentType: "native",
    });

    expect(report.laneEligibility.edit).toBe(true);
  });

  it("treats a seventh-lane fixture as a pure data record descriptor", async () => {
    const seventhLaneDescriptor: ProducerDescriptor = {
      id: "seventh-lane",
      executable: { name: "seventh-cli" },
      isolation: "inherited-config-only",
      hostState: {
        resolveStore: ctx => `${ctx.homeDirectory}/.seventh`,
        authMarker: "token.json",
        inheritedWritablePaths: store => [store],
        defaultEnv: (store, ctx) => (ctx.env.SEVENTH_HOME ? {} : { SEVENTH_HOME: store }),
      },
      prompt: {
        actionPreamble: true,
        bootstrapPlacement: "before",
      },
      structuredOutput: true,
      executionModes: ["edit"],
    };

    // 1. Host-store functions operate on the pure data record
    const authed = isProducerAuthenticated(seventhLaneDescriptor, {
      env: {},
      homeDirectory: "/test/home",
      hasAuthStore: dir => dir === "/test/home/.seventh",
    });
    expect(authed).toBe(true);

    const unauthed = isProducerAuthenticated(seventhLaneDescriptor, {
      env: {},
      homeDirectory: "/test/home",
      hasAuthStore: () => false,
    });
    expect(unauthed).toBe(false);

    const writable = resolveInheritedWritablePaths(seventhLaneDescriptor, {
      env: {},
      homeDirectory: "/test/home",
    });
    expect(writable).toEqual(["/test/home/.seventh"]);

    const env = resolveDefaultEnv(seventhLaneDescriptor, {
      env: {},
      homeDirectory: "/test/home",
    });
    expect(env).toEqual({ SEVENTH_HOME: "/test/home/.seventh" });

    // 2. DescriptorAdapter wraps the data record directly without bespoke class boilerplate
    const adapter = new DescriptorAdapter(seventhLaneDescriptor, {
      env: {},
      homeDirectory: "/test/home",
      hasAuthStore: () => true,
    });

    expect(adapter.producerId).toBe("seventh-lane");
    expect(adapter.structuredOutput).toBe(true);
    expect(adapter.executionModes).toEqual(["edit"]);
    expect(adapter.configurationProfile().isolationState).toBe("inherited-config-only");

    const probeReport = await adapter.probe({
      ps: {
        resolveExecutable: async () => executable,
      } as unknown as PlatformServices,
      os: "darwin",
      arch: "arm64",
      environmentType: "native",
    });
    expect(probeReport.available).toBe(true);
    expect(probeReport.authState).toBe("authenticated");
    expect(probeReport.laneEligibility.edit).toBe(true);

    const invocation = adapter.buildInvocation(
      {
        id: "spec-seventh",
        objective: "Build seventh lane",
        context: "test",
        writeAllowlist: ["a.ts"],
        forbiddenScope: [],
        successCriteria: ["works"],
        executionMode: "edit",
        timeoutMs: 10_000,
      },
      {
        executable,
        worktreePath: "/tmp/worktree",
        tempHome: "/tmp/home",
      },
    );
    expect(invocation.stdin).toContain(EDIT_ACTION_PREAMBLE);
    expect(invocation.stdin).toContain(LINT_BEFORE_TYPECHECK_INSTRUCTION);
  });
});
