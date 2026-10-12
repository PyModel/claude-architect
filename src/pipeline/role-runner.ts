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
import { ProducerRuntime } from "../producers/producer-runtime.js";
import { route } from "../producers/routing-policy.js";
import { type BuiltEnvironment } from "../runtime/environment-policy.js";
import { redact } from "../runtime/redaction.js";
import type { RunStartContext } from "../runtime/run-start.js";
import type { ProducerHomeLease, ProducerHomeRetirement } from "../runtime/producer-home.js";
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
  /**
   * A runtime-allocated HOME that could not be retired was preserved; this is
   * its bounded, redacted diagnostic. The primary outcome is kept beside it.
   */
  cleanupFailure?: string;
}

export const READ_ONLY_ROLES: ReadonlySet<PipelineRole> = new Set<PipelineRole>([
  "reviewer-correctness",
  "reviewer-systems",
  "verifier",
  "advisor",
]);


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
  home: ProducerHomeLease | null,
  builtEnvironment: BuiltEnvironment | null,
): Promise<{ error: unknown | null; home: ProducerHomeRetirement | null }> {
  // Identity-bound retirement after the supervised tree settled; it never
  // throws and never deletes by name. It runs while the launch's secrets are
  // still registered, so its diagnostic is redacted against them.
  const retirement = home === null ? null : await home.retire();
  let failure: unknown | null = null;
  try {
    builtEnvironment?.secretRegistration.dispose();
  } catch (error) {
    failure = error;
  }
  return { error: failure, home: retirement === null || retirement.ok ? null : retirement };
}

function withCleanupFailure(result: RoleRunResult, failures: string[]): RoleRunResult {
  return failures.length === 0 ? result : { ...result, cleanupFailure: failures.join("; ") };
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

  const cleanupFailures: string[] = [];
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    let home: ProducerHomeLease | null = null;
    let builtEnvironment: BuiltEnvironment | null = null;
    let primaryError: unknown;
    let outcome: RoleRunResult | null = null;
    let homeConflict = false;
    try {
      const runtime = new ProducerRuntime(args.registry);
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
      home = launchResult.home;
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
        outcome = { ok: true, rawOutput, ...archiveSafeRawOutput, failure: null, producerId };
      } else if (exit.cancelled || attempt === 2) {
        outcome = { ok: false, rawOutput, ...archiveSafeRawOutput, failure, producerId };
      } else {
        // Retried below; its output is not the outcome.
        outcome = null;
      }
    } catch (error) {
      primaryError = error;
      throw error;
    } finally {
      const cleanup = await cleanupProcessAttempt(home, builtEnvironment);
      if (cleanup.home !== null) cleanupFailures.push(cleanup.home.diagnostic ?? "Producer HOME preserved");
      if (primaryError !== undefined && cleanupFailures.length > 0
        && typeof primaryError === "object" && primaryError !== null) {
        // The thrown error is the outcome now; earlier attempts' preserved
        // HOMEs ride on it rather than vanishing with the result.
        const carried = (primaryError as { producerHomeFailure?: unknown }).producerHomeFailure;
        Object.assign(primaryError, {
          producerHomeFailure: [...cleanupFailures, ...(typeof carried === "string" ? [carried] : [])].join("; "),
        });
      }
      if (primaryError === undefined && cleanup.error !== null) throw cleanup.error;
      homeConflict = cleanup.home?.conflict === true;
    }
    if (homeConflict) {
      // The Producer acted on its own allocation from outside it (moved or
      // replaced the HOME). Its output is kept for the log, but the role fails
      // closed: nothing it reported can be trusted.
      return withCleanupFailure({
        ...(outcome ?? { rawOutput: "", producerId }),
        ok: false,
        failure: "sandbox-violation",
      }, cleanupFailures);
    }
    if (outcome !== null) return withCleanupFailure(outcome, cleanupFailures);
  }

  throw new Error("unreachable role attempt state");
}
