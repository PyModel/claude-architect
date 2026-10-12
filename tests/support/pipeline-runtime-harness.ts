import { createHash } from "node:crypto";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, vi } from "vitest";
import { git } from "../../src/git/git-exec.js";
import { handleDecideCandidate, handleIntegrateCandidate } from "../../src/mcp/tools.js";
import type { CheckoutLock, PlatformServices } from "../../src/platform/platform-services.js";
import { getPlatformServices } from "../../src/platform/select-platform.js";
import type { AttemptResult, CandidateArtifact, ChangedPath } from "../../src/protocol/attempt-result.js";
import type { DelegationSpec, Slice } from "../../src/protocol/delegation-spec.js";
import { ProducerRegistry } from "../../src/producers/producer-registry.js";
import { type PipelineDependencies } from "../../src/pipeline/pipeline-runtime.js";
import type { ReviewReport } from "../../src/pipeline/report-types.js";
import type { RoleRunArgs, RoleRunResult } from "../../src/pipeline/role-runner.js";
import { ArtifactStore } from "../../src/runtime/artifact-store.js";
import { buildRunManifest } from "../../src/runtime/run-manifest.js";
import type { AcceptanceVerifierLike, AttemptRuntimeDependencies } from "../../src/runtime/attempt-runtime.js";
import { clearRegisteredSecrets } from "../../src/runtime/redaction.js";
import { initializeRunStart } from "../../src/runtime/run-start.js";

export const temporaryPaths: string[] = [];
let previousPluginData: string | undefined;
let previousNodeEnvironment: string | undefined;
let previousDelegated: string | undefined;

export async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), prefix));
  temporaryPaths.push(directory);
  return directory;
}

export async function runGit(
  cwd: string,
  args: string[],
  env?: Record<string, string>,
): Promise<string> {
  const result = await git(cwd, args, env === undefined ? undefined : { env });
  expect(result.exitCode, result.stderr).toBe(0);
  return result.stdout.trim();
}

export async function expectRefMissing(repo: string, ref: string): Promise<void> {
  const result = await git(repo, ["rev-parse", "--verify", "--quiet", ref]);
  expect(result.exitCode).not.toBe(0);
}

export async function expectRefPresent(repo: string, ref: string): Promise<void> {
  const result = await git(repo, ["rev-parse", "--verify", "--quiet", ref]);
  expect(result.exitCode).toBe(0);
}

export async function initRepo(): Promise<string> {
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

export function validSpec(reviewers: DelegationSpec["review"] = {
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

export function fenced(value: unknown): string {
  return `\`\`\`json\n${JSON.stringify(value)}\n\`\`\``;
}

export function success(rawOutput: string): RoleRunResult {
  return { ok: true, rawOutput, failure: null, producerId: "stub" };
}

export const approve: ReviewReport = {
  reportVersion: "1",
  verdict: "approve",
  findings: [],
  coverageGaps: [],
};

export const blocker: ReviewReport = {
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

export const passingVerifier: AcceptanceVerifierLike = {
  async verify() {
    return { ok: true, failures: [], evidence: {}, commandOutcomes: [] };
  },
};

export function statusChangeType(status: string): ChangedPath["changeType"] {
  if (status === "A") return "added";
  if (status === "D") return "deleted";
  return "modified";
}

export async function artifactFor(
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

export function attemptResult(runId: string, candidate: CandidateArtifact): AttemptResult {
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

export function failedAttemptResult(runId: string): AttemptResult {
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

export async function checkoutLeaseHarness(
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

export function fakeAttempt(runId: string, edit: (repo: string) => Promise<void>) {
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

export function dependencies(args: {
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

export async function expectPipelineAuthorityBlocksTools(
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

export function roundReviews(
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

export async function commitFix(args: RoleRunArgs, content: string): Promise<string> {
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

export function implementationSpec(maxIncrements: number): DelegationSpec {
  const spec = validSpec({ reviewers: ["correctness"], maxRounds: 1 });
  spec.implementation = { maxIncrements };
  return spec;
}

export function incrementRoleRunner(
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

export async function commitIncrement(
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

export async function initSlicedRepo(): Promise<string> {
  const repo = await initRepo();
  await writeFile(path.join(repo, "slice-one.txt"), "slice one base\n");
  await writeFile(path.join(repo, "slice-two.txt"), "slice two base\n");
  await runGit(repo, ["add", "slice-one.txt", "slice-two.txt"]);
  await runGit(repo, ["commit", "-q", "-m", "slice fixtures"]);
  return repo;
}

export function fileVerification(
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

export function slicedSpec(perSlice = false): DelegationSpec {
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

export async function commitRoleFile(
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


export function installPipelineRuntimeHooks(): void {
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
}
