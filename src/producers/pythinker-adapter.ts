import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ResolvedExecutable } from "../platform/platform-services.js";
import type { DelegationSpec } from "../protocol/delegation-spec.js";
import { parseSemver, probeOsConfinedCli, runVersionProbe } from "./cli-probe.js";
import { normalizePlainText, renderProducerPrompt } from "./plain-text.js";
import type {
  CapabilityReport,
  InvocationContext,
  ProbeContext,
  ProducerAdapter,
  ProducerConfigurationProfile,
  ProducerInvocation,
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

export interface PythinkerAdapterDeps {
  env: Record<string, string | undefined>;
  homeDirectory: string;
  hasAuthStore?: (directory: string) => boolean;
}

// The installed pythinker-code CLI auto-updates itself in the background by default
// (`pythinker doctor` reports "Auto-update: on (installs in background)"). Disabling it for
// the duration of a delegated run keeps the binary actually invoked consistent with the one
// this adapter probed moments earlier (--version/--help); the host may still override this
// by setting the variable itself, since defaultPythinkerEnv only fills in an absent value.
const PYTHINKER_NO_AUTO_UPDATE_ENV = "PYTHINKER_CLI_NO_AUTO_UPDATE";
// Forwarded from the host so a redirected Pythinker Code data directory — used below to
// resolve the auth store and the default HOME — actually reaches the invoked process.
// Pythinker's real default data directory is `~/.pythinker` (confirmed live via
// docs/en/configuration/providers.md's `~/.pythinker/config.toml`, the 0.19.0 and 0.34.0
// release notes referencing `~/.pythinker/projects/...` and `~/.pythinker/sessions/`, and an
// upstream commit noting `get_share_dir`/`get_config_file` "materialize ~/.pythinker"), not
// `~/.pythinker-code` as an earlier version of this adapter assumed. The override variable
// name follows the same `share.py`/`get_share_dir()` convention as the shared upstream CLI
// scaffold, whose confirmed override variable is `KIMI_SHARE_DIR` — the Pythinker-branded
// equivalent is `PYTHINKER_SHARE_DIR`. Without forwarding it, a deployment that sets
// PYTHINKER_SHARE_DIR to isolate this producer's config would have the adapter report
// auth/config state from that directory while the real invocation silently fell back to
// pythinker's own default `~/.pythinker`.
const PYTHINKER_REQUIRED_ENV = ["PYTHINKER_SHARE_DIR", PYTHINKER_NO_AUTO_UPDATE_ENV] as const;

function resolvePythinkerHome(
  deps: Required<Pick<PythinkerAdapterDeps, "env" | "homeDirectory">>,
): string {
  const configuredHome = deps.env.PYTHINKER_SHARE_DIR;
  return configuredHome !== undefined && configuredHome.length > 0
    ? configuredHome
    : join(deps.homeDirectory, ".pythinker");
}

function defaultPythinkerEnv(
  deps: Required<Pick<PythinkerAdapterDeps, "env" | "homeDirectory">> & {
    pythinkerHome: string;
    hasConfigDir: (directory: string) => boolean;
  },
): Record<string, string> {
  const env: Record<string, string> = {};
  if (deps.env.HOME === undefined && deps.hasConfigDir(deps.pythinkerHome)) {
    env.HOME = deps.homeDirectory;
  }
  if (deps.env[PYTHINKER_NO_AUTO_UPDATE_ENV] === undefined) {
    env[PYTHINKER_NO_AUTO_UPDATE_ENV] = "1";
  }
  return env;
}

export class PythinkerAdapter implements ProducerAdapter {
  readonly producerId = "pythinker";
  readonly structuredOutput = false;
  readonly executionModes = ["edit"];

  constructor(private readonly deps: PythinkerAdapterDeps = {
    env: process.env,
    homeDirectory: homedir(),
  }) {}

  private hasAuthStore(directory: string): boolean {
    return (this.deps.hasAuthStore ?? (store => existsSync(
      join(store, "credentials", "pythinker-code.json"),
    )))(directory);
  }

  private hasConfigDir(directory: string): boolean {
    return existsSync(directory);
  }

  async probe(ctx: ProbeContext): Promise<CapabilityReport> {
    return probeOsConfinedCli(ctx, {
      producerId: this.producerId,
      executableName: "pythinker",
      structuredOutput: this.structuredOutput,
      parseVersion: stdout =>
        parseSemver(stdout) ?? /\d+\.\d+\.\d+(?:[-+][^\s]+)?/u.exec(stdout)?.[0] ?? null,
      inspectSurface: (probeCtx, executable) => this.inspectCliSurface(probeCtx, executable),
      isAuthenticated: () => this.hasAuthStore(resolvePythinkerHome(this.deps)),
    });
  }

  /** The installed CLI must expose every long option this adapter emits. */
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

  buildInvocation(spec: DelegationSpec, ctx: InvocationContext): ProducerInvocation {
    if (spec.producerOverrides?.reasoningEffort !== undefined) {
      throw new Error(
        "Pythinker reasoningEffort override is unsupported by the installed pythinker-code CLI.",
      );
    }

    const args = [
      "--prompt",
      renderProducerPrompt(spec, ctx.readOnly === true),
    ];
    if (spec.producerOverrides?.model !== undefined) {
      args.push("--model", spec.producerOverrides.model);
    }
    return {
      executable: ctx.executable,
      args,
      requiredEnv: [...PYTHINKER_REQUIRED_ENV],
      inheritedStateWritablePaths: [resolvePythinkerHome(this.deps)],
      env: defaultPythinkerEnv({
        env: this.deps.env,
        homeDirectory: this.deps.homeDirectory,
        pythinkerHome: resolvePythinkerHome(this.deps),
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
      credentialSources: ["~/.pythinker/credentials/pythinker-code.json"],
      behavioralConfigSources: [
        "~/.pythinker/config.toml",
        "~/.pythinker/tui.toml",
      ],
      repositoryInstructionSources: ["worktree AGENTS.md"],
      environmentDependencies: [...PYTHINKER_REQUIRED_ENV],
      temporaryHomeStrategy: "real HOME inherited by declared policy; reduced reproducibility recorded in the Run Manifest",
    };
  }
}
