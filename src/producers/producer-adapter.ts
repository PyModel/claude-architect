import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import type {
  PlatformServices,
  ResolvedExecutable,
  SupervisedExit,
} from "../platform/platform-services.js";
import type { DelegationSpec } from "../protocol/delegation-spec.js";
import {
  probeOsConfinedCli,
  unavailableCapabilityReport,
  type OsConfinedCliProbe,
} from "./cli-probe.js";
import {
  isProducerAuthenticated,
  type HostStateDescriptor,
  type HostStoreContext,
} from "./host-store.js";
import { renderProducerPrompt } from "./prompt-renderer.js";

export type PlatformState = "certified" | "tested" | "conditional" | "unsupported" | "unknown";
export type EnvironmentType = "native" | "wsl";

export interface CapabilityReport {
  producerId: string;
  available: boolean;
  reason: string | null;
  os: "darwin" | "linux" | "win32";
  arch: string;
  environmentType: EnvironmentType;
  resolvedExecutable: ResolvedExecutable | null;
  version: string | null;
  authState: "authenticated" | "unauthenticated" | "unknown";
  executionModes: string[];
  structuredOutput: boolean;
  writeConfinementBackend: string | null;
  laneEligibility: Record<string, boolean>;
}

export interface AdapterEvent {
  kind: "message" | "tool" | "error" | "final";
  text?: string;
  raw?: unknown;
}

export interface ProducerInvocation {
  executable: ResolvedExecutable;
  args: string[];
  stdin?: string;
  requiredEnv: string[];
  /** Adapter-supplied defaults; never override a host-provided allowlisted value. */
  env?: Record<string, string>;
  /**
   * Absolute paths the Producer must be able to write when it runs with the
   * host's real HOME (no temporary home): its own auth/config/state store.
   * The OS write-confinement backend grants exactly these on top of the
   * worktree; it never derives them from executable identity or env names.
   * Ignored whenever a temporary home is in effect.
   */
  inheritedStateWritablePaths?: string[];
  network: "denied" | "allowed";
}

export interface ProbeContext {
  ps: PlatformServices;
  os: "darwin" | "linux" | "win32";
  arch: string;
  environmentType: EnvironmentType;
}

export interface InvocationContext {
  worktreePath: string;
  extraWritableRoots?: string[];
  gitObjectDirectory?: string;
  gitAlternateObjectDirectories?: string;
  runId: string;
  tempHome?: string;
  capabilityReport: CapabilityReport;
  executable: ResolvedExecutable;
  /** Read-only role sessions: adapters with a native sandbox must deny writes themselves. */
  readOnly?: boolean;
}

export interface ProducerAdapter {
  producerId: string;
  probe(ctx: ProbeContext): Promise<CapabilityReport>;
  buildInvocation(spec: DelegationSpec, ctx: InvocationContext): ProducerInvocation;
  normalizeEvents(raw: { stdout: string; stderr: string; exit: SupervisedExit }): {
    events: AdapterEvent[];
    producerSummary: string | null;
    ok: boolean;
  };
  configurationProfile(): ProducerConfigurationProfile;
}

export type ProducerConfigurationProfile = {
  isolationState:
    | "controlled-config-supported"
    | "controlled-config-with-copied-credentials"
    | "inherited-config-only"
    | "configuration-isolation-unsupported";
  credentialSources: string[];
  behavioralConfigSources: string[];
  repositoryInstructionSources: string[];
  environmentDependencies: string[];
  temporaryHomeStrategy: string;
};

export type ProducerIsolation = ProducerConfigurationProfile["isolationState"];

/**
 * A Producer Descriptor is the data that defines a Producer, plus hooks for
 * only the custom code its CLI genuinely needs. DescriptorAdapter is the one
 * adapter implementation; each hook replaces the corresponding default.
 */
export interface ProducerDescriptor {
  readonly id: string;
  readonly executable: { name: string };
  readonly isolation: ProducerIsolation;
  readonly hostState?: HostStateDescriptor;
  readonly prompt?: {
    actionPreamble?: boolean;
    bootstrapPlacement?: "before" | "after";
  };
  readonly structuredOutput: boolean;
  readonly executionModes?: string[];
  readonly configurationProfile?: ProducerConfigurationProfile;
  probe?(ctx: ProbeContext, deps: HostStoreContext): Promise<CapabilityReport>;
  buildInvocation?(
    spec: DelegationSpec,
    ctx: InvocationContext,
    deps: HostStoreContext,
  ): ProducerInvocation;
  normalizeEvents?(raw: { stdout: string; stderr: string; exit: SupervisedExit }): {
    events: AdapterEvent[];
    producerSummary: string | null;
    ok: boolean;
  };
}

/**
 * Probe hook body for a CLI Producer confined by the host OS backend: the
 * shared probe, with identity and auth taken from the descriptor.
 */
export function probeDescriptorCli(
  descriptor: ProducerDescriptor,
  ctx: ProbeContext,
  deps: HostStoreContext,
  options: Pick<OsConfinedCliProbe, "parseVersion" | "inspectSurface" | "writeConfinementBackend"> = {},
): Promise<CapabilityReport> {
  return probeOsConfinedCli(ctx, {
    ...options,
    producerId: descriptor.id,
    executableName: descriptor.executable.name,
    structuredOutput: descriptor.structuredOutput,
    isAuthenticated: () => isProducerAuthenticated(descriptor, deps),
  });
}

export class DescriptorAdapter implements ProducerAdapter {
  readonly producerId: string;
  readonly structuredOutput: boolean;
  readonly executionModes: string[];

  constructor(
    readonly descriptor: ProducerDescriptor,
    private readonly deps: HostStoreContext = {
      env: process.env,
      homeDirectory: homedir(),
    },
  ) {
    this.producerId = descriptor.id;
    this.structuredOutput = descriptor.structuredOutput;
    this.executionModes = descriptor.executionModes ? [...descriptor.executionModes] : ["edit"];
  }

  async probe(ctx: ProbeContext): Promise<CapabilityReport> {
    if (this.descriptor.probe) {
      return this.descriptor.probe(ctx, this.deps);
    }
    // Without a probe hook nothing proves write confinement, so the edit lane
    // stays closed (AGENTS.md: unproven eligibility is unavailable). The
    // executable is not resolved: nothing could act on it.
    return {
      ...unavailableCapabilityReport(
        ctx,
        this.producerId,
        this.structuredOutput,
        "probe-failed",
      ),
      authState: isProducerAuthenticated(this.descriptor, this.deps)
        ? "authenticated"
        : "unauthenticated",
      executionModes: [...this.executionModes],
    };
  }

  buildInvocation(spec: DelegationSpec, ctx: InvocationContext): ProducerInvocation {
    if (this.descriptor.buildInvocation) {
      return this.descriptor.buildInvocation(spec, ctx, this.deps);
    }
    return {
      executable: ctx.executable,
      args: [],
      stdin: renderProducerPrompt(spec, {
        readOnly: ctx.readOnly === true,
        ...this.descriptor.prompt,
      }),
      requiredEnv: [],
      network: "allowed",
    };
  }

  normalizeEvents(raw: { stdout: string; stderr: string; exit: SupervisedExit }): {
    events: AdapterEvent[];
    producerSummary: string | null;
    ok: boolean;
  } {
    if (this.descriptor.normalizeEvents) {
      return this.descriptor.normalizeEvents(raw);
    }
    return { events: [], producerSummary: null, ok: raw.exit.exitCode === 0 };
  }

  configurationProfile(): ProducerConfigurationProfile {
    if (this.descriptor.configurationProfile) {
      // A fresh copy per call: the descriptor's data is shared by every adapter.
      return structuredClone(this.descriptor.configurationProfile);
    }
    return {
      isolationState: this.descriptor.isolation,
      credentialSources: [],
      behavioralConfigSources: [],
      repositoryInstructionSources: [],
      environmentDependencies: [],
      temporaryHomeStrategy:
        this.descriptor.isolation === "inherited-config-only"
          ? "inherited-home"
          : "none",
    };
  }
}

export function detectEnvironmentType(
  readProcVersion: () => string = () => readFileSync("/proc/version", "utf8"),
): EnvironmentType {
  if (process.platform !== "linux") return "native";
  try {
    const version = readProcVersion().trim().toLowerCase();
    if (version.includes("microsoft")) return "wsl";
    return /^linux version(?:\s|$)/.test(version) ? "native" : "wsl";
  } catch {
    return "wsl";
  }
}

