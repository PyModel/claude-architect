import { supervise } from "../platform/process-supervisor.js";
import type { ResolvedExecutable, SupervisedExit } from "../platform/platform-services.js";
import { SANDBOX_BACKENDS } from "../platform/sandbox/backends.js";
import { normalizeNodeShim, selectOsWriteConfinementBackend } from "./plain-text.js";
import type { CapabilityReport, ProbeContext } from "./producer-adapter.js";

const VERSION_TIMEOUT_MS = 10_000;
const VERSION_OUTPUT_LIMIT = 64 * 1024;

/**
 * Probe contract for a CLI Producer whose write confinement is supplied by the
 * host OS backend (macOS Seatbelt) or a dedicated backend (Codex sandbox).
 */
export interface OsConfinedCliProbe {
  producerId: string;
  executableName: string;
  structuredOutput: boolean;
  writeConfinementBackend?: string | ((ctx: ProbeContext) => string | null);
  parseVersion?: (stdout: string) => string | null;
  /**
   * Extra surface checks after the version succeeds; return an unavailability
   * reason to fail the probe, or null to continue.
   */
  inspectSurface?: (ctx: ProbeContext, executable: ResolvedExecutable) => Promise<string | null>;
  isAuthenticated: () => boolean;
}

export function parseSemver(stdout: string): string | null {
  const match = /(?:^|\s)(\d+\.\d+\.\d+(?:[-+][^\s]+)?)(?:\s|$)/u.exec(stdout.trim());
  return match?.[1] ?? null;
}

export function selectConfinementBackend(ctx: ProbeContext, backendId: string): string | null {
  const backend = SANDBOX_BACKENDS.find(candidate =>
    candidate.id === backendId
    && candidate.platforms.some(platform =>
      platform.os === ctx.os
      && platform.environmentType === ctx.environmentType
      && (platform.arch === undefined || platform.arch === ctx.arch)
      && (platform.state === "certified" || platform.state === "tested")));
  return backend?.id ?? null;
}

export function unavailableCapabilityReport(
  ctx: ProbeContext,
  producerId: string,
  structuredOutput: boolean,
  reason: string,
  resolvedExecutable: ResolvedExecutable | null = null,
): CapabilityReport {
  return {
    producerId,
    available: false,
    reason,
    os: ctx.os,
    arch: ctx.arch,
    environmentType: ctx.environmentType,
    resolvedExecutable,
    version: null,
    authState: "unknown",
    executionModes: ["edit"],
    structuredOutput,
    writeConfinementBackend: null,
    laneEligibility: { edit: false },
  };
}

export async function runVersionProbe(
  ctx: ProbeContext,
  executable: ResolvedExecutable,
  args: string[],
): Promise<SupervisedExit> {
  return supervise(ctx.ps, {
    executable,
    args,
    cwd: process.cwd(),
    env: {},
    timeoutMs: VERSION_TIMEOUT_MS,
    maxOutputBytes: VERSION_OUTPUT_LIMIT,
  }, {});
}

/**
 * Shared probe: unsupported on win32; resolve the executable; require a
 * parseable `--version` with abnormal-termination guards (signal, timeout,
 * cancelled); optionally inspect the CLI surface; then report edit
 * eligibility honestly from the confinement backend and auth state.
 */
export async function probeOsConfinedCli(
  ctx: ProbeContext,
  probe: OsConfinedCliProbe,
): Promise<CapabilityReport> {
  const unavailable = (reason: string, executable: ResolvedExecutable | null = null) =>
    unavailableCapabilityReport(ctx, probe.producerId, probe.structuredOutput, reason, executable);
  if (ctx.os === "win32") return unavailable("unsupported-platform");

  let executable: ResolvedExecutable;
  try {
    executable = await normalizeNodeShim(
      await ctx.ps.resolveExecutable({ name: probe.executableName }),
    );
  } catch {
    return unavailable("missing-executable");
  }

  try {
    const result = await runVersionProbe(ctx, executable, ["--version"]);
    const isCleanExit = result.spawnError === undefined
      && result.exitCode === 0
      && result.signal === null
      && result.timedOut === false
      && result.cancelled === false;
    const version = isCleanExit
      ? (probe.parseVersion ?? parseSemver)(result.stdout)
      : null;
    if (version === null) return unavailable("probe-failed", executable);

    if (probe.inspectSurface !== undefined) {
      const reason = await probe.inspectSurface(ctx, executable);
      if (reason !== null) return unavailable(reason, executable);
    }

    const writeConfinementBackend = typeof probe.writeConfinementBackend === "function"
      ? probe.writeConfinementBackend(ctx)
      : typeof probe.writeConfinementBackend === "string"
        ? selectConfinementBackend(ctx, probe.writeConfinementBackend)
        : selectOsWriteConfinementBackend(ctx);
    return {
      producerId: probe.producerId,
      available: true,
      reason: null,
      os: ctx.os,
      arch: ctx.arch,
      environmentType: ctx.environmentType,
      resolvedExecutable: executable,
      version,
      authState: probe.isAuthenticated() ? "authenticated" : "unauthenticated",
      executionModes: ["edit"],
      structuredOutput: probe.structuredOutput,
      writeConfinementBackend,
      laneEligibility: { edit: writeConfinementBackend !== null },
    };
  } catch {
    return unavailable("probe-failed", executable);
  }
}

export { probeOsConfinedCli as probeCli };

