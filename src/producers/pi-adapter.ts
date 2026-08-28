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

const PI_REQUIRED_ENV = ["PI_API_KEY"] as const;

export interface PiAdapterDeps {
  env: Record<string, string | undefined>;
  homeDirectory: string;
  hasAuthStore?: (directory: string) => boolean;
}

function defaultPiEnv(
  deps: Required<Pick<PiAdapterDeps, "env" | "homeDirectory">> & {
    hasConfigDir: (directory: string) => boolean;
  },
): Record<string, string> {
  if (deps.env.HOME !== undefined) return {};
  return deps.hasConfigDir(join(deps.homeDirectory, ".pi"))
    ? { HOME: deps.homeDirectory }
    : {};
}

export class PiAdapter implements ProducerAdapter {
  readonly producerId = "pi";
  readonly structuredOutput = false;
  readonly executionModes = ["edit"];

  constructor(private readonly deps: PiAdapterDeps = {
    env: process.env,
    homeDirectory: homedir(),
  }) {}

  private hasAuthStore(directory: string): boolean {
    return (this.deps.hasAuthStore ?? (store => existsSync(join(store, "auth.json"))))(directory);
  }

  private hasConfigDir(directory: string): boolean {
    return existsSync(directory);
  }

  async probe(ctx: ProbeContext): Promise<CapabilityReport> {
    return probeOsConfinedCli(ctx, {
      producerId: this.producerId,
      executableName: "pi",
      structuredOutput: this.structuredOutput,
      isAuthenticated: () => this.hasAuthStore(this.agentStateDirectory()),
    });
  }

  /** Pi's auth + settings store; the only host state an attempt must write. */
  private agentStateDirectory(): string {
    return join(this.deps.env.HOME ?? this.deps.homeDirectory, ".pi", "agent");
  }

  buildInvocation(spec: DelegationSpec, ctx: InvocationContext): ProducerInvocation {
    // The Pi lane always runs the model configured in Pi itself
    // (~/.pi/agent/models.json). A requested override would silently substitute
    // a different model — possibly a local one — so it fails the lane instead,
    // mirroring the Pythinker reasoningEffort precedent.
    if (spec.producerOverrides?.model !== undefined) {
      throw new Error(
        "Pi model override is unsupported: the pi lane always uses the model configured in Pi.",
      );
    }
    const args = [
      "-p",
      "--no-session",
      "--no-skills",
      "--tools",
      "read,bash,edit,write,grep,find,ls",
    ];
    if (spec.producerOverrides?.reasoningEffort !== undefined) {
      args.push("--thinking", spec.producerOverrides.reasoningEffort);
    }

    return {
      executable: ctx.executable,
      args,
      stdin: renderProducerPrompt(spec, ctx.readOnly === true),
      requiredEnv: [...PI_REQUIRED_ENV],
      inheritedStateWritablePaths: [this.agentStateDirectory()],
      env: defaultPiEnv({
        env: this.deps.env,
        homeDirectory: this.deps.homeDirectory,
        hasConfigDir: directory => this.hasConfigDir(directory),
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
      isolationState: "inherited-config-only",
      credentialSources: ["~/.pi/agent/auth.json"],
      behavioralConfigSources: ["~/.pi/agent/settings.json", "~/.pi/agent/models.json"],
      repositoryInstructionSources: ["worktree AGENTS.md"],
      environmentDependencies: [...PI_REQUIRED_ENV],
      temporaryHomeStrategy: "real HOME inherited by declared policy; reduced reproducibility recorded in the Run Manifest",
    };
  }
}
