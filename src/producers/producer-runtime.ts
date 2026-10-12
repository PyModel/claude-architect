import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { supervise } from "../platform/process-supervisor.js";
import type {
  PlatformServices,
  ResolvedExecutable,
  SupervisedExit,
} from "../platform/platform-services.js";
import type { DelegationSpec } from "../protocol/delegation-spec.js";
import { buildEnvironment, type BuiltEnvironment } from "../runtime/environment-policy.js";
import {
  buildReadOnlySeatbeltPolicy,
  buildWriteSeatbeltPolicy,
  wrapInvocationWithSeatbelt,
} from "../platform/sandbox/seatbelt.js";
import { selectSandboxBackend } from "../platform/sandbox/backends.js";
import {
  parentDeathWatchdogInvocation,
  withRunStartPidRecording,
  type RunStartContext,
} from "../runtime/run-start.js";
import {
  allocateProducerHome,
  producerHomeRoot,
  type ProducerHomeLease,
} from "../runtime/producer-home.js";
import type {
  AdapterEvent,
  CapabilityReport,
  InvocationContext,
  ProbeContext,
  ProducerAdapter,
  ProducerDescriptor,
  ProducerInvocation,
} from "./producer-adapter.js";
import { detectEnvironmentType } from "./producer-adapter.js";
import { normalizeNodeShim } from "./plain-text.js";
import {
  resolveConfigRevision,
  resolveHostStoreRoot,
  type HostStoreContext,
} from "./host-store.js";
import { registry as defaultRegistry, ProducerRegistry } from "./producer-registry.js";
import { RuntimeError } from "../util/errors.js";

const MAX_PRODUCER_OUTPUT_BYTES = 1_000_000;

function preCancelledExit(): SupervisedExit {
  return {
    exitCode: null,
    signal: null,
    timedOut: false,
    cancelled: true,
    stdout: "",
    stderr: "",
    truncated: { stdout: false, stderr: false },
  };
}

export interface ProducerLaunchRequest {
  producerId?: string | undefined;
  adapter?: ProducerAdapter | undefined;
  spec: DelegationSpec;
  worktreePath: string;
  intent: "edit" | "read-only" | "probe";
  ps: PlatformServices;
  runId?: string | undefined;
  abortSignal?: AbortSignal | undefined;
  timeoutMs?: number | undefined;
  maxOutputBytes?: number | undefined;
  /** A borrowed HOME: the runtime never retires it. */
  tempHome?: string | null | undefined;
  /** The caller's lease on a borrowed `tempHome`, so this launch's spawn is claimed too. */
  homeLease?: ProducerHomeLease | null | undefined;
  extraWritableRoots?: string[] | undefined;
  gitObjectAccess?: {
    privateObjectsDir: string;
    sharedObjectsDir: string | string[];
  } | undefined;
  envAdditions?: Record<string, string> | undefined;
  runStartContext?: RunStartContext | undefined;
  capabilityReport?: CapabilityReport | undefined;
  plan?: ProducerLaunchPlan | undefined;
}

export interface ProducerLaunchPlan {
  descriptor?: ProducerDescriptor | undefined;
  adapter: ProducerAdapter;
  capabilityReport: CapabilityReport;
  tempHome: string | null;
  /**
   * The runtime-allocated HOME this plan owns, or null when the HOME is
   * borrowed or absent. Its holder retires it once the Producer has settled.
   */
  home: ProducerHomeLease | null;
  invocation: ProducerInvocation;
  supervisedInvocation: { executable: ResolvedExecutable; args: string[] };
  builtEnvironment: BuiltEnvironment;
  confinementBackend: string | null;
}

export interface ProducerLaunchResult extends ProducerLaunchPlan {
  exit: SupervisedExit;
  events: AdapterEvent[];
  producerSummary: string | null;
  ok: boolean;
}

export interface ProbeOptions {
  fresh?: boolean;
}

export class ProducerRuntime {
  private probeCache = new Map<string, CapabilityReport>();
  private cacheHits = 0;

  constructor(readonly registry: ProducerRegistry = defaultRegistry) {}

  get probeCacheHits(): number {
    return this.cacheHits;
  }

  clearProbeCache(): void {
    this.probeCache.clear();
    this.cacheHits = 0;
  }

  async computeProbeCacheKey(
    producerId: string,
    adapter: ProducerAdapter,
    ctx: ProbeContext,
  ): Promise<string | null> {
    const descriptor = (adapter as { descriptor?: ProducerDescriptor }).descriptor;
    let execKey = "";
    try {
      const query = descriptor?.executable ?? { name: producerId };
      const resolved = await normalizeNodeShim(await ctx.ps.resolveExecutable(query));
      let mtime = "";
      try {
        if (existsSync(resolved.command)) {
          mtime = String(statSync(resolved.command).mtimeMs);
        }
      } catch {}
      execKey = `${resolved.command}:${resolved.prefixArgs.join(",")}:${mtime}`;
    } catch {
      return null;
    }

    const hostStoreContext: HostStoreContext = {
      env: process.env,
      homeDirectory: homedir(),
    };
    const hostStoreRoot = descriptor ? resolveHostStoreRoot(descriptor, hostStoreContext) ?? "" : "";
    const configRevision = descriptor ? resolveConfigRevision(descriptor, hostStoreContext) : "";

    return `${producerId}|${execKey}|${hostStoreRoot}|${configRevision}`;
  }

  async probe(
    producerId: string,
    ctx: ProbeContext,
    options?: ProbeOptions,
    customRegistry?: ProducerRegistry,
  ): Promise<CapabilityReport> {
    const reg = customRegistry ?? this.registry;
    const adapter = reg.get(producerId);
    if (adapter === undefined) {
      throw new RuntimeError(`Unknown producer '${producerId}'`);
    }

    if (options?.fresh !== true) {
      const key = await this.computeProbeCacheKey(producerId, adapter, ctx);
      if (key !== null) {
        const cached = this.probeCache.get(key);
        if (cached !== undefined) {
          this.cacheHits++;
          return cached;
        }
      }
    }

    const report = await adapter.probe(ctx);
    if (options?.fresh !== true) {
      const key = await this.computeProbeCacheKey(producerId, adapter, ctx);
      if (key !== null) {
        this.probeCache.set(key, report);
      }
    }
    return report;
  }

  async probeAll(
    ctx: ProbeContext,
    options?: ProbeOptions,
    customRegistry?: ProducerRegistry,
  ): Promise<CapabilityReport[]> {
    const reg = customRegistry ?? this.registry;
    return Promise.all(reg.all().map(adapter => this.probe(adapter.producerId, ctx, options, reg)));
  }

  async planLaunch(request: ProducerLaunchRequest): Promise<ProducerLaunchPlan> {
    const adapter = request.adapter
      ?? (request.producerId !== undefined ? this.registry.get(request.producerId) : undefined);
    if (adapter === undefined) {
      throw new RuntimeError(`Unknown producer '${request.producerId ?? "unknown"}'`);
    }

    const producerId = request.producerId ?? adapter.producerId ?? "unknown";
    const descriptor = (adapter as { descriptor?: ProducerDescriptor }).descriptor;
    const report = request.capabilityReport ?? await adapter.probe({
      ps: request.ps,
      os: request.ps.os,
      arch: process.arch,
      environmentType: detectEnvironmentType(),
    });

    if (report.resolvedExecutable === null) {
      throw new RuntimeError(`Cannot launch producer '${producerId}': executable not resolved`);
    }

    const profile = typeof adapter.configurationProfile === "function"
      ? adapter.configurationProfile()
      : undefined;
    const isolation = descriptor?.isolation
      ?? profile?.isolationState
      ?? "controlled-config-supported";
    const requiresTempHome = isolation === "controlled-config-supported"
      || isolation === "controlled-config-with-copied-credentials";

    // Refuse declared-writable-state + temp-HOME combination
    if (request.tempHome !== undefined && request.tempHome !== null && !requiresTempHome) {
      throw new RuntimeError(
        `Declared writable state cannot be combined with temporary HOME isolation for producer '${producerId}'`,
      );
    }

    let home: ProducerHomeLease | null = null;
    let tempHome: string | null;
    if (request.tempHome !== undefined) {
      tempHome = request.tempHome;
    } else if (requiresTempHome) {
      home = await allocateProducerHome({
        writeScope: [
          request.worktreePath,
          ...(request.extraWritableRoots ?? []),
          ...(request.gitObjectAccess === undefined ? [] : [
            request.gitObjectAccess.privateObjectsDir,
            ...[request.gitObjectAccess.sharedObjectsDir].flat(),
          ]),
        ],
      });
      tempHome = home.path;
    } else {
      tempHome = null;
    }

    try {
      return await this.planWithHome(request, adapter, descriptor, report, report.resolvedExecutable, tempHome, home);
    } catch (error) {
      if (home === null) throw error;
      const retirement = await home.retire();
      if (retirement.ok) throw error;
      throw new AggregateError(
        [error, new RuntimeError(retirement.diagnostic ?? "Producer HOME preserved")],
        "launch planning failed and its Producer HOME could not be retired",
      );
    }
  }

  private async planWithHome(
    request: ProducerLaunchRequest,
    adapter: ProducerAdapter,
    descriptor: ProducerDescriptor | undefined,
    report: CapabilityReport,
    executable: ResolvedExecutable,
    tempHome: string | null,
    home: ProducerHomeLease | null,
  ): Promise<ProducerLaunchPlan> {
    const selection = selectSandboxBackend(report);
    const confinementBackend = selection.backend?.id ?? null;
    const isSeatbelt = selection.backend?.kind === "os" && selection.backend.id === "macos-seatbelt";

    const readOnly = request.intent === "read-only";
    const nativeReadOnly = readOnly
      && selection.backend?.kind === "producer-native";

    const invocationContext: InvocationContext = {
      worktreePath: request.worktreePath,
      runId: request.runId ?? "anonymous-run",
      ...(tempHome === null ? {} : { tempHome }),
      capabilityReport: report,
      executable,
      readOnly: nativeReadOnly,
      ...(request.extraWritableRoots && request.extraWritableRoots.length > 0
        ? { extraWritableRoots: request.extraWritableRoots }
        : {}),
      ...(request.gitObjectAccess ? {
        gitObjectDirectory: request.gitObjectAccess.privateObjectsDir,
        gitAlternateObjectDirectories: Array.isArray(request.gitObjectAccess.sharedObjectsDir)
          ? request.gitObjectAccess.sharedObjectsDir.join(path.delimiter)
          : request.gitObjectAccess.sharedObjectsDir,
      } : {}),
    };

    let invocation = adapter.buildInvocation(request.spec, invocationContext);

    if (readOnly && !nativeReadOnly) {
      if (isSeatbelt) {
        invocation = wrapInvocationWithSeatbelt(
          invocation,
          buildReadOnlySeatbeltPolicy({ tempHome, protectedRoots: [producerHomeRoot()] }),
        );
      }
    } else if (isSeatbelt) {
      invocation = wrapInvocationWithSeatbelt(
        invocation,
        buildWriteSeatbeltPolicy({
          worktreePath: request.worktreePath,
          tempHome,
          extraWritableRoots: request.extraWritableRoots ?? [],
          protectedRoots: [producerHomeRoot()],
        }),
      );
    }

    const builtEnvironment = buildEnvironment({
      os: request.ps.os,
      adapterAllowlist: invocation.requiredEnv ?? [],
      ...(invocation.env === undefined ? {} : { adapterValues: invocation.env }),
      specAdditions: {
        ...(request.envAdditions ?? {}),
        ...(request.gitObjectAccess ? {
          GIT_OBJECT_DIRECTORY: request.gitObjectAccess.privateObjectsDir,
          GIT_ALTERNATE_OBJECT_DIRECTORIES: Array.isArray(request.gitObjectAccess.sharedObjectsDir)
            ? request.gitObjectAccess.sharedObjectsDir.join(path.delimiter)
            : request.gitObjectAccess.sharedObjectsDir,
        } : {}),
      },
      ...(tempHome === null ? {} : { tempHome }),
    });

    const isWriter = request.intent !== "read-only";
    let supervisedInvocation: { executable: ResolvedExecutable; args: string[] };
    try {
      supervisedInvocation = isWriter
        ? await parentDeathWatchdogInvocation(invocation.executable, invocation.args)
        : { executable: invocation.executable, args: invocation.args };
    } catch (error) {
      // No caller will ever hold this environment: release its secrets here.
      builtEnvironment.secretRegistration.dispose();
      throw error;
    }

    return {
      descriptor,
      adapter,
      capabilityReport: report,
      tempHome,
      home,
      invocation,
      supervisedInvocation,
      builtEnvironment,
      confinementBackend,
    };
  }

  async launch(request: ProducerLaunchRequest): Promise<ProducerLaunchResult> {
    if (request.plan !== undefined) return await this.launchPlanned(request, request.plan);
    const plan = await this.planLaunch(request);
    try {
      return await this.launchPlanned(request, plan);
    } catch (error) {
      // The plan never reached the caller, so this call still owns its HOME
      // and its environment. Retire first, while secrets still redact.
      const retirement = plan.home === null ? null : await plan.home.retire();
      plan.builtEnvironment.secretRegistration.dispose();
      if (retirement === null || retirement.ok) throw error;
      throw new AggregateError(
        [error, new RuntimeError(retirement.diagnostic ?? "Producer HOME preserved")],
        "Producer launch failed and its HOME could not be retired",
      );
    }
  }

  private async launchPlanned(
    request: ProducerLaunchRequest,
    plan: ProducerLaunchPlan,
  ): Promise<ProducerLaunchResult> {
    const lease = plan.home ?? request.homeLease ?? null;
    const claimedServices = lease === null ? request.ps : withHomeClaimRecording(request.ps, lease);
    const processServices = request.runStartContext !== undefined
      ? withRunStartPidRecording(claimedServices, request.runStartContext)
      : claimedServices;

    const exit = request.abortSignal?.aborted === true
      ? preCancelledExit()
      : await supervise(processServices, {
        executable: plan.supervisedInvocation.executable,
        args: plan.supervisedInvocation.args,
        cwd: request.worktreePath,
        env: plan.builtEnvironment.env,
        timeoutMs: request.timeoutMs ?? request.spec.timeoutMs,
        ...(plan.invocation.stdin === undefined ? {} : { stdin: plan.invocation.stdin }),
        maxOutputBytes: request.maxOutputBytes ?? MAX_PRODUCER_OUTPUT_BYTES,
      }, request.abortSignal === undefined ? {} : { onCancel: request.abortSignal });

    const normalized = typeof plan.adapter.normalizeEvents === "function"
      ? plan.adapter.normalizeEvents({
        stdout: exit.stdout,
        stderr: exit.stderr,
        exit,
      })
      : { events: [], producerSummary: exit.stdout, ok: exit.exitCode === 0 };

    return {
      ...plan,
      exit,
      events: normalized.events,
      producerSummary: normalized.producerSummary,
      ok: normalized.ok,
    };
  }
}

/**
 * Record each spawned Producer in its HOME claim: `launching` before the
 * spawn, the process identity right after it. A failed record terminates the
 * tree, as run-start recording does.
 */
function withHomeClaimRecording(ps: PlatformServices, lease: ProducerHomeLease): PlatformServices {
  return Object.assign(Object.create(ps) as PlatformServices, {
    os: ps.os,
    async spawnSupervised(request: Parameters<PlatformServices["spawnSupervised"]>[0]) {
      await lease.beforeSpawn();
      const child = await ps.spawnSupervised(request);
      try {
        const processToken = child.pid > 1
          ? await ps.getProcessStartToken(child.pid).catch(() => null)
          : null;
        if (child.pid > 1) await lease.recordProducer(child.pid, processToken);
      } catch (error) {
        await ps.terminateProcessTree(child).catch(() => {});
        throw error;
      }
      return child;
    },
  });
}

export const producerRuntime = new ProducerRuntime();
