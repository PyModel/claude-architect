import path from "node:path";
import type { Slice, DelegationSpec } from "../protocol/delegation-spec.js";
import type { AttemptResult, FailureClassification } from "../protocol/attempt-result.js";
import { consolidate, type ConsolidationResult } from "./consolidator.js";
import type { VerificationReport } from "./report-types.js";
import { planSliceWaves } from "./slice-scheduler.js";
import { routeSlice, type SliceRoute } from "./wayfinder.js";
import { composeSliceOntoHead } from "./slice-composer.js";
import type { PlatformServices } from "../platform/platform-services.js";
import { getPlatformServices } from "../platform/select-platform.js";
import type { RunContext } from "./run-context.js";
import type { PipelineRole } from "./role-prompts.js";
import type { ReviewerKind } from "../protocol/delegation-spec.js";
import { WorktreeManager, withManagedWorktree } from "../runtime/worktree-manager.js";
import {
  resolveLinkedWorktreeWritableRoots,
  type LinkedWorktreeGitAccess,
} from "./git-writable-roots.js";
import {
  ProducerRuntime,
  producerRuntime as defaultProducerRuntime,
} from "../producers/producer-runtime.js";
import {
  RunDecision,
  runDecision as defaultRunDecision,
} from "../runtime/run-decision.js";
import {
  PlatformSafety,
  platformSafety as defaultPlatformSafety,
} from "../platform/platform-safety.js";
import {
  runRole as defaultRunRole,
  type RoleRunArgs,
  type RoleRunResult,
} from "./role-runner.js";
import {
  runIncrement,
  runReviews,
  type RoleExecutionDependencies,
} from "./pipeline-roles.js";
import {
  verifyCandidate,
} from "./candidate-verifier.js";
import {
  importPromotedObjects,
  validateCandidateProvenance,
} from "./candidate-provenance.js";
import { git, type GitExecOptions, type GitResult } from "../git/git-exec.js";
import { SLICE_REF_PREFIX } from "../git/ref-namespace.js";
import { RuntimeError } from "../util/errors.js";
import type { ArtifactStore } from "../runtime/artifact-store.js";
import type { CheckoutLock } from "../platform/platform-services.js";
import type { ProducerRegistry } from "../producers/producer-registry.js";


export interface TemporarySliceRef {
  ref: string;
  oid: string;
}

export class SliceExecutionError extends RuntimeError {
  constructor(message: string, readonly failure: FailureClassification) {
    super(message);
    this.name = "SliceExecutionError";
  }
}

export function findSliceExecutionError(error: unknown): SliceExecutionError | null {
  if (error instanceof SliceExecutionError) return error;
  if (error instanceof AggregateError) {
    for (const nested of error.errors) {
      const found = findSliceExecutionError(nested);
      if (found !== null) return found;
    }
  }
  return null;
}

export function scopeSpecToSlice(spec: DelegationSpec, slice: Slice): DelegationSpec {
  const scoped = structuredClone({ ...spec, ...slice });
  delete scoped.slices;
  return scoped;
}

function gitFailure(action: string, result: GitResult): RuntimeError {
  const diagnostic = (result.stderr || result.stdout).trim().slice(0, 2_000);
  return new RuntimeError(`${action} failed${diagnostic ? `: ${diagnostic}` : ""}`);
}

async function checkedGit(
  cwd: string,
  args: string[],
  options?: GitExecOptions,
): Promise<string> {
  const result = await git(cwd, args, options);
  if (result.exitCode !== 0) throw gitFailure(`git ${args[0] ?? "command"}`, result);
  return result.stdout;
}

export function temporarySliceRef(runId: string, index: number, attempt: number): string {
  return `${SLICE_REF_PREFIX}${runId}/slice-${index}-attempt-${attempt}`;
}

export async function createTemporarySliceRef(
  checkoutPath: string,
  temporaryRef: TemporarySliceRef,
): Promise<void> {
  const result = await git(checkoutPath, [
    "update-ref",
    "--no-deref",
    temporaryRef.ref,
    temporaryRef.oid,
    "0".repeat(temporaryRef.oid.length),
  ]);
  if (result.exitCode !== 0) throw gitFailure("create temporary slice ref", result);
}

export async function cleanupTemporarySliceRefs(
  checkoutPath: string,
  temporaryRefs: TemporarySliceRef[],
): Promise<unknown[]> {
  const errors: unknown[] = [];
  for (const temporaryRef of [...temporaryRefs].reverse()) {
    try {
      const result = await git(checkoutPath, [
        "update-ref",
        "--no-deref",
        "-d",
        temporaryRef.ref,
        temporaryRef.oid,
      ]);
      if (result.exitCode !== 0) {
        errors.push(gitFailure("delete temporary slice ref", result));
      }
    } catch (error) {
      errors.push(error);
    }
  }
  return errors;
}

export function describePriorAttempts(
  attempts: readonly SliceAttemptEvidence[],
): string {
  return attempts.map(entry => {
    const failed = (entry.verification?.commandResults ?? [])
      .filter(command => !command.ok)
      .map(command => `${command.id} (exit ${String(command.exitCode)})`);
    const blocking = (entry.perSliceReview?.findings ?? [])
      .filter(finding => finding.severity === "blocker" || finding.severity === "major")
      .map(finding => `${finding.severity} at ${finding.location}: ${finding.claim}`);
    return [
      `attempt ${entry.attempt} -> ${entry.route}`,
      `  reasons: ${entry.reasons.join("; ") || "(none recorded)"}`,
      ...(failed.length === 0 ? [] : [`  failing verification: ${failed.join(", ")}`]),
      ...(blocking.length === 0 ? [] : [`  blocking findings:\n    ${blocking.join("\n    ")}`]),
    ].join("\n");
  }).join("\n\n");
}

function verificationTestEvidence(verification: VerificationReport): Record<string, unknown> {
  return {
    pass: verification.pass,
    commandResults: verification.commandResults.map(command => ({ ...command })),
    workspaceClean: verification.workspaceClean,
    testsDeleted: verification.testsDeleted,
    testsSkipped: verification.testsSkipped,
    scopeViolations: [...verification.scopeViolations],
  };
}

export function sliceTestEvidence(slices: PipelineSlice[]): string {
  return JSON.stringify(slices.map(slice => ({
    sliceIndex: slice.index,
    verification: slice.verification === null
      ? null
      : verificationTestEvidence(slice.verification),
    attempts: slice.attempts.map(attempt => ({
      attempt: attempt.attempt,
      verification: attempt.verification === null
        ? null
        : verificationTestEvidence(attempt.verification),
    })),
  })));
}

export function testEvidence(attempt: AttemptResult): string {
  return JSON.stringify(attempt.executedVerification.map(outcome => ({
    id: outcome.id,
    exitCode: outcome.exitCode,
    timedOut: outcome.timedOut,
  })));
}

export async function runSliceReview(args: {
  checkoutPath: string;
  spec: DelegationSpec;
  deps: RoleExecutionDependencies;
  runId: string;
  baselineCommit: string;
  candidateCommit: string;
  namespace: string;
  reviewers: ReviewerKind[];
  verification: VerificationReport;
  store: ArtifactStore;
  // Required, not optional: a review worktree created without the run's
  // borrowed lease blocks on the lock this same process already holds.
  borrowedCheckoutLease: CheckoutLock | undefined;
}): Promise<{ review: ConsolidationResult; roleLogRefs: string[] }> {
  const ps = args.deps.ps ?? getPlatformServices();
  return withManagedWorktree({
    manager: new WorktreeManager(
      args.checkoutPath,
      `${args.runId}-${args.namespace}-review`,
      ps,
      args.borrowedCheckoutLease === undefined
        ? {}
        : { borrowedCheckoutLease: args.borrowedCheckoutLease },
    ),
    commit: args.candidateCommit,
    cleanupFailureMessage: "slice review failed and its worktree could not be cleaned up",
    run: async worktreePath => {
      const diffText = await checkedGit(worktreePath, [
        "diff",
        `${args.baselineCommit}..${args.candidateCommit}`,
      ]);
      const reviewRun = await runReviews({
        reviewers: args.reviewers,
        spec: args.spec,
        pkg: {
          spec: args.spec,
          baselineCommit: args.baselineCommit,
          candidateCommit: args.candidateCommit,
          candidateDiff: diffText,
          testEvidence: JSON.stringify(verificationTestEvidence(args.verification)),
        },
        worktreePath,
        deps: args.deps,
        runId: args.runId,
        round: 1,
        store: args.store,
        logNameNamespace: args.namespace,
      });
      if (!reviewRun.ok) {
        throw new SliceExecutionError(
          `slice review did not produce valid structured output (see ${reviewRun.failedRoleLogRef})`,
          "producer-failure",
        );
      }
      return {
        review: consolidate(reviewRun.reviews.map(review => ({
          reviewer: review.reviewer,
          report: review.report,
        }))),
        roleLogRefs: reviewRun.roleLogRefs,
      };
    },
  });
}

export interface SliceAttemptEvidence {
  sliceIndex: number;
  attempt: number;
  candidateCommit: string;
  verification: VerificationReport | null;
  perSliceReview: ConsolidationResult | null;
  route: SliceRoute;
  reasons: string[];
  roleLogRefs: string[];
}

export interface PipelineSlice {
  index: number;
  objective: string;
  route: SliceRoute;
  candidateCommit: string;
  roundsUsed: number;
  verification: VerificationReport | null;
  perSliceReview: ConsolidationResult | null;
  reasons: string[];
  attempts: SliceAttemptEvidence[];
  roleLogRefs: string[];
}

export interface SliceAttempt {
  candidateCommit: string;
  verification: VerificationReport | null;
  perSliceReview?: ConsolidationResult | null | undefined;
  roleLogRefs?: string[] | undefined;
  hardBlocker?: boolean | undefined;
}

export interface SlicePhaseResult {
  slices: PipelineSlice[];
  finalCandidateCommit: string;
  haltedSliceIndex: number | null;
  temporarySliceRefs?: TemporarySliceRef[] | undefined;
}

interface SliceOutcome {
  slice: PipelineSlice;
  advanced: boolean;
}


export interface ReviewConfig {
  perSlice?: boolean | undefined;
  final?: boolean | undefined;
  reviewers?: ReviewerKind[] | undefined;
}

export interface SliceRunnerDependencies {
  producerRuntime?: ProducerRuntime | undefined;
  runDecision?: RunDecision | undefined;
  platformSafety?: PlatformSafety | undefined;
  ps?: PlatformServices | undefined;
  runRole?: typeof defaultRunRole | undefined;
  roleRunner?: ((args: RoleRunArgs) => Promise<RoleRunResult>) | undefined;
}

export interface SliceRunnerBudgets {
  maxRounds?: number | undefined;
}

export interface SliceRunnerRunOptions {
  context: RunContext;
  slices: Slice[];
  baselineCommit: string;
  attempt: AttemptResult;
  budgets?: SliceRunnerBudgets | undefined;
  maxRounds?: number | undefined;
  concurrency?: number | undefined;
  initialAttempt?: SliceAttempt | undefined;
  initialPerSliceReview?: ConsolidationResult | null | undefined;
  initialRoleLogRefs?: string[] | undefined;
  reviewConfig?: ReviewConfig | undefined;
  reviewers?: ReviewerKind[] | undefined;
  registry?: ProducerRegistry | undefined;
  abortSignal?: AbortSignal | undefined;
  onAttempt?: ((evidence: SliceAttemptEvidence) => Promise<void>) | undefined;
  onSlice?: ((slice: PipelineSlice) => Promise<void>) | undefined;
}

export class SliceRunner {
  readonly producerRuntime: ProducerRuntime;
  readonly runDecision: RunDecision;
  readonly platformSafety: PlatformSafety;
  readonly ps: PlatformServices;
  readonly runRole: typeof defaultRunRole;
  readonly roleRunner?: ((args: RoleRunArgs) => Promise<RoleRunResult>) | undefined;

  constructor(dependencies: SliceRunnerDependencies = {}) {
    this.producerRuntime = dependencies.producerRuntime ?? defaultProducerRuntime;
    this.runDecision = dependencies.runDecision ?? defaultRunDecision;
    this.platformSafety = dependencies.platformSafety ?? defaultPlatformSafety;
    this.ps = dependencies.ps ?? getPlatformServices();
    this.runRole = dependencies.runRole ?? defaultRunRole;
    this.roleRunner = dependencies.roleRunner;
  }

  async run(options: SliceRunnerRunOptions): Promise<SlicePhaseResult> {
    const { context, slices, baselineCommit, attempt } = options;
    const maxRounds = options.budgets?.maxRounds ?? options.maxRounds ?? 3;
    const concurrency = options.concurrency ?? 1;
    const temporarySliceRefs: TemporarySliceRef[] = [];
    const completedSlices: PipelineSlice[] = [];
    let currentCommit = baselineCommit;
    const results: PipelineSlice[] = [];

    try {
      for (const wave of planSliceWaves(slices, concurrency)) {
        const base = currentCommit;
        const outcomes = await Promise.all(wave.indices.map(async index => {
          const slice = slices[index - 1]!;
          let roundsUsed = 0;
          const attempts: SliceAttemptEvidence[] = [];

          while (true) {
            let sourceAttempt: SliceAttempt;
            if (roundsUsed === 0 && index === 1 && options.initialAttempt !== undefined) {
              sourceAttempt = options.initialAttempt;
            } else {
              const namespace = `slice-${index}-attempt-${roundsUsed}`;
              const scopedSpec = scopeSpecToSlice(context.spec, slice);

              sourceAttempt = await withManagedWorktree({
                manager: new WorktreeManager(
                  context.checkoutPath,
                  `${context.runId}-${namespace}`,
                  this.ps,
                  context.borrowedCheckoutLease === undefined
                    ? {}
                    : { borrowedCheckoutLease: context.borrowedCheckoutLease },
                ),
                commit: base,
                cleanupFailureMessage:
                  "slice implementation failed and its worktree could not be cleaned up",
                run: async worktreePath => {
                  let gitObjectAccess: LinkedWorktreeGitAccess;
                  try {
                    gitObjectAccess = await resolveLinkedWorktreeWritableRoots(worktreePath);
                  } catch {
                    throw new SliceExecutionError(
                      "slice implementer git object isolation could not be established",
                      "sandbox-violation",
                    );
                  }

                  await context.emitStatus("implementing", {
                    sliceIndex: index,
                    role: "implementer",
                  });

                  const roleDeps: RoleExecutionDependencies = {
                    ps: this.ps,
                    runRole: this.runRole,
                    ...(this.roleRunner === undefined ? {} : { roleRunner: this.roleRunner }),
                    ...(options.registry === undefined ? {} : { registry: options.registry }),
                    ...(options.abortSignal === undefined ? {} : { abortSignal: options.abortSignal }),
                  };

                  const incrementRun = await runIncrement({
                    spec: scopedSpec,
                    pkg: {
                      spec: scopedSpec,
                      baselineCommit: base,
                      candidateCommit: base,
                      candidateDiff: "",
                      testEvidence: completedSlices.length === 0
                        ? testEvidence(attempt)
                        : sliceTestEvidence(completedSlices),
                      ...(attempts.length === 0
                        ? {}
                        : { priorAttempts: describePriorAttempts(attempts) }),
                    },
                    worktreePath,
                    deps: roleDeps,
                    runId: context.runId,
                    increment: roundsUsed + 1,
                    store: context.store,
                    gitObjectAccess,
                    ...(context.runStart === undefined ? {} : { runStart: context.runStart }),
                    logNameNamespace: namespace,
                  });

                  if (!incrementRun.ok) {
                    throw new SliceExecutionError(
                      `slice implementer did not produce valid structured output (see ${incrementRun.failedRoleLogRef})`,
                      incrementRun.failure,
                    );
                  }

                  await context.emitStatus("freezing", {
                    sliceIndex: index,
                    role: "implementer",
                  });

                  const candidateCommit = incrementRun.report.candidateCommit;
                  const provenanceFailure = await validateCandidateProvenance({
                    worktreePath,
                    previousCandidateCommit: base,
                    candidateCommit,
                    gitObjectAccess,
                    phaseLabel: "slice implementer",
                  });

                  if (provenanceFailure !== null) {
                    throw new SliceExecutionError(
                      provenanceFailure.reason,
                      provenanceFailure.failure,
                    );
                  }

                  if (candidateCommit !== base) {
                    try {
                      await importPromotedObjects({
                        checkoutPath: context.checkoutPath,
                        baselineCommit: base,
                        promotedCommit: candidateCommit,
                        access: gitObjectAccess,
                      });
                    } catch {
                      throw new SliceExecutionError(
                        "slice candidate objects could not be imported into the shared git object store",
                        "sandbox-violation",
                      );
                    }
                    const temporaryRef = {
                      ref: temporarySliceRef(context.runId, index, roundsUsed),
                      oid: candidateCommit,
                    };
                    try {
                      await createTemporarySliceRef(context.checkoutPath, temporaryRef);
                    } catch {
                      throw new SliceExecutionError(
                        "slice candidate temporary ref could not be established",
                        "sandbox-violation",
                      );
                    }
                    temporarySliceRefs.push(temporaryRef);
                  }

                  await context.emitStatus("verifying", { sliceIndex: index });
                  const verified = await verifyCandidate({
                    checkoutPath: context.checkoutPath,
                    spec: scopedSpec,
                    deps: {
                      ps: this.ps,
                      ...(context.borrowedCheckoutLease === undefined
                        ? {}
                        : { borrowedCheckoutLease: context.borrowedCheckoutLease }),
                    },
                    attempt,
                    baselineCommit: base,
                    candidateCommit,
                    store: context.store,
                    namespace,
                  });

                  let perSliceReview: ConsolidationResult | null = null;
                  const roleLogRefs = [...incrementRun.roleLogRefs];
                  if (options.reviewConfig?.perSlice === true) {
                    const reviewers = (options.reviewers ?? ["reviewer-correctness"])
                      .map(r => r.startsWith("reviewer-") ? r.replace("reviewer-", "") : r) as ReviewerKind[];
                    const reviewed = await runSliceReview({
                      checkoutPath: context.checkoutPath,
                      spec: scopedSpec,
                      deps: roleDeps,
                      runId: context.runId,
                      baselineCommit: base,
                      candidateCommit,
                      namespace,
                      reviewers,
                      verification: verified.verification,
                      store: context.store,
                      borrowedCheckoutLease: context.borrowedCheckoutLease,
                    });
                    perSliceReview = reviewed.review;
                    roleLogRefs.push(...reviewed.roleLogRefs);
                  }

                  return {
                    candidateCommit,
                    verification: verified.verification,
                    perSliceReview,
                    roleLogRefs,
                  };
                },
              });
            }

            const currentAttempt = structuredClone(sourceAttempt);
            const perSliceReview = currentAttempt.perSliceReview ?? null;
            const route = routeSlice({
              verification: currentAttempt.verification,
              perSliceReview,
              roundsUsed,
              maxRounds,
              hardBlocker: currentAttempt.hardBlocker ?? false,
            });

            const evidence: SliceAttemptEvidence = {
              sliceIndex: index,
              attempt: roundsUsed,
              candidateCommit: currentAttempt.candidateCommit,
              verification: currentAttempt.verification,
              perSliceReview,
              route: route.route,
              reasons: [...route.reasons],
              roleLogRefs: [...(currentAttempt.roleLogRefs ?? [])],
            };

            await context.store.writePipelineArtifact(
              `slice-${evidence.sliceIndex}-attempt-${evidence.attempt}`,
              evidence,
            );
            if (options.onAttempt) {
              await options.onAttempt(structuredClone(evidence));
            }
            attempts.push(evidence);

            const pipelineSlice: PipelineSlice = {
              index,
              objective: slice.objective,
              route: route.route,
              candidateCommit: currentAttempt.candidateCommit,
              roundsUsed,
              verification: currentAttempt.verification,
              perSliceReview,
              reasons: [...route.reasons],
              attempts: attempts.map(entry => ({
                ...entry,
                reasons: [...entry.reasons],
                roleLogRefs: [...entry.roleLogRefs],
              })),
              roleLogRefs: attempts.flatMap(entry => entry.roleLogRefs),
            };

            if (route.route === "repair") {
              roundsUsed += 1;
              continue;
            }
            return { slice: pipelineSlice, advanced: route.route === "advance" };
          }
        }));

        for (const outcome of outcomes) {
          const composed = wave.indices.length === 1
            ? outcome.slice.candidateCommit
            : await composeSliceOntoHead({
              checkoutPath: context.checkoutPath,
              runId: context.runId,
              head: currentCommit,
              base,
              sliceCommit: outcome.slice.candidateCommit,
              sliceIndex: outcome.slice.index,
            });

          const recorded: PipelineSlice = { ...outcome.slice, candidateCommit: composed };
          results.push(recorded);
          completedSlices.push(structuredClone(recorded));

          await context.store.writePipelineArtifact(`slice-${recorded.index}`, recorded);
          if (options.onSlice) {
            await options.onSlice(structuredClone(recorded));
          }

          if (!outcome.advanced) {
            return {
              slices: results,
              finalCandidateCommit: currentCommit,
              haltedSliceIndex: recorded.index,
              temporarySliceRefs: [...temporarySliceRefs],
            };
          }
          currentCommit = composed;
        }
      }

      return {
        slices: results,
        finalCandidateCommit: currentCommit,
        haltedSliceIndex: null,
        temporarySliceRefs: [...temporarySliceRefs],
      };
    } catch (error) {
      // Only the abandoned path cleans up here. On every returning path the
      // refs are handed to the caller, which still needs them reachable for
      // the final review round and disposes of them under its own lifecycle.
      await cleanupTemporarySliceRefs(context.checkoutPath, temporarySliceRefs);
      throw error;
    }
  }
}
