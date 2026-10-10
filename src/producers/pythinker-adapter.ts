import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ResolvedExecutable } from "../platform/platform-services.js";
import type { DelegationSpec } from "../protocol/delegation-spec.js";
import { parseSemver, runVersionProbe } from "./cli-probe.js";
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
  type ProbeContext,
  type ProducerDescriptor,
  type ProducerInvocation,
} from "./producer-adapter.js";

const REQUIRED_LONG_OPTIONS = ["--prompt", "--model"] as const;

function parseLongOptionTokens(helpText: string): Set<string> {
  const options = new Set<string>();
  for (const line of helpText.split(/\r?\n/u)) {
    const match = /^\s*(?:-[A-Z0-9],\s*)?(--[a-z][a-z0-9-]*)(?=\s|$)/iu.exec(line);
    if (match?.[1] !== undefined) options.add(match[1]);
  }
  return options;
}

const PYTHINKER_NO_AUTO_UPDATE_ENV = "PYTHINKER_CLI_NO_AUTO_UPDATE";
const PYTHINKER_REQUIRED_ENV = ["PYTHINKER_SHARE_DIR", PYTHINKER_NO_AUTO_UPDATE_ENV] as const;

function resolvePythinkerHome(deps: HostStoreContext): string {
  const configuredHome = deps.env.PYTHINKER_SHARE_DIR;
  return configuredHome !== undefined && configuredHome.length > 0
    ? configuredHome
    : join(deps.env.HOME ?? deps.env.USERPROFILE ?? deps.homeDirectory, ".pythinker");
}

async function inspectPythinkerCliSurface(
  ctx: ProbeContext,
  executable: ResolvedExecutable,
): Promise<string | null> {
  let helpResult;
  try {
    helpResult = await runVersionProbe(ctx, executable, ["--help"]);
  } catch {
    return "unsupported-cli-surface";
  }
  const options = parseLongOptionTokens(`${helpResult.stdout}\n${helpResult.stderr}`);
  if (
    helpResult.spawnError !== undefined
    || helpResult.exitCode !== 0
    || REQUIRED_LONG_OPTIONS.some(option => !options.has(option))
  ) {
    return "unsupported-cli-surface";
  }
  return null;
}

function buildPythinkerInvocation(
  spec: DelegationSpec,
  ctx: InvocationContext,
  deps: HostStoreContext,
): ProducerInvocation {
  if (spec.producerOverrides?.reasoningEffort !== undefined) {
    throw new Error(
      "Pythinker reasoningEffort override is unsupported by the installed pythinker-code CLI.",
    );
  }

  const args = [
    "--prompt",
    renderProducerPrompt(spec, {
      readOnly: ctx.readOnly === true,
      ...pythinkerDescriptor.prompt,
    }),
  ];
  if (spec.producerOverrides?.model !== undefined) {
    args.push("--model", spec.producerOverrides.model);
  }
  return {
    executable: ctx.executable,
    args,
    requiredEnv: [...PYTHINKER_REQUIRED_ENV],
    inheritedStateWritablePaths: resolveInheritedWritablePaths(pythinkerDescriptor, deps),
    env: resolveDefaultEnv(pythinkerDescriptor, deps),
    network: "allowed",
  };
}

export const pythinkerDescriptor: ProducerDescriptor = {
  id: "pythinker",
  executable: { name: "pythinker" },
  isolation: "inherited-config-only",
  hostState: {
    resolveStore: deps => resolvePythinkerHome(deps),
    authMarker: join("credentials", "pythinker-code.json"),
    inheritedWritablePaths: store => [store],
    defaultEnv: (store, deps) => {
      const env: Record<string, string> = {};
      if (deps.env.HOME === undefined) {
        const hasConfig = (deps.hasConfigDir ?? existsSync)(store);
        if (hasConfig) env.HOME = deps.homeDirectory;
      }
      if (deps.env[PYTHINKER_NO_AUTO_UPDATE_ENV] === undefined) {
        env[PYTHINKER_NO_AUTO_UPDATE_ENV] = "1";
      }
      return env;
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
    credentialSources: ["~/.pythinker/credentials/pythinker-code.json"],
    behavioralConfigSources: [
      "~/.pythinker/config.toml",
      "~/.pythinker/tui.toml",
    ],
    repositoryInstructionSources: ["worktree AGENTS.md"],
    environmentDependencies: [...PYTHINKER_REQUIRED_ENV],
    temporaryHomeStrategy: "real HOME inherited by declared policy; reduced reproducibility recorded in the Run Manifest",
  },
  probe: (ctx, deps) => probeDescriptorCli(pythinkerDescriptor, ctx, deps, {
    parseVersion: stdout =>
      parseSemver(stdout) ?? /\d+\.\d+\.\d+(?:[-+][^\s]+)?/u.exec(stdout)?.[0] ?? null,
    inspectSurface: inspectPythinkerCliSurface,
  }),
  buildInvocation: buildPythinkerInvocation,
  normalizeEvents: normalizePlainText,
};

export class PythinkerAdapter extends DescriptorAdapter { constructor(deps?: HostStoreContext) { super(pythinkerDescriptor, deps); } }
