import { describe, expect, it } from "vitest";
import { PosixPlatformServices } from "../../src/platform/posix-platform-services.js";
import { ProducerRuntime } from "../../src/producers/producer-runtime.js";
import { ProducerRegistry } from "../../src/producers/producer-registry.js";
import type {
  CapabilityReport,
  ProbeContext,
  ProducerAdapter,
} from "../../src/producers/producer-adapter.js";

function makeTestAdapter(id: string, version = "1.0.0"): {
  adapter: ProducerAdapter;
  probeCalls: number;
} {
  let probeCalls = 0;
  const adapter: ProducerAdapter = {
    producerId: id,
    structuredOutput: false,
    executionModes: ["edit"],
    async probe(ctx: ProbeContext): Promise<CapabilityReport> {
      probeCalls++;
      return {
        producerId: id,
        available: true,
        reason: null,
        os: ctx.os,
        arch: ctx.arch,
        environmentType: ctx.environmentType,
        resolvedExecutable: {
          kind: "native",
          command: `/bin/${id}`,
          prefixArgs: [],
          resolvedFrom: "test",
        },
        version,
        authState: "authenticated",
        executionModes: ["edit"],
        structuredOutput: false,
        writeConfinementBackend: null,
        laneEligibility: { edit: false },
      };
    },
    buildInvocation() {
      throw new Error("not implemented");
    },
    normalizeEvents(raw) {
      return { events: [], producerSummary: raw.stdout, ok: true };
    },
    configurationProfile() {
      return {
        isolationState: "controlled-config-supported",
        credentialSources: [],
        behavioralConfigSources: [],
        repositoryInstructionSources: [],
        environmentDependencies: [],
        temporaryHomeStrategy: "temporary HOME directory",
      };
    },
  };

  return {
    get probeCalls() {
      return probeCalls;
    },
    adapter,
  };
}

describe("producer probe cache", () => {
  it("caches probe results within a run and reports cache hits", async () => {
    const adapters = ["agy", "claude", "codex", "opencode", "pi", "pythinker"].map(id =>
      makeTestAdapter(id),
    );
    const registry = new ProducerRegistry(adapters.map(e => e.adapter));

    const runtime = new ProducerRuntime(registry);
    const ps = new PosixPlatformServices();
    ps.resolveExecutable = async query => ({
      kind: "native",
      command: `/bin/${query.name}`,
      prefixArgs: [],
      resolvedFrom: "test",
    });

    const ctx: ProbeContext = {
      ps,
      os: "darwin",
      arch: "arm64",
      environmentType: "native",
    };

    // First call (Role 1 / initial routing): all 6 probed fresh
    const reports1 = await runtime.probeAll(ctx);
    expect(reports1).toHaveLength(6);
    expect(runtime.probeCacheHits).toBe(0);
    for (const a of adapters) {
      expect(a.probeCalls).toBe(1);
    }

    // Second call (Role 2): all 6 hits from cache!
    const reports2 = await runtime.probeAll(ctx);
    expect(reports2).toHaveLength(6);
    expect(runtime.probeCacheHits).toBe(6);
    for (const a of adapters) {
      expect(a.probeCalls).toBe(1);
    }

    // Third call (Role 3): another 6 hits from cache!
    const reports3 = await runtime.probeAll(ctx);
    expect(reports3).toHaveLength(6);
    expect(runtime.probeCacheHits).toBe(12);
    for (const a of adapters) {
      expect(a.probeCalls).toBe(1);
    }
  });

  it("detects a swapped executable between roles and probes fresh", async () => {
    let currentCommand = "/bin/custom-agent-v1";
    let probeCalls = 0;

    const adapter: ProducerAdapter = {
      producerId: "custom",
      structuredOutput: false,
      executionModes: ["edit"],
      async probe(ctx: ProbeContext): Promise<CapabilityReport> {
        probeCalls++;
        return {
          producerId: "custom",
          available: true,
          reason: null,
          os: ctx.os,
          arch: ctx.arch,
          environmentType: ctx.environmentType,
          resolvedExecutable: {
            kind: "native",
            command: currentCommand,
            prefixArgs: [],
            resolvedFrom: "test",
          },
          version: "1.0.0",
          authState: "authenticated",
          executionModes: ["edit"],
          structuredOutput: false,
          writeConfinementBackend: null,
          laneEligibility: { edit: false },
        };
      },
      buildInvocation() { throw new Error("not implemented"); },
      normalizeEvents(raw) { return { events: [], producerSummary: raw.stdout, ok: true }; },
      configurationProfile() {
        return {
          isolationState: "controlled-config-supported",
          credentialSources: [],
          behavioralConfigSources: [],
          repositoryInstructionSources: [],
          environmentDependencies: [],
          temporaryHomeStrategy: "temp",
        };
      },
    };

    const registry = new ProducerRegistry([adapter]);
    const runtime = new ProducerRuntime(registry);
    const ps = new PosixPlatformServices();
    // Intercept resolveExecutable so it reflects currentCommand
    ps.resolveExecutable = async query => ({
      kind: "native",
      command: currentCommand,
      prefixArgs: [],
      resolvedFrom: "test",
    });

    const ctx: ProbeContext = {
      ps,
      os: "darwin",
      arch: "arm64",
      environmentType: "native",
    };

    // Role 1 probe
    await runtime.probe("custom", ctx);
    expect(probeCalls).toBe(1);
    expect(runtime.probeCacheHits).toBe(0);

    // Repeated probe with identical executable: cache hit
    await runtime.probe("custom", ctx);
    expect(probeCalls).toBe(1);
    expect(runtime.probeCacheHits).toBe(1);

    // Swapped executable between roles!
    currentCommand = "/bin/custom-agent-v2";

    // Role 2 probe detects swapped executable and probes fresh
    await runtime.probe("custom", ctx);
    expect(probeCalls).toBe(2);
    expect(runtime.probeCacheHits).toBe(1);

    // Re-probing v2 hits the cache
    await runtime.probe("custom", ctx);
    expect(probeCalls).toBe(2);
    expect(runtime.probeCacheHits).toBe(2);
  });

  it("always bypasses the cache when fresh: true is requested (doctor)", async () => {
    const entry = makeTestAdapter("codex");
    const registry = new ProducerRegistry([entry.adapter]);

    const runtime = new ProducerRuntime(registry);
    const ps = new PosixPlatformServices();
    ps.resolveExecutable = async query => ({
      kind: "native",
      command: `/bin/${query.name}`,
      prefixArgs: [],
      resolvedFrom: "test",
    });

    const ctx: ProbeContext = {
      ps,
      os: "darwin",
      arch: "arm64",
      environmentType: "native",
    };

    await runtime.probe("codex", ctx);
    expect(entry.probeCalls).toBe(1);

    // Regular call hits cache
    await runtime.probe("codex", ctx);
    expect(entry.probeCalls).toBe(1);
    expect(runtime.probeCacheHits).toBe(1);

    // Doctor fresh call bypasses cache
    await runtime.probe("codex", ctx, { fresh: true });
    expect(entry.probeCalls).toBe(2);
    expect(runtime.probeCacheHits).toBe(1);
  });
});
