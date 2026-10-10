/**
 * Candidate Decisions: every rule about who decided a candidate, whether a
 * decision may be recorded, and whether a recorded one may be spent.
 *
 * Provenance resolution (the autonomous verdict, the Jev screen, elicitation)
 * stays in the MCP server because it is a Host interaction; callers hand the
 * resolved provenance here. Integration and Autopilot read their acceptance
 * rules from this module, never from the MCP layer.
 */
import { git as runGit } from "../git/git-exec.js";
import {
  INTEGRABLE_DECISION_AUTHORITIES,
  type CandidateDecision,
  type CandidateDecisionV2,
  type CandidateDecisionValue,
  type LegacyDecisionAuthority,
} from "../protocol/candidate-decision.js";
import { RuntimeError } from "../util/errors.js";

/**
 * Who is allowed to accept a candidate.
 *
 * `autonomous` (the shipped default) lets the runtime record a decision without
 * asking a person, but only for a candidate that met every objective condition:
 * independently verified, no failure, a durable pipeline-gate clearance bound
 * to the archived candidate commit, no advisory warnings, archive readable.
 * Anything short of that still requires a human through elicitation.
 *
 * `human` restores an unconditional elicitation prompt for every decision.
 *
 * Why the default is autonomous: a delegation that stops to ask permission in
 * the middle is not autonomous delegation, and the prompt was landing on the
 * happy path — the case where the pipeline had independently reviewed and
 * verified the exact candidate bytes and cleared its gate. Human control did
 * not disappear; it moved to the points where it is load-bearing. Integration
 * still refuses a moved HEAD, a dirty tree, or a hash that does not match the
 * reviewed artifact, and a plain delegation or a candidate whose gate refused
 * it can still only be accepted by a person.
 *
 * The provenance of every decision is recorded either way, so "went in without
 * a person" stays auditable rather than becoming invisible.
 */
export type DecisionAuthority = "autonomous" | "human";

export const DECISION_AUTHORITY_ENV = "CLAUDE_ARCHITECT_DECISION_AUTHORITY";

export function decisionAuthority(
  env: NodeJS.ProcessEnv = process.env,
  warn: (message: string) => void = message => console.error(message),
): DecisionAuthority {
  const raw = env[DECISION_AUTHORITY_ENV];
  if (raw === undefined || raw === "") return "autonomous";
  if (raw === "autonomous" || raw === "human") return raw;
  // Fail closed and say so. A typo silently selecting the permissive mode is
  // exactly the failure this setting exists to prevent.
  warn(
    `${DECISION_AUTHORITY_ENV}="${raw}" is not a recognized decision authority; `
    + `requiring human confirmation. Valid values: "autonomous", "human".`,
  );
  return "human";
}

/**
 * How the runtime obtained a decision, as the MCP lifecycle observed it.
 *
 * Distinct from the authority persisted with the decision: this describes the
 * mechanism the server used, and {@link authorityForProvenance} maps it onto
 * the recorded authority. `caller-asserted` means the MCP caller supplied the
 * decision and the runtime never confirmed a human made it — something an agent
 * can do — so recording the distinction is what makes "who accepted this"
 * answerable after the fact rather than assumed.
 */
export type DecisionProvenance = "human-elicitation" | "caller-asserted" | "policy-autonomous";

/**
 * The one provenance-to-authority mapping, for new writes and legacy reads.
 *
 * Anything unrecognized — including the absent provenance of a record written
 * before provenance existed — is `unknown`: claiming a person made it would
 * invent evidence and hand it the one authority that passes integration. New
 * writes never record `unknown` (see {@link recordCandidateDecision}).
 */
export function authorityForProvenance(provenance: unknown): LegacyDecisionAuthority {
  switch (provenance) {
    case "human-elicitation": return "human";
    case "policy-autonomous": return "policy-autonomous";
    case "caller-asserted": return "caller-asserted";
    default: return "unknown";
  }
}

/**
 * The one "same decision" rule.
 *
 * Authority is part of identity, not metadata: re-recording the same verdict
 * under a different authority is a different claim about who decided, and
 * treating it as idempotent would let a caller-asserted decision inherit a
 * human one's standing. `recordedAt` is ignored. A version-1 record carries no
 * evidence binding, so nothing can be shown identical to it: any new decision
 * against one is a conflict.
 */
export function isSameDecision(
  existing: CandidateDecision,
  attempted: CandidateDecisionV2,
): boolean {
  return existing.decisionVersion === "2"
    && existing.authority === attempted.authority
    && existing.decision === attempted.decision
    && existing.candidateManifestHash === attempted.candidateManifestHash
    && existing.evidenceHash === attempted.evidenceHash
    && existing.policyVersion === attempted.policyVersion;
}

export function decisionConflict(existing: CandidateDecision, attempted: CandidateDecisionValue): RuntimeError {
  return new RuntimeError(
    `candidate decision conflict: recorded ${existing.decision}, attempted ${attempted}`,
    { toolError: "decision-conflict" },
  );
}

export interface CandidateDecisionWriter {
  writeCandidateDecisionRecord(record: CandidateDecisionV2): Promise<void>;
}

/** The candidate's anchor ref, removed when the candidate is rejected. */
export interface CandidateAnchor {
  repoRoot: string;
  anchorRef: string;
  candidateCommitOid: string;
  git?: typeof runGit | undefined;
}

export interface RecordCandidateDecisionArgs {
  store: CandidateDecisionWriter;
  /** The decision already archived for this run, read under the caller's lock. */
  existing: CandidateDecision | null;
  provenance: DecisionProvenance | undefined;
  decision: CandidateDecisionValue;
  candidateManifestHash: string;
  /** Computed only once the decision is known to be permitted. */
  evidenceHash: () => Promise<string>;
  recordedAt: string;
  anchor: CandidateAnchor;
}

/**
 * Record a decision: map provenance to authority, refuse a policy authority
 * anything but acceptance, treat an identical re-send as idempotent, refuse a
 * conflicting one, write, and remove the anchor of a rejected candidate.
 */
export async function recordCandidateDecision(args: RecordCandidateDecisionArgs): Promise<void> {
  // An absent or unrecognized provenance means no layer claimed to have
  // confirmed a human — exactly `caller-asserted`, which fails integration. It
  // is recorded rather than refused: the decision happened and the archive
  // should say so.
  const mapped = authorityForProvenance(args.provenance);
  const authority = mapped === "unknown" ? "caller-asserted" : mapped;
  // Only the policy authorities are accept-only: a policy that could reject or
  // request revision on its own could bury work nobody reviewed. A
  // caller-asserted decision may carry any value — a caller can reject, and
  // refusing to record that would lose the rejection entirely.
  if (authority === "policy-autonomous" && args.decision !== "accepted") {
    throw new RuntimeError(
      `a ${authority} authority may only accept, never ${args.decision}`,
      { toolError: "decision-authority-refused" },
    );
  }
  const record = {
    decisionVersion: "2",
    authority,
    decision: args.decision,
    candidateManifestHash: args.candidateManifestHash,
    evidenceHash: await args.evidenceHash(),
    policyVersion: "1",
    recordedAt: args.recordedAt,
  } as CandidateDecisionV2;
  if (args.existing !== null) {
    if (!isSameDecision(args.existing, record)) throw decisionConflict(args.existing, args.decision);
    if (args.decision === "rejected") await removeCandidateAnchor(args.anchor, true);
    return;
  }
  await args.store.writeCandidateDecisionRecord(record);
  if (args.decision === "rejected") await removeCandidateAnchor(args.anchor, false);
}

async function removeCandidateAnchor(anchor: CandidateAnchor, allowAlreadyAbsent: boolean): Promise<void> {
  const git = anchor.git ?? runGit;
  if (allowAlreadyAbsent) {
    // `for-each-ref` reports an absent ref as empty output with exit 0, so
    // "absent" is distinguishable from a failed read. (`show-ref --verify`
    // dies with exit 128 for an absent ref, indistinguishable from a broken
    // repository, which made the tolerant re-send unreachable.)
    const listed = await git(anchor.repoRoot, [
      "for-each-ref",
      "--format=%(refname) %(objectname)",
      anchor.anchorRef,
    ]);
    if (listed.exitCode !== 0) {
      throw new RuntimeError("rejected candidate anchor could not be read", { toolError: "anchor-delete-failed" });
    }
    const prefix = `${anchor.anchorRef} `;
    const current = listed.stdout.split("\n").find(line => line.startsWith(prefix));
    if (current === undefined) return;
    if (current.slice(prefix.length) !== anchor.candidateCommitOid) {
      throw new RuntimeError("rejected candidate anchor changed identity", { toolError: "anchor-delete-failed" });
    }
  }
  const deleted = await git(anchor.repoRoot, [
    "update-ref",
    "--no-deref",
    "-d",
    anchor.anchorRef,
    anchor.candidateCommitOid,
  ]);
  if (deleted.exitCode !== 0) {
    throw new RuntimeError("failed to delete rejected candidate anchor", { toolError: "anchor-delete-failed" });
  }
}

export type IntegrationRefusal =
  | "no-accepted-decision"
  | "accepted-decision-not-confirmed"
  | "decision-artifact-mismatch";

/**
 * Why a recorded decision may not be spent on `artifactHash`, or `null` when
 * it may.
 *
 * Provenance is recorded, not required to be human: a `policy-autonomous`
 * acceptance must stay spendable or the prompt the authority removed returns
 * at integration. `caller-asserted` and `unknown` are refused — they mean the
 * runtime does not know how the decision was reached. The shared list is read
 * rather than naming authorities inline, so a new authority cannot be added to
 * the union and silently left unspendable. An acceptance is spent only on the
 * artifact it names; a legacy record that names none is refused too.
 */
export function integrationRefusal(
  decision: CandidateDecision | null,
  artifactHash: string,
): IntegrationRefusal | null {
  if (decision?.decision !== "accepted") return "no-accepted-decision";
  if (!(INTEGRABLE_DECISION_AUTHORITIES as readonly string[]).includes(decision.authority)) {
    return "accepted-decision-not-confirmed";
  }
  if (decision.candidateManifestHash !== artifactHash) return "decision-artifact-mismatch";
  return null;
}

/**
 * Whether `decision` is the acceptance Autopilot records for a promotion: a
 * version-2 `autopilot-policy` acceptance bound to the expected candidate
 * manifest and eligibility evidence.
 */
export function isAutopilotAcceptance(
  decision: CandidateDecision | null,
  manifestHash: string,
  evidenceHash: string,
): boolean {
  return decision?.decisionVersion === "2"
    && decision.authority === "autopilot-policy"
    && decision.decision === "accepted"
    && decision.candidateManifestHash === manifestHash
    && decision.evidenceHash === evidenceHash;
}
