import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";
import path from "node:path";
import { z } from "zod";
import { PROTOCOL_VERSION, RUNTIME_VERSION } from "../protocol/versions.js";
import { FAILURE_PRECEDENCE } from "../protocol/attempt-result.js";
import { doctor, type DoctorDependencies } from "./doctor.js";
import {
  gitChangedFiles,
  gitDiff,
  gitLog,
  gitStatus,
  type GitReadDependencies,
} from "./git-read-tools.js";
import {
  handleAutopilotResume,
  handleAutopilotStart,
  handleAutopilotStatus,
  handleDecideCandidate,
  handleDelegate,
  handleDelegatePipeline,
  handleIntegrateCandidate,
  handleReviewCandidate,
  handleValidateDelegationSpec,
  type ToolDependencies,
} from "./tools.js";
import {
  autonomousEligibility,
  decisionAuthority,
  DECISION_AUTHORITY_ENV,
  type DecisionAuthority,
} from "./decision-authority.js";
import { runDecision } from "../runtime/run-decision.js";
import { recoverStaleRuns, type WorktreeSweepIssue } from "../runtime/recovery-manager.js";
import { pruneRuns } from "../runtime/artifact-store.js";
import { boundedRedactedDiagnostic, redact } from "../runtime/redaction.js";
import { RuntimeError } from "../util/errors.js";
import { getPlatformServices } from "../platform/select-platform.js";
import { platformPathsEqual } from "../util/platform-path.js";
import { git } from "../git/git-exec.js";
import { gitNulRecords } from "../git/git-output.js";
import { findWorktreeRegistration } from "../git/worktree-registration.js";

const errorOutputFields = {
  ok: z.literal(false).optional(),
  error: z.string().optional(),
  diagnostic: z.string().optional(),
};
const delegateOutput = z.object({
  ok: z.boolean(),
  result: z.record(z.string(), z.unknown()).optional(),
  validationErrors: z.array(z.object({ path: z.string(), message: z.string() })).optional(),
  diagnostic: z.string().optional(),
  error: z.string().optional(),
});
const validateDelegationSpecOutput = z.object({
  ok: z.boolean(),
  specSha256: z.string().optional(),
  validationErrors: z.array(z.object({ path: z.string(), message: z.string() })).optional(),
  diagnostic: z.string().optional(),
  error: z.string().optional(),
});
// The advertised output schema must describe every byte the server returns:
// a strict client validates structured content against it and rejects keys the
// schema omits, even when the server itself produced them.
const pipelineResultOutput = z.object({
  runId: z.string(),
  status: z.enum(["decision-ready", "human-decision-required", "failed"]),
  attempt: z.record(z.string(), z.unknown()),
  increments: z.array(z.object({
    increment: z.number(),
    report: z.object({
      reportVersion: z.literal("1"),
      candidateCommit: z.string(),
      status: z.enum(["complete", "continue", "blocked"]),
      summary: z.string(),
      nextSteps: z.string().optional(),
      blockers: z.string().optional(),
    }),
    roleLogRefs: z.array(z.string()),
  })),
  rounds: z.array(z.record(z.string(), z.unknown())),
  verification: z.record(z.string(), z.unknown()).nullable(),
  gate: z.record(z.string(), z.unknown()),
  finalCandidateCommit: z.string(),
  slices: z.array(z.record(z.string(), z.unknown())),
  haltedSliceIndex: z.number().nullable(),
  failure: z.enum(FAILURE_PRECEDENCE).nullable().optional(),
  pipelineGateCleared: z.object({
    clearedVersion: z.literal("1"),
    candidateCommitOid: z.string(),
    requiresHumanDecision: z.boolean(),
    clearedAt: z.string().optional(),
  }).nullable().optional(),
}).strict();
// Lane mode returns the correlation envelope instead of the full result; both
// shapes are part of the advertised contract.
const laneEnvelopeOutput = z.object({
  runId: z.string(),
  status: z.enum(["unavailable", "failed", "cancelled", "verified-candidate"]),
  producerId: z.string().nullable(),
  manifestHash: z.string().nullable(),
  failure: z.enum(FAILURE_PRECEDENCE).nullable(),
  durationMs: z.number(),
}).strict();
export const delegatePipelineOutput = z.object({
  ok: z.boolean(),
  result: z.union([pipelineResultOutput, laneEnvelopeOutput]).optional(),
  validationErrors: z.array(z.object({ path: z.string(), message: z.string() })).optional(),
  diagnostic: z.string().optional(),
  error: z.string().optional(),
});
export const reviewCandidateOutputSchema = z.object({
  runId: z.string().optional(),
  baseCommitOid: z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u).optional(),
  candidateCommitOid: z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u).optional(),
  candidateTreeOid: z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u).optional(),
  manifestHash: z.string().regex(/^[0-9a-f]{64}$/u).optional(),
  patch: z.string().optional(),
  changedPaths: z.array(z.object({
    path: z.string(),
    changeType: z.enum(["added", "modified", "deleted"]),
    mode: z.string(),
    contentHash: z.string().nullable(),
  })).optional(),
  evidence: z.record(z.string(), z.unknown()).optional(),
  executedVerification: z.array(z.record(z.string(), z.unknown())).optional(),
  ...errorOutputFields,
});
const decisionOutput = z.object({
  recorded: z.literal(true).optional(),
  ...errorOutputFields,
});
const integrationOutput = z.object({
  integration: z.enum(["applied", "conflicted", "aborted"]).optional(),
  detail: z.string().optional(),
  ...errorOutputFields,
});
// Must mirror DoctorResult in ./doctor.ts exactly: the client validates
// structured content against this schema, and the doctor response previously
// carried undeclared keys (git.path, sandboxBackends, dependencyClone,
// liveBundle) that strict clients rejected with -32602.
export const doctorOutput = z.object({
  node: z.object({ version: z.string(), ok: z.boolean() }).strict(),
  git: z.object({
    version: z.string().nullable(),
    ok: z.boolean(),
    // Which git actually resolved; a PATH wrapper behaves differently under
    // load than a real git, and a version string alone cannot show that.
    path: z.string().nullable(),
  }).strict(),
  producers: z.array(z.record(z.string(), z.unknown())),
  sandboxBackends: z.array(z.object({
    id: z.string(),
    kind: z.string(),
    state: z.enum(["certified", "tested", "unsupported"]),
  }).strict()),
  dependencyClone: z.object({
    cowSupported: z.boolean(),
    strategy: z.string(),
  }).strict(),
  liveBundle: z.object({
    selfHosted: z.boolean(),
    runningVersion: z.string(),
    repositoryVersion: z.string().nullable(),
    bundleMatches: z.boolean().nullable(),
    stale: z.boolean(),
  }).strict(),
  runtimeVersion: z.string(),
  schemaVersion: z.string(),
  protocolVersion: z.string(),
  issues: z.array(z.string()),
}).strict();
const gitReadOutput = z.object({
  ok: z.boolean(),
  output: z.string().optional(),
  error: z.literal("git-read-failed").optional(),
  diagnostic: z.string().optional(),
});
const autopilotOutput = z.object({
  ok: z.boolean(),
  result: z.record(z.string(), z.unknown()).optional(),
  validationErrors: z.array(z.object({ path: z.string(), message: z.string() })).optional(),
  diagnostic: z.string().optional(),
  error: z.string().optional(),
});

// zod 4 replaced `errorMap` with `error` and dropped `invalid_literal`; the
// received value now arrives as `issue.input` for both the wrong-value and the
// absent-key case, so branch on that rather than on an issue code.
const protocolVersionInput = z.literal(PROTOCOL_VERSION, {
  error: issue =>
    "protocol version mismatch: received "
    + (issue.input === undefined ? "(missing)" : String(issue.input))
    + `, expected ${PROTOCOL_VERSION}`,
});

export const delegateInputSchema = z.object({
  checkoutPath: z.string(),
  spec: z.unknown(),
  protocolVersion: protocolVersionInput,
  /**
   * Optional dispatch guard obtained from `validateDelegationSpec`. Omission is
   * backward-compatible; lane dispatch supplies it to prevent a valid-but-
   * different spec from starting work before review can detect substitution.
   */
  expectedSpecSha256: z.string().optional(),
  /**
   * "lane" returns only the correlation envelope a delegation lane reports.
   * A full result can exceed the host's inline-response limit, and the host then
   * offloads it to a file a lane — which has no filesystem tools by design —
   * cannot open, so the lane reported nothing and its controller re-dispatched,
   * duplicating the whole attempt. Evidence stays archived either way.
   */
  responseMode: z.enum(["full", "lane"]).optional(),
}).strict();

export const validateDelegationSpecInputSchema = z.object({
  spec: z.unknown(),
  protocolVersion: protocolVersionInput,
}).strict();

export const delegatePipelineInputSchema = z.object({
  checkoutPath: z.string(),
  spec: z.unknown(),
  protocolVersion: protocolVersionInput,
  /** See `delegateInputSchema.expectedSpecSha256`. */
  expectedSpecSha256: z.string().optional(),
  /**
   * "lane" returns only the correlation envelope a delegation lane reports.
   * A full result can exceed the host's inline-response limit, and the host then
   * offloads it to a file a lane — which has no filesystem tools by design —
   * cannot open, so the lane reported nothing and its controller re-dispatched,
   * duplicating the whole attempt. Evidence stays archived either way.
   */
  responseMode: z.enum(["full", "lane"]).optional(),
}).strict();

export const autopilotStartInputSchema = z.object({
  checkoutPath: z.string(),
  spec: z.unknown(),
  protocolVersion: protocolVersionInput,
}).strict();

export const autopilotWorkflowInputSchema = z.object({
  checkoutPath: z.string(),
  workflowId: z.string(),
  protocolVersion: protocolVersionInput,
}).strict();

export const reviewCandidateInputSchema = z.object({
  checkoutPath: z.string(),
  runId: z.string(),
  /**
   * Optional proof that this run belongs to the spec the caller dispatched.
   * A delegation lane reports its own runId, so without this the architect is
   * trusting the reviewed party's word about which run to review.
   */
  expectedSpecSha256: z.string().optional(),
}).strict();

export const decideCandidateInputSchema = z.object({
  checkoutPath: z.string(),
  runId: z.string(),
  decision: z.enum(["accepted", "rejected", "revision-requested"]),
  expectedArtifactHash: z.string().regex(/^[0-9a-f]{64}$/u),
}).strict();

export const integrateCandidateInputSchema = z.object({
  checkoutPath: z.string(),
  runId: z.string(),
  expectedArtifactHash: z.string(),
}).strict();

export type ServerDependencies = ToolDependencies & DoctorDependencies & GitReadDependencies & {
  recoverStaleRuns?: typeof recoverStaleRuns;
  pruneRuns?: typeof pruneRuns;
  /**
   * Transport seam. Cancellation only reaches the runtime if a client's abort
   * becomes a `notifications/cancelled` that the SDK turns into an aborted
   * `extra.signal`. Injecting a signal into the pipeline proves the checks fire;
   * it does not prove the signal ever fires. Driving a real client over an
   * in-memory transport does.
   */
  transport?: Transport;
  /** Test seam for the configured decision authority. */
  decisionAuthority?: () => DecisionAuthority;
};

/**
 * Obtain a decision from a person when the configured authority requires one.
 *
 * A tool caller is not evidence that a human chose the verdict. Elicitation is
 * the only channel where the runtime itself reaches a person, so every
 * non-policy decision depends on it.
 *
 * This fails closed. When this path is required, a client that does not
 * advertise elicitation cannot record the decision — degrading to "trust the
 * caller" would restore exactly the hole this closes, and silently. `rejected`
 * and `revision-requested` are gated too: an agent that can freely discard a
 * candidate can bury work it dislikes.
 */
/**
 * How long a person gets to answer. The SDK's default request timeout is 60
 * seconds, which is a machine-scale figure applied to a human-scale act: read
 * the candidate patch, weigh the verification evidence, decide. Both acceptance
 * attempts in a live session failed at exactly 60s, so required human decisions
 * had become unrecordable instead.
 */
const HUMAN_DECISION_TIMEOUT_MS = 15 * 60_000;

export async function confirmWithHuman(
  server: Pick<McpServer, "server">,
  runId: string,
  decision: "accepted" | "rejected" | "revision-requested",
  warnings: readonly string[] = [],
): Promise<{ ok: true } | { ok: false; error: { ok: false; error: string; diagnostic: string } }> {
  const capabilities = server.server.getClientCapabilities();
  if (capabilities?.elicitation === undefined) {
    return {
      ok: false,
      error: {
        ok: false,
        error: "elicitation-unavailable",
        diagnostic: "this client does not support MCP elicitation, so the runtime cannot confirm a "
          + "human made this decision; this decision requires confirmation and fails closed",
      },
    };
  }

  let response;
  try {
    response = await server.server.elicitInput({
      // Warnings go in the message, not only in a tool result: this text is the
      // last thing a human sees before the decision is spent, and a gate that
      // refused the candidate has to be visible right here.
      message: `Claude Architect: record "${decision}" for candidate run ${runId}? `
        + "Only you can decide this; review the candidate patch and verification evidence first."
        + (warnings.length === 0 ? "" : `\n\nWARNING — ${warnings.join("\nWARNING — ")}`),
      requestedSchema: {
        type: "object",
        properties: {
          confirm: {
            type: "boolean",
            title: `Confirm "${decision}"`,
            description: "Checked means you, the human, are recording this decision.",
          },
        },
        required: ["confirm"],
      },
    }, { timeout: HUMAN_DECISION_TIMEOUT_MS });
  } catch (error) {
    return {
      ok: false,
      error: {
        ok: false,
        error: "elicitation-failed",
        diagnostic: redact(error instanceof Error ? error.message : String(error)),
      },
    };
  }

  if (response.action !== "accept" || response.content?.confirm !== true) {
    return {
      ok: false,
      error: {
        ok: false,
        error: "decision-not-confirmed",
        diagnostic: `no decision was recorded: the human did not confirm "${decision}"`,
      },
    };
  }
  return { ok: true };
}

function toolOutput(value: object) {
  const structuredContent = value as Record<string, unknown>;
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    structuredContent,
  };
}

async function withProgress<T>(
  extra: RequestHandlerExtra<ServerRequest, ServerNotification>,
  initialPhase: string,
  operation: (onProgress: ((message: string) => void) | undefined) => Promise<T>,
): Promise<T> {
  const progressToken = extra._meta?.progressToken;
  const startedAt = Date.now();
  let step = 0;
  let lastPhase = initialPhase;
  const emit = (message: string) => {
    if (progressToken === undefined) return;
    step += 1;
    const elapsed = Math.round((Date.now() - startedAt) / 1000);
    void extra.sendNotification({
      method: "notifications/progress",
      params: { progressToken, progress: step, message: `${message} (${elapsed}s)` },
    }).catch(() => { /* progress is best-effort */ });
  };
  const onProgress = progressToken === undefined ? undefined : (message: string) => {
    lastPhase = message;
    emit(message);
  };
  const heartbeat = onProgress === undefined
    ? undefined
    : setInterval(() => emit(lastPhase), 8_000);
  try {
    return await operation(onProgress);
  } finally {
    if (heartbeat !== undefined) clearInterval(heartbeat);
  }
}

/**
 * A delegated Producer must never be able to build this surface: nesting a
 * delegation would let an untrusted process launch further untrusted processes.
 * The guard lives here rather than only in `start` because `createServer` is
 * public API and wires up the whole tool surface, autopilot included.
 */
export function nestedDelegationDenied(): boolean {
  return process.env.CLAUDE_ARCHITECT_DELEGATED !== undefined;
}

export async function createServer(
  dependencies: ServerDependencies = {},
): Promise<McpServer> {
  if (nestedDelegationDenied()) {
    throw new RuntimeError(
      "Claude Architect MCP startup denied: CLAUDE_ARCHITECT_DELEGATED is present",
    );
  }
  const recover = dependencies.recoverStaleRuns ?? recoverStaleRuns;
  const recovery = await recover();
  const sweepIssues = recovery.worktreeSweepIssues ?? [];
  let unresolvedSweepIssues = sweepIssues;
  if (sweepIssues.length > 0) {
    const noun = sweepIssues.length === 1 ? "path" : "paths";
    const diagnostic = boundedRedactedDiagnostic(
      sweepIssues.map(issue => issue.reason).join("; "),
      2_000,
    );
    // Paths themselves can contain user and repository names. Recovery already
    // retained them in its structured in-process result; stderr gets only the
    // bounded redacted reasons so startup ambiguity is visible without PII.
    console.error(
      `Claude Architect worktree sweep preserved ${sweepIssues.length} ambiguous ${noun}: ${diagnostic}`,
    );
  }

  const assertMutationRecoveryClear = async (checkoutPath: string) => {
    if (unresolvedSweepIssues.length === 0) return;
    const retried = await recover();
    unresolvedSweepIssues = retried.worktreeSweepIssues ?? [];
    if (unresolvedSweepIssues.length === 0) return;
    const attributed = unresolvedSweepIssues.filter(
      (issue): issue is WorktreeSweepIssue & { repositoryIdentity: string } =>
        issue.repositoryIdentity !== undefined,
    );
    const unattributedWorktrees = unresolvedSweepIssues.filter(issue =>
      issue.repositoryIdentity === undefined
      && path.basename(path.dirname(issue.worktreePath)) === "worktrees",
    );
    if (attributed.length === 0 && unattributedWorktrees.length === 0) return;
    const canonical = await (dependencies.ps ?? getPlatformServices())
      .canonicalizePath(checkoutPath);
    const gitCommonDir = canonical.gitCommonDir;
    if (gitCommonDir === null) {
      throw new RuntimeError("checkout Git common directory could not be resolved");
    }
    const repositoryIssues: WorktreeSweepIssue[] = attributed.filter(issue =>
      platformPathsEqual(issue.repositoryIdentity, gitCommonDir),
    );
    if (unattributedWorktrees.length > 0) {
      const listed = await (dependencies.git ?? git)(gitCommonDir, [
        "worktree", "list", "--porcelain", "-z",
      ]);
      if (listed.exitCode !== 0
        || listed.truncated?.stdout === true
        || listed.truncated?.stderr === true) {
        throw new RuntimeError("repository worktree ownership could not be revalidated");
      }
      const fields = gitNulRecords(listed.stdout, "recovery-gate Git worktree list");
      for (const issue of unattributedWorktrees) {
        if (await findWorktreeRegistration(fields, issue.worktreePath, true) !== -1) {
          repositoryIssues.push(issue);
        }
      }
    }
    if (repositoryIssues.length === 0) return;
    const ambiguousPaths = `${repositoryIssues.length} ambiguous worktree ${
      repositoryIssues.length === 1 ? "path" : "paths"
    }`;
    throw new RuntimeError(
      `mutating tools are unavailable while repository recovery preserves ${ambiguousPaths}`,
    );
  };

  // Reclaim aged/oversized run archives once per boot, after recovery has
  // settled interrupted prunes. Fail-safe: a prune failure (including a lease
  // held by a concurrent session) must never block or crash startup, so it can
  // only log. Bounded lease waits (2.5s each) match the recovery step that
  // already runs under leases above. Startup-only pruning does not bound a
  // single long-lived session; that is an accepted limitation.
  try {
    await (dependencies.pruneRuns ?? pruneRuns)();
  } catch (error) {
    console.error(`Claude Architect run pruning skipped: ${boundedRedactedDiagnostic(error, 2_000)}`);
  }

  const server = new McpServer({ name: "claude-architect", version: RUNTIME_VERSION });
  server.registerTool(
    "validateDelegationSpec",
    {
      title: "Validate and identify a Delegation Spec",
      description: "Validate a spec without starting a Producer and return its canonical digest.",
      inputSchema: validateDelegationSpecInputSchema,
      outputSchema: validateDelegationSpecOutput,
      annotations: { destructiveHint: false, idempotentHint: true, readOnlyHint: true },
    },
    async ({ spec, protocolVersion }) => toolOutput(await handleValidateDelegationSpec(
      spec,
      { ...dependencies, skillProtocolVersion: protocolVersion },
    )),
  );
  server.registerTool(
    "delegate",
    {
      title: "Delegate an implementation subtask",
      description: "Validate a Delegation Spec and run one verified attempt.",
      inputSchema: delegateInputSchema,
      outputSchema: delegateOutput,
      // Runs an untrusted Producer in a worktree and freezes a candidate; not a
      // probe a client may retry freely.
      annotations: { destructiveHint: true, idempotentHint: false, readOnlyHint: false },
    },
    async ({ checkoutPath, spec, protocolVersion, responseMode, expectedSpecSha256 }, extra) => {
      await assertMutationRecoveryClear(checkoutPath);
      return withProgress(extra, "starting attempt", async onProgress =>
        toolOutput(await handleDelegate(
          checkoutPath,
          spec,
          {
            ...dependencies,
            skillProtocolVersion: protocolVersion,
            ...(onProgress === undefined ? {} : { onProgress }),
            // The caller's cancellation must reach the Producer tree; without
            // it a cancelled request keeps running and keeps spawning.
            abortSignal: extra.signal,
          },
          responseMode ?? "full",
          expectedSpecSha256,
        ))
      );
    },
  );
  server.registerTool(
    "delegatePipeline",
    {
      title: "Run the fresh-context review pipeline",
      description: "Validate a Delegation Spec and run the full implement/review/fix pipeline.",
      inputSchema: delegatePipelineInputSchema,
      outputSchema: delegatePipelineOutput,
      // Runs Producers across implement/review/fix rounds.
      annotations: { destructiveHint: true, idempotentHint: false, readOnlyHint: false },
    },
    async ({ checkoutPath, spec, protocolVersion, responseMode, expectedSpecSha256 }, extra) => {
      await assertMutationRecoveryClear(checkoutPath);
      return withProgress(extra, "starting attempt", async onProgress =>
        toolOutput(await handleDelegatePipeline(
          checkoutPath,
          spec,
          {
            ...dependencies,
            skillProtocolVersion: protocolVersion,
            ...(onProgress === undefined ? {} : { onProgress }),
            // The caller's cancellation must reach the Producer tree; without
            // it a cancelled request keeps running and keeps spawning.
            abortSignal: extra.signal,
          },
          responseMode ?? "full",
          expectedSpecSha256,
        ))
      );
    },
  );
  server.registerTool(
    "autopilotStart",
    {
      title: "Start an autopilot workflow",
      description: "Validate an Autopilot Spec and run its verified workflow.",
      inputSchema: autopilotStartInputSchema,
      outputSchema: autopilotOutput,
      // The most consequential tool on the surface: runs Producers, creates
      // branches and worktrees, promotes commits, pushes, and opens a PR.
      annotations: { destructiveHint: true, idempotentHint: false, readOnlyHint: false },
    },
    async ({ checkoutPath, spec, protocolVersion }, extra) => {
      await assertMutationRecoveryClear(checkoutPath);
      return withProgress(extra, "starting autopilot workflow", async onProgress =>
        toolOutput(await handleAutopilotStart(checkoutPath, spec, {
          ...dependencies,
          skillProtocolVersion: protocolVersion,
          abortSignal: extra.signal,
          ...(onProgress === undefined ? {} : { onProgress }),
        }))
      );
    },
  );
  server.registerTool(
    "autopilotStatus",
    {
      title: "Read autopilot workflow status",
      description: "Return the persisted state of an autopilot workflow.",
      inputSchema: autopilotWorkflowInputSchema,
      outputSchema: autopilotOutput,
      annotations: { readOnlyHint: true },
    },
    async ({ checkoutPath, workflowId, protocolVersion }, extra) => toolOutput(
      await handleAutopilotStatus(checkoutPath, workflowId, {
        ...dependencies,
        skillProtocolVersion: protocolVersion,
        abortSignal: extra.signal,
      }),
    ),
  );
  server.registerTool(
    "autopilotResume",
    {
      title: "Resume an autopilot workflow",
      description: "Resume a recoverable autopilot workflow from durable state.",
      inputSchema: autopilotWorkflowInputSchema,
      outputSchema: autopilotOutput,
      // Continues the same shipping workflow from durable state.
      annotations: { destructiveHint: true, idempotentHint: false, readOnlyHint: false },
    },
    async ({ checkoutPath, workflowId, protocolVersion }, extra) => {
      await assertMutationRecoveryClear(checkoutPath);
      return withProgress(extra, "resuming autopilot workflow", async onProgress =>
        toolOutput(await handleAutopilotResume(checkoutPath, workflowId, {
          ...dependencies,
          skillProtocolVersion: protocolVersion,
          abortSignal: extra.signal,
          ...(onProgress === undefined ? {} : { onProgress }),
        }))
      );
    },
  );
  server.registerTool(
    "reviewCandidate",
    {
      title: "Review a verified candidate",
      description: "Return the exact candidate manifest hash, patch, and verification evidence.",
      inputSchema: reviewCandidateInputSchema,
      outputSchema: reviewCandidateOutputSchema,
    },
    async ({ checkoutPath, runId, expectedSpecSha256 }) => toolOutput(await handleReviewCandidate(
      checkoutPath,
      runId,
      dependencies,
      expectedSpecSha256,
    )),
  );
  server.registerTool(
    "decideCandidate",
    {
      title: "Record a candidate decision",
      description: "Record acceptance, rejection, or a revision request for a candidate. "
        + "An independently verified candidate is accepted without prompting when it "
        + "carries no advisory warnings: either a delegatePipeline candidate with a "
        + "durable, well-formed pipelineGateCleared record bound to the candidate "
        + "commit and requiring no human decision, or a plain delegate candidate "
        + "whose archive records plain-delegate provenance and is judged on its "
        + "independent verification result alone; "
        + "anything else requires human confirmation through MCP elicitation and fails "
        + "closed without it. Set "
        + `${DECISION_AUTHORITY_ENV}=human to require confirmation for every decision.`,
      inputSchema: decideCandidateInputSchema,
      outputSchema: decisionOutput,
      // Rejection deletes the candidate anchor and acceptance authorizes writes
      // to the checkout; neither is a read-only probe a client may retry freely.
      annotations: { destructiveHint: true, idempotentHint: false, readOnlyHint: false },
    },
    async ({ checkoutPath, runId, decision, expectedArtifactHash }) => {
      await assertMutationRecoveryClear(checkoutPath);
      return toolOutput(await handleDecideCandidate(
        checkoutPath,
        runId,
        decision,
        expectedArtifactHash,
        {
          ...dependencies,
          decisionProvenanceResolver: async ({
            advisory,
            runId: targetRunId,
            decision: targetDecision,
            snapshot,
          }) => {
            const effectiveRunId = targetRunId ?? runId;
            const effectiveDecision = targetDecision ?? decision;
            const verdict = runDecision.verdictFor(
              snapshot,
              (dependencies.decisionAuthority ?? decisionAuthority)(),
            );
            // Eligibility says the runtime proved everything it can prove about
            // the candidate; it says nothing about the verdict. The policy may
            // only accept, so every other verdict is a human override.
            if (verdict.state === "accepted" && effectiveDecision === "accepted") {
              return "policy-autonomous";
            }
            const reasons = verdict.state === "accepted" ? advisory.warnings : verdict.reasons;
            const confirmed = await confirmWithHuman(
              server,
              effectiveRunId,
              effectiveDecision,
              reasons,
            );
            if (!confirmed.ok) {
              throw new RuntimeError(confirmed.error.diagnostic, {
                toolError: confirmed.error.error,
              });
            }
            return "human-elicitation";
          },
        },
      ));
    },
  );
  server.registerTool(
    "integrateCandidate",
    {
      title: "Integrate an accepted candidate",
      description: "Apply an accepted candidate tree after revalidating its artifact hash.",
      inputSchema: integrateCandidateInputSchema,
      outputSchema: integrationOutput,
      // Writes the reviewed tree into the user's checkout.
      annotations: { destructiveHint: true, idempotentHint: false, readOnlyHint: false },
    },
    async ({ checkoutPath, runId, expectedArtifactHash }) => {
      await assertMutationRecoveryClear(checkoutPath);
      return toolOutput(await handleIntegrateCandidate(
        checkoutPath,
        runId,
        expectedArtifactHash,
        dependencies,
      ));
    },
  );
  server.registerTool(
    "doctor",
    {
      title: "Diagnose the Claude Architect runtime",
      description: "Report runtime, Git, and Producer availability diagnostics.",
      inputSchema: {},
      outputSchema: doctorOutput,
    },
    async () => toolOutput(await doctor(dependencies)),
  );
  const registerGitReadTool = (
    name: "gitStatus" | "gitDiff" | "gitLog" | "gitChangedFiles",
    title: string,
    description: string,
    handler: (checkoutPath: string, deps: GitReadDependencies) => Promise<object>,
  ) => server.registerTool(
    name,
    {
      title,
      description,
      inputSchema: { checkoutPath: z.string() },
      outputSchema: gitReadOutput,
    },
    async ({ checkoutPath }) => toolOutput(await handler(checkoutPath, dependencies)),
  );
  registerGitReadTool(
    "gitStatus",
    "Read repository status",
    "Return redacted porcelain status without modifying the repository.",
    gitStatus,
  );
  registerGitReadTool(
    "gitDiff",
    "Read repository diff",
    "Return the redacted HEAD-to-worktree diff without external diff drivers.",
    gitDiff,
  );
  registerGitReadTool(
    "gitLog",
    "Read recent repository history",
    "Return a redacted bounded recent commit log.",
    gitLog,
  );
  registerGitReadTool(
    "gitChangedFiles",
    "Read changed repository paths",
    "Return redacted HEAD-to-worktree name-status records.",
    gitChangedFiles,
  );

  return server;
}

export async function start(dependencies: ServerDependencies = {}): Promise<void> {
  // createServer enforces this too; keeping it here preserves the CLI's
  // graceful non-zero exit instead of surfacing a stack trace.
  if (nestedDelegationDenied()) {
    console.error("Claude Architect MCP startup denied: CLAUDE_ARCHITECT_DELEGATED is present");
    process.exitCode = 1;
    return;
  }

  const server = await createServer(dependencies);
  // The transport is injectable so a real MCP client can drive this server
  // in-process; without it the cancellation contract could only be tested by
  // pre-aborting a signal, which proves a check runs but never that one fires.
  await server.connect(dependencies.transport ?? new StdioServerTransport());
  console.error("claude-architect MCP server ready");
}
