import { spawnSync } from "node:child_process";
import { renameSync } from "node:fs";
import { access, mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runRole, type RoleRunArgs } from "../../src/pipeline/role-runner.js";
import type { RolePackage } from "../../src/pipeline/role-prompts.js";
import type { PlatformServices, ResolvedExecutable } from "../../src/platform/platform-services.js";
import { SANDBOX_BACKENDS } from "../../src/platform/sandbox/backends.js";
import { getPlatformServices } from "../../src/platform/select-platform.js";
import type { DelegationSpec } from "../../src/protocol/delegation-spec.js";
import type {
  CapabilityReport,
  InvocationContext,
  ProbeContext,
  ProducerAdapter,
  ProducerInvocation,
} from "../../src/producers/producer-adapter.js";
import { ProducerRegistry } from "../../src/producers/producer-registry.js";
import { ProducerRuntime } from "../../src/producers/producer-runtime.js";
import {
  allocateProducerHome,
  producerHomeRoot,
  recoverProducerHomes,
} from "../../src/runtime/producer-home.js";
import { recoverStaleRuns } from "../../src/runtime/recovery-manager.js";
import { containsRegisteredSecret } from "../../src/runtime/redaction.js";
import { platformServicesDouble } from "../helpers/platform-services-double.js";

const REVIEW_JSON = JSON.stringify({ reportVersion: "1", verdict: "approve", findings: [], coverageGaps: [] });
const REVIEW_OUTPUT = "```json\n" + REVIEW_JSON + "\n```";

const node: ResolvedExecutable = {
  kind: "native",
  command: process.execPath,
  prefixArgs: [],
  resolvedFrom: "test",
};

const HOME_EXPRESSION = "(process.env.HOME || process.env.USERPROFILE)";

/** A real Producer child: writes into its HOME, moves it aside, and plants a replacement. */
const SWAP_HOME_SCRIPT = `
const fs = require("node:fs");
const path = require("node:path");
const home = ${HOME_EXPRESSION};
fs.writeFileSync(path.join(home, "owned.txt"), "allocated HOME");
fs.mkdirSync(path.join(home, "replacement"));
fs.writeFileSync(path.join(home, "replacement", "replacement.txt"), "replacement HOME");
fs.renameSync(home, home + ".moved");
fs.renameSync(path.join(home + ".moved", "replacement"), home);
process.stdout.write(${JSON.stringify(REVIEW_OUTPUT)});
`;

/** Populates its HOME with nested state, then answers. */
const WRITE_HOME_SCRIPT = `
const fs = require("node:fs");
const path = require("node:path");
const home = ${HOME_EXPRESSION};
fs.mkdirSync(path.join(home, ".config", "producer"), { recursive: true });
fs.writeFileSync(path.join(home, ".config", "producer", "auth.json"), "{\\"token\\":\\"copied\\"}");
process.stdout.write(${JSON.stringify(REVIEW_OUTPUT)});
`;

/** Waits until its own claim names it, then prints that claim. */
const PRINT_CLAIM_SCRIPT = `
const fs = require("node:fs");
const path = require("node:path");
const home = ${HOME_EXPRESSION};
const claimPath = path.join(path.dirname(home), path.basename(home) + ".claim");
const deadline = Date.now() + 10000;
const poll = () => {
  let claim = { producers: [] };
  // The runtime replaces the claim by rename; a reader can briefly lose the race.
  try { claim = JSON.parse(fs.readFileSync(claimPath, "utf8")); } catch {}
  if (claim.producers.some(entry => entry.pid === process.pid)) {
    setTimeout(() => process.stdout.write(JSON.stringify(claim)), 300);
  } else if (Date.now() > deadline) {
    process.exit(3);
  } else {
    setTimeout(poll, 20);
  }
};
poll();
`;

class ScriptedAdapter implements ProducerAdapter {
  readonly producerId = "scripted";
  readonly homes: string[] = [];

  constructor(
    private readonly script: string,
    private readonly backend: string = "codex-native-sandbox",
  ) {}

  async probe(ctx: ProbeContext): Promise<CapabilityReport> {
    return {
      producerId: this.producerId,
      available: true,
      reason: null,
      os: ctx.os,
      arch: ctx.arch,
      environmentType: ctx.environmentType,
      resolvedExecutable: node,
      version: "1.0.0",
      authState: "unknown",
      executionModes: ["edit"],
      structuredOutput: true,
      writeConfinementBackend: this.backend,
      laneEligibility: { edit: true },
    };
  }

  buildInvocation(_spec: DelegationSpec, ctx: InvocationContext): ProducerInvocation {
    if (ctx.tempHome !== undefined) this.homes.push(ctx.tempHome);
    return { executable: node, args: ["-e", this.script], requiredEnv: [], network: "denied" };
  }

  normalizeEvents(raw: Parameters<ProducerAdapter["normalizeEvents"]>[0]) {
    return { events: [], producerSummary: raw.stdout, ok: true };
  }

  configurationProfile() {
    return {
      isolationState: "controlled-config-supported" as const,
      credentialSources: [],
      behavioralConfigSources: [],
      repositoryInstructionSources: [],
      environmentDependencies: [],
      temporaryHomeStrategy: "per-attempt HOME",
    };
  }
}

const temporaryPaths: string[] = [];
let worktreePath = "";
let restoreBackends: Array<() => void> = [];

function spec(): DelegationSpec {
  return {
    specVersion: "1",
    objective: "Review the candidate.",
    context: "HOME ownership regression.",
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
    timeoutMs: 20_000,
    producerPreferences: ["scripted"],
    expectedOutput: "candidate-patch",
  };
}

function roleArgs(adapter: ScriptedAdapter, overrides: Partial<RoleRunArgs> = {}): RoleRunArgs {
  const baseSpec = spec();
  const pkg: RolePackage = {
    spec: baseSpec,
    baselineCommit: "b".repeat(40),
    candidateCommit: "c".repeat(40),
    candidateDiff: "diff --git a/src/a.ts b/src/a.ts",
    testEvidence: "unit: exit 0",
  };
  return {
    role: "reviewer-correctness",
    baseSpec,
    pkg,
    worktreePath,
    ps: getPlatformServices(),
    registry: new ProducerRegistry([adapter]),
    runId: "home-ownership-role",
    env: {},
    ...overrides,
  };
}

function promoteBackend(id: string): void {
  const backend = SANDBOX_BACKENDS.find(candidate => candidate.id === id);
  if (backend === undefined) throw new Error(`${id} backend is missing`);
  const row = { os: getPlatformServices().os, environmentType: "native" as const, state: "tested" as const };
  backend.platforms.unshift(row);
  restoreBackends.push(() => {
    const index = backend.platforms.indexOf(row);
    if (index !== -1) backend.platforms.splice(index, 1);
  });
}

async function homeRootEntries(): Promise<string[]> {
  return (await readdir(producerHomeRoot()).catch(() => [] as string[])).sort();
}

async function deadProcess(): Promise<number> {
  const child = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" });
  return Number(child.stdout);
}

/** Simulate a crashed owner: the same claim, written by a process that has exited. */
async function rewriteClaim(home: string, change: (claim: Record<string, unknown>) => void): Promise<void> {
  const claimPath = join(dirname(home), `${basename(home)}.claim`);
  const claim = JSON.parse(await readFile(claimPath, "utf8")) as Record<string, unknown>;
  change(claim);
  await writeFile(claimPath, `${JSON.stringify(claim)}\n`);
}

beforeEach(async () => {
  worktreePath = await realpath(await mkdtemp(join(tmpdir(), "ca-home-worktree-")));
  temporaryPaths.push(worktreePath);
  // A producer-native read-only role runs the child directly on every host
  // OS, so each scenario is performed by a real, unconfined child process.
  promoteBackend("codex-native-sandbox");
});

afterEach(async () => {
  for (const restore of restoreBackends.splice(0)) restore();
  // Scenarios that preserve allocations leave them for the test to remove.
  temporaryPaths.push(producerHomeRoot());
  await Promise.all(temporaryPaths.splice(0).map(entry =>
    rm(entry, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })));
});

describe("runtime-owned Producer HOME", () => {
  it("rejects a replaced HOME without deleting either directory", async () => {
    const adapter = new ScriptedAdapter(SWAP_HOME_SCRIPT);

    const result = await runRole(roleArgs(adapter));

    expect(adapter.homes).toHaveLength(1);
    const home = adapter.homes[0]!;
    // The replacement planted at the allocated pathname is not the runtime's
    // allocation, so it must survive, and so must the moved allocation.
    await expect(readFile(join(home, "replacement.txt"), "utf8")).resolves.toBe("replacement HOME");
    await expect(readFile(join(`${home}.moved`, "owned.txt"), "utf8")).resolves.toBe("allocated HOME");
    // The refusal is visible and fails the role closed; its output is kept.
    expect(result).toMatchObject({ ok: false, failure: "sandbox-violation", rawOutput: REVIEW_OUTPUT });
    expect(result.cleanupFailure).toMatch(/replaced before retirement/u);
    expect(result.cleanupFailure).not.toContain(home);
    expect(result.cleanupFailure).not.toContain(producerHomeRoot());
    // The claim stays, so startup recovery keeps reporting the allocation.
    await expect(access(`${home}.claim`)).resolves.toBeUndefined();
  });

  it("allocates under the private state root and retires the identity-matched HOME", async () => {
    const adapter = new ScriptedAdapter(WRITE_HOME_SCRIPT);

    const result = await runRole(roleArgs(adapter));

    expect(result).toMatchObject({ ok: true, failure: null });
    expect(result.cleanupFailure).toBeUndefined();
    const home = adapter.homes[0]!;
    expect(dirname(home)).toBe(await realpath(producerHomeRoot()));
    expect(basename(home)).toMatch(/^[0-9a-f]{8}$/u);
    await expect(access(home)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await homeRootEntries()).toEqual([]);
  });

  it("rolls back a runtime-allocated HOME when planning fails after allocation", async () => {
    const adapter = new ScriptedAdapter("process.exit(0)");
    const failure = new Error("adapter rejected the invocation");
    adapter.buildInvocation = (_spec, ctx) => {
      if (ctx.tempHome !== undefined) adapter.homes.push(ctx.tempHome);
      throw failure;
    };

    await expect(runRole(roleArgs(adapter))).rejects.toBe(failure);

    expect(adapter.homes).toHaveLength(1);
    await expect(access(adapter.homes[0]!)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await homeRootEntries()).toEqual([]);
  });

  it("rolls back the HOME when environment assembly rejects an invalid name", async () => {
    const adapter = new ScriptedAdapter("process.exit(0)");
    const runtime = new ProducerRuntime(new ProducerRegistry([adapter]));

    await expect(runtime.planLaunch({
      adapter,
      spec: spec(),
      worktreePath,
      intent: "read-only",
      ps: getPlatformServices(),
      envAdditions: { "BAD=NAME": "value", HOME_OWNERSHIP_TOKEN: "planning-secret-value-1" },
    })).rejects.toThrow(/environment variable name/u);

    expect(containsRegisteredSecret("planning-secret-value-1")).toBe(false);

    expect(adapter.homes).toHaveLength(1);
    await expect(access(adapter.homes[0]!)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await homeRootEntries()).toEqual([]);
  });

  it("retires an internally planned HOME when the launch fails after planning", async () => {
    const adapter = new ScriptedAdapter(WRITE_HOME_SCRIPT);
    const failure = new Error("normalizer rejected the output");
    adapter.normalizeEvents = () => { throw failure; };
    const runtime = new ProducerRuntime(new ProducerRegistry([adapter]));

    await expect(runtime.launch({
      adapter,
      spec: spec(),
      worktreePath,
      intent: "read-only",
      ps: getPlatformServices(),
      envAdditions: { HOME_OWNERSHIP_TOKEN: "launch-secret-value-2" },
    })).rejects.toBe(failure);

    // The plan never reached a caller, so the launch released its secrets.
    expect(containsRegisteredSecret("launch-secret-value-2")).toBe(false);

    await expect(access(adapter.homes[0]!)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await homeRootEntries()).toEqual([]);
  });

  it("keeps the planning error and a redacted diagnostic when rollback cannot retire", async () => {
    const adapter = new ScriptedAdapter("process.exit(0)");
    const failure = new Error("adapter rejected the invocation");
    const moved: string[] = [];
    adapter.buildInvocation = (_spec, ctx) => {
      // The allocation disappears from its name before the rollback runs.
      const home = ctx.tempHome!;
      renameSync(home, `${home}.gone`);
      moved.push(`${home}.gone`, home);
      throw failure;
    };
    const runtime = new ProducerRuntime(new ProducerRegistry([adapter]));

    const error = await runtime.planLaunch({
      adapter,
      spec: spec(),
      worktreePath,
      intent: "read-only",
      ps: getPlatformServices(),
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(AggregateError);
    const errors = (error as AggregateError).errors;
    expect(errors[0]).toBe(failure);
    expect(String((errors[1] as Error).message)).toMatch(/moved away before retirement/u);
    expect(String((errors[1] as Error).message)).not.toContain(moved[1]!);
    await expect(access(moved[0]!)).resolves.toBeUndefined();
  });

  it("never retires a borrowed HOME", async () => {
    const adapter = new ScriptedAdapter(WRITE_HOME_SCRIPT);
    const borrowed = await mkdtemp(join(tmpdir(), "ca-borrowed-home-"));
    temporaryPaths.push(borrowed);
    const runtime = new ProducerRuntime(new ProducerRegistry([adapter]));

    const result = await runtime.launch({
      adapter,
      spec: spec(),
      worktreePath,
      intent: "read-only",
      ps: getPlatformServices(),
      tempHome: borrowed,
    });
    result.builtEnvironment.secretRegistration.dispose();

    expect(result.home).toBeNull();
    expect(result.tempHome).toBe(borrowed);
    await expect(readFile(join(borrowed, ".config", "producer", "auth.json"), "utf8")).resolves.toContain("copied");
    expect(await homeRootEntries()).toEqual([]);
  });

  it("claims a borrowed launch's Producer under the lender's lease without retiring it", async () => {
    // The attempt lends its HOME to the preflight probe this way.
    const lease = await allocateProducerHome({ writeScope: [worktreePath] });
    const adapter = new ScriptedAdapter(WRITE_HOME_SCRIPT);
    const runtime = new ProducerRuntime(new ProducerRegistry([adapter]));

    const result = await runtime.launch({
      adapter,
      spec: spec(),
      worktreePath,
      intent: "read-only",
      ps: getPlatformServices(),
      tempHome: lease.path,
      homeLease: lease,
    });
    result.builtEnvironment.secretRegistration.dispose();

    expect(result.home).toBeNull();
    const claim = JSON.parse(await readFile(`${lease.path}.claim`, "utf8")) as {
      phase: string;
      producers: Array<{ pid: number }>;
    };
    expect(claim.phase).toBe("held");
    expect(claim.producers).toHaveLength(1);
    await expect(access(join(lease.path, ".config", "producer", "auth.json"))).resolves.toBeUndefined();
    expect((await lease.retire()).ok).toBe(true);
    expect(await homeRootEntries()).toEqual([]);
  });

  it("gives concurrent roles separate claims that record only their own Producer", async () => {
    const first = new ScriptedAdapter(PRINT_CLAIM_SCRIPT);
    const second = new ScriptedAdapter(PRINT_CLAIM_SCRIPT);

    const results = await Promise.all([
      runRole(roleArgs(first, { role: "reviewer-correctness" })),
      runRole(roleArgs(second, { role: "reviewer-systems" })),
    ]);

    const claims = results.map(result => JSON.parse(result.rawOutput) as {
      homeId: string;
      owner: { pid: number };
      producers: Array<{ pid: number }>;
    });
    expect(claims[0]!.homeId).not.toBe(claims[1]!.homeId);
    for (const claim of claims) {
      expect(claim.owner.pid).toBe(process.pid);
      expect(claim.producers).toHaveLength(1);
    }
    expect(claims[0]!.producers[0]!.pid).not.toBe(claims[1]!.producers[0]!.pid);
    for (const home of [...first.homes, ...second.homes]) {
      await expect(access(home)).rejects.toMatchObject({ code: "ENOENT" });
    }
    expect(await homeRootEntries()).toEqual([]);
  });

  it("retires the HOME after a cancelled Producer is terminated", async () => {
    const adapter = new ScriptedAdapter(`
      require("fs").writeFileSync(require("path").join(${HOME_EXPRESSION}, "partial"), "x");
      setTimeout(() => {}, 60000);
    `);
    const controller = new AbortController();
    const pending = runRole(roleArgs(adapter, { abortSignal: controller.signal }));
    const deadline = Date.now() + 10_000;
    while (adapter.homes.length === 0 || await access(join(adapter.homes[0]!, "partial")).then(() => false, () => true)) {
      if (Date.now() > deadline) throw new Error("the Producer never started");
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    controller.abort();

    const result = await pending;

    expect(result).toMatchObject({ ok: false, failure: "cancelled" });
    expect(result.cleanupFailure).toBeUndefined();
    await expect(access(adapter.homes[0]!)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await homeRootEntries()).toEqual([]);
  });

  it("preserves the HOME and moves nothing when the cleanup backend is unavailable", async () => {
    const lease = await allocateProducerHome({ writeScope: [worktreePath] });
    await writeFile(join(lease.path, "state"), "x");
    const unsupported = platformServicesDouble({ os: "aix" as PlatformServices["os"] });

    const retirement = await lease.retire(unsupported);

    expect(retirement).toMatchObject({ ok: false, conflict: false });
    expect(retirement.diagnostic).toMatch(/cleanup backend is unavailable/u);
    expect(retirement.diagnostic).not.toContain(lease.path);
    await expect(readFile(join(lease.path, "state"), "utf8")).resolves.toBe("x");
    await expect(access(`${lease.path}.claim`)).resolves.toBeUndefined();
    // Memoized: the owner cannot retry into a half-moved state.
    await expect(lease.retire()).resolves.toBe(retirement);
  });

  it("refuses a state directory inside the Producer's writable scope before allocating", async () => {
    const adapter = new ScriptedAdapter("process.exit(0)");
    const runtime = new ProducerRuntime(new ProducerRegistry([adapter]));

    await expect(runtime.planLaunch({
      adapter,
      spec: spec(),
      worktreePath: dirname(producerHomeRoot()),
      intent: "read-only",
      ps: getPlatformServices(),
    })).rejects.toThrow(/overlaps the Producer's writable scope/u);

    expect(adapter.homes).toEqual([]);
    expect(await homeRootEntries()).toEqual([]);
  });

  it.runIf(process.platform === "darwin")("denies a Seatbelt-confined Producer every write in the HOME root except its own HOME", async () => {
    restoreBackends.push((() => {
      const seatbelt = SANDBOX_BACKENDS.find(backend => backend.id === "macos-seatbelt")!;
      const saved = seatbelt.platforms.map(platform => platform.state);
      for (const platform of seatbelt.platforms) platform.state = "tested";
      return () => seatbelt.platforms.forEach((platform, index) => { platform.state = saved[index]!; });
    })());
    const adapter = new ScriptedAdapter(`
      const fs = require("node:fs");
      const path = require("node:path");
      const home = ${HOME_EXPRESSION};
      const os = require("node:os");
      const attempt = action => { try { action(); return "written"; } catch (error) { return error.code; } };
      const write = target => attempt(() => fs.writeFileSync(target, "x"));
      process.stdout.write(JSON.stringify({
        own: write(path.join(home, "own.txt")),
        nested: attempt(() => {
          fs.mkdirSync(path.join(home, ".config", "producer"), { recursive: true });
          fs.writeFileSync(path.join(home, ".config", "producer", "auth.json"), "{}");
        }),
        sibling: write(path.join(path.dirname(home), "planted")),
        claim: write(path.join(path.dirname(home), path.basename(home) + ".claim")),
        quarantine: write(path.join(path.dirname(home), ".q-" + path.basename(home))),
        // The HOME pathname itself is the runtime's: it can be neither moved
        // away (into writable temp) nor recreated.
        moveOut: attempt(() => fs.renameSync(home, path.join(os.tmpdir(), "stolen-" + path.basename(home)))),
        recreate: attempt(() => { fs.rmSync(home, { recursive: true }); fs.mkdirSync(home); }),
      }));
    `, "macos-seatbelt");

    const result = await runRole(roleArgs(adapter));
    temporaryPaths.push(join(tmpdir(), `stolen-${basename(adapter.homes[0]!)}`));

    expect(JSON.parse(result.rawOutput)).toEqual({
      own: "written",
      nested: "written",
      sibling: "EPERM",
      claim: "EPERM",
      quarantine: "EPERM",
      moveOut: "EPERM",
      recreate: "EPERM",
    });
    expect(result.cleanupFailure).toBeUndefined();
    expect(await homeRootEntries()).toEqual([]);
  });
});

describe("Producer HOME recovery", () => {
  it("reclaims a HOME whose owners are all proven dead and preserves a live owner's", async () => {
    const dead = await allocateProducerHome({ writeScope: [worktreePath] });
    await mkdir(join(dead.path, "nested"));
    await writeFile(join(dead.path, "nested", "file"), "x");
    const deadPid = await deadProcess();
    await rewriteClaim(dead.path, claim => {
      claim.owner = { pid: deadPid, processToken: "exited" };
      claim.producers = [{ pid: deadPid, processToken: null }];
    });
    const live = await allocateProducerHome({ writeScope: [worktreePath] });
    const unverifiable = await allocateProducerHome({ writeScope: [worktreePath] });
    await rewriteClaim(unverifiable.path, claim => {
      claim.owner = { pid: deadPid, processToken: "exited" };
      // Alive, but recorded without a start token: a reused pid is possible.
      claim.producers = [{ pid: process.pid, processToken: null }];
    });

    const issues = await recoverProducerHomes({
      stateRoot: dirname(producerHomeRoot()),
      ps: getPlatformServices(),
      isProcessAlive: pid => pid === process.pid,
    });

    expect(issues.map(issue => [issue.path, String((issue.error as Error).message)])).toEqual([
      [unverifiable.path, expect.stringMatching(/identity cannot be verified/u)],
    ]);
    await expect(access(unverifiable.path)).resolves.toBeUndefined();
    await expect(access(dead.path)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(`${dead.path}.claim`)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(live.path)).resolves.toBeUndefined();
    expect((await live.retire()).ok).toBe(true);
  });

  it("completes a retirement interrupted after the quarantine rename", async () => {
    const lease = await allocateProducerHome({ writeScope: [worktreePath] });
    await writeFile(join(lease.path, "file"), "x");
    const deadPid = await deadProcess();
    await rewriteClaim(lease.path, claim => {
      claim.owner = { pid: deadPid, processToken: "exited" };
    });
    await rename(lease.path, join(dirname(lease.path), `.q-${basename(lease.path)}`));

    const issues = await recoverProducerHomes({
      stateRoot: dirname(producerHomeRoot()),
      ps: getPlatformServices(),
      isProcessAlive: pid => pid === process.pid,
    });

    expect(issues).toEqual([]);
    expect(await homeRootEntries()).toEqual([]);
  });

  it("preserves and reports malformed, interrupted-launch, replaced, and unclaimed allocations", async () => {
    const deadPid = await deadProcess();
    const malformed = await allocateProducerHome({ writeScope: [worktreePath] });
    await writeFile(`${malformed.path}.claim`, "{\"claimVersion\":1}\n");
    const launching = await allocateProducerHome({ writeScope: [worktreePath] });
    await rewriteClaim(launching.path, claim => {
      claim.owner = { pid: deadPid, processToken: "exited" };
      claim.phase = "launching";
    });
    const replaced = await allocateProducerHome({ writeScope: [worktreePath] });
    await rewriteClaim(replaced.path, claim => {
      claim.owner = { pid: deadPid, processToken: "exited" };
    });
    await rename(replaced.path, `${replaced.path}-aside`);
    await mkdir(replaced.path);
    const unclaimed = join(producerHomeRoot(), "0badf00d");
    await mkdir(unclaimed);

    const issues = await recoverProducerHomes({
      stateRoot: dirname(producerHomeRoot()),
      ps: getPlatformServices(),
      isProcessAlive: pid => pid === process.pid,
    });

    const reasons = new Map(issues.map(issue => [basename(issue.path), String((issue.error as Error).message)]));
    expect(reasons.get(basename(malformed.path))).toMatch(/malformed/u);
    expect(reasons.get(basename(launching.path))).toMatch(/between a spawn and its record/u);
    expect(reasons.get(basename(replaced.path))).toMatch(/replaced before retirement/u);
    expect(reasons.get("0badf00d")).toMatch(/without an ownership claim/u);
    for (const preserved of [malformed.path, launching.path, replaced.path, `${replaced.path}-aside`, unclaimed]) {
      await expect(access(preserved)).resolves.toBeUndefined();
    }
  });

  it("surfaces preserved HOMEs through startup recovery with redacted reasons", async () => {
    const malformed = await allocateProducerHome({ writeScope: [worktreePath] });
    await writeFile(`${malformed.path}.claim`, "not json\n");

    const result = await recoverStaleRuns({ platformServices: getPlatformServices() });

    // Reported apart from the worktree sweep, so it never gates mutation.
    expect(result.worktreeSweepIssues ?? []).toEqual([]);
    const issue = result.producerHomeIssues?.find(entry => entry.worktreePath === malformed.path);
    expect(issue?.reason).toMatch(/malformed/u);
    expect(issue?.reason).not.toContain(producerHomeRoot());
    await expect(access(malformed.path)).resolves.toBeUndefined();
  });
});
