import {
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { git } from "../../src/git/git-exec.js";
import {
  handleDecideCandidate,
  handleDelegate,
  handleIntegrateCandidate,
  handleReviewCandidate,
  type ToolDependencies,
} from "../../src/mcp/tools.js";
import type { ResolvedExecutable } from "../../src/platform/platform-services.js";
import { getPlatformServices } from "../../src/platform/select-platform.js";
import type { FailureClassification } from "../../src/protocol/attempt-result.js";
import type { DelegationSpec } from "../../src/protocol/delegation-spec.js";
import type {
  CapabilityReport,
  InvocationContext,
  ProbeContext,
  ProducerAdapter,
  ProducerConfigurationProfile,
  ProducerInvocation,
} from "../../src/producers/producer-adapter.js";
import { ProducerRegistry } from "../../src/producers/producer-registry.js";
import type {
  AcceptanceVerifierLike,
  AttemptRuntimeDependencies,
} from "../../src/runtime/attempt-runtime.js";
import { clearRegisteredSecrets } from "../../src/runtime/redaction.js";

const editFixture = fileURLToPath(new URL("fixtures/edit-file.mjs", import.meta.url));
const sleepFixture = fileURLToPath(new URL("fixtures/echo-sleep.mjs", import.meta.url));
const nodeExecutable: ResolvedExecutable = {
  kind: "native",
  command: process.execPath,
  prefixArgs: [],
  resolvedFrom: "e2e-fixture",
};

interface FakeAdapterOptions {
  target?: string;
  content?: string;
  exitCode?: number;
  normalizable?: boolean;
  eligible?: boolean;
  reason?: string | null;
  spawnFailure?: boolean;
  sleepMs?: number;
}

class FakeAdapter implements ProducerAdapter {
  readonly producerId = "codex";

  constructor(private readonly options: FakeAdapterOptions = {}) {}

  async probe(context: ProbeContext): Promise<CapabilityReport> {
    const eligible = this.options.eligible ?? true;
    return {
      producerId: this.producerId,
      available: eligible,
      reason: this.options.reason ?? (eligible ? null : "missing-executable"),
      os: "darwin",
      arch: "arm64",
      environmentType: "native",
      resolvedExecutable: eligible ? nodeExecutable : null,
      version: eligible ? "1.0.0" : null,
      authState: this.options.reason === "authentication-required"
        ? "unauthenticated"
        : "unknown",
      executionModes: ["edit"],
      structuredOutput: true,
      writeConfinementBackend: eligible ? "codex-native-sandbox" : null,
      laneEligibility: { edit: eligible },
    };
  }

  buildInvocation(_spec: DelegationSpec, _context: InvocationContext): ProducerInvocation {
    return {
      executable: this.options.spawnFailure
        ? {
          kind: "native",
          command: path.join(tmpdir(), "claude-architect-missing-e2e-producer"),
          prefixArgs: [],
          resolvedFrom: "e2e-missing",
        }
        : nodeExecutable,
      args: this.options.sleepMs === undefined
        ? [
          editFixture,
          this.options.target ?? "a.txt",
          this.options.content ?? "integrated\n",
          String(this.options.exitCode ?? 0),
        ]
        : [sleepFixture, "", "", String(this.options.sleepMs)],
      requiredEnv: [],
      network: "denied",
    };
  }

  normalizeEvents(): ReturnType<ProducerAdapter["normalizeEvents"]> {
    if (this.options.normalizable === false) {
      return { events: [], producerSummary: null, ok: false };
    }
    return {
      events: [{ kind: "final", text: "fake producer complete" }],
      producerSummary: "fake producer complete",
      ok: true,
    };
  }

  configurationProfile(): ProducerConfigurationProfile {
    return {
      isolationState: "controlled-config-supported",
      credentialSources: [],
      behavioralConfigSources: [],
      repositoryInstructionSources: [],
      environmentDependencies: [],
      temporaryHomeStrategy: "per-attempt HOME",
    };
  }
}

const passingVerifier: AcceptanceVerifierLike = {
  async verify() {
    return {
      ok: true,
      failures: [],
      evidence: { acceptance: "passed" },
      commandOutcomes: [],
    };
  },
};

const rejectingVerifier: AcceptanceVerifierLike = {
  async verify() {
    return {
      ok: false,
      failures: ["e2e-verification-rejected"],
      evidence: { acceptance: "failed" },
      commandOutcomes: [],
    };
  },
};

const temporaryPaths: string[] = [];
let previousPluginData: string | undefined;
let previousNodeEnvironment: string | undefined;
let previousDelegated: string | undefined;

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), prefix));
  temporaryPaths.push(directory);
  return directory;
}

async function runGit(cwd: string, args: string[]): Promise<string> {
  const result = await git(cwd, args);
  expect(result.exitCode, result.stderr).toBe(0);
  return result.stdout.trim();
}

async function initRepo(): Promise<string> {
  const directory = await realpath(await temporaryDirectory("ca-e2e-repo-"));
  await runGit(directory, ["init", "-q"]);
  await writeFile(path.join(directory, "a.txt"), "base\n");
  await runGit(directory, ["add", "-A"]);
  await runGit(directory, [
    "-c",
    "user.name=Claude Architect Test",
    "-c",
    "user.email=claude-architect@example.invalid",
    "commit",
    "-q",
    "-m",
    "base",
  ]);
  return directory;
}

function validSpec(): DelegationSpec {
  return {
    specVersion: "1",
    objective: "Update the authorized fixture file.",
    context: "a.txt is the only file in scope.",
    writeAllowlist: ["a.txt"],
    forbiddenScope: [],
    successCriteria: ["a.txt contains the delegated edit."],
    verification: [{
      id: "check",
      executable: "node",
      args: ["-e", "process.exit(0)"],
      cwd: ".",
      timeoutMs: 60_000,
      network: "denied",
      expectedExitCodes: [0],
    }],
    executionMode: "edit",
    timeoutMs: 600_000,
    producerPreferences: ["codex"],
    expectedOutput: "candidate-patch",
  };
}

function dependencies(
  adapter: ProducerAdapter | null,
  runId: string,
  options: {
    verifier?: AcceptanceVerifierLike;
    abortSignal?: AbortSignal;
    env?: Record<string, string | undefined>;
  } = {},
): ToolDependencies {
  // The platform-selected services, not Posix unconditionally: on Windows the
  // POSIX process-group kill fails silently and a timed-out producer survives.
  const ps = getPlatformServices();
  const attemptDependencies: AttemptRuntimeDependencies = {
    ps,
    producerRegistry: new ProducerRegistry(adapter === null ? [] : [adapter]),
    verifier: options.verifier ?? passingVerifier,
    // This suite drives every failure classification through the handler; the
    // Producer environment probe would spawn a second time per attempt and has
    // its own coverage, including an end-to-end pass in the pipeline suite.
    producerPreflight: false,
    runId: () => runId,
    env: options.env ?? {},
    packagedVerifier: { version: "e2e", content: "trusted e2e verifier" },
    ...(options.abortSignal === undefined ? {} : { abortSignal: options.abortSignal }),
  };
  return { ps, attemptDependencies };
}

beforeEach(async () => {
  previousPluginData = process.env.CLAUDE_PLUGIN_DATA;
  previousNodeEnvironment = process.env.NODE_ENV;
  previousDelegated = process.env.CLAUDE_ARCHITECT_DELEGATED;
  process.env.CLAUDE_PLUGIN_DATA = await temporaryDirectory("ca-e2e-state-");
  process.env.NODE_ENV = "test";
  delete process.env.CLAUDE_ARCHITECT_DELEGATED;
  clearRegisteredSecrets();
});

afterEach(async () => {
  clearRegisteredSecrets();
  if (previousPluginData === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
  else process.env.CLAUDE_PLUGIN_DATA = previousPluginData;
  if (previousNodeEnvironment === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = previousNodeEnvironment;
  if (previousDelegated === undefined) delete process.env.CLAUDE_ARCHITECT_DELEGATED;
  else process.env.CLAUDE_ARCHITECT_DELEGATED = previousDelegated;
  await Promise.all(temporaryPaths.splice(0).map(entry =>
    rm(entry, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })));
});

describe("P0-A end-to-end vertical slice", () => {
  it("delegates, reviews, decides, and integrates the exact candidate tree", async () => {
    const repoRoot = await initRepo();
    const runId = "e2e-happy";
    const deps = dependencies(new FakeAdapter(), runId);
    const lifecycleDeps = {
      ...deps,
      decisionProvenance: "human-elicitation" as const,
    };

    const delegated = await handleDelegate(repoRoot, validSpec(), deps);
    expect(delegated).toMatchObject({
      ok: true,
      result: { runId, status: "verified-candidate", failure: null },
    });
    if (!delegated.ok) throw new Error("delegation unexpectedly failed");
    const candidate = delegated.result.candidate;
    expect(candidate).not.toBeNull();

    const review = await handleReviewCandidate(repoRoot, runId, deps);
    expect(review).toMatchObject({
      patch: expect.stringContaining("+integrated"),
      changedPaths: [{ path: "a.txt", changeType: "modified" }],
    });
    await expect(handleIntegrateCandidate(
      repoRoot,
      runId,
      candidate!.manifestHash,
      deps,
    )).resolves.toEqual({ integration: "aborted", detail: "no-accepted-decision" });
    await expect(handleDecideCandidate(
      repoRoot,
      runId,
      "accepted",
      candidate!.manifestHash,
      lifecycleDeps,
    )).resolves.toEqual({
      recorded: true,
    });
    await expect(handleIntegrateCandidate(
      repoRoot,
      runId,
      candidate!.manifestHash,
      lifecycleDeps,
    )).resolves.toEqual({ integration: "applied", detail: "candidate tree applied" });

    expect(await readFile(path.join(repoRoot, "a.txt"), "utf8")).toBe("integrated\n");
    expect(await runGit(repoRoot, ["status", "--short"])).toBe("M  a.txt");
  });

  it("surfaces all canonical failure classifications through the delegate handler", async () => {
    const observed: FailureClassification[] = [];
    // This intentionally mirrors FAILURE_PRECEDENCE so a production reordering or removal fails this test.
    const expectedFailurePrecedence: FailureClassification[] = [
      "invalid-specification",
      "environment-defect",
      "unavailable",
      "authentication-required",
      "spawn-failure",
      "cancelled",
      "timeout",
      "sandbox-violation",
      "invalid-output",
      "producer-failure",
      "verification-failure",
    ];

    for (const classification of expectedFailurePrecedence) {
      if (classification === "invalid-specification") {
        const invalid = await handleDelegate(
          "/checkout-not-needed-for-invalid-spec",
          { specVersion: "1" },
          dependencies(new FakeAdapter(), "e2e-invalid-specification"),
        );
        expect(invalid).toMatchObject({
          ok: false,
          error: "invalid-specification",
          validationErrors: expect.any(Array),
        });
        observed.push(classification);
        continue;
      }

      const repoRoot = await initRepo();
      const spec = validSpec();
      let adapter: ProducerAdapter | null = new FakeAdapter();
      let verifier = passingVerifier;
      let abortSignal: AbortSignal | undefined;
      switch (classification) {
        case "unavailable":
          adapter = null;
          break;
        case "authentication-required":
          adapter = new FakeAdapter({ eligible: false, reason: "authentication-required" });
          break;
        case "spawn-failure":
          // The producer is now spawned via the watchdog wrapper (node watchdog.mjs ... -- <cmd>),
          // so the outer OS spawn always succeeds (node exists); a missing wrapped-producer command
          // now surfaces as a nonzero watchdog exit, classified as producer-failure. See the
          // dedicated unit test in tests/runtime/attempt-runtime.test.ts for this exact mapping.
          adapter = new FakeAdapter({ spawnFailure: true });
          break;
        case "cancelled": {
          const controller = new AbortController();
          controller.abort();
          abortSignal = controller.signal;
          break;
        }
        case "timeout":
          process.env.CLAUDE_ARCHITECT_MIN_EDIT_TIMEOUT_MS = "1";
          spec.timeoutMs = 100;
          adapter = new FakeAdapter({ sleepMs: 60_000 });
          break;
        case "sandbox-violation":
          adapter = new FakeAdapter({ target: "outside.txt" });
          break;
        case "invalid-output":
          adapter = new FakeAdapter({ normalizable: false });
          break;
        case "producer-failure":
          adapter = new FakeAdapter({ exitCode: 1 });
          break;
        case "environment-defect":
          spec.verification[0]!.expectedExitCodes = [1];
          break;
        case "verification-failure":
          verifier = rejectingVerifier;
          break;
        default:
          classification satisfies never;
      }
      let output;
      try {
        output = await handleDelegate(
          repoRoot,
          spec,
          dependencies(adapter, `e2e-${classification}`, { verifier, abortSignal }),
        );
      } finally {
        delete process.env.CLAUDE_ARCHITECT_MIN_EDIT_TIMEOUT_MS;
      }
      const expectedFailure = classification === "spawn-failure" ? "producer-failure" : classification;
      expect(output).toMatchObject({
        ok: true,
        result: { failure: expectedFailure },
      });
      observed.push(classification);
    }

    expect(observed).toEqual(expectedFailurePrecedence);
  }, process.platform === "win32" ? 360_000 : 90_000);

  it("structures the nested-delegation guard as a handler error", async () => {
    const repoRoot = await initRepo();

    await expect(handleDelegate(
      repoRoot,
      validSpec(),
      dependencies(new FakeAdapter(), "e2e-nested", {
        env: { CLAUDE_ARCHITECT_DELEGATED: "1" },
      }),
    )).resolves.toEqual({ ok: false, error: "nested-delegation-denied" });
  });
});
