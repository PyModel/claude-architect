import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { DelegationSpec } from "../protocol/delegation-spec.js";
import { probeOsConfinedCli } from "./cli-probe.js";
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
import {
  isProducerAuthenticated,
  isRecord,
  resolveDefaultEnv,
  stringProperty,
  type HostStoreContext,
} from "./host-store.js";
import {
  EDIT_ACTION_PREAMBLE,
  renderProducerPrompt,
} from "./prompt-renderer.js";

export const CODEX_REQUIRED_ENV = [
  "CODEX_HOME",
  "CODEX_API_KEY",
  "CODEX_ACCESS_TOKEN",
  "CODEX_CA_CERTIFICATE",
  "SSL_CERT_FILE",
] as const;

// Glob patterns denied to the Producer shell. Codex needs these on its own
// process to authenticate, but the delegated shell never does.
export const CODEX_SHELL_ENV_EXCLUDE = [
  "CODEX_HOME",
  "CODEX_API_KEY",
  "CODEX_ACCESS_TOKEN",
  "CODEX_CA_CERTIFICATE",
  "CODEX_MANAGED_*",
  "SSL_CERT_FILE",
] as const;
const MULTI_AGENT_CONTROL =
  "features.multi_agent_v2={enabled=false,max_concurrent_threads_per_session=1}";

/**
 * The macOS per-user temp directory, as `xcrun` resolves it — `confstr(3)` with
 * `_CS_DARWIN_USER_TEMP_DIR`, which ignores TMPDIR. Node exposes no binding, so
 * ask getconf once per process and cache the answer.
 */
let darwinUserTempDirectory: string | null | undefined;
function resolveDarwinUserTempDirectory(): string | null {
  if (darwinUserTempDirectory !== undefined) return darwinUserTempDirectory;
  try {
    const raw = execFileSync("/usr/bin/getconf", ["DARWIN_USER_TEMP_DIR"], {
      encoding: "utf8",
      timeout: 10_000,
    }).trim();
    darwinUserTempDirectory = raw.length === 0 ? realpathSync(tmpdir()) : realpathSync(raw);
  } catch {
    // getconf is absent or the directory does not resolve. Fall back to the
    // process temp directory; if that also fails the lane simply keeps the
    // pre-existing (slow but correct) behavior.
    try {
      darwinUserTempDirectory = realpathSync(tmpdir());
    } catch {
      darwinUserTempDirectory = null;
    }
  }
  return darwinUserTempDirectory;
}

/**
 * Roots the Producer sandbox must be able to write for reasons unrelated to the
 * task. On macOS with full Xcode selected, `/usr/bin/git` is a stub that resolves
 * the real binary through `xcrun` and caches the answer in the per-user temp
 * directory. The Producer shell is a login shell, so `path_helper` puts
 * `/usr/bin` ahead of every inherited PATH entry and that stub is what runs. When
 * the cache write is denied, *every* git invocation re-runs `xcodebuild -find git`
 * — measured at 1.01s per call against 0.012s cached, which turned ordinary
 * suites into hundreds of concurrent xcodebuild processes.
 *
 * Be precise about what this costs. `buildEnvironment` passes the host TMPDIR
 * through unchanged, and on macOS TMPDIR is normally this same per-user
 * directory, so where that holds `exclude_tmpdir_env_var` becomes a no-op and
 * this reopens exactly what that flag closed. `exclude_slash_tmp` still stands,
 * `/tmp` stays unwritable, and the repository and worktree confinement are
 * untouched. Deliberate: xcrun resolves the cache through
 * `confstr(_CS_DARWIN_USER_TEMP_DIR)` and ignores TMPDIR, so no narrower
 * directory can carry it.
 */
export function sandboxSupportWritableRoots(platform: NodeJS.Platform): string[] {
  if (platform !== "darwin") return [];
  const temporaryDirectory = resolveDarwinUserTempDirectory();
  return temporaryDirectory === null ? [] : [temporaryDirectory];
}
function parseVersion(stdout: string): string | null {
  const match = /(?:^|\s)(\d+\.\d+\.\d+(?:[-+][^\s]+)?)(?:\s|$)/u.exec(stdout.trim());
  return match?.[1] ?? null;
}

function quoteTomlString(value: string): string {
  return JSON.stringify(value);
}

export const CODEX_EDIT_ACTION_PREAMBLE = EDIT_ACTION_PREAMBLE;

export const codexDescriptor: ProducerDescriptor = {
  id: "codex",
  executable: { name: "codex" },
  isolation: "controlled-config-with-copied-credentials",
  hostState: {
    resolveStore: deps => deps.env.CODEX_HOME ?? join(deps.homeDirectory, ".codex"),
    authMarker: "auth.json",
    defaultEnv: (store, deps) => {
      if (deps.env.CODEX_HOME !== undefined) return {};
      const hasAuth = (deps.hasAuthStore ?? (dir => existsSync(join(dir, "auth.json"))))(store);
      return hasAuth ? { CODEX_HOME: store } : {};
    },
  },
  prompt: {
    actionPreamble: true,
    bootstrapPlacement: "before",
  },
  structuredOutput: true,
  executionModes: ["edit"],
};

export interface CodexAdapterDeps extends HostStoreContext {}

export class CodexAdapter implements ProducerAdapter {
  readonly producerId = codexDescriptor.id;
  readonly structuredOutput = codexDescriptor.structuredOutput!;
  readonly executionModes = codexDescriptor.executionModes!;
  readonly descriptor = codexDescriptor;

  constructor(private readonly deps: CodexAdapterDeps = {
    env: process.env,
    homeDirectory: homedir(),
  }) {}

  async probe(ctx: ProbeContext): Promise<CapabilityReport> {
    return probeOsConfinedCli(ctx, {
      producerId: this.producerId,
      executableName: "codex",
      structuredOutput: this.structuredOutput,
      writeConfinementBackend: "codex-native-sandbox",
      parseVersion,
      isAuthenticated: () => isProducerAuthenticated(codexDescriptor, this.deps),
    });
  }

  buildInvocation(spec: DelegationSpec, ctx: InvocationContext): ProducerInvocation {
    const redirectedGitObjects = ctx.gitObjectDirectory !== undefined
      && ctx.gitAlternateObjectDirectories !== undefined;
    const shellEnvironment = [
      "PATH",
      "HOME",
      "TMPDIR",
      "LANG",
      "LC_ALL",
      "CLAUDE_ARCHITECT_DELEGATED",
      ...(redirectedGitObjects
        ? ["GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES"]
        : []),
    ];
    // `include_only` narrows the inherited set; it cannot add to it. Under
    // inherit="none" the inherited set is empty, so the producer shell lost PATH
    // entirely and could not resolve node, npx, or git — Producers then burned
    // whole attempts inventing workarounds. inherit="core" delivers the
    // already-sanitized PATH/HOME/TMPDIR/LANG/LC_ALL from the spawn environment
    // without leaking CODEX_HOME or any other host variable, and `set` force-adds
    // the non-core variables (nested-delegation guard, redirected Git objects)
    // that "core" would otherwise drop.
    const forcedShellEnvironment: Record<string, string> = {
      CLAUDE_ARCHITECT_DELEGATED: "1",
      ...(redirectedGitObjects
        ? {
          GIT_OBJECT_DIRECTORY: ctx.gitObjectDirectory!,
          GIT_ALTERNATE_OBJECT_DIRECTORIES: ctx.gitAlternateObjectDirectories!,
        }
        : {}),
    };
    // Read-only roles get Codex's read-only sandbox, which has no writable roots
    // at all; the support roots below only make sense for the edit lane.
    const writableRoots = ctx.readOnly === true
      ? (ctx.extraWritableRoots ?? [])
      : [...new Set([
        ...(ctx.extraWritableRoots ?? []),
        ...sandboxSupportWritableRoots(process.platform),
      ])];
    const args = [
      "exec",
      "--json",
      "--ephemeral",
      "--sandbox",
      // Read-only roles use Codex's native read-only sandbox: wrapping Codex in
      // an outer Seatbelt profile EPERM-crashes its internal sandbox init.
      ctx.readOnly === true ? "read-only" : "workspace-write",
      "--ignore-user-config",
      "--ignore-rules",
      "--disable",
      "multi_agent",
      "-c",
      MULTI_AGENT_CONTROL,
      "-c",
      'approval_policy="never"',
      "-c",
      "sandbox_workspace_write.network_access=false",
      "-c",
      "sandbox_workspace_write.exclude_tmpdir_env_var=true",
      "-c",
      "sandbox_workspace_write.exclude_slash_tmp=true",
      ...(writableRoots.length === 0
        ? []
        : [
          "-c",
          `sandbox_workspace_write.writable_roots=${JSON.stringify(writableRoots)}`,
        ]),
      "-c",
      'shell_environment_policy.inherit="core"',
      "-c",
      `shell_environment_policy.include_only=${JSON.stringify(shellEnvironment)}`,
      "-c",
      // Codex re-injects its own credential and packaging variables after the
      // inherit filter runs, so the auth-store location would otherwise reach the
      // Producer shell. Deny them explicitly.
      `shell_environment_policy.exclude=${JSON.stringify(CODEX_SHELL_ENV_EXCLUDE)}`,
      "-c",
      `shell_environment_policy.set={${
        Object.entries(forcedShellEnvironment)
          .map(([name, value]) => `${name}=${quoteTomlString(value)}`)
          .join(",")
      }}`,
      "-c",
      'web_search="disabled"',
      "--cd",
      ctx.worktreePath,
    ];
    if (spec.producerOverrides?.model !== undefined) {
      args.push("--model", spec.producerOverrides.model);
    }
    if (spec.producerOverrides?.reasoningEffort !== undefined) {
      args.push(
        "-c",
        `model_reasoning_effort=${quoteTomlString(spec.producerOverrides.reasoningEffort)}`,
      );
    }
    args.push("-");
    const defaultEnv = resolveDefaultEnv(codexDescriptor, this.deps);
    return {
      executable: ctx.executable,
      args,
      stdin: renderProducerPrompt(spec, {
        readOnly: ctx.readOnly === true,
        ...codexDescriptor.prompt,
      }),
      requiredEnv: [...CODEX_REQUIRED_ENV],
      env: {
        ...defaultEnv,
        ...(redirectedGitObjects
          ? {
            GIT_OBJECT_DIRECTORY: ctx.gitObjectDirectory!,
            GIT_ALTERNATE_OBJECT_DIRECTORIES: ctx.gitAlternateObjectDirectories!,
          }
          : {}),
      },
      network: "denied",
    };
  }

  normalizeEvents(raw: {
    stdout: string;
    stderr: string;
    exit: Parameters<ProducerAdapter["normalizeEvents"]>[0]["exit"];
  }): ReturnType<ProducerAdapter["normalizeEvents"]> {
    if (raw.exit.truncated.stdout) {
      return { events: [], producerSummary: null, ok: false };
    }
    const lines = raw.stdout.split(/\r?\n/u).filter(line => line.trim().length > 0);
    if (lines.length === 0) return { events: [], producerSummary: null, ok: false };

    const events: AdapterEvent[] = [];
    let producerSummary: string | null = null;
    let completed = false;
    let failed = false;
    try {
      for (const line of lines) {
        const parsed: unknown = JSON.parse(line);
        if (!isRecord(parsed) || typeof parsed.type !== "string") {
          return { events: [], producerSummary: null, ok: false };
        }
        if (parsed.type === "turn.completed") {
          completed = true;
          continue;
        }
        if (parsed.type === "error" || parsed.type === "turn.failed") {
          failed = true;
          const text = stringProperty(parsed, "message")
            ?? stringProperty(parsed.error, "message");
          events.push({
            kind: "error",
            ...(text === undefined ? {} : { text }),
            raw: parsed,
          });
          continue;
        }
        if (parsed.type !== "item.completed") continue;
        const item = parsed.item;
        const itemType = stringProperty(item, "type");
        if (itemType === "agent_message") {
          const text = stringProperty(item, "text");
          if (text === undefined) return { events: [], producerSummary: null, ok: false };
          producerSummary = text;
          events.push({ kind: "final", text, raw: parsed });
        } else if (itemType !== undefined) {
          events.push({ kind: "tool", raw: parsed });
        }
      }
    } catch {
      return { events: [], producerSummary: null, ok: false };
    }

    return {
      events,
      producerSummary,
      ok: completed && !failed && producerSummary !== null,
    };
  }

  configurationProfile(): ProducerConfigurationProfile {
    return {
      isolationState: "controlled-config-supported",
      credentialSources: [
        "CODEX_HOME auth store",
        "CODEX_API_KEY",
        "CODEX_ACCESS_TOKEN",
        "operating-system credential store",
      ],
      behavioralConfigSources: ["explicit invocation argv"],
      repositoryInstructionSources: ["worktree AGENTS.md"],
      environmentDependencies: [...CODEX_REQUIRED_ENV],
      temporaryHomeStrategy:
        "use a per-attempt HOME while preserving CODEX_HOME for auth; ignore user config and rules",
    };
  }
}
