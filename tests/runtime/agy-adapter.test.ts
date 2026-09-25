import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
import type { DelegationSpec } from "../../src/protocol/delegation-spec.js";
import { AgyAdapter } from "../../src/producers/agy-adapter.js";
import { renderProducerPrompt } from "../../src/producers/plain-text.js";
import { producerRuntime } from "../../src/producers/producer-runtime.js";
import { renderSkillBootstrap } from "../../src/producers/skill-bootstrap.js";
import type {
  CapabilityReport,
  InvocationContext,
  ProbeContext,
} from "../../src/producers/producer-adapter.js";

const execFileAsync = promisify(execFile);
const executable: ResolvedExecutable = {
  kind: "native",
  command: "/usr/local/bin/agy",
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
  stdout = "1.1.10\n",
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
    producerId: "agy",
    available: true,
    reason: null,
    os: "darwin",
    arch: "arm64",
    environmentType: "native",
    resolvedExecutable: executable,
    version: "1.1.10",
    authState: "unknown",
    executionModes: ["edit"],
    structuredOutput: true,
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
    producerPreferences: ["agy"],
    expectedOutput: "candidate-patch",
  };
}

function invocationContext(worktreePath = "/tmp/attempt-worktree"): InvocationContext {
  return {
    worktreePath,
    runId: "run-agy",
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

function baseArgs(worktreePath: string, prompt: string): string[] {
  return [
    "-p",
    prompt,
    "--add-dir",
    worktreePath,
    "--new-project",
    "--output-format",
    "json",
    "--dangerously-skip-permissions",
    "--print-timeout",
    "60s",
  ];
}

describe("AgyAdapter", () => {
  it("reports a missing executable without spawning or guessing auth state", async () => {
    await expect(new AgyAdapter().probe(probeContext(
      unavailablePlatformServices(),
    ))).resolves.toMatchObject({
      producerId: "agy",
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
    await expect(new AgyAdapter().probe({
      ...probeContext(unavailablePlatformServices()),
      os: "win32",
    })).resolves.toMatchObject({
      available: false,
      reason: "unsupported-platform",
      resolvedExecutable: null,
    });
  });

  it("parses the agy version and honestly gates edit eligibility", async () => {
    const root = await mkdtemp(join(tmpdir(), "claude-architect-agy-config-"));

    try {
      const report = await new AgyAdapter({
        env: {},
        homeDirectory: root,
      }).probe(probeContext(versionPlatformServices(executable)));

      expect(report).toMatchObject({
        producerId: "agy",
        available: true,
        reason: null,
        version: "1.1.10",
        structuredOutput: true,
        writeConfinementBackend: "macos-seatbelt",
        laneEligibility: { edit: true },
      });
      expect(report.laneEligibility.edit).toBe(report.writeConfinementBackend !== null);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reports probe-failed when version output cannot be parsed", async () => {
    await expect(new AgyAdapter().probe(probeContext(
      versionPlatformServices(executable, [], "agy development\n"),
    ))).resolves.toMatchObject({
      available: false,
      reason: "probe-failed",
      resolvedExecutable: executable,
      version: null,
    });
  });

  it("reports authenticated when settings.json exists in the default store", async () => {
    const root = await mkdtemp(join(tmpdir(), "claude-architect-agy-auth-"));
    const store = join(root, ".gemini", "antigravity-cli");
    await mkdir(store, { recursive: true });
    await writeFile(join(store, "settings.json"), "fixture contents must not be read");

    try {
      const report = await new AgyAdapter({
        env: {},
        homeDirectory: root,
      }).probe(probeContext(versionPlatformServices(executable)));

      expect(report.authState).toBe("authenticated");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reports unauthenticated when settings.json is absent from the default store", async () => {
    const root = await mkdtemp(join(tmpdir(), "claude-architect-agy-auth-"));

    try {
      const report = await new AgyAdapter({
        env: {},
        homeDirectory: root,
      }).probe(probeContext(versionPlatformServices(executable)));

      expect(report.authState).toBe("unauthenticated");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("builds the exact argv invocation, prompt included, with no stdin", () => {
    const spec = sampleSpec();
    const context = invocationContext();
    const prompt = renderProducerPrompt(spec, false);
    const invocation = new AgyAdapter().buildInvocation(spec, context);

    expect(invocation.executable).toBe(executable);
    expect(invocation.args).toEqual(baseArgs(context.worktreePath, prompt));
    expect(invocation.args[1]).toContain(spec.objective);
    expect(invocation.stdin).toBeUndefined();
    expect(invocation.requiredEnv).toEqual(["GEMINI_API_KEY"]);
    expect(invocation.network).toBe("allowed");
  });

  it("wraps an agy edit invocation with provider network and write confinement", async () => {
    const context = invocationContext();
    const spec = sampleSpec();
    const plan = await producerRuntime.planLaunch({
      producerId: "agy",
      spec,
      worktreePath: context.worktreePath,
      intent: "edit",
      ps: new PosixPlatformServices(),
      capabilityReport: {
        ...context.capabilityReport,
        writeConfinementBackend: "macos-seatbelt",
      },
    });
    const profile = plan.invocation.args[1] ?? "";

    expect(spec.executionMode).toBe("edit");
    expect(plan.confinementBackend).toBe("macos-seatbelt");
    expect(plan.invocation.executable.command).toBe("/usr/bin/sandbox-exec");
    expect(profile).not.toContain("(deny network*)");
    expect(profile).toContain("(deny file-write*)");
  });

  it("omits the delegated skill bootstrap from read-only prompts", () => {
    const invocation = new AgyAdapter()
      .buildInvocation(sampleSpec(), { ...invocationContext(), readOnly: true });

    expect(invocation.args.join("\n")).not.toContain("## Delegated procedure skills");
  });

  it("includes the delegated skill bootstrap in edit prompts", () => {
    const invocation = new AgyAdapter().buildInvocation(sampleSpec(), invocationContext());

    expect(invocation.args[1]).toContain(renderSkillBootstrap());
  });

  it("appends a model override to the invocation argv", () => {
    const spec = sampleSpec();
    spec.producerOverrides = { model: "gemini-3.6-flash-high" };
    const context = invocationContext();
    const prompt = renderProducerPrompt(spec, false);

    expect(new AgyAdapter().buildInvocation(spec, context).args).toEqual([
      ...baseArgs(context.worktreePath, prompt),
      "--model",
      "gemini-3.6-flash-high",
    ]);
  });

  it("appends an effort override without adding a model override", () => {
    const spec = sampleSpec();
    spec.producerOverrides = { reasoningEffort: "high" };
    const context = invocationContext();
    const prompt = renderProducerPrompt(spec, false);

    const args = new AgyAdapter().buildInvocation(spec, context).args;

    expect(args).toEqual([...baseArgs(context.worktreePath, prompt), "--effort", "high"]);
    expect(args).not.toContain("--model");
  });

  it("appends model then effort overrides to the invocation argv", () => {
    const spec = sampleSpec();
    spec.producerOverrides = { model: "gemini-3.6-flash-high", reasoningEffort: "medium" };
    const context = invocationContext();
    const prompt = renderProducerPrompt(spec, false);

    expect(new AgyAdapter().buildInvocation(spec, context).args).toEqual([
      ...baseArgs(context.worktreePath, prompt),
      "--model",
      "gemini-3.6-flash-high",
      "--effort",
      "medium",
    ]);
  });

  it("formats --print-timeout in whole seconds from spec.timeoutMs", () => {
    const spec = sampleSpec();
    spec.timeoutMs = 1_800_000;
    const context = invocationContext();

    expect(new AgyAdapter().buildInvocation(spec, context).args).toContain("1800s");
  });

  it("declares only ~/.gemini/antigravity-cli as inherited writable state", () => {
    const adapter = new AgyAdapter({ env: {}, homeDirectory: "/Users/test" });
    const invocation = adapter.buildInvocation(sampleSpec(), invocationContext());
    expect(invocation.inheritedStateWritablePaths).toEqual([join("/Users/test", ".gemini", "antigravity-cli")]);
  });

  it("declares the agy configuration isolation profile", () => {
    expect(new AgyAdapter().configurationProfile()).toEqual({
      isolationState: "inherited-config-only",
      credentialSources: [
        "macOS Keychain (\"Antigravity IDE Safe Storage\")",
        "GEMINI_API_KEY (optional, unconfirmed CI semantics)",
      ],
      behavioralConfigSources: ["~/.gemini/antigravity-cli/settings.json", "explicit invocation argv"],
      repositoryInstructionSources: ["worktree AGENTS.md"],
      environmentDependencies: ["GEMINI_API_KEY"],
      temporaryHomeStrategy:
        "real HOME inherited by declared policy (keyring auth is not HOME-redirectable); reduced reproducibility recorded in the Run Manifest",
    });
  });

  it("normalizes a successful JSON envelope", () => {
    const stdout = JSON.stringify({
      conversation_id: "72048b34-e2de-4b0d-9210-1ec44db53f01",
      status: "SUCCESS",
      response: "PROBE_OK\n",
      duration_seconds: 1.32995,
      num_turns: 1,
      usage: { input_tokens: 18548, output_tokens: 40, thinking_tokens: 32, cache_read_tokens: 0, total_tokens: 18588 },
    });
    const parsed = JSON.parse(stdout) as Record<string, unknown>;

    expect(new AgyAdapter().normalizeEvents({
      stdout,
      stderr: "",
      exit: exit({ stdout }),
    })).toEqual({
      events: [{ kind: "final", text: "PROBE_OK\n", raw: parsed }],
      producerSummary: "PROBE_OK\n",
      ok: true,
    });
  });

  it("reports failure for a non-SUCCESS status without setting a producer summary", () => {
    const stdout = JSON.stringify({ status: "ERROR", response: "model not found" });
    const parsed = JSON.parse(stdout) as Record<string, unknown>;

    expect(new AgyAdapter().normalizeEvents({
      stdout,
      stderr: "",
      exit: exit({ stdout }),
    })).toEqual({
      events: [{ kind: "error", text: "model not found", raw: parsed }],
      producerSummary: null,
      ok: false,
    });
  });

  it("reports failure from stderr on a non-zero exit", () => {
    expect(new AgyAdapter().normalizeEvents({
      stdout: "",
      stderr: "authentication required",
      exit: exit({ exitCode: 1, stdout: "" }),
    })).toEqual({
      events: [{ kind: "error", text: "authentication required" }],
      producerSummary: null,
      ok: false,
    });
  });

  it("reports failure when stdout is truncated", () => {
    expect(new AgyAdapter().normalizeEvents({
      stdout: "{\"status\":",
      stderr: "",
      exit: exit({ stdout: "{\"status\":", truncated: { stdout: true, stderr: false } }),
    })).toEqual({ events: [], producerSummary: null, ok: false });
  });

  it("reports failure when stdout is not valid JSON", () => {
    expect(new AgyAdapter().normalizeEvents({
      stdout: "not json",
      stderr: "",
      exit: exit({ stdout: "not json" }),
    })).toEqual({ events: [], producerSummary: null, ok: false });
  });

  it("reports failure when a SUCCESS envelope is missing a response field", () => {
    const stdout = JSON.stringify({ status: "SUCCESS" });

    expect(new AgyAdapter().normalizeEvents({
      stdout,
      stderr: "",
      exit: exit({ stdout }),
    })).toEqual({ events: [], producerSummary: null, ok: false });
  });

  it.skipIf(
    process.platform !== "darwin"
      || process.arch !== "arm64"
      || process.env.RUN_AGY_SMOKE !== "1",
  )(
    "runs a real agy invocation through macOS Seatbelt, scoped to the worktree",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "claude-architect-agy-smoke-"));
      const worktreePath = join(root, "worktree");
      const smokePath = join(worktreePath, "smoke.txt");
      let builtEnvironment: ReturnType<typeof buildEnvironment> | undefined;

      try {
        await mkdir(worktreePath);
        await execFileAsync("git", ["init", "-q"], { cwd: worktreePath });
        const ps = new PosixPlatformServices();
        const adapter = new AgyAdapter();
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
        console.info(`agy smoke probe version: ${report.version}`);

        const spec = sampleSpec();
        spec.objective = "Create a file named smoke.txt containing ok.";
        spec.context = "This is an opt-in macOS arm64 adapter smoke test.";
        spec.writeAllowlist = ["smoke.txt"];
        spec.forbiddenScope = [];
        spec.successCriteria = ["smoke.txt exists and contains ok."];
        spec.timeoutMs = 300_000;
        const launchResult = await producerRuntime.launch({
          producerId: "agy",
          spec,
          worktreePath,
          intent: "edit",
          ps,
          runId: "run-agy-smoke",
          capabilityReport: report,
        });
        builtEnvironment = launchResult.builtEnvironment;
        const supervisedExit = launchResult.exit;
        const normalized = { ok: launchResult.ok };

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
