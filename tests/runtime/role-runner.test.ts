import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runRole, type RoleRunArgs } from "../../src/pipeline/role-runner.js";
import type { PipelineRole, RolePackage } from "../../src/pipeline/role-prompts.js";
import type {
  PlatformServices,
  ResolvedExecutable,
  SupervisedExit,
} from "../../src/platform/platform-services.js";
import { SANDBOX_BACKENDS } from "../../src/platform/sandbox/backends.js";
import type { DelegationSpec } from "../../src/protocol/delegation-spec.js";
import type {
  CapabilityReport,
  InvocationContext,
  ProbeContext,
  ProducerAdapter,
  ProducerConfigurationProfile,
  ProducerInvocation,
} from "../../src/producers/producer-adapter.js";
import { ProducerRegistry } from "../../src/producers/producer-registry.js";
import type { RunStartContext } from "../../src/runtime/run-start.js";
import { addSandboxRow } from "../support/sandbox-rows.js";

const REVIEW_OUTPUT = [
  "```json",
  JSON.stringify({
    reportVersion: "1",
    verdict: "approve",
    findings: [],
    coverageGaps: [],
  }),
  "```",
].join("\n");

const nodeExecutable: ResolvedExecutable = {
  kind: "native",
  command: process.execPath,
  prefixArgs: [],
  resolvedFrom: "test",
};

interface FakeAdapterOptions {
  exitCode?: number;
  spawnFailure?: boolean;
  writeConfinementBackend?: string | null;
  cannedStdout?: string;
  failFirstAttempt?: boolean;
}

function capabilityReport(
  ctx: ProbeContext,
  options: FakeAdapterOptions,
): CapabilityReport {
  return {
    producerId: "fake",
    available: true,
    reason: null,
    os: ctx.os,
    arch: ctx.arch,
    environmentType: ctx.environmentType,
    resolvedExecutable: nodeExecutable,
    version: "1.0.0",
    authState: "unknown",
    executionModes: ["edit"],
    structuredOutput: true,
    writeConfinementBackend: options.writeConfinementBackend === undefined
      ? "macos-seatbelt"
      : options.writeConfinementBackend,
    laneEligibility: { edit: true },
  };
}

function supervisedExit(overrides: Partial<SupervisedExit> = {}): SupervisedExit {
  return {
    exitCode: 0,
    signal: null,
    timedOut: false,
    cancelled: false,
    stdout: REVIEW_OUTPUT,
    stderr: "",
    truncated: { stdout: false, stderr: false },
    ...overrides,
  };
}

class FakeAdapter implements ProducerAdapter {
  readonly producerId = "fake";
  spawnCount = 0;
  invocationCount = 0;
  readonly tempHomes: string[] = [];
  readonly spawnedCommands: string[] = [];
  readonly spawnedArgs: string[][] = [];
  readonly spawnedEnvs: Record<string, string>[] = [];
  readonly readOnlyRequests: boolean[] = [];
  readonly extraWritableRootRequests: Array<string[] | undefined> = [];
  readonly gitObjectDirectoryRequests: Array<string | undefined> = [];
  readonly gitAlternateDirectoryRequests: Array<string | undefined> = [];
  readonly roleSpecs: DelegationSpec[] = [];

  constructor(private readonly options: FakeAdapterOptions = {}) {}

  async probe(ctx: ProbeContext): Promise<CapabilityReport> {
    return capabilityReport(ctx, this.options);
  }

  buildInvocation(spec: DelegationSpec, ctx: InvocationContext): ProducerInvocation {
    this.invocationCount += 1;
    this.roleSpecs.push(structuredClone(spec));
    if (ctx.tempHome !== undefined) this.tempHomes.push(ctx.tempHome);
    this.readOnlyRequests.push(ctx.readOnly === true);
    this.extraWritableRootRequests.push(ctx.extraWritableRoots);
    this.gitObjectDirectoryRequests.push(ctx.gitObjectDirectory);
    this.gitAlternateDirectoryRequests.push(ctx.gitAlternateObjectDirectories);
    return {
      executable: nodeExecutable,
      args: [],
      stdin: this.options.cannedStdout ?? REVIEW_OUTPUT,
      requiredEnv: [],
      network: "denied",
    };
  }

  normalizeEvents(
    raw: Parameters<ProducerAdapter["normalizeEvents"]>[0],
  ): ReturnType<ProducerAdapter["normalizeEvents"]> {
    return {
      events: [{ kind: "final", text: raw.stdout }],
      producerSummary: raw.stdout,
      ok: true,
    };
  }

  configurationProfile(): ProducerConfigurationProfile {
    return {
      isolationState: "controlled-config-supported",
      credentialSources: [],
      behavioralConfigSources: [],
      repositoryInstructionSources: [],
      environmentDependencies: [],
      temporaryHomeStrategy: "per-attempt HOME",
    };
  }

  recordSpawn(command: string, args: string[], env: Record<string, string>): SupervisedExit {
    this.spawnCount += 1;
    this.spawnedCommands.push(command);
    this.spawnedArgs.push([...args]);
    this.spawnedEnvs.push({ ...env });
    const failsThisAttempt = this.options.failFirstAttempt === true && this.spawnCount === 1;
    const exit = supervisedExit({
      exitCode: failsThisAttempt ? 1 : (this.options.exitCode ?? 0),
      stdout: this.options.cannedStdout ?? REVIEW_OUTPUT,
    });
    if (this.options.spawnFailure === true) {
      exit.exitCode = null;
      exit.spawnError = new Error("fake spawn failure");
    }
    return exit;
  }
}

const temporaryPaths: string[] = [];
let previousNodeEnvironment: string | undefined;
let previousSeatbeltStates: Array<"certified" | "tested" | "unsupported"> | undefined;
let worktreePath = "";
let runStartTarget: RunStartContext["target"];

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  temporaryPaths.push(directory);
  return directory;
}

function platformServices(adapter: FakeAdapter): PlatformServices {
  return {
    os: "darwin",
    async resolveExecutable() {
      return nodeExecutable;
    },
    async spawnSupervised(request) {
      return {
        pid: 42,
        stdout: Readable.from([]),
        stderr: Readable.from([]),
        done: Promise.resolve(adapter.recordSpawn(
          request.executable.command,
          request.args,
          request.env,
        )),
      };
    },
    async requestCooperativeCancellation() {},
    async terminateProcessTree() {},
    async getProcessStartToken() {
      return `token-${adapter.spawnCount}`;
    },
    async terminateProcessTreeByPid() {},
    async acquireCheckoutLock() {
      throw new Error("unexpected lock");
    },
    async createSecureTempDirectory() {
      return temporaryDirectory("ca-role-home-");
    },
    async canonicalizePath(input) {
      return { input, canonical: input, gitCommonDir: null };
    },
    async acquireCleanupJournalLock() {
      throw new Error("unexpected cleanup journal lock");
    },
    async assertDirectoryWriteIntegrity() {
      throw new Error("unexpected directory integrity check");
    },
  };
}

function makeSpec(): DelegationSpec {
  return {
    specVersion: "1",
    objective: "Review the candidate.",
    context: "Candidate context.",
    writeAllowlist: ["src/**"],
    forbiddenScope: [],
    successCriteria: ["The review is complete."],
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
    timeoutMs: 10_000,
    producerPreferences: ["fake"],
    expectedOutput: "candidate-patch",
  };
}

function makePackage(spec: DelegationSpec): RolePackage {
  return {
    spec,
    baselineCommit: "b".repeat(40),
    candidateCommit: "c".repeat(40),
    candidateDiff: "diff --git a/src/a.ts b/src/a.ts",
    testEvidence: "unit: exit 0",
  };
}

function argsWith(adapter: FakeAdapter, role: PipelineRole): RoleRunArgs {
  const baseSpec = makeSpec();
  const runId = `role-${role}`;
  return {
    role,
    baseSpec,
    pkg: makePackage(baseSpec),
    worktreePath,
    ps: platformServices(adapter),
    registry: new ProducerRegistry([adapter]),
    runId,
    runStart: {
      target: runStartTarget,
      record: {
        runId,
        lockKey: "a".repeat(64),
        canonicalCommonDir: worktreePath,
        pid: null,
        processToken: null,
        startedAt: "2026-07-18T12:00:00.000Z",
      },
    },
    env: {},
  };
}

async function configureFixerGitRoots(): Promise<void> {
  const gitDir = join(await temporaryDirectory("ca-role-git-"), "worktrees", "fix");
  const commonDir = join(gitDir, "..", "..");
  await mkdir(gitDir, { recursive: true });
  await mkdir(join(commonDir, "objects"));
  await writeFile(join(worktreePath, ".git"), `gitdir: ${gitDir}\n`);
  await writeFile(join(gitDir, "commondir"), "../..\n");
}

async function readRunStart(): Promise<{ pid: number; processToken: string }> {
  return JSON.parse(await readFile(
    join(runStartTarget.canonicalDirectory, "run-start.json"),
    "utf8",
  )) as { pid: number; processToken: string };
}

beforeEach(async () => {
  previousNodeEnvironment = process.env.NODE_ENV;
  process.env.NODE_ENV = "test";
  worktreePath = await temporaryDirectory("ca-role-worktree-");
  const runStartDirectory = await realpath(await temporaryDirectory("ca-role-run-start-"));
  const metadata = await lstat(runStartDirectory, { bigint: true });
  runStartTarget = {
    publicDirectory: runStartDirectory,
    canonicalDirectory: runStartDirectory,
    identity: { dev: metadata.dev, ino: metadata.ino, birthtimeNs: metadata.birthtimeNs },
  };

  const seatbelt = SANDBOX_BACKENDS.find(backend => backend.id === "macos-seatbelt");
  if (seatbelt === undefined) throw new Error("macOS Seatbelt test backend is missing");
  // runRole checks the HOST arch (process.arch), so every darwin entry must be
  // promoted for these tests to behave identically on arm64 and x64 CI hosts.
  previousSeatbeltStates = seatbelt.platforms.map(platform => platform.state);
  for (const platform of seatbelt.platforms) platform.state = "tested";
});

afterEach(async () => {
  if (previousNodeEnvironment === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = previousNodeEnvironment;

  const seatbelt = SANDBOX_BACKENDS.find(backend => backend.id === "macos-seatbelt");
  if (seatbelt !== undefined && previousSeatbeltStates !== undefined) {
    seatbelt.platforms.forEach((platform, index) => {
      const saved = previousSeatbeltStates?.[index];
      if (saved !== undefined) platform.state = saved;
    });
  }
  previousSeatbeltStates = undefined;

  await Promise.all(temporaryPaths.splice(0).map(path =>
    rm(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })));
});

describe("runRole", () => {
  it("returns producer output for a healthy read-only reviewer run (seatbelt available)", async () => {
    const adapter = new FakeAdapter({ cannedStdout: REVIEW_OUTPUT });

    const result = await runRole(argsWith(adapter, "reviewer-correctness"));

    expect(result.ok).toBe(true);
    expect(result.rawOutput).toContain('"reportVersion"');
    expect(result.failure).toBeNull();
    expect(adapter.spawnCount).toBe(1);
    expect(adapter.spawnedCommands).toEqual(["/usr/bin/sandbox-exec"]);
  });

  it("runs each advisor invocation in a fresh read-only home without mutation or authority capabilities", async () => {
    const adapter = new FakeAdapter({ cannedStdout: REVIEW_OUTPUT });
    const first = argsWith(adapter, "advisor");
    const second = argsWith(adapter, "advisor");

    await runRole(first);
    await runRole(second);

    expect(adapter.tempHomes).toHaveLength(2);
    expect(adapter.tempHomes[0]).not.toBe(adapter.tempHomes[1]);
    expect(adapter.spawnedEnvs.map(env => env.HOME)).toEqual(adapter.tempHomes);
    expect(adapter.spawnedCommands).toEqual(["/usr/bin/sandbox-exec", "/usr/bin/sandbox-exec"]);
    expect(adapter.readOnlyRequests).toEqual([false, false]);
    expect(adapter.extraWritableRootRequests).toEqual([undefined, undefined]);
    expect(adapter.gitObjectDirectoryRequests).toEqual([undefined, undefined]);
    expect(adapter.gitAlternateDirectoryRequests).toEqual([undefined, undefined]);
    for (const roleSpec of adapter.roleSpecs) {
      expect(roleSpec.writeAllowlist).toEqual([]);
      expect(roleSpec.forbiddenScope).toEqual(["**/*"]);
      expect(roleSpec.context).toContain("READ-ONLY final advisor in a fresh session");
      expect(roleSpec.context).toContain("no authority to accept, waive, promote, integrate, commit, push, ship");
      expect(roleSpec.context).toContain("call MCP decision tools");
    }
  });

  it("fails closed when the HOST has no OS sandbox backend", async () => {
    const seatbelt = SANDBOX_BACKENDS.find(backend => backend.id === "macos-seatbelt");
    for (const platform of seatbelt?.platforms ?? []) platform.state = "unsupported";
    const adapter = new FakeAdapter({ writeConfinementBackend: null });

    const result = await runRole(argsWith(adapter, "reviewer-systems"));

    expect(result.ok).toBe(false);
    expect(result.failure).toBe("sandbox-violation");
    expect(adapter.invocationCount).toBe(0);
    expect(adapter.spawnCount).toBe(0);
  });

  it("delegates read-only confinement to a producer-native sandbox instead of wrapping it", async () => {
    // Regression: real Codex reports codex-native-sandbox (producer-native).
    // Wrapping it in an outer Seatbelt profile EPERM-crashes its own sandbox
    // init, so the role must run the producer directly with readOnly=true.
    // Add a host-arch-independent producer-native row so the assertion holds on
    // any CI runner (the probe report's arch is the real process.arch).
    const removeCodexRow = addSandboxRow(
      "codex-native-sandbox",
      { os: "darwin", environmentType: "native", state: "tested" },
      "last",
    );
    try {
      const adapter = new FakeAdapter({
        cannedStdout: REVIEW_OUTPUT,
        writeConfinementBackend: "codex-native-sandbox",
      });

      const result = await runRole(argsWith(adapter, "reviewer-correctness"));

      expect(result.ok).toBe(true);
      expect(result.failure).toBeNull();
      expect(adapter.spawnedCommands).not.toContain("/usr/bin/sandbox-exec");
      expect(adapter.readOnlyRequests).toEqual([true]);
    } finally {
      removeCodexRow();
    }
  });

  it("retries exactly once on process failure, then reports failure", async () => {
    const adapter = new FakeAdapter({ exitCode: 1 });
    await configureFixerGitRoots();

    const result = await runRole(argsWith(adapter, "fixer"));

    expect(result.ok).toBe(false);
    expect(result.failure).toBe("producer-failure");
    expect(adapter.spawnCount).toBe(2);
    expect(adapter.invocationCount).toBe(2);
    await expect(readRunStart()).resolves.toMatchObject({
      pid: 42,
      processToken: "token-2",
    });
  });

  it("passes linked-worktree git metadata roots to the fixer", async () => {
    const gitDir = join(await temporaryDirectory("ca-role-git-"), "worktrees", "fix");
    const commonDir = join(gitDir, "..", "..");
    await mkdir(gitDir, { recursive: true });
    await mkdir(join(commonDir, "objects"));
    await writeFile(join(worktreePath, ".git"), `gitdir: ${gitDir}\n`);
    await writeFile(join(gitDir, "commondir"), "../..\n");
    const adapter = new FakeAdapter();

    await runRole(argsWith(adapter, "fixer"));

    // The resolver canonicalizes via realpath (e.g. macOS /var -> /private/var).
    expect(adapter.extraWritableRootRequests).toEqual([[
      await realpath(gitDir),
      join(await realpath(gitDir), "private-objects"),
    ]]);
    expect(adapter.extraWritableRootRequests[0]).not.toContain(
      join(await realpath(commonDir), "objects"),
    );
    expect(adapter.gitObjectDirectoryRequests).toEqual([
      join(await realpath(gitDir), "private-objects"),
    ]);
    expect(adapter.gitAlternateDirectoryRequests).toEqual([
      join(await realpath(commonDir), "objects"),
    ]);
    expect(adapter.spawnedEnvs[0]).toMatchObject({
      GIT_OBJECT_DIRECTORY: join(await realpath(gitDir), "private-objects"),
      GIT_ALTERNATE_OBJECT_DIRECTORIES: join(await realpath(commonDir), "objects"),
    });
  });

  it("passes linked-worktree git metadata roots to the implementer", async () => {
    await configureFixerGitRoots();
    const gitDir = join(worktreePath, ".git");
    const resolvedGitFile = await readFile(gitDir, "utf8");
    const linkedGitDir = resolvedGitFile.trim().slice("gitdir: ".length);
    const commonDir = join(linkedGitDir, "..", "..");
    const adapter = new FakeAdapter();

    await runRole(argsWith(adapter, "implementer"));

    expect(adapter.extraWritableRootRequests).toEqual([[
      await realpath(linkedGitDir),
      join(await realpath(linkedGitDir), "private-objects"),
    ]]);
    expect(adapter.gitObjectDirectoryRequests).toEqual([
      join(await realpath(linkedGitDir), "private-objects"),
    ]);
    expect(adapter.gitAlternateDirectoryRequests).toEqual([
      join(await realpath(commonDir), "objects"),
    ]);
    expect(adapter.spawnedEnvs[0]).toMatchObject({
      GIT_OBJECT_DIRECTORY: join(await realpath(linkedGitDir), "private-objects"),
      GIT_ALTERNATE_OBJECT_DIRECTORIES: join(await realpath(commonDir), "objects"),
    });
  });

  it("does not grant reviewer roles git object access", async () => {
    for (const role of ["reviewer-correctness", "reviewer-systems"] as const) {
      const adapter = new FakeAdapter();
      const args = argsWith(adapter, role);
      args.gitObjectAccess = {
        gitDir: "/private/git-dir",
        privateObjectsDir: "/private/increment-objects",
        sharedObjectsDir: "/shared/objects",
        writableRoots: ["/private/increment-objects"],
      };

      await runRole(args);

      expect(adapter.gitObjectDirectoryRequests).toEqual([undefined]);
      expect(adapter.gitAlternateDirectoryRequests).toEqual([undefined]);
      expect(adapter.spawnedEnvs[0]).not.toHaveProperty("GIT_OBJECT_DIRECTORY");
      expect(adapter.spawnedEnvs[0]).not.toHaveProperty("GIT_ALTERNATE_OBJECT_DIRECTORIES");
    }
  });

  it.skipIf(process.platform === "win32")("wraps an OS-confined fixer with write-enabled Seatbelt roots", async () => {
    await configureFixerGitRoots();
    const adapter = new FakeAdapter({ writeConfinementBackend: "macos-seatbelt" });

    const result = await runRole(argsWith(adapter, "fixer"));

    expect(result.ok).toBe(true);
    expect(adapter.spawnedCommands).toEqual([process.execPath]);
    expect(adapter.spawnedArgs[0]?.slice(1, 4)).toEqual([
      String(process.pid),
      "--",
      "/usr/bin/sandbox-exec",
    ]);
    expect(adapter.spawnedArgs[0]?.[0]).toMatch(/runtime[/\\]watchdog\.mjs$/);
    const profile = adapter.spawnedArgs[0]?.[5] ?? "";
    expect(profile).toContain(worktreePath);
    for (const writableRoot of adapter.extraWritableRootRequests[0] ?? []) {
      expect(profile).toContain(writableRoot);
    }
  });

  it.skipIf(process.platform === "win32")("wraps an OS-confined implementer with write-enabled Seatbelt roots", async () => {
    await configureFixerGitRoots();
    const adapter = new FakeAdapter({ writeConfinementBackend: "macos-seatbelt" });

    const result = await runRole(argsWith(adapter, "implementer"));

    expect(result.ok).toBe(true);
    expect(adapter.spawnedCommands).toEqual([process.execPath]);
    expect(adapter.spawnedArgs[0]?.slice(1, 4)).toEqual([
      String(process.pid),
      "--",
      "/usr/bin/sandbox-exec",
    ]);
    expect(adapter.spawnedArgs[0]?.[0]).toMatch(/runtime[/\\]watchdog\.mjs$/);
    const profile = adapter.spawnedArgs[0]?.[5] ?? "";
    expect(profile).toContain(worktreePath);
    for (const writableRoot of adapter.extraWritableRootRequests[0] ?? []) {
      expect(profile).toContain(writableRoot);
    }
    await expect(readRunStart()).resolves.toMatchObject({
      pid: 42,
      processToken: "token-1",
    });
  });

  it("keeps a producer-native fixer unwrapped", async () => {
    const removeCodexRow = addSandboxRow(
      "codex-native-sandbox",
      { os: "darwin", environmentType: "native", state: "tested" },
      "last",
    );
    try {
      await configureFixerGitRoots();
      const adapter = new FakeAdapter({
        writeConfinementBackend: "codex-native-sandbox",
      });

      const result = await runRole(argsWith(adapter, "fixer"));

      expect(result.ok).toBe(true);
      expect(adapter.spawnedCommands).toEqual([process.execPath]);
      expect(adapter.spawnedArgs[0]?.slice(1)).toEqual([
        String(process.pid),
        "--",
        process.execPath,
      ]);
      expect(adapter.spawnedArgs[0]?.[0]).toMatch(/runtime[/\\]watchdog\.mjs$/);
      await expect(readRunStart()).resolves.toMatchObject({
        pid: 42,
        processToken: "token-1",
      });
    } finally {
      removeCodexRow();
    }
  });

  it("keeps a producer-native implementer unwrapped", async () => {
    const codex = SANDBOX_BACKENDS.find(backend => backend.id === "codex-native-sandbox");
    if (codex === undefined) throw new Error("codex-native-sandbox backend is missing");
    const platforms = codex.platforms as Array<(typeof codex.platforms)[number]>;
    platforms.push({ os: "darwin", environmentType: "native", state: "tested" });
    try {
      await configureFixerGitRoots();
      const adapter = new FakeAdapter({
        writeConfinementBackend: "codex-native-sandbox",
      });

      const result = await runRole(argsWith(adapter, "implementer"));

      expect(result.ok).toBe(true);
      expect(adapter.spawnedCommands).toEqual([process.execPath]);
      expect(adapter.spawnedArgs[0]?.slice(1)).toEqual([
        String(process.pid),
        "--",
        process.execPath,
      ]);
      expect(adapter.spawnedArgs[0]?.[0]).toMatch(/runtime[/\\]watchdog\.mjs$/);
      await expect(readRunStart()).resolves.toMatchObject({
        pid: 42,
        processToken: "token-1",
      });
    } finally {
      platforms.pop();
    }
  });

  it("fails closed before invoking a fixer with no confinement backend", async () => {
    await configureFixerGitRoots();
    const adapter = new FakeAdapter({ writeConfinementBackend: null });

    const result = await runRole(argsWith(adapter, "fixer"));

    expect(result).toMatchObject({
      ok: false,
      failure: "sandbox-violation",
      producerId: "fake",
    });
    expect(adapter.invocationCount).toBe(0);
    expect(adapter.spawnCount).toBe(0);
  });

  it("fails closed before invoking an implementer with no confinement backend", async () => {
    await configureFixerGitRoots();
    const adapter = new FakeAdapter({ writeConfinementBackend: null });

    const result = await runRole(argsWith(adapter, "implementer"));

    expect(result).toMatchObject({
      ok: false,
      failure: "sandbox-violation",
      producerId: "fake",
    });
    expect(adapter.invocationCount).toBe(0);
    expect(adapter.spawnCount).toBe(0);
  });

  it("fails closed when fixer writable-root validation fails", async () => {
    const adapter = new FakeAdapter();

    const result = await runRole(argsWith(adapter, "fixer"));

    expect(result).toMatchObject({
      ok: false,
      rawOutput: "",
      failure: "sandbox-violation",
      producerId: "fake",
    });
    expect(adapter.invocationCount).toBe(0);
    expect(adapter.spawnCount).toBe(0);
  });

  it("fails closed when implementer writable-root validation fails", async () => {
    const adapter = new FakeAdapter();

    const result = await runRole(argsWith(adapter, "implementer"));

    expect(result).toMatchObject({
      ok: false,
      rawOutput: "",
      failure: "sandbox-violation",
      producerId: "fake",
    });
    expect(adapter.invocationCount).toBe(0);
    expect(adapter.spawnCount).toBe(0);
  });

  it("requires run-start recording for implementer writers", async () => {
    await configureFixerGitRoots();
    const adapter = new FakeAdapter();
    const args = argsWith(adapter, "implementer");
    delete args.runStart;

    const result = await runRole(args);

    expect(result).toMatchObject({
      ok: false,
      rawOutput: "",
      failure: "spawn-failure",
      producerId: "fake",
    });
    expect(adapter.invocationCount).toBe(0);
    expect(adapter.spawnCount).toBe(0);
  });

  it("recovers when the retry succeeds", async () => {
    const adapter = new FakeAdapter({ failFirstAttempt: true });

    const result = await runRole(argsWith(adapter, "reviewer-correctness"));

    expect(result.ok).toBe(true);
    expect(result.failure).toBeNull();
    expect(adapter.spawnCount).toBe(2);
    expect(adapter.invocationCount).toBe(2);
    expect(adapter.tempHomes).toHaveLength(2);
    expect(adapter.tempHomes[0]).not.toBe(adapter.tempHomes[1]);
    expect(adapter.spawnedCommands).toEqual([
      "/usr/bin/sandbox-exec",
      "/usr/bin/sandbox-exec",
    ]);
  });
});
