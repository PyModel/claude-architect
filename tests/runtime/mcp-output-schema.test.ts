import { describe, expect, it } from "vitest";
import { doctor } from "../../src/mcp/doctor.js";
import { delegatePipelineOutput, doctorOutput } from "../../src/mcp/server.js";
import type { PlatformServices } from "../../src/platform/platform-services.js";
import type { CapabilityReport } from "../../src/producers/producer-adapter.js";
import { RUNTIME_VERSION } from "../../src/protocol/versions.js";

// The advertised output schema is the contract a strict MCP client validates
// structured content against. A handler returning keys the schema omits fails
// client-side (-32602 "must NOT have additional properties") even when the
// server produced those keys itself — the doctor tool shipped exactly that
// defect. These tests parse real handler outputs through the advertised
// schemas and require a byte-exact round-trip: a key the schema drops (parse
// strips it, toStrictEqual catches it) and a key the schema lacks (strict
// parse throws) both fail here instead of in a client session.

function platformServices(): PlatformServices {
  return {
    os: "darwin",
    resolveExecutable: async () => ({
      kind: "native",
      command: "/usr/local/bin/node",
      prefixArgs: [],
      resolvedFrom: "test",
    }),
    async spawnSupervised() { throw new Error("unexpected spawn"); },
    async requestCooperativeCancellation() { throw new Error("unexpected cancellation"); },
    async terminateProcessTree() { throw new Error("unexpected termination"); },
    async getProcessStartToken() { throw new Error("unexpected process token"); },
    async terminateProcessTreeByPid() { throw new Error("unexpected termination"); },
    async acquireCheckoutLock() { throw new Error("unexpected lock"); },
    async createSecureTempDirectory() { throw new Error("unexpected temp directory"); },
    async canonicalizePath() { throw new Error("unexpected canonicalization"); },
    async acquireCleanupJournalLock() { throw new Error("unexpected cleanup journal lock"); },
    async assertDirectoryWriteIntegrity() { throw new Error("unexpected directory integrity check"); },
  };
}

function codexReport(): CapabilityReport {
  return {
    producerId: "codex",
    available: true,
    reason: null,
    os: "darwin",
    arch: "arm64",
    environmentType: "native",
    resolvedExecutable: null,
    version: "0.144.4",
    authState: "unknown",
    executionModes: ["edit"],
    structuredOutput: true,
    writeConfinementBackend: "codex-native-sandbox",
    laneEligibility: { edit: true },
  };
}

function fullPipelineResult() {
  return {
    runId: "run-1",
    status: "decision-ready",
    attempt: { resultVersion: "1", runId: "run-1" },
    increments: [],
    rounds: [],
    verification: null,
    gate: { decisionReady: true },
    finalCandidateCommit: "a".repeat(40),
    slices: [],
    haltedSliceIndex: null,
    failure: null,
  };
}

describe("MCP advertised output schemas", () => {
  it("doctor output round-trips its advertised schema with no stripped or undeclared keys", async () => {
    const result = await doctor({
      ps: platformServices(),
      env: { CLAUDE_PLUGIN_DATA: "/plugin-data" },
      nodeVersion: "22.17.0",
      arch: "arm64",
      environmentType: "native",
      git: async () => ({ stdout: "git version 2.49.0\n", stderr: "", exitCode: 0 }),
      probeAll: async () => [codexReport()],
      probeCowSupport: async () => ({ cowSupported: true, strategy: "clonefile" }),
      checkLiveBundle: async () => ({
        selfHosted: false,
        runningVersion: RUNTIME_VERSION,
        repositoryVersion: null,
        bundleMatches: null,
        stale: false,
      }),
    });

    expect(doctorOutput.parse(result)).toStrictEqual(result);
  });

  it("a full delegatePipeline result round-trips, including the failure classification", () => {
    const output = { ok: true, result: fullPipelineResult() };
    expect(delegatePipelineOutput.parse(output)).toStrictEqual(output);

    const failed = {
      ok: true,
      result: { ...fullPipelineResult(), status: "failed", failure: "verification-failure" },
    };
    expect(delegatePipelineOutput.parse(failed)).toStrictEqual(failed);
  });

  it("a delegatePipeline lane envelope round-trips its advertised schema", () => {
    const output = {
      ok: true,
      result: {
        runId: "run-1",
        status: "verified-candidate",
        producerId: "codex",
        manifestHash: "b".repeat(64),
        failure: null,
        durationMs: 1234,
      },
    };
    expect(delegatePipelineOutput.parse(output)).toStrictEqual(output);
  });

  it("rejects an undeclared result key instead of silently stripping it", () => {
    const drifted = {
      ok: true,
      result: { ...fullPipelineResult(), unexpectedFutureField: true },
    };
    expect(() => delegatePipelineOutput.parse(drifted)).toThrow();
  });
});
