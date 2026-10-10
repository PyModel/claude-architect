// Characterization guard for the Producer Adapter descriptor migration (F9).
// Records, for all six Producers, the probe report, invocation (argv, stdin,
// env, required env, writable state paths), configuration profile and event
// normalization exactly as the bespoke adapters produced them before the
// migration. These snapshots must stay byte-identical across the migration.
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type {
  PlatformServices,
  ResolvedExecutable,
  SupervisedExit,
} from "../../src/platform/platform-services.js";
import type { DelegationSpec } from "../../src/protocol/delegation-spec.js";
import { AgyAdapter, agyDescriptor } from "../../src/producers/agy-adapter.js";
import { ClaudeAdapter, claudeDescriptor } from "../../src/producers/claude-adapter.js";
import {
  CodexAdapter,
  codexDescriptor,
  sandboxSupportWritableRoots,
} from "../../src/producers/codex-adapter.js";
import type { HostStoreContext } from "../../src/producers/host-store.js";
import { OpenCodeAdapter, openCodeDescriptor } from "../../src/producers/opencode-adapter.js";
import { PiAdapter, piDescriptor } from "../../src/producers/pi-adapter.js";
import type {
  InvocationContext,
  ProbeContext,
  ProducerAdapter,
  ProducerDescriptor,
} from "../../src/producers/producer-adapter.js";
import { PythinkerAdapter, pythinkerDescriptor } from "../../src/producers/pythinker-adapter.js";

type Factory = (deps: HostStoreContext) => ProducerAdapter;

const executable: ResolvedExecutable = {
  kind: "native",
  command: "/nonexistent/claude-architect-characterization/cli",
  prefixArgs: [],
  resolvedFrom: "characterization",
};

const fullHelp = [
  "Usage: cli [options]",
  "  -p, --prompt <prompt>",
  "  -m, --model <model>",
  "  --no-session-persistence",
  "  --strict-mcp-config",
  "  --setting-sources <sources>",
  "",
].join("\n");

const DEPS: Record<string, HostStoreContext> = {
  homeSetAuthed: {
    env: { HOME: "/home/char" },
    homeDirectory: "/home/char",
    hasAuthStore: () => true,
    hasConfigDir: () => true,
    hasOauthAccount: () => true,
  },
  homeUnsetConfigPresent: {
    env: {},
    homeDirectory: "/home/char",
    hasAuthStore: () => true,
    hasConfigDir: () => true,
    hasOauthAccount: () => false,
  },
  homeUnsetNothing: {
    env: {},
    homeDirectory: "/home/char",
    hasAuthStore: () => false,
    hasConfigDir: () => false,
    hasOauthAccount: () => false,
  },
  userProfileOnly: {
    env: { USERPROFILE: "/profile/char" },
    homeDirectory: "/home/char",
    hasAuthStore: () => false,
    hasConfigDir: () => true,
    hasOauthAccount: () => false,
  },
  overridesSet: {
    env: {
      HOME: "/home/override",
      XDG_DATA_HOME: "/xdg/data",
      XDG_STATE_HOME: "/xdg/state",
      PYTHINKER_SHARE_DIR: "/pythinker/share",
      PYTHINKER_CLI_NO_AUTO_UPDATE: "0",
      CODEX_HOME: "/codex/home",
      CLAUDE_CONFIG_DIR: "/claude/config",
      GEMINI_API_KEY: "gemini-key",
      ANTHROPIC_API_KEY: "anthropic-key",
    },
    homeDirectory: "/home/char",
    hasAuthStore: () => false,
    hasConfigDir: () => false,
    hasOauthAccount: () => false,
  },
};

function spec(overrides: Partial<DelegationSpec> = {}): DelegationSpec {
  return {
    specVersion: "1",
    objective: "Characterize the adapter.",
    context: "Characterization fixture.",
    writeAllowlist: ["src/a.ts"],
    forbiddenScope: ["secrets/**"],
    successCriteria: ["It is characterized."],
    verification: [],
    executionMode: "edit",
    timeoutMs: 90_500,
    producerPreferences: [],
    expectedOutput: "candidate-patch",
    ...overrides,
  };
}

const INVOCATION_CASES: Record<string, { spec: DelegationSpec; ctx: Partial<InvocationContext> }> = {
  base: { spec: spec(), ctx: {} },
  readOnly: { spec: spec(), ctx: { readOnly: true } },
  model: { spec: spec({ producerOverrides: { model: "model-x" } }), ctx: {} },
  effortHigh: { spec: spec({ producerOverrides: { reasoningEffort: "high" } }), ctx: {} },
  effortInvalid: { spec: spec({ producerOverrides: { reasoningEffort: "turbo" } }), ctx: {} },
  modelAndEffort: {
    spec: spec({ producerOverrides: { model: "model-y", reasoningEffort: "low" } }),
    ctx: {},
  },
  gitRedirect: {
    spec: spec(),
    ctx: {
      gitObjectDirectory: "/repo/.git/objects",
      gitAlternateObjectDirectories: "/repo/alt/objects",
      extraWritableRoots: ["/extra/root"],
    },
  },
  gitRedirectReadOnly: {
    spec: spec(),
    ctx: {
      readOnly: true,
      gitObjectDirectory: "/repo/.git/objects",
      gitAlternateObjectDirectories: "/repo/alt/objects",
      extraWritableRoots: ["/extra/root"],
    },
  },
};

function exit(overrides: Partial<SupervisedExit> = {}): SupervisedExit {
  return {
    exitCode: 0,
    signal: null,
    timedOut: false,
    cancelled: false,
    stdout: "",
    stderr: "",
    truncated: { stdout: false, stderr: false },
    ...overrides,
  };
}

const longText = `${"x".repeat(9_000)}END`;
const EVENT_CASES: Record<string, { stdout: string; stderr: string; exit: SupervisedExit }> = {
  plainSuccess: { stdout: "Done.\n", stderr: "", exit: exit() },
  plainLong: { stdout: longText, stderr: "", exit: exit() },
  emptySuccess: { stdout: "  \n", stderr: "", exit: exit() },
  nonzeroExit: { stdout: "partial", stderr: "boom", exit: exit({ exitCode: 1 }) },
  truncated: {
    stdout: "Done.",
    stderr: "",
    exit: exit({ truncated: { stdout: true, stderr: false } }),
  },
  agySuccess: { stdout: '{"status":"SUCCESS","response":"agy done"}', stderr: "", exit: exit() },
  agyError: { stdout: '{"status":"ERROR","response":"agy failed"}', stderr: "", exit: exit() },
  agyNoResponse: { stdout: '{"status":"SUCCESS"}', stderr: "", exit: exit() },
  claudeSuccess: {
    stdout: 'warning\n{"type":"result","subtype":"success","is_error":false,"result":"claude done"}',
    stderr: "",
    exit: exit(),
  },
  claudeError: {
    stdout: '{"type":"result","subtype":"error_max_turns","is_error":true,"result":"claude failed"}',
    stderr: "err",
    exit: exit({ exitCode: 1 }),
  },
  codexSuccess: {
    stdout: [
      '{"type":"thread.started"}',
      '{"type":"item.completed","item":{"type":"command_execution","command":"ls"}}',
      '{"type":"item.completed","item":{"type":"agent_message","text":"codex done"}}',
      '{"type":"turn.completed"}',
    ].join("\n"),
    stderr: "",
    exit: exit(),
  },
  codexFailed: {
    stdout: [
      '{"type":"error","message":"rate limited"}',
      '{"type":"turn.failed","error":{"message":"turn failed"}}',
    ].join("\r\n"),
    stderr: "",
    exit: exit({ exitCode: 1 }),
  },
  codexMalformed: { stdout: '{"type":"turn.completed"}\nnot json', stderr: "", exit: exit() },
  codexMessageWithoutText: {
    stdout: '{"type":"item.completed","item":{"type":"agent_message"}}\n{"type":"turn.completed"}',
    stderr: "",
    exit: exit(),
  },
};

function platformServices(
  os: PlatformServices["os"],
  spawned: string[][],
  options: { missing?: boolean; version?: string; help?: string } = {},
): PlatformServices {
  const fake = {
    os,
    async resolveExecutable() {
      if (options.missing === true) throw new Error("not installed");
      return executable;
    },
    async spawnSupervised(request: { args: string[] }) {
      spawned.push([...request.args]);
      const stdout = request.args.includes("--help")
        ? (options.help ?? fullHelp)
        : (options.version ?? "1.2.3\n");
      return {
        pid: 4242,
        stdout: Readable.from([]),
        stderr: Readable.from([]),
        done: Promise.resolve(exit({ stdout })),
      };
    },
    async requestCooperativeCancellation() {},
    async terminateProcessTree() {},
    async getProcessStartToken() {
      return null;
    },
    async terminateProcessTreeByPid() {},
  };
  return fake as unknown as PlatformServices;
}

const PROBE_CASES: Record<string, {
  os: ProbeContext["os"];
  arch: string;
  environmentType: ProbeContext["environmentType"];
  deps: string;
  options?: { missing?: boolean; version?: string; help?: string };
}> = {
  darwinAuthed: { os: "darwin", arch: "arm64", environmentType: "native", deps: "homeSetAuthed" },
  darwinUnauthed: { os: "darwin", arch: "arm64", environmentType: "native", deps: "homeUnsetNothing" },
  darwinEnvKeys: { os: "darwin", arch: "x64", environmentType: "native", deps: "overridesSet" },
  linuxNative: { os: "linux", arch: "x64", environmentType: "native", deps: "homeSetAuthed" },
  linuxWsl: { os: "linux", arch: "x64", environmentType: "wsl", deps: "homeSetAuthed" },
  win32: { os: "win32", arch: "x64", environmentType: "native", deps: "homeSetAuthed" },
  missingExecutable: {
    os: "darwin", arch: "arm64", environmentType: "native", deps: "homeSetAuthed",
    options: { missing: true },
  },
  unparseableVersion: {
    os: "darwin", arch: "arm64", environmentType: "native", deps: "homeSetAuthed",
    options: { version: "no version here" },
  },
  prefixedVersion: {
    os: "darwin", arch: "arm64", environmentType: "native", deps: "homeSetAuthed",
    options: { version: "cli v2.0.1-beta.1 (build 7)" },
  },
  bareHelp: {
    os: "darwin", arch: "arm64", environmentType: "native", deps: "homeSetAuthed",
    options: { help: "Usage: cli\n" },
  },
};

const supportRoots = sandboxSupportWritableRoots(process.platform);
const WRITABLE_ROOTS_PREFIX = "sandbox_workspace_write.writable_roots=";

/**
 * Codex appends host support roots (macOS only) to its writable roots. Drop
 * them so the snapshot is the same on every OS; the platform-specific part is
 * covered by the Codex adapter's own tests.
 */
function withoutSupportRoots(args: string[]): string[] {
  const index = args.findIndex(arg => arg.startsWith(WRITABLE_ROOTS_PREFIX));
  if (index < 0) return args;
  const roots = (JSON.parse(args[index]!.slice(WRITABLE_ROOTS_PREFIX.length)) as string[])
    .filter(root => !supportRoots.includes(root));
  const result = [...args];
  if (roots.length === 0) result.splice(index - 1, 2);
  else result[index] = `${WRITABLE_ROOTS_PREFIX}${JSON.stringify(roots)}`;
  return result;
}

/**
 * Make a record platform-neutral and checkout-independent without losing
 * bytes that matter: path separators become "/", the checkout root becomes
 * "<checkout>/" (before hashing, so rendered prompts embedding vendored skill
 * paths hash the same everywhere), and long strings (rendered prompts)
 * collapse to their sha256.
 */
function canonical(value: unknown, checkoutRoot: string): unknown {
  if (typeof value === "string") {
    const root = checkoutRoot.split("\\").join("/").replace(/\/?$/, "/");
    const text = value.split("\\").join("/").split(root).join("<checkout>/");
    return text.length > 200 ? `sha256:${createHash("sha256").update(text).digest("hex")}` : text;
  }
  if (Array.isArray(value)) return value.map(entry => canonical(entry, checkoutRoot));
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, canonical(entry, checkoutRoot)]),
    );
  }
  return value;
}

function captured<T>(run: () => T): T | { error: string } {
  try {
    return run();
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));

/** Rewrite every string as if the repository were checked out at `root`. */
function relocated(value: unknown, root: string): unknown {
  if (typeof value === "string") return value.split(REPO_ROOT).join(root);
  if (Array.isArray(value)) return value.map(entry => relocated(entry, root));
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, relocated(entry, root)]),
    );
  }
  return value;
}

async function characterize(
  factory: Factory,
  descriptor: ProducerDescriptor,
  checkoutRoot: string = REPO_ROOT,
): Promise<unknown> {
  const reference = factory(DEPS.homeSetAuthed!);
  const identity = {
    producerId: reference.producerId,
    structuredOutput: (reference as { structuredOutput?: unknown }).structuredOutput,
    executionModes: (reference as { executionModes?: unknown }).executionModes,
    descriptorIsExported: (reference as { descriptor?: unknown }).descriptor === descriptor,
  };

  const probe: Record<string, unknown> = {};
  for (const [name, probeCase] of Object.entries(PROBE_CASES)) {
    const spawned: string[][] = [];
    const ps = platformServices(probeCase.os, spawned, probeCase.options);
    const report = await factory(DEPS[probeCase.deps]!).probe({
      ps,
      os: probeCase.os,
      arch: probeCase.arch,
      environmentType: probeCase.environmentType,
    });
    probe[name] = { report, spawned };
  }

  const invocation: Record<string, unknown> = {};
  for (const [name, invocationCase] of Object.entries(INVOCATION_CASES)) {
    const adapter = factory(DEPS.homeSetAuthed!);
    const result = captured(() => adapter.buildInvocation(invocationCase.spec, {
      worktreePath: "/work/tree",
      runId: "run-char",
      executable,
      capabilityReport: undefined as never,
      ...invocationCase.ctx,
    }));
    invocation[name] = "error" in result
      ? result
      : { ...result, args: withoutSupportRoots(result.args) };
  }

  const environment: Record<string, unknown> = {};
  for (const [name, deps] of Object.entries(DEPS)) {
    const result = captured(() => factory(deps).buildInvocation(spec(), {
      worktreePath: "/work/tree",
      runId: "run-char",
      executable,
      capabilityReport: undefined as never,
    }));
    environment[name] = "error" in result
      ? result
      : {
        env: result.env,
        requiredEnv: result.requiredEnv,
        inheritedStateWritablePaths: result.inheritedStateWritablePaths,
        network: result.network,
      };
  }

  const events: Record<string, unknown> = {};
  for (const [name, raw] of Object.entries(EVENT_CASES)) {
    events[name] = reference.normalizeEvents(raw);
  }

  return canonical(relocated({
    identity,
    configurationProfile: reference.configurationProfile(),
    probe,
    invocation,
    environment,
    events,
  }, checkoutRoot), checkoutRoot);
}

const PRODUCERS: Array<[string, Factory, ProducerDescriptor]> = [
  ["pi", deps => new PiAdapter(deps), piDescriptor],
  ["opencode", deps => new OpenCodeAdapter(deps), openCodeDescriptor],
  ["agy", deps => new AgyAdapter(deps), agyDescriptor],
  ["pythinker", deps => new PythinkerAdapter(deps), pythinkerDescriptor],
  ["claude", deps => new ClaudeAdapter(deps), claudeDescriptor],
  ["codex", deps => new CodexAdapter(deps), codexDescriptor],
];

describe("Producer Adapter characterization is independent of the checkout path", () => {
  it.each(PRODUCERS)("%s records the same characterization from two checkout roots", async (
    _name,
    factory,
    descriptor,
  ) => {
    const here = await characterize(factory, descriptor);
    const elsewhere = await characterize(factory, descriptor, "/other/checkout/root/");
    expect(elsewhere).toEqual(here);
  });
});

describe("Producer Adapter characterization (descriptor migration guard)", () => {
  it("pi", async () => {
    expect(await characterize(deps => new PiAdapter(deps), piDescriptor)).toMatchInlineSnapshot(`
      {
        "configurationProfile": {
          "behavioralConfigSources": [
            "~/.pi/agent/settings.json",
            "~/.pi/agent/models.json",
          ],
          "credentialSources": [
            "~/.pi/agent/auth.json",
          ],
          "environmentDependencies": [
            "PI_API_KEY",
          ],
          "isolationState": "inherited-config-only",
          "repositoryInstructionSources": [
            "worktree AGENTS.md",
          ],
          "temporaryHomeStrategy": "real HOME inherited by declared policy; reduced reproducibility recorded in the Run Manifest",
        },
        "environment": {
          "homeSetAuthed": {
            "env": {},
            "inheritedStateWritablePaths": [
              "/home/char/.pi/agent",
            ],
            "network": "allowed",
            "requiredEnv": [
              "PI_API_KEY",
            ],
          },
          "homeUnsetConfigPresent": {
            "env": {
              "HOME": "/home/char",
            },
            "inheritedStateWritablePaths": [
              "/home/char/.pi/agent",
            ],
            "network": "allowed",
            "requiredEnv": [
              "PI_API_KEY",
            ],
          },
          "homeUnsetNothing": {
            "env": {},
            "inheritedStateWritablePaths": [
              "/home/char/.pi/agent",
            ],
            "network": "allowed",
            "requiredEnv": [
              "PI_API_KEY",
            ],
          },
          "overridesSet": {
            "env": {},
            "inheritedStateWritablePaths": [
              "/home/override/.pi/agent",
            ],
            "network": "allowed",
            "requiredEnv": [
              "PI_API_KEY",
            ],
          },
          "userProfileOnly": {
            "env": {
              "HOME": "/home/char",
            },
            "inheritedStateWritablePaths": [
              "/profile/char/.pi/agent",
            ],
            "network": "allowed",
            "requiredEnv": [
              "PI_API_KEY",
            ],
          },
        },
        "events": {
          "agyError": {
            "events": [
              {
                "kind": "final",
                "text": "{"status":"ERROR","response":"agy failed"}",
              },
            ],
            "ok": true,
            "producerSummary": "{"status":"ERROR","response":"agy failed"}",
          },
          "agyNoResponse": {
            "events": [
              {
                "kind": "final",
                "text": "{"status":"SUCCESS"}",
              },
            ],
            "ok": true,
            "producerSummary": "{"status":"SUCCESS"}",
          },
          "agySuccess": {
            "events": [
              {
                "kind": "final",
                "text": "{"status":"SUCCESS","response":"agy done"}",
              },
            ],
            "ok": true,
            "producerSummary": "{"status":"SUCCESS","response":"agy done"}",
          },
          "claudeError": {
            "events": [
              {
                "kind": "error",
                "text": "err",
              },
            ],
            "ok": false,
            "producerSummary": null,
          },
          "claudeSuccess": {
            "events": [
              {
                "kind": "final",
                "text": "warning
      {"type":"result","subtype":"success","is_error":false,"result":"claude done"}",
              },
            ],
            "ok": true,
            "producerSummary": "warning
      {"type":"result","subtype":"success","is_error":false,"result":"claude done"}",
          },
          "codexFailed": {
            "events": [
              {
                "kind": "error",
                "text": "",
              },
            ],
            "ok": false,
            "producerSummary": null,
          },
          "codexMalformed": {
            "events": [
              {
                "kind": "final",
                "text": "{"type":"turn.completed"}
      not json",
              },
            ],
            "ok": true,
            "producerSummary": "{"type":"turn.completed"}
      not json",
          },
          "codexMessageWithoutText": {
            "events": [
              {
                "kind": "final",
                "text": "{"type":"item.completed","item":{"type":"agent_message"}}
      {"type":"turn.completed"}",
              },
            ],
            "ok": true,
            "producerSummary": "{"type":"item.completed","item":{"type":"agent_message"}}
      {"type":"turn.completed"}",
          },
          "codexSuccess": {
            "events": [
              {
                "kind": "final",
                "text": "sha256:b227d237f1471e0c572c81d64fb9c987da757d54016f7682ea3337feec57a6ae",
              },
            ],
            "ok": true,
            "producerSummary": "sha256:b227d237f1471e0c572c81d64fb9c987da757d54016f7682ea3337feec57a6ae",
          },
          "emptySuccess": {
            "events": [],
            "ok": false,
            "producerSummary": null,
          },
          "nonzeroExit": {
            "events": [
              {
                "kind": "error",
                "text": "boom",
              },
            ],
            "ok": false,
            "producerSummary": null,
          },
          "plainLong": {
            "events": [
              {
                "kind": "final",
                "text": "sha256:f16355ccd00a5b021a29e971c88d56060acebef2e0a57330cff99b6e4878bb18",
              },
            ],
            "ok": true,
            "producerSummary": "sha256:f16355ccd00a5b021a29e971c88d56060acebef2e0a57330cff99b6e4878bb18",
          },
          "plainSuccess": {
            "events": [
              {
                "kind": "final",
                "text": "Done.",
              },
            ],
            "ok": true,
            "producerSummary": "Done.",
          },
          "truncated": {
            "events": [
              {
                "kind": "error",
                "text": "stdout-truncated",
              },
            ],
            "ok": false,
            "producerSummary": null,
          },
        },
        "identity": {
          "descriptorIsExported": true,
          "executionModes": [
            "edit",
          ],
          "producerId": "pi",
          "structuredOutput": false,
        },
        "invocation": {
          "base": {
            "args": [
              "-p",
              "--no-session",
              "--no-skills",
              "--tools",
              "read,bash,edit,write,grep,find,ls",
            ],
            "env": {},
            "executable": {
              "command": "/nonexistent/claude-architect-characterization/cli",
              "kind": "native",
              "prefixArgs": [],
              "resolvedFrom": "characterization",
            },
            "inheritedStateWritablePaths": [
              "/home/char/.pi/agent",
            ],
            "network": "allowed",
            "requiredEnv": [
              "PI_API_KEY",
            ],
            "stdin": "sha256:2d833852f36a3d6339192342faa20c721f577bc09590311ac3c49416f3b6a23c",
          },
          "effortHigh": {
            "args": [
              "-p",
              "--no-session",
              "--no-skills",
              "--tools",
              "read,bash,edit,write,grep,find,ls",
              "--thinking",
              "high",
            ],
            "env": {},
            "executable": {
              "command": "/nonexistent/claude-architect-characterization/cli",
              "kind": "native",
              "prefixArgs": [],
              "resolvedFrom": "characterization",
            },
            "inheritedStateWritablePaths": [
              "/home/char/.pi/agent",
            ],
            "network": "allowed",
            "requiredEnv": [
              "PI_API_KEY",
            ],
            "stdin": "sha256:2d833852f36a3d6339192342faa20c721f577bc09590311ac3c49416f3b6a23c",
          },
          "effortInvalid": {
            "args": [
              "-p",
              "--no-session",
              "--no-skills",
              "--tools",
              "read,bash,edit,write,grep,find,ls",
              "--thinking",
              "turbo",
            ],
            "env": {},
            "executable": {
              "command": "/nonexistent/claude-architect-characterization/cli",
              "kind": "native",
              "prefixArgs": [],
              "resolvedFrom": "characterization",
            },
            "inheritedStateWritablePaths": [
              "/home/char/.pi/agent",
            ],
            "network": "allowed",
            "requiredEnv": [
              "PI_API_KEY",
            ],
            "stdin": "sha256:2d833852f36a3d6339192342faa20c721f577bc09590311ac3c49416f3b6a23c",
          },
          "gitRedirect": {
            "args": [
              "-p",
              "--no-session",
              "--no-skills",
              "--tools",
              "read,bash,edit,write,grep,find,ls",
            ],
            "env": {},
            "executable": {
              "command": "/nonexistent/claude-architect-characterization/cli",
              "kind": "native",
              "prefixArgs": [],
              "resolvedFrom": "characterization",
            },
            "inheritedStateWritablePaths": [
              "/home/char/.pi/agent",
            ],
            "network": "allowed",
            "requiredEnv": [
              "PI_API_KEY",
            ],
            "stdin": "sha256:2d833852f36a3d6339192342faa20c721f577bc09590311ac3c49416f3b6a23c",
          },
          "gitRedirectReadOnly": {
            "args": [
              "-p",
              "--no-session",
              "--no-skills",
              "--tools",
              "read,bash,edit,write,grep,find,ls",
            ],
            "env": {},
            "executable": {
              "command": "/nonexistent/claude-architect-characterization/cli",
              "kind": "native",
              "prefixArgs": [],
              "resolvedFrom": "characterization",
            },
            "inheritedStateWritablePaths": [
              "/home/char/.pi/agent",
            ],
            "network": "allowed",
            "requiredEnv": [
              "PI_API_KEY",
            ],
            "stdin": "sha256:eefd09a87d2a7749a560d263d0fc4787a457c2e8c7066fa6a749b03c09a988c2",
          },
          "model": {
            "error": "Pi model override is unsupported: the pi lane always uses the model configured in Pi.",
          },
          "modelAndEffort": {
            "error": "Pi model override is unsupported: the pi lane always uses the model configured in Pi.",
          },
          "readOnly": {
            "args": [
              "-p",
              "--no-session",
              "--no-skills",
              "--tools",
              "read,bash,edit,write,grep,find,ls",
            ],
            "env": {},
            "executable": {
              "command": "/nonexistent/claude-architect-characterization/cli",
              "kind": "native",
              "prefixArgs": [],
              "resolvedFrom": "characterization",
            },
            "inheritedStateWritablePaths": [
              "/home/char/.pi/agent",
            ],
            "network": "allowed",
            "requiredEnv": [
              "PI_API_KEY",
            ],
            "stdin": "sha256:eefd09a87d2a7749a560d263d0fc4787a457c2e8c7066fa6a749b03c09a988c2",
          },
        },
        "probe": {
          "bareHelp": {
            "report": {
              "arch": "arm64",
              "authState": "authenticated",
              "available": true,
              "environmentType": "native",
              "executionModes": [
                "edit",
              ],
              "laneEligibility": {
                "edit": true,
              },
              "os": "darwin",
              "producerId": "pi",
              "reason": null,
              "resolvedExecutable": {
                "command": "/nonexistent/claude-architect-characterization/cli",
                "kind": "native",
                "prefixArgs": [],
                "resolvedFrom": "characterization",
              },
              "structuredOutput": false,
              "version": "1.2.3",
              "writeConfinementBackend": "macos-seatbelt",
            },
            "spawned": [
              [
                "--version",
              ],
            ],
          },
          "darwinAuthed": {
            "report": {
              "arch": "arm64",
              "authState": "authenticated",
              "available": true,
              "environmentType": "native",
              "executionModes": [
                "edit",
              ],
              "laneEligibility": {
                "edit": true,
              },
              "os": "darwin",
              "producerId": "pi",
              "reason": null,
              "resolvedExecutable": {
                "command": "/nonexistent/claude-architect-characterization/cli",
                "kind": "native",
                "prefixArgs": [],
                "resolvedFrom": "characterization",
              },
              "structuredOutput": false,
              "version": "1.2.3",
              "writeConfinementBackend": "macos-seatbelt",
            },
            "spawned": [
              [
                "--version",
              ],
            ],
          },
          "darwinEnvKeys": {
            "report": {
              "arch": "x64",
              "authState": "unauthenticated",
              "available": true,
              "environmentType": "native",
              "executionModes": [
                "edit",
              ],
              "laneEligibility": {
                "edit": false,
              },
              "os": "darwin",
              "producerId": "pi",
              "reason": null,
              "resolvedExecutable": {
                "command": "/nonexistent/claude-architect-characterization/cli",
                "kind": "native",
                "prefixArgs": [],
                "resolvedFrom": "characterization",
              },
              "structuredOutput": false,
              "version": "1.2.3",
              "writeConfinementBackend": null,
            },
            "spawned": [
              [
                "--version",
              ],
            ],
          },
          "darwinUnauthed": {
            "report": {
              "arch": "arm64",
              "authState": "unauthenticated",
              "available": true,
              "environmentType": "native",
              "executionModes": [
                "edit",
              ],
              "laneEligibility": {
                "edit": true,
              },
              "os": "darwin",
              "producerId": "pi",
              "reason": null,
              "resolvedExecutable": {
                "command": "/nonexistent/claude-architect-characterization/cli",
                "kind": "native",
                "prefixArgs": [],
                "resolvedFrom": "characterization",
              },
              "structuredOutput": false,
              "version": "1.2.3",
              "writeConfinementBackend": "macos-seatbelt",
            },
            "spawned": [
              [
                "--version",
              ],
            ],
          },
          "linuxNative": {
            "report": {
              "arch": "x64",
              "authState": "authenticated",
              "available": true,
              "environmentType": "native",
              "executionModes": [
                "edit",
              ],
              "laneEligibility": {
                "edit": false,
              },
              "os": "linux",
              "producerId": "pi",
              "reason": null,
              "resolvedExecutable": {
                "command": "/nonexistent/claude-architect-characterization/cli",
                "kind": "native",
                "prefixArgs": [],
                "resolvedFrom": "characterization",
              },
              "structuredOutput": false,
              "version": "1.2.3",
              "writeConfinementBackend": null,
            },
            "spawned": [
              [
                "--version",
              ],
            ],
          },
          "linuxWsl": {
            "report": {
              "arch": "x64",
              "authState": "authenticated",
              "available": true,
              "environmentType": "wsl",
              "executionModes": [
                "edit",
              ],
              "laneEligibility": {
                "edit": false,
              },
              "os": "linux",
              "producerId": "pi",
              "reason": null,
              "resolvedExecutable": {
                "command": "/nonexistent/claude-architect-characterization/cli",
                "kind": "native",
                "prefixArgs": [],
                "resolvedFrom": "characterization",
              },
              "structuredOutput": false,
              "version": "1.2.3",
              "writeConfinementBackend": null,
            },
            "spawned": [
              [
                "--version",
              ],
            ],
          },
          "missingExecutable": {
            "report": {
              "arch": "arm64",
              "authState": "unknown",
              "available": false,
              "environmentType": "native",
              "executionModes": [
                "edit",
              ],
              "laneEligibility": {
                "edit": false,
              },
              "os": "darwin",
              "producerId": "pi",
              "reason": "missing-executable",
              "resolvedExecutable": null,
              "structuredOutput": false,
              "version": null,
              "writeConfinementBackend": null,
            },
            "spawned": [],
          },
          "prefixedVersion": {
            "report": {
              "arch": "arm64",
              "authState": "unknown",
              "available": false,
              "environmentType": "native",
              "executionModes": [
                "edit",
              ],
              "laneEligibility": {
                "edit": false,
              },
              "os": "darwin",
              "producerId": "pi",
              "reason": "probe-failed",
              "resolvedExecutable": {
                "command": "/nonexistent/claude-architect-characterization/cli",
                "kind": "native",
                "prefixArgs": [],
                "resolvedFrom": "characterization",
              },
              "structuredOutput": false,
              "version": null,
              "writeConfinementBackend": null,
            },
            "spawned": [
              [
                "--version",
              ],
            ],
          },
          "unparseableVersion": {
            "report": {
              "arch": "arm64",
              "authState": "unknown",
              "available": false,
              "environmentType": "native",
              "executionModes": [
                "edit",
              ],
              "laneEligibility": {
                "edit": false,
              },
              "os": "darwin",
              "producerId": "pi",
              "reason": "probe-failed",
              "resolvedExecutable": {
                "command": "/nonexistent/claude-architect-characterization/cli",
                "kind": "native",
                "prefixArgs": [],
                "resolvedFrom": "characterization",
              },
              "structuredOutput": false,
              "version": null,
              "writeConfinementBackend": null,
            },
            "spawned": [
              [
                "--version",
              ],
            ],
          },
          "win32": {
            "report": {
              "arch": "x64",
              "authState": "unknown",
              "available": false,
              "environmentType": "native",
              "executionModes": [
                "edit",
              ],
              "laneEligibility": {
                "edit": false,
              },
              "os": "win32",
              "producerId": "pi",
              "reason": "unsupported-platform",
              "resolvedExecutable": null,
              "structuredOutput": false,
              "version": null,
              "writeConfinementBackend": null,
            },
            "spawned": [],
          },
        },
      }
    `);
  });

  it("opencode", async () => {
    expect(await characterize(deps => new OpenCodeAdapter(deps), openCodeDescriptor))
      .toMatchInlineSnapshot(`
        {
          "configurationProfile": {
            "behavioralConfigSources": [
              "explicit invocation argv",
            ],
            "credentialSources": [
              "~/.local/share/opencode/auth.json",
            ],
            "environmentDependencies": [
              "OPENCODE_CONFIG_DIR",
              "XDG_DATA_HOME",
            ],
            "isolationState": "controlled-config-with-copied-credentials",
            "repositoryInstructionSources": [
              "worktree AGENTS.md",
            ],
            "temporaryHomeStrategy": "temp HOME with XDG_DATA_HOME passthrough for the auth store",
          },
          "environment": {
            "homeSetAuthed": {
              "env": {
                "XDG_DATA_HOME": "/home/char/.local/share",
              },
              "inheritedStateWritablePaths": [
                "/home/char/.local/share/opencode",
                "/home/char/.local/state/opencode",
              ],
              "network": "allowed",
              "requiredEnv": [
                "OPENCODE_CONFIG_DIR",
                "XDG_DATA_HOME",
              ],
            },
            "homeUnsetConfigPresent": {
              "env": {
                "XDG_DATA_HOME": "/home/char/.local/share",
              },
              "inheritedStateWritablePaths": [
                "/home/char/.local/share/opencode",
                "/home/char/.local/state/opencode",
              ],
              "network": "allowed",
              "requiredEnv": [
                "OPENCODE_CONFIG_DIR",
                "XDG_DATA_HOME",
              ],
            },
            "homeUnsetNothing": {
              "env": {},
              "inheritedStateWritablePaths": [
                "/home/char/.local/share/opencode",
                "/home/char/.local/state/opencode",
              ],
              "network": "allowed",
              "requiredEnv": [
                "OPENCODE_CONFIG_DIR",
                "XDG_DATA_HOME",
              ],
            },
            "overridesSet": {
              "env": {},
              "inheritedStateWritablePaths": [
                "/xdg/data/opencode",
                "/xdg/state/opencode",
              ],
              "network": "allowed",
              "requiredEnv": [
                "OPENCODE_CONFIG_DIR",
                "XDG_DATA_HOME",
              ],
            },
            "userProfileOnly": {
              "env": {},
              "inheritedStateWritablePaths": [
                "/home/char/.local/share/opencode",
                "/home/char/.local/state/opencode",
              ],
              "network": "allowed",
              "requiredEnv": [
                "OPENCODE_CONFIG_DIR",
                "XDG_DATA_HOME",
              ],
            },
          },
          "events": {
            "agyError": {
              "events": [
                {
                  "kind": "final",
                  "text": "{"status":"ERROR","response":"agy failed"}",
                },
              ],
              "ok": true,
              "producerSummary": "{"status":"ERROR","response":"agy failed"}",
            },
            "agyNoResponse": {
              "events": [
                {
                  "kind": "final",
                  "text": "{"status":"SUCCESS"}",
                },
              ],
              "ok": true,
              "producerSummary": "{"status":"SUCCESS"}",
            },
            "agySuccess": {
              "events": [
                {
                  "kind": "final",
                  "text": "{"status":"SUCCESS","response":"agy done"}",
                },
              ],
              "ok": true,
              "producerSummary": "{"status":"SUCCESS","response":"agy done"}",
            },
            "claudeError": {
              "events": [
                {
                  "kind": "error",
                  "text": "err",
                },
              ],
              "ok": false,
              "producerSummary": null,
            },
            "claudeSuccess": {
              "events": [
                {
                  "kind": "final",
                  "text": "warning
        {"type":"result","subtype":"success","is_error":false,"result":"claude done"}",
                },
              ],
              "ok": true,
              "producerSummary": "warning
        {"type":"result","subtype":"success","is_error":false,"result":"claude done"}",
            },
            "codexFailed": {
              "events": [
                {
                  "kind": "error",
                  "text": "",
                },
              ],
              "ok": false,
              "producerSummary": null,
            },
            "codexMalformed": {
              "events": [
                {
                  "kind": "final",
                  "text": "{"type":"turn.completed"}
        not json",
                },
              ],
              "ok": true,
              "producerSummary": "{"type":"turn.completed"}
        not json",
            },
            "codexMessageWithoutText": {
              "events": [
                {
                  "kind": "final",
                  "text": "{"type":"item.completed","item":{"type":"agent_message"}}
        {"type":"turn.completed"}",
                },
              ],
              "ok": true,
              "producerSummary": "{"type":"item.completed","item":{"type":"agent_message"}}
        {"type":"turn.completed"}",
            },
            "codexSuccess": {
              "events": [
                {
                  "kind": "final",
                  "text": "sha256:b227d237f1471e0c572c81d64fb9c987da757d54016f7682ea3337feec57a6ae",
                },
              ],
              "ok": true,
              "producerSummary": "sha256:b227d237f1471e0c572c81d64fb9c987da757d54016f7682ea3337feec57a6ae",
            },
            "emptySuccess": {
              "events": [],
              "ok": false,
              "producerSummary": null,
            },
            "nonzeroExit": {
              "events": [
                {
                  "kind": "error",
                  "text": "boom",
                },
              ],
              "ok": false,
              "producerSummary": null,
            },
            "plainLong": {
              "events": [
                {
                  "kind": "final",
                  "text": "sha256:f16355ccd00a5b021a29e971c88d56060acebef2e0a57330cff99b6e4878bb18",
                },
              ],
              "ok": true,
              "producerSummary": "sha256:f16355ccd00a5b021a29e971c88d56060acebef2e0a57330cff99b6e4878bb18",
            },
            "plainSuccess": {
              "events": [
                {
                  "kind": "final",
                  "text": "Done.",
                },
              ],
              "ok": true,
              "producerSummary": "Done.",
            },
            "truncated": {
              "events": [
                {
                  "kind": "error",
                  "text": "stdout-truncated",
                },
              ],
              "ok": false,
              "producerSummary": null,
            },
          },
          "identity": {
            "descriptorIsExported": true,
            "executionModes": [
              "edit",
            ],
            "producerId": "opencode",
            "structuredOutput": false,
          },
          "invocation": {
            "base": {
              "args": [
                "run",
                "--dir",
                "/work/tree",
                "--agent",
                "build",
                "--auto",
                "--log-level",
                "ERROR",
              ],
              "env": {
                "XDG_DATA_HOME": "/home/char/.local/share",
              },
              "executable": {
                "command": "/nonexistent/claude-architect-characterization/cli",
                "kind": "native",
                "prefixArgs": [],
                "resolvedFrom": "characterization",
              },
              "inheritedStateWritablePaths": [
                "/home/char/.local/share/opencode",
                "/home/char/.local/state/opencode",
              ],
              "network": "allowed",
              "requiredEnv": [
                "OPENCODE_CONFIG_DIR",
                "XDG_DATA_HOME",
              ],
              "stdin": "sha256:2d833852f36a3d6339192342faa20c721f577bc09590311ac3c49416f3b6a23c",
            },
            "effortHigh": {
              "args": [
                "run",
                "--dir",
                "/work/tree",
                "--agent",
                "build",
                "--auto",
                "--log-level",
                "ERROR",
              ],
              "env": {
                "XDG_DATA_HOME": "/home/char/.local/share",
              },
              "executable": {
                "command": "/nonexistent/claude-architect-characterization/cli",
                "kind": "native",
                "prefixArgs": [],
                "resolvedFrom": "characterization",
              },
              "inheritedStateWritablePaths": [
                "/home/char/.local/share/opencode",
                "/home/char/.local/state/opencode",
              ],
              "network": "allowed",
              "requiredEnv": [
                "OPENCODE_CONFIG_DIR",
                "XDG_DATA_HOME",
              ],
              "stdin": "sha256:2d833852f36a3d6339192342faa20c721f577bc09590311ac3c49416f3b6a23c",
            },
            "effortInvalid": {
              "args": [
                "run",
                "--dir",
                "/work/tree",
                "--agent",
                "build",
                "--auto",
                "--log-level",
                "ERROR",
              ],
              "env": {
                "XDG_DATA_HOME": "/home/char/.local/share",
              },
              "executable": {
                "command": "/nonexistent/claude-architect-characterization/cli",
                "kind": "native",
                "prefixArgs": [],
                "resolvedFrom": "characterization",
              },
              "inheritedStateWritablePaths": [
                "/home/char/.local/share/opencode",
                "/home/char/.local/state/opencode",
              ],
              "network": "allowed",
              "requiredEnv": [
                "OPENCODE_CONFIG_DIR",
                "XDG_DATA_HOME",
              ],
              "stdin": "sha256:2d833852f36a3d6339192342faa20c721f577bc09590311ac3c49416f3b6a23c",
            },
            "gitRedirect": {
              "args": [
                "run",
                "--dir",
                "/work/tree",
                "--agent",
                "build",
                "--auto",
                "--log-level",
                "ERROR",
              ],
              "env": {
                "XDG_DATA_HOME": "/home/char/.local/share",
              },
              "executable": {
                "command": "/nonexistent/claude-architect-characterization/cli",
                "kind": "native",
                "prefixArgs": [],
                "resolvedFrom": "characterization",
              },
              "inheritedStateWritablePaths": [
                "/home/char/.local/share/opencode",
                "/home/char/.local/state/opencode",
              ],
              "network": "allowed",
              "requiredEnv": [
                "OPENCODE_CONFIG_DIR",
                "XDG_DATA_HOME",
              ],
              "stdin": "sha256:2d833852f36a3d6339192342faa20c721f577bc09590311ac3c49416f3b6a23c",
            },
            "gitRedirectReadOnly": {
              "args": [
                "run",
                "--dir",
                "/work/tree",
                "--agent",
                "build",
                "--auto",
                "--log-level",
                "ERROR",
              ],
              "env": {
                "XDG_DATA_HOME": "/home/char/.local/share",
              },
              "executable": {
                "command": "/nonexistent/claude-architect-characterization/cli",
                "kind": "native",
                "prefixArgs": [],
                "resolvedFrom": "characterization",
              },
              "inheritedStateWritablePaths": [
                "/home/char/.local/share/opencode",
                "/home/char/.local/state/opencode",
              ],
              "network": "allowed",
              "requiredEnv": [
                "OPENCODE_CONFIG_DIR",
                "XDG_DATA_HOME",
              ],
              "stdin": "sha256:eefd09a87d2a7749a560d263d0fc4787a457c2e8c7066fa6a749b03c09a988c2",
            },
            "model": {
              "args": [
                "run",
                "--dir",
                "/work/tree",
                "--agent",
                "build",
                "--auto",
                "--log-level",
                "ERROR",
                "--model",
                "model-x",
              ],
              "env": {
                "XDG_DATA_HOME": "/home/char/.local/share",
              },
              "executable": {
                "command": "/nonexistent/claude-architect-characterization/cli",
                "kind": "native",
                "prefixArgs": [],
                "resolvedFrom": "characterization",
              },
              "inheritedStateWritablePaths": [
                "/home/char/.local/share/opencode",
                "/home/char/.local/state/opencode",
              ],
              "network": "allowed",
              "requiredEnv": [
                "OPENCODE_CONFIG_DIR",
                "XDG_DATA_HOME",
              ],
              "stdin": "sha256:2d833852f36a3d6339192342faa20c721f577bc09590311ac3c49416f3b6a23c",
            },
            "modelAndEffort": {
              "args": [
                "run",
                "--dir",
                "/work/tree",
                "--agent",
                "build",
                "--auto",
                "--log-level",
                "ERROR",
                "--model",
                "model-y",
              ],
              "env": {
                "XDG_DATA_HOME": "/home/char/.local/share",
              },
              "executable": {
                "command": "/nonexistent/claude-architect-characterization/cli",
                "kind": "native",
                "prefixArgs": [],
                "resolvedFrom": "characterization",
              },
              "inheritedStateWritablePaths": [
                "/home/char/.local/share/opencode",
                "/home/char/.local/state/opencode",
              ],
              "network": "allowed",
              "requiredEnv": [
                "OPENCODE_CONFIG_DIR",
                "XDG_DATA_HOME",
              ],
              "stdin": "sha256:2d833852f36a3d6339192342faa20c721f577bc09590311ac3c49416f3b6a23c",
            },
            "readOnly": {
              "args": [
                "run",
                "--dir",
                "/work/tree",
                "--agent",
                "build",
                "--auto",
                "--log-level",
                "ERROR",
              ],
              "env": {
                "XDG_DATA_HOME": "/home/char/.local/share",
              },
              "executable": {
                "command": "/nonexistent/claude-architect-characterization/cli",
                "kind": "native",
                "prefixArgs": [],
                "resolvedFrom": "characterization",
              },
              "inheritedStateWritablePaths": [
                "/home/char/.local/share/opencode",
                "/home/char/.local/state/opencode",
              ],
              "network": "allowed",
              "requiredEnv": [
                "OPENCODE_CONFIG_DIR",
                "XDG_DATA_HOME",
              ],
              "stdin": "sha256:eefd09a87d2a7749a560d263d0fc4787a457c2e8c7066fa6a749b03c09a988c2",
            },
          },
          "probe": {
            "bareHelp": {
              "report": {
                "arch": "arm64",
                "authState": "authenticated",
                "available": true,
                "environmentType": "native",
                "executionModes": [
                  "edit",
                ],
                "laneEligibility": {
                  "edit": true,
                },
                "os": "darwin",
                "producerId": "opencode",
                "reason": null,
                "resolvedExecutable": {
                  "command": "/nonexistent/claude-architect-characterization/cli",
                  "kind": "native",
                  "prefixArgs": [],
                  "resolvedFrom": "characterization",
                },
                "structuredOutput": false,
                "version": "1.2.3",
                "writeConfinementBackend": "macos-seatbelt",
              },
              "spawned": [
                [
                  "--version",
                ],
              ],
            },
            "darwinAuthed": {
              "report": {
                "arch": "arm64",
                "authState": "authenticated",
                "available": true,
                "environmentType": "native",
                "executionModes": [
                  "edit",
                ],
                "laneEligibility": {
                  "edit": true,
                },
                "os": "darwin",
                "producerId": "opencode",
                "reason": null,
                "resolvedExecutable": {
                  "command": "/nonexistent/claude-architect-characterization/cli",
                  "kind": "native",
                  "prefixArgs": [],
                  "resolvedFrom": "characterization",
                },
                "structuredOutput": false,
                "version": "1.2.3",
                "writeConfinementBackend": "macos-seatbelt",
              },
              "spawned": [
                [
                  "--version",
                ],
              ],
            },
            "darwinEnvKeys": {
              "report": {
                "arch": "x64",
                "authState": "unauthenticated",
                "available": true,
                "environmentType": "native",
                "executionModes": [
                  "edit",
                ],
                "laneEligibility": {
                  "edit": false,
                },
                "os": "darwin",
                "producerId": "opencode",
                "reason": null,
                "resolvedExecutable": {
                  "command": "/nonexistent/claude-architect-characterization/cli",
                  "kind": "native",
                  "prefixArgs": [],
                  "resolvedFrom": "characterization",
                },
                "structuredOutput": false,
                "version": "1.2.3",
                "writeConfinementBackend": null,
              },
              "spawned": [
                [
                  "--version",
                ],
              ],
            },
            "darwinUnauthed": {
              "report": {
                "arch": "arm64",
                "authState": "unauthenticated",
                "available": true,
                "environmentType": "native",
                "executionModes": [
                  "edit",
                ],
                "laneEligibility": {
                  "edit": true,
                },
                "os": "darwin",
                "producerId": "opencode",
                "reason": null,
                "resolvedExecutable": {
                  "command": "/nonexistent/claude-architect-characterization/cli",
                  "kind": "native",
                  "prefixArgs": [],
                  "resolvedFrom": "characterization",
                },
                "structuredOutput": false,
                "version": "1.2.3",
                "writeConfinementBackend": "macos-seatbelt",
              },
              "spawned": [
                [
                  "--version",
                ],
              ],
            },
            "linuxNative": {
              "report": {
                "arch": "x64",
                "authState": "authenticated",
                "available": true,
                "environmentType": "native",
                "executionModes": [
                  "edit",
                ],
                "laneEligibility": {
                  "edit": false,
                },
                "os": "linux",
                "producerId": "opencode",
                "reason": null,
                "resolvedExecutable": {
                  "command": "/nonexistent/claude-architect-characterization/cli",
                  "kind": "native",
                  "prefixArgs": [],
                  "resolvedFrom": "characterization",
                },
                "structuredOutput": false,
                "version": "1.2.3",
                "writeConfinementBackend": null,
              },
              "spawned": [
                [
                  "--version",
                ],
              ],
            },
            "linuxWsl": {
              "report": {
                "arch": "x64",
                "authState": "authenticated",
                "available": true,
                "environmentType": "wsl",
                "executionModes": [
                  "edit",
                ],
                "laneEligibility": {
                  "edit": false,
                },
                "os": "linux",
                "producerId": "opencode",
                "reason": null,
                "resolvedExecutable": {
                  "command": "/nonexistent/claude-architect-characterization/cli",
                  "kind": "native",
                  "prefixArgs": [],
                  "resolvedFrom": "characterization",
                },
                "structuredOutput": false,
                "version": "1.2.3",
                "writeConfinementBackend": null,
              },
              "spawned": [
                [
                  "--version",
                ],
              ],
            },
            "missingExecutable": {
              "report": {
                "arch": "arm64",
                "authState": "unknown",
                "available": false,
                "environmentType": "native",
                "executionModes": [
                  "edit",
                ],
                "laneEligibility": {
                  "edit": false,
                },
                "os": "darwin",
                "producerId": "opencode",
                "reason": "missing-executable",
                "resolvedExecutable": null,
                "structuredOutput": false,
                "version": null,
                "writeConfinementBackend": null,
              },
              "spawned": [],
            },
            "prefixedVersion": {
              "report": {
                "arch": "arm64",
                "authState": "unknown",
                "available": false,
                "environmentType": "native",
                "executionModes": [
                  "edit",
                ],
                "laneEligibility": {
                  "edit": false,
                },
                "os": "darwin",
                "producerId": "opencode",
                "reason": "probe-failed",
                "resolvedExecutable": {
                  "command": "/nonexistent/claude-architect-characterization/cli",
                  "kind": "native",
                  "prefixArgs": [],
                  "resolvedFrom": "characterization",
                },
                "structuredOutput": false,
                "version": null,
                "writeConfinementBackend": null,
              },
              "spawned": [
                [
                  "--version",
                ],
              ],
            },
            "unparseableVersion": {
              "report": {
                "arch": "arm64",
                "authState": "unknown",
                "available": false,
                "environmentType": "native",
                "executionModes": [
                  "edit",
                ],
                "laneEligibility": {
                  "edit": false,
                },
                "os": "darwin",
                "producerId": "opencode",
                "reason": "probe-failed",
                "resolvedExecutable": {
                  "command": "/nonexistent/claude-architect-characterization/cli",
                  "kind": "native",
                  "prefixArgs": [],
                  "resolvedFrom": "characterization",
                },
                "structuredOutput": false,
                "version": null,
                "writeConfinementBackend": null,
              },
              "spawned": [
                [
                  "--version",
                ],
              ],
            },
            "win32": {
              "report": {
                "arch": "x64",
                "authState": "unknown",
                "available": false,
                "environmentType": "native",
                "executionModes": [
                  "edit",
                ],
                "laneEligibility": {
                  "edit": false,
                },
                "os": "win32",
                "producerId": "opencode",
                "reason": "unsupported-platform",
                "resolvedExecutable": null,
                "structuredOutput": false,
                "version": null,
                "writeConfinementBackend": null,
              },
              "spawned": [],
            },
          },
        }
      `);
  });

  it("agy", async () => {
    expect(await characterize(deps => new AgyAdapter(deps), agyDescriptor)).toMatchInlineSnapshot(`
      {
        "configurationProfile": {
          "behavioralConfigSources": [
            "~/.gemini/antigravity-cli/settings.json",
            "explicit invocation argv",
          ],
          "credentialSources": [
            "macOS Keychain ("Antigravity IDE Safe Storage")",
            "GEMINI_API_KEY (optional, unconfirmed CI semantics)",
          ],
          "environmentDependencies": [
            "GEMINI_API_KEY",
          ],
          "isolationState": "inherited-config-only",
          "repositoryInstructionSources": [
            "worktree AGENTS.md",
          ],
          "temporaryHomeStrategy": "real HOME inherited by declared policy (keyring auth is not HOME-redirectable); reduced reproducibility recorded in the Run Manifest",
        },
        "environment": {
          "homeSetAuthed": {
            "env": undefined,
            "inheritedStateWritablePaths": [
              "/home/char/.gemini/antigravity-cli",
            ],
            "network": "allowed",
            "requiredEnv": [
              "GEMINI_API_KEY",
            ],
          },
          "homeUnsetConfigPresent": {
            "env": undefined,
            "inheritedStateWritablePaths": [
              "/home/char/.gemini/antigravity-cli",
            ],
            "network": "allowed",
            "requiredEnv": [
              "GEMINI_API_KEY",
            ],
          },
          "homeUnsetNothing": {
            "env": undefined,
            "inheritedStateWritablePaths": [
              "/home/char/.gemini/antigravity-cli",
            ],
            "network": "allowed",
            "requiredEnv": [
              "GEMINI_API_KEY",
            ],
          },
          "overridesSet": {
            "env": undefined,
            "inheritedStateWritablePaths": [
              "/home/override/.gemini/antigravity-cli",
            ],
            "network": "allowed",
            "requiredEnv": [
              "GEMINI_API_KEY",
            ],
          },
          "userProfileOnly": {
            "env": undefined,
            "inheritedStateWritablePaths": [
              "/profile/char/.gemini/antigravity-cli",
            ],
            "network": "allowed",
            "requiredEnv": [
              "GEMINI_API_KEY",
            ],
          },
        },
        "events": {
          "agyError": {
            "events": [
              {
                "kind": "error",
                "raw": {
                  "response": "agy failed",
                  "status": "ERROR",
                },
                "text": "agy failed",
              },
            ],
            "ok": false,
            "producerSummary": null,
          },
          "agyNoResponse": {
            "events": [],
            "ok": false,
            "producerSummary": null,
          },
          "agySuccess": {
            "events": [
              {
                "kind": "final",
                "raw": {
                  "response": "agy done",
                  "status": "SUCCESS",
                },
                "text": "agy done",
              },
            ],
            "ok": true,
            "producerSummary": "agy done",
          },
          "claudeError": {
            "events": [
              {
                "kind": "error",
                "text": "err",
              },
            ],
            "ok": false,
            "producerSummary": null,
          },
          "claudeSuccess": {
            "events": [],
            "ok": false,
            "producerSummary": null,
          },
          "codexFailed": {
            "events": [
              {
                "kind": "error",
                "text": "",
              },
            ],
            "ok": false,
            "producerSummary": null,
          },
          "codexMalformed": {
            "events": [],
            "ok": false,
            "producerSummary": null,
          },
          "codexMessageWithoutText": {
            "events": [],
            "ok": false,
            "producerSummary": null,
          },
          "codexSuccess": {
            "events": [],
            "ok": false,
            "producerSummary": null,
          },
          "emptySuccess": {
            "events": [],
            "ok": false,
            "producerSummary": null,
          },
          "nonzeroExit": {
            "events": [
              {
                "kind": "error",
                "text": "boom",
              },
            ],
            "ok": false,
            "producerSummary": null,
          },
          "plainLong": {
            "events": [],
            "ok": false,
            "producerSummary": null,
          },
          "plainSuccess": {
            "events": [],
            "ok": false,
            "producerSummary": null,
          },
          "truncated": {
            "events": [],
            "ok": false,
            "producerSummary": null,
          },
        },
        "identity": {
          "descriptorIsExported": true,
          "executionModes": [
            "edit",
          ],
          "producerId": "agy",
          "structuredOutput": true,
        },
        "invocation": {
          "base": {
            "args": [
              "-p",
              "sha256:2d833852f36a3d6339192342faa20c721f577bc09590311ac3c49416f3b6a23c",
              "--add-dir",
              "/work/tree",
              "--new-project",
              "--output-format",
              "json",
              "--dangerously-skip-permissions",
              "--print-timeout",
              "91s",
            ],
            "executable": {
              "command": "/nonexistent/claude-architect-characterization/cli",
              "kind": "native",
              "prefixArgs": [],
              "resolvedFrom": "characterization",
            },
            "inheritedStateWritablePaths": [
              "/home/char/.gemini/antigravity-cli",
            ],
            "network": "allowed",
            "requiredEnv": [
              "GEMINI_API_KEY",
            ],
          },
          "effortHigh": {
            "args": [
              "-p",
              "sha256:2d833852f36a3d6339192342faa20c721f577bc09590311ac3c49416f3b6a23c",
              "--add-dir",
              "/work/tree",
              "--new-project",
              "--output-format",
              "json",
              "--dangerously-skip-permissions",
              "--print-timeout",
              "91s",
              "--effort",
              "high",
            ],
            "executable": {
              "command": "/nonexistent/claude-architect-characterization/cli",
              "kind": "native",
              "prefixArgs": [],
              "resolvedFrom": "characterization",
            },
            "inheritedStateWritablePaths": [
              "/home/char/.gemini/antigravity-cli",
            ],
            "network": "allowed",
            "requiredEnv": [
              "GEMINI_API_KEY",
            ],
          },
          "effortInvalid": {
            "args": [
              "-p",
              "sha256:2d833852f36a3d6339192342faa20c721f577bc09590311ac3c49416f3b6a23c",
              "--add-dir",
              "/work/tree",
              "--new-project",
              "--output-format",
              "json",
              "--dangerously-skip-permissions",
              "--print-timeout",
              "91s",
              "--effort",
              "turbo",
            ],
            "executable": {
              "command": "/nonexistent/claude-architect-characterization/cli",
              "kind": "native",
              "prefixArgs": [],
              "resolvedFrom": "characterization",
            },
            "inheritedStateWritablePaths": [
              "/home/char/.gemini/antigravity-cli",
            ],
            "network": "allowed",
            "requiredEnv": [
              "GEMINI_API_KEY",
            ],
          },
          "gitRedirect": {
            "args": [
              "-p",
              "sha256:2d833852f36a3d6339192342faa20c721f577bc09590311ac3c49416f3b6a23c",
              "--add-dir",
              "/work/tree",
              "--new-project",
              "--output-format",
              "json",
              "--dangerously-skip-permissions",
              "--print-timeout",
              "91s",
            ],
            "executable": {
              "command": "/nonexistent/claude-architect-characterization/cli",
              "kind": "native",
              "prefixArgs": [],
              "resolvedFrom": "characterization",
            },
            "inheritedStateWritablePaths": [
              "/home/char/.gemini/antigravity-cli",
            ],
            "network": "allowed",
            "requiredEnv": [
              "GEMINI_API_KEY",
            ],
          },
          "gitRedirectReadOnly": {
            "args": [
              "-p",
              "sha256:eefd09a87d2a7749a560d263d0fc4787a457c2e8c7066fa6a749b03c09a988c2",
              "--add-dir",
              "/work/tree",
              "--new-project",
              "--output-format",
              "json",
              "--dangerously-skip-permissions",
              "--print-timeout",
              "91s",
            ],
            "executable": {
              "command": "/nonexistent/claude-architect-characterization/cli",
              "kind": "native",
              "prefixArgs": [],
              "resolvedFrom": "characterization",
            },
            "inheritedStateWritablePaths": [
              "/home/char/.gemini/antigravity-cli",
            ],
            "network": "allowed",
            "requiredEnv": [
              "GEMINI_API_KEY",
            ],
          },
          "model": {
            "args": [
              "-p",
              "sha256:2d833852f36a3d6339192342faa20c721f577bc09590311ac3c49416f3b6a23c",
              "--add-dir",
              "/work/tree",
              "--new-project",
              "--output-format",
              "json",
              "--dangerously-skip-permissions",
              "--print-timeout",
              "91s",
              "--model",
              "model-x",
            ],
            "executable": {
              "command": "/nonexistent/claude-architect-characterization/cli",
              "kind": "native",
              "prefixArgs": [],
              "resolvedFrom": "characterization",
            },
            "inheritedStateWritablePaths": [
              "/home/char/.gemini/antigravity-cli",
            ],
            "network": "allowed",
            "requiredEnv": [
              "GEMINI_API_KEY",
            ],
          },
          "modelAndEffort": {
            "args": [
              "-p",
              "sha256:2d833852f36a3d6339192342faa20c721f577bc09590311ac3c49416f3b6a23c",
              "--add-dir",
              "/work/tree",
              "--new-project",
              "--output-format",
              "json",
              "--dangerously-skip-permissions",
              "--print-timeout",
              "91s",
              "--model",
              "model-y",
              "--effort",
              "low",
            ],
            "executable": {
              "command": "/nonexistent/claude-architect-characterization/cli",
              "kind": "native",
              "prefixArgs": [],
              "resolvedFrom": "characterization",
            },
            "inheritedStateWritablePaths": [
              "/home/char/.gemini/antigravity-cli",
            ],
            "network": "allowed",
            "requiredEnv": [
              "GEMINI_API_KEY",
            ],
          },
          "readOnly": {
            "args": [
              "-p",
              "sha256:eefd09a87d2a7749a560d263d0fc4787a457c2e8c7066fa6a749b03c09a988c2",
              "--add-dir",
              "/work/tree",
              "--new-project",
              "--output-format",
              "json",
              "--dangerously-skip-permissions",
              "--print-timeout",
              "91s",
            ],
            "executable": {
              "command": "/nonexistent/claude-architect-characterization/cli",
              "kind": "native",
              "prefixArgs": [],
              "resolvedFrom": "characterization",
            },
            "inheritedStateWritablePaths": [
              "/home/char/.gemini/antigravity-cli",
            ],
            "network": "allowed",
            "requiredEnv": [
              "GEMINI_API_KEY",
            ],
          },
        },
        "probe": {
          "bareHelp": {
            "report": {
              "arch": "arm64",
              "authState": "authenticated",
              "available": true,
              "environmentType": "native",
              "executionModes": [
                "edit",
              ],
              "laneEligibility": {
                "edit": true,
              },
              "os": "darwin",
              "producerId": "agy",
              "reason": null,
              "resolvedExecutable": {
                "command": "/nonexistent/claude-architect-characterization/cli",
                "kind": "native",
                "prefixArgs": [],
                "resolvedFrom": "characterization",
              },
              "structuredOutput": true,
              "version": "1.2.3",
              "writeConfinementBackend": "macos-seatbelt",
            },
            "spawned": [
              [
                "--version",
              ],
            ],
          },
          "darwinAuthed": {
            "report": {
              "arch": "arm64",
              "authState": "authenticated",
              "available": true,
              "environmentType": "native",
              "executionModes": [
                "edit",
              ],
              "laneEligibility": {
                "edit": true,
              },
              "os": "darwin",
              "producerId": "agy",
              "reason": null,
              "resolvedExecutable": {
                "command": "/nonexistent/claude-architect-characterization/cli",
                "kind": "native",
                "prefixArgs": [],
                "resolvedFrom": "characterization",
              },
              "structuredOutput": true,
              "version": "1.2.3",
              "writeConfinementBackend": "macos-seatbelt",
            },
            "spawned": [
              [
                "--version",
              ],
            ],
          },
          "darwinEnvKeys": {
            "report": {
              "arch": "x64",
              "authState": "authenticated",
              "available": true,
              "environmentType": "native",
              "executionModes": [
                "edit",
              ],
              "laneEligibility": {
                "edit": false,
              },
              "os": "darwin",
              "producerId": "agy",
              "reason": null,
              "resolvedExecutable": {
                "command": "/nonexistent/claude-architect-characterization/cli",
                "kind": "native",
                "prefixArgs": [],
                "resolvedFrom": "characterization",
              },
              "structuredOutput": true,
              "version": "1.2.3",
              "writeConfinementBackend": null,
            },
            "spawned": [
              [
                "--version",
              ],
            ],
          },
          "darwinUnauthed": {
            "report": {
              "arch": "arm64",
              "authState": "unauthenticated",
              "available": true,
              "environmentType": "native",
              "executionModes": [
                "edit",
              ],
              "laneEligibility": {
                "edit": true,
              },
              "os": "darwin",
              "producerId": "agy",
              "reason": null,
              "resolvedExecutable": {
                "command": "/nonexistent/claude-architect-characterization/cli",
                "kind": "native",
                "prefixArgs": [],
                "resolvedFrom": "characterization",
              },
              "structuredOutput": true,
              "version": "1.2.3",
              "writeConfinementBackend": "macos-seatbelt",
            },
            "spawned": [
              [
                "--version",
              ],
            ],
          },
          "linuxNative": {
            "report": {
              "arch": "x64",
              "authState": "authenticated",
              "available": true,
              "environmentType": "native",
              "executionModes": [
                "edit",
              ],
              "laneEligibility": {
                "edit": false,
              },
              "os": "linux",
              "producerId": "agy",
              "reason": null,
              "resolvedExecutable": {
                "command": "/nonexistent/claude-architect-characterization/cli",
                "kind": "native",
                "prefixArgs": [],
                "resolvedFrom": "characterization",
              },
              "structuredOutput": true,
              "version": "1.2.3",
              "writeConfinementBackend": null,
            },
            "spawned": [
              [
                "--version",
              ],
            ],
          },
          "linuxWsl": {
            "report": {
              "arch": "x64",
              "authState": "authenticated",
              "available": true,
              "environmentType": "wsl",
              "executionModes": [
                "edit",
              ],
              "laneEligibility": {
                "edit": false,
              },
              "os": "linux",
              "producerId": "agy",
              "reason": null,
              "resolvedExecutable": {
                "command": "/nonexistent/claude-architect-characterization/cli",
                "kind": "native",
                "prefixArgs": [],
                "resolvedFrom": "characterization",
              },
              "structuredOutput": true,
              "version": "1.2.3",
              "writeConfinementBackend": null,
            },
            "spawned": [
              [
                "--version",
              ],
            ],
          },
          "missingExecutable": {
            "report": {
              "arch": "arm64",
              "authState": "unknown",
              "available": false,
              "environmentType": "native",
              "executionModes": [
                "edit",
              ],
              "laneEligibility": {
                "edit": false,
              },
              "os": "darwin",
              "producerId": "agy",
              "reason": "missing-executable",
              "resolvedExecutable": null,
              "structuredOutput": true,
              "version": null,
              "writeConfinementBackend": null,
            },
            "spawned": [],
          },
          "prefixedVersion": {
            "report": {
              "arch": "arm64",
              "authState": "unknown",
              "available": false,
              "environmentType": "native",
              "executionModes": [
                "edit",
              ],
              "laneEligibility": {
                "edit": false,
              },
              "os": "darwin",
              "producerId": "agy",
              "reason": "probe-failed",
              "resolvedExecutable": {
                "command": "/nonexistent/claude-architect-characterization/cli",
                "kind": "native",
                "prefixArgs": [],
                "resolvedFrom": "characterization",
              },
              "structuredOutput": true,
              "version": null,
              "writeConfinementBackend": null,
            },
            "spawned": [
              [
                "--version",
              ],
            ],
          },
          "unparseableVersion": {
            "report": {
              "arch": "arm64",
              "authState": "unknown",
              "available": false,
              "environmentType": "native",
              "executionModes": [
                "edit",
              ],
              "laneEligibility": {
                "edit": false,
              },
              "os": "darwin",
              "producerId": "agy",
              "reason": "probe-failed",
              "resolvedExecutable": {
                "command": "/nonexistent/claude-architect-characterization/cli",
                "kind": "native",
                "prefixArgs": [],
                "resolvedFrom": "characterization",
              },
              "structuredOutput": true,
              "version": null,
              "writeConfinementBackend": null,
            },
            "spawned": [
              [
                "--version",
              ],
            ],
          },
          "win32": {
            "report": {
              "arch": "x64",
              "authState": "unknown",
              "available": false,
              "environmentType": "native",
              "executionModes": [
                "edit",
              ],
              "laneEligibility": {
                "edit": false,
              },
              "os": "win32",
              "producerId": "agy",
              "reason": "unsupported-platform",
              "resolvedExecutable": null,
              "structuredOutput": true,
              "version": null,
              "writeConfinementBackend": null,
            },
            "spawned": [],
          },
        },
      }
    `);
  });

  it("pythinker", async () => {
    expect(await characterize(deps => new PythinkerAdapter(deps), pythinkerDescriptor))
      .toMatchInlineSnapshot(`
        {
          "configurationProfile": {
            "behavioralConfigSources": [
              "~/.pythinker/config.toml",
              "~/.pythinker/tui.toml",
            ],
            "credentialSources": [
              "~/.pythinker/credentials/pythinker-code.json",
            ],
            "environmentDependencies": [
              "PYTHINKER_SHARE_DIR",
              "PYTHINKER_CLI_NO_AUTO_UPDATE",
            ],
            "isolationState": "inherited-config-only",
            "repositoryInstructionSources": [
              "worktree AGENTS.md",
            ],
            "temporaryHomeStrategy": "real HOME inherited by declared policy; reduced reproducibility recorded in the Run Manifest",
          },
          "environment": {
            "homeSetAuthed": {
              "env": {
                "PYTHINKER_CLI_NO_AUTO_UPDATE": "1",
              },
              "inheritedStateWritablePaths": [
                "/home/char/.pythinker",
              ],
              "network": "allowed",
              "requiredEnv": [
                "PYTHINKER_SHARE_DIR",
                "PYTHINKER_CLI_NO_AUTO_UPDATE",
              ],
            },
            "homeUnsetConfigPresent": {
              "env": {
                "HOME": "/home/char",
                "PYTHINKER_CLI_NO_AUTO_UPDATE": "1",
              },
              "inheritedStateWritablePaths": [
                "/home/char/.pythinker",
              ],
              "network": "allowed",
              "requiredEnv": [
                "PYTHINKER_SHARE_DIR",
                "PYTHINKER_CLI_NO_AUTO_UPDATE",
              ],
            },
            "homeUnsetNothing": {
              "env": {
                "PYTHINKER_CLI_NO_AUTO_UPDATE": "1",
              },
              "inheritedStateWritablePaths": [
                "/home/char/.pythinker",
              ],
              "network": "allowed",
              "requiredEnv": [
                "PYTHINKER_SHARE_DIR",
                "PYTHINKER_CLI_NO_AUTO_UPDATE",
              ],
            },
            "overridesSet": {
              "env": {},
              "inheritedStateWritablePaths": [
                "/pythinker/share",
              ],
              "network": "allowed",
              "requiredEnv": [
                "PYTHINKER_SHARE_DIR",
                "PYTHINKER_CLI_NO_AUTO_UPDATE",
              ],
            },
            "userProfileOnly": {
              "env": {
                "HOME": "/home/char",
                "PYTHINKER_CLI_NO_AUTO_UPDATE": "1",
              },
              "inheritedStateWritablePaths": [
                "/profile/char/.pythinker",
              ],
              "network": "allowed",
              "requiredEnv": [
                "PYTHINKER_SHARE_DIR",
                "PYTHINKER_CLI_NO_AUTO_UPDATE",
              ],
            },
          },
          "events": {
            "agyError": {
              "events": [
                {
                  "kind": "final",
                  "text": "{"status":"ERROR","response":"agy failed"}",
                },
              ],
              "ok": true,
              "producerSummary": "{"status":"ERROR","response":"agy failed"}",
            },
            "agyNoResponse": {
              "events": [
                {
                  "kind": "final",
                  "text": "{"status":"SUCCESS"}",
                },
              ],
              "ok": true,
              "producerSummary": "{"status":"SUCCESS"}",
            },
            "agySuccess": {
              "events": [
                {
                  "kind": "final",
                  "text": "{"status":"SUCCESS","response":"agy done"}",
                },
              ],
              "ok": true,
              "producerSummary": "{"status":"SUCCESS","response":"agy done"}",
            },
            "claudeError": {
              "events": [
                {
                  "kind": "error",
                  "text": "err",
                },
              ],
              "ok": false,
              "producerSummary": null,
            },
            "claudeSuccess": {
              "events": [
                {
                  "kind": "final",
                  "text": "warning
        {"type":"result","subtype":"success","is_error":false,"result":"claude done"}",
                },
              ],
              "ok": true,
              "producerSummary": "warning
        {"type":"result","subtype":"success","is_error":false,"result":"claude done"}",
            },
            "codexFailed": {
              "events": [
                {
                  "kind": "error",
                  "text": "",
                },
              ],
              "ok": false,
              "producerSummary": null,
            },
            "codexMalformed": {
              "events": [
                {
                  "kind": "final",
                  "text": "{"type":"turn.completed"}
        not json",
                },
              ],
              "ok": true,
              "producerSummary": "{"type":"turn.completed"}
        not json",
            },
            "codexMessageWithoutText": {
              "events": [
                {
                  "kind": "final",
                  "text": "{"type":"item.completed","item":{"type":"agent_message"}}
        {"type":"turn.completed"}",
                },
              ],
              "ok": true,
              "producerSummary": "{"type":"item.completed","item":{"type":"agent_message"}}
        {"type":"turn.completed"}",
            },
            "codexSuccess": {
              "events": [
                {
                  "kind": "final",
                  "text": "sha256:b227d237f1471e0c572c81d64fb9c987da757d54016f7682ea3337feec57a6ae",
                },
              ],
              "ok": true,
              "producerSummary": "sha256:b227d237f1471e0c572c81d64fb9c987da757d54016f7682ea3337feec57a6ae",
            },
            "emptySuccess": {
              "events": [],
              "ok": false,
              "producerSummary": null,
            },
            "nonzeroExit": {
              "events": [
                {
                  "kind": "error",
                  "text": "boom",
                },
              ],
              "ok": false,
              "producerSummary": null,
            },
            "plainLong": {
              "events": [
                {
                  "kind": "final",
                  "text": "sha256:f16355ccd00a5b021a29e971c88d56060acebef2e0a57330cff99b6e4878bb18",
                },
              ],
              "ok": true,
              "producerSummary": "sha256:f16355ccd00a5b021a29e971c88d56060acebef2e0a57330cff99b6e4878bb18",
            },
            "plainSuccess": {
              "events": [
                {
                  "kind": "final",
                  "text": "Done.",
                },
              ],
              "ok": true,
              "producerSummary": "Done.",
            },
            "truncated": {
              "events": [
                {
                  "kind": "error",
                  "text": "stdout-truncated",
                },
              ],
              "ok": false,
              "producerSummary": null,
            },
          },
          "identity": {
            "descriptorIsExported": true,
            "executionModes": [
              "edit",
            ],
            "producerId": "pythinker",
            "structuredOutput": false,
          },
          "invocation": {
            "base": {
              "args": [
                "--prompt",
                "sha256:2d833852f36a3d6339192342faa20c721f577bc09590311ac3c49416f3b6a23c",
              ],
              "env": {
                "PYTHINKER_CLI_NO_AUTO_UPDATE": "1",
              },
              "executable": {
                "command": "/nonexistent/claude-architect-characterization/cli",
                "kind": "native",
                "prefixArgs": [],
                "resolvedFrom": "characterization",
              },
              "inheritedStateWritablePaths": [
                "/home/char/.pythinker",
              ],
              "network": "allowed",
              "requiredEnv": [
                "PYTHINKER_SHARE_DIR",
                "PYTHINKER_CLI_NO_AUTO_UPDATE",
              ],
            },
            "effortHigh": {
              "error": "Pythinker reasoningEffort override is unsupported by the installed pythinker-code CLI.",
            },
            "effortInvalid": {
              "error": "Pythinker reasoningEffort override is unsupported by the installed pythinker-code CLI.",
            },
            "gitRedirect": {
              "args": [
                "--prompt",
                "sha256:2d833852f36a3d6339192342faa20c721f577bc09590311ac3c49416f3b6a23c",
              ],
              "env": {
                "PYTHINKER_CLI_NO_AUTO_UPDATE": "1",
              },
              "executable": {
                "command": "/nonexistent/claude-architect-characterization/cli",
                "kind": "native",
                "prefixArgs": [],
                "resolvedFrom": "characterization",
              },
              "inheritedStateWritablePaths": [
                "/home/char/.pythinker",
              ],
              "network": "allowed",
              "requiredEnv": [
                "PYTHINKER_SHARE_DIR",
                "PYTHINKER_CLI_NO_AUTO_UPDATE",
              ],
            },
            "gitRedirectReadOnly": {
              "args": [
                "--prompt",
                "sha256:eefd09a87d2a7749a560d263d0fc4787a457c2e8c7066fa6a749b03c09a988c2",
              ],
              "env": {
                "PYTHINKER_CLI_NO_AUTO_UPDATE": "1",
              },
              "executable": {
                "command": "/nonexistent/claude-architect-characterization/cli",
                "kind": "native",
                "prefixArgs": [],
                "resolvedFrom": "characterization",
              },
              "inheritedStateWritablePaths": [
                "/home/char/.pythinker",
              ],
              "network": "allowed",
              "requiredEnv": [
                "PYTHINKER_SHARE_DIR",
                "PYTHINKER_CLI_NO_AUTO_UPDATE",
              ],
            },
            "model": {
              "args": [
                "--prompt",
                "sha256:2d833852f36a3d6339192342faa20c721f577bc09590311ac3c49416f3b6a23c",
                "--model",
                "model-x",
              ],
              "env": {
                "PYTHINKER_CLI_NO_AUTO_UPDATE": "1",
              },
              "executable": {
                "command": "/nonexistent/claude-architect-characterization/cli",
                "kind": "native",
                "prefixArgs": [],
                "resolvedFrom": "characterization",
              },
              "inheritedStateWritablePaths": [
                "/home/char/.pythinker",
              ],
              "network": "allowed",
              "requiredEnv": [
                "PYTHINKER_SHARE_DIR",
                "PYTHINKER_CLI_NO_AUTO_UPDATE",
              ],
            },
            "modelAndEffort": {
              "error": "Pythinker reasoningEffort override is unsupported by the installed pythinker-code CLI.",
            },
            "readOnly": {
              "args": [
                "--prompt",
                "sha256:eefd09a87d2a7749a560d263d0fc4787a457c2e8c7066fa6a749b03c09a988c2",
              ],
              "env": {
                "PYTHINKER_CLI_NO_AUTO_UPDATE": "1",
              },
              "executable": {
                "command": "/nonexistent/claude-architect-characterization/cli",
                "kind": "native",
                "prefixArgs": [],
                "resolvedFrom": "characterization",
              },
              "inheritedStateWritablePaths": [
                "/home/char/.pythinker",
              ],
              "network": "allowed",
              "requiredEnv": [
                "PYTHINKER_SHARE_DIR",
                "PYTHINKER_CLI_NO_AUTO_UPDATE",
              ],
            },
          },
          "probe": {
            "bareHelp": {
              "report": {
                "arch": "arm64",
                "authState": "unknown",
                "available": false,
                "environmentType": "native",
                "executionModes": [
                  "edit",
                ],
                "laneEligibility": {
                  "edit": false,
                },
                "os": "darwin",
                "producerId": "pythinker",
                "reason": "unsupported-cli-surface",
                "resolvedExecutable": {
                  "command": "/nonexistent/claude-architect-characterization/cli",
                  "kind": "native",
                  "prefixArgs": [],
                  "resolvedFrom": "characterization",
                },
                "structuredOutput": false,
                "version": null,
                "writeConfinementBackend": null,
              },
              "spawned": [
                [
                  "--version",
                ],
                [
                  "--help",
                ],
              ],
            },
            "darwinAuthed": {
              "report": {
                "arch": "arm64",
                "authState": "authenticated",
                "available": true,
                "environmentType": "native",
                "executionModes": [
                  "edit",
                ],
                "laneEligibility": {
                  "edit": true,
                },
                "os": "darwin",
                "producerId": "pythinker",
                "reason": null,
                "resolvedExecutable": {
                  "command": "/nonexistent/claude-architect-characterization/cli",
                  "kind": "native",
                  "prefixArgs": [],
                  "resolvedFrom": "characterization",
                },
                "structuredOutput": false,
                "version": "1.2.3",
                "writeConfinementBackend": "macos-seatbelt",
              },
              "spawned": [
                [
                  "--version",
                ],
                [
                  "--help",
                ],
              ],
            },
            "darwinEnvKeys": {
              "report": {
                "arch": "x64",
                "authState": "unauthenticated",
                "available": true,
                "environmentType": "native",
                "executionModes": [
                  "edit",
                ],
                "laneEligibility": {
                  "edit": false,
                },
                "os": "darwin",
                "producerId": "pythinker",
                "reason": null,
                "resolvedExecutable": {
                  "command": "/nonexistent/claude-architect-characterization/cli",
                  "kind": "native",
                  "prefixArgs": [],
                  "resolvedFrom": "characterization",
                },
                "structuredOutput": false,
                "version": "1.2.3",
                "writeConfinementBackend": null,
              },
              "spawned": [
                [
                  "--version",
                ],
                [
                  "--help",
                ],
              ],
            },
            "darwinUnauthed": {
              "report": {
                "arch": "arm64",
                "authState": "unauthenticated",
                "available": true,
                "environmentType": "native",
                "executionModes": [
                  "edit",
                ],
                "laneEligibility": {
                  "edit": true,
                },
                "os": "darwin",
                "producerId": "pythinker",
                "reason": null,
                "resolvedExecutable": {
                  "command": "/nonexistent/claude-architect-characterization/cli",
                  "kind": "native",
                  "prefixArgs": [],
                  "resolvedFrom": "characterization",
                },
                "structuredOutput": false,
                "version": "1.2.3",
                "writeConfinementBackend": "macos-seatbelt",
              },
              "spawned": [
                [
                  "--version",
                ],
                [
                  "--help",
                ],
              ],
            },
            "linuxNative": {
              "report": {
                "arch": "x64",
                "authState": "authenticated",
                "available": true,
                "environmentType": "native",
                "executionModes": [
                  "edit",
                ],
                "laneEligibility": {
                  "edit": false,
                },
                "os": "linux",
                "producerId": "pythinker",
                "reason": null,
                "resolvedExecutable": {
                  "command": "/nonexistent/claude-architect-characterization/cli",
                  "kind": "native",
                  "prefixArgs": [],
                  "resolvedFrom": "characterization",
                },
                "structuredOutput": false,
                "version": "1.2.3",
                "writeConfinementBackend": null,
              },
              "spawned": [
                [
                  "--version",
                ],
                [
                  "--help",
                ],
              ],
            },
            "linuxWsl": {
              "report": {
                "arch": "x64",
                "authState": "authenticated",
                "available": true,
                "environmentType": "wsl",
                "executionModes": [
                  "edit",
                ],
                "laneEligibility": {
                  "edit": false,
                },
                "os": "linux",
                "producerId": "pythinker",
                "reason": null,
                "resolvedExecutable": {
                  "command": "/nonexistent/claude-architect-characterization/cli",
                  "kind": "native",
                  "prefixArgs": [],
                  "resolvedFrom": "characterization",
                },
                "structuredOutput": false,
                "version": "1.2.3",
                "writeConfinementBackend": null,
              },
              "spawned": [
                [
                  "--version",
                ],
                [
                  "--help",
                ],
              ],
            },
            "missingExecutable": {
              "report": {
                "arch": "arm64",
                "authState": "unknown",
                "available": false,
                "environmentType": "native",
                "executionModes": [
                  "edit",
                ],
                "laneEligibility": {
                  "edit": false,
                },
                "os": "darwin",
                "producerId": "pythinker",
                "reason": "missing-executable",
                "resolvedExecutable": null,
                "structuredOutput": false,
                "version": null,
                "writeConfinementBackend": null,
              },
              "spawned": [],
            },
            "prefixedVersion": {
              "report": {
                "arch": "arm64",
                "authState": "authenticated",
                "available": true,
                "environmentType": "native",
                "executionModes": [
                  "edit",
                ],
                "laneEligibility": {
                  "edit": true,
                },
                "os": "darwin",
                "producerId": "pythinker",
                "reason": null,
                "resolvedExecutable": {
                  "command": "/nonexistent/claude-architect-characterization/cli",
                  "kind": "native",
                  "prefixArgs": [],
                  "resolvedFrom": "characterization",
                },
                "structuredOutput": false,
                "version": "2.0.1-beta.1",
                "writeConfinementBackend": "macos-seatbelt",
              },
              "spawned": [
                [
                  "--version",
                ],
                [
                  "--help",
                ],
              ],
            },
            "unparseableVersion": {
              "report": {
                "arch": "arm64",
                "authState": "unknown",
                "available": false,
                "environmentType": "native",
                "executionModes": [
                  "edit",
                ],
                "laneEligibility": {
                  "edit": false,
                },
                "os": "darwin",
                "producerId": "pythinker",
                "reason": "probe-failed",
                "resolvedExecutable": {
                  "command": "/nonexistent/claude-architect-characterization/cli",
                  "kind": "native",
                  "prefixArgs": [],
                  "resolvedFrom": "characterization",
                },
                "structuredOutput": false,
                "version": null,
                "writeConfinementBackend": null,
              },
              "spawned": [
                [
                  "--version",
                ],
              ],
            },
            "win32": {
              "report": {
                "arch": "x64",
                "authState": "unknown",
                "available": false,
                "environmentType": "native",
                "executionModes": [
                  "edit",
                ],
                "laneEligibility": {
                  "edit": false,
                },
                "os": "win32",
                "producerId": "pythinker",
                "reason": "unsupported-platform",
                "resolvedExecutable": null,
                "structuredOutput": false,
                "version": null,
                "writeConfinementBackend": null,
              },
              "spawned": [],
            },
          },
        }
      `);
  });

  it("claude", async () => {
    expect(await characterize(deps => new ClaudeAdapter(deps), claudeDescriptor))
      .toMatchInlineSnapshot(`
        {
          "configurationProfile": {
            "behavioralConfigSources": [
              "explicit invocation argv (user/project/local settings, hooks, MCP servers, and skills are all disabled)",
            ],
            "credentialSources": [
              "~/.claude.json oauthAccount + macOS login keychain ("Claude Code-credentials")",
              "ANTHROPIC_API_KEY (optional)",
            ],
            "environmentDependencies": [
              "USER",
              "CLAUDE_CONFIG_DIR",
              "ANTHROPIC_API_KEY",
            ],
            "isolationState": "inherited-config-only",
            "repositoryInstructionSources": [],
            "temporaryHomeStrategy": "real HOME inherited by declared policy (OAuth state in ~/.claude.json is not HOME-redirectable); reduced reproducibility recorded in the Run Manifest",
          },
          "environment": {
            "homeSetAuthed": {
              "env": undefined,
              "inheritedStateWritablePaths": [
                "/home/char/.claude",
                "/home/char/.claude.json",
              ],
              "network": "allowed",
              "requiredEnv": [
                "USER",
                "CLAUDE_CONFIG_DIR",
                "ANTHROPIC_API_KEY",
              ],
            },
            "homeUnsetConfigPresent": {
              "env": undefined,
              "inheritedStateWritablePaths": [
                "/home/char/.claude",
                "/home/char/.claude.json",
              ],
              "network": "allowed",
              "requiredEnv": [
                "USER",
                "CLAUDE_CONFIG_DIR",
                "ANTHROPIC_API_KEY",
              ],
            },
            "homeUnsetNothing": {
              "env": undefined,
              "inheritedStateWritablePaths": [
                "/home/char/.claude",
                "/home/char/.claude.json",
              ],
              "network": "allowed",
              "requiredEnv": [
                "USER",
                "CLAUDE_CONFIG_DIR",
                "ANTHROPIC_API_KEY",
              ],
            },
            "overridesSet": {
              "env": undefined,
              "inheritedStateWritablePaths": [
                "/claude/config",
                "/claude/config/.claude.json",
              ],
              "network": "allowed",
              "requiredEnv": [
                "USER",
                "CLAUDE_CONFIG_DIR",
                "ANTHROPIC_API_KEY",
              ],
            },
            "userProfileOnly": {
              "env": undefined,
              "inheritedStateWritablePaths": [
                "/profile/char/.claude",
                "/profile/char/.claude.json",
              ],
              "network": "allowed",
              "requiredEnv": [
                "USER",
                "CLAUDE_CONFIG_DIR",
                "ANTHROPIC_API_KEY",
              ],
            },
          },
          "events": {
            "agyError": {
              "events": [
                {
                  "kind": "error",
                  "text": "",
                },
              ],
              "ok": false,
              "producerSummary": null,
            },
            "agyNoResponse": {
              "events": [
                {
                  "kind": "error",
                  "text": "",
                },
              ],
              "ok": false,
              "producerSummary": null,
            },
            "agySuccess": {
              "events": [
                {
                  "kind": "error",
                  "text": "",
                },
              ],
              "ok": false,
              "producerSummary": null,
            },
            "claudeError": {
              "events": [
                {
                  "kind": "error",
                  "raw": {
                    "is_error": true,
                    "result": "claude failed",
                    "subtype": "error_max_turns",
                    "type": "result",
                  },
                  "text": "claude failed",
                },
              ],
              "ok": false,
              "producerSummary": null,
            },
            "claudeSuccess": {
              "events": [
                {
                  "kind": "final",
                  "raw": {
                    "is_error": false,
                    "result": "claude done",
                    "subtype": "success",
                    "type": "result",
                  },
                  "text": "claude done",
                },
              ],
              "ok": true,
              "producerSummary": "claude done",
            },
            "codexFailed": {
              "events": [
                {
                  "kind": "error",
                  "text": "",
                },
              ],
              "ok": false,
              "producerSummary": null,
            },
            "codexMalformed": {
              "events": [
                {
                  "kind": "error",
                  "text": "",
                },
              ],
              "ok": false,
              "producerSummary": null,
            },
            "codexMessageWithoutText": {
              "events": [
                {
                  "kind": "error",
                  "text": "",
                },
              ],
              "ok": false,
              "producerSummary": null,
            },
            "codexSuccess": {
              "events": [
                {
                  "kind": "error",
                  "text": "",
                },
              ],
              "ok": false,
              "producerSummary": null,
            },
            "emptySuccess": {
              "events": [
                {
                  "kind": "error",
                  "text": "",
                },
              ],
              "ok": false,
              "producerSummary": null,
            },
            "nonzeroExit": {
              "events": [
                {
                  "kind": "error",
                  "text": "boom",
                },
              ],
              "ok": false,
              "producerSummary": null,
            },
            "plainLong": {
              "events": [
                {
                  "kind": "error",
                  "text": "",
                },
              ],
              "ok": false,
              "producerSummary": null,
            },
            "plainSuccess": {
              "events": [
                {
                  "kind": "error",
                  "text": "",
                },
              ],
              "ok": false,
              "producerSummary": null,
            },
            "truncated": {
              "events": [],
              "ok": false,
              "producerSummary": null,
            },
          },
          "identity": {
            "descriptorIsExported": true,
            "executionModes": [
              "edit",
            ],
            "producerId": "claude",
            "structuredOutput": true,
          },
          "invocation": {
            "base": {
              "args": [
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
                "Read,Edit,Write,Bash,Grep,Glob",
              ],
              "executable": {
                "command": "/nonexistent/claude-architect-characterization/cli",
                "kind": "native",
                "prefixArgs": [],
                "resolvedFrom": "characterization",
              },
              "inheritedStateWritablePaths": [
                "/home/char/.claude",
                "/home/char/.claude.json",
              ],
              "network": "allowed",
              "requiredEnv": [
                "USER",
                "CLAUDE_CONFIG_DIR",
                "ANTHROPIC_API_KEY",
              ],
              "stdin": "sha256:2d833852f36a3d6339192342faa20c721f577bc09590311ac3c49416f3b6a23c",
            },
            "effortHigh": {
              "args": [
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
                "Read,Edit,Write,Bash,Grep,Glob",
                "--effort",
                "high",
              ],
              "executable": {
                "command": "/nonexistent/claude-architect-characterization/cli",
                "kind": "native",
                "prefixArgs": [],
                "resolvedFrom": "characterization",
              },
              "inheritedStateWritablePaths": [
                "/home/char/.claude",
                "/home/char/.claude.json",
              ],
              "network": "allowed",
              "requiredEnv": [
                "USER",
                "CLAUDE_CONFIG_DIR",
                "ANTHROPIC_API_KEY",
              ],
              "stdin": "sha256:2d833852f36a3d6339192342faa20c721f577bc09590311ac3c49416f3b6a23c",
            },
            "effortInvalid": {
              "error": "Claude effort override "turbo" is unsupported; use one of low|medium|high|xhigh|max.",
            },
            "gitRedirect": {
              "args": [
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
                "Read,Edit,Write,Bash,Grep,Glob",
              ],
              "executable": {
                "command": "/nonexistent/claude-architect-characterization/cli",
                "kind": "native",
                "prefixArgs": [],
                "resolvedFrom": "characterization",
              },
              "inheritedStateWritablePaths": [
                "/home/char/.claude",
                "/home/char/.claude.json",
              ],
              "network": "allowed",
              "requiredEnv": [
                "USER",
                "CLAUDE_CONFIG_DIR",
                "ANTHROPIC_API_KEY",
              ],
              "stdin": "sha256:2d833852f36a3d6339192342faa20c721f577bc09590311ac3c49416f3b6a23c",
            },
            "gitRedirectReadOnly": {
              "args": [
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
                "Read,Grep,Glob",
              ],
              "executable": {
                "command": "/nonexistent/claude-architect-characterization/cli",
                "kind": "native",
                "prefixArgs": [],
                "resolvedFrom": "characterization",
              },
              "inheritedStateWritablePaths": [
                "/home/char/.claude",
                "/home/char/.claude.json",
              ],
              "network": "allowed",
              "requiredEnv": [
                "USER",
                "CLAUDE_CONFIG_DIR",
                "ANTHROPIC_API_KEY",
              ],
              "stdin": "sha256:eefd09a87d2a7749a560d263d0fc4787a457c2e8c7066fa6a749b03c09a988c2",
            },
            "model": {
              "args": [
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
                "Read,Edit,Write,Bash,Grep,Glob",
                "--model",
                "model-x",
              ],
              "executable": {
                "command": "/nonexistent/claude-architect-characterization/cli",
                "kind": "native",
                "prefixArgs": [],
                "resolvedFrom": "characterization",
              },
              "inheritedStateWritablePaths": [
                "/home/char/.claude",
                "/home/char/.claude.json",
              ],
              "network": "allowed",
              "requiredEnv": [
                "USER",
                "CLAUDE_CONFIG_DIR",
                "ANTHROPIC_API_KEY",
              ],
              "stdin": "sha256:2d833852f36a3d6339192342faa20c721f577bc09590311ac3c49416f3b6a23c",
            },
            "modelAndEffort": {
              "args": [
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
                "Read,Edit,Write,Bash,Grep,Glob",
                "--model",
                "model-y",
                "--effort",
                "low",
              ],
              "executable": {
                "command": "/nonexistent/claude-architect-characterization/cli",
                "kind": "native",
                "prefixArgs": [],
                "resolvedFrom": "characterization",
              },
              "inheritedStateWritablePaths": [
                "/home/char/.claude",
                "/home/char/.claude.json",
              ],
              "network": "allowed",
              "requiredEnv": [
                "USER",
                "CLAUDE_CONFIG_DIR",
                "ANTHROPIC_API_KEY",
              ],
              "stdin": "sha256:2d833852f36a3d6339192342faa20c721f577bc09590311ac3c49416f3b6a23c",
            },
            "readOnly": {
              "args": [
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
                "Read,Grep,Glob",
              ],
              "executable": {
                "command": "/nonexistent/claude-architect-characterization/cli",
                "kind": "native",
                "prefixArgs": [],
                "resolvedFrom": "characterization",
              },
              "inheritedStateWritablePaths": [
                "/home/char/.claude",
                "/home/char/.claude.json",
              ],
              "network": "allowed",
              "requiredEnv": [
                "USER",
                "CLAUDE_CONFIG_DIR",
                "ANTHROPIC_API_KEY",
              ],
              "stdin": "sha256:eefd09a87d2a7749a560d263d0fc4787a457c2e8c7066fa6a749b03c09a988c2",
            },
          },
          "probe": {
            "bareHelp": {
              "report": {
                "arch": "arm64",
                "authState": "unknown",
                "available": false,
                "environmentType": "native",
                "executionModes": [
                  "edit",
                ],
                "laneEligibility": {
                  "edit": false,
                },
                "os": "darwin",
                "producerId": "claude",
                "reason": "unsupported-cli-surface",
                "resolvedExecutable": {
                  "command": "/nonexistent/claude-architect-characterization/cli",
                  "kind": "native",
                  "prefixArgs": [],
                  "resolvedFrom": "characterization",
                },
                "structuredOutput": true,
                "version": null,
                "writeConfinementBackend": null,
              },
              "spawned": [
                [
                  "--version",
                ],
                [
                  "--help",
                ],
              ],
            },
            "darwinAuthed": {
              "report": {
                "arch": "arm64",
                "authState": "authenticated",
                "available": true,
                "environmentType": "native",
                "executionModes": [
                  "edit",
                ],
                "laneEligibility": {
                  "edit": true,
                },
                "os": "darwin",
                "producerId": "claude",
                "reason": null,
                "resolvedExecutable": {
                  "command": "/nonexistent/claude-architect-characterization/cli",
                  "kind": "native",
                  "prefixArgs": [],
                  "resolvedFrom": "characterization",
                },
                "structuredOutput": true,
                "version": "1.2.3",
                "writeConfinementBackend": "macos-seatbelt",
              },
              "spawned": [
                [
                  "--version",
                ],
                [
                  "--help",
                ],
              ],
            },
            "darwinEnvKeys": {
              "report": {
                "arch": "x64",
                "authState": "authenticated",
                "available": true,
                "environmentType": "native",
                "executionModes": [
                  "edit",
                ],
                "laneEligibility": {
                  "edit": false,
                },
                "os": "darwin",
                "producerId": "claude",
                "reason": null,
                "resolvedExecutable": {
                  "command": "/nonexistent/claude-architect-characterization/cli",
                  "kind": "native",
                  "prefixArgs": [],
                  "resolvedFrom": "characterization",
                },
                "structuredOutput": true,
                "version": "1.2.3",
                "writeConfinementBackend": null,
              },
              "spawned": [
                [
                  "--version",
                ],
                [
                  "--help",
                ],
              ],
            },
            "darwinUnauthed": {
              "report": {
                "arch": "arm64",
                "authState": "unauthenticated",
                "available": true,
                "environmentType": "native",
                "executionModes": [
                  "edit",
                ],
                "laneEligibility": {
                  "edit": true,
                },
                "os": "darwin",
                "producerId": "claude",
                "reason": null,
                "resolvedExecutable": {
                  "command": "/nonexistent/claude-architect-characterization/cli",
                  "kind": "native",
                  "prefixArgs": [],
                  "resolvedFrom": "characterization",
                },
                "structuredOutput": true,
                "version": "1.2.3",
                "writeConfinementBackend": "macos-seatbelt",
              },
              "spawned": [
                [
                  "--version",
                ],
                [
                  "--help",
                ],
              ],
            },
            "linuxNative": {
              "report": {
                "arch": "x64",
                "authState": "authenticated",
                "available": true,
                "environmentType": "native",
                "executionModes": [
                  "edit",
                ],
                "laneEligibility": {
                  "edit": false,
                },
                "os": "linux",
                "producerId": "claude",
                "reason": null,
                "resolvedExecutable": {
                  "command": "/nonexistent/claude-architect-characterization/cli",
                  "kind": "native",
                  "prefixArgs": [],
                  "resolvedFrom": "characterization",
                },
                "structuredOutput": true,
                "version": "1.2.3",
                "writeConfinementBackend": null,
              },
              "spawned": [
                [
                  "--version",
                ],
                [
                  "--help",
                ],
              ],
            },
            "linuxWsl": {
              "report": {
                "arch": "x64",
                "authState": "authenticated",
                "available": true,
                "environmentType": "wsl",
                "executionModes": [
                  "edit",
                ],
                "laneEligibility": {
                  "edit": false,
                },
                "os": "linux",
                "producerId": "claude",
                "reason": null,
                "resolvedExecutable": {
                  "command": "/nonexistent/claude-architect-characterization/cli",
                  "kind": "native",
                  "prefixArgs": [],
                  "resolvedFrom": "characterization",
                },
                "structuredOutput": true,
                "version": "1.2.3",
                "writeConfinementBackend": null,
              },
              "spawned": [
                [
                  "--version",
                ],
                [
                  "--help",
                ],
              ],
            },
            "missingExecutable": {
              "report": {
                "arch": "arm64",
                "authState": "unknown",
                "available": false,
                "environmentType": "native",
                "executionModes": [
                  "edit",
                ],
                "laneEligibility": {
                  "edit": false,
                },
                "os": "darwin",
                "producerId": "claude",
                "reason": "missing-executable",
                "resolvedExecutable": null,
                "structuredOutput": true,
                "version": null,
                "writeConfinementBackend": null,
              },
              "spawned": [],
            },
            "prefixedVersion": {
              "report": {
                "arch": "arm64",
                "authState": "unknown",
                "available": false,
                "environmentType": "native",
                "executionModes": [
                  "edit",
                ],
                "laneEligibility": {
                  "edit": false,
                },
                "os": "darwin",
                "producerId": "claude",
                "reason": "probe-failed",
                "resolvedExecutable": {
                  "command": "/nonexistent/claude-architect-characterization/cli",
                  "kind": "native",
                  "prefixArgs": [],
                  "resolvedFrom": "characterization",
                },
                "structuredOutput": true,
                "version": null,
                "writeConfinementBackend": null,
              },
              "spawned": [
                [
                  "--version",
                ],
              ],
            },
            "unparseableVersion": {
              "report": {
                "arch": "arm64",
                "authState": "unknown",
                "available": false,
                "environmentType": "native",
                "executionModes": [
                  "edit",
                ],
                "laneEligibility": {
                  "edit": false,
                },
                "os": "darwin",
                "producerId": "claude",
                "reason": "probe-failed",
                "resolvedExecutable": {
                  "command": "/nonexistent/claude-architect-characterization/cli",
                  "kind": "native",
                  "prefixArgs": [],
                  "resolvedFrom": "characterization",
                },
                "structuredOutput": true,
                "version": null,
                "writeConfinementBackend": null,
              },
              "spawned": [
                [
                  "--version",
                ],
              ],
            },
            "win32": {
              "report": {
                "arch": "x64",
                "authState": "unknown",
                "available": false,
                "environmentType": "native",
                "executionModes": [
                  "edit",
                ],
                "laneEligibility": {
                  "edit": false,
                },
                "os": "win32",
                "producerId": "claude",
                "reason": "unsupported-platform",
                "resolvedExecutable": null,
                "structuredOutput": true,
                "version": null,
                "writeConfinementBackend": null,
              },
              "spawned": [],
            },
          },
        }
      `);
  });

  it("codex", async () => {
    expect(await characterize(deps => new CodexAdapter(deps), codexDescriptor))
      .toMatchInlineSnapshot(`
        {
          "configurationProfile": {
            "behavioralConfigSources": [
              "explicit invocation argv",
            ],
            "credentialSources": [
              "CODEX_HOME auth store",
              "CODEX_API_KEY",
              "CODEX_ACCESS_TOKEN",
              "operating-system credential store",
            ],
            "environmentDependencies": [
              "CODEX_HOME",
              "CODEX_API_KEY",
              "CODEX_ACCESS_TOKEN",
              "CODEX_CA_CERTIFICATE",
              "SSL_CERT_FILE",
            ],
            "isolationState": "controlled-config-supported",
            "repositoryInstructionSources": [
              "worktree AGENTS.md",
            ],
            "temporaryHomeStrategy": "use a per-attempt HOME while preserving CODEX_HOME for auth; ignore user config and rules",
          },
          "environment": {
            "homeSetAuthed": {
              "env": {
                "CODEX_HOME": "/home/char/.codex",
              },
              "inheritedStateWritablePaths": undefined,
              "network": "denied",
              "requiredEnv": [
                "CODEX_HOME",
                "CODEX_API_KEY",
                "CODEX_ACCESS_TOKEN",
                "CODEX_CA_CERTIFICATE",
                "SSL_CERT_FILE",
              ],
            },
            "homeUnsetConfigPresent": {
              "env": {
                "CODEX_HOME": "/home/char/.codex",
              },
              "inheritedStateWritablePaths": undefined,
              "network": "denied",
              "requiredEnv": [
                "CODEX_HOME",
                "CODEX_API_KEY",
                "CODEX_ACCESS_TOKEN",
                "CODEX_CA_CERTIFICATE",
                "SSL_CERT_FILE",
              ],
            },
            "homeUnsetNothing": {
              "env": {},
              "inheritedStateWritablePaths": undefined,
              "network": "denied",
              "requiredEnv": [
                "CODEX_HOME",
                "CODEX_API_KEY",
                "CODEX_ACCESS_TOKEN",
                "CODEX_CA_CERTIFICATE",
                "SSL_CERT_FILE",
              ],
            },
            "overridesSet": {
              "env": {},
              "inheritedStateWritablePaths": undefined,
              "network": "denied",
              "requiredEnv": [
                "CODEX_HOME",
                "CODEX_API_KEY",
                "CODEX_ACCESS_TOKEN",
                "CODEX_CA_CERTIFICATE",
                "SSL_CERT_FILE",
              ],
            },
            "userProfileOnly": {
              "env": {},
              "inheritedStateWritablePaths": undefined,
              "network": "denied",
              "requiredEnv": [
                "CODEX_HOME",
                "CODEX_API_KEY",
                "CODEX_ACCESS_TOKEN",
                "CODEX_CA_CERTIFICATE",
                "SSL_CERT_FILE",
              ],
            },
          },
          "events": {
            "agyError": {
              "events": [],
              "ok": false,
              "producerSummary": null,
            },
            "agyNoResponse": {
              "events": [],
              "ok": false,
              "producerSummary": null,
            },
            "agySuccess": {
              "events": [],
              "ok": false,
              "producerSummary": null,
            },
            "claudeError": {
              "events": [],
              "ok": false,
              "producerSummary": null,
            },
            "claudeSuccess": {
              "events": [],
              "ok": false,
              "producerSummary": null,
            },
            "codexFailed": {
              "events": [
                {
                  "kind": "error",
                  "raw": {
                    "message": "rate limited",
                    "type": "error",
                  },
                  "text": "rate limited",
                },
                {
                  "kind": "error",
                  "raw": {
                    "error": {
                      "message": "turn failed",
                    },
                    "type": "turn.failed",
                  },
                  "text": "turn failed",
                },
              ],
              "ok": false,
              "producerSummary": null,
            },
            "codexMalformed": {
              "events": [],
              "ok": false,
              "producerSummary": null,
            },
            "codexMessageWithoutText": {
              "events": [],
              "ok": false,
              "producerSummary": null,
            },
            "codexSuccess": {
              "events": [
                {
                  "kind": "tool",
                  "raw": {
                    "item": {
                      "command": "ls",
                      "type": "command_execution",
                    },
                    "type": "item.completed",
                  },
                },
                {
                  "kind": "final",
                  "raw": {
                    "item": {
                      "text": "codex done",
                      "type": "agent_message",
                    },
                    "type": "item.completed",
                  },
                  "text": "codex done",
                },
              ],
              "ok": true,
              "producerSummary": "codex done",
            },
            "emptySuccess": {
              "events": [],
              "ok": false,
              "producerSummary": null,
            },
            "nonzeroExit": {
              "events": [],
              "ok": false,
              "producerSummary": null,
            },
            "plainLong": {
              "events": [],
              "ok": false,
              "producerSummary": null,
            },
            "plainSuccess": {
              "events": [],
              "ok": false,
              "producerSummary": null,
            },
            "truncated": {
              "events": [],
              "ok": false,
              "producerSummary": null,
            },
          },
          "identity": {
            "descriptorIsExported": true,
            "executionModes": [
              "edit",
            ],
            "producerId": "codex",
            "structuredOutput": true,
          },
          "invocation": {
            "base": {
              "args": [
                "exec",
                "--json",
                "--ephemeral",
                "--sandbox",
                "workspace-write",
                "--ignore-user-config",
                "--ignore-rules",
                "--disable",
                "multi_agent",
                "-c",
                "features.multi_agent_v2={enabled=false,max_concurrent_threads_per_session=1}",
                "-c",
                "approval_policy="never"",
                "-c",
                "sandbox_workspace_write.network_access=false",
                "-c",
                "sandbox_workspace_write.exclude_tmpdir_env_var=true",
                "-c",
                "sandbox_workspace_write.exclude_slash_tmp=true",
                "-c",
                "shell_environment_policy.inherit="core"",
                "-c",
                "shell_environment_policy.include_only=["PATH","HOME","TMPDIR","LANG","LC_ALL","CLAUDE_ARCHITECT_DELEGATED"]",
                "-c",
                "shell_environment_policy.exclude=["CODEX_HOME","CODEX_API_KEY","CODEX_ACCESS_TOKEN","CODEX_CA_CERTIFICATE","CODEX_MANAGED_*","SSL_CERT_FILE"]",
                "-c",
                "shell_environment_policy.set={CLAUDE_ARCHITECT_DELEGATED="1"}",
                "-c",
                "web_search="disabled"",
                "--cd",
                "/work/tree",
                "-",
              ],
              "env": {
                "CODEX_HOME": "/home/char/.codex",
              },
              "executable": {
                "command": "/nonexistent/claude-architect-characterization/cli",
                "kind": "native",
                "prefixArgs": [],
                "resolvedFrom": "characterization",
              },
              "network": "denied",
              "requiredEnv": [
                "CODEX_HOME",
                "CODEX_API_KEY",
                "CODEX_ACCESS_TOKEN",
                "CODEX_CA_CERTIFICATE",
                "SSL_CERT_FILE",
              ],
              "stdin": "sha256:2d833852f36a3d6339192342faa20c721f577bc09590311ac3c49416f3b6a23c",
            },
            "effortHigh": {
              "args": [
                "exec",
                "--json",
                "--ephemeral",
                "--sandbox",
                "workspace-write",
                "--ignore-user-config",
                "--ignore-rules",
                "--disable",
                "multi_agent",
                "-c",
                "features.multi_agent_v2={enabled=false,max_concurrent_threads_per_session=1}",
                "-c",
                "approval_policy="never"",
                "-c",
                "sandbox_workspace_write.network_access=false",
                "-c",
                "sandbox_workspace_write.exclude_tmpdir_env_var=true",
                "-c",
                "sandbox_workspace_write.exclude_slash_tmp=true",
                "-c",
                "shell_environment_policy.inherit="core"",
                "-c",
                "shell_environment_policy.include_only=["PATH","HOME","TMPDIR","LANG","LC_ALL","CLAUDE_ARCHITECT_DELEGATED"]",
                "-c",
                "shell_environment_policy.exclude=["CODEX_HOME","CODEX_API_KEY","CODEX_ACCESS_TOKEN","CODEX_CA_CERTIFICATE","CODEX_MANAGED_*","SSL_CERT_FILE"]",
                "-c",
                "shell_environment_policy.set={CLAUDE_ARCHITECT_DELEGATED="1"}",
                "-c",
                "web_search="disabled"",
                "--cd",
                "/work/tree",
                "-c",
                "model_reasoning_effort="high"",
                "-",
              ],
              "env": {
                "CODEX_HOME": "/home/char/.codex",
              },
              "executable": {
                "command": "/nonexistent/claude-architect-characterization/cli",
                "kind": "native",
                "prefixArgs": [],
                "resolvedFrom": "characterization",
              },
              "network": "denied",
              "requiredEnv": [
                "CODEX_HOME",
                "CODEX_API_KEY",
                "CODEX_ACCESS_TOKEN",
                "CODEX_CA_CERTIFICATE",
                "SSL_CERT_FILE",
              ],
              "stdin": "sha256:2d833852f36a3d6339192342faa20c721f577bc09590311ac3c49416f3b6a23c",
            },
            "effortInvalid": {
              "args": [
                "exec",
                "--json",
                "--ephemeral",
                "--sandbox",
                "workspace-write",
                "--ignore-user-config",
                "--ignore-rules",
                "--disable",
                "multi_agent",
                "-c",
                "features.multi_agent_v2={enabled=false,max_concurrent_threads_per_session=1}",
                "-c",
                "approval_policy="never"",
                "-c",
                "sandbox_workspace_write.network_access=false",
                "-c",
                "sandbox_workspace_write.exclude_tmpdir_env_var=true",
                "-c",
                "sandbox_workspace_write.exclude_slash_tmp=true",
                "-c",
                "shell_environment_policy.inherit="core"",
                "-c",
                "shell_environment_policy.include_only=["PATH","HOME","TMPDIR","LANG","LC_ALL","CLAUDE_ARCHITECT_DELEGATED"]",
                "-c",
                "shell_environment_policy.exclude=["CODEX_HOME","CODEX_API_KEY","CODEX_ACCESS_TOKEN","CODEX_CA_CERTIFICATE","CODEX_MANAGED_*","SSL_CERT_FILE"]",
                "-c",
                "shell_environment_policy.set={CLAUDE_ARCHITECT_DELEGATED="1"}",
                "-c",
                "web_search="disabled"",
                "--cd",
                "/work/tree",
                "-c",
                "model_reasoning_effort="turbo"",
                "-",
              ],
              "env": {
                "CODEX_HOME": "/home/char/.codex",
              },
              "executable": {
                "command": "/nonexistent/claude-architect-characterization/cli",
                "kind": "native",
                "prefixArgs": [],
                "resolvedFrom": "characterization",
              },
              "network": "denied",
              "requiredEnv": [
                "CODEX_HOME",
                "CODEX_API_KEY",
                "CODEX_ACCESS_TOKEN",
                "CODEX_CA_CERTIFICATE",
                "SSL_CERT_FILE",
              ],
              "stdin": "sha256:2d833852f36a3d6339192342faa20c721f577bc09590311ac3c49416f3b6a23c",
            },
            "gitRedirect": {
              "args": [
                "exec",
                "--json",
                "--ephemeral",
                "--sandbox",
                "workspace-write",
                "--ignore-user-config",
                "--ignore-rules",
                "--disable",
                "multi_agent",
                "-c",
                "features.multi_agent_v2={enabled=false,max_concurrent_threads_per_session=1}",
                "-c",
                "approval_policy="never"",
                "-c",
                "sandbox_workspace_write.network_access=false",
                "-c",
                "sandbox_workspace_write.exclude_tmpdir_env_var=true",
                "-c",
                "sandbox_workspace_write.exclude_slash_tmp=true",
                "-c",
                "sandbox_workspace_write.writable_roots=["/extra/root"]",
                "-c",
                "shell_environment_policy.inherit="core"",
                "-c",
                "shell_environment_policy.include_only=["PATH","HOME","TMPDIR","LANG","LC_ALL","CLAUDE_ARCHITECT_DELEGATED","GIT_OBJECT_DIRECTORY","GIT_ALTERNATE_OBJECT_DIRECTORIES"]",
                "-c",
                "shell_environment_policy.exclude=["CODEX_HOME","CODEX_API_KEY","CODEX_ACCESS_TOKEN","CODEX_CA_CERTIFICATE","CODEX_MANAGED_*","SSL_CERT_FILE"]",
                "-c",
                "shell_environment_policy.set={CLAUDE_ARCHITECT_DELEGATED="1",GIT_OBJECT_DIRECTORY="/repo/.git/objects",GIT_ALTERNATE_OBJECT_DIRECTORIES="/repo/alt/objects"}",
                "-c",
                "web_search="disabled"",
                "--cd",
                "/work/tree",
                "-",
              ],
              "env": {
                "CODEX_HOME": "/home/char/.codex",
                "GIT_ALTERNATE_OBJECT_DIRECTORIES": "/repo/alt/objects",
                "GIT_OBJECT_DIRECTORY": "/repo/.git/objects",
              },
              "executable": {
                "command": "/nonexistent/claude-architect-characterization/cli",
                "kind": "native",
                "prefixArgs": [],
                "resolvedFrom": "characterization",
              },
              "network": "denied",
              "requiredEnv": [
                "CODEX_HOME",
                "CODEX_API_KEY",
                "CODEX_ACCESS_TOKEN",
                "CODEX_CA_CERTIFICATE",
                "SSL_CERT_FILE",
              ],
              "stdin": "sha256:2d833852f36a3d6339192342faa20c721f577bc09590311ac3c49416f3b6a23c",
            },
            "gitRedirectReadOnly": {
              "args": [
                "exec",
                "--json",
                "--ephemeral",
                "--sandbox",
                "read-only",
                "--ignore-user-config",
                "--ignore-rules",
                "--disable",
                "multi_agent",
                "-c",
                "features.multi_agent_v2={enabled=false,max_concurrent_threads_per_session=1}",
                "-c",
                "approval_policy="never"",
                "-c",
                "sandbox_workspace_write.network_access=false",
                "-c",
                "sandbox_workspace_write.exclude_tmpdir_env_var=true",
                "-c",
                "sandbox_workspace_write.exclude_slash_tmp=true",
                "-c",
                "sandbox_workspace_write.writable_roots=["/extra/root"]",
                "-c",
                "shell_environment_policy.inherit="core"",
                "-c",
                "shell_environment_policy.include_only=["PATH","HOME","TMPDIR","LANG","LC_ALL","CLAUDE_ARCHITECT_DELEGATED","GIT_OBJECT_DIRECTORY","GIT_ALTERNATE_OBJECT_DIRECTORIES"]",
                "-c",
                "shell_environment_policy.exclude=["CODEX_HOME","CODEX_API_KEY","CODEX_ACCESS_TOKEN","CODEX_CA_CERTIFICATE","CODEX_MANAGED_*","SSL_CERT_FILE"]",
                "-c",
                "shell_environment_policy.set={CLAUDE_ARCHITECT_DELEGATED="1",GIT_OBJECT_DIRECTORY="/repo/.git/objects",GIT_ALTERNATE_OBJECT_DIRECTORIES="/repo/alt/objects"}",
                "-c",
                "web_search="disabled"",
                "--cd",
                "/work/tree",
                "-",
              ],
              "env": {
                "CODEX_HOME": "/home/char/.codex",
                "GIT_ALTERNATE_OBJECT_DIRECTORIES": "/repo/alt/objects",
                "GIT_OBJECT_DIRECTORY": "/repo/.git/objects",
              },
              "executable": {
                "command": "/nonexistent/claude-architect-characterization/cli",
                "kind": "native",
                "prefixArgs": [],
                "resolvedFrom": "characterization",
              },
              "network": "denied",
              "requiredEnv": [
                "CODEX_HOME",
                "CODEX_API_KEY",
                "CODEX_ACCESS_TOKEN",
                "CODEX_CA_CERTIFICATE",
                "SSL_CERT_FILE",
              ],
              "stdin": "sha256:eefd09a87d2a7749a560d263d0fc4787a457c2e8c7066fa6a749b03c09a988c2",
            },
            "model": {
              "args": [
                "exec",
                "--json",
                "--ephemeral",
                "--sandbox",
                "workspace-write",
                "--ignore-user-config",
                "--ignore-rules",
                "--disable",
                "multi_agent",
                "-c",
                "features.multi_agent_v2={enabled=false,max_concurrent_threads_per_session=1}",
                "-c",
                "approval_policy="never"",
                "-c",
                "sandbox_workspace_write.network_access=false",
                "-c",
                "sandbox_workspace_write.exclude_tmpdir_env_var=true",
                "-c",
                "sandbox_workspace_write.exclude_slash_tmp=true",
                "-c",
                "shell_environment_policy.inherit="core"",
                "-c",
                "shell_environment_policy.include_only=["PATH","HOME","TMPDIR","LANG","LC_ALL","CLAUDE_ARCHITECT_DELEGATED"]",
                "-c",
                "shell_environment_policy.exclude=["CODEX_HOME","CODEX_API_KEY","CODEX_ACCESS_TOKEN","CODEX_CA_CERTIFICATE","CODEX_MANAGED_*","SSL_CERT_FILE"]",
                "-c",
                "shell_environment_policy.set={CLAUDE_ARCHITECT_DELEGATED="1"}",
                "-c",
                "web_search="disabled"",
                "--cd",
                "/work/tree",
                "--model",
                "model-x",
                "-",
              ],
              "env": {
                "CODEX_HOME": "/home/char/.codex",
              },
              "executable": {
                "command": "/nonexistent/claude-architect-characterization/cli",
                "kind": "native",
                "prefixArgs": [],
                "resolvedFrom": "characterization",
              },
              "network": "denied",
              "requiredEnv": [
                "CODEX_HOME",
                "CODEX_API_KEY",
                "CODEX_ACCESS_TOKEN",
                "CODEX_CA_CERTIFICATE",
                "SSL_CERT_FILE",
              ],
              "stdin": "sha256:2d833852f36a3d6339192342faa20c721f577bc09590311ac3c49416f3b6a23c",
            },
            "modelAndEffort": {
              "args": [
                "exec",
                "--json",
                "--ephemeral",
                "--sandbox",
                "workspace-write",
                "--ignore-user-config",
                "--ignore-rules",
                "--disable",
                "multi_agent",
                "-c",
                "features.multi_agent_v2={enabled=false,max_concurrent_threads_per_session=1}",
                "-c",
                "approval_policy="never"",
                "-c",
                "sandbox_workspace_write.network_access=false",
                "-c",
                "sandbox_workspace_write.exclude_tmpdir_env_var=true",
                "-c",
                "sandbox_workspace_write.exclude_slash_tmp=true",
                "-c",
                "shell_environment_policy.inherit="core"",
                "-c",
                "shell_environment_policy.include_only=["PATH","HOME","TMPDIR","LANG","LC_ALL","CLAUDE_ARCHITECT_DELEGATED"]",
                "-c",
                "shell_environment_policy.exclude=["CODEX_HOME","CODEX_API_KEY","CODEX_ACCESS_TOKEN","CODEX_CA_CERTIFICATE","CODEX_MANAGED_*","SSL_CERT_FILE"]",
                "-c",
                "shell_environment_policy.set={CLAUDE_ARCHITECT_DELEGATED="1"}",
                "-c",
                "web_search="disabled"",
                "--cd",
                "/work/tree",
                "--model",
                "model-y",
                "-c",
                "model_reasoning_effort="low"",
                "-",
              ],
              "env": {
                "CODEX_HOME": "/home/char/.codex",
              },
              "executable": {
                "command": "/nonexistent/claude-architect-characterization/cli",
                "kind": "native",
                "prefixArgs": [],
                "resolvedFrom": "characterization",
              },
              "network": "denied",
              "requiredEnv": [
                "CODEX_HOME",
                "CODEX_API_KEY",
                "CODEX_ACCESS_TOKEN",
                "CODEX_CA_CERTIFICATE",
                "SSL_CERT_FILE",
              ],
              "stdin": "sha256:2d833852f36a3d6339192342faa20c721f577bc09590311ac3c49416f3b6a23c",
            },
            "readOnly": {
              "args": [
                "exec",
                "--json",
                "--ephemeral",
                "--sandbox",
                "read-only",
                "--ignore-user-config",
                "--ignore-rules",
                "--disable",
                "multi_agent",
                "-c",
                "features.multi_agent_v2={enabled=false,max_concurrent_threads_per_session=1}",
                "-c",
                "approval_policy="never"",
                "-c",
                "sandbox_workspace_write.network_access=false",
                "-c",
                "sandbox_workspace_write.exclude_tmpdir_env_var=true",
                "-c",
                "sandbox_workspace_write.exclude_slash_tmp=true",
                "-c",
                "shell_environment_policy.inherit="core"",
                "-c",
                "shell_environment_policy.include_only=["PATH","HOME","TMPDIR","LANG","LC_ALL","CLAUDE_ARCHITECT_DELEGATED"]",
                "-c",
                "shell_environment_policy.exclude=["CODEX_HOME","CODEX_API_KEY","CODEX_ACCESS_TOKEN","CODEX_CA_CERTIFICATE","CODEX_MANAGED_*","SSL_CERT_FILE"]",
                "-c",
                "shell_environment_policy.set={CLAUDE_ARCHITECT_DELEGATED="1"}",
                "-c",
                "web_search="disabled"",
                "--cd",
                "/work/tree",
                "-",
              ],
              "env": {
                "CODEX_HOME": "/home/char/.codex",
              },
              "executable": {
                "command": "/nonexistent/claude-architect-characterization/cli",
                "kind": "native",
                "prefixArgs": [],
                "resolvedFrom": "characterization",
              },
              "network": "denied",
              "requiredEnv": [
                "CODEX_HOME",
                "CODEX_API_KEY",
                "CODEX_ACCESS_TOKEN",
                "CODEX_CA_CERTIFICATE",
                "SSL_CERT_FILE",
              ],
              "stdin": "sha256:eefd09a87d2a7749a560d263d0fc4787a457c2e8c7066fa6a749b03c09a988c2",
            },
          },
          "probe": {
            "bareHelp": {
              "report": {
                "arch": "arm64",
                "authState": "authenticated",
                "available": true,
                "environmentType": "native",
                "executionModes": [
                  "edit",
                ],
                "laneEligibility": {
                  "edit": true,
                },
                "os": "darwin",
                "producerId": "codex",
                "reason": null,
                "resolvedExecutable": {
                  "command": "/nonexistent/claude-architect-characterization/cli",
                  "kind": "native",
                  "prefixArgs": [],
                  "resolvedFrom": "characterization",
                },
                "structuredOutput": true,
                "version": "1.2.3",
                "writeConfinementBackend": "codex-native-sandbox",
              },
              "spawned": [
                [
                  "--version",
                ],
              ],
            },
            "darwinAuthed": {
              "report": {
                "arch": "arm64",
                "authState": "authenticated",
                "available": true,
                "environmentType": "native",
                "executionModes": [
                  "edit",
                ],
                "laneEligibility": {
                  "edit": true,
                },
                "os": "darwin",
                "producerId": "codex",
                "reason": null,
                "resolvedExecutable": {
                  "command": "/nonexistent/claude-architect-characterization/cli",
                  "kind": "native",
                  "prefixArgs": [],
                  "resolvedFrom": "characterization",
                },
                "structuredOutput": true,
                "version": "1.2.3",
                "writeConfinementBackend": "codex-native-sandbox",
              },
              "spawned": [
                [
                  "--version",
                ],
              ],
            },
            "darwinEnvKeys": {
              "report": {
                "arch": "x64",
                "authState": "unauthenticated",
                "available": true,
                "environmentType": "native",
                "executionModes": [
                  "edit",
                ],
                "laneEligibility": {
                  "edit": false,
                },
                "os": "darwin",
                "producerId": "codex",
                "reason": null,
                "resolvedExecutable": {
                  "command": "/nonexistent/claude-architect-characterization/cli",
                  "kind": "native",
                  "prefixArgs": [],
                  "resolvedFrom": "characterization",
                },
                "structuredOutput": true,
                "version": "1.2.3",
                "writeConfinementBackend": null,
              },
              "spawned": [
                [
                  "--version",
                ],
              ],
            },
            "darwinUnauthed": {
              "report": {
                "arch": "arm64",
                "authState": "unauthenticated",
                "available": true,
                "environmentType": "native",
                "executionModes": [
                  "edit",
                ],
                "laneEligibility": {
                  "edit": true,
                },
                "os": "darwin",
                "producerId": "codex",
                "reason": null,
                "resolvedExecutable": {
                  "command": "/nonexistent/claude-architect-characterization/cli",
                  "kind": "native",
                  "prefixArgs": [],
                  "resolvedFrom": "characterization",
                },
                "structuredOutput": true,
                "version": "1.2.3",
                "writeConfinementBackend": "codex-native-sandbox",
              },
              "spawned": [
                [
                  "--version",
                ],
              ],
            },
            "linuxNative": {
              "report": {
                "arch": "x64",
                "authState": "authenticated",
                "available": true,
                "environmentType": "native",
                "executionModes": [
                  "edit",
                ],
                "laneEligibility": {
                  "edit": true,
                },
                "os": "linux",
                "producerId": "codex",
                "reason": null,
                "resolvedExecutable": {
                  "command": "/nonexistent/claude-architect-characterization/cli",
                  "kind": "native",
                  "prefixArgs": [],
                  "resolvedFrom": "characterization",
                },
                "structuredOutput": true,
                "version": "1.2.3",
                "writeConfinementBackend": "codex-native-sandbox",
              },
              "spawned": [
                [
                  "--version",
                ],
              ],
            },
            "linuxWsl": {
              "report": {
                "arch": "x64",
                "authState": "authenticated",
                "available": true,
                "environmentType": "wsl",
                "executionModes": [
                  "edit",
                ],
                "laneEligibility": {
                  "edit": false,
                },
                "os": "linux",
                "producerId": "codex",
                "reason": null,
                "resolvedExecutable": {
                  "command": "/nonexistent/claude-architect-characterization/cli",
                  "kind": "native",
                  "prefixArgs": [],
                  "resolvedFrom": "characterization",
                },
                "structuredOutput": true,
                "version": "1.2.3",
                "writeConfinementBackend": null,
              },
              "spawned": [
                [
                  "--version",
                ],
              ],
            },
            "missingExecutable": {
              "report": {
                "arch": "arm64",
                "authState": "unknown",
                "available": false,
                "environmentType": "native",
                "executionModes": [
                  "edit",
                ],
                "laneEligibility": {
                  "edit": false,
                },
                "os": "darwin",
                "producerId": "codex",
                "reason": "missing-executable",
                "resolvedExecutable": null,
                "structuredOutput": true,
                "version": null,
                "writeConfinementBackend": null,
              },
              "spawned": [],
            },
            "prefixedVersion": {
              "report": {
                "arch": "arm64",
                "authState": "unknown",
                "available": false,
                "environmentType": "native",
                "executionModes": [
                  "edit",
                ],
                "laneEligibility": {
                  "edit": false,
                },
                "os": "darwin",
                "producerId": "codex",
                "reason": "probe-failed",
                "resolvedExecutable": {
                  "command": "/nonexistent/claude-architect-characterization/cli",
                  "kind": "native",
                  "prefixArgs": [],
                  "resolvedFrom": "characterization",
                },
                "structuredOutput": true,
                "version": null,
                "writeConfinementBackend": null,
              },
              "spawned": [
                [
                  "--version",
                ],
              ],
            },
            "unparseableVersion": {
              "report": {
                "arch": "arm64",
                "authState": "unknown",
                "available": false,
                "environmentType": "native",
                "executionModes": [
                  "edit",
                ],
                "laneEligibility": {
                  "edit": false,
                },
                "os": "darwin",
                "producerId": "codex",
                "reason": "probe-failed",
                "resolvedExecutable": {
                  "command": "/nonexistent/claude-architect-characterization/cli",
                  "kind": "native",
                  "prefixArgs": [],
                  "resolvedFrom": "characterization",
                },
                "structuredOutput": true,
                "version": null,
                "writeConfinementBackend": null,
              },
              "spawned": [
                [
                  "--version",
                ],
              ],
            },
            "win32": {
              "report": {
                "arch": "x64",
                "authState": "unknown",
                "available": false,
                "environmentType": "native",
                "executionModes": [
                  "edit",
                ],
                "laneEligibility": {
                  "edit": false,
                },
                "os": "win32",
                "producerId": "codex",
                "reason": "unsupported-platform",
                "resolvedExecutable": null,
                "structuredOutput": true,
                "version": null,
                "writeConfinementBackend": null,
              },
              "spawned": [],
            },
          },
        }
      `);
  });
});
