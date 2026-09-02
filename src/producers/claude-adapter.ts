import { homedir } from "node:os";
import { join } from "node:path";
import type { DelegationSpec } from "../protocol/delegation-spec.js";
import type { ResolvedExecutable } from "../platform/platform-services.js";
import { parseSemver, probeOsConfinedCli, runVersionProbe } from "./cli-probe.js";
import {
  defaultHasOauthAccount,
  isProducerAuthenticated,
  isRecord,
  resolveInheritedWritablePaths,
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

const CLAUDE_REQUIRED_ENV = ["USER", "CLAUDE_CONFIG_DIR", "ANTHROPIC_API_KEY"] as const;
const EDIT_TOOLS = "Read,Edit,Write,Bash,Grep,Glob";
const READ_ONLY_TOOLS = "Read,Grep,Glob";
const EFFORT_LEVELS = new Set(["low", "medium", "high", "xhigh", "max"]);
const TEXT_LIMIT = 8_000;

function parseVersion(stdout: string): string | null {
  return /^(\d+\.\d+\.\d+(?:[-+][^\s]+)?)\b/u.exec(stdout.trim())?.[1] ?? null;
}

function parseEnvelope(stdout: string): Record<string, unknown> | null {
  const trimmed = stdout.trim();
  const start = trimmed.indexOf("{");
  if (start < 0) return null;
  try {
    const parsed: unknown = JSON.parse(trimmed.slice(start));
    return isRecord(parsed) && parsed.type === "result" ? parsed : null;
  } catch {
    return null;
  }
}

function resolveClaudeAccountFile(deps: HostStoreContext): string {
  const configured = deps.env.CLAUDE_CONFIG_DIR;
  if (configured !== undefined && configured.length > 0) {
    return join(configured, ".claude.json");
  }
  const home = deps.env.HOME ?? deps.env.USERPROFILE ?? deps.homeDirectory;
  return join(home, ".claude.json");
}

export const claudeDescriptor: ProducerDescriptor = {
  id: "claude",
  executable: { name: "claude" },
  isolation: "inherited-config-only",
  hostState: {
    resolveStore: deps => {
      const configured = deps.env.CLAUDE_CONFIG_DIR;
      if (configured !== undefined && configured.length > 0) return configured;
      const home = deps.env.HOME ?? deps.env.USERPROFILE ?? deps.homeDirectory;
      return join(home, ".claude");
    },
    authMarker: (_store, deps) => {
      const apiKey = deps.env.ANTHROPIC_API_KEY;
      if (apiKey !== undefined && apiKey.length > 0) return true;
      const accountFile = resolveClaudeAccountFile(deps);
      return (deps.hasOauthAccount ?? defaultHasOauthAccount)(accountFile);
    },
    inheritedWritablePaths: (store, deps) => [store, resolveClaudeAccountFile(deps)],
    apiKeyEnv: ["ANTHROPIC_API_KEY"],
  },
  prompt: {
    actionPreamble: true,
    bootstrapPlacement: "before",
  },
  structuredOutput: true,
  executionModes: ["edit"],
};

export interface ClaudeAdapterDeps extends HostStoreContext {}

const REQUIRED_CLAUDE_FLAGS = [
  "--no-session-persistence",
  "--strict-mcp-config",
  "--setting-sources",
] as const;

export class ClaudeAdapter implements ProducerAdapter {
  readonly producerId = claudeDescriptor.id;
  readonly structuredOutput = claudeDescriptor.structuredOutput!;
  readonly executionModes = claudeDescriptor.executionModes!;
  readonly descriptor = claudeDescriptor;

  constructor(private readonly deps: ClaudeAdapterDeps = {
    env: process.env,
    homeDirectory: homedir(),
  }) {}

  private async inspectCliSurface(
    ctx: ProbeContext,
    executable: ResolvedExecutable,
  ): Promise<string | null> {
    let helpResult;
    try {
      helpResult = await runVersionProbe(ctx, executable, ["--help"]);
    } catch {
      return "unsupported-cli-surface";
    }
    if (helpResult.spawnError !== undefined || helpResult.exitCode !== 0) {
      return "unsupported-cli-surface";
    }
    const helpOutput = `${helpResult.stdout}\n${helpResult.stderr}`;
    for (const flag of REQUIRED_CLAUDE_FLAGS) {
      if (!helpOutput.includes(flag)) {
        return "unsupported-cli-surface";
      }
    }
    return null;
  }

  async probe(ctx: ProbeContext): Promise<CapabilityReport> {
    return probeOsConfinedCli(ctx, {
      producerId: this.producerId,
      executableName: "claude",
      structuredOutput: this.structuredOutput,
      parseVersion,
      inspectSurface: (probeCtx, executable) => this.inspectCliSurface(probeCtx, executable),
      isAuthenticated: () => isProducerAuthenticated(claudeDescriptor, this.deps),
    });
  }

  buildInvocation(spec: DelegationSpec, ctx: InvocationContext): ProducerInvocation {
    const effort = spec.producerOverrides?.reasoningEffort;
    if (effort !== undefined && !EFFORT_LEVELS.has(effort)) {
      throw new Error(
        `Claude effort override ${JSON.stringify(effort)} is unsupported; use one of ${[...EFFORT_LEVELS].join("|")}.`,
      );
    }
    const readOnly = ctx.readOnly === true;
    const args = [
      "-p",
      "--output-format",
      "json",
      "--no-session-persistence",
      "--strict-mcp-config",
      "--setting-sources",
      "",
      "--disable-slash-commands",
      "--dangerously-skip-permissions",
      "--tools",
      readOnly ? READ_ONLY_TOOLS : EDIT_TOOLS,
    ];
    if (spec.producerOverrides?.model !== undefined) {
      args.push("--model", spec.producerOverrides.model);
    }
    if (effort !== undefined) {
      args.push("--effort", effort);
    }

    return {
      executable: ctx.executable,
      args,
      stdin: renderProducerPrompt(spec, {
        readOnly,
        ...claudeDescriptor.prompt,
      }),
      requiredEnv: [...CLAUDE_REQUIRED_ENV],
      inheritedStateWritablePaths: resolveInheritedWritablePaths(claudeDescriptor, this.deps),
      network: "allowed",
    };
  }

  normalizeEvents(
    raw: Parameters<ProducerAdapter["normalizeEvents"]>[0],
  ): ReturnType<ProducerAdapter["normalizeEvents"]> {
    if (raw.exit.truncated.stdout) {
      return { events: [], producerSummary: null, ok: false };
    }
    const envelope = parseEnvelope(raw.stdout);
    if (envelope === null) {
      return {
        events: [{ kind: "error", text: raw.stderr.slice(-TEXT_LIMIT) }],
        producerSummary: null,
        ok: false,
      };
    }
    const result = typeof envelope.result === "string" ? envelope.result : undefined;
    const ok = raw.exit.exitCode === 0
      && envelope.is_error === false
      && envelope.subtype === "success"
      && result !== undefined;
    if (ok) {
      const events: AdapterEvent[] = [{ kind: "final", text: result, raw: envelope }];
      return { events, producerSummary: result, ok: true };
    }
    const events: AdapterEvent[] = [{
      kind: "error",
      ...(result === undefined ? {} : { text: result.slice(-TEXT_LIMIT) }),
      raw: envelope,
    }];
    return { events, producerSummary: null, ok: false };
  }

  configurationProfile(): ProducerConfigurationProfile {
    return {
      isolationState: "inherited-config-only",
      credentialSources: [
        "~/.claude.json oauthAccount + macOS login keychain (\"Claude Code-credentials\")",
        "ANTHROPIC_API_KEY (optional)",
      ],
      behavioralConfigSources: [
        "explicit invocation argv (user/project/local settings, hooks, MCP servers, and skills are all disabled)",
      ],
      repositoryInstructionSources: [],
      environmentDependencies: [...CLAUDE_REQUIRED_ENV],
      temporaryHomeStrategy:
        "real HOME inherited by declared policy (OAuth state in ~/.claude.json is not HOME-redirectable); reduced reproducibility recorded in the Run Manifest",
    };
  }
}
