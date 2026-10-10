import type { DelegationSpec, ReviewerKind } from "../protocol/delegation-spec.js";
import type { ArtifactStore } from "../runtime/artifact-store.js";
import type { RunStartContext } from "../runtime/run-start.js";
import type { LinkedWorktreeGitAccess } from "./git-writable-roots.js";
import type { PipelineRole, RolePackage } from "./role-prompts.js";
import {
  runRole as defaultRoleRunner,
  type RoleRunArgs,
  type RoleRunResult,
} from "./role-runner.js";
import { parseStructuredReport } from "./structured-output.js";
import { loadSchemas } from "../protocol/schema-loader.js";
import type {
  FixReport,
  IncrementReport,
  ReviewReport,
} from "./report-types.js";
import type { FailureClassification } from "../protocol/attempt-result.js";
import type { PlatformServices } from "../platform/platform-services.js";
import { getPlatformServices } from "../platform/select-platform.js";
import type { ProducerRegistry } from "../producers/producer-registry.js";

const schemas = loadSchemas();

export interface StructuredRoleRunFailure {
  ok: false;
  failure: FailureClassification;
  failedRoleLogRef: string;
  roleLogRefs: string[];
}

export interface StructuredRoleRunSuccess<T> {
  ok: true;
  report: T;
  roleLogRefs: string[];
}

export type StructuredRoleRunResult<T> =
  | StructuredRoleRunFailure
  | StructuredRoleRunSuccess<T>;

export interface RoleExecutionDependencies {
  ps?: PlatformServices | undefined;
  registry: ProducerRegistry;
  env?: Record<string, string | undefined> | undefined;
  abortSignal?: AbortSignal | undefined;
  roleRunner?: ((args: RoleRunArgs) => Promise<RoleRunResult>) | undefined;
}

export async function runStructuredRole<T>(args: {
  role: PipelineRole;
  schema: Parameters<typeof parseStructuredReport>[1];
  logName: string;
  spec: DelegationSpec;
  pkg: RolePackage;
  worktreePath: string;
  deps: RoleExecutionDependencies;
  runId: string;
  store: Pick<ArtifactStore, "writeLog">;
  runStart?: RunStartContext | undefined;
  gitObjectAccess?: LinkedWorktreeGitAccess | undefined;
}): Promise<StructuredRoleRunResult<T>> {
  const runner = args.deps.roleRunner ?? defaultRoleRunner;
  const callArgs: RoleRunArgs = {
    role: args.role,
    baseSpec: args.spec,
    pkg: args.pkg,
    worktreePath: args.worktreePath,
    ps: args.deps.ps ?? getPlatformServices(),
    registry: args.deps.registry,
    runId: args.runId,
    ...(args.runStart === undefined ? {} : { runStart: args.runStart }),
    ...(args.gitObjectAccess === undefined ? {} : { gitObjectAccess: args.gitObjectAccess }),
    ...(args.deps.env === undefined ? {} : { env: args.deps.env }),
    ...(args.deps.abortSignal === undefined ? {} : { abortSignal: args.deps.abortSignal }),
  };
  // Every run, initial or repair, is archived before its result is read, so a
  // failed or rejected reply always has a log to point at.
  const runArchived = async (
    runArgs: RoleRunArgs,
    logName: string,
  ): Promise<{ result: RoleRunResult; logRef: string }> => {
    const result = await runner(runArgs);
    const output = result.rawOutput === ""
      ? `role produced no stdout; failure: ${result.failure ?? "none"}\n`
      : result.archiveSafeRawOutput ?? result.rawOutput;
    return { result, logRef: await args.store.writeLog(logName, output) };
  };
  const initial = await runArchived(callArgs, args.logName);
  const roleLogRefs = [initial.logRef];
  if (!initial.result.ok) {
    return {
      ok: false,
      failure: initial.result.failure ?? "producer-failure",
      failedRoleLogRef: initial.logRef,
      roleLogRefs,
    };
  }
  const outcome = await parseStructuredReport<T>(
    initial.result.rawOutput,
    args.schema,
    async validationErrors => {
      // Re-running with the identical arguments is a blind retry: the Producer
      // cannot see why its reply was rejected, so it reproduces the defect and
      // the round is spent for nothing. Carry the errors into the retry.
      const repair = await runArchived(
        { ...callArgs, pkg: { ...callArgs.pkg, outputRepair: validationErrors } },
        `${args.logName}-repair`,
      );
      roleLogRefs.push(repair.logRef);
      return repair.result.ok ? repair.result.rawOutput : "";
    },
  );
  if (!outcome.ok) {
    return {
      ok: false,
      // Unparseable structured output is the Producer answering wrongly, not
      // failing to answer; collapsing it to producer-failure loses the only
      // signal that separates a malformed report from a crashed process.
      failure: "invalid-output",
      // The rejected output is what a reader needs to see. Pointing at the
      // repair attempt hides the report that actually failed validation.
      failedRoleLogRef: initial.logRef,
      roleLogRefs,
    };
  }
  return { ok: true, report: outcome.value, roleLogRefs };
}

export async function runIncrement(args: {
  spec: DelegationSpec;
  pkg: RolePackage;
  worktreePath: string;
  deps: RoleExecutionDependencies;
  runId: string;
  increment: number;
  store: ArtifactStore;
  gitObjectAccess: LinkedWorktreeGitAccess;
  runStart?: RunStartContext | undefined;
  logNameNamespace?: string | undefined;
}): Promise<StructuredRoleRunResult<IncrementReport>> {
  const logNameNamespace = args.logNameNamespace === undefined
    ? ""
    : `${args.logNameNamespace}-`;
  return runStructuredRole<IncrementReport>({
    role: "implementer",
    schema: schemas.incrementReport,
    logName: `role-implementer-${logNameNamespace}increment${args.increment}`,
    spec: args.spec,
    pkg: args.pkg,
    worktreePath: args.worktreePath,
    deps: args.deps,
    runId: args.runId,
    store: args.store,
    ...(args.runStart === undefined ? {} : { runStart: args.runStart }),
    gitObjectAccess: args.gitObjectAccess,
  });
}

export type ParsedReview = { reviewer: ReviewerKind; report: ReviewReport };

export type ReviewRunResult =
  | { ok: true; reviews: ParsedReview[]; roleLogRefs: string[] }
  | { ok: false; failedRoleLogRef: string; roleLogRefs: string[] };

export async function runReviews(args: {
  reviewers: ReviewerKind[];
  spec: DelegationSpec;
  pkg: RolePackage;
  worktreePath: string;
  deps: RoleExecutionDependencies;
  runId: string;
  round: number;
  store: ArtifactStore;
  logNameNamespace?: string | undefined;
  onReviewer?: ((role: `reviewer-${ReviewerKind}`) => Promise<void>) | undefined;
}): Promise<ReviewRunResult> {
  const logNameNamespace = args.logNameNamespace === undefined
    ? ""
    : `${args.logNameNamespace}-`;
  const outcomes = await Promise.all(args.reviewers.map(async reviewer => {
    const role: PipelineRole = `reviewer-${reviewer}`;
    await args.onReviewer?.(role as `reviewer-${ReviewerKind}`);
    const outcome = await runStructuredRole<ReviewReport>({
      role,
      schema: schemas.reviewReport,
      logName: `role-${role}-${logNameNamespace}round${args.round}`,
      spec: args.spec,
      pkg: args.pkg,
      worktreePath: args.worktreePath,
      deps: args.deps,
      runId: args.runId,
      store: args.store,
    });
    return {
      review: outcome.ok ? { reviewer, report: outcome.report } : null,
      initialLogRef: outcome.ok ? null : outcome.failedRoleLogRef,
      roleLogRefs: outcome.roleLogRefs,
    };
  }));
  const roleLogRefs = outcomes.flatMap(outcome => outcome.roleLogRefs);
  const reviews = outcomes.map(outcome => outcome.review);
  if (reviews.every((review): review is ParsedReview => review !== null)) {
    return { ok: true, reviews, roleLogRefs };
  }
  const failed = outcomes.find(outcome => outcome.review === null);
  if (failed?.initialLogRef === null || failed === undefined) {
    throw new Error("unreachable invalid review state");
  }
  return { ok: false, failedRoleLogRef: failed.initialLogRef, roleLogRefs };
}

export type FixRunResult =
  | { ok: true; fix: FixReport; roleLogRefs: string[] }
  | StructuredRoleRunFailure;

export async function runFix(args: {
  spec: DelegationSpec;
  pkg: RolePackage;
  worktreePath: string;
  deps: RoleExecutionDependencies;
  runId: string;
  round: number;
  store: ArtifactStore;
  gitObjectAccess: LinkedWorktreeGitAccess;
  runStart?: RunStartContext | undefined;
}): Promise<FixRunResult> {
  const outcome = await runStructuredRole<FixReport>({
    role: "fixer",
    schema: schemas.fixReport,
    logName: `role-fixer-round${args.round}`,
    spec: args.spec,
    pkg: args.pkg,
    worktreePath: args.worktreePath,
    deps: args.deps,
    runId: args.runId,
    store: args.store,
    ...(args.runStart === undefined ? {} : { runStart: args.runStart }),
    gitObjectAccess: args.gitObjectAccess,
  });
  return outcome.ok
    ? { ok: true, fix: outcome.report, roleLogRefs: outcome.roleLogRefs }
    : outcome;
}
