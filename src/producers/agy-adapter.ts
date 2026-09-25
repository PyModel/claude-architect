import { homedir } from "node:os";
import { join } from "node:path";
import type { DelegationSpec } from "../protocol/delegation-spec.js";
import { probeOsConfinedCli } from "./cli-probe.js";
import {
  isProducerAuthenticated,
  isRecord,
  resolveInheritedWritablePaths,
  stringProperty,
  type HostStoreContext,
} from "./host-store.js";
import { renderProducerPrompt } from "./plain-text.js";
import type {
  AdapterEvent,
  CapabilityReport,
  InvocationContext,
  ProbeContext,
  ProducerAdapter,
  ProducerConfigurationProfile,
  ProducerDescriptor,
  ProducerInvocation,
} from "./producer-adapter.js";

const AGY_REQUIRED_ENV = ["GEMINI_API_KEY"] as const;
const TEXT_LIMIT = 8_000;

function formatPrintTimeout(timeoutMs: number): string {
  return `${Math.ceil(timeoutMs / 1000)}s`;
}

export const agyDescriptor: ProducerDescriptor = {
  id: "agy",
  executable: { name: "agy" },
  isolation: "inherited-config-only",
  hostState: {
    resolveStore: deps => {
      const home = deps.env.HOME ?? deps.env.USERPROFILE ?? deps.homeDirectory;
      return join(home, ".gemini", "antigravity-cli");
    },
    authMarker: "settings.json",
    inheritedWritablePaths: store => [store],
    apiKeyEnv: ["GEMINI_API_KEY"],
  },
  prompt: {
    actionPreamble: true,
    bootstrapPlacement: "before",
  },
  structuredOutput: true,
  executionModes: ["edit"],
};

export interface AgyAdapterDeps extends HostStoreContext {}

export class AgyAdapter implements ProducerAdapter {
  readonly producerId = agyDescriptor.id;
  readonly structuredOutput = agyDescriptor.structuredOutput!;
  readonly executionModes = agyDescriptor.executionModes!;
  readonly descriptor = agyDescriptor;

  constructor(private readonly deps: AgyAdapterDeps = {
    env: process.env,
    homeDirectory: homedir(),
  }) {}

  async probe(ctx: ProbeContext): Promise<CapabilityReport> {
    return probeOsConfinedCli(ctx, {
      producerId: this.producerId,
      executableName: "agy",
      structuredOutput: this.structuredOutput,
      isAuthenticated: () => isProducerAuthenticated(agyDescriptor, this.deps),
    });
  }

  buildInvocation(spec: DelegationSpec, ctx: InvocationContext): ProducerInvocation {
    const args = [
      "-p",
      renderProducerPrompt(spec, {
        readOnly: ctx.readOnly === true,
        ...agyDescriptor.prompt,
      }),
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
      inheritedStateWritablePaths: resolveInheritedWritablePaths(agyDescriptor, this.deps),
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
