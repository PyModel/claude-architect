import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import type {
  PlatformServices,
  SupervisedExit,
} from "../../src/platform/platform-services.js";
import { probeAll } from "../../src/producers/capability-probe.js";
import { CodexAdapter } from "../../src/producers/codex-adapter.js";
import {
  ProducerRegistry,
  registry,
} from "../../src/producers/producer-registry.js";

function successfulExit(): SupervisedExit {
  return {
    exitCode: 0,
    signal: null,
    timedOut: false,
    cancelled: false,
    stdout: "codex-cli 0.144.4\n",
    stderr: "",
    truncated: { stdout: false, stderr: false },
  };
}

function platformServices(probeCount: { value: number }): PlatformServices {
  return {
    os: "darwin",
    async resolveExecutable() {
      return {
        kind: "native",
        command: "/usr/local/bin/codex-test-double",
        prefixArgs: [],
        resolvedFrom: "test",
      };
    },
    async spawnSupervised() {
      probeCount.value += 1;
      return {
        pid: 42,
        stdout: Readable.from([]),
        stderr: Readable.from([]),
        done: Promise.resolve(successfulExit()),
      };
    },
    async requestCooperativeCancellation() {},
    async terminateProcessTree() {},
    async terminateProcessTreeByPid() {},
    async acquireCheckoutLock() {
      throw new Error("unexpected lock acquisition");
    },
    async createSecureTempDirectory() {
      throw new Error("unexpected temp directory creation");
    },
    async canonicalizePath() {
      throw new Error("unexpected path canonicalization");
    },
  };
}

describe("ProducerRegistry", () => {
  it("exposes the registered adapters by identifier without preferences", () => {
    const adapter = new CodexAdapter();
    const testRegistry = new ProducerRegistry([adapter]);

    expect(testRegistry.get("codex")).toBe(adapter);
    expect(testRegistry.get("pi")).toBeUndefined();
    expect(testRegistry.all()).toEqual([adapter]);
    expect(registry.get("codex")).toBeInstanceOf(CodexAdapter);
    expect(registry.all().map(adapter => adapter.producerId)).toEqual([
      "codex",
      "opencode",
      "pi",
      "pythinker",
      "agy",
      "claude",
    ]);
  });
});

describe("probeAll", () => {
  it("returns one report per adapter and re-probes on every call", async () => {
    const probeCount = { value: 0 };
    const ps = platformServices(probeCount);
    const testRegistry = new ProducerRegistry([new CodexAdapter()]);
    const ctx = {
      ps,
      os: "darwin" as const,
      arch: "arm64",
      environmentType: "native" as const,
    };

    const first = await probeAll(ctx, testRegistry);
    const second = await probeAll(ctx, testRegistry);

    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({
      producerId: "codex",
      available: true,
      version: "0.144.4",
      laneEligibility: { edit: true },
    });
    expect(second).toHaveLength(1);
    expect(probeCount.value).toBe(2);
  });
});
