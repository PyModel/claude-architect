import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { git } from "../../src/git/git-exec.js";
import { WorktreeManager } from "../../src/runtime/worktree-manager.js";
import { applyCandidateTree } from "../../src/integrate/controlled-integrator.js";
import { delegatePipelineOutput } from "../../src/mcp/server.js";
import {
  handleDecideCandidate,
  handleIntegrateCandidate,
} from "../../src/mcp/tools.js";
import type {
  CheckoutLock,
  PlatformServices,
} from "../../src/platform/platform-services.js";
import { getPlatformServices } from "../../src/platform/select-platform.js";
import type {
  AttemptResult,
  CandidateArtifact,
  ChangedPath,
} from "../../src/protocol/attempt-result.js";
import type { DelegationSpec, Slice } from "../../src/protocol/delegation-spec.js";
import { ProducerRegistry } from "../../src/producers/producer-registry.js";
import {
  composeProgressNotes,
  detectWeakenedTests,
  runIncrement,
  runPipeline,
  runReviews,
  scopeSpecToSlice,
  verifyCandidate,
  type PipelineDependencies,
} from "../../src/pipeline/pipeline-runtime.js";
import {
  resolveLinkedWorktreeWritableRoots,
  type LinkedWorktreeGitAccess,
} from "../../src/pipeline/git-writable-roots.js";
import type { IncrementReport, ReviewReport } from "../../src/pipeline/report-types.js";
import type { RolePackage } from "../../src/pipeline/role-prompts.js";
import type { RoleRunArgs, RoleRunResult } from "../../src/pipeline/role-runner.js";
import { ArtifactStore } from "../../src/runtime/artifact-store.js";
import { buildRunManifest } from "../../src/runtime/run-manifest.js";
import type {
  AcceptanceVerifierLike,
  AttemptRuntimeDependencies,
} from "../../src/runtime/attempt-runtime.js";
import {
  clearRegisteredSecrets,
  registerSecretValue,
} from "../../src/runtime/redaction.js";
import { recoverStaleRuns } from "../../src/runtime/recovery-manager.js";
import { specSha256 } from "../../src/protocol/spec-hash.js";
import { initializeRunStart } from "../../src/runtime/run-start.js";
import { AcceptanceVerifier } from "../../src/verify/acceptance-verifier.js";

const temporaryPaths: string[] = [];
let previousPluginData: string | undefined;
let previousNodeEnvironment: string | undefined;
let previousDelegated: string | undefined;

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), prefix));
  temporaryPaths.push(directory);
  return directory;
}

async function runGit(
  cwd: string,
  args: string[],
  env?: Record<string, string>,
): Promise<string> {
  const result = await git(cwd, args, env === undefined ? undefined : { env });
  expect(result.exitCode, result.stderr).toBe(0);
  return result.stdout.trim();
}

async function expectRefMissing(repo: string, ref: string): Promise<void> {
  const result = await git(repo, ["rev-parse", "--verify", "--quiet", ref]);
  expect(result.exitCode).not.toBe(0);
}

async function expectRefPresent(repo: string, ref: string): Promise<void> {
  const result = await git(repo, ["rev-parse", "--verify", "--quiet", ref]);
  expect(result.exitCode).toBe(0);
}

async function initRepo(): Promise<string> {
  const directory = await realpath(await temporaryDirectory("ca-pipeline-repo-"));
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

function validSpec(reviewers: DelegationSpec["review"] = {
  reviewers: ["correctness", "systems"],
  maxRounds: 2,
}): DelegationSpec {
  return {
    specVersion: "1",
    objective: "Update the authorized fixture file.",
    context: "a.txt is in scope.",
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
    timeoutMs: 10_000,
    producerPreferences: ["codex"],
    expectedOutput: "candidate-patch",
    review: reviewers,
  };
}

function fenced(value: unknown): string {
  return `\`\`\`json\n${JSON.stringify(value)}\n\`\`\``;
}

function success(rawOutput: string): RoleRunResult {
  return { ok: true, rawOutput, failure: null, producerId: "stub" };
}

const approve: ReviewReport = {
  reportVersion: "1",
  verdict: "approve",
  findings: [],
  coverageGaps: [],
};

const blocker: ReviewReport = {
  reportVersion: "1",
  verdict: "request-changes",
  findings: [{
    severity: "blocker",
    location: "a.txt:1",
    claim: "The candidate still needs a deterministic fix.",
    evidence: "The fixture contains the first implementation.",
    reproduction: "Read a.txt.",
    requiredOutcome: "Commit the corrected fixture.",
    confidence: 1,
  }],
  coverageGaps: [],
};

const passingVerifier: AcceptanceVerifierLike = {
  async verify() {
    return { ok: true, failures: [], evidence: {}, commandOutcomes: [] };
  },
};

function statusChangeType(status: string): ChangedPath["changeType"] {
  if (status === "A") return "added";
  if (status === "D") return "deleted";
  return "modified";
}

async function artifactFor(
  repo: string,
  runId: string,
  baselineCommit: string,
  candidateCommit: string,
): Promise<CandidateArtifact> {
  const output = await runGit(repo, [
    "diff",
    "--name-status",
    "--no-renames",
    baselineCommit,
    candidateCommit,
  ]);
  const changedPaths: ChangedPath[] = [];
  for (const line of output.split("\n").filter(Boolean)) {
    const [status, pathname] = line.split("\t");
    if (status === undefined || pathname === undefined) throw new Error("invalid test diff");
    const sourceCommit = status === "D" ? baselineCommit : candidateCommit;
    const entry = await runGit(repo, ["ls-tree", sourceCommit, "--", pathname]);
    const match = /^(\d{6})\s+blob\s+([0-9a-f]+)\t/.exec(entry);
    if (match === null) throw new Error("missing test tree entry");
    changedPaths.push({
      path: pathname,
      changeType: statusChangeType(status),
      mode: match[1] ?? "",
      contentHash: status === "D" ? null : match[2] ?? null,
    });
  }
  changedPaths.sort((left, right) => left.path.localeCompare(right.path));
  const anchorRef = `refs/claude-architect/candidates/${runId}`;
  await runGit(repo, ["update-ref", anchorRef, candidateCommit]);
  return {
    baseCommitOid: baselineCommit,
    candidateTreeOid: await runGit(repo, ["rev-parse", `${candidateCommit}^{tree}`]),
    candidateCommitOid: candidateCommit,
    anchorRef,
    manifestHash: createHash("sha256").update(JSON.stringify(changedPaths)).digest("hex"),
    changedPaths,
    patch: await runGit(repo, ["diff", "--binary", baselineCommit, candidateCommit]),
  };
}

function attemptResult(runId: string, candidate: CandidateArtifact): AttemptResult {
  return {
    resultVersion: "1",
    runId,
    status: "verified-candidate",
    failure: null,
    summary: "candidate produced and independently verified",
    producerSummary: "test producer",
    candidate,
    requestedVerification: [],
    executedVerification: [],
    unresolvedIssues: [],
    evidence: {},
    logsRef: "logs/producer.log",
    producerId: "stub",
    producerVersion: "1",
    producerModel: null,
    durationMs: 1,
    sessionId: null,
  };
}

function failedAttemptResult(runId: string): AttemptResult {
  return {
    resultVersion: "1",
    runId,
    status: "failed",
    failure: "verification-failure",
    summary: "candidate did not pass independent verification",
    producerSummary: "test producer",
    candidate: null,
    requestedVerification: [],
    executedVerification: [],
    unresolvedIssues: ["base-changed"],
    evidence: { structural: { failures: ["base-changed"] } },
    logsRef: "logs/producer.log",
    producerId: "stub",
    producerVersion: "1",
    producerModel: null,
    durationMs: 1,
    sessionId: null,
  };
}

async function checkoutLeaseHarness(
  repo: string,
  options: {
    releaseError?: Error;
    onRelease?: () => void | Promise<void>;
  } = {},
): Promise<{
  ps: PlatformServices;
  lock(): CheckoutLock;
  held(): boolean;
  acquireCalls(): number;
  releaseCalls(): number;
}> {
  const platformServices = getPlatformServices();
  let lock: CheckoutLock | undefined;
  let held = false;
  let acquireCalls = 0;
  let releaseCalls = 0;
  const ps = Object.assign(Object.create(platformServices), {
    async acquireCheckoutLock(checkout: string): Promise<CheckoutLock> {
      acquireCalls += 1;
      const ownedLock = await platformServices.acquireCheckoutLock(checkout);
      held = true;
      lock = {
        key: ownedLock.key,
        repositoryIdentity: ownedLock.repositoryIdentity,
        async release() {
          releaseCalls += 1;
          try {
            await options.onRelease?.();
            if (options.releaseError !== undefined) throw options.releaseError;
          } finally {
            await ownedLock.release();
            held = false;
          }
        },
      };
      return lock;
    },
  }) as PlatformServices;
  return {
    ps,
    lock: () => {
      if (lock === undefined) throw new Error("checkout lock was not acquired");
      return lock;
    },
    held: () => held,
    acquireCalls: () => acquireCalls,
    releaseCalls: () => releaseCalls,
  };
}

function fakeAttempt(runId: string, edit: (repo: string) => Promise<void>) {
  return async (
    repo: string,
    _spec?: DelegationSpec,
    deps?: AttemptRuntimeDependencies,
  ): Promise<AttemptResult> => {
    const baselineCommit = await runGit(repo, ["rev-parse", "HEAD"]);
    const store = new ArtifactStore(runId);
    const canonicalCommonDir = await realpath(path.join(repo, ".git"));
    const runStart = await initializeRunStart(store, {
      runId,
      lockKey: createHash("sha256").update(canonicalCommonDir).digest("hex"),
      canonicalCommonDir,
      pid: null,
      processToken: null,
      startedAt: new Date().toISOString(),
    });
    await deps?.onRunStart?.(runStart);
    await edit(repo);
    await runGit(repo, ["add", "-A"]);
    await runGit(repo, ["commit", "-q", "-m", "candidate"]);
    const candidateCommit = await runGit(repo, ["rev-parse", "HEAD"]);
    const result = attemptResult(
      runId,
      await artifactFor(repo, runId, baselineCommit, candidateCommit),
    );
    // Mirror AttemptRuntime, which archives result.json + manifest.json before
    // the pipeline runs; candidate promotion reads and replaces both.
    await store.writeResult(result);
    await store.writeManifest(buildRunManifest({
      runId,
      repoRoot: repo,
      baseCommitOid: baselineCommit,
      candidateManifestHash: result.candidate!.manifestHash,
      producer: { id: "stub", version: "1", model: null },
      effectivePolicy: { isolation: "temporary-home", retries: 0 },
      repositoryInstructions: [],
      prompt: "test",
      executionPolicy: { network: "denied", writeAllowlist: ["**"] },
      environment: [],
      packagedVerifier: { version: "1", content: "test" },
    }));
    return result;
  };
}

function dependencies(args: {
  runId: string;
  edit?: (repo: string) => Promise<void>;
  roleRunner: (args: RoleRunArgs) => Promise<RoleRunResult>;
}): PipelineDependencies {
  return {
    verifier: passingVerifier,
    ps: getPlatformServices(),
    registry: new ProducerRegistry([]),
    roleRunner: args.roleRunner,
    runAttempt: fakeAttempt(args.runId, args.edit ?? (async repo => {
      await writeFile(path.join(repo, "a.txt"), "candidate\n");
    })),
  };
}

async function expectPipelineAuthorityBlocksTools(
  repo: string,
  runId: string,
  manifestHash: string,
): Promise<void> {
  const expected = {
    ok: false,
    error: "pipeline-active",
    diagnostic: "the delegation pipeline for this run is still active",
  };
  await expect(handleDecideCandidate(repo, runId, "accepted", manifestHash)).resolves.toEqual(expected);
  await expect(handleIntegrateCandidate(repo, runId, manifestHash)).resolves.toEqual(expected);
}

function roundReviews(
  rounds: Array<{ correctness: ReviewReport; systems: ReviewReport }>,
  fixer: (args: RoleRunArgs, round: number) => Promise<RoleRunResult>,
): (args: RoleRunArgs) => Promise<RoleRunResult> {
  let reviewerCalls = 0;
  let fixerCalls = 0;
  return async args => {
    if (args.role === "fixer") {
      fixerCalls += 1;
      return fixer(args, fixerCalls);
    }
    const roundIndex = Math.floor(reviewerCalls / 2);
    reviewerCalls += 1;
    const reports = rounds[roundIndex];
    if (reports === undefined) throw new Error(`missing reviews for round ${roundIndex + 1}`);
    return success(fenced(
      args.role === "reviewer-correctness" ? reports.correctness : reports.systems,
    ));
  };
}

async function commitFix(args: RoleRunArgs, content: string): Promise<string> {
  if (args.gitObjectAccess === undefined) {
    throw new Error("fixer git object isolation is missing");
  }
  const env = {
    GIT_OBJECT_DIRECTORY: args.gitObjectAccess.privateObjectsDir,
    GIT_ALTERNATE_OBJECT_DIRECTORIES: args.gitObjectAccess.sharedObjectsDir,
  };
  await writeFile(path.join(args.worktreePath, "a.txt"), content);
  await runGit(args.worktreePath, ["add", "a.txt"], env);
  await runGit(args.worktreePath, ["commit", "-q", "-m", "fix"], env);
  return runGit(args.worktreePath, ["rev-parse", "HEAD"], env);
}

function implementationSpec(maxIncrements: number): DelegationSpec {
  const spec = validSpec({ reviewers: ["correctness"], maxRounds: 1 });
  spec.implementation = { maxIncrements };
  return spec;
}

function incrementRoleRunner(
  implementer: (args: RoleRunArgs, call: number) => Promise<RoleRunResult>,
): (args: RoleRunArgs) => Promise<RoleRunResult> {
  let implementerCalls = 0;
  return async args => {
    if (args.role === "implementer") {
      implementerCalls += 1;
      return implementer(args, implementerCalls);
    }
    if (args.role === "reviewer-correctness") return success(fenced(approve));
    throw new Error(`unexpected role ${args.role}`);
  };
}

async function commitIncrement(
  args: RoleRunArgs,
  content: string,
  allowEmpty = false,
): Promise<string> {
  if (args.gitObjectAccess === undefined) {
    throw new Error("implementer git object isolation is missing");
  }
  const env = {
    GIT_OBJECT_DIRECTORY: args.gitObjectAccess.privateObjectsDir,
    GIT_ALTERNATE_OBJECT_DIRECTORIES: args.gitObjectAccess.sharedObjectsDir,
  };
  if (allowEmpty) {
    await runGit(args.worktreePath, ["commit", "--allow-empty", "-q", "-m", "increment"], env);
  } else {
    await writeFile(path.join(args.worktreePath, "a.txt"), content);
    await runGit(args.worktreePath, ["add", "a.txt"], env);
    await runGit(args.worktreePath, ["commit", "-q", "-m", "increment"], env);
  }
  return runGit(args.worktreePath, ["rev-parse", "HEAD"], env);
}

async function initSlicedRepo(): Promise<string> {
  const repo = await initRepo();
  await writeFile(path.join(repo, "slice-one.txt"), "slice one base\n");
  await writeFile(path.join(repo, "slice-two.txt"), "slice two base\n");
  await runGit(repo, ["add", "slice-one.txt", "slice-two.txt"]);
  await runGit(repo, ["commit", "-q", "-m", "slice fixtures"]);
  return repo;
}

function fileVerification(
  id: string,
  expected: Record<string, string>,
): Slice["verification"][number] {
  return {
    id,
    executable: "node",
    args: [
      "-e",
      [
        "const fs = require('node:fs');",
        `const expected = ${JSON.stringify(expected)};`,
        "for (const [name, content] of Object.entries(expected)) {",
        "  if (fs.readFileSync(name, 'utf8') !== content) process.exit(1);",
        "}",
        "process.stdout.write(process.cwd());",
      ].join(" "),
    ],
    cwd: ".",
    timeoutMs: 60_000,
    network: "denied",
    expectedExitCodes: [0],
  };
}

function slicedSpec(perSlice = false): DelegationSpec {
  const slices: Slice[] = [{
    objective: "Implement slice one only.",
    context: "slice-one.txt is the only writable path.",
    writeAllowlist: ["slice-one.txt"],
    forbiddenScope: [],
    successCriteria: ["slice-one.txt contains the slice-one candidate."],
    verification: [fileVerification("slice-one-check", {
      "slice-one.txt": "slice one candidate\n",
    })],
  }, {
    objective: "Implement slice two only.",
    context: "Preserve slice one and update only slice-two.txt.",
    writeAllowlist: ["slice-two.txt"],
    forbiddenScope: [],
    successCriteria: ["slice-two.txt contains the slice-two candidate."],
    verification: [fileVerification("slice-two-check", {
      "slice-one.txt": "slice one candidate\n",
      "slice-two.txt": "slice two candidate\n",
    })],
  }];
  return {
    ...validSpec({
      reviewers: ["correctness"],
      maxRounds: 1,
      ...(perSlice ? { perSlice: true } : {}),
    }),
    objective: "Implement both ordered slices.",
    context: "Each slice has a disjoint write allowlist.",
    writeAllowlist: ["slice-one.txt", "slice-two.txt"],
    successCriteria: ["Both slice files contain their candidate content."],
    verification: [fileVerification("final-check", {
      "slice-one.txt": "slice one candidate\n",
      "slice-two.txt": "slice two candidate\n",
    })],
    implementation: { maxIncrements: 2 },
    slices,
  };
}

async function commitRoleFile(
  args: RoleRunArgs,
  pathname: string,
  content: string,
): Promise<string> {
  if (args.gitObjectAccess === undefined) {
    throw new Error("implementer git object isolation is missing");
  }
  const env = {
    GIT_OBJECT_DIRECTORY: args.gitObjectAccess.privateObjectsDir,
    GIT_ALTERNATE_OBJECT_DIRECTORIES: args.gitObjectAccess.sharedObjectsDir,
  };
  await writeFile(path.join(args.worktreePath, pathname), content);
  await runGit(args.worktreePath, ["add", pathname], env);
  await runGit(args.worktreePath, ["commit", "-q", "-m", `update ${pathname}`], env);
  return runGit(args.worktreePath, ["rev-parse", "HEAD"], env);
}

beforeEach(async () => {
  previousPluginData = process.env.CLAUDE_PLUGIN_DATA;
  previousNodeEnvironment = process.env.NODE_ENV;
  previousDelegated = process.env.CLAUDE_ARCHITECT_DELEGATED;
  process.env.CLAUDE_PLUGIN_DATA = await temporaryDirectory("ca-pipeline-state-");
  process.env.NODE_ENV = "test";
  delete process.env.CLAUDE_ARCHITECT_DELEGATED;
  clearRegisteredSecrets();
});

afterEach(async () => {
  vi.restoreAllMocks();
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

describe("composeProgressNotes", () => {
  it("renders only the provided report deterministically and redacts secrets", () => {
    registerSecretValue("increment-secret-value");
    const earlier: IncrementReport = {
      reportVersion: "1",
      candidateCommit: "a".repeat(40),
      status: "continue",
      summary: "increment two marker increment-secret-value",
      nextSteps: "continue increment two",
    };
    const latest: IncrementReport = {
      reportVersion: "1",
      candidateCommit: "b".repeat(40),
      status: "continue",
      summary: "increment three marker",
      nextSteps: "continue increment three",
    };

    const first = composeProgressNotes(earlier);
    const second = composeProgressNotes(latest);

    expect(first).not.toContain("increment-secret-value");
    expect(first).toContain("[s]");
    expect(second).not.toContain("increment two marker");
    expect(second).toContain("increment three marker");
    expect(composeProgressNotes(latest)).toBe(second);
  });

  it("caps schema-valid summary and next steps at 8000 characters", () => {
    const notes = composeProgressNotes({
      reportVersion: "1",
      candidateCommit: "c".repeat(40),
      status: "continue",
      summary: "a".repeat(4_000),
      nextSteps: "b".repeat(4_000),
    });

    expect(notes).toHaveLength(8_000);
    expect(notes).toMatch(/\[progress notes truncated\]$/);
  });
});

describe("scopeSpecToSlice", () => {
  it("clones the parent with only slice-owned fields replaced and slices removed", async () => {
    const slice: Slice = {
      objective: "Implement only the first slice.",
      context: "The slice context is authoritative.",
      writeAllowlist: ["src/slice/**"],
      forbiddenScope: ["src/slice/private/**"],
      successCriteria: ["The slice is independently complete."],
      verification: [{
        id: "slice-check",
        executable: "node",
        args: ["-e", "process.exit(0)"],
        cwd: ".",
        environment: { SLICE_CHECK: "true" },
        timeoutMs: 30_000,
        network: "denied",
        expectedExitCodes: [0],
        platform: { os: ["darwin", "linux", "win32"] },
      }],
    };
    const parent: DelegationSpec = {
      ...validSpec({ reviewers: ["correctness"], maxRounds: 1, focus: ["security"] }),
      objective: "Complete the whole delegation.",
      context: "Parent context.",
      writeAllowlist: ["src/**"],
      forbiddenScope: ["src/private/**"],
      successCriteria: ["The entire delegation is complete."],
      producerOverrides: { model: "trusted-model", reasoningEffort: "high" },
      implementation: { maxIncrements: 2 },
      slices: [structuredClone(slice)],
    };
    const parentSnapshot = structuredClone(parent);
    const sliceSnapshot = structuredClone(slice);

    const scoped = scopeSpecToSlice(parent, slice);
    const expected = structuredClone(parent);
    Object.assign(expected, slice);
    delete expected.slices;

    expect(scoped).toEqual(expected);
    expect(scoped).not.toHaveProperty("slices");
    scoped.writeAllowlist.push("result-only/**");
    scoped.verification[0]!.args.push("result-only");
    scoped.producerPreferences.push("result-only");
    expect(parent).toEqual(parentSnapshot);
    expect(slice).toEqual(sliceSnapshot);
  });

  it("inherits parent test-deletion globs unless the slice overrides them", () => {
    const parent = validSpec();
    parent.allowedTestDeletions = ["tests/inherited/**"];
    const inheritedSlice: Slice = {
      objective: "Inherited deletion scope.",
      context: "Use the parent deletion authority.",
      writeAllowlist: ["a.txt"],
      forbiddenScope: [],
      successCriteria: ["Done."],
      verification: parent.verification,
    };
    const overrideSlice: Slice = {
      ...inheritedSlice,
      allowedTestDeletions: ["tests/override/**"],
    };

    const inherited = scopeSpecToSlice(parent, inheritedSlice);
    const overridden = scopeSpecToSlice(parent, overrideSlice);
    expect(inherited.allowedTestDeletions).toEqual(["tests/inherited/**"]);
    expect(overridden.allowedTestDeletions).toEqual(["tests/override/**"]);

    const diff = [
      "diff --git a/tests/inherited/old.test.ts b/tests/inherited/old.test.ts",
      "deleted file mode 100644",
    ].join("\n");
    expect(detectWeakenedTests(diff, inherited.allowedTestDeletions).testsDeleted).toBe(0);
    expect(detectWeakenedTests(diff, overridden.allowedTestDeletions).testsDeleted).toBe(1);
  });
});

describe("pipeline runtime namespaces", () => {
  it("derives distinct implementer and reviewer log names from a trusted namespace", async () => {
    const runId = "pipeline-namespaced-roles";
    const spec = implementationSpec(2);
    const pkg: RolePackage = {
      spec,
      baselineCommit: "a".repeat(40),
      candidateCommit: "b".repeat(40),
      candidateDiff: "",
      testEvidence: "[]",
    };
    const roleRunner = async (args: RoleRunArgs): Promise<RoleRunResult> => args.role === "implementer"
      ? success(fenced({
        reportVersion: "1",
        candidateCommit: pkg.candidateCommit,
        status: "complete",
        summary: "slice complete",
      }))
      : success(fenced(approve));
    const deps = dependencies({ runId, roleRunner });
    const store = new ArtifactStore(runId);
    const gitObjectAccess: LinkedWorktreeGitAccess = {
      gitDir: "/git-dir",
      privateObjectsDir: "/private-objects",
      sharedObjectsDir: "/shared-objects",
      writableRoots: [],
    };
    const increment = await runIncrement({
      spec,
      pkg,
      worktreePath: "/worktree",
      deps,
      runId,
      increment: 2,
      store,
      gitObjectAccess,
      logNameNamespace: "slice1-attempt0",
    });
    const reviews = await runReviews({
      reviewers: ["correctness"],
      spec,
      pkg,
      worktreePath: "/worktree",
      deps,
      runId,
      round: 1,
      store,
      logNameNamespace: "slice1-attempt1",
    });

    expect(increment.roleLogRefs).toEqual([
      "logs/role-implementer-slice1-attempt0-increment2.log",
    ]);
    expect(reviews.roleLogRefs).toEqual([
      "logs/role-reviewer-correctness-slice1-attempt1-round1.log",
    ]);
  });

  it("derives verification worktree, verifier, and log identities from one namespace", async () => {
    const repo = await initRepo();
    const runId = "pipeline-namespaced-verification";
    const baselineCommit = await runGit(repo, ["rev-parse", "HEAD"]);
    await writeFile(path.join(repo, "a.txt"), "candidate\n");
    await runGit(repo, ["add", "a.txt"]);
    await runGit(repo, ["commit", "-q", "-m", "candidate"]);
    const candidateCommit = await runGit(repo, ["rev-parse", "HEAD"]);
    const candidate = await artifactFor(repo, runId, baselineCommit, candidateCommit);
    const attempt = attemptResult(runId, candidate);
    const spec = validSpec({ reviewers: ["correctness"], maxRounds: 1 });
    spec.verification = [{
      ...spec.verification[0]!,
      args: [
        "-e",
        [
          "const fs = require('node:fs');",
          "const path = require('node:path');",
          "process.stdout.write(fs.readdirSync(path.dirname(process.cwd())).sort().join('\\n'));",
        ].join(" "),
      ],
    }];
    const store = new ArtifactStore(runId);
    const verifierSpy = vi.spyOn(AcceptanceVerifier.prototype, "verify");

    const result = await verifyCandidate({
      checkoutPath: repo,
      spec,
      deps: dependencies({
        runId,
        roleRunner: async () => { throw new Error("role runner must not run"); },
      }),
      attempt,
      baselineCommit,
      candidateCommit,
      store,
      namespace: "slice1-attempt0",
    });
    const stdoutRef = result.verification.evidence.commandOutcomes[0]?.stdoutRef;
    const verifierArgs = verifierSpy.mock.calls[0]?.[0];

    expect(stdoutRef).toBe("logs/slice1-attempt0-pipeline-verification-0-stdout.log");
    expect(verifierArgs?.verificationId?.()).toBe(
      `${runId}-slice1-attempt0-pipeline`,
    );
    const worktrees = (await readFile(path.join(store.runDirectory, stdoutRef!), "utf8"))
      .split("\n");
    expect(worktrees).toContain(`${runId}-slice1-attempt0-verify`);
  });
});

describe("runPipeline", () => {
  it("passes the acquisition-bound identity when canonicalization changes before lock acquisition", async () => {
    const repo = await initRepo();
    const platformServices = getPlatformServices();
    const canonical = await platformServices.canonicalizePath(repo);
    const preAcquireIdentity = `${canonical.gitCommonDir ?? canonical.canonical}-before-acquire`;
    const acquisitionIdentity = `${canonical.gitCommonDir ?? canonical.canonical}-at-acquire`;
    const observations: string[] = [];
    let acquiredLock: CheckoutLock | undefined;
    let releaseCalls = 0;
    let ps: PlatformServices;
    ps = Object.assign(Object.create(platformServices), {
      async canonicalizePath(input: string) {
        const repositoryIdentity = observations.length === 0
          ? preAcquireIdentity
          : acquisitionIdentity;
        observations.push(repositoryIdentity);
        return { input, canonical: canonical.canonical, gitCommonDir: repositoryIdentity };
      },
      async acquireCheckoutLock(checkout: string) {
        const acquired = await ps.canonicalizePath(checkout);
        const repositoryIdentity = acquired.gitCommonDir ?? acquired.canonical;
        acquiredLock = {
          key: createHash("sha256").update(repositoryIdentity).digest("hex"),
          repositoryIdentity,
          async release() { releaseCalls += 1; },
        };
        return acquiredLock;
      },
    }) as PlatformServices;
    let receivedLease: AttemptRuntimeDependencies["borrowedCheckoutLease"];

    const result = await runPipeline(repo, validSpec(), {
      verifier: passingVerifier,
      ps,
      registry: new ProducerRegistry([]),
      roleRunner: async () => { throw new Error("role runner must not run"); },
      runAttempt: async (_checkoutPath, _spec, attemptDeps) => {
        receivedLease = attemptDeps.borrowedCheckoutLease;
        return failedAttemptResult("pipeline-acquisition-bound-identity");
      },
    });

    expect(result.status).toBe("failed");
    expect(observations).toEqual([preAcquireIdentity, acquisitionIdentity]);
    expect(receivedLease).toBe(acquiredLock);
    expect(receivedLease?.repositoryIdentity).toBe(acquisitionIdentity);
    expect(releaseCalls).toBe(1);
  });

  it("holds one checkout lease through attempt, review, fix, verification, and marker cleanup", async () => {
    const repo = await initRepo();
    const runId = "pipeline-continuous-checkout-lease";
    const spec = validSpec();
    spec.implementation = { maxIncrements: 2 };
    const store = new ArtifactStore(runId);
    let releaseObservedLast = false;
    let lease: Awaited<ReturnType<typeof checkoutLeaseHarness>>;
    lease = await checkoutLeaseHarness(repo, {
      onRelease: async () => {
        expect(lease.held()).toBe(true);
        await expect(store.readPipelineActiveMarker()).resolves.toBeNull();
        await expect(store.readPipelineArtifact("pipeline-result"))
          .resolves.toMatchObject({ status: "decision-ready" });
        releaseObservedLast = true;
      },
    });
    const baseRoleRunner = roundReviews([
      { correctness: blocker, systems: approve },
      { correctness: approve, systems: approve },
    ], async args => {
      expect(lease.held()).toBe(true);
      const commit = await commitFix(args, "lease-protected fix\n");
      return success(fenced({
        reportVersion: "1",
        candidateCommit: commit,
        dispositions: [{
          findingId: "F-001",
          disposition: "fixed",
          evidence: "Committed under the pipeline lease.",
          commit,
        }],
      }));
    });
    const roleRunner = async (args: RoleRunArgs): Promise<RoleRunResult> => {
      expect(lease.held()).toBe(true);
      if (args.role === "implementer") {
        const candidateCommit = await commitIncrement(args, "lease-protected increment\n");
        return success(fenced({
          reportVersion: "1",
          candidateCommit,
          status: "complete",
          summary: "increment complete",
        }));
      }
      return baseRoleRunner(args);
    };
    const deps = dependencies({ runId, roleRunner });
    deps.ps = lease.ps;
    const initialRun = deps.runAttempt!;
    let receivedLease: CheckoutLock | undefined;
    deps.runAttempt = async (checkoutPath, receivedSpec, attemptDeps) => {
      expect(lease.held()).toBe(true);
      receivedLease = attemptDeps.borrowedCheckoutLease;
      return initialRun(checkoutPath, receivedSpec, attemptDeps);
    };
    const verify = AcceptanceVerifier.prototype.verify;
    const verifySpy = vi.spyOn(AcceptanceVerifier.prototype, "verify")
      .mockImplementation(function (args) {
        expect(lease.held()).toBe(true);
        return verify.call(this, args);
      });
    const clearMarker = ArtifactStore.prototype.clearPipelineActiveMarker;
    const clearMarkerSpy = vi.spyOn(ArtifactStore.prototype, "clearPipelineActiveMarker")
      .mockImplementation(function () {
        expect(lease.held()).toBe(true);
        return clearMarker.call(this);
      });

    const result = await runPipeline(repo, spec, deps);

    expect(result.status).toBe("decision-ready");
    expect(result.increments).toHaveLength(1);
    expect(receivedLease).toBe(lease.lock());
    expect(verifySpy).toHaveBeenCalled();
    expect(clearMarkerSpy).toHaveBeenCalledOnce();
    expect(lease.acquireCalls()).toBe(1);
    expect(lease.releaseCalls()).toBe(1);
    expect(lease.held()).toBe(false);
    expect(releaseObservedLast).toBe(true);
  }, 120_000);

  it("holds the borrowed lease through the early sliced marker and temporary-ref cleanup", async () => {
    const repo = await initSlicedRepo();
    const runId = "pipeline-sliced-continuous-checkout-lease";
    const store = new ArtifactStore(runId);
    const temporaryRef = `refs/claude-architect/slices/${runId}/slice-2-attempt-0`;
    let releaseObservedLast = false;
    let lease: Awaited<ReturnType<typeof checkoutLeaseHarness>>;
    lease = await checkoutLeaseHarness(repo, {
      onRelease: async () => {
        expect(lease.held()).toBe(true);
        await expectRefMissing(repo, temporaryRef);
        await expect(store.readPipelineActiveMarker()).resolves.toBeNull();
        await expect(store.readPipelineArtifact("pipeline-result"))
          .resolves.toMatchObject({ status: "decision-ready" });
        releaseObservedLast = true;
      },
    });
    const deps = dependencies({
      runId,
      edit: async checkout => {
        expect(lease.held()).toBe(true);
        await expect(store.readPipelineActiveMarker()).resolves.toMatchObject({
          sliced: true,
        });
        await writeFile(path.join(checkout, "slice-one.txt"), "slice one candidate\n");
      },
      roleRunner: async args => {
        expect(lease.held()).toBe(true);
        if (args.role === "implementer") {
          const candidateCommit = await commitRoleFile(
            args,
            "slice-two.txt",
            "slice two candidate\n",
          );
          return success(fenced({
            reportVersion: "1",
            candidateCommit,
            status: "complete",
            summary: "slice complete",
          }));
        }
        if (args.role === "reviewer-correctness") {
          expect(await runGit(repo, ["rev-parse", "--verify", temporaryRef]))
            .toMatch(/^[0-9a-f]{40}$/);
          return success(fenced(approve));
        }
        throw new Error(`unexpected role ${args.role}`);
      },
    });
    deps.ps = lease.ps;
    const initialRun = deps.runAttempt!;
    let receivedLease: CheckoutLock | undefined;
    deps.runAttempt = async (checkoutPath, receivedSpec, attemptDeps) => {
      expect(lease.held()).toBe(true);
      receivedLease = attemptDeps.borrowedCheckoutLease;
      return initialRun(checkoutPath, receivedSpec, attemptDeps);
    };
    const verify = AcceptanceVerifier.prototype.verify;
    vi.spyOn(AcceptanceVerifier.prototype, "verify").mockImplementation(function (args) {
      expect(lease.held()).toBe(true);
      return verify.call(this, args);
    });

    const result = await runPipeline(repo, slicedSpec(), deps);

    expect(result.status).toBe("decision-ready");
    expect(receivedLease).toBe(lease.lock());
    expect(lease.acquireCalls()).toBe(1);
    expect(lease.releaseCalls()).toBe(1);
    expect(lease.held()).toBe(false);
    expect(releaseObservedLast).toBe(true);
  }, 120_000);

  it("releases the checkout lease after a non-verified initial result", async () => {
    const repo = await initRepo();
    const lease = await checkoutLeaseHarness(repo);
    const failing = failedAttemptResult("pipeline-attempt-lock-release");
    let receivedLease: CheckoutLock | undefined;

    const result = await runPipeline(repo, validSpec(), {
      verifier: passingVerifier,
      ps: lease.ps,
      registry: new ProducerRegistry([]),
      roleRunner: async () => { throw new Error("role runner must not run"); },
      runAttempt: async (_checkoutPath, _spec, attemptDeps) => {
        expect(lease.held()).toBe(true);
        receivedLease = attemptDeps.borrowedCheckoutLease;
        return failing;
      },
    });

    expect(result.status).toBe("failed");
    expect(receivedLease).toBe(lease.lock());
    expect(lease.acquireCalls()).toBe(1);
    expect(lease.releaseCalls()).toBe(1);
    expect(lease.held()).toBe(false);
  });

  it("releases the checkout lease when the initial attempt throws", async () => {
    const repo = await initRepo();
    const lease = await checkoutLeaseHarness(repo);

    await expect(runPipeline(repo, validSpec(), {
      verifier: passingVerifier,
      ps: lease.ps,
      registry: new ProducerRegistry([]),
      roleRunner: async () => { throw new Error("role runner must not run"); },
      runAttempt: async () => {
        expect(lease.held()).toBe(true);
        throw new Error("initial attempt failed");
      },
    })).rejects.toThrow("initial attempt failed");

    expect(lease.acquireCalls()).toBe(1);
    expect(lease.releaseCalls()).toBe(1);
    expect(lease.held()).toBe(false);
  });

  it("reports a checkout lease release failure after an otherwise classified result", async () => {
    const repo = await initRepo();
    const releaseError = new Error("checkout lease release failed");
    const lease = await checkoutLeaseHarness(repo, { releaseError });

    await expect(runPipeline(repo, validSpec(), {
      verifier: passingVerifier,
      ps: lease.ps,
      registry: new ProducerRegistry([]),
      roleRunner: async () => { throw new Error("role runner must not run"); },
      runAttempt: async () => failedAttemptResult("pipeline-release-failure"),
    })).rejects.toBe(releaseError);

    expect(lease.acquireCalls()).toBe(1);
    expect(lease.releaseCalls()).toBe(1);
    expect(lease.held()).toBe(false);
  });

  it("aggregates checkout lease release failure with the primary pipeline error", async () => {
    const repo = await initRepo();
    const primaryError = new Error("pipeline primary failure");
    const releaseError = new Error("checkout lease release failed");
    const lease = await checkoutLeaseHarness(repo, { releaseError });
    let thrown: unknown;

    try {
      await runPipeline(repo, validSpec(), {
        verifier: passingVerifier,
        ps: lease.ps,
        registry: new ProducerRegistry([]),
        roleRunner: async () => { throw new Error("role runner must not run"); },
        runAttempt: async () => { throw primaryError; },
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AggregateError);
    expect((thrown as AggregateError).errors).toEqual([primaryError, releaseError]);
    expect(lease.acquireCalls()).toBe(1);
    expect(lease.releaseCalls()).toBe(1);
    expect(lease.held()).toBe(false);
  });

  it("hands the attempt the dispatched spec hash, not the sliced spec's", async () => {
    const repo = await initSlicedRepo();
    const runId = "pipeline-slice-spec-hash";
    const spec = slicedSpec();
    const deps = dependencies({
      runId,
      edit: async checkout => {
        await writeFile(path.join(checkout, "slice-one.txt"), "slice one candidate\n");
      },
    });
    const realAttempt = deps.runAttempt!;
    let handed: string | undefined;
    deps.runAttempt = async (checkoutPath, receivedSpec, attemptDeps) => {
      handed = attemptDeps?.dispatchedSpecSha256;
      // The spec the attempt receives is the slice, which is exactly why the
      // attempt must not derive the run's identity from it.
      expect(specSha256(receivedSpec)).not.toBe(specSha256(spec));
      return realAttempt(checkoutPath, receivedSpec, attemptDeps);
    };

    await runPipeline(repo, spec, deps).catch(() => undefined);

    // scopeSpecToSlice merges the slice over the spec and drops `slices`, so
    // hashing what the attempt receives recorded an identity no caller ever
    // held, and reviewCandidate's correspondence check could never match it.
    expect(handed).toBe(specSha256(spec));
  });

  it("establishes sliced lifecycle authority before the initial candidate is created", async () => {
    const repo = await initSlicedRepo();
    const runId = "pipeline-slices-early-marker";
    let markerBeforeEdit: Awaited<ReturnType<ArtifactStore["readPipelineActiveMarker"]>>;

    const result = await runPipeline(repo, slicedSpec(), dependencies({
      runId,
      edit: async checkout => {
        markerBeforeEdit = await new ArtifactStore(runId).readPipelineActiveMarker();
        await writeFile(path.join(checkout, "slice-one.txt"), "slice one candidate\n");
      },
      roleRunner: async args => {
        if (args.role === "implementer") {
          const candidateCommit = await commitRoleFile(
            args,
            "slice-two.txt",
            "slice two candidate\n",
          );
          return success(fenced({
            reportVersion: "1",
            candidateCommit,
            status: "complete",
            summary: "slice complete",
          }));
        }
        if (args.role === "reviewer-correctness") return success(fenced(approve));
        throw new Error(`unexpected role ${args.role}`);
      },
    }));

    expect(result.status).toBe("decision-ready");
    expect(markerBeforeEdit).toMatchObject({ sliced: true });
  }, 120_000);

  it("does not archive a sliced candidate when lifecycle authority cannot be established", async () => {
    const repo = await initSlicedRepo();
    const runId = "pipeline-slices-marker-write-failure";
    let editCalled = false;
    vi.spyOn(ArtifactStore.prototype, "writePipelineActiveMarker")
      .mockRejectedValueOnce(new Error("pipeline marker write failed"));

    await expect(runPipeline(repo, slicedSpec(), dependencies({
      runId,
      edit: async checkout => {
        editCalled = true;
        await writeFile(path.join(checkout, "slice-one.txt"), "slice one candidate\n");
      },
      roleRunner: async () => { throw new Error("role runner must not run"); },
    }))).rejects.toThrow("pipeline marker write failed");

    expect(editCalled).toBe(false);
    await expect(new ArtifactStore(runId).readResult()).resolves.toBeNull();
  });

  it("advances disjoint slices through private provenance and composed gates", async () => {
    const repo = await initSlicedRepo();
    const runId = "pipeline-slices-advance";
    const spec = slicedSpec();
    const parentSnapshot = structuredClone(spec);
    const initialRun = fakeAttempt(runId, async checkout => {
      await writeFile(path.join(checkout, "slice-one.txt"), "slice one candidate\n");
    });
    let initialSpec: DelegationSpec | undefined;
    let implementerArgs: RoleRunArgs | undefined;
    const temporarySliceRef = `refs/claude-architect/slices/${runId}/slice-2-attempt-0`;
    let observedTemporaryRef = "";
    const reviewArgs: RoleRunArgs[] = [];
    const roleRunner = async (args: RoleRunArgs): Promise<RoleRunResult> => {
      if (args.role === "implementer") {
        implementerArgs = args;
        expect(await readFile(path.join(args.worktreePath, "slice-one.txt"), "utf8"))
          .toBe("slice one candidate\n");
        const candidateCommit = await commitRoleFile(
          args,
          "slice-two.txt",
          "slice two candidate\n",
        );
        return success(fenced({
          reportVersion: "1",
          candidateCommit,
          status: "blocked",
          summary: "Producer status must not control objective routing.",
          blockers: "Untrusted Producer claim.",
        }));
      }
      if (args.role === "reviewer-correctness") {
        observedTemporaryRef = await runGit(repo, ["rev-parse", "--verify", temporarySliceRef]);
        reviewArgs.push(args);
        return success(fenced(approve));
      }
      throw new Error(`unexpected role ${args.role}`);
    };
    const deps = dependencies({ runId, roleRunner });
    deps.runAttempt = async (checkoutPath, receivedSpec, attemptDeps) => {
      initialSpec = structuredClone(receivedSpec);
      return initialRun(checkoutPath, receivedSpec, attemptDeps);
    };
    const acceptanceSpy = vi.spyOn(AcceptanceVerifier.prototype, "verify");

    const result = await runPipeline(repo, spec, deps);

    expect(initialSpec).toEqual(scopeSpecToSlice(parentSnapshot, parentSnapshot.slices![0]!));
    expect(initialSpec).not.toHaveProperty("slices");
    expect(spec).toEqual(parentSnapshot);
    expect(implementerArgs?.baseSpec).toEqual(
      scopeSpecToSlice(parentSnapshot, parentSnapshot.slices![1]!),
    );
    expect(implementerArgs?.pkg.spec).toEqual(implementerArgs?.baseSpec);
    expect(implementerArgs?.pkg.baselineCommit).toBe(result.slices[0]?.candidateCommit);
    expect(implementerArgs?.pkg.candidateCommit).toBe(result.slices[0]?.candidateCommit);
    expect(implementerArgs?.pkg.candidateDiff).toBe("");
    expect(implementerArgs?.pkg).not.toHaveProperty("progress");
    expect(path.basename(implementerArgs?.worktreePath ?? "")).toBe(
      `${runId}-slice-2-attempt-0`,
    );

    expect(reviewArgs).toHaveLength(1);
    expect(reviewArgs[0]?.baseSpec).toEqual(parentSnapshot);
    expect(reviewArgs[0]?.pkg.candidateDiff).toContain("slice one candidate");
    expect(reviewArgs[0]?.pkg.candidateDiff).toContain("slice two candidate");
    expect(reviewArgs[0]?.pkg.testEvidence).toContain('"sliceIndex":1');
    expect(reviewArgs[0]?.pkg.testEvidence).toContain('"sliceIndex":2');
    expect(path.basename(reviewArgs[0]?.worktreePath ?? "")).toBe(`${runId}-composed-review`);

    expect(result).toMatchObject({
      status: "decision-ready",
      increments: [],
      haltedSliceIndex: null,
      failure: null,
    });
    expect(result.slices).toHaveLength(2);
    expect(result.slices.map(slice => slice.route)).toEqual(["advance", "advance"]);
    expect(result.slices[0]?.roleLogRefs).toEqual(["logs/producer.log"]);
    expect(result.slices[1]?.roleLogRefs).toEqual([
      "logs/role-implementer-slice-2-attempt-0-increment1.log",
    ]);
    expect(observedTemporaryRef).toBe(result.slices[1]?.candidateCommit);
    expect((await git(repo, ["rev-parse", "--verify", "--quiet", temporarySliceRef])).exitCode)
      .not.toBe(0);
    expect(result.slices[1]?.verification?.scopeViolations).toEqual([]);
    expect(result.rounds).toHaveLength(1);
    expect(result.verification?.pass).toBe(true);

    expect(acceptanceSpy.mock.calls.map(call => path.basename(call[0].worktreePath))).toEqual([
      `${runId}-slice-1-attempt-0-verify`,
      `${runId}-slice-2-attempt-0-verify`,
      `${runId}-final-verify`,
    ]);
    const verificationIds = acceptanceSpy.mock.calls.map(call => call[0].verificationId?.());
    expect(verificationIds).toEqual([
      `${runId}-slice-1-attempt-0-pipeline`,
      `${runId}-slice-2-attempt-0-pipeline`,
      `${runId}-final-pipeline`,
    ]);
    const store = new ArtifactStore(runId);
    const sliceOneStdout = result.slices[0]?.verification?.evidence.commandOutcomes[0]?.stdoutRef;
    const sliceTwoStdout = result.slices[1]?.verification?.evidence.commandOutcomes[0]?.stdoutRef;
    const finalStdout = result.verification?.evidence.commandOutcomes[0]?.stdoutRef;
    expect([sliceOneStdout, sliceTwoStdout, finalStdout]).toEqual([
      "logs/slice-1-attempt-0-pipeline-verification-0-stdout.log",
      "logs/slice-2-attempt-0-pipeline-verification-0-stdout.log",
      "logs/final-pipeline-verification-0-stdout.log",
    ]);
    const nestedWorktrees = await Promise.all(
      [sliceOneStdout, sliceTwoStdout, finalStdout].map(async ref =>
        path.basename(await readFile(path.join(store.runDirectory, ref!), "utf8"))),
    );
    expect(nestedWorktrees).toEqual([
      `verify-${runId}-slice-1-attempt-0-pipeline`,
      `verify-${runId}-slice-2-attempt-0-pipeline`,
      `verify-${runId}-final-pipeline`,
    ]);
    expect(new Set([
      implementerArgs?.worktreePath,
      reviewArgs[0]?.worktreePath,
      ...acceptanceSpy.mock.calls.map(call => call[0].worktreePath),
      ...nestedWorktrees,
    ]).size).toBe(8);

    await expect(store.readPipelineArtifact("slice-1-attempt-0"))
      .resolves.toMatchObject({ sliceIndex: 1, attempt: 0, route: "advance" });
    await expect(store.readPipelineArtifact("slice-1"))
      .resolves.toMatchObject({ index: 1, route: "advance" });
    await expect(store.readPipelineArtifact("slice-2-attempt-0"))
      .resolves.toMatchObject({ sliceIndex: 2, attempt: 0, route: "advance" });
    await expect(store.readPipelineArtifact("slice-2"))
      .resolves.toMatchObject({ index: 2, route: "advance" });
    expect(result.attempt.candidate?.candidateCommitOid).toBe(result.finalCandidateCommit);
    await expect(store.readResult()).resolves.toMatchObject({
      candidate: { candidateCommitOid: result.finalCandidateCommit },
    });
    expect(await runGit(repo, ["rev-parse", result.attempt.candidate!.anchorRef]))
      .toBe(result.finalCandidateCommit);
    expect(await runGit(repo, ["show", `${result.finalCandidateCommit}:slice-one.txt`]))
      .toBe("slice one candidate");
    expect(await runGit(repo, ["show", `${result.finalCandidateCommit}:slice-two.txt`]))
      .toBe("slice two candidate");
  }, 120_000);

  it("retains lifecycle authority when a primary failure coincides with incomplete ref cleanup", async () => {
    const repo = await initSlicedRepo();
    const runId = "pipeline-slices-cleanup-errors";
    const spec = slicedSpec();
    const initialRun = fakeAttempt(runId, async checkout => {
      await writeFile(path.join(checkout, "slice-one.txt"), "slice one candidate\n");
    });
    const baselineCommit = await runGit(repo, ["rev-parse", "HEAD"]);
    const temporarySliceRef = `refs/claude-architect/slices/${runId}/slice-2-attempt-0`;
    const roleRunner = async (args: RoleRunArgs): Promise<RoleRunResult> => {
      if (args.role === "implementer") {
        const candidateCommit = await commitRoleFile(
          args,
          "slice-two.txt",
          "slice two candidate\n",
        );
        return success(fenced({
          reportVersion: "1",
          candidateCommit,
          status: "complete",
          summary: "slice complete",
        }));
      }
      if (args.role === "reviewer-correctness") {
        const expectedOid = await runGit(repo, ["rev-parse", "--verify", temporarySliceRef]);
        await runGit(repo, [
          "update-ref",
          temporarySliceRef,
          baselineCommit,
          expectedOid,
        ]);
        throw new Error("primary composed-review failure");
      }
      throw new Error(`unexpected role ${args.role}`);
    };
    const deps = dependencies({ runId, roleRunner });
    deps.runAttempt = initialRun;
    const markerCleanup = vi.spyOn(ArtifactStore.prototype, "clearPipelineActiveMarker");

    let thrown: unknown;
    try {
      await runPipeline(repo, spec, deps);
    } catch (error) {
      thrown = error;
    }

    const messages: string[] = [];
    const collectMessages = (error: unknown): void => {
      if (error instanceof Error) messages.push(error.message);
      if (error instanceof AggregateError) error.errors.forEach(collectMessages);
    };
    collectMessages(thrown);
    expect(thrown).toBeInstanceOf(AggregateError);
    expect(messages).toContain("primary composed-review failure");
    expect(messages.some(message => message.includes("delete temporary slice ref"))).toBe(true);
    expect(markerCleanup).not.toHaveBeenCalled();
    await expect(new ArtifactStore(runId).readPipelineActiveMarker()).resolves.toMatchObject({
      sliced: true,
    });
    expect(await runGit(repo, ["rev-parse", "--verify", temporarySliceRef]))
      .toBe(baselineCommit);
  }, 120_000);

  it("archives a temporary-ref cleanup failure but retains lifecycle authority", async () => {
    const repo = await initSlicedRepo();
    const runId = "pipeline-slices-ref-cleanup-failure";
    const spec = slicedSpec();
    const initialRun = fakeAttempt(runId, async checkout => {
      await writeFile(path.join(checkout, "slice-one.txt"), "slice one candidate\n");
    });
    const baselineCommit = await runGit(repo, ["rev-parse", "HEAD"]);
    const temporarySliceRef = `refs/claude-architect/slices/${runId}/slice-2-attempt-0`;
    const roleRunner = async (args: RoleRunArgs): Promise<RoleRunResult> => {
      if (args.role === "implementer") {
        const candidateCommit = await commitRoleFile(
          args,
          "slice-two.txt",
          "slice two candidate\n",
        );
        return success(fenced({
          reportVersion: "1",
          candidateCommit,
          status: "complete",
          summary: "slice complete",
        }));
      }
      if (args.role === "reviewer-correctness") {
        const expectedOid = await runGit(repo, ["rev-parse", "--verify", temporarySliceRef]);
        await runGit(repo, [
          "update-ref",
          temporarySliceRef,
          baselineCommit,
          expectedOid,
        ]);
        return success(fenced(approve));
      }
      throw new Error(`unexpected role ${args.role}`);
    };
    const deps = dependencies({ runId, roleRunner });
    deps.runAttempt = initialRun;

    await expect(runPipeline(repo, spec, deps))
      .rejects.toThrow("delete temporary slice ref");

    const store = new ArtifactStore(runId);
    await expect(store.readResult()).resolves.toMatchObject({
      status: "failed",
      failure: "verification-failure",
      candidate: expect.any(Object),
    });
    await expect(store.readPipelineActiveMarker()).resolves.toMatchObject({ sliced: true });
    const archived = await store.readResult();
    await expectPipelineAuthorityBlocksTools(
      repo,
      runId,
      archived!.candidate!.manifestHash,
    );
    expect(await runGit(repo, ["rev-parse", temporarySliceRef])).toBe(baselineCommit);
  }, 120_000);

  it("retains lifecycle authority when terminal failure archival does not complete", async () => {
    const repo = await initSlicedRepo();
    const runId = "pipeline-slices-archive-failure";
    const spec = slicedSpec(true);
    const initialRun = fakeAttempt(runId, async checkout => {
      await writeFile(path.join(checkout, "slice-one.txt"), "slice one candidate\n");
    });
    const deps = dependencies({
      runId,
      roleRunner: async args => {
        if (args.role === "reviewer-correctness") {
          return {
            ok: false,
            rawOutput: "",
            failure: "timeout",
            producerId: "stub",
          };
        }
        throw new Error(`unexpected role ${args.role}`);
      },
    });
    deps.runAttempt = initialRun;
    const promotion = vi.spyOn(ArtifactStore.prototype, "promoteTerminalArtifacts")
      .mockRejectedValueOnce(new Error("terminal archive failed"));

    await expect(runPipeline(repo, spec, deps)).rejects.toThrow(
      "sliced pipeline failed and its attempt result could not be archived",
    );

    const store = new ArtifactStore(runId);
    expect(promotion).toHaveBeenCalledOnce();
    await expect(store.readPipelineActiveMarker()).resolves.toMatchObject({ sliced: true });
    const archived = await store.readResult();
    expect(archived).toMatchObject({ status: "verified-candidate" });
    await expectRefMissing(repo, archived!.candidate!.anchorRef);
    await expectPipelineAuthorityBlocksTools(
      repo,
      runId,
      archived!.candidate!.manifestHash,
    );

    promotion.mockRestore();
    await expect(recoverStaleRuns({
      platformServices: {
        os: "darwin",
        async getProcessStartToken() { return null; },
        async terminateProcessTreeByPid() {},
      },
      isProcessAlive: () => false,
    })).resolves.toEqual({ recovered: [], quarantined: [] });

    await expect(store.readResult()).resolves.toMatchObject({
      status: "failed",
      failure: "verification-failure",
      candidate: expect.any(Object),
    });
    await expect(store.readPipelineActiveMarker()).resolves.toBeNull();
    await expectRefMissing(repo, archived!.candidate!.anchorRef);
    const oldTime = new Date(Date.now() - 60_000);
    await utimes(store.runDirectory, oldTime, oldTime);
    await expect(store.prune({
      maxAgeMs: 1_000,
      maxBytes: Number.MAX_SAFE_INTEGER,
    })).resolves.toMatchObject({ removed: [runId] });
    await expect(store.readResult()).resolves.toBeNull();
  }, 120_000);

  it("refuses candidate-null archival when the exact run anchor moved", async () => {
    const repo = await initSlicedRepo();
    const runId = "pipeline-slices-moved-failure-anchor";
    const spec = slicedSpec(true);
    const initialRun = fakeAttempt(runId, async checkout => {
      await writeFile(path.join(checkout, "slice-one.txt"), "slice one candidate\n");
    });
    const movedOid = await runGit(repo, ["rev-parse", "HEAD"]);
    const anchorRef = `refs/claude-architect/candidates/${runId}`;
    const deps = dependencies({
      runId,
      roleRunner: async args => {
        if (args.role === "reviewer-correctness") {
          const expectedOid = await runGit(repo, ["rev-parse", anchorRef]);
          await runGit(repo, ["update-ref", anchorRef, movedOid, expectedOid]);
          return {
            ok: false,
            rawOutput: "",
            failure: "timeout",
            producerId: "stub",
          };
        }
        throw new Error(`unexpected role ${args.role}`);
      },
    });
    deps.runAttempt = initialRun;

    let thrown: unknown;
    try {
      await runPipeline(repo, spec, deps);
    } catch (error) {
      thrown = error;
    }

    const messages: string[] = [];
    const collectMessages = (error: unknown): void => {
      if (error instanceof Error) messages.push(error.message);
      if (error instanceof AggregateError) error.errors.forEach(collectMessages);
    };
    collectMessages(thrown);
    expect(messages.some(message => message.includes("delete sliced candidate anchor"))).toBe(true);
    expect(await runGit(repo, ["rev-parse", anchorRef])).toBe(movedOid);
    const store = new ArtifactStore(runId);
    const archived = await store.readResult();
    expect(archived).toMatchObject({ status: "verified-candidate" });
    await expect(store.readPipelineActiveMarker()).resolves.toMatchObject({ sliced: true });
    await expectPipelineAuthorityBlocksTools(
      repo,
      runId,
      archived!.candidate!.manifestHash,
    );
  }, 120_000);

  it("refuses candidate-null archival for a noncanonical candidate anchor", async () => {
    const repo = await initSlicedRepo();
    const runId = "pipeline-slices-noncanonical-failure-anchor";
    const spec = slicedSpec(true);
    const initialRun = fakeAttempt(runId, async checkout => {
      await writeFile(path.join(checkout, "slice-one.txt"), "slice one candidate\n");
    });
    const canonicalRef = `refs/claude-architect/candidates/${runId}`;
    const foreignRef = `${canonicalRef}-foreign`;
    const deps = dependencies({
      runId,
      roleRunner: async args => {
        if (args.role === "reviewer-correctness") {
          return {
            ok: false,
            rawOutput: "",
            failure: "timeout",
            producerId: "stub",
          };
        }
        throw new Error(`unexpected role ${args.role}`);
      },
    });
    deps.runAttempt = async (checkoutPath, receivedSpec, attemptDeps) => {
      const result = await initialRun(checkoutPath, receivedSpec, attemptDeps);
      await runGit(repo, ["update-ref", foreignRef, result.candidate!.candidateCommitOid]);
      return {
        ...result,
        candidate: { ...result.candidate!, anchorRef: foreignRef },
      };
    };

    let thrown: unknown;
    try {
      await runPipeline(repo, spec, deps);
    } catch (error) {
      thrown = error;
    }

    const messages: string[] = [];
    const collectMessages = (error: unknown): void => {
      if (error instanceof Error) messages.push(error.message);
      if (error instanceof AggregateError) error.errors.forEach(collectMessages);
    };
    collectMessages(thrown);
    expect(messages).toContain("sliced candidate anchor does not match run id");

    const canonicalOid = await runGit(repo, ["rev-parse", canonicalRef]);
    expect(await runGit(repo, ["rev-parse", foreignRef])).toBe(canonicalOid);
    const store = new ArtifactStore(runId);
    await expect(store.readResult()).resolves.toMatchObject({ status: "verified-candidate" });
    await expect(store.readPipelineActiveMarker()).resolves.toMatchObject({ sliced: true });
  }, 120_000);

  it("runs independent per-slice reviewers with slice-local evidence and logs", async () => {
    const repo = await initSlicedRepo();
    const runId = "pipeline-slices-review";
    const spec = slicedSpec(true);
    const initialRun = fakeAttempt(runId, async checkout => {
      await writeFile(path.join(checkout, "slice-one.txt"), "slice one candidate\n");
    });
    const reviewerArgs: RoleRunArgs[] = [];
    const roleRunner = async (args: RoleRunArgs): Promise<RoleRunResult> => {
      if (args.role === "implementer") {
        const candidateCommit = await commitRoleFile(
          args,
          "slice-two.txt",
          "slice two candidate\n",
        );
        return success(fenced({
          reportVersion: "1",
          candidateCommit,
          status: "continue",
          summary: "Producer continuation is non-authoritative.",
          nextSteps: "Objective gates decide advancement.",
        }));
      }
      if (args.role === "reviewer-correctness") {
        reviewerArgs.push(args);
        return success(fenced(approve));
      }
      throw new Error(`unexpected role ${args.role}`);
    };
    const deps = dependencies({ runId, roleRunner });
    deps.runAttempt = initialRun;

    const result = await runPipeline(repo, spec, deps);

    expect(result.status).toBe("decision-ready");
    expect(result.slices).toHaveLength(2);
    expect(reviewerArgs).toHaveLength(3);
    expect(reviewerArgs.map(args => path.basename(args.worktreePath))).toEqual([
      `${runId}-slice-1-attempt-0-review`,
      `${runId}-slice-2-attempt-0-review`,
      `${runId}-composed-review`,
    ]);
    expect(reviewerArgs[0]?.baseSpec.objective).toBe("Implement slice one only.");
    expect(reviewerArgs[0]?.pkg.candidateDiff).toContain("slice one candidate");
    expect(reviewerArgs[0]?.pkg.candidateDiff).not.toContain("slice two candidate");
    expect(reviewerArgs[0]?.pkg.testEvidence).toContain('"slice-one-check"');
    expect(reviewerArgs[1]?.baseSpec.objective).toBe("Implement slice two only.");
    expect(reviewerArgs[1]?.pkg.candidateDiff).toContain("slice two candidate");
    expect(reviewerArgs[1]?.pkg.candidateDiff).not.toContain("slice one candidate");
    expect(reviewerArgs[1]?.pkg.testEvidence).toContain('"slice-two-check"');
    expect(reviewerArgs[2]?.baseSpec.objective).toBe("Implement both ordered slices.");
    expect(reviewerArgs[2]?.pkg.testEvidence).toContain('"sliceIndex":1');
    expect(reviewerArgs[2]?.pkg.testEvidence).toContain('"sliceIndex":2');
    expect(result.slices.map(slice => slice.perSliceReview)).toEqual([
      { findings: [] },
      { findings: [] },
    ]);
    expect(result.slices.map(slice => slice.roleLogRefs)).toEqual([
      [
        "logs/producer.log",
        "logs/role-reviewer-correctness-slice-1-attempt-0-round1.log",
      ],
      [
        "logs/role-implementer-slice-2-attempt-0-increment1.log",
        "logs/role-reviewer-correctness-slice-2-attempt-0-round1.log",
      ],
    ]);
  }, 120_000);

  it("returns an explicit failed sliced result when objective routing halts", async () => {
    const repo = await initSlicedRepo();
    const runId = "pipeline-slices-halt";
    const spec = slicedSpec();
    spec.writeAllowlist.push("a.txt");
    const initialRun = fakeAttempt(runId, async checkout => {
      await writeFile(path.join(checkout, "a.txt"), "out of slice one scope\n");
    });
    let reviewerCalls = 0;
    const roleRunner = async (args: RoleRunArgs): Promise<RoleRunResult> => {
      if (args.role === "implementer") {
        const candidateCommit = await commitRoleFile(
          args,
          "a.txt",
          "still out of slice one scope\n",
        );
        return success(fenced({
          reportVersion: "1",
          candidateCommit,
          status: "complete",
          summary: "Untrusted repair remained outside the slice.",
        }));
      }
      reviewerCalls += 1;
      return success(fenced(approve));
    };
    const deps = dependencies({ runId, roleRunner });
    deps.runAttempt = initialRun;
    const baselineCommit = await runGit(repo, ["rev-parse", "HEAD"]);

    const result = await runPipeline(repo, spec, deps);

    expect(result).toMatchObject({
      status: "failed",
      increments: [],
      haltedSliceIndex: 1,
      rounds: [],
      verification: null,
      finalCandidateCommit: baselineCommit,
      failure: "verification-failure",
    });
    expect(result.slices).toHaveLength(1);
    expect(result.slices[0]).toMatchObject({
      index: 1,
      route: "halt",
      roundsUsed: 1,
      reasons: ["slice verification failed", "out-of-scope diff: a.txt"],
    });
    expect(result.slices[0]?.attempts).toHaveLength(2);
    expect(reviewerCalls).toBe(0);
    expect(result.attempt.candidate?.candidateCommitOid).not.toBe(result.finalCandidateCommit);
    const store = new ArtifactStore(runId);
    await expect(store.readPipelineArtifact("slice-1-attempt-0"))
      .resolves.toMatchObject({ route: "repair" });
    await expect(store.readPipelineArtifact("slice-1-attempt-1"))
      .resolves.toMatchObject({ route: "halt" });
    await expect(store.readPipelineArtifact("slice-1"))
      .resolves.toMatchObject({ route: "halt" });
    const archived = await store.readResult();
    expect(archived).toMatchObject({
      status: "failed",
      failure: "verification-failure",
      candidate: result.attempt.candidate,
    });
    expect(result.attempt).toEqual(archived);
    expect(await runGit(repo, ["rev-parse", result.attempt.candidate!.anchorRef]))
      .toBe(result.attempt.candidate!.candidateCommitOid);
    await writeFile(
      path.join(store.runDirectory, "decision.json"),
      `${JSON.stringify({
        decision: "accepted",
        recordedAt: "2026-07-19T12:00:00.000Z",
      })}\n`,
    );
    await expect(handleIntegrateCandidate(
      repo,
      runId,
      result.attempt.candidate!.manifestHash,
    )).resolves.toEqual({
      ok: false,
      error: "candidate-not-verified",
      diagnostic: "candidate did not complete independent verification",
    });
  }, 120_000);

  it("hands a later-slice halt to the human as an acceptable partial candidate", async () => {
    const repo = await initSlicedRepo();
    const runId = "pipeline-slices-partial-halt";
    const spec = slicedSpec();
    const initialRun = fakeAttempt(runId, async checkout => {
      await writeFile(path.join(checkout, "slice-one.txt"), "slice one candidate\n");
    });
    let reviewerCalls = 0;
    const roleRunner = async (args: RoleRunArgs): Promise<RoleRunResult> => {
      if (args.role === "implementer") {
        // Slice two never satisfies its verification, so it exhausts its repair
        // budget and halts — but only after slice one has already advanced.
        const candidateCommit = await commitRoleFile(
          args,
          "slice-two.txt",
          "wrong slice two\n",
        );
        return success(fenced({
          reportVersion: "1",
          candidateCommit,
          status: "complete",
          summary: "Producer claim is not objective evidence.",
        }));
      }
      reviewerCalls += 1;
      return success(fenced(approve));
    };
    const deps = dependencies({ runId, roleRunner });
    deps.runAttempt = initialRun;
    const baselineCommit = await runGit(repo, ["rev-parse", "HEAD"]);

    const result = await runPipeline(repo, spec, deps);

    // A halt after at least one advance is handed to the human, not reported
    // failed: the design routes it to human-decision-required with the partial
    // branch promoted for a decision.
    expect(result).toMatchObject({
      status: "human-decision-required",
      haltedSliceIndex: 2,
      failure: null,
      increments: [],
      rounds: [],
    });
    expect(result.slices.map(slice => slice.route)).toEqual(["advance", "halt"]);
    expect(result.slices[1]?.attempts).toHaveLength(2);
    expect(reviewerCalls).toBe(0);
    expect(result.gate).toMatchObject({ decisionReady: false, requiresHumanDecision: true });
    expect(result.finalCandidateCommit).not.toBe(baselineCommit);

    // The partial branch keeps slice one's advance and leaves slice two at its
    // baseline; the composed verification honestly fails on the unbuilt slice.
    expect(await runGit(repo, ["show", `${result.finalCandidateCommit}:slice-one.txt`]))
      .toBe("slice one candidate");
    expect(await runGit(repo, ["show", `${result.finalCandidateCommit}:slice-two.txt`]))
      .toBe("slice two base");
    expect(result.verification?.pass).toBe(false);

    // The promoted partial is a real verified-candidate anchored at the partial
    // branch, so the human can accept it — the crux of a human-decision halt.
    const store = new ArtifactStore(runId);
    const archivedResult = await store.readResult();
    expect(archivedResult).toMatchObject({
      status: "verified-candidate",
      failure: null,
      candidate: { candidateCommitOid: result.finalCandidateCommit },
    });
    expect(await runGit(repo, ["rev-parse", result.attempt.candidate!.anchorRef]))
      .toBe(result.finalCandidateCommit);
    await expect(handleDecideCandidate(
      repo,
      runId,
      "accepted",
      archivedResult!.candidate!.manifestHash,
    ))
      .resolves.toEqual({ recorded: true });
  }, 120_000);

  it("archives a SliceExecutionError as the returned non-integrable attempt", async () => {
    const repo = await initSlicedRepo();
    const runId = "pipeline-slices-role-failure";
    const spec = slicedSpec();
    const initialRun = fakeAttempt(runId, async checkout => {
      await writeFile(path.join(checkout, "slice-one.txt"), "slice one candidate\n");
    });
    const deps = dependencies({
      runId,
      roleRunner: async args => {
        if (args.role === "implementer") {
          return {
            ok: false,
            rawOutput: "",
            failure: "timeout",
            producerId: "stub",
          };
        }
        throw new Error(`unexpected role ${args.role}`);
      },
    });
    deps.runAttempt = initialRun;

    const result = await runPipeline(repo, spec, deps);

    expect(result).toMatchObject({
      status: "failed",
      failure: "timeout",
      attempt: {
        status: "failed",
        failure: "timeout",
        candidate: null,
      },
    });
    const store = new ArtifactStore(runId);
    await expect(store.readResult()).resolves.toEqual(result.attempt);
    await expectRefMissing(repo, `refs/claude-architect/candidates/${runId}`);
    await expect(readFile(
      path.join(store.runDirectory, "pipeline-active.json"),
      "utf8",
    )).rejects.toMatchObject({ code: "ENOENT" });
  }, 120_000);

  it("labels sliced candidate provenance failures as slice implementer failures", async () => {
    const repo = await initSlicedRepo();
    const runId = "pipeline-slices-provenance-label";
    const spec = slicedSpec();
    const initialRun = fakeAttempt(runId, async checkout => {
      await writeFile(path.join(checkout, "slice-one.txt"), "slice one candidate\n");
    });
    const deps = dependencies({
      runId,
      roleRunner: async args => {
        if (args.role === "implementer") {
          return success(fenced({
            reportVersion: "1",
            candidateCommit: "d".repeat(40),
            status: "complete",
            summary: "reported a nonexistent commit",
          }));
        }
        throw new Error(`unexpected role ${args.role}`);
      },
    });
    deps.runAttempt = initialRun;

    const result = await runPipeline(repo, spec, deps);

    expect(result.gate.reasons).toContain("slice implementer reported a missing candidate commit");
    expect(result.gate.reasons.some(reason => reason.includes("fix phase"))).toBe(false);
  }, 120_000);

  it("archives an initial per-slice review error before returning failure", async () => {
    const repo = await initSlicedRepo();
    const runId = "pipeline-slices-initial-review-failure";
    const spec = slicedSpec(true);
    const initialRun = fakeAttempt(runId, async checkout => {
      await writeFile(path.join(checkout, "slice-one.txt"), "slice one candidate\n");
    });
    const deps = dependencies({
      runId,
      roleRunner: async args => {
        if (args.role === "reviewer-correctness") {
          return {
            ok: false,
            rawOutput: "",
            failure: "timeout",
            producerId: "stub",
          };
        }
        throw new Error(`unexpected role ${args.role}`);
      },
    });
    deps.runAttempt = initialRun;

    const result = await runPipeline(repo, spec, deps);

    expect(result).toMatchObject({
      status: "failed",
      failure: "producer-failure",
      attempt: {
        status: "failed",
        failure: "producer-failure",
        candidate: null,
      },
    });
    await expect(new ArtifactStore(runId).readResult()).resolves.toEqual(result.attempt);
    await expectRefMissing(repo, `refs/claude-architect/candidates/${runId}`);
  }, 120_000);

  it("salvages a verified composed candidate when the review role fails", async () => {
    const repo = await initSlicedRepo();
    const runId = "pipeline-slices-composed-review-failure";
    const spec = slicedSpec();
    const initialRun = fakeAttempt(runId, async checkout => {
      await writeFile(path.join(checkout, "slice-one.txt"), "slice one candidate\n");
    });
    const deps = dependencies({
      runId,
      roleRunner: async args => {
        if (args.role === "implementer") {
          const candidateCommit = await commitRoleFile(
            args,
            "slice-two.txt",
            "slice two candidate\n",
          );
          return success(fenced({
            reportVersion: "1",
            candidateCommit,
            status: "complete",
            summary: "slice complete",
          }));
        }
        if (args.role === "reviewer-correctness") {
          return {
            ok: false,
            rawOutput: "",
            failure: "timeout",
            producerId: "stub",
          };
        }
        throw new Error(`unexpected role ${args.role}`);
      },
    });
    deps.runAttempt = initialRun;

    const result = await runPipeline(repo, spec, deps);

    // A reviewer that cannot run is an orchestration failure, not a verdict.
    // The composed bytes still passed independent verification, so they are
    // presented for the human review the pipeline could not perform itself.
    expect(result).toMatchObject({
      status: "human-decision-required",
      failure: null,
      attempt: { status: "verified-candidate", failure: null },
    });
    expect(result.attempt.candidate).not.toBeNull();
    expect(result.verification?.pass).toBe(true);
    expect(result.gate.requiresHumanDecision).toBe(true);
    expect(result.gate.reasons[0]).toContain("review phase");

    // Salvage is only worth anything if the trusted accept path can load these
    // bytes: the archived result — not the in-memory one — is what it reads.
    const archived = await new ArtifactStore(runId).readResult();
    expect(archived).toMatchObject({ status: "verified-candidate", failure: null });
    expect(archived?.candidate?.candidateCommitOid).toBe(result.finalCandidateCommit);
    const archivedManifest = await new ArtifactStore(runId).readManifest();
    expect(archivedManifest?.candidateManifestHash).toBe(archived?.candidate?.manifestHash);
    expect(archived?.evidence.pipelineReviewIncomplete).toMatchObject({
      failure: "producer-failure",
    });
    // The definitive check: the real accept gate must admit these bytes.
    await expect(handleDecideCandidate(
      repo,
      runId,
      "accepted",
      archived!.candidate!.manifestHash,
    )).resolves.toEqual({ recorded: true });
  }, 120_000);

  it("archives an unexpected final-verification error before clearing lifecycle authority", async () => {
    const repo = await initSlicedRepo();
    const runId = "pipeline-slices-final-verification-error";
    const spec = slicedSpec();
    const initialRun = fakeAttempt(runId, async checkout => {
      await writeFile(path.join(checkout, "slice-one.txt"), "slice one candidate\n");
    });
    const deps = dependencies({
      runId,
      roleRunner: async args => {
        if (args.role === "implementer") {
          const candidateCommit = await commitRoleFile(
            args,
            "slice-two.txt",
            "slice two candidate\n",
          );
          return success(fenced({
            reportVersion: "1",
            candidateCommit,
            status: "complete",
            summary: "slice complete",
          }));
        }
        if (args.role === "reviewer-correctness") return success(fenced(approve));
        throw new Error(`unexpected role ${args.role}`);
      },
    });
    deps.runAttempt = initialRun;
    const originalVerify = AcceptanceVerifier.prototype.verify;
    let verificationCalls = 0;
    vi.spyOn(AcceptanceVerifier.prototype, "verify").mockImplementation(function (args) {
      verificationCalls += 1;
      if (verificationCalls === 3) {
        return Promise.reject(new Error("final verification infrastructure failed"));
      }
      return originalVerify.call(this, args);
    });

    await expect(runPipeline(repo, spec, deps))
      .rejects.toThrow("final verification infrastructure failed");

    const store = new ArtifactStore(runId);
    await expect(store.readResult()).resolves.toMatchObject({
      status: "failed",
      failure: "verification-failure",
      candidate: expect.any(Object),
    });
    await expect(readFile(
      path.join(store.runDirectory, "pipeline-active.json"),
      "utf8",
    )).rejects.toMatchObject({ code: "ENOENT" });
  }, 120_000);

  it("salvages the reviewed composed candidate when the fixer role fails", async () => {
    const repo = await initSlicedRepo();
    const runId = "pipeline-slices-composed-fixer-failure";
    const spec = slicedSpec();
    const initialRun = fakeAttempt(runId, async checkout => {
      await writeFile(path.join(checkout, "slice-one.txt"), "slice one candidate\n");
    });
    const deps = dependencies({
      runId,
      roleRunner: async args => {
        if (args.role === "implementer") {
          const candidateCommit = await commitRoleFile(
            args,
            "slice-two.txt",
            "slice two candidate\n",
          );
          return success(fenced({
            reportVersion: "1",
            candidateCommit,
            status: "complete",
            summary: "slice complete",
          }));
        }
        if (args.role === "reviewer-correctness") return success(fenced(blocker));
        if (args.role === "fixer") {
          return {
            ok: false,
            rawOutput: "",
            failure: "timeout",
            producerId: "stub",
          };
        }
        throw new Error(`unexpected role ${args.role}`);
      },
    });
    deps.runAttempt = initialRun;

    const result = await runPipeline(repo, spec, deps);

    // The fix never landed, so these are the last reviewed bytes; the blocking
    // finding is what the human decides on, not a reason to destroy the work.
    expect(result).toMatchObject({
      status: "human-decision-required",
      failure: null,
      attempt: { status: "verified-candidate", failure: null },
    });
    expect(result.attempt.candidate).not.toBeNull();
    expect(result.gate.reasons[0]).toContain("fix phase");
    await expectRefPresent(repo, `refs/claude-architect/candidates/${runId}`);
  }, 120_000);

  it("runs a completed increment, redacts and archives it, then reviews its diff", async () => {
    const repo = await initRepo();
    registerSecretValue("increment-secret-value");
    let reviewedDiff = "";
    const roleRunner = incrementRoleRunner(async args => {
      const commit = await commitIncrement(args, "increment complete\n");
      return success(fenced({
        reportVersion: "1",
        candidateCommit: commit,
        status: "complete",
        summary: "completed with increment-secret-value",
      }));
    });
    const observingRunner = async (args: RoleRunArgs): Promise<RoleRunResult> => {
      if (args.role === "reviewer-correctness") reviewedDiff = args.pkg.candidateDiff;
      return roleRunner(args);
    };

    const result = await runPipeline(
      repo,
      implementationSpec(3),
      dependencies({ runId: "pipeline-increment-complete", roleRunner: observingRunner }),
    );

    expect(result.status).toBe("decision-ready");
    expect(result.gate).toEqual({
      decisionReady: true,
      requiresHumanDecision: false,
      reasons: [],
    });
    expect(result.increments).toHaveLength(1);
    expect(result.increments[0]).toMatchObject({
      increment: 2,
      report: { status: "complete", summary: "completed with [s]" },
      roleLogRefs: ["logs/role-implementer-increment2.log"],
    });
    expect(reviewedDiff).toContain("increment complete");
    const store = new ArtifactStore("pipeline-increment-complete");
    await expect(store.readPipelineArtifact("increment-2"))
      .resolves.toMatchObject({ status: "complete", summary: "completed with [s]" });
    expect(delegatePipelineOutput.parse({ ok: true, result })).toMatchObject({
      result: { increments: [{ increment: 2, report: { status: "complete" } }] },
    });
    expect(delegatePipelineOutput.parse({ ok: true, result: { ...result, increments: [] } }))
      .toMatchObject({ result: { increments: [] } });
    // The wire schema must carry the sliced-pipeline fields through, not strip them.
    const parsed = delegatePipelineOutput.parse({ ok: true, result });
    expect(parsed.result).toHaveProperty("slices", []);
    expect(parsed.result).toHaveProperty("haltedSliceIndex", null);
    const sliced = delegatePipelineOutput.parse({
      ok: true,
      result: { ...result, slices: [{ index: 1, route: "advance" }], haltedSliceIndex: 2 },
    });
    expect(sliced.result?.slices).toEqual([{ index: 1, route: "advance" }]);
    expect(sliced.result?.haltedSliceIndex).toBe(2);
  }, 120_000);

  it("exhausts the increment budget after continued real progress and still reviews", async () => {
    const repo = await initRepo();
    let reviewerCalls = 0;
    const scripted = incrementRoleRunner(async (args, call) => {
      const commit = await commitIncrement(args, `increment ${call}\n`);
      return success(fenced({
        reportVersion: "1",
        candidateCommit: commit,
        status: "continue",
        summary: `increment ${call}`,
        nextSteps: "continue",
      }));
    });
    const roleRunner = async (args: RoleRunArgs): Promise<RoleRunResult> => {
      if (args.role === "reviewer-correctness") reviewerCalls += 1;
      return scripted(args);
    };

    const result = await runPipeline(
      repo,
      implementationSpec(3),
      dependencies({ runId: "pipeline-increment-budget", roleRunner }),
    );

    expect(result.increments).toHaveLength(2);
    expect(result.increments.map(entry => entry.increment)).toEqual([2, 3]);
    expect(reviewerCalls).toBe(1);
    expect(result.status).toBe("human-decision-required");
    expect(result.gate).toMatchObject({
      decisionReady: false,
      requiresHumanDecision: true,
      reasons: ["increment loop ended 'budget-exhausted' without completion"],
    });
  }, 120_000);

  it("stops incrementing when blocked and still reviews", async () => {
    const repo = await initRepo();
    let reviewerCalls = 0;
    const scripted = incrementRoleRunner(async args => success(fenced({
      reportVersion: "1",
      candidateCommit: args.pkg.candidateCommit,
      status: "blocked",
      summary: "blocked by unavailable input",
      blockers: "input unavailable",
    })));
    const roleRunner = async (args: RoleRunArgs): Promise<RoleRunResult> => {
      if (args.role === "reviewer-correctness") reviewerCalls += 1;
      return scripted(args);
    };

    const result = await runPipeline(
      repo,
      implementationSpec(4),
      dependencies({ runId: "pipeline-increment-blocked", roleRunner }),
    );

    expect(result.increments).toHaveLength(1);
    expect(result.increments[0]?.report.status).toBe("blocked");
    expect(reviewerCalls).toBe(1);
    expect(result.status).toBe("human-decision-required");
    expect(result.gate).toMatchObject({
      decisionReady: false,
      requiresHumanDecision: true,
      reasons: ["increment loop ended 'blocked' without completion"],
    });
  }, 120_000);

  it("treats an allow-empty continuing increment as stalled", async () => {
    const repo = await initRepo();
    const roleRunner = incrementRoleRunner(async (args, call) => {
      const commit = await commitIncrement(
        args,
        call === 1 ? "real progress\n" : "",
        call === 2,
      );
      return success(fenced({
        reportVersion: "1",
        candidateCommit: commit,
        status: "continue",
        summary: `increment ${call}`,
        nextSteps: "continue",
      }));
    });

    const result = await runPipeline(
      repo,
      implementationSpec(3),
      dependencies({ runId: "pipeline-increment-stalled", roleRunner }),
    );

    expect(result.increments).toHaveLength(2);
    expect(result.increments.map(entry => entry.increment)).toEqual([2, 3]);
    expect(result.status).toBe("human-decision-required");
    expect(result.gate).toMatchObject({
      decisionReady: false,
      requiresHumanDecision: true,
      reasons: ["increment loop ended 'stalled' without completion"],
    });
    const store = new ArtifactStore("pipeline-increment-stalled");
    await expect(store.readPipelineArtifact("increment-2"))
      .resolves.toMatchObject({ summary: "increment 1" });
    await expect(store.readPipelineArtifact("increment-3"))
      .resolves.toMatchObject({ summary: "increment 2" });
  }, 120_000);

  it("preserves completed increments when a later implementer role fails", async () => {
    const repo = await initRepo();
    const roleRunner = incrementRoleRunner(async (args, call) => {
      if (call === 2) {
        return {
          ok: false,
          rawOutput: "",
          failure: "timeout",
          producerId: "stub",
        };
      }
      const commit = await commitIncrement(args, "first increment\n");
      return success(fenced({
        reportVersion: "1",
        candidateCommit: commit,
        status: "continue",
        summary: "first increment",
        nextSteps: "continue",
      }));
    });

    const result = await runPipeline(
      repo,
      implementationSpec(3),
      dependencies({ runId: "pipeline-increment-role-failure", roleRunner }),
    );

    expect(result.status).toBe("failed");
    expect(result.failure).toBe("timeout");
    expect(result.increments).toHaveLength(1);
    expect(result.gate.reasons[0]).toContain("logs/role-implementer-increment3.log");
  }, 120_000);

  it("stops instead of launching the next increment once cancelled", async () => {
    // A cancellation landing between Producer runs previously did nothing: the
    // loop launched the next increment regardless, so a caller who gave up on a
    // run kept paying for Producers it no longer wanted.
    const repo = await initRepo();
    const controller = new AbortController();
    const roles: string[] = [];
    const roleRunner = incrementRoleRunner(async (args, _call) => {
      roles.push(args.role);
      return success(fenced({
        reportVersion: "1",
        candidateCommit: "c".repeat(40),
        status: "complete",
        summary: "should never run",
      }));
    });
    const deps = dependencies({
      runId: "pipeline-cancelled-increment",
      roleRunner,
      edit: async repoPath => {
        await writeFile(path.join(repoPath, "a.txt"), "candidate\n");
        controller.abort();
      },
    });
    deps.abortSignal = controller.signal;

    const result = await runPipeline(repo, implementationSpec(2), deps);

    expect(result.status).toBe("failed");
    expect(result.failure).toBe("cancelled");
    expect(result.gate.reasons[0]).toContain("cancelled before increment 2");
    expect(roles).toEqual([]);
  }, 120_000);

  it("fails invalid increment output after one archived repair", async () => {
    const repo = await initRepo();
    const roleRunner = incrementRoleRunner(async (_args, call) =>
      success(call === 1 ? "not json" : "still not json"));

    const result = await runPipeline(
      repo,
      implementationSpec(2),
      dependencies({ runId: "pipeline-increment-invalid", roleRunner }),
    );

    expect(result.status).toBe("failed");
    expect(result.failure).toBe("invalid-output");
    expect(result.increments).toEqual([]);
    expect(result.gate.reasons[0]).toContain("logs/role-implementer-increment2.log");
    const store = new ArtifactStore("pipeline-increment-invalid");
    await expect(readFile(
      path.join(store.runDirectory, "logs", "role-implementer-increment2-repair.log"),
      "utf8",
    )).resolves.toBe("still not json");
  }, 120_000);

  it("fails closed when an increment leaves the worktree dirty", async () => {
    const repo = await initRepo();
    const roleRunner = incrementRoleRunner(async args => {
      const commit = await commitIncrement(args, "committed increment\n");
      await writeFile(path.join(args.worktreePath, "dirty.txt"), "uncommitted\n");
      return success(fenced({
        reportVersion: "1",
        candidateCommit: commit,
        status: "complete",
        summary: "complete",
      }));
    });

    const result = await runPipeline(
      repo,
      implementationSpec(2),
      dependencies({ runId: "pipeline-increment-dirty", roleRunner }),
    );

    expect(result.status).toBe("failed");
    expect(result.failure).toBe("sandbox-violation");
    expect(result.increments).toEqual([]);
  }, 120_000);

  it("rejects an increment report whose candidate does not match worktree HEAD", async () => {
    const repo = await initRepo();
    let reviewerCalls = 0;
    const scripted = incrementRoleRunner(async args => {
      await commitIncrement(args, "real\n");
      return success(fenced({
        reportVersion: "1",
        candidateCommit: args.pkg.candidateCommit,
        status: "complete",
        summary: "reported the stale candidate",
      }));
    });
    const roleRunner = async (args: RoleRunArgs): Promise<RoleRunResult> => {
      if (args.role === "reviewer-correctness") {
        reviewerCalls += 1;
        throw new Error("reviewer must not run after increment provenance failure");
      }
      return scripted(args);
    };

    const result = await runPipeline(
      repo,
      implementationSpec(2),
      dependencies({ runId: "pipeline-increment-head-mismatch", roleRunner }),
    );

    expect(result.status).toBe("failed");
    expect(result.failure).toBe("producer-failure");
    expect(result.gate.reasons).toContain(
      "fix phase reported a candidate commit that does not match its worktree HEAD",
    );
    expect(result.increments).toEqual([]);
    expect(result.finalCandidateCommit).toBe(result.attempt.candidate?.candidateCommitOid);
    expect(reviewerCalls).toBe(0);
  }, 120_000);

  it("rejects an increment report whose candidate commit does not exist", async () => {
    const repo = await initRepo();
    let reviewerCalls = 0;
    const scripted = incrementRoleRunner(async () => success(fenced({
      reportVersion: "1",
      candidateCommit: "d".repeat(40),
      status: "complete",
      summary: "reported a nonexistent candidate",
    })));
    const roleRunner = async (args: RoleRunArgs): Promise<RoleRunResult> => {
      if (args.role === "reviewer-correctness") {
        reviewerCalls += 1;
        throw new Error("reviewer must not run after increment provenance failure");
      }
      return scripted(args);
    };

    const result = await runPipeline(
      repo,
      implementationSpec(2),
      dependencies({ runId: "pipeline-increment-missing", roleRunner }),
    );

    expect(result.status).toBe("failed");
    expect(result.failure).toBe("producer-failure");
    expect(result.gate.reasons).toContain("fix phase reported a missing candidate commit");
    expect(result.increments).toEqual([]);
    expect(result.finalCandidateCommit).toBe(result.attempt.candidate?.candidateCommitOid);
    expect(reviewerCalls).toBe(0);
  }, 120_000);

  it("rejects an increment HEAD that is not descended from the reviewed candidate", async () => {
    const repo = await initRepo();
    let reviewerCalls = 0;
    const scripted = incrementRoleRunner(async args => {
      if (args.gitObjectAccess === undefined) {
        throw new Error("implementer git object isolation is missing");
      }
      const env = {
        GIT_OBJECT_DIRECTORY: args.gitObjectAccess.privateObjectsDir,
        GIT_ALTERNATE_OBJECT_DIRECTORIES: args.gitObjectAccess.sharedObjectsDir,
      };
      const baselineTree = await runGit(
        args.worktreePath,
        ["rev-parse", `${args.pkg.baselineCommit}^{tree}`],
        env,
      );
      const sibling = await runGit(args.worktreePath, [
        "commit-tree",
        baselineTree,
        "-p",
        args.pkg.baselineCommit,
        "-m",
        "discard reviewed candidate",
      ], env);
      await runGit(args.worktreePath, [
        "update-ref",
        "HEAD",
        sibling,
        args.pkg.candidateCommit,
      ], env);
      return success(fenced({
        reportVersion: "1",
        candidateCommit: sibling,
        status: "complete",
        summary: "replaced the reviewed lineage",
      }));
    });
    const roleRunner = async (args: RoleRunArgs): Promise<RoleRunResult> => {
      if (args.role === "reviewer-correctness") {
        reviewerCalls += 1;
        throw new Error("reviewer must not run after increment provenance failure");
      }
      return scripted(args);
    };

    const result = await runPipeline(
      repo,
      implementationSpec(2),
      dependencies({ runId: "pipeline-increment-sibling", roleRunner }),
    );

    expect(result.status).toBe("failed");
    expect(result.failure).toBe("sandbox-violation");
    expect(result.gate.reasons).toContain(
      "fix phase candidate commit is not descended from the reviewed candidate",
    );
    expect(result.increments).toEqual([]);
    expect(result.finalCandidateCommit).toBe(result.attempt.candidate?.candidateCommitOid);
    expect(reviewerCalls).toBe(0);
  }, 120_000);

  it("fails closed without review when implementer confinement is unavailable", async () => {
    const repo = await initRepo();
    let reviewerCalls = 0;
    const scripted = incrementRoleRunner(async () => ({
      ok: false,
      rawOutput: "",
      failure: "sandbox-violation",
      producerId: "stub",
    }));
    const roleRunner = async (args: RoleRunArgs): Promise<RoleRunResult> => {
      if (args.role === "reviewer-correctness") {
        reviewerCalls += 1;
        throw new Error("reviewer must not run after implementer confinement failure");
      }
      return scripted(args);
    };

    const result = await runPipeline(
      repo,
      implementationSpec(2),
      dependencies({ runId: "pipeline-increment-no-confinement", roleRunner }),
    );

    expect(result.status).toBe("failed");
    expect(result.failure).toBe("sandbox-violation");
    expect(result.increments).toEqual([]);
    expect(reviewerCalls).toBe(0);
  }, 120_000);

  it("stops before dispatching another increment when only the commit oid changes", async () => {
    const repo = await initRepo();
    let implementerCalls = 0;
    const roleRunner = incrementRoleRunner(async (args, call) => {
      implementerCalls += 1;
      const commit = await commitIncrement(
        args,
        call === 1 ? "real progress\n" : "",
        call === 2,
      );
      return success(fenced({
        reportVersion: "1",
        candidateCommit: commit,
        status: "continue",
        summary: `increment ${call}`,
        nextSteps: "continue",
      }));
    });

    const result = await runPipeline(
      repo,
      implementationSpec(4),
      dependencies({ runId: "pipeline-increment-tree-progress", roleRunner }),
    );

    expect(result.increments.map(entry => entry.increment)).toEqual([2, 3]);
    expect(implementerCalls).toBe(2);
  }, 120_000);

  it("redacts increment secrets from archives, progress notes, and results", async () => {
    const repo = await initRepo();
    const runId = "pipeline-increment-secret-hygiene";
    const secret = "increment-secret-XYZ";
    registerSecretValue(secret);
    let incrementThreeProgress = "";
    const roleRunner = incrementRoleRunner(async (args, call) => {
      if (call === 2) incrementThreeProgress = args.pkg.progress ?? "";
      const commit = await commitIncrement(args, `secret progress ${call}\n`);
      return success(fenced({
        reportVersion: "1",
        candidateCommit: commit,
        status: call === 1 ? "continue" : "complete",
        summary: call === 1 ? `summary ${secret}` : "complete",
        ...(call === 1 ? { nextSteps: `next ${secret}` } : {}),
      }));
    });

    const result = await runPipeline(
      repo,
      implementationSpec(3),
      dependencies({ runId, roleRunner }),
    );

    const store = new ArtifactStore(runId);
    const archived = await store.readPipelineArtifact<IncrementReport>("increment-2");
    expect(archived?.summary).not.toContain(secret);
    expect(archived?.summary).toContain("[s]");
    expect(incrementThreeProgress).not.toContain(secret);
    expect(JSON.stringify(result)).not.toContain(secret);
  }, 120_000);

  it("passes only the immediately previous increment as progress", async () => {
    const repo = await initRepo();
    let incrementFourProgress = "";
    const roleRunner = incrementRoleRunner(async (args, call) => {
      if (call === 3) incrementFourProgress = args.pkg.progress ?? "";
      const commit = await commitIncrement(args, `progress ${call}\n`);
      return success(fenced({
        reportVersion: "1",
        candidateCommit: commit,
        status: "continue",
        summary: call === 1 ? "INCREMENT_TWO_MARKER" : `increment ${call + 1}`,
        nextSteps: call === 2 ? "INCREMENT_THREE_MARKER" : "continue",
      }));
    });

    const result = await runPipeline(
      repo,
      implementationSpec(4),
      dependencies({ runId: "pipeline-increment-progress", roleRunner }),
    );

    expect(result.increments).toHaveLength(3);
    expect(incrementFourProgress).toContain("INCREMENT_THREE_MARKER");
    expect(incrementFourProgress).not.toContain("INCREMENT_TWO_MARKER");
  }, 120_000);

  it("does not invoke an implementer without an implementation block", async () => {
    const repo = await initRepo();
    const roles: string[] = [];
    const roleRunner = async (args: RoleRunArgs): Promise<RoleRunResult> => {
      roles.push(args.role);
      if (args.role === "reviewer-correctness") return success(fenced(approve));
      throw new Error(`unexpected role ${args.role}`);
    };

    const result = await runPipeline(
      repo,
      validSpec({ reviewers: ["correctness"], maxRounds: 1 }),
      dependencies({ runId: "pipeline-no-increments", roleRunner }),
    );

    expect(result.increments).toEqual([]);
    expect(roles).toEqual(["reviewer-correctness"]);
    const preIncrementGate = {
      decisionReady: true,
      requiresHumanDecision: false,
      reasons: [],
    };
    expect(result.status).toBe("decision-ready");
    expect(JSON.stringify(result.gate)).toBe(JSON.stringify(preIncrementGate));
  }, 120_000);

  it("preserves and skips a terminal run recovered after an increment archive", async () => {
    const repo = await initRepo();
    const runId = "pipeline-increment-crash";
    const baselineCommit = await runGit(repo, ["rev-parse", "HEAD"]);
    await writeFile(path.join(repo, "a.txt"), "candidate before crash\n");
    await runGit(repo, ["add", "a.txt"]);
    await runGit(repo, ["commit", "-q", "-m", "candidate before crash"]);
    const candidateCommit = await runGit(repo, ["rev-parse", "HEAD"]);
    const candidate = await artifactFor(repo, runId, baselineCommit, candidateCommit);
    const store = new ArtifactStore(runId);
    await store.writeResult(attemptResult(runId, candidate));
    const canonicalCommonDir = await realpath(path.join(repo, ".git"));
    const lockKey = createHash("sha256").update(canonicalCommonDir).digest("hex");
    const writerPid = 424_242;
    await writeFile(path.join(store.runDirectory, "run-start.json"), `${JSON.stringify({
      runId,
      lockKey,
      canonicalCommonDir,
      pid: writerPid,
      processToken: null,
      startedAt: "2026-07-18T12:00:00.000Z",
    })}\n`);
    await new WorktreeManager(
      repo,
      `${runId}-pipeline`,
      getPlatformServices(),
    ).create(candidateCommit);
    await store.writePipelineArtifact("increment-2", {
      reportVersion: "1",
      candidateCommit,
      status: "continue",
      summary: "increment two",
    });
    const terminated: number[] = [];

    const recovery = await recoverStaleRuns({
      platformServices: {
        os: "darwin",
        async getProcessStartToken() { return null; },
        async terminateProcessTreeByPid(pid) { terminated.push(pid); },
      },
      isProcessAlive: () => false,
    });

    expect(recovery).toEqual({ recovered: [], quarantined: [] });
    expect(terminated).toEqual([]);
    await expect(store.readResult()).resolves.toMatchObject({
      status: "verified-candidate",
    });
    const anchor = await git(repo, [
      "rev-parse",
      "--verify",
      "--quiet",
      `refs/claude-architect/candidates/${runId}^{commit}`,
    ]);
    expect(anchor.exitCode, anchor.stderr).toBe(0);
    expect(anchor.stdout.trim()).toBe(candidateCommit);
    await expect(store.readPipelineArtifact("increment-2"))
      .resolves.toMatchObject({ summary: "increment two" });
  }, 120_000);

  it("returns decision-ready after a clean review round without fixing", async () => {
    const repo = await initRepo();
    const runId = "pipeline-clean";
    const store = new ArtifactStore(runId);
    const spec = validSpec();
    const markerPath = path.join(store.runDirectory, "pipeline-active.json");
    const baseRoleRunner = roundReviews(
      [{ correctness: approve, systems: approve }],
      async () => { throw new Error("fixer must not run"); },
    );
    let markerObserved = false;
    const roleRunner = async (args: RoleRunArgs): Promise<RoleRunResult> => {
      const marker = JSON.parse(await readFile(markerPath, "utf8")) as {
        pid?: unknown;
        sliced?: unknown;
      };
      expect(marker.pid).toBe(process.pid);
      expect(marker.sliced).toBe(false);
      markerObserved = true;
      return baseRoleRunner(args);
    };

    const result = await runPipeline(
      repo,
      spec,
      dependencies({ runId, roleRunner }),
    );

    expect(result.status).toBe("decision-ready");
    expect(result.slices).toEqual([]);
    expect(result.haltedSliceIndex).toBeNull();
    expect(markerObserved).toBe(true);
    await expect(readFile(markerPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(result.rounds).toHaveLength(1);
    expect(result.rounds[0]?.fix).toBeNull();
    expect(result.rounds[0]?.roleLogRefs).toEqual([
      "logs/role-reviewer-correctness-round1.log",
      "logs/role-reviewer-systems-round1.log",
    ]);
    await expect(store.readPipelineArtifact("delegation-spec")).resolves.toEqual(spec);
    await expect(readFile(
      path.join(store.runDirectory, "logs", "role-reviewer-correctness-round1.log"),
      "utf8",
    )).resolves.toBe(fenced(approve));
    await expect(readFile(
      path.join(store.runDirectory, "logs", "role-reviewer-systems-round1.log"),
      "utf8",
    )).resolves.toBe(fenced(approve));
  }, 120_000);

  it("reports the candidate identity when gate clearance cannot be archived", async () => {
    const repo = await initRepo();
    const runId = "pipeline-clearance-archive-missing";
    const store = new ArtifactStore(runId);
    const baseRoleRunner = roundReviews(
      [{ correctness: approve, systems: approve }],
      async () => { throw new Error("fixer must not run"); },
    );
    const roleRunner = async (args: RoleRunArgs): Promise<RoleRunResult> => {
      const result = await baseRoleRunner(args);
      if (args.role === "reviewer-systems") {
        await rm(path.join(store.runDirectory, "manifest.json"));
      }
      return result;
    };

    let thrown: unknown;
    try {
      await runPipeline(
        repo,
        validSpec(),
        dependencies({
          runId,
          roleRunner,
        }),
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toMatchObject({
      name: "RuntimeError",
      message: "pipeline gate cleared the candidate and the clearance could not be archived",
      detail: {
        candidateCommitOid: expect.stringMatching(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u),
        requiresHumanDecision: false,
      },
    });
  }, 120_000);

  it("fixes a blocker and returns decision-ready after a clean re-review", async () => {
    const repo = await initRepo();
    let privateObjectsDir = "";
    const roleRunner = roundReviews([
      { correctness: blocker, systems: approve },
      { correctness: approve, systems: approve },
    ], async args => {
      privateObjectsDir = args.gitObjectAccess?.privateObjectsDir ?? "";
      const commit = await commitFix(args, "fixed\n");
      return success(fenced({
        reportVersion: "1",
        candidateCommit: commit,
        dispositions: [{
          findingId: "F-001",
          disposition: "fixed",
          evidence: "Committed the requested correction.",
          commit,
        }],
      }));
    });

    const result = await runPipeline(
      repo,
      validSpec(),
      dependencies({ runId: "pipeline-fixed", roleRunner }),
    );

    expect(result.status).toBe("decision-ready");
    expect(result.rounds).toHaveLength(2);
    expect(result.rounds[0]?.roleLogRefs).toContain("logs/role-fixer-round1.log");
    expect(privateObjectsDir).not.toBe("");
    expect((await git(repo, [
      "cat-file",
      "-e",
      `${result.finalCandidateCommit}^{commit}`,
    ])).exitCode).toBe(0);
    expect(await runGit(repo, ["show", `${result.finalCandidateCommit}:a.txt`])).toBe("fixed");
    const promotedArtifact = result.attempt.candidate;
    expect(promotedArtifact).not.toBeNull();
    if (promotedArtifact === null) return;
    const checkoutHead = await runGit(repo, ["rev-parse", "HEAD"]);
    await writeFile(path.join(repo, "a.txt"), "base\n");
    await runGit(repo, ["add", "a.txt"]);
    await runGit(repo, [
      "update-ref",
      "HEAD",
      promotedArtifact.baseCommitOid,
      checkoutHead,
    ]);
    await expect(applyCandidateTree({
      repoRoot: repo,
      artifact: promotedArtifact,
      expectedArtifactHash: promotedArtifact.manifestHash,
    })).resolves.toMatchObject({ integration: "applied" });
    await expect(readFile(path.join(repo, "a.txt"), "utf8")).resolves.toBe("fixed\n");
  }, 120_000);

  it("emits ordered pipeline-stage progress phases across review and fix rounds", async () => {
    const repo = await initRepo();
    const roleRunner = roundReviews([
      { correctness: blocker, systems: approve },
      { correctness: approve, systems: approve },
    ], async args => {
      const commit = await commitFix(args, "fixed\n");
      return success(fenced({
        reportVersion: "1",
        candidateCommit: commit,
        dispositions: [{
          findingId: "F-001",
          disposition: "fixed",
          evidence: "Committed the requested correction.",
          commit,
        }],
      }));
    });

    const phases: string[] = [];
    const result = await runPipeline(repo, validSpec(), {
      ...dependencies({ runId: "pipeline-phases", roleRunner }),
      onPhase: phase => phases.push(phase),
    });

    expect(result.status).toBe("decision-ready");
    expect(phases).toEqual([
      "review round 1/2",
      "round 1: applying fixes",
      "review round 2/2",
      "final verification",
      "evaluating gate",
      // Terminal, so a reader can tell a finished pipeline from a wedged one.
      "finished: decision-ready",
    ]);
  });

  it("never lets a throwing progress callback affect pipeline control flow", async () => {
    const repo = await initRepo();
    const roleRunner = roundReviews([
      { correctness: approve, systems: approve },
    ], async () => {
      throw new Error("fixer must not run after a clean first round");
    });

    const result = await runPipeline(repo, validSpec(), {
      ...dependencies({ runId: "pipeline-phase-throw", roleRunner }),
      onPhase: () => { throw new Error("progress sink boom"); },
    });

    expect(result.status).toBe("decision-ready");
    expect(result.rounds).toHaveLength(1);
  });

  it.each([
    {
      state: "tracked-file modification",
      dirtyWorktree: async (args: RoleRunArgs): Promise<void> => {
        await writeFile(path.join(args.worktreePath, "a.txt"), "uncommitted\n");
      },
    },
    {
      state: "staged change",
      dirtyWorktree: async (args: RoleRunArgs): Promise<void> => {
        if (args.gitObjectAccess === undefined) {
          throw new Error("fixer git object isolation is missing");
        }
        await writeFile(path.join(args.worktreePath, "a.txt"), "staged\n");
        await runGit(args.worktreePath, ["add", "a.txt"], {
          GIT_OBJECT_DIRECTORY: args.gitObjectAccess.privateObjectsDir,
          GIT_ALTERNATE_OBJECT_DIRECTORIES: args.gitObjectAccess.sharedObjectsDir,
        });
      },
    },
    {
      state: "untracked file",
      dirtyWorktree: async (args: RoleRunArgs): Promise<void> => {
        await writeFile(path.join(args.worktreePath, "untracked.txt"), "uncommitted\n");
      },
    },
  ])("rejects fixer provenance with a $state", async ({ state, dirtyWorktree }) => {
    const repo = await initRepo();
    const roleRunner = roundReviews([
      { correctness: blocker, systems: approve },
    ], async args => {
      const commit = await commitFix(args, "fixed\n");
      await dirtyWorktree(args);
      return success(fenced({
        reportVersion: "1",
        candidateCommit: commit,
        dispositions: [{
          findingId: "F-001",
          disposition: "fixed",
          evidence: "Committed the requested correction.",
          commit,
        }],
      }));
    });

    const result = await runPipeline(
      repo,
      validSpec(),
      dependencies({ runId: `pipeline-fix-dirty-${state.replaceAll(" ", "-")}`, roleRunner }),
    );

    expect(result.status).toBe("failed");
    expect(result.failure).toBe("sandbox-violation");
    expect(result.gate.reasons).toContain(
      "fix phase candidate worktree contains uncommitted state",
    );
  });

  it("fails closed when fixer worktree cleanliness cannot be read", async () => {
    const repo = await initRepo();
    const roleRunner = roundReviews([
      { correctness: blocker, systems: approve },
    ], async args => {
      if (args.gitObjectAccess === undefined) {
        throw new Error("fixer git object isolation is missing");
      }
      const commit = await commitFix(args, "fixed\n");
      const env = {
        GIT_OBJECT_DIRECTORY: args.gitObjectAccess.privateObjectsDir,
        GIT_ALTERNATE_OBJECT_DIRECTORIES: args.gitObjectAccess.sharedObjectsDir,
      };
      const indexPath = path.resolve(
        args.worktreePath,
        await runGit(args.worktreePath, ["rev-parse", "--git-path", "index"], env),
      );
      await rm(indexPath);
      await mkdir(indexPath);
      return success(fenced({
        reportVersion: "1",
        candidateCommit: commit,
        dispositions: [{
          findingId: "F-001",
          disposition: "fixed",
          evidence: "Committed the requested correction.",
          commit,
        }],
      }));
    });

    const result = await runPipeline(
      repo,
      validSpec(),
      dependencies({ runId: "pipeline-fix-status-failure", roleRunner }),
    );

    expect(result.status).toBe("failed");
    expect(result.failure).toBe("sandbox-violation");
    expect(result.gate.reasons).toContain(
      "fix phase candidate worktree cleanliness could not be verified",
    );
  });

  it("validates fixer provenance through private objects before promotion", async () => {
    const repo = await initRepo();
    let privateCommit = "";
    const roleRunner = roundReviews([
      { correctness: blocker, systems: approve },
      { correctness: approve, systems: approve },
    ], async args => {
      privateCommit = await commitFix(args, "private-fixed\n");
      expect((await git(repo, [
        "cat-file",
        "-e",
        `${privateCommit}^{commit}`,
      ])).exitCode).not.toBe(0);
      return success(fenced({
        reportVersion: "1",
        candidateCommit: privateCommit,
        dispositions: [{
          findingId: "F-001",
          disposition: "fixed",
          evidence: "Committed the requested correction.",
          commit: privateCommit,
        }],
      }));
    });

    const result = await runPipeline(
      repo,
      validSpec(),
      dependencies({ runId: "pipeline-fix-private-provenance", roleRunner }),
    );

    expect(privateCommit).not.toBe("");
    expect(result.status).toBe("decision-ready");
    expect((await git(repo, [
      "cat-file",
      "-e",
      `${result.finalCandidateCommit}^{commit}`,
    ])).exitCode).toBe(0);
    expect(await runGit(repo, ["show", `${result.finalCandidateCommit}:a.txt`]))
      .toBe("private-fixed");
  });

  it("rejects a fixer report whose candidate does not match worktree HEAD", async () => {
    const repo = await initRepo();
    const roleRunner = roundReviews([
      { correctness: blocker, systems: approve },
    ], async args => {
      const reportedCommit = args.pkg.candidateCommit;
      await commitFix(args, "unreported-head\n");
      return success(fenced({
        reportVersion: "1",
        candidateCommit: reportedCommit,
        dispositions: [{
          findingId: "F-001",
          disposition: "fixed",
          evidence: "Claimed the old candidate instead of the produced HEAD.",
          commit: reportedCommit,
        }],
      }));
    });

    const result = await runPipeline(
      repo,
      validSpec(),
      dependencies({ runId: "pipeline-fix-head-mismatch", roleRunner }),
    );

    expect(result.status).toBe("failed");
    expect(result.failure).toBe("producer-failure");
    expect(result.gate.reasons).toContain(
      "fix phase reported a candidate commit that does not match its worktree HEAD",
    );
    expect(result.finalCandidateCommit).toBe(result.attempt.candidate?.candidateCommitOid);
  });

  it("rejects a fixer HEAD that is not descended from the reviewed candidate", async () => {
    const repo = await initRepo();
    const roleRunner = roundReviews([
      { correctness: blocker, systems: approve },
    ], async args => {
      if (args.gitObjectAccess === undefined) {
        throw new Error("fixer git object isolation is missing");
      }
      const env = {
        GIT_OBJECT_DIRECTORY: args.gitObjectAccess.privateObjectsDir,
        GIT_ALTERNATE_OBJECT_DIRECTORIES: args.gitObjectAccess.sharedObjectsDir,
      };
      const baselineTree = await runGit(
        args.worktreePath,
        ["rev-parse", `${args.pkg.baselineCommit}^{tree}`],
        env,
      );
      const sibling = await runGit(args.worktreePath, [
        "commit-tree",
        baselineTree,
        "-p",
        args.pkg.baselineCommit,
        "-m",
        "discard reviewed candidate",
      ], env);
      await runGit(args.worktreePath, [
        "update-ref",
        "HEAD",
        sibling,
        args.pkg.candidateCommit,
      ], env);
      return success(fenced({
        reportVersion: "1",
        candidateCommit: sibling,
        dispositions: [{
          findingId: "F-001",
          disposition: "fixed",
          evidence: "Replaced the reviewed lineage.",
          commit: sibling,
        }],
      }));
    });

    const result = await runPipeline(
      repo,
      validSpec(),
      dependencies({ runId: "pipeline-fix-sibling", roleRunner }),
    );

    expect(result.status).toBe("failed");
    expect(result.failure).toBe("sandbox-violation");
    expect(result.gate.reasons).toContain(
      "fix phase candidate commit is not descended from the reviewed candidate",
    );
    expect(result.finalCandidateCommit).toBe(result.attempt.candidate?.candidateCommitOid);
  });

  it("rejects a fixer disposition that cites a nonexistent commit", async () => {
    const repo = await initRepo();
    const roleRunner = roundReviews([
      { correctness: blocker, systems: approve },
    ], async args => {
      const commit = await commitFix(args, "fixed-with-false-evidence\n");
      return success(fenced({
        reportVersion: "1",
        candidateCommit: commit,
        dispositions: [{
          findingId: "F-001",
          disposition: "fixed",
          evidence: "Cited an object that does not exist.",
          commit: "d".repeat(40),
        }],
      }));
    });

    const result = await runPipeline(
      repo,
      validSpec(),
      dependencies({ runId: "pipeline-fix-missing-disposition", roleRunner }),
    );

    expect(result.status).toBe("failed");
    expect(result.failure).toBe("producer-failure");
    expect(result.gate.reasons).toContain(
      "fix phase disposition reported a missing commit object",
    );
  });

  it("requires human decision when the final-round fix was not re-reviewed", async () => {
    const repo = await initRepo();
    const roleRunner = roundReviews([
      { correctness: blocker, systems: approve },
      { correctness: blocker, systems: approve },
    ], async (args, round) => {
      const commit = await commitFix(args, `still-blocked-${round}\n`);
      return success(fenced({
        reportVersion: "1",
        candidateCommit: commit,
        dispositions: [{
          findingId: "F-001",
          disposition: "fixed",
          evidence: "Committed the requested correction.",
          commit,
        }],
      }));
    });

    const result = await runPipeline(
      repo,
      validSpec(),
      dependencies({ runId: "pipeline-capped", roleRunner }),
    );

    expect(result.status).toBe("human-decision-required");
    expect(result.gate.requiresHumanDecision).toBe(true);
    expect(result.gate.reasons).toContain("final fix was not re-reviewed");
    expect(result.rounds.at(-1)?.fix).not.toBeNull();
  });

  function parallelSpec(overrides: {
    sliceTwoCheck: Record<string, string>;
    finalCheck: Record<string, string>;
  }): DelegationSpec {
    const spec = slicedSpec();
    return {
      ...spec,
      sliceConcurrency: 2,
      slices: [
        { ...spec.slices![0]!, dependsOn: [] },
        {
          ...spec.slices![1]!,
          dependsOn: [],
          verification: [fileVerification("slice-two-check", overrides.sliceTwoCheck)],
        },
      ],
      verification: [fileVerification("final-check", overrides.finalCheck)],
    };
  }

  function parallelDeps(runId: string) {
    const deps = dependencies({
      runId,
      roleRunner: async args => {
        if (args.role === "implementer") {
          const commit = await commitRoleFile(args, "slice-two.txt", "slice two candidate\n");
          return success(fenced({
            reportVersion: "1",
            candidateCommit: commit,
            status: "complete",
            summary: "slice complete",
          }));
        }
        if (args.role === "reviewer-correctness") return success(fenced(approve));
        throw new Error(`unexpected role ${args.role}`);
      },
    });
    deps.runAttempt = fakeAttempt(runId, async checkout => {
      await writeFile(path.join(checkout, "slice-one.txt"), "slice one candidate\n");
    });
    return deps;
  }

  it("composes slices that ran in the same wave into one candidate", async () => {
    const repo = await initSlicedRepo();
    const runId = "pipeline-parallel-compose";

    const result = await runPipeline(repo, parallelSpec({
      // Slice two is verified without slice one present, which is exactly what
      // declaring independence means.
      sliceTwoCheck: { "slice-two.txt": "slice two candidate\n" },
      finalCheck: {
        "slice-one.txt": "slice one candidate\n",
        "slice-two.txt": "slice two candidate\n",
      },
    }), parallelDeps(runId));

    expect(result.status).toBe("decision-ready");
    expect(result.slices.map(slice => slice.index)).toEqual([1, 2]);
    const changed = result.attempt.candidate?.changedPaths.map(entry => entry.path) ?? [];
    expect(changed.sort()).toEqual(["slice-one.txt", "slice-two.txt"]);
  }, 180_000);

  it("fails closed when a slice under-declared what it depended on", async () => {
    const repo = await initSlicedRepo();
    const runId = "pipeline-parallel-underdeclared";

    // Both slices pass their own checks against a base that lacks the other's
    // work. Nothing in scheduling can detect an under-declared dependency, so
    // the mandatory verification of the composed tree is the only thing standing
    // between a wrong `dependsOn` and a shipped candidate.
    const result = await runPipeline(repo, parallelSpec({
      sliceTwoCheck: { "slice-two.txt": "slice two candidate\n" },
      finalCheck: { "slice-one.txt": "the composed tree must satisfy this\n" },
    }), parallelDeps(runId));

    expect(result.status).not.toBe("decision-ready");
    expect(result.gate.decisionReady).toBe(false);
    expect(result.gate.reasons.join("\n")).toContain("clean-room verification failed");
  }, 180_000);

  it("keeps the slice outcome when its worktree cannot be cleaned up", async () => {
    const repo = await initSlicedRepo();
    const runId = "pipeline-slice-cleanup-failure";
    const spec = slicedSpec();
    const initialRun = fakeAttempt(runId, async checkout => {
      await writeFile(path.join(checkout, "slice-one.txt"), "slice one candidate\n");
    });
    // Producer test children can outlive their parent and hold the worktree
    // open. Losing the whole slice result to that is finding 16.
    const create = WorktreeManager.prototype.create;
    let failedOnce = false;
    vi.spyOn(WorktreeManager.prototype, "create").mockImplementation(async function (commit) {
      const worktree = await create.call(this, commit);
      if (failedOnce) return worktree;
      failedOnce = true;
      return {
        ...worktree,
        async cleanup() {
          await worktree.cleanup();
          throw new Error("worktree busy");
        },
      };
    });
    const deps = dependencies({
      runId,
      roleRunner: async args => {
        if (args.role === "implementer") {
          const candidateCommit = await commitRoleFile(
            args,
            "slice-two.txt",
            "slice two candidate\n",
          );
          return success(fenced({
            reportVersion: "1",
            candidateCommit,
            status: "complete",
            summary: "slice complete",
          }));
        }
        if (args.role === "reviewer-correctness") return success(fenced(approve));
        throw new Error(`unexpected role ${args.role}`);
      },
    });
    deps.runAttempt = initialRun;

    const result = await runPipeline(repo, spec, deps);

    expect(result.status).toBe("decision-ready");
    expect(result.attempt.candidate).not.toBeNull();
  }, 120_000);

  it("keeps a round whose reviews completed when its fix phase then fails", async () => {
    const repo = await initRepo();
    let reviewed = false;
    const roleRunner = async (args: RoleRunArgs): Promise<RoleRunResult> => {
      if (args.role === "reviewer-correctness") {
        reviewed = true;
        return success(fenced(blocker));
      }
      if (args.role === "fixer") {
        return { ok: false, rawOutput: "", failure: "timeout", producerId: "stub" };
      }
      throw new Error(`unexpected role ${args.role}`);
    };

    const result = await runPipeline(
      repo,
      validSpec({ reviewers: ["correctness"], maxRounds: 1 }),
      dependencies({ runId: "pipeline-round-retained", roleRunner }),
    );

    // Review work already on disk must appear in the result even though the
    // round never reached a fix.
    expect(reviewed).toBe(true);
    expect(result.rounds).toHaveLength(1);
    expect(result.rounds[0]?.round).toBe(1);
    expect(result.rounds[0]?.fix).toBeNull();
    expect(result.rounds[0]?.consolidated.findings).not.toHaveLength(0);
  }, 120_000);

  it("discards the candidate when salvage verification fails", async () => {
    const repo = await initRepo();
    let calls = 0;
    const roleRunner = async (): Promise<RoleRunResult> => {
      calls += 1;
      return success(calls === 1 ? "not json" : "not json either");
    };
    // Salvage must never turn an unverifiable candidate into a decision the
    // human can act on: a red clean room still archives and discards.
    const verify = AcceptanceVerifier.prototype.verify;
    vi.spyOn(AcceptanceVerifier.prototype, "verify").mockImplementation(async function (args) {
      const report = await verify.call(this, args);
      return { ...report, ok: false, failures: ["salvage clean room is red"] };
    });

    const result = await runPipeline(
      repo,
      validSpec({ reviewers: ["correctness"], maxRounds: 1 }),
      dependencies({ runId: "pipeline-salvage-red", roleRunner }),
    );

    expect(result.status).toBe("failed");
    expect(result.failure).toBe("producer-failure");
    expect(result.gate.requiresHumanDecision).toBe(false);
    await expect(handleDecideCandidate(
      repo,
      "pipeline-salvage-red",
      "accepted",
      "0".repeat(64),
    )).resolves.toMatchObject({ ok: false, error: "candidate-not-verified" });
  }, 120_000);

  it("salvages the candidate after invalid reviewer output and one invalid repair", async () => {
    const repo = await initRepo();
    let calls = 0;
    const roleRunner = async (): Promise<RoleRunResult> => {
      calls += 1;
      return success(calls === 1 ? "not json" : "not json either");
    };

    const result = await runPipeline(
      repo,
      validSpec({ reviewers: ["correctness"], maxRounds: 1 }),
      dependencies({ runId: "pipeline-invalid", roleRunner }),
    );

    expect(result.status).toBe("human-decision-required");
    expect(result.attempt.candidate).not.toBeNull();
    expect(result.gate.reasons[0]).toBe(
      "review phase did not produce valid structured output (see logs/role-reviewer-correctness-round1.log)",
    );
    expect(calls).toBe(2);
    const store = new ArtifactStore("pipeline-invalid");
    await expect(readFile(
      path.join(store.runDirectory, "logs", "role-reviewer-correctness-round1.log"),
      "utf8",
    )).resolves.toBe("not json");
    await expect(readFile(
      path.join(store.runDirectory, "logs", "role-reviewer-correctness-round1-repair.log"),
      "utf8",
    )).resolves.toBe("not json either");
    await expect(readFile(
      path.join(store.runDirectory, "pipeline-active.json"),
      "utf8",
    )).rejects.toMatchObject({ code: "ENOENT" });
  }, 120_000);

  it("requires human decision when the candidate adds a skipped test", async () => {
    const repo = await initRepo();
    const spec = validSpec();
    spec.writeAllowlist = ["a.txt", "tests/**"];
    const roleRunner = roundReviews(
      [{ correctness: approve, systems: approve }],
      async () => { throw new Error("fixer must not run"); },
    );
    const edit = async (checkout: string): Promise<void> => {
      await writeFile(path.join(checkout, "a.txt"), "candidate\n");
      await mkdir(path.join(checkout, "tests"));
      await writeFile(path.join(checkout, "tests", "candidate.test.ts"), [
        "it.skip(\"newly skipped\", () => {});",
        "",
      ].join("\n"));
    };

    const result = await runPipeline(
      repo,
      spec,
      dependencies({ runId: "pipeline-weakened", roleRunner, edit }),
    );

    expect(result.status).toBe("human-decision-required");
    expect(result.verification?.testsSkipped).toBeGreaterThan(0);
  });

  it("passes an architect-authorized test deletion and records its evidence", async () => {
    const repo = await initRepo();
    await mkdir(path.join(repo, "tests"));
    await writeFile(path.join(repo, "tests", "obsolete.test.ts"), "it('works', () => {});\n");
    await runGit(repo, ["add", "tests/obsolete.test.ts"]);
    await runGit(repo, [
      "-c",
      "user.name=Claude Architect Test",
      "-c",
      "user.email=claude-architect@example.invalid",
      "commit",
      "-q",
      "-m",
      "add obsolete test",
    ]);
    const spec = validSpec();
    spec.writeAllowlist = ["a.txt", "tests/**"];
    spec.allowedTestDeletions = ["tests/obsolete.test.ts"];
    const roleRunner = roundReviews(
      [{ correctness: approve, systems: approve }],
      async () => { throw new Error("fixer must not run"); },
    );

    const result = await runPipeline(
      repo,
      spec,
      dependencies({
        runId: "pipeline-authorized-test-deletion",
        roleRunner,
        edit: async checkout => {
          await writeFile(path.join(checkout, "a.txt"), "candidate\n");
          await rm(path.join(checkout, "tests", "obsolete.test.ts"));
        },
      }),
    );

    expect(result.status).toBe("decision-ready");
    expect(result.verification?.testsDeleted).toBe(0);
    expect(result.verification?.evidence.authorizedTestDeletions)
      .toEqual(["tests/obsolete.test.ts"]);
  }, 120_000);

  it("persists round and verification artifacts", async () => {
    const repo = await initRepo();
    const runId = "pipeline-artifacts";
    const roleRunner = roundReviews(
      [{ correctness: approve, systems: approve }],
      async () => { throw new Error("fixer must not run"); },
    );

    const result = await runPipeline(repo, validSpec(), dependencies({ runId, roleRunner }));

    expect(result.verification?.evidence).not.toHaveProperty("authorizedTestDeletions");

    const store = new ArtifactStore(runId);
    await expect(store.readPipelineArtifact("round-1-review-correctness"))
      .resolves.toEqual(approve);
    await expect(store.readPipelineArtifact("round-1-review-systems"))
      .resolves.toEqual(approve);
    await expect(store.readPipelineArtifact("round-1-consolidated"))
      .resolves.toMatchObject({ findings: [] });
    const persistedVerification = await store.readPipelineArtifact("verification");
    expect(persistedVerification.evidence).not.toHaveProperty("authorizedTestDeletions");
    expect(persistedVerification)
      .toMatchObject({
        pass: true,
        workspaceClean: true,
        evidence: {
          failures: [],
          commandOutcomes: [{
            stdoutRef: "logs/pipeline-verification-0-stdout.log",
            stderrRef: "logs/pipeline-verification-0-stderr.log",
          }],
        },
      });
    await expect(readFile(
      path.join(store.runDirectory, "logs", "pipeline-verification-0-stdout.log"),
      "utf8",
    )).resolves.toBe("");
    await expect(readFile(
      path.join(store.runDirectory, "logs", "pipeline-verification-0-stderr.log"),
      "utf8",
    )).resolves.toBe("");
    await expect(store.readPipelineArtifact("pipeline-result"))
      .resolves.toMatchObject({ status: "decision-ready", runId });
  });

  it("fails the final gate when every verification command is platform-skipped", async () => {
    const repo = await initRepo();
    const spec = validSpec();
    spec.verification[0] = {
      ...spec.verification[0]!,
      platform: {
        os: [getPlatformServices().os === "darwin" ? "linux" : "darwin"],
      },
    };
    const roleRunner = roundReviews(
      [{ correctness: approve, systems: approve }],
      async () => { throw new Error("fixer must not run"); },
    );

    const result = await runPipeline(
      repo,
      spec,
      dependencies({ runId: "pipeline-all-skipped", roleRunner }),
    );

    expect(result.status).toBe("human-decision-required");
    expect(result.verification?.pass).toBe(false);
    expect(result.verification?.evidence.failures).toContain("empty-verification");
    expect(result.gate.reasons).toContain("clean-room verification failed");
  });

  it("does not expose unimported private fixer objects after worktree cleanup", async () => {
    const repo = await initRepo();
    const linked = path.join(await temporaryDirectory("ca-private-objects-"), "linked");
    await runGit(repo, ["worktree", "add", "--detach", "-q", linked, "HEAD"]);
    const objectAccess = await resolveLinkedWorktreeWritableRoots(linked);
    const env = {
      GIT_OBJECT_DIRECTORY: objectAccess.privateObjectsDir,
      GIT_ALTERNATE_OBJECT_DIRECTORIES: objectAccess.sharedObjectsDir,
    };
    await writeFile(path.join(linked, "private.txt"), "private only\n");
    await runGit(linked, ["add", "private.txt"], env);
    await runGit(linked, ["commit", "-q", "-m", "private object"], env);
    const privateCommit = await runGit(linked, ["rev-parse", "HEAD"], env);

    expect((await git(repo, ["cat-file", "-e", `${privateCommit}^{commit}`])).exitCode)
      .not.toBe(0);
    await runGit(repo, ["worktree", "remove", "--force", linked]);
    expect((await git(repo, ["cat-file", "-e", `${privateCommit}^{commit}`])).exitCode)
      .not.toBe(0);
  });

  it("propagates the attempt classification when the implement phase does not verify", async () => {
    const repo = await initRepo();
    const failing: AttemptResult = {
      resultVersion: "1",
      runId: "pipeline-attempt-classification",
      status: "failed",
      failure: "verification-failure",
      summary: "candidate did not pass independent verification",
      producerSummary: "test producer",
      candidate: null,
      requestedVerification: [],
      executedVerification: [],
      unresolvedIssues: ["base-changed"],
      evidence: { structural: { failures: ["base-changed"] } },
      logsRef: "logs/producer.log",
      producerId: "stub",
      producerVersion: "1",
      producerModel: null,
      durationMs: 1,
      sessionId: null,
    };

    const result = await runPipeline(repo, validSpec(), {
      verifier: passingVerifier,
      ps: getPlatformServices(),
      registry: new ProducerRegistry([]),
      roleRunner: async () => {
        throw new Error("roleRunner must not run for a non-verified implement phase");
      },
      runAttempt: async () => failing,
    });

    expect(result.status).toBe("failed");
    expect(result.slices).toEqual([]);
    expect(result.haltedSliceIndex).toBeNull();
    expect(result.failure).toBe("verification-failure");
    expect(result.gate.reasons).toContain("implement phase did not produce a verified candidate");
  });
});

describe("detectWeakenedTests", () => {
  it("counts deleted test files and added .skip calls", () => {
    const diff = [
      "diff --git a/tests/foo.test.ts b/tests/foo.test.ts",
      "deleted file mode 100644",
      "diff --git a/tests/bar.test.ts b/tests/bar.test.ts",
      "+it.skip(\"was passing\", () => {});",
    ].join("\n");
    expect(detectWeakenedTests(diff)).toEqual({ testsDeleted: 1, testsSkipped: 1 });
  });

  it("ignores skips in non-test files", () => {
    const diff = ["diff --git a/src/foo.ts b/src/foo.ts", "+it.skip(", ""].join("\n");
    expect(detectWeakenedTests(diff)).toEqual({ testsDeleted: 0, testsSkipped: 0 });
  });

  it("excludes only authorized deleted tests and records their paths", () => {
    const diff = [
      "diff --git a/tests/authorized.test.ts b/tests/authorized.test.ts",
      "deleted file mode 100644",
      "diff --git a/tests/unauthorized.test.ts b/tests/unauthorized.test.ts",
      "deleted file mode 100644",
    ].join("\n");

    expect(detectWeakenedTests(diff, ["tests/authorized.*"])).toEqual({
      testsDeleted: 1,
      testsSkipped: 0,
    });
    expect(detectWeakenedTests(diff, [])).toEqual({
      testsDeleted: 2,
      testsSkipped: 0,
    });
  });

  it("judges NUL-safe deleted paths without relying on quoted patch headers", () => {
    const diff = 'diff --git "a/tests/old test.test.ts" "b/tests/old test.test.ts"';

    expect(detectWeakenedTests(
      diff,
      ["tests/old *.test.ts"],
      ["tests/old test.test.ts", "tests/not-authorized.test.ts"],
    )).toEqual({
      testsDeleted: 1,
      testsSkipped: 0,
    });
  });
});
