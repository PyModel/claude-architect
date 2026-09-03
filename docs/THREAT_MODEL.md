# Threat Model

This model covers every Producer adapter exposed through the MCP implementation path. It assumes the local OS, user account, Node.js runtime, Git executable, and Claude Code host are not already fully compromised. It does not assume that repository text, generated code, Producer output, or model-provider responses are trustworthy.

Each invariant named here has exactly one owner in the source; the mapping is
[ARCHITECTURE.md § Who owns each trust invariant](ARCHITECTURE.md#who-owns-each-trust-invariant).

## Assets

Assets include the integrity and confidentiality of the user's repository and Git history; uncommitted work; credentials and environment variables; filesystem data outside the delegated scope; the correctness of verification evidence; candidate/decision integrity; plugin run logs; provider account access; and the integrity of the configured human/policy authority that may accept and integrate a candidate.

## Adversaries

1. A malicious or mistaken Producer emits unsafe code, changes forbidden files, lies about tests, creates unusual Git objects, or embeds instructions for later reviewers.
2. Repository content contains prompt injection in source, documentation, tests, filenames, diffs, or `AGENTS.md`, attempting to override the Delegation Spec or exfiltrate data.
3. A compromised Producer CLI or provider response executes unexpected commands, probes credentials, escapes its worktree, or forges structured output.
4. A local process races state files, swaps paths/symlinks, reuses a PID, alters candidate refs, or calls MCP decision tools.
5. An authorized but careless operator accepts incorrect output, allows overly broad scope/network access, or removes evidence prematurely.

## Attack surfaces and mitigations

| Surface | Principal mitigations | Residual risk |
|---|---|---|
| Delegation input | Schema/version validation in `src/protocol/spec-validator.ts` and `src/protocol/schema-loader.ts`; explicit allowlist, forbidden scope, timeout, verification argv, and network policy | A valid but overly broad spec grants broad authority |
| Producer process | Adapter-built argv in `src/producers/`; sanitized environment in `src/runtime/environment-policy.ts`; supervised process groups/timeouts in `src/platform/process-supervisor.ts`; nested-delegation marker | Compromised binaries run with whatever read authority the sandbox permits |
| Filesystem writes | Detached worktree in `src/git/worktree-manager.ts`; Producer-native sandbox or eligible platform backend; fail-closed eligibility; post-run inventory and scope rejection in `src/git/candidate-tree.ts` | Defects in an eligible sandbox can allow transient out-of-scope effects before detection |
| Network/exfiltration | Codex network disabled; per-command verification network declarations; minimal environment propagation; credential redaction | Provider traffic is necessary for cloud models; readable repository secrets may be sent; no destination allowlist |
| Prompt injection | Producer labeled untrusted; pipeline prompts delimit candidate diff/evidence as untrusted in `src/pipeline/role-prompts.ts`; reviewers are fresh, read-only invocations | Models can still follow malicious content or miss subtle behavior |
| Forged success claims | Producer self-report is not acceptance evidence; structural verification and Host-run commands in `src/verify/acceptance-verifier.ts`; separate verification worktree in `src/verify/project-verifier.ts` | Tests can be incomplete, malicious, nondeterministic, or dependent on unavailable services |
| Candidate substitution | Runtime-issued `specSha256` can be bound at dispatch before work starts; candidate tree/commit/ref anchors, changed-path content hashes, candidate manifest hash, and hashed run manifest; `reviewCandidate` regenerates patch from anchored objects | Legacy callers may omit the additive dispatch digest; SHA-256/Git integrity does not establish code safety; local users with repository write access can disrupt refs |
| Review/fix pipeline | New role invocation per round; reviewers/verifier use empty write allowlist and all-path forbidden scope; only fixer may edit; adversarial gates in `src/pipeline/gates.ts` | Provider-side context retention is outside plugin control; reviewer and implementer may share a vulnerable model family |
| Acceptance/integration | Policy acceptance requires independent verification plus durable, commit-bound `pipelineGateCleared` evidence with no human requirement or advisory warning; every other decision requires positive MCP elicitation; integration requires accepted, integrable provenance and the exact manifest hash, then rechecks base/ref/tree/status under locks | Policy evidence is not proof of safety; MCP elicitation is not cryptographic human identity; a compromised trusted host/client could synthesize confirmation |
| State tampering/races | Plain-directory/no-follow checks, bounded reads, restrictive modes, exclusive writes, hashes, repository and checkout locks in `src/runtime/artifact-store.ts` and platform services | Same-user malware may still deny service or tamper between operations not covered by OS guarantees |
| Crash/PID reuse | Startup recovery validates canonical paths and process start tokens before termination/reclamation in `src/runtime/recovery-manager.ts` | Platform process metadata can be unavailable; abrupt failure may leave artifacts requiring manual inspection |
| Sensitive logs | Bounded buffers, registered sensitive environment values, pattern/field redaction, refusal to persist known secrets | Unknown, encoded, transformed, or source-level secrets may remain |

## Abuse cases

A Producer that edits `README.md` when only `src/x.ts` is allowed is rejected during candidate freezing. A Producer that claims tests passed is not trusted; the Host verifier runs the exact authorized commands in a new worktree and archives stdout/stderr. A malicious diff that tells a reviewer to ignore policy remains inside an explicitly untrusted prompt block, while the reviewer has read-only confinement. A swapped candidate is rejected when its anchor, commit/tree identity, changed-path manifest hash, run manifest, expected artifact hash, or base commit fails revalidation.

These mitigations do not validate business intent. For example, a small allowed change can add a subtle backdoor while passing all tests. Review quality and success criteria remain decisive.

## Platform-specific residual risks

The backend registry marks Codex native sandboxing certified only on macOS arm64 and tested on native Linux. Native Windows is unsupported for Codex editing, though watchdog/process-tree support exists. Every Producer/platform combination must satisfy the capability registry before editing; an unsupported or unavailable combination fails closed with no alternate-lane substitution. Provider-specific autonomy remains a residual risk, so all Producer results require independent diff and test review.

## Security conclusions

Claude Architect provides containment, provenance, and a commitment boundary, not proof that generated code is secure. The strongest guarantee is that accepted bytes should match the frozen, reviewed candidate manifest hash and must pass the configured gates. Residual risks remain from overly broad specs, prompt injection, incomplete tests, compromised local dependencies, provider handling, redaction gaps, OS sandbox defects, and unauthenticated control of the Claude/MCP session.
