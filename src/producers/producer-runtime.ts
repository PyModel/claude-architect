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
  tempHome?: string | null | undefined;
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

    let tempHome: string | null;
    if (request.tempHome !== undefined) {
      tempHome = request.tempHome;
    } else if (requiresTempHome) {
      tempHome = await request.ps.createSecureTempDirectory();
    } else {
      tempHome = null;
    }

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
      executable: report.resolvedExecutable,
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
          buildReadOnlySeatbeltPolicy({ tempHome }),
        );
      }
    } else if (isSeatbelt) {
      invocation = wrapInvocationWithSeatbelt(
        invocation,
        buildWriteSeatbeltPolicy({
          worktreePath: request.worktreePath,
          tempHome,
          extraWritableRoots: request.extraWritableRoots ?? [],
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
    const supervisedInvocation = isWriter
      ? await parentDeathWatchdogInvocation(invocation.executable, invocation.args)
      : { executable: invocation.executable, args: invocation.args };

    return {
      descriptor,
      adapter,
      capabilityReport: report,
      tempHome,
      invocation,
      supervisedInvocation,
      builtEnvironment,
      confinementBackend,
    };
  }

  async launch(request: ProducerLaunchRequest): Promise<ProducerLaunchResult> {
    const plan = request.plan ?? await this.planLaunch(request);

    const processServices = request.runStartContext !== undefined
      ? withRunStartPidRecording(request.ps, request.runStartContext)
      : request.ps;

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

export const producerRuntime = new ProducerRuntime();
