import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { DelegationSpec } from "../protocol/delegation-spec.js";
import { probeOsConfinedCli } from "./cli-probe.js";
import {
  isProducerAuthenticated,
  resolveDefaultEnv,
  resolveInheritedWritablePaths,
  type HostStoreContext,
} from "./host-store.js";
import { normalizePlainText, renderProducerPrompt } from "./plain-text.js";
import type {
  CapabilityReport,
  InvocationContext,
  ProbeContext,
  ProducerAdapter,
  ProducerConfigurationProfile,
  ProducerDescriptor,
  ProducerInvocation,
} from "./producer-adapter.js";

const OPENCODE_REQUIRED_ENV = ["OPENCODE_CONFIG_DIR", "XDG_DATA_HOME"] as const;

export const openCodeDescriptor: ProducerDescriptor = {
  id: "opencode",
  executable: { name: "opencode" },
  isolation: "controlled-config-with-copied-credentials",
  hostState: {
    resolveStore: deps => {
      const dataHome = deps.env.XDG_DATA_HOME ?? join(deps.homeDirectory, ".local", "share");
      return join(dataHome, "opencode");
    },
    authMarker: "auth.json",
    inheritedWritablePaths: (store, deps) => {
      const stateHome = deps.env.XDG_STATE_HOME ?? join(deps.homeDirectory, ".local", "state");
      return [store, join(stateHome, "opencode")];
    },
    defaultEnv: (_store, deps) => {
      if (deps.env.XDG_DATA_HOME !== undefined) return {};
      const dataHome = join(deps.homeDirectory, ".local", "share");
      const dataDir = join(dataHome, "opencode");
      const hasAuth = (deps.hasAuthStore ?? (dir => existsSync(join(dir, "auth.json"))))(dataDir);
      return hasAuth ? { XDG_DATA_HOME: dataHome } : {};
    },
  },
  prompt: {
    actionPreamble: true,
    bootstrapPlacement: "before",
  },
  structuredOutput: false,
  executionModes: ["edit"],
};

export interface OpenCodeAdapterDeps extends HostStoreContext {}

export class OpenCodeAdapter implements ProducerAdapter {
  readonly producerId = openCodeDescriptor.id;
  readonly structuredOutput = openCodeDescriptor.structuredOutput!;
  readonly executionModes = openCodeDescriptor.executionModes!;
  readonly descriptor = openCodeDescriptor;

  constructor(private readonly deps: OpenCodeAdapterDeps = {
    env: process.env,
    homeDirectory: homedir(),
  }) {}

  async probe(ctx: ProbeContext): Promise<CapabilityReport> {
    return probeOsConfinedCli(ctx, {
      producerId: this.producerId,
      executableName: "opencode",
      structuredOutput: this.structuredOutput,
      isAuthenticated: () => isProducerAuthenticated(openCodeDescriptor, this.deps),
    });
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
      stdin: renderProducerPrompt(spec, {
        readOnly: ctx.readOnly === true,
        ...openCodeDescriptor.prompt,
      }),
      requiredEnv: [...OPENCODE_REQUIRED_ENV],
      inheritedStateWritablePaths: resolveInheritedWritablePaths(openCodeDescriptor, this.deps),
      env: resolveDefaultEnv(openCodeDescriptor, this.deps),
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
