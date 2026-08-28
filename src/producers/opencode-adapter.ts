import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { DelegationSpec } from "../protocol/delegation-spec.js";
import { probeOsConfinedCli } from "./cli-probe.js";
import { normalizePlainText, renderProducerPrompt } from "./plain-text.js";
import type {
  CapabilityReport,
  InvocationContext,
  ProbeContext,
  ProducerAdapter,
  ProducerConfigurationProfile,
  ProducerInvocation,
} from "./producer-adapter.js";

const OPENCODE_REQUIRED_ENV = ["OPENCODE_CONFIG_DIR", "XDG_DATA_HOME"] as const;

export interface OpenCodeAdapterDeps {
  env: Record<string, string | undefined>;
  homeDirectory: string;
  hasAuthStore?: (directory: string) => boolean;
}

function defaultOpenCodeEnv(
  deps: Required<Pick<OpenCodeAdapterDeps, "env" | "homeDirectory" | "hasAuthStore">>,
): Record<string, string> {
  if (deps.env.XDG_DATA_HOME !== undefined) return {};
  const dataHome = join(deps.homeDirectory, ".local", "share");
  return deps.hasAuthStore(join(dataHome, "opencode"))
    ? { XDG_DATA_HOME: dataHome }
    : {};
}

export class OpenCodeAdapter implements ProducerAdapter {
  readonly producerId = "opencode";
  readonly structuredOutput = false;
  readonly executionModes = ["edit"];

  constructor(private readonly deps: OpenCodeAdapterDeps = {
    env: process.env,
    homeDirectory: homedir(),
  }) {}

  private hasAuthStore(directory: string): boolean {
    return (this.deps.hasAuthStore ?? (store => existsSync(join(store, "auth.json"))))(directory);
  }

  async probe(ctx: ProbeContext): Promise<CapabilityReport> {
    return probeOsConfinedCli(ctx, {
      producerId: this.producerId,
      executableName: "opencode",
      structuredOutput: this.structuredOutput,
      isAuthenticated: () =>
        this.hasAuthStore(join(this.deps.homeDirectory, ".local", "share", "opencode")),
    });
  }

  /** OpenCode's XDG data (auth) and state directories, honoring host overrides. */
  private stateDirectories(): string[] {
    const dataHome = this.deps.env.XDG_DATA_HOME
      ?? join(this.deps.homeDirectory, ".local", "share");
    const stateHome = this.deps.env.XDG_STATE_HOME
      ?? join(this.deps.homeDirectory, ".local", "state");
    return [join(dataHome, "opencode"), join(stateHome, "opencode")];
  }

  buildInvocation(spec: DelegationSpec, ctx: InvocationContext): ProducerInvocation {
    const args = [
      "run",
      "--dir",
      ctx.worktreePath,
      "--agent",
      "build",
      "--auto",
      "--log-level",
      "ERROR",
    ];
    if (spec.producerOverrides?.model !== undefined) {
      args.push("--model", spec.producerOverrides.model);
    }

    return {
      executable: ctx.executable,
      args,
      stdin: renderProducerPrompt(spec, ctx.readOnly === true),
      requiredEnv: [...OPENCODE_REQUIRED_ENV],
      inheritedStateWritablePaths: this.stateDirectories(),
      env: defaultOpenCodeEnv({
        env: this.deps.env,
        homeDirectory: this.deps.homeDirectory,
        hasAuthStore: directory => this.hasAuthStore(directory),
      }),
      // Model sessions must reach the provider API; write-protection remains the confinement goal.
      network: "allowed",
    };
  }

  normalizeEvents(
    raw: Parameters<ProducerAdapter["normalizeEvents"]>[0],
  ): ReturnType<ProducerAdapter["normalizeEvents"]> {
    return normalizePlainText(raw);
  }

  configurationProfile(): ProducerConfigurationProfile {
    return {
      isolationState: "controlled-config-with-copied-credentials",
      credentialSources: ["~/.local/share/opencode/auth.json"],
      behavioralConfigSources: ["explicit invocation argv"],
      repositoryInstructionSources: ["worktree AGENTS.md"],
      environmentDependencies: [...OPENCODE_REQUIRED_ENV],
      temporaryHomeStrategy: "temp HOME with XDG_DATA_HOME passthrough for the auth store",
    };
  }
}
