import { existsSync } from "node:fs";
import { join } from "node:path";
import type { DelegationSpec } from "../protocol/delegation-spec.js";
import {
  resolveDefaultEnv,
  resolveInheritedWritablePaths,
  type HostStoreContext,
} from "./host-store.js";
import { normalizePlainText, renderProducerPrompt } from "./plain-text.js";
import {
  DescriptorAdapter,
  probeDescriptorCli,
  type InvocationContext,
  type ProducerDescriptor,
  type ProducerInvocation,
} from "./producer-adapter.js";

const OPENCODE_REQUIRED_ENV = ["OPENCODE_CONFIG_DIR", "XDG_DATA_HOME"] as const;

function buildOpenCodeInvocation(
  spec: DelegationSpec,
  ctx: InvocationContext,
  deps: HostStoreContext,
): ProducerInvocation {
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
    inheritedStateWritablePaths: resolveInheritedWritablePaths(openCodeDescriptor, deps),
    env: resolveDefaultEnv(openCodeDescriptor, deps),
    network: "allowed",
  };
}

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
  configurationProfile: {
    isolationState: "controlled-config-with-copied-credentials",
    credentialSources: ["~/.local/share/opencode/auth.json"],
    behavioralConfigSources: ["explicit invocation argv"],
    repositoryInstructionSources: ["worktree AGENTS.md"],
    environmentDependencies: [...OPENCODE_REQUIRED_ENV],
    temporaryHomeStrategy: "temp HOME with XDG_DATA_HOME passthrough for the auth store",
  },
  probe: (ctx, deps) => probeDescriptorCli(openCodeDescriptor, ctx, deps),
  buildInvocation: buildOpenCodeInvocation,
  normalizeEvents: normalizePlainText,
};

export class OpenCodeAdapter extends DescriptorAdapter { constructor(deps?: HostStoreContext) { super(openCodeDescriptor, deps); } }
