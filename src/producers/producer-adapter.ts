import { readFileSync } from "node:fs";
import type {
  PlatformServices,
  ResolvedExecutable,
  SupervisedExit,
} from "../platform/platform-services.js";
import type { DelegationSpec } from "../protocol/delegation-spec.js";

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
