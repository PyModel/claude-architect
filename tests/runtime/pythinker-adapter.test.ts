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
import { supervise } from "../../src/platform/process-supervisor.js";
import { wrapInvocationWithSeatbelt } from "../../src/platform/sandbox/seatbelt.js";
import type { DelegationSpec } from "../../src/protocol/delegation-spec.js";
import {
  normalizePlainText,
  renderProducerPrompt,
} from "../../src/producers/plain-text.js";
import type {
  CapabilityReport,
  InvocationContext,
  ProbeContext,
} from "../../src/producers/producer-adapter.js";
import { PythinkerAdapter } from "../../src/producers/pythinker-adapter.js";
import { renderSkillBootstrap } from "../../src/producers/skill-bootstrap.js";
import { buildEnvironment } from "../../src/runtime/environment-policy.js";

const execFileAsync = promisify(execFile);
const executable: ResolvedExecutable = {
  kind: "native",
  command: "/usr/local/bin/pythinker",
  prefixArgs: [],
  resolvedFrom: "test",
};

const supportedHelp = [
  "Usage: pythinker [options]",
  "",
  "Options:",
  "  -p, --prompt <prompt>  provide a prompt",
  "  -m, --model <model>    select a model",
  "  -h, --help             display help",
  "",
].join("\n");

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
    async assertDirectoryWriteIntegrity() {},
  };
}

function versionPlatformServices(
  resolvedExecutable: ResolvedExecutable,
  spawned: ResolvedExecutable[] = [],
  stdout = "pythinker 0.80.7\n",
  helpResult: SupervisedExit = exit({ stdout: supportedHelp }),
  spawnedArgs: string[][] = [],
): PlatformServices {
  return {
    os: "darwin",
    async resolveExecutable() {
      return resolvedExecutable;
    },
    async spawnSupervised(request) {
      spawned.push(request.executable);
      spawnedArgs.push([...request.args]);
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
    async assertDirectoryWriteIntegrity() {},
  };
}

function capabilityReport(): CapabilityReport {
  return {
    producerId: "pythinker",
    available: true,
    reason: null,
    os: "darwin",
    arch: "arm64",
    environmentType: "native",
    resolvedExecutable: executable,
    version: "0.80.7",
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
    producerPreferences: ["pythinker"],
    expectedOutput: "candidate-patch",
  };
}

function invocationContext(worktreePath = "/tmp/attempt-worktree"): InvocationContext {
  return {
    worktreePath,
    runId: "run-pythinker",
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

function baseArgs(spec: DelegationSpec): string[] {
  return [
    "--prompt",
    renderProducerPrompt(spec),
  ];
}

describe("PythinkerAdapter", () => {
  it("reports a missing executable without spawning or guessing auth state", async () => {
    await expect(new PythinkerAdapter().probe(probeContext(
      unavailablePlatformServices(),
    ))).resolves.toMatchObject({
      producerId: "pythinker",
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
    await expect(new PythinkerAdapter().probe({
      ...probeContext(unavailablePlatformServices()),
      os: "win32",
    })).resolves.toMatchObject({
      available: false,
      reason: "unsupported-platform",
      resolvedExecutable: null,
    });
  });

  it("parses the Pythinker version and honestly gates edit eligibility", async () => {
    const report = await new PythinkerAdapter({
      env: {},
      homeDirectory: "/hosthome",
      hasAuthStore: () => false,
    }).probe(probeContext(versionPlatformServices(executable)));

    expect(report).toMatchObject({
      producerId: "pythinker",
      available: true,
      reason: null,
      version: "0.80.7",
      structuredOutput: false,
      writeConfinementBackend: "macos-seatbelt",
      laneEligibility: { edit: true },
    });
    expect(report.laneEligibility.edit).toBe(report.writeConfinementBackend !== null);
  });

  it("falls back to a semver substring in noisy version output", async () => {
    await expect(new PythinkerAdapter({
      env: {},
      homeDirectory: "/hosthome",
      hasAuthStore: () => false,
    }).probe(probeContext(
      versionPlatformServices(executable, [], "Pythinker CLI(version=1.2.3) ready\n"),
    ))).resolves.toMatchObject({
      available: true,
      version: "1.2.3",
    });
  });

  it.each(["--prompt", "--model"])(
    "fails closed when help lacks the required %s option",
    async missingOption => {
      const help = supportedHelp
        .split("\n")
        .filter(line => !line.includes(missingOption))
        .concat(`Pythinker documentation mentions ${missingOption} in prose.`)
        .join("\n");

      await expect(new PythinkerAdapter({
        env: {},
        homeDirectory: "/hosthome",
        hasAuthStore: () => false,
      }).probe(probeContext(versionPlatformServices(
        executable,
        [],
        "pythinker 0.5.1\n",
        exit({ stdout: help }),
      )))).resolves.toMatchObject({
        available: false,
        reason: "unsupported-cli-surface",
        resolvedExecutable: executable,
        version: null,
        laneEligibility: { edit: false },
      });
    },
  );

  it("keeps the lane available when help exposes every emitted option", async () => {
    const spawnedArgs: string[][] = [];

    await expect(new PythinkerAdapter({
      env: {},
      homeDirectory: "/hosthome",
      hasAuthStore: () => false,
    }).probe(probeContext(versionPlatformServices(
      executable,
      [],
      "pythinker 0.5.1\n",
      exit({ stdout: supportedHelp }),
      spawnedArgs,
    )))).resolves.toMatchObject({
      available: true,
      reason: null,
      version: "0.5.1",
      laneEligibility: { edit: true },
    });
    expect(spawnedArgs).toEqual([["--version"], ["--help"]]);
  });

  it("reports probe-failed when version output cannot be parsed", async () => {
    await expect(new PythinkerAdapter().probe(probeContext(
      versionPlatformServices(executable, [], "pythinker development\n"),
    ))).resolves.toMatchObject({
      available: false,
      reason: "probe-failed",
      resolvedExecutable: executable,
      version: null,
    });
  });

  it("reports authenticated when credentials exist in the default Pythinker Code home", async () => {
    const root = await mkdtemp(join(tmpdir(), "claude-architect-pythinker-auth-"));
    const credentials = join(root, ".pythinker", "credentials");
    await mkdir(credentials, { recursive: true });
    await writeFile(
      join(credentials, "pythinker-code.json"),
      "fixture contents must not be read",
    );

    try {
      const report = await new PythinkerAdapter({
        env: {},
        homeDirectory: root,
      }).probe(probeContext(versionPlatformServices(executable)));

      expect(report.authState).toBe("authenticated");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reports unauthenticated when credentials are absent from the default Pythinker Code home", async () => {
    const root = await mkdtemp(join(tmpdir(), "claude-architect-pythinker-auth-"));

    try {
      const report = await new PythinkerAdapter({
        env: {},
        homeDirectory: root,
      }).probe(probeContext(versionPlatformServices(executable)));

      expect(report.authState).toBe("unauthenticated");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("uses PYTHINKER_SHARE_DIR for the authentication store", async () => {
    const root = await mkdtemp(join(tmpdir(), "claude-architect-pythinker-auth-"));
    const pythinkerHome = join(root, "custom-pythinker-home");
    const credentials = join(pythinkerHome, "credentials");
    await mkdir(credentials, { recursive: true });
    await writeFile(
      join(credentials, "pythinker-code.json"),
      "fixture contents must not be read",
    );

    try {
      const report = await new PythinkerAdapter({
        env: { PYTHINKER_SHARE_DIR: pythinkerHome },
        homeDirectory: root,
      }).probe(probeContext(versionPlatformServices(executable)));

      expect(report.authState).toBe("authenticated");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("invokes a Node Pythinker entrypoint with the runtime Node executable", async () => {
    const root = await mkdtemp(join(tmpdir(), "claude-architect-pythinker-entrypoint-"));
    const entrypoint = join(root, "pythinker");
    await writeFile(entrypoint, "#!/usr/bin/env node\nconsole.log('pythinker');\n");
    const spawned: ResolvedExecutable[] = [];
    const ps = versionPlatformServices({
      kind: "native",
      command: entrypoint,
      prefixArgs: [],
      resolvedFrom: `path:${entrypoint}`,
    }, spawned);

    try {
      const report = await new PythinkerAdapter().probe(probeContext(ps));

      expect(spawned).toEqual([{
        kind: "node-entrypoint",
        command: process.execPath,
        prefixArgs: [entrypoint],
        resolvedFrom: `path:${entrypoint};node:${process.execPath}`,
      }, {
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

  it("builds the exact argv-only invocation with no overrides", () => {
    const spec = sampleSpec();
    const invocation = new PythinkerAdapter({
      env: {},
      homeDirectory: "/hosthome",
      hasAuthStore: () => false,
    }).buildInvocation(spec, invocationContext());

    expect(invocation.executable).toBe(executable);
    expect(invocation.args).toEqual(baseArgs(spec));
    expect(invocation.stdin).toBeUndefined();
    expect(invocation.requiredEnv).toEqual(["PYTHINKER_SHARE_DIR", "PYTHINKER_CLI_NO_AUTO_UPDATE"]);
    expect(invocation.network).toBe("allowed");
  });

  it("passes the complete rendered prompt as one argv element", () => {
    const spec = sampleSpec();
    const args = new PythinkerAdapter({
      env: {},
      homeDirectory: "/hosthome",
      hasAuthStore: () => false,
    }).buildInvocation(spec, invocationContext()).args;
    const prompt = renderProducerPrompt(spec);
    const promptArg = args[args.indexOf("--prompt") + 1];

    expect(promptArg).toBe(renderProducerPrompt(spec));
    expect(promptArg?.length).toBe(prompt.length);
    expect(promptArg).toContain(renderSkillBootstrap());
  });

  it("omits the delegated skill bootstrap from read-only prompts", () => {
    const invocation = new PythinkerAdapter({
      env: {},
      homeDirectory: "/hosthome",
      hasAuthStore: () => false,
    }).buildInvocation(sampleSpec(), { ...invocationContext(), readOnly: true });
    const promptArg = invocation.args[invocation.args.indexOf("--prompt") + 1];

    expect(promptArg).not.toContain("## Delegated procedure skills");
  });

  it("appends a model override to the invocation argv", () => {
    const spec = sampleSpec();
    spec.producerOverrides = { model: "provider/model" };

    expect(new PythinkerAdapter({
      env: {},
      homeDirectory: "/hosthome",
      hasAuthStore: () => false,
    }).buildInvocation(spec, invocationContext()).args).toEqual([
      ...baseArgs(spec),
      "--model",
      "provider/model",
    ]);
  });

  it("rejects an unsupported reasoningEffort override with a version-agnostic message", () => {
    const spec = sampleSpec();
    spec.producerOverrides = { reasoningEffort: "high" };

    expect(() => new PythinkerAdapter({
      env: {},
      homeDirectory: "/hosthome",
      hasAuthStore: () => false,
    }).buildInvocation(spec, invocationContext())).toThrowError(
      "Pythinker reasoningEffort override is unsupported by the installed pythinker-code CLI.",
    );
  });

  it("defaults HOME to the host home when the Pythinker config directory exists", async () => {
    const root = await mkdtemp(join(tmpdir(), "claude-architect-pythinker-config-"));
    await mkdir(join(root, ".pythinker"));

    try {
      const invocation = new PythinkerAdapter({
        env: {},
        homeDirectory: root,
      }).buildInvocation(sampleSpec(), invocationContext());

      expect(invocation.env).toEqual({ HOME: root, PYTHINKER_CLI_NO_AUTO_UPDATE: "1" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not default HOME when the host already set it", async () => {
    const root = await mkdtemp(join(tmpdir(), "claude-architect-pythinker-config-"));
    await mkdir(join(root, ".pythinker"));

    try {
      const invocation = new PythinkerAdapter({
        env: { HOME: "/already-set" },
        homeDirectory: root,
      }).buildInvocation(sampleSpec(), invocationContext());

      expect(invocation.env).toEqual({ PYTHINKER_CLI_NO_AUTO_UPDATE: "1" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not default HOME when the Pythinker config directory is absent", async () => {
    const root = await mkdtemp(join(tmpdir(), "claude-architect-pythinker-config-"));

    try {
      const invocation = new PythinkerAdapter({
        env: {},
        homeDirectory: root,
      }).buildInvocation(sampleSpec(), invocationContext());

      expect(invocation.env).toEqual({ PYTHINKER_CLI_NO_AUTO_UPDATE: "1" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not override PYTHINKER_CLI_NO_AUTO_UPDATE when the host already set it", async () => {
    const root = await mkdtemp(join(tmpdir(), "claude-architect-pythinker-config-"));

    try {
      const invocation = new PythinkerAdapter({
        env: { PYTHINKER_CLI_NO_AUTO_UPDATE: "0" },
        homeDirectory: root,
      }).buildInvocation(sampleSpec(), invocationContext());

      expect(invocation.env).toEqual({});
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("declares PYTHINKER_SHARE_DIR, else ~/.pythinker, as inherited writable state", () => {
    const withOverride = new PythinkerAdapter({
      env: { PYTHINKER_SHARE_DIR: "/Users/test/custom-pythinker-home" },
      homeDirectory: "/Users/test",
    });
    expect(withOverride.buildInvocation(sampleSpec(), invocationContext()).inheritedStateWritablePaths)
      .toEqual(["/Users/test/custom-pythinker-home"]);
    const withDefault = new PythinkerAdapter({ env: {}, homeDirectory: "/Users/test" });
    expect(withDefault.buildInvocation(sampleSpec(), invocationContext()).inheritedStateWritablePaths)
      .toEqual([join("/Users/test", ".pythinker")]);
  });

  it("declares the Pythinker configuration isolation profile", () => {
    expect(new PythinkerAdapter().configurationProfile()).toEqual({
      isolationState: "inherited-config-only",
      credentialSources: ["~/.pythinker/credentials/pythinker-code.json"],
      behavioralConfigSources: [
        "~/.pythinker/config.toml",
        "~/.pythinker/tui.toml",
      ],
      repositoryInstructionSources: ["worktree AGENTS.md"],
      environmentDependencies: ["PYTHINKER_SHARE_DIR", "PYTHINKER_CLI_NO_AUTO_UPDATE"],
      temporaryHomeStrategy: "real HOME inherited by declared policy; reduced reproducibility recorded in the Run Manifest",
    });
  });

  it("normalizes successful plain text", () => {
    expect(new PythinkerAdapter().normalizeEvents({
      stdout: "hello world\n",
      stderr: "",
      exit: exit({ stdout: "hello world\n" }),
    })).toEqual({
      events: [{ kind: "final", text: "hello world" }],
      producerSummary: "hello world",
      ok: true,
    });
  });

  it.skipIf(
    process.platform !== "darwin"
      || process.arch !== "arm64"
      || process.env.RUN_PYTHINKER_SMOKE !== "1",
  )(
    "runs a real Pythinker invocation through macOS Seatbelt",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "claude-architect-pythinker-smoke-"));
      const worktreePath = join(root, "worktree");
      const smokePath = join(worktreePath, "smoke.txt");
      let builtEnvironment: ReturnType<typeof buildEnvironment> | undefined;

      try {
        await mkdir(worktreePath);
        await execFileAsync("git", ["init", "-q"], { cwd: worktreePath });
        const ps = new PosixPlatformServices();
        const adapter = new PythinkerAdapter();
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
        console.info(`Pythinker smoke probe version: ${report.version}`);

        const spec = sampleSpec();
        spec.objective = "Create a file named smoke.txt containing ok.";
        spec.context = "This is an opt-in macOS arm64 adapter smoke test.";
        spec.writeAllowlist = ["smoke.txt"];
        spec.forbiddenScope = [];
        spec.successCriteria = ["smoke.txt exists and contains ok."];
        spec.timeoutMs = 300_000;
        const invocation = wrapInvocationWithSeatbelt(adapter.buildInvocation(spec, {
          worktreePath,
          runId: "run-pythinker-smoke",
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
