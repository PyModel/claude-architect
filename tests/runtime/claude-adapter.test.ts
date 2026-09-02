import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
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
import { ClaudeAdapter } from "../../src/producers/claude-adapter.js";
import { renderProducerPrompt, selectOsWriteConfinementBackend } from "../../src/producers/plain-text.js";
import { renderSkillBootstrap } from "../../src/producers/skill-bootstrap.js";
import type {
  CapabilityReport,
  InvocationContext,
  ProbeContext,
} from "../../src/producers/producer-adapter.js";
import { buildEnvironment } from "../../src/runtime/environment-policy.js";

const execFileAsync = promisify(execFile);
const executable: ResolvedExecutable = {
  kind: "native",
  command: "/usr/local/bin/claude",
  prefixArgs: [],
  resolvedFrom: "test",
};

const supportedHelp = `
Usage: claude [options] [prompt]

Options:
  --no-session-persistence       Do not save session history
  --strict-mcp-config            Strict MCP configuration
  --setting-sources <sources>    Comma-separated list of setting sources
`;

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
  stdout = "2.1.250 (Claude Code)\n",
  helpResult: SupervisedExit = exit({ stdout: supportedHelp }),
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
        done: Promise.resolve(
          request.args.includes("--help") ? helpResult : exit({ stdout }),
        ),
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
    producerId: "claude",
    available: true,
    reason: null,
    os: "darwin",
    arch: "arm64",
    environmentType: "native",
    resolvedExecutable: executable,
    version: "2.1.250",
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
    producerPreferences: ["claude"],
    expectedOutput: "candidate-patch",
  };
}

function invocationContext(worktreePath = "/tmp/attempt-worktree"): InvocationContext {
  return {
    worktreePath,
    runId: "run-claude",
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

const ISOLATION_ARGS = [
  "-p",
  "--output-format",
  "json",
  "--no-session-persistence",
  "--strict-mcp-config",
  "--setting-sources",
  "",
  "--disable-slash-commands",
  "--dangerously-skip-permissions",
];

function envelope(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    result: "done",
    num_turns: 3,
    session_id: "s",
    ...overrides,
  });
}

function testAdapter(overrides: Partial<ConstructorParameters<typeof ClaudeAdapter>[0]> = {}): ClaudeAdapter {
  return new ClaudeAdapter({
    env: {},
    homeDirectory: "/Users/test",
    hasOauthAccount: () => false,
    ...overrides,
  });
}

describe("ClaudeAdapter", () => {
  it("reports a missing executable without spawning or guessing auth state", async () => {
    const report = await testAdapter().probe(probeContext(unavailablePlatformServices()));

    expect(report).toMatchObject({
      producerId: "claude",
      available: false,
      reason: "missing-executable",
      resolvedExecutable: null,
      version: null,
      authState: "unknown",
      structuredOutput: true,
      writeConfinementBackend: null,
      laneEligibility: { edit: false },
    });
  });

  it("reports win32 as unsupported without resolving an executable", async () => {
    const report = await testAdapter().probe({
      ...probeContext(unavailablePlatformServices()),
      os: "win32",
    });

    expect(report.available).toBe(false);
    expect(report.reason).toBe("unsupported-platform");
    expect(report.resolvedExecutable).toBeNull();
  });

  it("parses the Claude Code version banner and honestly gates edit eligibility", async () => {
    const ctx = probeContext(versionPlatformServices(executable));
    const report = await testAdapter().probe(ctx);

    expect(report.available).toBe(true);
    expect(report.version).toBe("2.1.250");
    expect(report.structuredOutput).toBe(true);
    expect(report.writeConfinementBackend).toBe(selectOsWriteConfinementBackend(ctx));
    expect(report.laneEligibility).toEqual({ edit: report.writeConfinementBackend !== null });
  });

  it("reports unsupported-cli-surface when --help lacks a required flag", async () => {
    const fakeHelp = `
Usage: claude [options]
Options:
  --no-session-persistence
  --setting-sources <sources>
`; // Missing --strict-mcp-config
    const ps = versionPlatformServices(
      executable,
      [],
      "2.1.250 (Claude Code)\n",
      exit({ stdout: fakeHelp }),
    );
    const report = await testAdapter().probe(probeContext(ps));

    expect(report.available).toBe(false);
    expect(report.reason).toBe("unsupported-cli-surface");
    expect(report.resolvedExecutable).toEqual(executable);
  });

  it("reports probe-failed when version output cannot be parsed", async () => {
    const report = await testAdapter().probe(
      probeContext(versionPlatformServices(executable, [], "Claude Code\n")),
    );

    expect(report.available).toBe(false);
    expect(report.reason).toBe("probe-failed");
    expect(report.resolvedExecutable).toEqual(executable);
  });

  it("reports authenticated when ~/.claude.json records an OAuth account", async () => {
    const checked: string[] = [];
    const adapter = testAdapter({
      hasOauthAccount: file => {
        checked.push(file);
        return true;
      },
    });
    const report = await adapter.probe(probeContext(versionPlatformServices(executable)));

    expect(report.authState).toBe("authenticated");
    expect(checked).toEqual([join("/Users/test", ".claude.json")]);
  });

  it("reads the account record from CLAUDE_CONFIG_DIR when the host relocated it", async () => {
    const checked: string[] = [];
    const adapter = testAdapter({
      env: { CLAUDE_CONFIG_DIR: "/Users/test/relocated" },
      hasOauthAccount: file => {
        checked.push(file);
        return false;
      },
    });
    const report = await adapter.probe(probeContext(versionPlatformServices(executable)));

    expect(report.authState).toBe("unauthenticated");
    expect(checked).toEqual([join("/Users/test/relocated", ".claude.json")]);
  });

  it("reports authenticated from ANTHROPIC_API_KEY without reading the account file", async () => {
    const adapter = testAdapter({
      env: { ANTHROPIC_API_KEY: "sk-test" },
      hasOauthAccount: () => {
        throw new Error("must not read the account file");
      },
    });
    const report = await adapter.probe(probeContext(versionPlatformServices(executable)));

    expect(report.authState).toBe("authenticated");
  });

  it("builds an isolated headless invocation and sends the prompt on stdin", () => {
    const spec = sampleSpec();
    const invocation = testAdapter().buildInvocation(spec, invocationContext());

    expect(invocation.args).toEqual([...ISOLATION_ARGS, "--tools", "Read,Edit,Write,Bash,Grep,Glob"]);
    expect(invocation.stdin).toBe(renderProducerPrompt(spec));
    expect(invocation.requiredEnv).toEqual(["USER", "CLAUDE_CONFIG_DIR", "ANTHROPIC_API_KEY"]);
    expect(invocation.network).toBe("allowed");
    expect(invocation.env).toBeUndefined();
  });

  it("never exposes Agent, MCP, or web tools to the Producer", () => {
    const invocation = testAdapter().buildInvocation(sampleSpec(), invocationContext());
    const tools = invocation.args[invocation.args.indexOf("--tools") + 1] ?? "";

    expect(tools.split(",")).not.toContain("Agent");
    expect(tools.split(",")).not.toContain("WebFetch");
    expect(invocation.args).toContain("--strict-mcp-config");
    expect(invocation.args).not.toContain("--mcp-config");
    expect(invocation.args).not.toContain("--continue");
    expect(invocation.args).not.toContain("--resume");
  });

  it("restricts read-only roles to non-mutating built-in tools", () => {
    const invocation = testAdapter().buildInvocation(sampleSpec(), {
      ...invocationContext(),
      readOnly: true,
    });

    expect(invocation.args).toEqual([...ISOLATION_ARGS, "--tools", "Read,Grep,Glob"]);
    expect(invocation.stdin).toBe(renderProducerPrompt(sampleSpec(), true));
  });

  it("omits the delegated skill bootstrap from read-only prompts", () => {
    const invocation = testAdapter().buildInvocation(sampleSpec(), {
      ...invocationContext(),
      readOnly: true,
    });

    expect(invocation.stdin).not.toContain(renderSkillBootstrap());
  });

  it("includes the delegated skill bootstrap in edit prompts", () => {
    const invocation = testAdapter().buildInvocation(sampleSpec(), invocationContext());

    expect(invocation.stdin).toContain(renderSkillBootstrap());
  });

  it("appends a model override so the lane can run Opus or Sonnet", () => {
    const spec = { ...sampleSpec(), producerOverrides: { model: "opus" } };
    const invocation = testAdapter().buildInvocation(spec, invocationContext());

    expect(invocation.args.slice(-2)).toEqual(["--model", "opus"]);
    expect(invocation.args).not.toContain("--effort");
  });

  it("appends model then effort overrides to the invocation argv", () => {
    const spec = {
      ...sampleSpec(),
      producerOverrides: { model: "sonnet", reasoningEffort: "high" },
    };
    const invocation = testAdapter().buildInvocation(spec, invocationContext());

    expect(invocation.args.slice(-4)).toEqual(["--model", "sonnet", "--effort", "high"]);
  });

  it("rejects an effort level the CLI does not accept before spawning", () => {
    const spec = { ...sampleSpec(), producerOverrides: { reasoningEffort: "ultra" } };

    expect(() => testAdapter().buildInvocation(spec, invocationContext()))
      .toThrow(/effort override "ultra" is unsupported/u);
  });

  it("declares ~/.claude and ~/.claude.json as inherited writable state, following HOME", () => {
    const invocation = testAdapter({ env: { HOME: "/Users/real" } })
      .buildInvocation(sampleSpec(), invocationContext());

    expect(invocation.inheritedStateWritablePaths).toEqual([
      join("/Users/real", ".claude"),
      join("/Users/real", ".claude.json"),
    ]);
  });

  it("declares the relocated CLAUDE_CONFIG_DIR instead of ~/.claude when set", () => {
    const invocation = testAdapter({ env: { CLAUDE_CONFIG_DIR: "/Users/test/relocated" } })
      .buildInvocation(sampleSpec(), invocationContext());

    expect(invocation.inheritedStateWritablePaths).toEqual([
      "/Users/test/relocated",
      join("/Users/test/relocated", ".claude.json"),
    ]);
  });

  it("wraps a Claude edit invocation with provider network and write confinement", () => {
    const invocation = testAdapter().buildInvocation(sampleSpec(), invocationContext());
    const wrapped = wrapInvocationWithSeatbelt(invocation, {
      worktreePath: "/tmp/attempt-worktree",
      tempHome: null,
      allowNetwork: true,
    });
    const profile = wrapped.args[1] ?? "";
    const configDir = join("/Users/test", ".claude");
    const accountFile = join("/Users/test", ".claude.json");

    expect(wrapped.executable.command).toBe("/usr/bin/sandbox-exec");
    expect(profile).toContain('(allow file-write* (subpath "/tmp/attempt-worktree"))');
    expect(profile).toContain(`(subpath "${configDir.replace(/\\/gu, "\\\\")}")`);
    expect(profile).toContain(`(subpath "${accountFile.replace(/\\/gu, "\\\\")}")`);
    expect(profile).not.toContain('(subpath "/Users/test")');
    expect(profile).not.toContain("(deny network*)");
    expect(wrapped.args.slice(2)).toEqual([executable.command, ...invocation.args]);
  });

  it("declares the Claude Code configuration isolation profile", () => {
    const profile = testAdapter().configurationProfile();

    expect(profile.isolationState).toBe("inherited-config-only");
    expect(profile.environmentDependencies).toEqual(["USER", "CLAUDE_CONFIG_DIR", "ANTHROPIC_API_KEY"]);
    expect(profile.repositoryInstructionSources).toEqual([]);
    expect(profile.temporaryHomeStrategy).toMatch(/real HOME inherited/u);
  });

  it("normalizes a successful result envelope", () => {
    const stdout = envelope({ result: "Updated the greeting." });
    const normalized = testAdapter().normalizeEvents({ stdout, stderr: "", exit: exit({ stdout }) });

    expect(normalized.ok).toBe(true);
    expect(normalized.producerSummary).toBe("Updated the greeting.");
    expect(normalized.events).toEqual([
      { kind: "final", text: "Updated the greeting.", raw: JSON.parse(stdout) },
    ]);
  });

  it("tolerates a warning line printed before the envelope", () => {
    const stdout = `Warning: Advisor disabled\n${envelope()}`;
    const normalized = testAdapter().normalizeEvents({ stdout, stderr: "", exit: exit({ stdout }) });

    expect(normalized.ok).toBe(true);
    expect(normalized.producerSummary).toBe("done");
  });

  it("reports failure for an is_error envelope even on exit code 0 and surfaces its text", () => {
    // Observed live: `claude -p` exits 0 for some API-level failures and
    // reports them only inside the envelope.
    const stdout = envelope({ is_error: true, result: "Not logged in · Please run /login" });
    const normalized = testAdapter().normalizeEvents({ stdout, stderr: "", exit: exit({ stdout }) });

    expect(normalized.ok).toBe(false);
    expect(normalized.producerSummary).toBeNull();
    expect(normalized.events).toEqual([
      { kind: "error", text: "Not logged in · Please run /login", raw: JSON.parse(stdout) },
    ]);
  });

  it("reports failure for a non-success subtype", () => {
    const stdout = envelope({ subtype: "error_max_turns" });
    const normalized = testAdapter().normalizeEvents({ stdout, stderr: "", exit: exit({ stdout }) });

    expect(normalized.ok).toBe(false);
  });

  it("reports failure for a non-zero exit even when the envelope claims success", () => {
    const stdout = envelope();
    const normalized = testAdapter().normalizeEvents({
      stdout,
      stderr: "",
      exit: exit({ stdout, exitCode: 1 }),
    });

    expect(normalized.ok).toBe(false);
    expect(normalized.producerSummary).toBeNull();
  });

  it("reports failure from stderr when no envelope is present", () => {
    const normalized = testAdapter().normalizeEvents({
      stdout: "",
      stderr: "error: unknown option",
      exit: exit({ exitCode: 1 }),
    });

    expect(normalized).toEqual({
      events: [{ kind: "error", text: "error: unknown option" }],
      producerSummary: null,
      ok: false,
    });
  });

  it("reports failure when stdout is truncated", () => {
    const normalized = testAdapter().normalizeEvents({
      stdout: "{\"type\":\"result\"",
      stderr: "",
      exit: exit({ truncated: { stdout: true, stderr: false } }),
    });

    expect(normalized).toEqual({ events: [], producerSummary: null, ok: false });
  });

  it("ignores JSON that is not a result envelope", () => {
    const stdout = JSON.stringify({ type: "assistant", message: {} });
    const normalized = testAdapter().normalizeEvents({ stdout, stderr: "", exit: exit({ stdout }) });

    expect(normalized.ok).toBe(false);
  });

  it("reports failure when a success envelope carries no result string", () => {
    const stdout = envelope({ result: undefined });
    const normalized = testAdapter().normalizeEvents({ stdout, stderr: "", exit: exit({ stdout }) });

    expect(normalized.ok).toBe(false);
    expect(normalized.producerSummary).toBeNull();
  });
});

describe("ClaudeAdapter macOS smoke", () => {
  const enabled = process.platform === "darwin"
    && process.arch === "arm64"
    && process.env.CLAUDE_ARCHITECT_CLAUDE_SMOKE === "1";

  it.runIf(enabled)(
    "runs a real confined headless Claude Code attempt in an isolated worktree",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "claude-smoke-"));
      const worktreePath = join(root, "worktree");
      const smokePath = join(worktreePath, "smoke.txt");
      let builtEnvironment: ReturnType<typeof buildEnvironment> | undefined;

      try {
        await mkdir(worktreePath);
        await execFileAsync("git", ["init", "-q"], { cwd: worktreePath });
        const ps = new PosixPlatformServices();
        const adapter = new ClaudeAdapter();
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
        console.info(`claude smoke probe version: ${report.version}`);

        const spec = sampleSpec();
        spec.objective = "Create a file named smoke.txt containing ok.";
        spec.context = "This is an opt-in macOS arm64 adapter smoke test.";
        spec.writeAllowlist = ["smoke.txt"];
        spec.forbiddenScope = [];
        spec.successCriteria = ["smoke.txt exists and contains ok."];
        spec.timeoutMs = 300_000;
        spec.producerOverrides = { model: "haiku" };
        const invocation = wrapInvocationWithSeatbelt(adapter.buildInvocation(spec, {
          worktreePath,
          runId: "run-claude-smoke",
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
        const normalized = adapter.normalizeEvents({
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
