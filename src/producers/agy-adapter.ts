import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { DelegationSpec } from "../protocol/delegation-spec.js";
import { probeOsConfinedCli } from "./cli-probe.js";
import { renderProducerPrompt } from "./plain-text.js";
import type {
  AdapterEvent,
  CapabilityReport,
  InvocationContext,
  ProbeContext,
  ProducerAdapter,
  ProducerConfigurationProfile,
  ProducerInvocation,
} from "./producer-adapter.js";

const AGY_REQUIRED_ENV = ["GEMINI_API_KEY"] as const;
const TEXT_LIMIT = 8_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringProperty(value: unknown, name: string): string | undefined {
  if (!isRecord(value)) return undefined;
  const property = value[name];
  return typeof property === "string" ? property : undefined;
}

/** Go time.ParseDuration accepts a bare seconds-magnitude unit; keep it simple. */
function formatPrintTimeout(timeoutMs: number): string {
  return `${Math.ceil(timeoutMs / 1000)}s`;
}

export interface AgyAdapterDeps {
  env: Record<string, string | undefined>;
  homeDirectory: string;
  hasAuthStore?: (directory: string) => boolean;
}

export class AgyAdapter implements ProducerAdapter {
  readonly producerId = "agy";
  readonly structuredOutput = true;
  readonly executionModes = ["edit"];

  constructor(private readonly deps: AgyAdapterDeps = {
    env: process.env,
    homeDirectory: homedir(),
  }) {}

  private hasAuthStore(directory: string): boolean {
    return (this.deps.hasAuthStore ?? (store => existsSync(join(store, "settings.json"))))(directory);
  }

  async probe(ctx: ProbeContext): Promise<CapabilityReport> {
    return probeOsConfinedCli(ctx, {
      producerId: this.producerId,
      executableName: "agy",
      structuredOutput: this.structuredOutput,
      isAuthenticated: () => this.hasAuthStore(this.configDirectory()),
    });
  }

  /** agy's settings/auth store; the only host state an attempt must write. */
  private configDirectory(): string {
    return join(this.deps.env.HOME ?? this.deps.homeDirectory, ".gemini", "antigravity-cli");
  }

  buildInvocation(spec: DelegationSpec, ctx: InvocationContext): ProducerInvocation {
    const args = [
      "-p",
      renderProducerPrompt(spec, ctx.readOnly === true),
      "--add-dir",
      ctx.worktreePath,
      "--new-project",
      "--output-format",
      "json",
      "--dangerously-skip-permissions",
      "--print-timeout",
      formatPrintTimeout(spec.timeoutMs),
    ];
    if (spec.producerOverrides?.model !== undefined) {
      args.push("--model", spec.producerOverrides.model);
    }
    if (spec.producerOverrides?.reasoningEffort !== undefined) {
      args.push("--effort", spec.producerOverrides.reasoningEffort);
    }

    return {
      executable: ctx.executable,
      args,
      requiredEnv: [...AGY_REQUIRED_ENV],
      inheritedStateWritablePaths: [this.configDirectory()],
      // Model sessions must reach the provider API; write-protection remains the confinement goal.
      network: "allowed",
    };
  }

  normalizeEvents(
    raw: Parameters<ProducerAdapter["normalizeEvents"]>[0],
  ): ReturnType<ProducerAdapter["normalizeEvents"]> {
    if (raw.exit.truncated.stdout) {
      return { events: [], producerSummary: null, ok: false };
    }
    if (raw.exit.exitCode !== 0) {
      return {
        events: [{ kind: "error", text: raw.stderr.slice(-TEXT_LIMIT) }],
        producerSummary: null,
        ok: false,
      };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.stdout.trim());
    } catch {
      return { events: [], producerSummary: null, ok: false };
    }
    if (!isRecord(parsed) || typeof parsed.status !== "string") {
      return { events: [], producerSummary: null, ok: false };
    }

    const response = stringProperty(parsed, "response");
    const ok = parsed.status === "SUCCESS";
    if (ok) {
      if (response === undefined) return { events: [], producerSummary: null, ok: false };
      const events: AdapterEvent[] = [{ kind: "final", text: response, raw: parsed }];
      return { events, producerSummary: response, ok: true };
    }
    const events: AdapterEvent[] = [{
      kind: "error",
      ...(response === undefined ? {} : { text: response }),
      raw: parsed,
    }];
    return { events, producerSummary: null, ok: false };
  }

  configurationProfile(): ProducerConfigurationProfile {
    return {
      isolationState: "inherited-config-only",
      credentialSources: [
        "macOS Keychain (\"Antigravity IDE Safe Storage\")",
        "GEMINI_API_KEY (optional, unconfirmed CI semantics)",
      ],
      behavioralConfigSources: ["~/.gemini/antigravity-cli/settings.json", "explicit invocation argv"],
      repositoryInstructionSources: ["worktree AGENTS.md"],
      environmentDependencies: [...AGY_REQUIRED_ENV],
      temporaryHomeStrategy:
        "real HOME inherited by declared policy (keyring auth is not HOME-redirectable); reduced reproducibility recorded in the Run Manifest",
    };
  }
}
