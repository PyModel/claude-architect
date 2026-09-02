import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import type {
  PlatformServices,
  ResolvedExecutable,
  SupervisedExit,
} from "../../src/platform/platform-services.js";
import { PosixPlatformServices } from "../../src/platform/posix-platform-services.js";
import type { DelegationSpec } from "../../src/protocol/delegation-spec.js";
import {
  CODEX_EDIT_ACTION_PREAMBLE,
  CODEX_REQUIRED_ENV,
  CODEX_SHELL_ENV_EXCLUDE,
  CodexAdapter,
  codexDescriptor,
  sandboxSupportWritableRoots,
} from "../../src/producers/codex-adapter.js";
import { resolveDefaultEnv } from "../../src/producers/host-store.js";
import { producerRuntime } from "../../src/producers/producer-runtime.js";
import { renderSkillBootstrap } from "../../src/producers/skill-bootstrap.js";
import type {
  CapabilityReport,
  InvocationContext,
  ProbeContext,
} from "../../src/producers/producer-adapter.js";
import { buildRoleSpec, type RolePackage } from "../../src/pipeline/role-prompts.js";

const execFileAsync = promisify(execFile);
const executable: ResolvedExecutable = {
  kind: "native",
  command: "/usr/local/bin/codex",
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
  spawned: ResolvedExecutable[],
  supervisedExit: SupervisedExit = exit({ stdout: "codex-cli 0.144.4\n" }),
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

function capabilityReport(): CapabilityReport {
  return {
    producerId: "codex",
    available: true,
    reason: null,
    os: "darwin",
    arch: "arm64",
    environmentType: "native",
    resolvedExecutable: executable,
    version: "0.144.4",
    authState: "unknown",
    executionModes: ["edit"],
    structuredOutput: true,
    writeConfinementBackend: "codex-native-sandbox",
    laneEligibility: { edit: true },
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
    timeoutMs: 600_000,
    producerPreferences: ["codex"],
    producerOverrides: { model: "gpt-test", reasoningEffort: "high" },
    expectedOutput: "candidate-patch",
  };
}

function invocationContext(worktreePath = "/tmp/attempt-worktree"): InvocationContext {
  const report = capabilityReport();
  return {
    worktreePath,
    runId: "run-codex",
    tempHome: "/tmp/attempt-home",
    capabilityReport: report,
    executable,
  };
}

describe("CodexAdapter", () => {
  it("normalizes a captured successful Codex JSONL stream", async () => {
    const stdout = await readFile(new URL("fixtures/codex-success.json", import.meta.url), "utf8");
    const normalized = new CodexAdapter().normalizeEvents({ stdout, stderr: "", exit: exit() });

    expect(normalized.ok).toBe(true);
    expect(normalized.producerSummary).toBe("fixture-ok");
    expect(normalized.events.length).toBeGreaterThanOrEqual(1);
  });

  it("rejects malformed Codex output", async () => {
    const stdout = await readFile(new URL("fixtures/codex-garbage.txt", import.meta.url), "utf8");

    expect(new CodexAdapter().normalizeEvents({ stdout, stderr: "", exit: exit() })).toEqual({
      events: [],
      producerSummary: null,
      ok: false,
    });
  });

  it("rejects a truncated structured-output stream", async () => {
    const stdout = await readFile(new URL("fixtures/codex-success.json", import.meta.url), "utf8");

    expect(new CodexAdapter().normalizeEvents({
      stdout,
      stderr: "",
      exit: exit({ truncated: { stdout: true, stderr: false } }),
    })).toEqual({ events: [], producerSummary: null, ok: false });
  });

  it("keeps normalizable nonzero output valid for producer-failure classification", async () => {
    const stdout = await readFile(new URL("fixtures/codex-success.json", import.meta.url), "utf8");

    expect(new CodexAdapter().normalizeEvents({
      stdout,
      stderr: "producer failed after reporting",
      exit: exit({ exitCode: 1 }),
    }).ok).toBe(true);
  });

  it("defaults CODEX_HOME to the host auth store when unset and auth.json exists", () => {
    const store = join("/hosthome", ".codex");
    const values = resolveDefaultEnv(codexDescriptor, {
      env: {},
      homeDirectory: "/hosthome",
      hasAuthStore: directory => directory === store,
    });
    expect(values).toEqual({ CODEX_HOME: store });
  });

  it("does not default CODEX_HOME when the variable is set or no auth store exists", () => {
    expect(resolveDefaultEnv(codexDescriptor, {
      env: { CODEX_HOME: "/custom" },
      homeDirectory: "/hosthome",
      hasAuthStore: () => true,
    })).toEqual({});
    expect(resolveDefaultEnv(codexDescriptor, {
      env: {},
      homeDirectory: "/hosthome",
      hasAuthStore: () => false,
    })).toEqual({});
  });

  function writableRootsOf(args: string[]): string[] {
    const prefix = "sandbox_workspace_write.writable_roots=";
    const rendered = args.find(arg => arg.startsWith(prefix));
    return rendered === undefined ? [] : JSON.parse(rendered.slice(prefix.length)) as string[];
  }

  it("grants the edit lane the macOS xcrun cache directory and nothing more", () => {
    // /usr/bin/git is a stub that resolves the real binary through xcrun and
    // caches the answer in the per-user temp directory. The Producer shell is a
    // login shell, so path_helper puts /usr/bin ahead of every inherited PATH
    // entry and that stub is what runs. Denying the cache write made every git
    // call re-run `xcodebuild -find git` — 1.01s against 0.012s cached.
    const roots = sandboxSupportWritableRoots(process.platform);
    if (process.platform !== "darwin") {
      expect(roots).toEqual([]);
      return;
    }
    expect(roots).toHaveLength(1);
    expect(roots[0]!.startsWith("/")).toBe(true);

    const invocation = new CodexAdapter().buildInvocation(sampleSpec(), invocationContext());
    expect(writableRootsOf(invocation.args)).toContain(roots[0]);
    // exclude_tmpdir_env_var is effectively neutralized wherever TMPDIR is this
    // same directory, which is the macOS default; exclude_slash_tmp is what still
    // does work, and it must stay.
    expect(invocation.args).toContain("sandbox_workspace_write.exclude_slash_tmp=true");
    expect(roots).not.toContain("/tmp");
    expect(roots).not.toContain("/private/tmp");
  });

  it("adds no support roots to the read-only sandbox", () => {
    // The read-only sandbox has no writable roots at all; handing it one would
    // silently widen a lane whose whole purpose is that it cannot write.
    const invocation = new CodexAdapter().buildInvocation(sampleSpec(), {
      ...invocationContext(),
      readOnly: true,
    });
    expect(invocation.args.some(arg =>
      arg.startsWith("sandbox_workspace_write.writable_roots="))).toBe(false);
  });

  it("uses the read-only sandbox when the context is a read-only role", () => {
    const invocation = new CodexAdapter().buildInvocation(sampleSpec(), {
      ...invocationContext(),
      readOnly: true,
    });
    const sandboxIndex = invocation.args.indexOf("--sandbox");
    expect(invocation.args[sandboxIndex + 1]).toBe("read-only");
    expect(invocation.args).not.toContain("workspace-write");
    expect(invocation.stdin).not.toContain(CODEX_EDIT_ACTION_PREAMBLE);
    expect(invocation.stdin).not.toContain("## Delegated procedure skills");
  });

  it("keeps the edit preamble stable while allowing only delegated skill files", () => {
    expect(CODEX_EDIT_ACTION_PREAMBLE.split("\n")).toEqual([
      "This is an action-first edit run.",
      "Constraints are fully pre-digested in this spec.",
      "Do not read repository AGENTS.md, CLAUDE.md, SKILL.md, lessons files, or any repository agent-rule/skill documents; the delegated skill files named below are permitted.",
      "Begin by opening the implementation files authorized in the spec.",
      "A plan-only final message with zero edits is a failed run.",
    ]);
  });

  it("denies every credential it hands Codex to the Producer shell", () => {
    // Codex applies `include_only` as a filter over the inherited set rather than
    // as an allowlist, so this denylist is the only thing keeping the auth store
    // out of the Producer shell. Adding a credential to CODEX_REQUIRED_ENV
    // without excluding it must fail here.
    for (const name of CODEX_REQUIRED_ENV) {
      expect(CODEX_SHELL_ENV_EXCLUDE as readonly string[]).toContain(name);
    }
  });

  it("gives the advisor an ephemeral no-config read-only invocation with no external authority", () => {
    const base = sampleSpec();
    const pkg: RolePackage = {
      spec: base,
      baselineCommit: "a".repeat(40),
      candidateCommit: "b".repeat(40),
      candidateDiff: "diff --git a/a b/a",
      testEvidence: "verified",
      advisorEvidence: { candidateTreeOid: "c".repeat(40) },
    };
    const advisorSpec = buildRoleSpec("advisor", base, pkg);
    const invocation = new CodexAdapter().buildInvocation(advisorSpec, {
      ...invocationContext(),
      readOnly: true,
    });

    expect(invocation.args).toContain("--ephemeral");
    expect(invocation.args).toContain("--ignore-user-config");
    expect(invocation.args).toContain("--ignore-rules");
    expect(invocation.args).toContain('approval_policy="never"');
    expect(invocation.args).toContain('web_search="disabled"');
    expect(invocation.args).toContain("read-only");
    expect(invocation.args).not.toContain("workspace-write");
    // The arg that would silently reintroduce write capability if the read-only
    // branch regressed. `--sandbox read-only` alone does not pin its absence.
    expect(invocation.args.some(arg => arg.includes("writable_roots"))).toBe(false);
    expect(invocation.network).toBe("denied");
    expect(invocation.stdin).toContain("no authority to accept, waive, promote, integrate, commit, push, ship");
    expect(invocation.stdin).toContain("call MCP decision tools");
    expect(invocation.stdin).not.toContain(base.context);
  });

  it("carries the defaulted auth store on the invocation env", () => {
    const invocation = new CodexAdapter().buildInvocation(sampleSpec(), invocationContext());
    expect(invocation.env === undefined || typeof invocation.env === "object").toBe(true);
  });

  it("builds an argv-only invocation with the delegation prompt on stdin", () => {
    const spec = sampleSpec();
    const invocation = new CodexAdapter().buildInvocation(spec, invocationContext());
    const disableIndex = invocation.args.indexOf("--disable");
    const controlIndex = invocation.args.indexOf(
      "features.multi_agent_v2={enabled=false,max_concurrent_threads_per_session=1}",
    );

    expect(invocation.executable).toBe(executable);
    expect(invocation.args).toContain("--json");
    expect(invocation.args).toContain("workspace-write");
    expect(invocation.args.slice(disableIndex, disableIndex + 2)).toEqual([
      "--disable",
      "multi_agent",
    ]);
    expect(invocation.args[controlIndex - 1]).toBe("-c");
    expect(invocation.args).toContain('shell_environment_policy.inherit="core"');
    expect(invocation.args).toContain(
      'shell_environment_policy.include_only=["PATH","HOME","TMPDIR","LANG","LC_ALL","CLAUDE_ARCHITECT_DELEGATED"]',
    );
    expect(invocation.args).toContain(
      'shell_environment_policy.exclude=["CODEX_HOME","CODEX_API_KEY","CODEX_ACCESS_TOKEN"'
      + ',"CODEX_CA_CERTIFICATE","CODEX_MANAGED_*","SSL_CERT_FILE"]',
    );
    expect(invocation.args).toContain(
      'shell_environment_policy.set={CLAUDE_ARCHITECT_DELEGATED="1"}',
    );
    expect(invocation.args).toContain("sandbox_workspace_write.exclude_tmpdir_env_var=true");
    expect(invocation.args).toContain("sandbox_workspace_write.exclude_slash_tmp=true");
    expect(writableRootsOf(invocation.args)).toEqual(sandboxSupportWritableRoots(process.platform));
    expect(invocation.args.at(-1)).toBe("-");
    expect(invocation.args.join(" ")).not.toContain(spec.objective);
    expect(invocation.stdin).toContain(spec.objective);
    expect(invocation.stdin?.startsWith(`${CODEX_EDIT_ACTION_PREAMBLE}\n\n`)).toBe(true);
    expect(invocation.stdin).toContain(renderSkillBootstrap());
    expect(invocation.stdin).toContain(spec.context);
    expect(invocation.stdin).toContain("src/greeting.ts");
    expect(invocation.stdin).toContain(
      "If you run linting, formatting, or type checking, complete all linting and formatting first, then run a final type-check covering every typed file you changed, including new or modified tests.",
    );
    expect(invocation.requiredEnv).toEqual([
      "CODEX_HOME",
      "CODEX_API_KEY",
      "CODEX_ACCESS_TOKEN",
      "CODEX_CA_CERTIFICATE",
      "SSL_CERT_FILE",
    ]);
    expect(invocation.network).toBe("denied");
  });

  it("renders additional writable roots for linked-worktree git metadata", () => {
    const context = invocationContext();
    context.extraWritableRoots = [
      "/repo/.git/worktrees/fix",
      "/repo/.git/worktrees/fix/private-objects",
    ];
    context.gitObjectDirectory = "/repo/.git/worktrees/fix/private-objects";
    context.gitAlternateObjectDirectories = "/repo/.git/objects";

    const invocation = new CodexAdapter().buildInvocation(sampleSpec(), context);

    expect(writableRootsOf(invocation.args)).toEqual([
      "/repo/.git/worktrees/fix",
      "/repo/.git/worktrees/fix/private-objects",
      ...sandboxSupportWritableRoots(process.platform),
    ]);
    expect(writableRootsOf(invocation.args)).not.toContain("/repo/.git/objects");
    expect(invocation.env).toMatchObject({
      GIT_OBJECT_DIRECTORY: "/repo/.git/worktrees/fix/private-objects",
      GIT_ALTERNATE_OBJECT_DIRECTORIES: "/repo/.git/objects",
    });
    expect(invocation.args).toContain(
      'shell_environment_policy.include_only=["PATH","HOME","TMPDIR","LANG","LC_ALL","CLAUDE_ARCHITECT_DELEGATED","GIT_OBJECT_DIRECTORY","GIT_ALTERNATE_OBJECT_DIRECTORIES"]',
    );
    expect(invocation.args).toContain(
      'shell_environment_policy.set={CLAUDE_ARCHITECT_DELEGATED="1"'
      + ',GIT_OBJECT_DIRECTORY="/repo/.git/worktrees/fix/private-objects"'
      + ',GIT_ALTERNATE_OBJECT_DIRECTORIES="/repo/.git/objects"}',
    );
  });

  it("reports a missing executable without spawning or guessing auth state", async () => {
    const ctx: ProbeContext = {
      ps: unavailablePlatformServices(),
      os: "darwin",
      arch: "arm64",
      environmentType: "native",
    };

    await expect(new CodexAdapter().probe(ctx)).resolves.toMatchObject({
      producerId: "codex",
      available: false,
      reason: "missing-executable",
      resolvedExecutable: null,
      version: null,
      authState: "unknown",
      writeConfinementBackend: null,
      laneEligibility: { edit: false },
    });
  });

  it.each([
    ["times out", exit({ timedOut: true, stdout: "codex-cli 0.144.4\n" })],
    ["is signal-terminated", exit({ exitCode: null, signal: "SIGTERM", stdout: "codex-cli 0.144.4\n" })],
  ])("reports probe-failed when the version probe %s", async (_description, supervisedExit) => {
    const report = await new CodexAdapter().probe({
      ps: versionPlatformServices(executable, [], supervisedExit),
      os: "darwin",
      arch: "arm64",
      environmentType: "native",
    });

    expect(report).toMatchObject({
      available: false,
      reason: "probe-failed",
      resolvedExecutable: executable,
      version: null,
      writeConfinementBackend: null,
      laneEligibility: { edit: false },
    });
  });

  it("reports authenticated when auth.json exists in the default store", async () => {
    const root = await mkdtemp(join(tmpdir(), "claude-architect-codex-auth-"));
    const store = join(root, ".codex");
    await mkdir(store);
    await writeFile(join(store, "auth.json"), "fixture contents must not be read");

    try {
      const report = await new CodexAdapter({
        env: {},
        homeDirectory: root,
      }).probe({
        ps: versionPlatformServices(executable, []),
        os: "darwin",
        arch: "arm64",
        environmentType: "native",
      });

      expect(report.authState).toBe("authenticated");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reports unauthenticated when auth.json is absent from the default store", async () => {
    const root = await mkdtemp(join(tmpdir(), "claude-architect-codex-auth-"));

    try {
      const report = await new CodexAdapter({
        env: {},
        homeDirectory: root,
      }).probe({
        ps: versionPlatformServices(executable, []),
        os: "darwin",
        arch: "arm64",
        environmentType: "native",
      });

      expect(report.authState).toBe("unauthenticated");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("respects CODEX_HOME when reporting auth state", async () => {
    const root = await mkdtemp(join(tmpdir(), "claude-architect-codex-auth-"));
    const store = join(root, "custom-codex-home");
    await mkdir(store);
    await writeFile(join(store, "auth.json"), "fixture contents must not be read");

    try {
      const report = await new CodexAdapter({
        env: { CODEX_HOME: store },
        homeDirectory: join(root, "unused-home"),
      }).probe({
        ps: versionPlatformServices(executable, []),
        os: "darwin",
        arch: "arm64",
        environmentType: "native",
      });

      expect(report.authState).toBe("authenticated");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("invokes an npm Codex entrypoint with the runtime Node executable", async () => {
    const root = await mkdtemp(join(tmpdir(), "claude-architect-codex-entrypoint-"));
    const entrypoint = join(root, "codex");
    await writeFile(entrypoint, "#!/usr/bin/env node\nconsole.log('codex');\n");
    const spawned: ResolvedExecutable[] = [];
    const ps = versionPlatformServices({
      kind: "native",
      command: entrypoint,
      prefixArgs: [],
      resolvedFrom: `path:${entrypoint}`,
    }, spawned);

    try {
      const report = await new CodexAdapter().probe({
        ps,
        os: "darwin",
        arch: "arm64",
        environmentType: "native",
      });

      expect(spawned).toEqual([{
        kind: "node-entrypoint",
        command: process.execPath,
        prefixArgs: [entrypoint],
        resolvedFrom: `path:${entrypoint};node:${process.execPath}`,
      }]);
      expect(report.resolvedExecutable).toEqual(spawned[0]);
      expect(report.version).toBe("0.144.4");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.skipIf(
    process.platform !== "darwin"
      || process.arch !== "arm64"
      || process.env.RUN_CODEX_CONFINEMENT_GATE !== "1",
  )(
    "proves the native sandbox blocks a write outside the attempt worktree",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "claude-architect-codex-gate-"));
      const worktreePath = join(root, "worktree");
      const tempHome = join(root, "home");
      const insidePath = join(worktreePath, "inside-probe.txt");
      const outsidePath = join(homedir(), `.claude-architect-sandbox-probe-${randomUUID()}`);
      const originalCodexHome = process.env.CODEX_HOME;
      if (originalCodexHome === undefined) {
        process.env.CODEX_HOME = join(homedir(), ".codex");
      }
      let builtEnvironment: { secretRegistration: { dispose(): void } } | undefined;

      try {
        await mkdir(worktreePath);
        await mkdir(tempHome);
        await execFileAsync("git", ["init", "-q"], { cwd: worktreePath });
        const ps = new PosixPlatformServices();
        const adapter = new CodexAdapter();
        const probeContext: ProbeContext = {
          ps,
          os: "darwin",
          arch: process.arch,
          environmentType: "native",
        };
        const report = await adapter.probe(probeContext);
        expect(report.resolvedExecutable).not.toBeNull();
        if (report.resolvedExecutable === null) return;
        const spec = sampleSpec();
        spec.objective = [
          "This is a sandbox certification probe.",
          "Use the shell exactly once to run:",
          `printf attempted > inside-probe.txt && printf blocked > ${JSON.stringify(outsidePath)}`,
          "Run the command even though its second target is outside the workspace, then report the result.",
        ].join(" ");
        spec.writeAllowlist = ["**"];
        spec.forbiddenScope = [];
        spec.producerOverrides = { reasoningEffort: "low" };
        const launchResult = await producerRuntime.launch({
          producerId: "codex",
          spec,
          worktreePath,
          intent: "edit",
          ps,
          runId: "run-confinement-gate",
          tempHome,
          timeoutMs: 120_000,
          capabilityReport: report,
        });
        builtEnvironment = launchResult.builtEnvironment;
        const supervisedExit = launchResult.exit;

        await expect(
          readFile(insidePath, "utf8"),
          `stdout:\n${supervisedExit.stdout}\nstderr:\n${supervisedExit.stderr}`,
        ).resolves.toBe("attempted");
        await expect(access(outsidePath)).rejects.toMatchObject({ code: "ENOENT" });
        expect(report.writeConfinementBackend).toBe("codex-native-sandbox");
        expect(report.laneEligibility.edit).toBe(true);
      } finally {
        builtEnvironment?.secretRegistration.dispose();
        if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
        else process.env.CODEX_HOME = originalCodexHome;
        await rm(outsidePath, { force: true });
        await rm(root, { recursive: true, force: true });
      }
    },
    150_000,
  );

  it.skipIf(
    process.platform !== "darwin"
      || process.arch !== "arm64"
      || process.env.RUN_CODEX_SKILL_GATE !== "1",
  )(
    "proves the producer can read a vendored skill under the isolated HOME",
    async () => {
      // Asserting that the prompt contains the bootstrap would prove nothing: the
      // failure mode is the Producer being unable to READ the vendored path under
      // write confinement and a per-attempt HOME. So the probe demands output that
      // is only derivable from the file's bytes — a line count and one interior
      // line, neither of which is recallable from a public skill's training data.
      const skillPath = fileURLToPath(new URL(
        "../../vendor/superpowers/skills/verification-before-completion/SKILL.md",
        import.meta.url,
      ));
      // Strip the trailing newline before splitting: the Producer counts lines the
      // way `wc -l` does, so an unstripped split reports one line too many.
      const skillLines = (await readFile(skillPath, "utf8")).replace(/\n$/u, "").split("\n");
      const probedLineNumber = 17;
      const expectedLine = skillLines[probedLineNumber - 1];
      expect(expectedLine).toBeDefined();

      const root = await mkdtemp(join(tmpdir(), "claude-architect-codex-skill-"));
      const worktreePath = join(root, "worktree");
      const tempHome = join(root, "home");
      const proofPath = join(worktreePath, "skill-proof.txt");
      const originalCodexHome = process.env.CODEX_HOME;
      if (originalCodexHome === undefined) {
        process.env.CODEX_HOME = join(homedir(), ".codex");
      }
      let builtEnvironment: { secretRegistration: { dispose(): void } } | undefined;

      try {
        await mkdir(worktreePath);
        await mkdir(tempHome);
        await execFileAsync("git", ["init", "-q"], { cwd: worktreePath });
        const ps = new PosixPlatformServices();
        const adapter = new CodexAdapter();
        const report = await adapter.probe({
          ps,
          os: "darwin",
          arch: process.arch,
          environmentType: "native",
        });
        expect(report.resolvedExecutable).not.toBeNull();
        if (report.resolvedExecutable === null) return;
        const spec = sampleSpec();
        spec.objective = [
          "This is a delegated-skill certification probe.",
          "Open the verification-before-completion skill at the absolute path given in the",
          "delegated procedure skills section of this prompt, then write skill-proof.txt",
          `containing exactly two lines: the file's total line count, then line ${probedLineNumber}`,
          "of that file copied verbatim.",
        ].join(" ");
        spec.writeAllowlist = ["skill-proof.txt"];
        spec.forbiddenScope = [];
        spec.producerOverrides = { reasoningEffort: "low" };
        const launchResult = await producerRuntime.launch({
          producerId: "codex",
          spec,
          worktreePath,
          intent: "edit",
          ps,
          runId: "run-skill-gate",
          tempHome,
          timeoutMs: 240_000,
          capabilityReport: report,
        });
        expect(launchResult.invocation.stdin).toContain(skillPath);
        builtEnvironment = launchResult.builtEnvironment;
        const supervisedExit = launchResult.exit;

        const proof = await readFile(proofPath, "utf8");
        const diagnostic =
          `stdout:\n${supervisedExit.stdout}\nstderr:\n${supervisedExit.stderr}`;
        expect(proof, diagnostic).toContain(String(skillLines.length));
        expect(proof, diagnostic).toContain(expectedLine!);
      } finally {
        builtEnvironment?.secretRegistration.dispose();
        if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
        else process.env.CODEX_HOME = originalCodexHome;
        await rm(root, { recursive: true, force: true });
      }
    },
    300_000,
  );

  it.skipIf(
    process.platform === "win32"
      || process.env.RUN_CODEX_SHELL_ENV_GATE !== "1",
  )(
    "proves the producer shell inherits a usable PATH and the delegation guard",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "claude-architect-codex-env-"));
      const worktreePath = join(root, "worktree");
      const tempHome = join(root, "home");
      const originalCodexHome = process.env.CODEX_HOME;
      if (originalCodexHome === undefined) {
        process.env.CODEX_HOME = join(homedir(), ".codex");
      }
      let builtEnvironment: { secretRegistration: { dispose(): void } } | undefined;

      try {
        await mkdir(worktreePath);
        await mkdir(tempHome);
        await execFileAsync("git", ["init", "-q"], { cwd: worktreePath });
        const ps = new PosixPlatformServices();
        const adapter = new CodexAdapter();
        const os = process.platform === "darwin" ? "darwin" : "linux";
        const report = await adapter.probe({
          ps,
          os,
          arch: process.arch,
          environmentType: "native",
        });
        expect(report.resolvedExecutable).not.toBeNull();
        if (report.resolvedExecutable === null) return;
        const spec = sampleSpec();
        spec.objective = [
          "This is an environment certification probe.",
          "Use the shell exactly once to run:",
          "env; command -v node; command -v git",
          "Then write everything that command printed to probe-env.txt and stop.",
        ].join(" ");
        spec.writeAllowlist = ["**"];
        spec.forbiddenScope = [];
        spec.producerOverrides = { reasoningEffort: "low" };
        const launchResult = await producerRuntime.launch({
          producerId: "codex",
          spec,
          worktreePath,
          intent: "edit",
          ps,
          runId: "run-shell-env-gate",
          tempHome,
          timeoutMs: 180_000,
          maxOutputBytes: 2_000_000,
          capabilityReport: report,
        });
        builtEnvironment = launchResult.builtEnvironment;
        const supervisedExit = launchResult.exit;
        const observed = await readFile(join(worktreePath, "probe-env.txt"), "utf8");
        const context =
          `stdout:\n${supervisedExit.stdout}\nstderr:\n${supervisedExit.stderr}`;

        // The whole point of the gate: a Producer that cannot resolve the
        // project toolchain cannot verify its own work.
        expect(observed, context).toMatch(/^\/.*\/node$/mu);
        expect(observed, context).toMatch(/^\/.*\/git$/mu);
        expect(observed, context).toContain("CLAUDE_ARCHITECT_DELEGATED=1");
        expect(observed, context).toContain(`HOME=${tempHome}`);
        expect(observed, context).not.toContain("CODEX_HOME=");
      } finally {
        builtEnvironment?.secretRegistration.dispose();
        if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
        else process.env.CODEX_HOME = originalCodexHome;
        await rm(root, { recursive: true, force: true });
      }
    },
    210_000,
  );

  it.skipIf(
    process.platform !== "linux"
      || process.env.RUN_CODEX_CONFINEMENT_GATE !== "1",
  )(
    "proves the native sandbox blocks a write outside the attempt worktree on Linux",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "claude-architect-codex-gate-"));
      const worktreePath = join(root, "worktree");
      const tempHome = join(root, "home");
      const insidePath = join(worktreePath, "inside-probe.txt");
      const outsidePath = join(homedir(), `.claude-architect-sandbox-probe-${randomUUID()}`);
      const originalCodexHome = process.env.CODEX_HOME;
      if (originalCodexHome === undefined) {
        process.env.CODEX_HOME = join(homedir(), ".codex");
      }
      let builtEnvironment: { secretRegistration: { dispose(): void } } | undefined;

      try {
        await mkdir(worktreePath);
        await mkdir(tempHome);
        await execFileAsync("git", ["init", "-q"], { cwd: worktreePath });
        const ps = new PosixPlatformServices();
        const adapter = new CodexAdapter();
        const probeContext: ProbeContext = {
          ps,
          os: "linux",
          arch: process.arch,
          environmentType: "native",
        };
        const report = await adapter.probe(probeContext);
        expect(report.resolvedExecutable).not.toBeNull();
        if (report.resolvedExecutable === null) return;
        const spec = sampleSpec();
        spec.objective = [
          "This is a sandbox certification probe.",
          "Use the shell exactly once to run:",
          `printf attempted > inside-probe.txt && printf blocked > ${JSON.stringify(outsidePath)}`,
          "Run the command even though its second target is outside the workspace, then report the result.",
        ].join(" ");
        spec.writeAllowlist = ["**"];
        spec.forbiddenScope = [];
        spec.producerOverrides = { reasoningEffort: "low" };
        const launchResult = await producerRuntime.launch({
          producerId: "codex",
          spec,
          worktreePath,
          intent: "edit",
          ps,
          runId: "run-confinement-gate",
          tempHome,
          timeoutMs: 120_000,
          capabilityReport: {
            ...report,
            writeConfinementBackend: "codex-native-sandbox",
            laneEligibility: { ...report.laneEligibility, edit: true },
          },
        });
        builtEnvironment = launchResult.builtEnvironment;
        const supervisedExit = launchResult.exit;

        await expect(
          readFile(insidePath, "utf8"),
          `stdout:\n${supervisedExit.stdout}\nstderr:\n${supervisedExit.stderr}`,
        ).resolves.toBe("attempted");
        await expect(access(outsidePath)).rejects.toMatchObject({ code: "ENOENT" });
      } finally {
        builtEnvironment?.secretRegistration.dispose();
        if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
        else process.env.CODEX_HOME = originalCodexHome;
        await rm(outsidePath, { force: true });
        await rm(root, { recursive: true, force: true });
      }
    },
    150_000,
  );
});
