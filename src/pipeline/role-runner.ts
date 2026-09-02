import { rm } from "node:fs/promises";
import type { PlatformServices, SupervisedExit } from "../platform/platform-services.js";
import { selectSandboxBackend } from "../platform/sandbox/backends.js";
import { selectOsWriteConfinementBackend } from "../producers/plain-text.js";
import {
  classifyFailure,
  type FailureClassification,
  type FailureSignals,
} from "../protocol/attempt-result.js";
import type { DelegationSpec } from "../protocol/delegation-spec.js";
import { probeAll } from "../producers/capability-probe.js";
import { detectEnvironmentType } from "../producers/producer-adapter.js";
import type { ProducerRegistry } from "../producers/producer-registry.js";
import { ProducerRuntime, producerRuntime } from "../producers/producer-runtime.js";
import { route } from "../producers/routing-policy.js";
import { type BuiltEnvironment } from "../runtime/environment-policy.js";
import { redact } from "../runtime/redaction.js";
import type { RunStartContext } from "../runtime/run-start.js";
import {
  buildRoleSpec,
  type PipelineRole,
  type RolePackage,
} from "./role-prompts.js";
import { resolveLinkedWorktreeWritableRoots } from "./git-writable-roots.js";
import type { LinkedWorktreeGitAccess } from "./git-writable-roots.js";

export interface RoleRunArgs {
  role: PipelineRole;
  baseSpec: DelegationSpec;
  pkg: RolePackage;
  worktreePath: string;
  ps: PlatformServices;
  registry: ProducerRegistry;
  runId: string;
  runStart?: RunStartContext;
  env?: Record<string, string | undefined>;
  gitObjectAccess?: LinkedWorktreeGitAccess;
  abortSignal?: AbortSignal;
}

export interface RoleRunResult {
  ok: boolean;
  rawOutput: string;
  archiveSafeRawOutput?: string;
  failure: FailureClassification | null;
  producerId: string | null;
}

export const READ_ONLY_ROLES: ReadonlySet<PipelineRole> = new Set<PipelineRole>([
  "reviewer-correctness",
  "reviewer-systems",
  "verifier",
  "advisor",
]);
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

function definedEnvironment(
  environment: Record<string, string | undefined> | undefined,
): Record<string, string> {
  const additions: Record<string, string> = {};
  for (const [name, value] of Object.entries(environment ?? {})) {
    if (value === undefined) continue;
    Object.defineProperty(additions, name, {
      value,
      writable: true,
      enumerable: true,
      configurable: true,
    });
  }
  return additions;
}

function failureSignals(exit: SupervisedExit): FailureSignals {
  const signals: FailureSignals = {};
  if (exit.spawnError !== undefined) signals["spawn-failure"] = true;
  if (exit.cancelled) signals.cancelled = true;
  if (exit.timedOut) signals.timeout = true;
  return signals;
}

function hasFailureSignal(signals: FailureSignals): boolean {
  return Object.values(signals).some(Boolean);
}

async function cleanupProcessAttempt(
  tempHome: string | null,
  builtEnvironment: BuiltEnvironment | null,
): Promise<unknown | null> {
  const failures: unknown[] = [];
  try {
    builtEnvironment?.secretRegistration.dispose();
  } catch (error) {
    failures.push(error);
  }
  if (tempHome !== null) {
    try {
      await rm(tempHome, { recursive: true, force: true });
    } catch (error) {
      failures.push(error);
    }
  }
  return failures[0] ?? null;
}

export async function runRole(args: RoleRunArgs): Promise<RoleRunResult> {
  const roleSpec = buildRoleSpec(args.role, args.baseSpec, args.pkg);
  const reports = await probeAll({
    ps: args.ps,
    os: args.ps.os,
    arch: process.arch,
    environmentType: detectEnvironmentType(),
  }, args.registry);
  const routing = route(roleSpec.producerPreferences, reports);
  if (routing.producerId === null) {
    return {
      ok: false,
      rawOutput: "",
      failure: routing.reason === "authentication-required"
        ? "authentication-required"
        : "unavailable",
      producerId: null,
    };
  }

  const producerId = routing.producerId;
  const adapter = args.registry.get(producerId);
  const report = reports.find(candidate => candidate.producerId === producerId);
  if (adapter === undefined || report === undefined || report.resolvedExecutable === null) {
    return {
      ok: false,
      rawOutput: "",
      failure: "unavailable",
      producerId,
    };
  }

  const readOnly = READ_ONLY_ROLES.has(args.role);
  const writer = args.role === "fixer" || args.role === "implementer";
  let extraWritableRoots: string[] = [];
  let gitObjectAccess: LinkedWorktreeGitAccess | undefined;
  if (writer) {
    try {
      gitObjectAccess = await resolveLinkedWorktreeWritableRoots(args.worktreePath);
      extraWritableRoots = gitObjectAccess.writableRoots;
    } catch {
      return {
        ok: false,
        rawOutput: "",
        failure: "sandbox-violation",
        producerId,
      };
    }
  }
  // Producers with a native sandbox (Codex) must confine read-only roles
  // themselves: wrapping them in an outer Seatbelt profile EPERM-crashes their
  // internal sandbox init. Producers without one get the HOST's read-only
  // Seatbelt wrap, so that path's availability is a host property.
  const nativeReadOnly = readOnly
    && selectSandboxBackend(report).backend?.kind === "producer-native";
  const writerBackend = writer ? selectSandboxBackend(report).backend : null;
  const seatbeltWriter = writerBackend?.kind === "os"
    && writerBackend.id === "macos-seatbelt";
  if (writer && (writerBackend === null
    || (writerBackend.kind === "os" && !seatbeltWriter))) {
    return {
      ok: false,
      rawOutput: "",
      failure: "sandbox-violation",
      producerId,
    };
  }
  if (readOnly && !nativeReadOnly) {
    const osBackend = selectOsWriteConfinementBackend({
      ps: args.ps,
      os: args.ps.os,
      arch: process.arch,
      environmentType: detectEnvironmentType(),
    });
    if (osBackend === null) {
      return {
        ok: false,
        rawOutput: "",
        failure: "sandbox-violation",
        producerId,
      };
    }
  }
  const runStart = args.runStart;
  if (writer && runStart === undefined) {
    return {
      ok: false,
      rawOutput: "",
      failure: "spawn-failure",
      producerId,
    };
  }

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    let tempHome: string | null = null;
    let builtEnvironment: BuiltEnvironment | null = null;
    let primaryError: unknown;
    try {
      const runtime = args.registry !== undefined
        ? new ProducerRuntime(args.registry)
        : producerRuntime;
      const launchResult = await runtime.launch({
        producerId,
        spec: roleSpec,
        worktreePath: args.worktreePath,
        intent: readOnly ? "read-only" : "edit",
        ps: args.ps,
        runId: args.runId,
        abortSignal: args.abortSignal,
        timeoutMs: roleSpec.timeoutMs,
        extraWritableRoots: extraWritableRoots.length > 0 ? extraWritableRoots : undefined,
        gitObjectAccess,
        envAdditions: args.env !== undefined ? definedEnvironment(args.env) : undefined,
        runStartContext: writer && runStart !== undefined ? runStart : undefined,
        capabilityReport: report,
      });
      tempHome = launchResult.tempHome;
      builtEnvironment = launchResult.builtEnvironment;
      const exit = launchResult.exit;

      const signals = failureSignals(exit);
      let rawOutput = exit.stdout;
      if (!hasFailureSignal(signals)) {
        const normalized = adapter.normalizeEvents({
          stdout: exit.stdout,
          stderr: exit.stderr,
          exit,
        });
        rawOutput = normalized.producerSummary ?? exit.stdout;
        if (!normalized.ok) signals["invalid-output"] = true;
        if (exit.exitCode !== 0) signals["producer-failure"] = true;
      }

      const failure = classifyFailure(signals);
      const archiveSafeRawOutput = rawOutput === ""
        ? {}
        : { archiveSafeRawOutput: redact(rawOutput) };
      if (failure === null) {
        return { ok: true, rawOutput, ...archiveSafeRawOutput, failure: null, producerId };
      }
      if (exit.cancelled || attempt === 2) {
        return { ok: false, rawOutput, ...archiveSafeRawOutput, failure, producerId };
      }
    } catch (error) {
      primaryError = error;
      throw error;
    } finally {
      const cleanupError = await cleanupProcessAttempt(tempHome, builtEnvironment);
      if (primaryError === undefined && cleanupError !== null) throw cleanupError;
    }
  }

  throw new Error("unreachable role attempt state");
}
