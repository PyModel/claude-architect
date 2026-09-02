import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import type {
  PlatformServices,
  ResolvedExecutable,
  SupervisedExit,
} from "../../src/platform/platform-services.js";
import { PosixPlatformServices } from "../../src/platform/posix-platform-services.js";
import { supervise } from "../../src/platform/process-supervisor.js";
import { wrapInvocationWithSeatbelt } from "../../src/platform/sandbox/seatbelt.js";
import type { DelegationSpec } from "../../src/protocol/delegation-spec.js";
import { OpenCodeAdapter } from "../../src/producers/opencode-adapter.js";
import { renderSkillBootstrap } from "../../src/producers/skill-bootstrap.js";
import type {
  CapabilityReport,
  InvocationContext,
  ProbeContext,
} from "../../src/producers/producer-adapter.js";
import {
  normalizePlainText,
  selectOsWriteConfinementBackend,
} from "../../src/producers/plain-text.js";
import { buildEnvironment } from "../../src/runtime/environment-policy.js";

const execFileAsync = promisify(execFile);
const executable: ResolvedExecutable = {
  kind: "native",
  command: "/usr/local/bin/opencode",
  prefixArgs: [],
  resolvedFrom: "test",
};

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

function unavailablePlatformServices(): PlatformServices {
  return {
    os: "darwin",
    async resolveExecutable() {
      throw new Error("not installed");
    },
    async spawnSupervised() {
      throw new Error("unexpected spawn");
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

function versionPlatformServices(
  resolvedExecutable: ResolvedExecutable,
  spawned: ResolvedExecutable[] = [],
  stdout = "opencode 1.2.3\n",
): PlatformServices {
  return {
    os: "darwin",
    async resolveExecutable() {
      return resolvedExecutable;
    },
    async spawnSupervised(request) {
      spawned.push(request.executable);
      return {
        pid: 42,
        stdout: Readable.from([]),
        stderr: Readable.from([]),
        done: Promise.resolve(exit({ stdout })),
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

function capabilityReport(): CapabilityReport {
  return {
    producerId: "opencode",
    available: true,
    reason: null,
    os: "darwin",
    arch: "arm64",
    environmentType: "native",
    resolvedExecutable: executable,
    version: "1.2.3",
    authState: "unknown",
    executionModes: ["edit"],
    structuredOutput: false,
    writeConfinementBackend: null,
    laneEligibility: { edit: false },
  };
}

function sampleSpec(): DelegationSpec {
  return {
    specVersion: "1",
    objective: "Update the greeting without changing any other behavior.",
    context: "The greeting is rendered from src/greeting.ts.",
    writeAllowlist: ["src/greeting.ts"],
    forbiddenScope: ["secrets/**"],
    successCriteria: ["The greeting says hello."],
    verification: [{
      id: "check",
      executable: "node",
      args: ["-e", "process.exit(0)"],
      cwd: ".",
      timeoutMs: 60_000,
      network: "denied",
      expectedExitCodes: [0],
    }],
    executionMode: "edit",
    timeoutMs: 60_000,
    producerPreferences: ["opencode"],
    expectedOutput: "candidate-patch",
  };
}

function invocationContext(worktreePath = "/tmp/attempt-worktree"): InvocationContext {
  return {
    worktreePath,
    runId: "run-opencode",
    tempHome: "/tmp/attempt-home",
    capabilityReport: capabilityReport(),
    executable,
  };
}

function probeContext(ps: PlatformServices): ProbeContext {
  return {
    ps,
    os: "darwin",
    arch: "arm64",
    environmentType: "native",
  };
}

describe("OpenCodeAdapter", () => {
  it("reports a missing executable without spawning or guessing auth state", async () => {
    await expect(new OpenCodeAdapter().probe(probeContext(
      unavailablePlatformServices(),
    ))).resolves.toMatchObject({
      producerId: "opencode",
      available: false,
      reason: "missing-executable",
      resolvedExecutable: null,
      version: null,
      authState: "unknown",
      writeConfinementBackend: null,
      laneEligibility: { edit: false },
    });
  });

  it("reports win32 as unsupported without resolving an executable", async () => {
    await expect(new OpenCodeAdapter().probe({
      ...probeContext(unavailablePlatformServices()),
      os: "win32",
    })).resolves.toMatchObject({
      available: false,
      reason: "unsupported-platform",
      resolvedExecutable: null,
    });
  });

  it("parses the OpenCode version and honestly gates edit eligibility", async () => {
    const report = await new OpenCodeAdapter({
      env: {},
      homeDirectory: "/hosthome",
      hasAuthStore: () => false,
    }).probe(probeContext(versionPlatformServices(executable)));

    expect(report).toMatchObject({
      producerId: "opencode",
      available: true,
      reason: null,
      version: "1.2.3",
      structuredOutput: false,
      writeConfinementBackend: "macos-seatbelt",
      laneEligibility: { edit: true },
    });
  });

  it("reports probe-failed when version output cannot be parsed", async () => {
    await expect(new OpenCodeAdapter().probe(probeContext(
      versionPlatformServices(executable, [], "opencode development\n"),
    ))).resolves.toMatchObject({
      available: false,
      reason: "probe-failed",
      resolvedExecutable: executable,
      version: null,
    });
  });

  it("reports authenticated when auth.json exists in the default store", async () => {
    const root = await mkdtemp(join(tmpdir(), "claude-architect-opencode-auth-"));
    const store = join(root, ".local", "share", "opencode");
    await mkdir(store, { recursive: true });
    await writeFile(join(store, "auth.json"), "fixture contents must not be read");

    try {
      const report = await new OpenCodeAdapter({
        env: {},
        homeDirectory: root,
      }).probe(probeContext(versionPlatformServices(executable)));

      expect(report.authState).toBe("authenticated");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reports unauthenticated when auth.json is absent from the default store", async () => {
    const root = await mkdtemp(join(tmpdir(), "claude-architect-opencode-auth-"));

    try {
      const report = await new OpenCodeAdapter({
        env: {},
        homeDirectory: root,
      }).probe(probeContext(versionPlatformServices(executable)));

      expect(report.authState).toBe("unauthenticated");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reports authenticated when auth.json exists in the store overridden by XDG_DATA_HOME", async () => {
    const root = await mkdtemp(join(tmpdir(), "claude-architect-opencode-auth-"));
    const customDataHome = join(root, "custom-data");
    const store = join(customDataHome, "opencode");
    await mkdir(store, { recursive: true });
    await writeFile(join(store, "auth.json"), "fixture contents must not be read");

    try {
      const report = await new OpenCodeAdapter({
        env: { XDG_DATA_HOME: customDataHome },
        homeDirectory: root,
      }).probe(probeContext(versionPlatformServices(executable)));

      expect(report.authState).toBe("authenticated");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("invokes a Node OpenCode entrypoint with the runtime Node executable", async () => {
    const root = await mkdtemp(join(tmpdir(), "claude-architect-opencode-entrypoint-"));
    const entrypoint = join(root, "opencode");
    await writeFile(entrypoint, "#!/usr/bin/env node\nconsole.log('opencode');\n");
    const spawned: ResolvedExecutable[] = [];
    const ps = versionPlatformServices({
      kind: "native",
      command: entrypoint,
      prefixArgs: [],
      resolvedFrom: `path:${entrypoint}`,
    }, spawned);

    try {
      const report = await new OpenCodeAdapter().probe(probeContext(ps));

      expect(spawned).toEqual([{
        kind: "node-entrypoint",
        command: process.execPath,
        prefixArgs: [entrypoint],
        resolvedFrom: `path:${entrypoint};node:${process.execPath}`,
      }]);
      expect(report.resolvedExecutable).toEqual(spawned[0]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("builds the exact argv-only invocation and sends the delegation prompt on stdin", () => {
    const spec = sampleSpec();
    const context = invocationContext();
    const invocation = new OpenCodeAdapter({
      env: {},
      homeDirectory: "/hosthome",
      hasAuthStore: () => false,
    }).buildInvocation(spec, context);

    expect(invocation.executable).toBe(executable);
    expect(invocation.args).toEqual([
      "run",
      "--dir",
      context.worktreePath,
      "--agent",
      "build",
      "--auto",
      "--log-level",
      "ERROR",
    ]);
    expect(invocation.args.join(" ")).not.toContain(spec.objective);
    expect(invocation.stdin).toContain(spec.objective);
    expect(invocation.stdin).toContain(spec.context);
    expect(invocation.stdin).toContain("src/greeting.ts");
    expect(invocation.stdin).toContain(renderSkillBootstrap());
    expect(invocation.requiredEnv).toEqual(["OPENCODE_CONFIG_DIR", "XDG_DATA_HOME"]);
    expect(invocation.network).toBe("allowed");
  });

  it("omits the delegated skill bootstrap from read-only prompts", () => {
    const invocation = new OpenCodeAdapter({
      env: {},
      homeDirectory: "/hosthome",
      hasAuthStore: () => false,
    }).buildInvocation(sampleSpec(), { ...invocationContext(), readOnly: true });

    expect(invocation.stdin).not.toContain("## Delegated procedure skills");
  });

  it("appends a model override to the invocation argv", () => {
    const spec = sampleSpec();
    spec.producerOverrides = { model: "provider/model" };

    expect(new OpenCodeAdapter({
      env: {},
      homeDirectory: "/hosthome",
      hasAuthStore: () => false,
    }).buildInvocation(spec, invocationContext()).args).toEqual([
      "run",
      "--dir",
      "/tmp/attempt-worktree",
      "--agent",
      "build",
      "--auto",
      "--log-level",
      "ERROR",
      "--model",
      "provider/model",
    ]);
  });

  it("defaults XDG_DATA_HOME to the host data directory when its auth store exists", () => {
    const dataHome = join("/hosthome", ".local", "share");
    const invocation = new OpenCodeAdapter({
      env: {},
      homeDirectory: "/hosthome",
      hasAuthStore: directory => directory === join(dataHome, "opencode"),
    }).buildInvocation(sampleSpec(), invocationContext());

    expect(invocation.env).toEqual({ XDG_DATA_HOME: dataHome });
  });

  it("does not default XDG_DATA_HOME when the host set it or no auth store exists", () => {
    const hostConfigured = new OpenCodeAdapter({
      env: { XDG_DATA_HOME: "/custom" },
      homeDirectory: "/hosthome",
      hasAuthStore: () => true,
    }).buildInvocation(sampleSpec(), invocationContext());
    const authAbsent = new OpenCodeAdapter({
      env: {},
      homeDirectory: "/hosthome",
      hasAuthStore: () => false,
    }).buildInvocation(sampleSpec(), invocationContext());

    expect(hostConfigured.env).toEqual({});
    expect(authAbsent.env).toEqual({});
  });

  it("normalizes successful plain text to a trimmed 8000-character tail", () => {
    const stdout = `  discarded-${"x".repeat(8_010)}-tail  \n`;
    const summary = stdout.trim().slice(-8_000);

    expect(new OpenCodeAdapter().normalizeEvents({
      stdout,
      stderr: "",
      exit: exit({ stdout }),
    })).toEqual({
      events: [{ kind: "final", text: summary }],
      producerSummary: summary,
      ok: true,
    });
  });

  it("rejects empty successful stdout", () => {
    expect(new OpenCodeAdapter().normalizeEvents({
      stdout: "  \n",
      stderr: "",
      exit: exit({ stdout: "  \n" }),
    })).toEqual({ events: [], producerSummary: null, ok: false });
  });

  it("prioritizes stdout truncation over other failures", () => {
    expect(new OpenCodeAdapter().normalizeEvents({
      stdout: "partial",
      stderr: "process failed",
      exit: exit({
        exitCode: 1,
        stdout: "partial",
        stderr: "process failed",
        truncated: { stdout: true, stderr: false },
      }),
    })).toEqual({
      events: [{ kind: "error", text: "stdout-truncated" }],
      producerSummary: null,
      ok: false,
    });
  });

  it("reports a small stderr message for a nonzero exit", () => {
    expect(new OpenCodeAdapter().normalizeEvents({
      stdout: "",
      stderr: "process failed",
      exit: exit({ exitCode: 1, stderr: "process failed" }),
    })).toEqual({
      events: [{ kind: "error", text: "process failed" }],
      producerSummary: null,
      ok: false,
    });
  });

  it("bounds a nonzero exit error to the last 8000 stderr characters", () => {
    const stderr = `discarded-${"e".repeat(8_005)}-tail`;

    const normalized = new OpenCodeAdapter().normalizeEvents({
      stdout: "",
      stderr,
      exit: exit({ exitCode: 2, stderr }),
    });

    expect(normalized).toEqual({
      events: [{ kind: "error", text: stderr.slice(-8_000) }],
      producerSummary: null,
      ok: false,
    });
    expect(normalized.events[0]?.text).toHaveLength(8_000);
  });

  it("treats a null exit code with a signal as a failure", () => {
    expect(new OpenCodeAdapter().normalizeEvents({
      stdout: "partial",
      stderr: "terminated",
      exit: exit({ exitCode: null, signal: "SIGTERM", stderr: "terminated" }),
    })).toEqual({
      events: [{ kind: "error", text: "terminated" }],
      producerSummary: null,
      ok: false,
    });
  });

  it("declares OpenCode's XDG data and state directories as inherited writable state", () => {
    const adapter = new OpenCodeAdapter({
      env: { XDG_STATE_HOME: "/Users/test/.local/state" },
      homeDirectory: "/Users/test",
      hasAuthStore: () => false,
    });
    const invocation = adapter.buildInvocation(sampleSpec(), invocationContext());
    expect(invocation.inheritedStateWritablePaths).toEqual([
      join("/Users/test", ".local", "share", "opencode"),
      join("/Users/test", ".local", "state", "opencode"),
    ]);
  });

  it("declares the OpenCode configuration isolation profile", () => {
    expect(new OpenCodeAdapter().configurationProfile()).toEqual({
      isolationState: "controlled-config-with-copied-credentials",
      credentialSources: ["~/.local/share/opencode/auth.json"],
      behavioralConfigSources: ["explicit invocation argv"],
      repositoryInstructionSources: ["worktree AGENTS.md"],
      environmentDependencies: ["OPENCODE_CONFIG_DIR", "XDG_DATA_HOME"],
      temporaryHomeStrategy: "temp HOME with XDG_DATA_HOME passthrough for the auth store",
    });
  });

  it.skipIf(
    process.platform !== "darwin"
      || process.arch !== "arm64"
      || process.env.RUN_SEATBELT_CONFINEMENT_GATE !== "1",
  )(
    "proves macOS Seatbelt permits worktree writes and blocks an outside write",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "claude-architect-seatbelt-gate-"));
      const worktreePath = join(root, "worktree");
      const insidePath = join(worktreePath, "inside-probe.txt");
      const outsidePath = join(
        "/Users/Shared",
        `.claude-architect-seatbelt-probe-${randomUUID()}`,
      );

      try {
        await mkdir(worktreePath);
        await execFileAsync("git", ["init", "-q"], { cwd: worktreePath });
        const ps = new PosixPlatformServices();
        const invocation = {
          executable: {
            kind: "native" as const,
            command: "/usr/bin/touch",
            prefixArgs: [],
            resolvedFrom: "seatbelt-confinement-gate",
          },
          args: [insidePath],
          requiredEnv: [],
          network: "denied" as const,
        };
        const policy = { worktreePath, tempHome: null, allowNetwork: false };
        const insideExit = await supervise(ps, {
          executable: wrapInvocationWithSeatbelt(invocation, policy).executable,
          args: wrapInvocationWithSeatbelt(invocation, policy).args,
          cwd: worktreePath,
          env: {},
          timeoutMs: 30_000,
          maxOutputBytes: 64 * 1024,
        }, {});

        expect(
          insideExit.exitCode,
          `stdout:\n${insideExit.stdout}\nstderr:\n${insideExit.stderr}`,
        ).toBe(0);
        await expect(access(insidePath)).resolves.toBeUndefined();

        const outsideInvocation = wrapInvocationWithSeatbelt({
          ...invocation,
          args: [outsidePath],
        }, policy);
        const outsideExit = await supervise(ps, {
          executable: outsideInvocation.executable,
          args: outsideInvocation.args,
          cwd: worktreePath,
          env: {},
          timeoutMs: 30_000,
          maxOutputBytes: 64 * 1024,
        }, {});

        expect(outsideExit.spawnError).toBeUndefined();
        expect(
          outsideExit.exitCode,
          `stdout:\n${outsideExit.stdout}\nstderr:\n${outsideExit.stderr}`,
        ).not.toBe(0);
        await expect(access(outsidePath)).rejects.toMatchObject({ code: "ENOENT" });
      } finally {
        await rm(outsidePath, { force: true });
        await rm(root, { recursive: true, force: true });
      }
    },
    60_000,
  );

  it.skipIf(
    process.platform !== "darwin"
      || process.arch !== "arm64"
      || process.env.RUN_OPENCODE_SMOKE !== "1",
  )(
    "runs a real OpenCode invocation through macOS Seatbelt",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "claude-architect-opencode-smoke-"));
      const worktreePath = join(root, "worktree");
      const smokePath = join(worktreePath, "smoke.txt");
      let builtEnvironment: ReturnType<typeof buildEnvironment> | undefined;

      try {
        await mkdir(worktreePath);
        await execFileAsync("git", ["init", "-q"], { cwd: worktreePath });
        const ps = new PosixPlatformServices();
        const adapter = new OpenCodeAdapter();
        const report = await adapter.probe({
          ps,
          os: "darwin",
          arch: process.arch,
          environmentType: "native",
        });
        if (!report.available) {
          expect(typeof report.reason).toBe("string");
          expect(report.reason).not.toBe("");
          return;
        }
        expect(report.resolvedExecutable).not.toBeNull();
        expect(typeof report.version).toBe("string");
        if (report.resolvedExecutable === null) return;
        console.info(`OpenCode smoke probe version: ${report.version}`);

        const spec = sampleSpec();
        spec.objective = "Create a file named smoke.txt containing ok.";
        spec.context = "This is an opt-in macOS arm64 adapter smoke test.";
        spec.writeAllowlist = ["smoke.txt"];
        spec.forbiddenScope = [];
        spec.successCriteria = ["smoke.txt exists and contains ok."];
        spec.timeoutMs = 300_000;
        const invocation = wrapInvocationWithSeatbelt(adapter.buildInvocation(spec, {
          worktreePath,
          runId: "run-opencode-smoke",
          capabilityReport: report,
          executable: report.resolvedExecutable,
        }), {
          worktreePath,
          tempHome: null,
          allowNetwork: true,
        });
        builtEnvironment = buildEnvironment({
          os: "darwin",
          adapterAllowlist: invocation.requiredEnv,
          ...(invocation.env === undefined ? {} : { adapterValues: invocation.env }),
        });
        const supervisedExit = await supervise(ps, {
          executable: invocation.executable,
          args: invocation.args,
          cwd: worktreePath,
          env: builtEnvironment.env,
          timeoutMs: 300_000,
          ...(invocation.stdin === undefined ? {} : { stdin: invocation.stdin }),
          maxOutputBytes: 1_000_000,
        }, {});
        const normalized = normalizePlainText({
          stdout: supervisedExit.stdout,
          stderr: supervisedExit.stderr,
          exit: supervisedExit,
        });

        expect(
          normalized.ok,
          `stdout:\n${supervisedExit.stdout}\nstderr:\n${supervisedExit.stderr}`,
        ).toBe(true);
        expect((await readFile(smokePath, "utf8")).trim()).toBe("ok");
      } finally {
        builtEnvironment?.secretRegistration.dispose();
        await rm(root, { recursive: true, force: true });
      }
    },
    330_000,
  );
});

describe("selectOsWriteConfinementBackend", () => {
  it("returns the certified seatbelt backend on darwin/arm64", () => {
    expect(selectOsWriteConfinementBackend(probeContext(
      unavailablePlatformServices(),
    ))).toBe("macos-seatbelt");
  });

  it("returns null for an uncertified host row", () => {
    expect(selectOsWriteConfinementBackend({
      ...probeContext(unavailablePlatformServices()),
      arch: "x64",
    })).toBeNull();
    expect(selectOsWriteConfinementBackend({
      ...probeContext(unavailablePlatformServices()),
      os: "linux",
    })).toBeNull();
  });
});
