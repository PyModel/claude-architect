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
