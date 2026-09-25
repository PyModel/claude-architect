import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  access,
  chmod,
  link,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  truncate,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AttemptResult, CandidateArtifact } from "../../src/protocol/attempt-result.js";
import { ArtifactStore, pruneRuns } from "../../src/runtime/artifact-store.js";
import {
  buildRunManifest,
  sanitizeRunManifest,
  type BuildRunManifestArgs,
} from "../../src/runtime/run-manifest.js";
import {
  clearRegisteredSecrets,
  registerSecretValue,
} from "../../src/runtime/redaction.js";
import { scrubbedGitEnv } from "./helpers/git-fixture-env.js";
import {
  evaluateAutopilotEligibility,
} from "../../src/autopilot/autopilot-eligibility.js";
import {
  advisorReport,
  pipelineResult,
  reviewSnapshot,
} from "./pipeline/autopilot-fixtures.js";

const filesystemHooks = vi.hoisted(() => ({
  beforeOpen: undefined as undefined | ((filename: string) => Promise<void>),
  beforeLink: undefined as undefined | ((source: string, destination: string) => Promise<void>),
  beforeLstat: undefined as undefined | ((filename: string) => Promise<void>),
  beforeDirectoryRead: undefined as undefined | ((filename: string) => Promise<void>),
  beforeRm: undefined as undefined | ((filename: string) => Promise<void>),
}));

vi.mock("node:fs/promises", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const hook = filesystemHooks.beforeOpen;
      if (hook !== undefined) await hook(String(args[0]));
      return actual.open(...args);
    },
    link: async (...args: Parameters<typeof actual.link>) => {
      const hook = filesystemHooks.beforeLink;
      if (hook !== undefined) await hook(String(args[0]), String(args[1]));
      return actual.link(...args);
    },
    lstat: async (...args: Parameters<typeof actual.lstat>) => {
      const hook = filesystemHooks.beforeLstat;
      if (hook !== undefined) await hook(String(args[0]));
      return actual.lstat(...args);
    },
    opendir: async (...args: Parameters<typeof actual.opendir>) => {
      const hook = filesystemHooks.beforeDirectoryRead;
      if (hook !== undefined) await hook(String(args[0]));
      return actual.opendir(...args);
    },
    readdir: async (...args: Parameters<typeof actual.readdir>) => {
      const hook = filesystemHooks.beforeDirectoryRead;
      if (hook !== undefined) await hook(String(args[0]));
      return actual.readdir(...args);
    },
    rm: async (...args: Parameters<typeof actual.rm>) => {
      const hook = filesystemHooks.beforeRm;
      if (hook !== undefined) await hook(String(args[0]));
      return actual.rm(...args);
    },
  };
});

const execFileAsync = promisify(execFile);
const temporaryPaths: string[] = [];
const emptyCandidateManifestHash = createHash("sha256").update("[]").digest("hex");
let previousPluginData: string | undefined;
let previousPluginRoot: string | undefined;

function sampleResult(runId: string): AttemptResult {
  return {
    resultVersion: "1",
    runId,
    status: "failed",
    failure: "producer-failure",
    summary: "producer exited non-zero",
    producerSummary: null,
    candidate: null,
    requestedVerification: [],
    executedVerification: [],
    unresolvedIssues: [],
    evidence: {},
    logsRef: "logs/producer.log",
    producerId: "codex",
    producerVersion: "1.2.3",
    producerModel: null,
    durationMs: 42,
    sessionId: null,
  };
}

function manifestArgs(
  runId: string,
  repoRoot: string,
  candidateManifestHash: string | null = null,
  baseCommitOid = "a".repeat(40),
): BuildRunManifestArgs {
  return {
    runId,
    repoRoot,
    baseCommitOid,
    candidateManifestHash,
    producer: { id: "codex", version: "1.2.3", model: null },
    effectivePolicy: { isolation: "temporary-home", retries: 0 },
    repositoryInstructions: [
      { path: "AGENTS.md", content: "follow the repository rules\n" },
    ],
    prompt: "Implement the requested change",
    executionPolicy: { network: "denied", writeAllowlist: ["src/**"] },
    environment: [
      { name: "PATH", source: "platform" },
      { name: "CODEX_TOKEN", source: "adapter" },
    ],
    packagedVerifier: { version: "1", content: "trusted verifier bytes" },
  };
}

async function git(cwd: string, args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, {
    cwd,
    env: scrubbedGitEnv({
      GIT_AUTHOR_NAME: "test",
      GIT_AUTHOR_EMAIL: "test@example.invalid",
      GIT_COMMITTER_NAME: "test",
      GIT_COMMITTER_EMAIL: "test@example.invalid",
    }),
  });
  return result.stdout.trim();
}

// Prune now serializes archive removal against the repository checkout lease,
// which requires a run manifest to resolve the repository root. Give a run a
// real repository plus manifest so it is eligible for the full prune path.
async function writePrunableResult(
  store: ArtifactStore,
  runId: string,
  result: AttemptResult,
): Promise<string> {
  const repoRoot = await mkdtemp(join(tmpdir(), "claude-architect-prunable-repo-"));
  temporaryPaths.push(repoRoot);
  await git(repoRoot, ["init", "-q"]);
  await git(repoRoot, ["commit", "--allow-empty", "-q", "-m", "base"]);
  await store.writeResult(result);
  await store.writeManifest(buildRunManifest(manifestArgs(runId, repoRoot)));
  return repoRoot;
}

beforeEach(async () => {
  previousPluginData = process.env.CLAUDE_PLUGIN_DATA;
  previousPluginRoot = process.env.CLAUDE_PLUGIN_ROOT;
  const stateRoot = await mkdtemp(join(tmpdir(), "claude-architect-artifacts-"));
  temporaryPaths.push(stateRoot);
  process.env.CLAUDE_PLUGIN_DATA = stateRoot;
  process.env.CLAUDE_PLUGIN_ROOT = join(stateRoot, "plugin-cache");
  filesystemHooks.beforeOpen = undefined;
  filesystemHooks.beforeLink = undefined;
  filesystemHooks.beforeLstat = undefined;
  filesystemHooks.beforeDirectoryRead = undefined;
  filesystemHooks.beforeRm = undefined;
  clearRegisteredSecrets();
});

afterEach(async () => {
  filesystemHooks.beforeOpen = undefined;
  filesystemHooks.beforeLink = undefined;
  filesystemHooks.beforeLstat = undefined;
  filesystemHooks.beforeDirectoryRead = undefined;
  filesystemHooks.beforeRm = undefined;
  if (previousPluginData === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
  else process.env.CLAUDE_PLUGIN_DATA = previousPluginData;
  if (previousPluginRoot === undefined) delete process.env.CLAUDE_PLUGIN_ROOT;
  else process.env.CLAUDE_PLUGIN_ROOT = previousPluginRoot;
  clearRegisteredSecrets();
  await Promise.all(temporaryPaths.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

describe("ArtifactStore", () => {
  // A crash can leave the store's own `.{basename}.{uuid}.tmp` sibling behind.
  // `validateComponent` rejects dot-prefixed names, so one leftover used to make
  // every evidence walk for that run throw until it was cleaned up by hand.
  it("walks evidence past its own crash-left temporary residue", async () => {
    const store = new ArtifactStore("run-tmp-residue");
    await store.writePipelineArtifact("verification", { ok: true });
    await writeFile(
      join(store.runDirectory, "pipeline", ".verification.json.0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0.tmp"),
      "partial\n",
    );

    await expect(store.listEvidenceReferences()).resolves.toEqual([
      "pipeline/verification.json",
    ]);
  });

  it("still rejects an unexpected dot-file in the evidence tree", async () => {
    const store = new ArtifactStore("run-dotfile");
    await store.writePipelineArtifact("verification", { ok: true });
    await writeFile(join(store.runDirectory, "pipeline", ".hidden"), "nope\n");

    await expect(store.listEvidenceReferences()).rejects.toThrow();
  });

  it("reads exact archived evidence bytes and rejects traversal or symlink escapes", async () => {
    const store = new ArtifactStore("run-final-evidence");
    await store.writePipelineArtifact("verification", { ok: true, count: 2 });
    const expected = await readFile(
      join(store.runDirectory, "pipeline", "verification.json"),
      "utf8",
    );

    await expect(store.readEvidence("pipeline/verification.json")).resolves.toBe(expected);
    await expect(store.listEvidenceReferences()).resolves.toEqual([
      "pipeline/verification.json",
    ]);
    await expect(store.readEvidence("pipeline/missing.json")).resolves.toBeNull();
    await expect(store.readEvidence("../decision.json")).rejects.toThrow(/invalid archived evidence/u);
    const external = join(process.env.CLAUDE_PLUGIN_DATA!, "external-evidence.json");
    await writeFile(external, "outside\n");
    await symlink(external, join(store.runDirectory, "pipeline", "linked.json"));
    await expect(store.readEvidence("pipeline/linked.json"))
      .rejects.toThrow(/invalid archived evidence|symbolic link|escapes/u);
    await expect(store.listEvidenceReferences()).rejects.toThrow(/symbolic links/u);
  });

  it("atomically persists hash-bound advisor and eligibility artifacts without rewriting PipelineResult", async () => {
    const runId = "run-post-pipeline-autopilot";
    const store = new ArtifactStore(runId);
    const pipeline = pipelineResult(runId);
    const snapshot = reviewSnapshot(runId);
    await store.writePipelineArtifact("pipeline-result", pipeline);
    await store.writeReviewSnapshot(snapshot);
    const pipelinePath = join(store.runDirectory, "pipeline", "pipeline-result.json");
    const pipelineBefore = await readFile(pipelinePath, "utf8");
    const eligibility = evaluateAutopilotEligibility({
      pipelineResult: pipeline,
      reviewSnapshot: snapshot,
      advisor: advisorReport,
      evaluatedAt: "2026-07-20T12:00:00.000Z",
    });

    const hashes = await store.writePostPipelineAutopilotArtifacts({
      pipelineResult: pipeline,
      reviewSnapshot: snapshot,
      advisorReport,
      eligibility,
    });

    expect(hashes.advisorReportHash).toBe(eligibility.advisorReportHash);
    expect(hashes.eligibilityRecordHash).toMatch(/^[0-9a-f]{64}$/u);
    await expect(store.readAdvisorReport()).resolves.toEqual(advisorReport);
    await expect(store.readAutopilotEligibility()).resolves.toEqual(eligibility);
    expect(await readFile(pipelinePath, "utf8")).toBe(pipelineBefore);

    const candidate = pipeline.attempt.candidate!;
    await store.writeAutopilotDecision(
      candidate,
      eligibility,
      "2026-07-20T12:01:00.000Z",
    );
    await expect(store.readCandidateDecision()).resolves.toMatchObject({
      authority: "autopilot-policy",
      candidateManifestHash: candidate.manifestHash,
      evidenceHash: hashes.eligibilityRecordHash,
    });

    await rm(join(store.runDirectory, "pipeline", "post-pipeline-autopilot.json"));
    await expect(store.readAdvisorReport()).resolves.toBeNull();
    await expect(store.readAutopilotEligibility()).resolves.toBeNull();
  });

  it("publishes neither post-pipeline record when the single atomic publication fails", async () => {
    const runId = "run-post-pipeline-atomic-failure";
    const store = new ArtifactStore(runId);
    const pipeline = pipelineResult(runId);
    const snapshot = reviewSnapshot(runId);
    await store.writePipelineArtifact("pipeline-result", pipeline);
    await store.writeReviewSnapshot(snapshot);
    const pipelinePath = join(store.runDirectory, "pipeline", "pipeline-result.json");
    const pipelineBefore = await readFile(pipelinePath, "utf8");
    const eligibility = evaluateAutopilotEligibility({
      pipelineResult: pipeline,
      reviewSnapshot: snapshot,
      advisor: advisorReport,
      evaluatedAt: "2026-07-20T12:00:00.000Z",
    });
    filesystemHooks.beforeLink = async (_source, destination) => {
      if (!destination.endsWith("post-pipeline-autopilot.json")) return;
      const error = new Error("injected atomic publication failure") as NodeJS.ErrnoException;
      error.code = "EIO";
      throw error;
    };

    await expect(store.writePostPipelineAutopilotArtifacts({
      pipelineResult: pipeline,
      reviewSnapshot: snapshot,
      advisorReport,
      eligibility,
    })).rejects.toThrow(/injected atomic publication failure/u);
    filesystemHooks.beforeLink = undefined;

    await expect(store.readAdvisorReport()).resolves.toBeNull();
    await expect(store.readAutopilotEligibility()).resolves.toBeNull();
    expect(await readFile(pipelinePath, "utf8")).toBe(pipelineBefore);
  });

  it("never treats a partial post-pipeline envelope as eligible", async () => {
    const runId = "run-post-pipeline-partial";
    const store = new ArtifactStore(runId);
    await store.writePipelineArtifact("post-pipeline-autopilot", {
      artifactVersion: "1",
      advisorReport,
      advisorReportHash: "f".repeat(64),
    });

    await expect(store.readAdvisorReport()).rejects.toThrow(/artifacts are invalid/u);
    await expect(store.readAutopilotEligibility()).rejects.toThrow(/artifacts are invalid/u);
  });

  it("rejects caller-forged or non-strict post-pipeline eligibility", async () => {
    const runId = "run-forged-post-pipeline-autopilot";
    const store = new ArtifactStore(runId);
    const pipeline = pipelineResult(runId);
    const snapshot = reviewSnapshot(runId);
    await store.writePipelineArtifact("pipeline-result", pipeline);
    await store.writeReviewSnapshot(snapshot);
    const eligibility = evaluateAutopilotEligibility({
      pipelineResult: pipeline,
      reviewSnapshot: snapshot,
      advisor: advisorReport,
      evaluatedAt: "2026-07-20T12:00:00.000Z",
    });

    await expect(store.writePostPipelineAutopilotArtifacts({
      pipelineResult: pipeline,
      reviewSnapshot: snapshot,
      advisorReport,
      // Internally consistent (a false verdict WITH reasons), so it passes
      // strict validation and must be caught by the DERIVATION check instead.
      // A shared loose /eligibility/ matcher could not tell the two guards
      // apart, so dropping either one would have left this green.
      eligibility: { ...eligibility, eligible: false, reasons: ["forged verdict"] },
    })).rejects.toThrow(/was not derived from the supplied frozen evidence/u);
    await expect(store.writePostPipelineAutopilotArtifacts({
      pipelineResult: pipeline,
      reviewSnapshot: snapshot,
      advisorReport,
      // An unknown field must fail strict schema validation, not derivation.
      eligibility: { ...eligibility, extra: true } as unknown as typeof eligibility,
    })).rejects.toThrow(/record is invalid/u);
  });

  it("redacts secrets in persisted pipeline artifacts", async () => {
    const runId = "run-pipeline-redaction";
    const secret = "sk-pipeline-secret-12345678";
    const store = new ArtifactStore(runId);

    await store.writePipelineArtifact("round-1-review", {
      summary: `provider returned ${secret}`,
      nested: { rawOutput: `Bearer bearer-secret-value and ${secret}` },
    });

    const persisted = await readFile(join(
      store.runDirectory,
      "pipeline",
      "round-1-review.json",
    ), "utf8");
    expect(persisted).not.toContain(secret);
    expect(persisted).not.toContain("bearer-secret-value");
    await expect(store.readPipelineArtifact("round-1-review")).resolves.toEqual({
      nested: { rawOutput: "Bearer [b] and [k]" },
      summary: "provider returned [k]",
    });
  });

  it("promotes terminal artifacts before a decision and recomputes manifest integrity", async () => {
    const runId = "run-promote";
    const store = new ArtifactStore(runId);
    const original = sampleResult(runId);
    const promoted = { ...original, summary: "promoted result" };
    const originalManifest = buildRunManifest(manifestArgs(runId, "/repo"));
    const promotedManifest = { ...originalManifest, candidateManifestHash: emptyCandidateManifestHash };
    await store.writeResult(original);
    await store.writeManifest(originalManifest);

    await store.promoteTerminalArtifacts({ result: promoted, manifest: promotedManifest });

    await expect(store.readResult()).resolves.toEqual(promoted);
    await expect(store.readManifest()).resolves.toEqual(sanitizeRunManifest(promotedManifest));
  });

  it("rejects terminal promotion across run ids or after a decision", async () => {
    const runId = "run-promote-guarded";
    const store = new ArtifactStore(runId);
    const manifest = buildRunManifest(manifestArgs(runId, "/repo"));
    await store.writeResult(sampleResult(runId));
    await store.writeManifest(manifest);

    await expect(store.promoteTerminalArtifacts({
      result: sampleResult("different-run"),
      manifest,
    })).rejects.toThrow(/run id/i);
    await expect(store.promoteTerminalArtifacts({
      result: sampleResult(runId),
      manifest: buildRunManifest(manifestArgs("different-run", "/repo")),
    })).rejects.toThrow(/manifest id/i);

    await store.writeHumanDecision({
      decision: "accepted",
      candidateManifestHash: "a".repeat(64),
      evidenceHash: "b".repeat(64),
      policyVersion: "1",
      recordedAt: new Date().toISOString(),
    });
    await expect(store.promoteTerminalArtifacts({
      result: { ...sampleResult(runId), summary: "too late" },
      manifest,
    })).rejects.toThrow(/after a decision/i);
  });

  it("creates each missing plugin-data directory before archiving", async () => {
    const parent = await mkdtemp(join(tmpdir(), "claude-architect-missing-state-"));
    temporaryPaths.push(parent);
    process.env.CLAUDE_PLUGIN_DATA = join(parent, "nested", "plugin-data");
    const store = new ArtifactStore("run-missing-state");

    await store.writeResult(sampleResult("run-missing-state"));

    await expect(stat(join(
      process.env.CLAUDE_PLUGIN_DATA,
      "runs",
      "run-missing-state",
      "result.json",
    ))).resolves.toBeDefined();
  });

  it("preserves baseline and mutation policy on archived verification commands", async () => {
    const store = new ArtifactStore("run-allowed-mutations");
    const result = sampleResult("run-allowed-mutations");
    result.requestedVerification = [{
      id: "install-deps",
      executable: "npm",
      args: ["ci"],
      cwd: ".",
      timeoutMs: 60_000,
      network: "allowed",
      allowedMutations: "ignored-paths",
      expectBaselineFailure: true,
      expectedExitCodes: [0],
    }];

    await store.writeResult(result);

    const archived = await store.readResult();
    expect(archived?.requestedVerification[0]?.allowedMutations).toBe("ignored-paths");
    expect(archived?.requestedVerification[0]?.expectBaselineFailure).toBe(true);
  });

  it("round-trips an AttemptResult under plugin data", async () => {
    const store = new ArtifactStore("run-round-trip");
    const result = sampleResult("run-round-trip");

    await store.writeResult(result);

    await expect(store.readResult()).resolves.toEqual(result);
    await expect(store.list()).resolves.toContain("run-round-trip");
    await expect(access(join(
      process.env.CLAUDE_PLUGIN_DATA!,
      "runs",
      "run-round-trip",
      "result.json",
    ))).resolves.toBeUndefined();
    await expect(access(join(process.env.CLAUDE_PLUGIN_ROOT!, "runs"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("rejects malformed and cross-run archived AttemptResults", async () => {
    const malformedRunId = "run-malformed-result";
    const malformedStore = new ArtifactStore(malformedRunId);
    await malformedStore.writeLog("producer", "create run directory\n");
    await writeFile(join(malformedStore.runDirectory, "result.json"), "{}\n");
    await expect(malformedStore.readResult()).rejects.toThrow(
      /attempt result.*invalid|run id/i,
    );

    const crossRunId = "run-cross-result";
    const crossStore = new ArtifactStore(crossRunId);
    await crossStore.writeLog("producer", "create run directory\n");
    await writeFile(
      join(crossStore.runDirectory, "result.json"),
      `${JSON.stringify(sampleResult("different-run"))}\n`,
    );
    await expect(crossStore.readResult()).rejects.toThrow(/attempt result.*run id/i);
  });

  it("rejects case-colliding changed paths consumed from archived pipeline bytes", async () => {
    const runId = "run-case-colliding-pipeline";
    const store = new ArtifactStore(runId);
    const pipeline = pipelineResult(runId);
    const changedPaths = [
      { path: "Foo.txt", changeType: "added" as const, mode: "100644", contentHash: "b".repeat(40) },
      { path: "foo.txt", changeType: "added" as const, mode: "100644", contentHash: "c".repeat(40) },
    ];
    pipeline.attempt.candidate = {
      ...pipeline.attempt.candidate!,
      manifestHash: createHash("sha256").update(JSON.stringify(changedPaths)).digest("hex"),
      changedPaths,
    };
    await store.writePipelineArtifact("pipeline-result", pipeline);
    const archivedBytes = await store.readEvidence("pipeline/pipeline-result.json");
    expect(archivedBytes).not.toBeNull();
    const archivedPipeline = JSON.parse(archivedBytes!);

    const eligibility = evaluateAutopilotEligibility({
      pipelineResult: archivedPipeline,
      reviewSnapshot: reviewSnapshot(runId),
      advisor: advisorReport,
      evaluatedAt: "2026-07-20T12:00:00.000Z",
    });
    expect(eligibility).toMatchObject({
      eligible: false,
      reasons: expect.arrayContaining(["pipeline result is malformed"]),
    });
  });

  it("rejects a runtime-invalid AttemptResult before writing it", async () => {
    const runId = "run-invalid-result-write";
    const store = new ArtifactStore(runId);
    const invalid = {
      ...sampleResult(runId),
      status: "verified-candidate",
      failure: null,
      candidate: null,
    } as AttemptResult;

    await expect(store.writeResult(invalid)).rejects.toThrow(/attempt result.*invalid/i);
  });

  it("validates the run id once, at construction, before any read", () => {
    expect(() => new ArtifactStore("../run-manifest-id-check")).toThrow(/invalid run id/i);
  });

  it("binds every read façade to the run it was constructed for", async () => {
    const bound = new ArtifactStore("run-bound-a");
    const other = new ArtifactStore("run-bound-b");
    await bound.writeResult(sampleResult("run-bound-a"));

    await expect(bound.readResult()).resolves.toMatchObject({ runId: "run-bound-a" });
    await expect(other.readResult()).resolves.toBeNull();
    for (const facade of [
      "readResult", "readManifest", "readRunStatus", "readReviewSnapshot", "readCandidateDecision",
      "readDecision", "readPipelineGateCleared", "readPipelineActiveMarker", "readAdvisorReport",
      "readAutopilotEligibility", "readRunStartSpecSha256",
    ] as const) {
      expect(ArtifactStore.prototype[facade].length, facade).toBe(0);
    }
  });

  it("treats an archived runtime version as provenance", async () => {
    const runId = "run-older-runtime";
    const store = new ArtifactStore(runId);
    const manifest = {
      ...buildRunManifest(manifestArgs(runId, "/repo")),
      runtimeVersion: "0.16.0",
    };

    await store.writeManifest(manifest);

    await expect(store.readManifest()).resolves.toMatchObject({
      runId,
      runtimeVersion: "0.16.0",
    });
  });

  it("rejects incompatible manifest schema versions before writing", async () => {
    const runId = "run-incompatible-manifest-schema";
    const store = new ArtifactStore(runId);
    const manifest = buildRunManifest(manifestArgs(runId, "/repo"));

    await expect(store.writeManifest({
      ...manifest,
      schemaVersions: { ...manifest.schemaVersions, delegationSpec: "2" },
    } as never)).rejects.toThrow(/manifest contract/i);
    await expect(access(join(store.runDirectory, "manifest.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("rejects an invalid manifest shape before writing", async () => {
    const runId = "run-invalid-manifest-shape";
    const store = new ArtifactStore(runId);
    const manifest = buildRunManifest(manifestArgs(runId, "/repo"));

    await expect(store.writeManifest({
      ...manifest,
      producer: { ...manifest.producer, unexpected: true },
    } as never)).rejects.toThrow(/manifest.*malformed|manifest contract/i);
    await expect(access(join(store.runDirectory, "manifest.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("rejects an oversized archive entry before reading it into memory", async () => {
    const runId = "run-oversized-read";
    const store = new ArtifactStore(runId);
    await store.writeResult(sampleResult(runId));
    await truncate(join(store.runDirectory, "result.json"), 8_000_001);

    await expect(store.readResult()).rejects.toThrow(/archive entry.*large|byte limit/i);
  });

  it("rejects a hardlinked archive entry", async () => {
    const runId = "run-hardlinked-read";
    const store = new ArtifactStore(runId);
    await store.writeResult(sampleResult(runId));
    const destination = join(store.runDirectory, "result.json");
    const external = join(process.env.CLAUDE_PLUGIN_DATA!, "external-result.json");
    await writeFile(external, `${JSON.stringify({
      ...sampleResult(runId),
      summary: "forged hardlink result",
    })}\n`);
    await rm(destination);
    await link(external, destination);

    await expect(store.readResult()).rejects.toThrow(/hardlink|link count/i);
  });

  it("fails size accounting when a run directory is swapped for a symlink", async () => {
    const runId = "run-size-swap";
    const store = new ArtifactStore(runId);
    await store.writeResult(sampleResult(runId));
    const preserved = join(process.env.CLAUDE_PLUGIN_DATA!, "preserved-size-swap");
    const external = await mkdtemp(join(tmpdir(), "claude-architect-size-external-"));
    temporaryPaths.push(external);
    await writeFile(join(external, "outside.txt"), "outside\n");
    let swapped = false;
    filesystemHooks.beforeDirectoryRead = async filename => {
      if (swapped || filename !== store.runDirectory) return;
      swapped = true;
      filesystemHooks.beforeDirectoryRead = undefined;
      await rename(store.runDirectory, preserved);
      await symlink(external, store.runDirectory, "dir");
    };

    await expect(store.prune({
      maxAgeMs: Number.MAX_SAFE_INTEGER,
      maxBytes: Number.MAX_SAFE_INTEGER,
    })).rejects.toThrow(/directory identity|symbolic link/i);

    expect(swapped).toBe(true);
    await expect(readFile(join(external, "outside.txt"), "utf8")).resolves.toBe("outside\n");
  });

  it("binds size accounting to the directory identity captured by listing", async () => {
    const runId = "run-size-identity";
    const store = new ArtifactStore(runId);
    await store.writeResult(sampleResult(runId));
    const preserved = join(process.env.CLAUDE_PLUGIN_DATA!, "preserved-size-identity");
    let probes = 0;
    filesystemHooks.beforeLstat = async filename => {
      if (filename !== store.runDirectory || ++probes !== 2) return;
      filesystemHooks.beforeLstat = undefined;
      await rename(store.runDirectory, preserved);
      await mkdir(store.runDirectory);
      await writeFile(join(store.runDirectory, "replacement.txt"), "replacement\n");
    };

    await expect(store.prune({
      maxAgeMs: Number.MAX_SAFE_INTEGER,
      maxBytes: Number.MAX_SAFE_INTEGER,
    })).rejects.toThrow(/directory identity/i);

    expect(probes).toBe(2);
    await expect(stat(preserved)).resolves.toBeDefined();
  });

  it.each(["../../outside.ts", "/absolute.ts", "C:\\outside.ts", "src/../outside.ts"])(
    "rejects an unsafe candidate path %s",
    async candidatePath => {
      const runId = "run-unsafe-candidate-path";
      const store = new ArtifactStore(runId);
      const result = sampleResult(runId);
      const changedPaths = [{
        path: candidatePath,
        changeType: "added" as const,
        mode: "100644",
        contentHash: "b".repeat(40),
      }];
      result.failure = "verification-failure";
      result.candidate = {
        baseCommitOid: "a".repeat(40),
        candidateTreeOid: "b".repeat(40),
        candidateCommitOid: "c".repeat(40),
        anchorRef: `refs/claude-architect/candidates/${runId}`,
        manifestHash: createHash("sha256").update(JSON.stringify(changedPaths)).digest("hex"),
        changedPaths,
        patch: "",
      };

      await expect(store.writeResult(result)).rejects.toThrow(/candidate path/i);
    },
  );

  it("does not expose a production writer for new legacy decisions", () => {
    expect("writeDecision" in new ArtifactStore("run-no-legacy-writer")).toBe(false);
  });

  it("persists the first v2 decision, treats identical provenance as idempotent, and rejects conflicts", async () => {
    const runId = "run-decision";
    const store = new ArtifactStore(runId);
    await store.writeResult(sampleResult(runId));
    const first = {
      decision: "revision-requested" as const,
      candidateManifestHash: "a".repeat(64),
      evidenceHash: "b".repeat(64),
      policyVersion: "1" as const,
      recordedAt: "2026-07-14T12:00:00.000Z",
    };

    await store.writeHumanDecision(first);
    await store.writeHumanDecision({
      ...first,
      recordedAt: "2026-07-14T12:01:00.000Z",
    });
    await expect(store.writeHumanDecision({
      ...first,
      decision: "accepted",
      recordedAt: "2026-07-14T12:02:00.000Z",
    })).rejects.toMatchObject({
      message: "candidate decision conflict: recorded revision-requested, attempted accepted",
      detail: { toolError: "decision-conflict" },
    });

    await expect(store.readCandidateDecision()).resolves.toEqual({
      ...first,
      decisionVersion: "2",
      authority: "human",
    });
    const stored = JSON.parse(await readFile(join(store.runDirectory, "decision.json"), "utf8"));
    expect(stored).toEqual({
      ...first,
      decisionVersion: "2",
      authority: "human",
    });
  });

  it("reads a legacy decision in memory without rewriting its archived bytes", async () => {
    const runId = "run-legacy-decision";
    const store = new ArtifactStore(runId);
    await store.writeResult(sampleResult(runId));
    const legacy = {
      decision: "accepted" as const,
      recordedAt: "2026-07-14T12:00:00.000Z",
    };
    const decisionPath = join(store.runDirectory, "decision.json");
    await writeFile(decisionPath, `${JSON.stringify(legacy)}\n`);
    const before = await readFile(decisionPath, "utf8");

    // "unknown", not "human": the record predates provenance, so it says a
    // decision happened and nothing about who made it. Reporting a person would
    // invent evidence and hand it the one authority integration accepts.
    await expect(store.readCandidateDecision()).resolves.toEqual({
      decisionVersion: "1",
      decision: "accepted",
      authority: "unknown",
      recordedAt: legacy.recordedAt,
    });
    await expect(store.writeHumanDecision({
      decision: "accepted",
      candidateManifestHash: "a".repeat(64),
      evidenceHash: "b".repeat(64),
      policyVersion: "1",
      recordedAt: "2026-07-14T12:01:00.000Z",
    })).rejects.toMatchObject({
      detail: { toolError: "decision-conflict" },
    });
    expect(await readFile(decisionPath, "utf8")).toBe(before);
    expect(JSON.parse(before)).toEqual(legacy);
  });

  it("writes human decisions as v2 and requires identical provenance for idempotence", async () => {
    const runId = "run-human-decision-v2";
    const store = new ArtifactStore(runId);
    const first = {
      decision: "accepted" as const,
      candidateManifestHash: "a".repeat(64),
      evidenceHash: "b".repeat(64),
      policyVersion: "1" as const,
      recordedAt: "2026-07-14T12:00:00.000Z",
    };
    await store.writeHumanDecision(first);
    await store.writeHumanDecision({
      ...first,
      recordedAt: "2026-07-14T12:01:00.000Z",
    });

    for (const conflicting of [
      { ...first, decision: "rejected" as const },
      { ...first, candidateManifestHash: "c".repeat(64) },
      { ...first, evidenceHash: "d".repeat(64) },
    ]) {
      await expect(store.writeHumanDecision(conflicting)).rejects.toMatchObject({
        detail: { toolError: "decision-conflict" },
      });
    }
    const expected = {
      ...first,
      decisionVersion: "2",
      authority: "human",
    };
    await expect(store.readCandidateDecision()).resolves.toEqual(expected);
    expect(JSON.parse(await readFile(join(store.runDirectory, "decision.json"), "utf8")))
      .toEqual(expected);
  });

  it("writes accepted autopilot decisions only from the current archived eligibility record", async () => {
    const runId = "run-autopilot-decision-v2";
    const store = new ArtifactStore(runId);
    const pipeline = pipelineResult(runId);
    const snapshot = reviewSnapshot(runId);
    const candidate = pipeline.attempt.candidate!;
    await store.writeResult(sampleResult(runId));
    await store.writePipelineArtifact("pipeline-result", pipeline);
    await store.writeReviewSnapshot(snapshot);
    const eligibility = evaluateAutopilotEligibility({
      pipelineResult: pipeline,
      reviewSnapshot: snapshot,
      advisor: advisorReport,
      evaluatedAt: "2026-07-14T12:00:00.000Z",
    });
    const hashes = await store.writePostPipelineAutopilotArtifacts({
      pipelineResult: pipeline,
      reviewSnapshot: snapshot,
      advisorReport,
      eligibility,
    });
    const persisted = {
      decisionVersion: "2",
      decision: "accepted",
      authority: "autopilot-policy",
      candidateManifestHash: candidate.manifestHash,
      evidenceHash: hashes.eligibilityRecordHash,
      policyVersion: "1",
      recordedAt: "2026-07-14T12:00:00.000Z",
    };
    await store.writeAutopilotDecision(candidate, eligibility, persisted.recordedAt);
    await store.writeAutopilotDecision(
      candidate,
      eligibility,
      "2026-07-14T12:01:00.000Z",
    );

    await expect(store.readCandidateDecision()).resolves.toEqual(persisted);
    expect(JSON.parse(await readFile(join(store.runDirectory, "decision.json"), "utf8")))
      .toEqual(persisted);

    await writeFile(join(store.runDirectory, "decision.json"), JSON.stringify({
      ...persisted,
      evidenceHash: "c".repeat(64),
    }));
    await expect(store.writeAutopilotDecision(
      candidate,
      eligibility,
      "2026-07-14T12:02:00.000Z",
    )).rejects.toMatchObject({ detail: { toolError: "decision-conflict" } });

    await rm(join(store.runDirectory, "pipeline", "post-pipeline-autopilot.json"));
    await expect(store.writeAutopilotDecision(
      candidate,
      eligibility,
      "2026-07-14T12:03:00.000Z",
    )).rejects.toThrow(/eligibility is invalid/u);
  });

  it("rejects forged or ineligible autopilot provenance", async () => {
    const runId = "run-autopilot-forgery";
    const store = new ArtifactStore(runId);
    const pipeline = pipelineResult(runId);
    const snapshot = reviewSnapshot(runId);
    const candidate = pipeline.attempt.candidate!;
    await store.writePipelineArtifact("pipeline-result", pipeline);
    await store.writeReviewSnapshot(snapshot);
    const eligibility = evaluateAutopilotEligibility({
      pipelineResult: pipeline,
      reviewSnapshot: snapshot,
      advisor: advisorReport,
      evaluatedAt: "2026-07-14T12:00:00.000Z",
    });
    await store.writePostPipelineAutopilotArtifacts({
      pipelineResult: pipeline,
      reviewSnapshot: snapshot,
      advisorReport,
      eligibility,
    });

    await expect(store.writeAutopilotDecision(candidate, {
      ...eligibility,
      candidateManifestHash: "f".repeat(64),
    }, "2026-07-14T12:00:00.000Z")).rejects.toThrow(/eligibility is invalid/u);
    await expect(store.writeAutopilotDecision({
      ...candidate,
      manifestHash: "f".repeat(64),
    }, {
      ...eligibility,
      candidateManifestHash: "f".repeat(64),
    }, "2026-07-14T12:00:00.000Z")).rejects.toThrow(/eligibility is invalid/u);
    await expect(store.writeAutopilotDecision({
      ...candidate,
      candidateTreeOid: "f".repeat(40),
    }, eligibility, "2026-07-14T12:00:00.000Z")).rejects.toThrow(/eligibility is invalid/u);
    await expect(store.writeAutopilotDecision(candidate, {
      ...eligibility,
      eligible: false,
    }, "2026-07-14T12:00:00.000Z"))
      .rejects.toThrow(/eligibility is invalid/u);
    await expect(store.readCandidateDecision()).resolves.toBeNull();
  });

  it("requires idempotent decision retries to match authority and candidate binding", async () => {
    const runId = "run-decision-authority";
    const store = new ArtifactStore(runId);
    await store.writeResult(sampleResult(runId));
    const original = {
      decisionVersion: "2" as const,
      decision: "accepted" as const,
      authority: "human" as const,
      candidateManifestHash: "a".repeat(64),
      evidenceHash: "b".repeat(64),
      policyVersion: "1" as const,
      recordedAt: "2026-07-27T12:00:00.000Z",
    };
    await store.writeCandidateDecisionRecord(original);
    await store.writeCandidateDecisionRecord({
      ...original,
      recordedAt: "2026-07-27T12:01:00.000Z",
    });

    // Authority is part of a decision's identity: the same verdict recorded
    // under a different authority is a different claim about who decided.
    for (const conflicting of [
      { ...original, authority: "policy-autonomous" as const },
      { ...original, candidateManifestHash: "b".repeat(64) },
    ]) {
      await expect(store.writeCandidateDecisionRecord(conflicting)).rejects.toMatchObject({
        detail: { toolError: "decision-conflict" },
      });
    }
    await expect(store.readCandidateDecision()).resolves.toEqual(original);
  });

  it("atomically preserves one decision when conflicting writers race", async () => {
    const runId = "run-decision-race";
    const firstStore = new ArtifactStore(runId);
    const secondStore = new ArtifactStore(runId);
    await firstStore.writeResult(sampleResult(runId));
    const records = [{
      decision: "accepted" as const,
      candidateManifestHash: "a".repeat(64),
      evidenceHash: "b".repeat(64),
      policyVersion: "1" as const,
      recordedAt: "2026-07-14T12:00:00.000Z",
    }, {
      decision: "rejected" as const,
      candidateManifestHash: "a".repeat(64),
      evidenceHash: "b".repeat(64),
      policyVersion: "1" as const,
      recordedAt: "2026-07-14T12:01:00.000Z",
    }] as const;
    let arrivals = 0;
    let markReady!: () => void;
    let releaseWriters!: () => void;
    const ready = new Promise<void>(resolve => { markReady = resolve; });
    const writersReleased = new Promise<void>(resolve => { releaseWriters = resolve; });
    filesystemHooks.beforeLink = async (_source, destination) => {
      if (!destination.endsWith(join(runId, "decision.json"))) return;
      arrivals += 1;
      if (arrivals === 2) markReady();
      await writersReleased;
    };

    const pending = [
      firstStore.writeHumanDecision(records[0]),
      secondStore.writeHumanDecision(records[1]),
    ];
    await ready;
    releaseWriters();
    const outcomes = await Promise.allSettled(pending);

    expect(outcomes.filter(outcome => outcome.status === "fulfilled")).toHaveLength(1);
    const winnerIndex = outcomes.findIndex(outcome => outcome.status === "fulfilled");
    const rejected = outcomes.find(outcome => outcome.status === "rejected");
    expect(rejected).toMatchObject({
      reason: { detail: { toolError: "decision-conflict" } },
    });
    await expect(firstStore.readCandidateDecision()).resolves.toEqual({
      decisionVersion: "2",
      ...records[winnerIndex],
      authority: "human",
    });
  });

  it.each([true, false])("round-trips an explicit sliced=%s pipeline marker", async sliced => {
    const runId = `run-pipeline-marker-${sliced}`;
    const store = new ArtifactStore(runId);
    const marker = {
      pid: process.pid,
      processToken: null,
      startedAt: "2026-07-19T12:00:00.000Z",
      sliced,
    };
    await store.writeLog("lifecycle", "create run directory\n");

    await store.writePipelineActiveMarker(marker);

    await expect(store.readPipelineActiveMarker()).resolves.toEqual(marker);
  });

  it("rejects a legacy pipeline marker without sliced", async () => {
    const runId = "run-pipeline-marker-legacy";
    const store = new ArtifactStore(runId);
    await store.writeLog("lifecycle", "create run directory\n");
    await writeFile(join(store.runDirectory, "pipeline-active.json"), `${JSON.stringify({
      pid: process.pid,
      processToken: null,
      startedAt: "2026-07-19T12:00:00.000Z",
    })}\n`);

    await expect(store.readPipelineActiveMarker()).rejects.toThrow(
      /pipeline-active marker is malformed/i,
    );
  });

  it.each([null, "true", 1, {}])(
    "rejects a malformed present pipeline marker discriminator %#",
    async sliced => {
      const runId = "run-pipeline-marker-malformed";
      const store = new ArtifactStore(runId);
      await store.writeLog("lifecycle", "create run directory\n");
      await writeFile(join(store.runDirectory, "pipeline-active.json"), `${JSON.stringify({
        pid: process.pid,
        processToken: null,
        startedAt: "2026-07-19T12:00:00.000Z",
        sliced,
      })}\n`);

      await expect(store.readPipelineActiveMarker()).rejects.toThrow(
        /pipeline-active marker is malformed/i,
      );
    },
  );

  it("rejects a newly written pipeline marker without an explicit discriminator", async () => {
    const store = new ArtifactStore("run-pipeline-marker-missing-discriminator");
    await store.writeLog("lifecycle", "create run directory\n");

    await expect(store.writePipelineActiveMarker({
      pid: process.pid,
      processToken: null,
      startedAt: "2026-07-19T12:00:00.000Z",
    } as never)).rejects.toThrow(/pipeline-active marker is invalid/i);
  });

  it("does not accept a forged result after a validated run directory is swapped", async () => {
    const runId = "run-read-swap";
    const store = new ArtifactStore(runId);
    await store.writeResult(sampleResult(runId));
    const preservedPath = join(process.env.CLAUDE_PLUGIN_DATA!, "preserved-run-read-swap");
    let swapped = false;
    filesystemHooks.beforeOpen = async filename => {
      if (swapped || !filename.endsWith(join(runId, "result.json"))) return;
      swapped = true;
      filesystemHooks.beforeOpen = undefined;
      await rename(store.runDirectory, preservedPath);
      await mkdir(store.runDirectory);
      await writeFile(filename, `${JSON.stringify({
        ...sampleResult(runId),
        summary: "forged result",
      })}\n`);
    };

    const result = await store.readResult().catch(() => null);

    expect(swapped).toBe(true);
    expect(result?.summary).not.toBe("forged result");
    await expect(stat(preservedPath)).resolves.toBeDefined();
  });

  it("keeps archived JSON valid when a registered secret contains JSON syntax", async () => {
    const registration = registerSecretValue('"runId"');
    const store = new ArtifactStore("run-json-syntax");

    await store.writeResult(sampleResult("run-json-syntax"));

    const stored = await readFile(join(store.runDirectory, "result.json"), "utf8");
    expect(() => JSON.parse(stored)).not.toThrow();
    expect(stored).not.toContain('"runId"');
    await expect(store.readResult()).resolves.toMatchObject({
      runId: "run-json-syntax",
    });
    registration.dispose();
  });

  it("preserves required result keys when their names equal registered values", async () => {
    const registration = registerSecretValue("ummary");
    const store = new ArtifactStore("run-required-key");

    await store.writeResult(sampleResult("run-required-key"));

    const stored = await readFile(join(store.runDirectory, "result.json"), "utf8");
    expect(stored).not.toContain("ummary");
    await expect(store.readResult()).resolves.toMatchObject({
      summary: "producer exited non-zero",
    });
    registration.dispose();
  });

  it("fails closed instead of redacting an AttemptResult status", async () => {
    const registration = registerSecretValue("failed");
    const store = new ArtifactStore("run-status-collision");

    await expect(store.writeResult(sampleResult("run-status-collision"))).rejects.toThrow(
      /safely persist|status/,
    );
    await expect(access(join(store.runDirectory, "result.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    registration.dispose();
  });

  it.each([
    ["producer id", (result: AttemptResult) => { result.producerId = "identity-secret"; }],
    ["producer version", (result: AttemptResult) => { result.producerVersion = "identity-secret"; }],
    ["producer model", (result: AttemptResult) => { result.producerModel = "identity-secret"; }],
    ["session id", (result: AttemptResult) => { result.sessionId = "identity-secret"; }],
  ])("fails closed instead of redacting the AttemptResult %s", async (_label, assign) => {
    const registration = registerSecretValue("identity-secret");
    const store = new ArtifactStore("run-result-identity");
    const result = sampleResult("run-result-identity");
    assign(result);

    await expect(store.writeResult(result)).rejects.toThrow(/safely persist/);
    await expect(access(join(store.runDirectory, "result.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    registration.dispose();
  });

  it("fails closed instead of changing hash-bound candidate paths", async () => {
    const secretPath = "enterprise-secret-path.ts";
    const registration = registerSecretValue(secretPath);
    const store = new ArtifactStore("run-candidate-path-collision");
    const result = sampleResult("run-candidate-path-collision");
    const changedPaths = [{
      path: secretPath,
      changeType: "added" as const,
      mode: "100644",
      contentHash: "b".repeat(40),
    }];
    result.failure = "verification-failure";
    result.candidate = {
      baseCommitOid: "a".repeat(40),
      candidateTreeOid: "b".repeat(40),
      candidateCommitOid: "c".repeat(40),
      anchorRef: "refs/claude-architect/candidates/run-candidate-path-collision",
      manifestHash: createHash("sha256").update(JSON.stringify(changedPaths)).digest("hex"),
      changedPaths,
      patch: "",
    };

    await expect(store.writeResult(result)).rejects.toThrow(/candidate path|safely persist/);
    registration.dispose();
  });

  it("writes redacted logs and returns a relative archive ref", async () => {
    const registration = registerSecretValue("enterprise-secret-value");
    const store = new ArtifactStore("run-log");

    const ref = await store.writeLog("producer", "output enterprise-secret-value\n");

    expect(ref).toBe("logs/producer.log");
    const stored = await readFile(join(process.env.CLAUDE_PLUGIN_DATA!, "runs", "run-log", ref), "utf8");
    expect(stored).not.toContain("enterprise-secret-value");
    expect(stored).toContain("[s]");
    registration.dispose();
  });

  it("redacts registered secrets containing literal marker text from logs", async () => {
    const secret = "prefix[s]suffix";
    const registration = registerSecretValue(secret);
    const store = new ArtifactStore("run-marker-secret-log");

    const ref = await store.writeLog("producer", `output ${secret}\n`);

    const stored = await readFile(join(store.runDirectory, ref), "utf8");
    expect(stored).not.toContain(secret);
    expect(stored).toBe("output [s]\n");
    registration.dispose();
  });

  it("redacts registered marker secrets before JSON escaping can hide them", async () => {
    const secret = 'prefix"[s]\\suffix';
    const registration = registerSecretValue(secret);
    const store = new ArtifactStore("run-marker-secret-json");
    const result = sampleResult("run-marker-secret-json");
    result.summary = secret;

    await store.writeResult(result);

    const stored = await readFile(join(store.runDirectory, "result.json"), "utf8");
    const parsed = JSON.parse(stored) as AttemptResult;
    expect(parsed.summary).toBe("[s]");
    expect(JSON.stringify(parsed)).not.toContain(secret);
    registration.dispose();
  });

  it("does not persist a registered secret created by pattern redaction", async () => {
    const secret = "prefix [k] suffix";
    const registration = registerSecretValue(secret);
    const store = new ArtifactStore("run-cascading-secret-log");

    const ref = await store.writeLog(
      "producer",
      "prefix sk-ABCDEF0123456789 suffix",
    );

    const stored = await readFile(join(store.runDirectory, ref), "utf8");
    expect(stored).toBe("[s]");
    expect(stored).not.toContain(secret);
    registration.dispose();
  });

  it("redacts registered secrets used as JSON property names", async () => {
    const secret = "enterprise-secret-key";
    const registration = registerSecretValue(secret);
    const store = new ArtifactStore("run-json-key");
    const result = sampleResult("run-json-key");
    result.evidence = { [secret]: "ordinary value" };

    await store.writeResult(result);

    const stored = await readFile(join(
      process.env.CLAUDE_PLUGIN_DATA!,
      "runs",
      "run-json-key",
      "result.json",
    ), "utf8");
    expect(stored).not.toContain(secret);
    const parsed = JSON.parse(stored) as AttemptResult;
    expect(Object.keys(parsed.evidence)).toContain("[s]");
    registration.dispose();
  });

  it("rejects path traversal in run and log names", async () => {
    expect(() => new ArtifactStore("../outside")).toThrow(/invalid run id/);
    expect(() => new ArtifactStore("CON")).toThrow(/invalid run id/);
    expect(() => new ArtifactStore("Run-A")).toThrow(/invalid run id/);
    const store = new ArtifactStore("run-safe");

    await expect(store.writeLog("../outside", "text")).rejects.toThrow(/invalid log name/);
  });

  it("rejects a symlinked archive directory instead of writing outside plugin data", async () => {
    const external = await mkdtemp(join(tmpdir(), "claude-architect-external-"));
    temporaryPaths.push(external);
    const runDirectory = join(process.env.CLAUDE_PLUGIN_DATA!, "runs", "run-linked");
    await mkdir(runDirectory, { recursive: true });
    await symlink(external, join(runDirectory, "logs"), "dir");
    const store = new ArtifactStore("run-linked");

    await expect(store.writeLog("producer", "must stay contained")).rejects.toThrow(
      /archive directory|symbolic link/,
    );
    await expect(access(join(external, "producer.log"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps terminal artifacts create-once and permits idempotent retries", async () => {
    const store = new ArtifactStore("run-create-once");
    const original = sampleResult("run-create-once");
    await store.writeResult(original);

    await expect(store.writeResult(original)).resolves.toBeUndefined();
    await expect(store.writeResult({
      ...original,
      summary: "conflicting terminal result",
    })).rejects.toThrow(/already exists with different content/);
    await expect(store.readResult()).resolves.toEqual(original);
  });

  it("allows only one conflicting concurrent terminal write", async () => {
    const store = new ArtifactStore("run-concurrent");
    const first = sampleResult("run-concurrent");
    const second = { ...first, summary: "different terminal result" };

    const outcomes = await Promise.allSettled([
      store.writeResult(first),
      store.writeResult(second),
    ]);

    expect(outcomes.filter(outcome => outcome.status === "fulfilled")).toHaveLength(1);
    const stored = await store.readResult();
    expect([first.summary, second.summary]).toContain(stored?.summary);
  });

  it("prunes over-age runs", async () => {
    const oldStore = new ArtifactStore("run-old");
    await writePrunableResult(oldStore, "run-old", sampleResult("run-old"));
    const oldDirectory = join(process.env.CLAUDE_PLUGIN_DATA!, "runs", "run-old");
    const oldTime = new Date(Date.now() - 60_000);
    await utimes(oldDirectory, oldTime, oldTime);

    const result = await oldStore.prune({ maxAgeMs: 1_000, maxBytes: Number.MAX_SAFE_INTEGER });

    expect(result.removed).toContain("run-old");
    await expect(stat(oldDirectory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reclaims over-age runs through the cross-run pruneRuns wrapper", async () => {
    const oldStore = new ArtifactStore("run-wrapper-old");
    await writePrunableResult(oldStore, "run-wrapper-old", sampleResult("run-wrapper-old"));
    const oldDirectory = join(process.env.CLAUDE_PLUGIN_DATA!, "runs", "run-wrapper-old");
    const oldTime = new Date(Date.now() - 60_000);
    await utimes(oldDirectory, oldTime, oldTime);

    const result = await pruneRuns({ maxAgeMs: 1_000, maxBytes: Number.MAX_SAFE_INTEGER });

    expect(result.removed).toContain("run-wrapper-old");
    await expect(stat(oldDirectory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("fast-retains an active pipeline marker without acquiring a checkout lease", async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), "claude-architect-active-prune-repo-"));
    temporaryPaths.push(repoRoot);
    await git(repoRoot, ["init", "-q"]);
    await git(repoRoot, ["commit", "--allow-empty", "-q", "-m", "base"]);
    const runId = "run-active-prune";
    const store = new ArtifactStore(runId);
    await store.writeResult(sampleResult(runId));
    await store.writeManifest(buildRunManifest(manifestArgs(runId, repoRoot)));
    await store.writePipelineActiveMarker({
      pid: 4242,
      processToken: "test:live",
      startedAt: new Date().toISOString(),
      sliced: false,
    });
    const oldTime = new Date(Date.now() - 60_000);
    await utimes(store.runDirectory, oldTime, oldTime);

    const result = await store.prune(
      { maxAgeMs: 1_000, maxBytes: Number.MAX_SAFE_INTEGER },
      {
        platformServices: {
          async canonicalizePath() { throw new Error("must not canonicalize an active run"); },
          async acquireCheckoutLock() { throw new Error("must not lock an active run"); },
        },
      },
    );

    expect(result.removed).not.toContain(runId);
    expect(result.retained).toContainEqual({ runId, reason: "active-run" });
    await expect(stat(store.runDirectory)).resolves.toBeDefined();
  });

  it("rereads the active marker under the checkout lease before pruning", async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), "claude-architect-waiting-prune-repo-"));
    temporaryPaths.push(repoRoot);
    await git(repoRoot, ["init", "-q"]);
    await git(repoRoot, ["commit", "--allow-empty", "-q", "-m", "base"]);
    const commonDir = await realpath(join(repoRoot, ".git"));
    const runId = "run-active-while-prune-waits";
    const store = new ArtifactStore(runId);
    await store.writeResult(sampleResult(runId));
    await store.writeManifest(buildRunManifest(manifestArgs(runId, repoRoot)));
    await utimes(store.runDirectory, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));
    const events: string[] = [];

    const result = await store.prune(
      { maxAgeMs: 1_000, maxBytes: Number.MAX_SAFE_INTEGER },
      {
        platformServices: {
          async canonicalizePath(input) {
            return { input, canonical: repoRoot, gitCommonDir: commonDir };
          },
          async acquireCheckoutLock() {
            events.push("acquire");
            await store.writePipelineActiveMarker({
              pid: 4343,
              processToken: "test:live",
              startedAt: new Date().toISOString(),
              sliced: false,
            });
            return {
              key: "test",
              repositoryIdentity: commonDir,
              async release() { events.push("release"); },
            };
          },
        },
      },
    );

    expect(events).toEqual(["acquire", "release"]);
    expect(result.removed).not.toContain(runId);
    expect(result.retained).toContainEqual({ runId, reason: "active-run" });
    await expect(stat(store.runDirectory)).resolves.toBeDefined();
  });

  it("retains an archive without journaling when checkout lease acquisition fails", async () => {
    const runId = "run-prune-acquire-failure";
    const store = new ArtifactStore(runId);
    const repoRoot = await writePrunableResult(store, runId, sampleResult(runId));
    const commonDir = await realpath(join(repoRoot, ".git"));
    await utimes(store.runDirectory, new Date(0), new Date(0));

    const result = await store.prune(
      { maxAgeMs: 1_000, maxBytes: Number.MAX_SAFE_INTEGER },
      {
        platformServices: {
          async canonicalizePath(input) {
            return { input, canonical: repoRoot, gitCommonDir: commonDir };
          },
          async acquireCheckoutLock() { throw new Error("lease unavailable"); },
        },
      },
    );

    expect(result.removed).not.toContain(runId);
    expect(result.retained).toContainEqual({ runId, reason: "lease unavailable" });
    await expect(stat(store.runDirectory)).resolves.toBeDefined();
    await expect(readFile(join(process.env.CLAUDE_PLUGIN_DATA!, "runs", "cleanup.ndjson"), "utf8"))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("retains latest terminal authority when the result changes while waiting", async () => {
    const runId = "run-prune-result-changed";
    const store = new ArtifactStore(runId);
    const initial = sampleResult(runId);
    const repoRoot = await writePrunableResult(store, runId, initial);
    const commonDir = await realpath(join(repoRoot, ".git"));
    await utimes(store.runDirectory, new Date(0), new Date(0));
    const replacement = { ...initial, summary: "new terminal authority" };

    const result = await store.prune(
      { maxAgeMs: 1_000, maxBytes: Number.MAX_SAFE_INTEGER },
      {
        platformServices: {
          async canonicalizePath(input) {
            return { input, canonical: repoRoot, gitCommonDir: commonDir };
          },
          async acquireCheckoutLock() {
            await rm(join(store.runDirectory, "result.json"));
            await store.writeResult(replacement);
            return { key: "test", repositoryIdentity: commonDir, async release() {} };
          },
        },
      },
    );

    expect(result.removed).not.toContain(runId);
    expect(result.retained.some(entry => entry.reason.includes("authority changed"))).toBe(true);
    await expect(store.readResult()).resolves.toEqual(replacement);
  });

  it("records repository identity for candidate-null cleanup intents", async () => {
    const runId = "run-null-candidate-intent";
    const store = new ArtifactStore(runId);
    const repoRoot = await writePrunableResult(store, runId, sampleResult(runId));
    await utimes(store.runDirectory, new Date(0), new Date(0));

    const result = await store.prune({ maxAgeMs: 1_000, maxBytes: Number.MAX_SAFE_INTEGER });

    expect(result.removed).toContain(runId);
    const records = (await readFile(
      join(process.env.CLAUDE_PLUGIN_DATA!, "runs", "cleanup.ndjson"),
      "utf8",
    )).trim().split("\n").map(line => JSON.parse(line) as {
      event: string; repoRoot: string | null; anchorRef: string | null;
    });
    expect(records[0]).toMatchObject({
      event: "prune-cleanup-intent",
      repoRoot: await realpath(repoRoot),
      anchorRef: null,
    });
  });

  it("reclaims a run whose repository was deleted so pruning converges", async () => {
    const runId = "run-repo-gone-prune";
    const store = new ArtifactStore(runId);
    const repoRoot = await writePrunableResult(store, runId, sampleResult(runId));
    await utimes(store.runDirectory, new Date(0), new Date(0));

    // The delegating repository is deleted, so canonicalizePath(repoRoot) throws ENOENT.
    // Without the fix the run is retained forever and its bytes never reclaimed; with it
    // the archive is reclaimed directly and a repo-absent intent/complete pair is journaled.
    await rm(repoRoot, { recursive: true, force: true });

    const result = await store.prune({ maxAgeMs: 1_000, maxBytes: Number.MAX_SAFE_INTEGER });

    expect(result.removed).toContain(runId);
    await expect(stat(store.runDirectory)).rejects.toMatchObject({ code: "ENOENT" });
    const records = (await readFile(
      join(process.env.CLAUDE_PLUGIN_DATA!, "runs", "cleanup.ndjson"),
      "utf8",
    )).trim().split("\n").map(line => JSON.parse(line) as {
      event: string; repoRoot: string; anchorRef: string | null; anchorCleanup: string;
    });
    expect(records.map(record => record.event)).toEqual([
      "prune-cleanup-intent",
      "prune-cleanup-complete",
    ]);
    expect(records[0]).toMatchObject({ repoRoot, anchorRef: null, anchorCleanup: "pending" });
    expect(records[1]).toMatchObject({ anchorRef: null, anchorCleanup: "already-absent" });
  });

  it("surfaces a checkout lease release failure after a committed removal", async () => {
    const runId = "run-prune-release-failure";
    const store = new ArtifactStore(runId);
    const repoRoot = await writePrunableResult(store, runId, sampleResult(runId));
    const commonDir = await realpath(join(repoRoot, ".git"));
    await utimes(store.runDirectory, new Date(0), new Date(0));
    let releases = 0;

    const result = await store.prune(
      { maxAgeMs: 1_000, maxBytes: Number.MAX_SAFE_INTEGER },
      {
        platformServices: {
          async canonicalizePath(input) {
            return { input, canonical: repoRoot, gitCommonDir: commonDir };
          },
          async acquireCheckoutLock() {
            return {
              key: "test",
              repositoryIdentity: commonDir,
              async release() { releases += 1; throw new Error("release failed after removal"); },
            };
          },
        },
      },
    );

    expect(releases).toBe(1);
    expect(result.removed).toContain(runId);
    expect(result.retained).toContainEqual({
      runId,
      reason: "archive removed; checkout lease release failed: release failed after removal",
    });
    await expect(stat(store.runDirectory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("enforces the byte limit", async () => {
    const store = new ArtifactStore("run-large");
    await writePrunableResult(store, "run-large", sampleResult("run-large"));
    await store.writeLog("large", "x".repeat(1_000));

    const result = await store.prune({ maxAgeMs: Number.MAX_SAFE_INTEGER, maxBytes: 0 });

    expect(result.removed).toContain("run-large");
  });

  it("does not prune a run without a terminal AttemptResult", async () => {
    const store = new ArtifactStore("run-active");
    await store.writeLog("producer", "still running");
    const runDirectory = join(process.env.CLAUDE_PLUGIN_DATA!, "runs", "run-active");
    const oldTime = new Date(Date.now() - 60_000);
    await utimes(runDirectory, oldTime, oldTime);

    const result = await store.prune({ maxAgeMs: 1_000, maxBytes: 0 });

    expect(result.removed).not.toContain("run-active");
    expect(result.retained).toContainEqual({ runId: "run-active", reason: "incomplete-run" });
    await expect(stat(runDirectory)).resolves.toBeDefined();
  });

  it("durably records cleanup before removing an archived run", async () => {
    const store = new ArtifactStore("run-audited");
    await writePrunableResult(store, "run-audited", sampleResult("run-audited"));
    const runDirectory = join(process.env.CLAUDE_PLUGIN_DATA!, "runs", "run-audited");
    const oldTime = new Date(Date.now() - 60_000);
    await utimes(runDirectory, oldTime, oldTime);

    await store.prune({ maxAgeMs: 1_000, maxBytes: Number.MAX_SAFE_INTEGER });

    const journal = await readFile(join(
      process.env.CLAUDE_PLUGIN_DATA!,
      "runs",
      "cleanup.ndjson",
    ), "utf8");
    const records = journal.trim().split("\n").map(line => JSON.parse(line) as {
      runId: string;
      reason: string;
      anchorCleanup: string;
    });
    expect(records.at(-1)).toMatchObject({
      runId: "run-audited",
      reason: "max-age",
      anchorCleanup: "not-applicable",
    });
  });

  it("does not write cleanup intent after the archive root is swapped", async () => {
    const runId = "run-cleanup-root-swap";
    const store = new ArtifactStore(runId);
    await writePrunableResult(store, runId, sampleResult(runId));
    const runsRoot = join(process.env.CLAUDE_PLUGIN_DATA!, "runs");
    const preservedRunsRoot = join(process.env.CLAUDE_PLUGIN_DATA!, "preserved-runs");
    const cleanupJournal = join(runsRoot, "cleanup.ndjson");
    const oldTime = new Date(Date.now() - 60_000);
    await utimes(store.runDirectory, oldTime, oldTime);
    let swapped = false;
    filesystemHooks.beforeOpen = async filename => {
      if (swapped || filename !== cleanupJournal) return;
      swapped = true;
      filesystemHooks.beforeOpen = undefined;
      await rename(runsRoot, preservedRunsRoot);
      await mkdir(runsRoot);
    };

    const pruned = await store.prune({
      maxAgeMs: 1_000,
      maxBytes: Number.MAX_SAFE_INTEGER,
    });

    expect(swapped).toBe(true);
    expect(pruned.removed).not.toContain(runId);
    expect(pruned.retained.some(entry => entry.runId === runId)).toBe(true);
    await expect(stat(join(preservedRunsRoot, runId))).resolves.toBeDefined();
    await expect(readFile(cleanupJournal, "utf8")).resolves.toBe("");
  });

  it("deletes a candidate anchor before pruning its archive", async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), "claude-architect-prune-repo-"));
    temporaryPaths.push(repoRoot);
    await git(repoRoot, ["init", "-q"]);
    await git(repoRoot, ["commit", "--allow-empty", "-q", "-m", "base"]);
    const commitOid = await git(repoRoot, ["rev-parse", "HEAD"]);
    const anchorRef = "refs/claude-architect/candidates/run-anchor";
    await git(repoRoot, ["update-ref", anchorRef, commitOid]);

    const store = new ArtifactStore("run-anchor");
    const result = sampleResult("run-anchor");
    result.failure = "verification-failure";
    result.candidate = {
      baseCommitOid: commitOid,
      candidateTreeOid: await git(repoRoot, ["rev-parse", "HEAD^{tree}"]),
      candidateCommitOid: commitOid,
      anchorRef,
      manifestHash: createHash("sha256").update("[]").digest("hex"),
      changedPaths: [],
      patch: "",
    };
    await store.writeResult(result);
    await store.writeManifest(buildRunManifest(manifestArgs(
      "run-anchor",
      repoRoot,
      emptyCandidateManifestHash,
      commitOid,
    )));
    const runDirectory = join(process.env.CLAUDE_PLUGIN_DATA!, "runs", "run-anchor");
    const oldTime = new Date(Date.now() - 60_000);
    await utimes(runDirectory, oldTime, oldTime);

    await store.prune({ maxAgeMs: 1_000, maxBytes: Number.MAX_SAFE_INTEGER });

    await expect(git(repoRoot, ["show-ref", "--verify", anchorRef])).rejects.toBeDefined();
    await expect(git(repoRoot, [
      "show-ref",
      "--verify",
      "refs/claude-architect/prune-backups/run-anchor",
    ])).rejects.toBeDefined();
    await expect(stat(runDirectory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("records cleanup intent before deleting a candidate anchor", async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), "claude-architect-intent-repo-"));
    temporaryPaths.push(repoRoot);
    await git(repoRoot, ["init", "-q"]);
    await git(repoRoot, ["commit", "--allow-empty", "-q", "-m", "base"]);
    const commitOid = await git(repoRoot, ["rev-parse", "HEAD"]);
    const anchorRef = "refs/claude-architect/candidates/run-intent";
    await git(repoRoot, ["update-ref", anchorRef, commitOid]);

    const store = new ArtifactStore("run-intent");
    const result = sampleResult("run-intent");
    result.failure = "verification-failure";
    result.candidate = {
      baseCommitOid: commitOid,
      candidateTreeOid: await git(repoRoot, ["rev-parse", "HEAD^{tree}"]),
      candidateCommitOid: commitOid,
      anchorRef,
      manifestHash: createHash("sha256").update("[]").digest("hex"),
      changedPaths: [],
      patch: "",
    };
    await store.writeResult(result);
    await store.writeManifest(buildRunManifest(manifestArgs(
      "run-intent",
      repoRoot,
      emptyCandidateManifestHash,
      commitOid,
    )));
    const runDirectory = join(process.env.CLAUDE_PLUGIN_DATA!, "runs", "run-intent");
    const oldTime = new Date(Date.now() - 60_000);
    await utimes(runDirectory, oldTime, oldTime);

    await store.prune({ maxAgeMs: 1_000, maxBytes: Number.MAX_SAFE_INTEGER });

    const records = (await readFile(join(
      process.env.CLAUDE_PLUGIN_DATA!,
      "runs",
      "cleanup.ndjson",
    ), "utf8")).trim().split("\n").map(line => JSON.parse(line) as {
      event: string;
      runId: string;
      anchorCleanup: string;
    });
    expect(records.slice(-2)).toMatchObject([
      { event: "prune-cleanup-intent", runId: "run-intent", anchorCleanup: "pending" },
      { event: "prune-cleanup-complete", runId: "run-intent", anchorCleanup: "deleted" },
    ]);
  });

  it("retains a candidate anchor when cleanup intent cannot be recorded", async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), "claude-architect-intent-failure-repo-"));
    temporaryPaths.push(repoRoot);
    await git(repoRoot, ["init", "-q"]);
    await git(repoRoot, ["commit", "--allow-empty", "-q", "-m", "base"]);
    const commitOid = await git(repoRoot, ["rev-parse", "HEAD"]);
    const anchorRef = "refs/claude-architect/candidates/run-intent-failure";
    await git(repoRoot, ["update-ref", anchorRef, commitOid]);

    const store = new ArtifactStore("run-intent-failure");
    const result = sampleResult("run-intent-failure");
    result.failure = "verification-failure";
    result.candidate = {
      baseCommitOid: commitOid,
      candidateTreeOid: await git(repoRoot, ["rev-parse", "HEAD^{tree}"]),
      candidateCommitOid: commitOid,
      anchorRef,
      manifestHash: createHash("sha256").update("[]").digest("hex"),
      changedPaths: [],
      patch: "",
    };
    await store.writeResult(result);
    await store.writeManifest(buildRunManifest(manifestArgs(
      "run-intent-failure",
      repoRoot,
      emptyCandidateManifestHash,
      commitOid,
    )));
    const runDirectory = join(process.env.CLAUDE_PLUGIN_DATA!, "runs", "run-intent-failure");
    const oldTime = new Date(Date.now() - 60_000);
    await utimes(runDirectory, oldTime, oldTime);
    await mkdir(join(process.env.CLAUDE_PLUGIN_DATA!, "runs", "cleanup.ndjson"));

    const pruned = await store.prune({
      maxAgeMs: 1_000,
      maxBytes: Number.MAX_SAFE_INTEGER,
    });

    expect(pruned.removed).not.toContain("run-intent-failure");
    expect(await git(repoRoot, ["rev-parse", anchorRef])).toBe(commitOid);
    await expect(stat(runDirectory)).resolves.toBeDefined();
  });

  it("deletes a symbolic candidate anchor without dereferencing it", async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), "claude-architect-symref-repo-"));
    temporaryPaths.push(repoRoot);
    await git(repoRoot, ["init", "-q"]);
    await git(repoRoot, ["commit", "--allow-empty", "-q", "-m", "base"]);
    const commitOid = await git(repoRoot, ["rev-parse", "HEAD"]);
    const branchRef = await git(repoRoot, ["symbolic-ref", "HEAD"]);
    const anchorRef = "refs/claude-architect/candidates/run-symref";
    await git(repoRoot, ["symbolic-ref", anchorRef, branchRef]);

    const store = new ArtifactStore("run-symref");
    const result = sampleResult("run-symref");
    result.failure = "verification-failure";
    result.candidate = {
      baseCommitOid: commitOid,
      candidateTreeOid: await git(repoRoot, ["rev-parse", "HEAD^{tree}"]),
      candidateCommitOid: commitOid,
      anchorRef,
      manifestHash: createHash("sha256").update("[]").digest("hex"),
      changedPaths: [],
      patch: "",
    };
    await store.writeResult(result);
    await store.writeManifest(buildRunManifest(manifestArgs(
      "run-symref",
      repoRoot,
      emptyCandidateManifestHash,
      commitOid,
    )));
    const runDirectory = join(process.env.CLAUDE_PLUGIN_DATA!, "runs", "run-symref");
    const oldTime = new Date(Date.now() - 60_000);
    await utimes(runDirectory, oldTime, oldTime);

    await store.prune({ maxAgeMs: 1_000, maxBytes: Number.MAX_SAFE_INTEGER });

    await expect(git(repoRoot, ["rev-parse", branchRef])).resolves.toBe(commitOid);
    await expect(git(repoRoot, ["symbolic-ref", anchorRef])).rejects.toBeDefined();
  });

  it("retains the archive when the candidate anchor moved", async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), "claude-architect-moved-ref-repo-"));
    temporaryPaths.push(repoRoot);
    await git(repoRoot, ["init", "-q"]);
    await git(repoRoot, ["commit", "--allow-empty", "-q", "-m", "base"]);
    const candidateCommitOid = await git(repoRoot, ["rev-parse", "HEAD"]);
    const anchorRef = "refs/claude-architect/candidates/run-moved-ref";
    await git(repoRoot, ["update-ref", anchorRef, candidateCommitOid]);

    const store = new ArtifactStore("run-moved-ref");
    const result = sampleResult("run-moved-ref");
    result.failure = "verification-failure";
    result.candidate = {
      baseCommitOid: candidateCommitOid,
      candidateTreeOid: await git(repoRoot, ["rev-parse", "HEAD^{tree}"]),
      candidateCommitOid,
      anchorRef,
      manifestHash: createHash("sha256").update("[]").digest("hex"),
      changedPaths: [],
      patch: "",
    };
    await store.writeResult(result);
    await store.writeManifest(buildRunManifest(manifestArgs(
      "run-moved-ref",
      repoRoot,
      emptyCandidateManifestHash,
      candidateCommitOid,
    )));
    await writeFile(join(repoRoot, "later.txt"), "later\n");
    await git(repoRoot, ["add", "later.txt"]);
    await git(repoRoot, ["commit", "-q", "-m", "later"]);
    const movedCommitOid = await git(repoRoot, ["rev-parse", "HEAD"]);
    await git(repoRoot, ["update-ref", anchorRef, movedCommitOid]);
    const runDirectory = join(process.env.CLAUDE_PLUGIN_DATA!, "runs", "run-moved-ref");
    const oldTime = new Date(Date.now() - 60_000);
    await utimes(runDirectory, oldTime, oldTime);

    const pruned = await store.prune({
      maxAgeMs: 1_000,
      maxBytes: Number.MAX_SAFE_INTEGER,
    });

    expect(pruned.removed).not.toContain("run-moved-ref");
    expect(await git(repoRoot, ["rev-parse", anchorRef])).toBe(movedCommitOid);
    await expect(stat(runDirectory)).resolves.toBeDefined();
  });

  it("retains the archive when the candidate anchor is a dangling symbolic ref", async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), "claude-architect-dangling-ref-repo-"));
    temporaryPaths.push(repoRoot);
    await git(repoRoot, ["init", "-q"]);
    await git(repoRoot, ["commit", "--allow-empty", "-q", "-m", "base"]);
    const candidateCommitOid = await git(repoRoot, ["rev-parse", "HEAD"]);
    const anchorRef = "refs/claude-architect/candidates/run-dangling-ref";
    await git(repoRoot, ["symbolic-ref", anchorRef, "refs/heads/missing"]);

    const store = new ArtifactStore("run-dangling-ref");
    const result = sampleResult("run-dangling-ref");
    result.failure = "verification-failure";
    result.candidate = {
      baseCommitOid: candidateCommitOid,
      candidateTreeOid: await git(repoRoot, ["rev-parse", "HEAD^{tree}"]),
      candidateCommitOid,
      anchorRef,
      manifestHash: createHash("sha256").update("[]").digest("hex"),
      changedPaths: [],
      patch: "",
    };
    await store.writeResult(result);
    await store.writeManifest(buildRunManifest(manifestArgs(
      "run-dangling-ref",
      repoRoot,
      emptyCandidateManifestHash,
      candidateCommitOid,
    )));
    const runDirectory = join(process.env.CLAUDE_PLUGIN_DATA!, "runs", "run-dangling-ref");
    const oldTime = new Date(Date.now() - 60_000);
    await utimes(runDirectory, oldTime, oldTime);

    const pruned = await store.prune({
      maxAgeMs: 1_000,
      maxBytes: Number.MAX_SAFE_INTEGER,
    });

    expect(pruned.removed).not.toContain("run-dangling-ref");
    expect(await git(repoRoot, ["symbolic-ref", anchorRef])).toBe("refs/heads/missing");
    await expect(stat(runDirectory)).resolves.toBeDefined();
  });

  it("rejects a tampered manifest before pruning a candidate anchor", async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), "claude-architect-integrity-repo-"));
    const otherRepo = await mkdtemp(join(tmpdir(), "claude-architect-other-repo-"));
    temporaryPaths.push(repoRoot, otherRepo);
    for (const repository of [repoRoot, otherRepo]) {
      await git(repository, ["init", "-q"]);
      await git(repository, ["commit", "--allow-empty", "-q", "-m", "base"]);
    }
    const candidateCommitOid = await git(repoRoot, ["rev-parse", "HEAD"]);
    const anchorRef = "refs/claude-architect/candidates/run-tampered-manifest";
    await git(repoRoot, ["update-ref", anchorRef, candidateCommitOid]);

    const store = new ArtifactStore("run-tampered-manifest");
    const result = sampleResult("run-tampered-manifest");
    result.failure = "verification-failure";
    result.candidate = {
      baseCommitOid: candidateCommitOid,
      candidateTreeOid: await git(repoRoot, ["rev-parse", "HEAD^{tree}"]),
      candidateCommitOid,
      anchorRef,
      manifestHash: createHash("sha256").update("[]").digest("hex"),
      changedPaths: [],
      patch: "",
    };
    await store.writeResult(result);
    await store.writeManifest(buildRunManifest(manifestArgs(
      "run-tampered-manifest",
      repoRoot,
      emptyCandidateManifestHash,
      candidateCommitOid,
    )));
    const manifestPath = join(store.runDirectory, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
    manifest.repoRoot = otherRepo;
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    const oldTime = new Date(Date.now() - 60_000);
    await utimes(store.runDirectory, oldTime, oldTime);

    const pruned = await store.prune({
      maxAgeMs: 1_000,
      maxBytes: Number.MAX_SAFE_INTEGER,
    });

    expect(pruned.removed).not.toContain("run-tampered-manifest");
    expect(await git(repoRoot, ["rev-parse", anchorRef])).toBe(candidateCommitOid);
    await expect(stat(store.runDirectory)).resolves.toBeDefined();
  });

  it("does not restore a partially deleted quarantine as a retained archive", async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), "claude-architect-rollback-repo-"));
    temporaryPaths.push(repoRoot);
    await git(repoRoot, ["init", "-q"]);
    await git(repoRoot, ["commit", "--allow-empty", "-q", "-m", "base"]);
    const candidateCommitOid = await git(repoRoot, ["rev-parse", "HEAD"]);
    const anchorRef = "refs/claude-architect/candidates/run-prune-rollback";
    await git(repoRoot, ["update-ref", anchorRef, candidateCommitOid]);

    const store = new ArtifactStore("run-prune-rollback");
    const result = sampleResult("run-prune-rollback");
    result.failure = "verification-failure";
    result.candidate = {
      baseCommitOid: candidateCommitOid,
      candidateTreeOid: await git(repoRoot, ["rev-parse", "HEAD^{tree}"]),
      candidateCommitOid,
      anchorRef,
      manifestHash: createHash("sha256").update("[]").digest("hex"),
      changedPaths: [],
      patch: "",
    };
    await store.writeResult(result);
    await store.writeManifest(buildRunManifest(manifestArgs(
      "run-prune-rollback",
      repoRoot,
      emptyCandidateManifestHash,
      candidateCommitOid,
    )));
    await store.writeLog("first", "first log\n");
    await store.writeLog("second", "second log\n");
    filesystemHooks.beforeRm = async filename => {
      if (!filename.includes(".prune-run-prune-rollback-")) return;
      filesystemHooks.beforeRm = undefined;
      await rm(join(filename, "logs", "first.log"));
      throw Object.assign(new Error("forced partial archive removal"), { code: "EACCES" });
    };
    const oldTime = new Date(Date.now() - 60_000);
    await utimes(store.runDirectory, oldTime, oldTime);

    const pruned = await store.prune({
      maxAgeMs: 1_000,
      maxBytes: Number.MAX_SAFE_INTEGER,
    });

    expect(pruned.removed).toContain("run-prune-rollback");
    expect(pruned.retained.some(entry => entry.runId === "run-prune-rollback")).toBe(false);
    await expect(git(repoRoot, ["show-ref", "--verify", anchorRef])).rejects.toBeDefined();
    expect(await git(repoRoot, [
      "rev-parse",
      "refs/claude-architect/prune-backups/run-prune-rollback",
    ])).toBe(candidateCommitOid);
    await expect(stat(store.runDirectory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not remove a replacement swapped into the quarantine path", async () => {
    const store = new ArtifactStore("run-quarantine-swap");
    await writePrunableResult(store, "run-quarantine-swap", sampleResult("run-quarantine-swap"));
    const runsRoot = join(process.env.CLAUDE_PLUGIN_DATA!, "runs");
    const oldTime = new Date(Date.now() - 60_000);
    await utimes(store.runDirectory, oldTime, oldTime);
    const preservedPath = join(runsRoot, ".preserved-run-quarantine-swap");
    let swappedPath: string | null = null;
    filesystemHooks.beforeLstat = async directory => {
      if (!directory.startsWith(join(runsRoot, ".prune-run-quarantine-swap-"))) return;
      filesystemHooks.beforeLstat = undefined;
      await rename(directory, preservedPath);
      await mkdir(directory);
      await writeFile(join(directory, "replacement.txt"), "do not delete\n");
      swappedPath = directory;
    };

    const pruned = await store.prune({
      maxAgeMs: 1_000,
      maxBytes: Number.MAX_SAFE_INTEGER,
    });

    expect(swappedPath).not.toBeNull();
    expect(pruned.removed).not.toContain("run-quarantine-swap");
    expect(pruned.retained.some(entry => entry.runId === "run-quarantine-swap")).toBe(true);
    await expect(readFile(join(swappedPath!, "replacement.txt"), "utf8")).resolves.toBe(
      "do not delete\n",
    );
    await expect(stat(preservedPath)).resolves.toBeDefined();
  });

  it("does not journal cleanup complete or retain a run after backup deletion fails", async () => {
    if (process.platform === "win32") return;
    const repoRoot = await mkdtemp(join(tmpdir(), "claude-architect-backup-failure-repo-"));
    temporaryPaths.push(repoRoot);
    await git(repoRoot, ["init", "-q"]);
    await git(repoRoot, ["commit", "--allow-empty", "-q", "-m", "base"]);
    const candidateCommitOid = await git(repoRoot, ["rev-parse", "HEAD"]);
    const runId = "run-backup-failure";
    const anchorRef = `refs/claude-architect/candidates/${runId}`;
    const backupRef = `refs/claude-architect/prune-backups/${runId}`;
    await git(repoRoot, ["update-ref", anchorRef, candidateCommitOid]);
    // Runtime git() disables repository hooks (core.hooksPath=/dev/null), so a
    // reference-transaction hook can no longer inject the deletion failure.
    // Shim git on PATH to fail only the prune-backup deletion, passing every
    // other invocation (including hardening discovery) through to real git.
    const realGit = (await promisify(execFile)("/usr/bin/env", ["which", "git"]))
      .stdout.trim().split("\n")[0]!;
    const shimDir = join(repoRoot, "shim-bin");
    await mkdir(shimDir);
    await writeFile(join(shimDir, "git"), `#!/bin/sh
for arg in "$@"; do
  case "$arg" in
    refs/claude-architect/prune-backups/*)
      for prev in "$@"; do
        [ "$prev" = "-d" ] && { echo "backup deletion blocked" >&2; exit 1; }
      done
      ;;
  esac
done
exec ${JSON.stringify(realGit)} "$@"
`);
    await chmod(join(shimDir, "git"), 0o755);
    const previousPath = process.env.PATH;
    process.env.PATH = `${shimDir}:${previousPath ?? ""}`;

    const store = new ArtifactStore(runId);
    const result = sampleResult(runId);
    result.failure = "verification-failure";
    result.candidate = {
      baseCommitOid: candidateCommitOid,
      candidateTreeOid: await git(repoRoot, ["rev-parse", "HEAD^{tree}"]),
      candidateCommitOid,
      anchorRef,
      manifestHash: createHash("sha256").update("[]").digest("hex"),
      changedPaths: [],
      patch: "",
    };
    await store.writeResult(result);
    await store.writeManifest(buildRunManifest(manifestArgs(
      runId,
      repoRoot,
      emptyCandidateManifestHash,
      candidateCommitOid,
    )));
    const oldTime = new Date(Date.now() - 60_000);
    await utimes(store.runDirectory, oldTime, oldTime);

    let pruned;
    try {
      pruned = await store.prune({
        maxAgeMs: 1_000,
        maxBytes: Number.MAX_SAFE_INTEGER,
      });
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }

    expect(pruned.removed).toContain(runId);
    expect(pruned.retained.some(entry => entry.runId === runId)).toBe(false);
    expect(await git(repoRoot, ["rev-parse", backupRef])).toBe(candidateCommitOid);
    const records = (await readFile(join(
      process.env.CLAUDE_PLUGIN_DATA!,
      "runs",
      "cleanup.ndjson",
    ), "utf8")).trim().split("\n").map(line => JSON.parse(line) as { event: string });
    expect(records.map(record => record.event)).toEqual(["prune-cleanup-intent"]);
  });
});

describe("buildRunManifest", () => {
  it("fails closed when redaction would change repository identity", () => {
    const repoRoot = "/canonical/enterprise-secret-repository";
    const registration = registerSecretValue(repoRoot);

    expect(() => buildRunManifest(manifestArgs("run-repo-collision", repoRoot))).toThrow(
      /repository root|safely persist/,
    );
    registration.dispose();
  });

  it.each([
    ["repository instruction path", (args: BuildRunManifestArgs) => {
      args.repositoryInstructions[0]!.path = "identity-secret";
    }],
    ["producer id", (args: BuildRunManifestArgs) => { args.producer.id = "identity-secret"; }],
    ["producer version", (args: BuildRunManifestArgs) => {
      args.producer.version = "identity-secret";
    }],
    ["producer model", (args: BuildRunManifestArgs) => {
      args.producer.model = "identity-secret";
    }],
    ["environment name", (args: BuildRunManifestArgs) => {
      args.environment[0]!.name = "identity-secret";
    }],
    ["environment source", (args: BuildRunManifestArgs) => {
      args.environment[0]!.source = "identity-secret" as never;
    }],
    ["packaged verifier version", (args: BuildRunManifestArgs) => {
      args.packagedVerifier.version = "identity-secret";
    }],
  ])("fails closed instead of redacting the manifest %s", (_label, assign) => {
    const registration = registerSecretValue("identity-secret");
    const args = manifestArgs("run-manifest-identity", "/canonical/repo");
    assign(args);

    expect(() => buildRunManifest(args)).toThrow(/safely persist/);
    registration.dispose();
  });

  it("records reproducibility hashes and names-only environment provenance", () => {
    const registration = registerSecretValue("manifest-secret-value");
    const args = manifestArgs("run-manifest", "/canonical/repo");
    args.effectivePolicy = {
      token: "manifest-secret-value",
      "manifest-secret-value": true,
      nested: { beta: 2, alpha: 1 },
    };

    const manifest = buildRunManifest(args);
    const reordered = buildRunManifest({
      ...args,
      effectivePolicy: {
        nested: { alpha: 1, beta: 2 },
        "manifest-secret-value": true,
        token: "manifest-secret-value",
      },
      environment: [...args.environment].reverse(),
    });

    expect(manifest.promptHash).toBe(
      createHash("sha256").update(args.prompt).digest("hex"),
    );
    expect(manifest.repositoryInstructions).toEqual([
      {
        path: "AGENTS.md",
        hash: createHash("sha256")
          .update("follow the repository rules\n")
          .digest("hex"),
      },
    ]);
    expect(manifest.packagedVerifier.hash).toBe(
      createHash("sha256").update("trusted verifier bytes").digest("hex"),
    );
    expect(manifest.manifestHash).toMatch(/^[0-9a-f]{64}$/);
    expect(manifest.manifestHash).toBe(reordered.manifestHash);
    expect(JSON.stringify(manifest)).not.toContain("manifest-secret-value");
    expect(manifest.environment).toEqual([
      { name: "CODEX_TOKEN", source: "adapter" },
      { name: "PATH", source: "platform" },
    ]);
    registration.dispose();
  });

  it("keeps the persisted manifest hash consistent after value redaction", async () => {
    const registration = registerSecretValue("secret");
    const store = new ArtifactStore("run-manifest-hash");
    const args = manifestArgs("run-manifest-hash", "/canonical/repo");
    args.effectivePolicy = { profile: "secret" };
    await store.writeManifest(buildRunManifest(args));

    const persisted = JSON.parse(await readFile(
      join(store.runDirectory, "manifest.json"),
      "utf8",
    )) as Record<string, unknown>;
    const manifestHash = persisted.manifestHash;
    delete persisted.manifestHash;
    const canonicalize = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(canonicalize);
      if (value === null || typeof value !== "object") return value;
      return Object.fromEntries(Object.entries(value as Record<string, unknown>)
        .filter(([, child]) => child !== undefined)
        .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
        .map(([key, child]) => [key, canonicalize(child)]));
    };
    const recomputed = createHash("sha256")
      .update(JSON.stringify(canonicalize(persisted)))
      .digest("hex");

    expect(manifestHash).toBe(recomputed);
    registration.dispose();
  });

  it("rehashes a manifest when a secret is registered after construction", async () => {
    const args = manifestArgs("run-manifest-late-secret", "/canonical/repo");
    args.effectivePolicy = { profile: "policy-secret" };
    const manifest = buildRunManifest(args);
    const registration = registerSecretValue("policy-secret");
    const store = new ArtifactStore("run-manifest-late-secret");

    await store.writeManifest(manifest);

    const persisted = JSON.parse(await readFile(
      join(store.runDirectory, "manifest.json"),
      "utf8",
    )) as Record<string, unknown>;
    const manifestHash = persisted.manifestHash;
    delete persisted.manifestHash;
    const canonicalize = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(canonicalize);
      if (value === null || typeof value !== "object") return value;
      return Object.fromEntries(Object.entries(value as Record<string, unknown>)
        .filter(([, child]) => child !== undefined)
        .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
        .map(([key, child]) => [key, canonicalize(child)]));
    };

    expect(manifestHash).toBe(createHash("sha256")
      .update(JSON.stringify(canonicalize(persisted)))
      .digest("hex"));
    expect(JSON.stringify(persisted)).not.toContain("policy-secret");
    registration.dispose();
  });

  it("fails closed when the final manifest hash equals a registered secret", async () => {
    const manifest = buildRunManifest(manifestArgs(
      "run-manifest-hash-collision",
      "/canonical/repo",
    ));
    const registration = registerSecretValue(manifest.manifestHash);
    const store = new ArtifactStore("run-manifest-hash-collision");

    await expect(store.writeManifest(manifest)).rejects.toThrow(/safely persist/);
    await expect(access(join(store.runDirectory, "manifest.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    registration.dispose();
  });
});
