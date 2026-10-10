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

const PI_REQUIRED_ENV = ["PI_API_KEY"] as const;

function buildPiInvocation(
  spec: DelegationSpec,
  ctx: InvocationContext,
  deps: HostStoreContext,
): ProducerInvocation {
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
    stdin: renderProducerPrompt(spec, {
      readOnly: ctx.readOnly === true,
      ...piDescriptor.prompt,
    }),
    requiredEnv: [...PI_REQUIRED_ENV],
    inheritedStateWritablePaths: resolveInheritedWritablePaths(piDescriptor, deps),
    env: resolveDefaultEnv(piDescriptor, deps),
    network: "allowed",
  };
}

export const piDescriptor: ProducerDescriptor = {
  id: "pi",
  executable: { name: "pi" },
  isolation: "inherited-config-only",
  hostState: {
    resolveStore: deps => {
      const home = deps.env.HOME ?? deps.env.USERPROFILE ?? deps.homeDirectory;
      return join(home, ".pi", "agent");
    },
    authMarker: "auth.json",
    inheritedWritablePaths: store => [store],
    defaultEnv: (_store, deps) => {
      if (deps.env.HOME !== undefined) return {};
      const configDir = join(deps.homeDirectory, ".pi");
      const hasConfig = (deps.hasConfigDir ?? existsSync)(configDir);
      return hasConfig ? { HOME: deps.homeDirectory } : {};
    },
  },
  prompt: {
    actionPreamble: true,
    bootstrapPlacement: "before",
  },
  structuredOutput: false,
  executionModes: ["edit"],
  configurationProfile: {
    isolationState: "inherited-config-only",
    credentialSources: ["~/.pi/agent/auth.json"],
    behavioralConfigSources: ["~/.pi/agent/settings.json", "~/.pi/agent/models.json"],
    repositoryInstructionSources: ["worktree AGENTS.md"],
    environmentDependencies: [...PI_REQUIRED_ENV],
    temporaryHomeStrategy: "real HOME inherited by declared policy; reduced reproducibility recorded in the Run Manifest",
  },
  probe: (ctx, deps) => probeDescriptorCli(piDescriptor, ctx, deps),
  buildInvocation: buildPiInvocation,
  normalizeEvents: normalizePlainText,
};

export class PiAdapter extends DescriptorAdapter { constructor(deps?: HostStoreContext) { super(piDescriptor, deps); } }
