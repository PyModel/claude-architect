import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import type {
  PlatformServices,
  ResolvedExecutable,
  SupervisedExit,
} from "../../src/platform/platform-services.js";
import { AgyAdapter } from "../../src/producers/agy-adapter.js";
import { ClaudeAdapter } from "../../src/producers/claude-adapter.js";
import { CodexAdapter } from "../../src/producers/codex-adapter.js";
import { OpenCodeAdapter } from "../../src/producers/opencode-adapter.js";
import { PiAdapter } from "../../src/producers/pi-adapter.js";
import { PythinkerAdapter } from "../../src/producers/pythinker-adapter.js";
import type { ProbeContext, ProducerAdapter } from "../../src/producers/producer-adapter.js";

function exit(overrides: Partial<SupervisedExit> = {}): SupervisedExit {
  return {
    exitCode: 0,
    signal: null,
    timedOut: false,
    cancelled: false,
    stdout: "",
    stderr: "",
    truncated: { stdout: false, stderr: false },
    ...overrides,
  };
}

function mockPlatformServices(
  name: string,
  supervisedExit: SupervisedExit,
): PlatformServices {
  const executable: ResolvedExecutable = {
    kind: "native",
    command: `/usr/local/bin/${name}`,
    prefixArgs: [],
    resolvedFrom: "test",
  };

  return {
    os: "darwin",
    async resolveExecutable() {
      return executable;
    },
    async spawnSupervised(request) {
      // For claude/pythinker inspectSurface probes, respond with supported help output
      if (request.args.includes("--help")) {
        const helpOutput = request.executable.command.includes("claude")
          ? "--no-session-persistence\n--strict-mcp-config\n--setting-sources\n"
          : "--prompt\n--model\n";
        return {
          pid: 42,
          stdout: Readable.from([]),
          stderr: Readable.from([]),
          done: Promise.resolve(exit({ stdout: helpOutput })),
        };
      }

      return {
        pid: 42,
        stdout: Readable.from([]),
        stderr: Readable.from([]),
        done: Promise.resolve(supervisedExit),
      };
    },
    async requestCooperativeCancellation() {},
    async terminateProcessTree() {},
    async getProcessStartToken() {
      return null;
    },
    async terminateProcessTreeByPid() {},
    async acquireCheckoutLock() {
      throw new Error("unexpected lock");
    },
    async acquireCleanupJournalLock() {
      throw new Error("unexpected cleanup journal lock");
    },
    async createSecureTempDirectory() {
      throw new Error("unexpected temp directory");
    },
    async canonicalizePath() {
      throw new Error("unexpected canonicalization");
    },
  };
}

describe("Cross-Lane Probe Abnormal Termination Guard (Slice 2.3)", () => {
  const laneFactories: { id: string; create: () => ProducerAdapter }[] = [
    { id: "codex", create: () => new CodexAdapter() },
    { id: "agy", create: () => new AgyAdapter() },
    { id: "claude", create: () => new ClaudeAdapter() },
    { id: "opencode", create: () => new OpenCodeAdapter() },
    { id: "pi", create: () => new PiAdapter() },
    { id: "pythinker", create: () => new PythinkerAdapter() },
  ];

  it("yields version: null and probe-failed for all six lanes when --version is signal-terminated", async () => {
    for (const { id, create } of laneFactories) {
      const ps = mockPlatformServices(
        id,
        exit({ exitCode: null, signal: "SIGTERM", stdout: "1.2.3\n" }),
      );
      const ctx: ProbeContext = {
        ps,
        os: "darwin",
        arch: "arm64",
        environmentType: "native",
      };

      const report = await create().probe(ctx);
      expect(report.version, `Lane ${id} must yield version: null when signalled`).toBeNull();
      expect(report.available, `Lane ${id} must not be available when signalled`).toBe(false);
      expect(report.reason, `Lane ${id} must report probe-failed when signalled`).toBe("probe-failed");
      expect(report.laneEligibility.edit, `Lane ${id} edit eligibility must be false`).toBe(false);
    }
  });

  it("yields version: null and probe-failed for all six lanes when --version times out", async () => {
    for (const { id, create } of laneFactories) {
      const ps = mockPlatformServices(
        id,
        exit({ timedOut: true, stdout: "1.2.3\n" }),
      );
      const ctx: ProbeContext = {
        ps,
        os: "darwin",
        arch: "arm64",
        environmentType: "native",
      };

      const report = await create().probe(ctx);
      expect(report.version, `Lane ${id} must yield version: null on timeout`).toBeNull();
      expect(report.available, `Lane ${id} must not be available on timeout`).toBe(false);
      expect(report.reason, `Lane ${id} must report probe-failed on timeout`).toBe("probe-failed");
      expect(report.laneEligibility.edit, `Lane ${id} edit eligibility must be false`).toBe(false);
    }
  });

  it("yields version: null and probe-failed for all six lanes when --version is cancelled", async () => {
    for (const { id, create } of laneFactories) {
      const ps = mockPlatformServices(
        id,
        exit({ cancelled: true, stdout: "1.2.3\n" }),
      );
      const ctx: ProbeContext = {
        ps,
        os: "darwin",
        arch: "arm64",
        environmentType: "native",
      };

      const report = await create().probe(ctx);
      expect(report.version, `Lane ${id} must yield version: null when cancelled`).toBeNull();
      expect(report.available, `Lane ${id} must not be available when cancelled`).toBe(false);
      expect(report.reason, `Lane ${id} must report probe-failed when cancelled`).toBe("probe-failed");
      expect(report.laneEligibility.edit, `Lane ${id} edit eligibility must be false`).toBe(false);
    }
  });

  it("succeeds for all six lanes when --version exits normally with 0 and clean exit state", async () => {
    for (const { id, create } of laneFactories) {
      const ps = mockPlatformServices(
        id,
        exit({ exitCode: 0, signal: null, stdout: "1.2.3\n" }),
      );
      const ctx: ProbeContext = {
        ps,
        os: "darwin",
        arch: "arm64",
        environmentType: "native",
      };

      const report = await create().probe(ctx);
      expect(report.version, `Lane ${id} must parse version 1.2.3`).toBe("1.2.3");
      expect(report.available, `Lane ${id} must be available`).toBe(true);
      expect(report.reason).toBeNull();
    }
  });
});
