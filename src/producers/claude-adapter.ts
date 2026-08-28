import { existsSync, readFileSync } from "node:fs";
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

// USER: the CLI resolves its OAuth credential through the login keychain, which
// it looks up by user name — without it a logged-in host reports "Not logged in".
// CLAUDE_CONFIG_DIR: relocated config/auth store must reach the process, or the
// adapter would report auth state from one directory while the CLI read another.
// ANTHROPIC_API_KEY: the API-key auth path, forwarded by declared policy exactly
// as the Pi and agy lanes forward theirs.
const CLAUDE_REQUIRED_ENV = ["USER", "CLAUDE_CONFIG_DIR", "ANTHROPIC_API_KEY"] as const;
const EDIT_TOOLS = "Read,Edit,Write,Bash,Grep,Glob";
const READ_ONLY_TOOLS = "Read,Grep,Glob";
const EFFORT_LEVELS = new Set(["low", "medium", "high", "xhigh", "max"]);
const TEXT_LIMIT = 8_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Claude Code emits `--version` as `<semver> (Claude Code)`. */
function parseVersion(stdout: string): string | null {
  return /^(\d+\.\d+\.\d+(?:[-+][^\s]+)?)\b/u.exec(stdout.trim())?.[1] ?? null;
}

/** stderr warnings can precede the envelope when both land on one stream. */
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

export interface ClaudeAdapterDeps {
  env: Record<string, string | undefined>;
  homeDirectory: string;
  /** Whether the account file at the given path records a logged-in OAuth account. */
  hasOauthAccount?: (accountFile: string) => boolean;
}

function defaultHasOauthAccount(accountFile: string): boolean {
  if (!existsSync(accountFile)) return false;
  try {
    const parsed: unknown = JSON.parse(readFileSync(accountFile, "utf8"));
    return isRecord(parsed) && isRecord(parsed.oauthAccount);
  } catch {
    return false;
  }
}

export class ClaudeAdapter implements ProducerAdapter {
  readonly producerId = "claude";
  readonly structuredOutput = true;
  readonly executionModes = ["edit"];

  constructor(private readonly deps: ClaudeAdapterDeps = {
    env: process.env,
    homeDirectory: homedir(),
  }) {}

  /** `~/.claude` (or CLAUDE_CONFIG_DIR): settings, sessions, and local state. */
  private configDirectory(): string {
    const configured = this.deps.env.CLAUDE_CONFIG_DIR;
    if (configured !== undefined && configured.length > 0) return configured;
    return join(this.deps.env.HOME ?? this.deps.homeDirectory, ".claude");
  }

  /** `~/.claude.json`: the account record the CLI rewrites on every run. */
  private accountFile(): string {
    const configured = this.deps.env.CLAUDE_CONFIG_DIR;
    if (configured !== undefined && configured.length > 0) return join(configured, ".claude.json");
    return join(this.deps.env.HOME ?? this.deps.homeDirectory, ".claude.json");
  }

  private isAuthenticated(): boolean {
    const apiKey = this.deps.env.ANTHROPIC_API_KEY;
    if (apiKey !== undefined && apiKey.length > 0) return true;
    return (this.deps.hasOauthAccount ?? defaultHasOauthAccount)(this.accountFile());
  }

  async probe(ctx: ProbeContext): Promise<CapabilityReport> {
    return probeOsConfinedCli(ctx, {
      producerId: this.producerId,
      executableName: "claude",
      structuredOutput: this.structuredOutput,
      parseVersion,
      isAuthenticated: () => this.isAuthenticated(),
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
      // Fresh context per attempt is a trust invariant: nothing is resumable.
      "--no-session-persistence",
      // No MCP servers at all — in particular not this plugin's own runtime,
      // which would otherwise hand the Producer a nested `delegate` tool.
      "--strict-mcp-config",
      // Skip user, project, and local settings: their hooks and permission
      // grants are host-side behavior that must not run inside an attempt.
      "--setting-sources",
      "",
      "--disable-slash-commands",
      // Write confinement is the host Seatbelt profile, not the permission prompt.
      "--dangerously-skip-permissions",
      // Built-ins only: no Agent (no nested subagents), no web, no artifacts.
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
      stdin: renderProducerPrompt(spec, readOnly),
      requiredEnv: [...CLAUDE_REQUIRED_ENV],
      inheritedStateWritablePaths: [this.configDirectory(), this.accountFile()],
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
      // `--setting-sources ""` also turns off CLAUDE.md/AGENTS.md discovery
      // (confirmed live): the Producer sees only the rendered spec.
      repositoryInstructionSources: [],
      environmentDependencies: [...CLAUDE_REQUIRED_ENV],
      temporaryHomeStrategy:
        "real HOME inherited by declared policy (OAuth state in ~/.claude.json is not HOME-redirectable); reduced reproducibility recorded in the Run Manifest",
    };
  }
}
