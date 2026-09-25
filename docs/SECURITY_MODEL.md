# Security Model

Claude Architect treats repository content, Producer output, model text, and command output as untrusted. The Host runtime and the human-controlled Claude session form the control plane. The main security objective is to prevent an implementation Producer from silently expanding its scope or causing unreviewed bytes to enter the user's checkout.

Each invariant named here has exactly one owner in the source; the mapping is
[ARCHITECTURE.md § Who owns each trust invariant](ARCHITECTURE.md#who-owns-each-trust-invariant).

## Components that execute code

`runtime/bootstrap.mjs` executes Node.js and starts the MCP server. The Host runtime invokes `git`, the selected Producer CLI (`codex`, `opencode`, `pi`, `pythinker`, or `agy`), OS confinement helpers such as `/usr/bin/sandbox-exec` on supported macOS systems, Linux sandbox tooling when selected, and the packaged Windows watchdog/helper. Verification executes only commands listed in the validated Delegation Spec.

Producer commands are built by adapters in `src/producers/`; user-controlled values are passed as argv rather than interpolated shell programs. Executables are resolved through platform services. Verification commands include an executable, argv, relative cwd, timeout, network policy, expected exit codes, optional environment, platform filters, and mutation policy. There is no general MCP “run arbitrary shell” tool.

## Authorization and write confinement

The architect supplies explicit `writeAllowlist` and `forbiddenScope` entries. The Producer works in a detached worktree, not the user's checkout. After execution, `src/git/candidate-tree.ts` inventories tracked, untracked, and ignored changes and rejects unauthorized paths. This post-run check complements, but does not replace, OS sandboxing. Nested delegation is denied by the `CLAUDE_ARCHITECT_DELEGATED` marker and MCP startup refuses to run when that marker is present.

Codex receives its native `workspace-write` or `read-only` sandbox. The supported backend table is fail-closed: macOS arm64 is certified, Linux is tested, and native Windows Codex editing is unsupported. Every other Producer must likewise pass its adapter and platform capability checks; lack of an eligible backend makes the requested edit unavailable and never authorizes an unconfined substitute.

## Network access

Codex edit and read-only invocations request no network (`sandbox_workspace_write.network_access=false`). Each verification command declares `network: denied` or an allowed policy; the verifier reports the requested and effective enforcement. A command is not evidence of network denial if the selected platform cannot enforce it. Producer CLIs may contact their configured cloud model service, and local providers may contact configured local endpoints. The plugin has no fixed hostname allowlist and does not proxy model traffic. Provider authentication, transport, and retention remain the provider/CLI operator's responsibility.

## Files read and written

The runtime reads the selected Git repository, Git metadata, applicable repository instructions such as worktree `AGENTS.md`, plugin schemas/runtime files, Producer configuration needed by the CLI, and verification inputs. The Producer can read files visible through its sandbox and worktree; repository secrets committed or present in readable paths may therefore reach the Producer model.

Writes are limited to the isolated worktree, plugin data state, Git candidate refs, locks, logs, and—only after acceptance—the target checkout/index. Verification runs in a separate materialized worktree. Integration stages the candidate tree and modifies working-tree files but does not create a commit.

## Workflow state and artifacts

Outside tests, state resolves only from `$CLAUDE_PLUGIN_DATA`. Runs are archived at `$CLAUDE_PLUGIN_DATA/runs/<run-id>/`; managed worktrees are under `<main checkout>/.worktrees/claude-architect/`, a self-ignoring namespace recorded in the plugin data root so recovery can find it; locks and recovery records are also beneath the plugin data root. A run contains a sanitized `manifest.json`, `result.json`, decision record when present, bounded redacted logs, and pipeline JSON. Candidate commits are anchored under `refs/claude-architect/candidates/` in the repository. The run manifest hashes its canonical body, prompt, repository instructions, packaged verifier, execution policy, environment provenance, and candidate manifest association. The candidate manifest hash is SHA-256 over the normalized changed-path records; content hashes and Git object identities provide additional anchoring.

## Fresh-context isolation and reviewers

Pipeline roles are separate one-shot Producer invocations. Reviewer prompts explicitly treat diff and evidence blocks as untrusted. Correctness reviewers, systems reviewers, and the final verifier are configured read-only with no allowed writes and all paths forbidden; the Codex adapter requests its native read-only sandbox. The fixer is the only pipeline role permitted to edit, using the original policy. “Fresh context” means a new invocation with a role-specific prompt; it does not guarantee provider-side statelessness.

## Decision authority and authentication

`decideCandidate` is an MCP tool available to the controlling Claude session. The runtime refuses acceptance unless the result is a verified candidate, and records how every decision was reached as `decidedBy`.

Whether a person is prompted is governed by `CLAUDE_ARCHITECT_DECISION_AUTHORITY`. Unset or `autonomous` (the shipped default) records `accepted` without prompting only for an independently verified `delegatePipeline` candidate carrying a well-formed `pipelineGateCleared` record bound to the archived candidate commit, with `requiresHumanDecision:false`, no failure or advisory warnings, and a readable archive, marking it `policy-autonomous`. Autonomy additionally requires that every executed verification command ran under an OS confinement backend (so off macOS every decision needs a person), and a plain `delegate` candidate qualifies only when it leaves verification inputs untouched. The opt-in Jev screen (`CLAUDE_ARCHITECT_JEV=on`) sends the redacted patch and changed paths to the TypeSafe API and can only turn an autonomous acceptance into a human prompt. Plain `delegate` that changes verification inputs, refusal, incomplete review, malformed or mismatched clearance, non-accept verdicts, and every decision under `human` open an MCP elicitation request and write the decision only when the response both accepts the request and explicitly confirms it; a client without elicitation support, an unconfirmed response, or an elicitation failure leaves the candidate undecided. An unrecognized value for the variable fails closed to `human` with a warning.

Integration accepts `human-elicitation` and `policy-autonomous` provenance. It refuses provenance the runtime cannot vouch for: `caller-asserted` records, and provenance-less records predating the field. It also refuses any acceptance that does not name the exact manifest hash it is spent on. Autopilot promotions record `autopilot-policy` provenance and are refused outright under the `human` authority. Decision records are immutable: a confirmation whose provenance or candidate binding differs from an existing record returns `decision-conflict` rather than claiming it replaced the older one.

Elicitation, where it applies, is an enforced channel boundary, not cryptographic human identity. The plugin does not implement a separate login, signature, or hardware confirmation, and it relies on the MCP host to present elicitation faithfully. A compromised or modified host/client could synthesize a confirmation, so control of that trusted client remains equivalent to decision authority.

## Atomic candidate integration

Integration requires a stored accepted decision and an exact `expectedArtifactHash`. It revalidates the archive, canonical repository identity, base commit, candidate ref/commit/tree, structural identity, and clean preconditions while holding repository locks. Git `read-tree -m -u` applies the complete candidate tree, followed by staged-tree, HEAD, worktree, and status checks. Archive writes use exclusive creation and atomic rename/link patterns. This is a guarded tree application, not a transaction across arbitrary external processes; filesystem or Git failures can return `conflicted` or `aborted` and require inspection.

## Logging and redaction

Output is bounded and archived through `ArtifactStore`. Environment variables with sensitive names are registered as secrets; common token formats, registered values, and sensitive record fields are redacted. Persistence fails when a registered secret cannot be safely removed. Logs use restrictive modes and reject symlink/path escapes. Redaction is pattern-based and cannot guarantee removal of every secret, especially secrets with unusual names, transformed/encoded values, or sensitive source text that is not recognized as a credential.

## What data leaves the machine

The Delegation Spec, selected repository context, Producer prompt, and any file/output the Producer reads and includes in requests may leave the machine for the configured model provider. Pipeline reviewers may receive the candidate diff and test evidence. Verification commands can send data only when their network policy is allowed and actually enforced as such. Git and local runtime operations do not inherently upload data. See `PRIVACY.md`.

## Uninstall and data removal

Disable/remove the plugin through Claude Code's plugin manager, then remove its installed/cache copy according to Claude Code documentation. Uninstalling code may not remove `$CLAUDE_PLUGIN_DATA`, Git candidate refs, provider CLI configuration, or provider-side records. After ensuring no run is active, users may remove the plugin data directory and inspect/delete `refs/claude-architect/candidates/*` with Git. Remove provider CLI credentials separately. Back up accepted evidence first if audit retention is required.

## Known limitations

- Only native macOS arm64 Codex is certified; Linux is tested, and native Windows Codex edit confinement is unsupported.
- Producer edit availability is capability-gated and fails closed; certification is specific to the reported Producer, platform, and confinement backend.
- Prompt injection can influence a model despite role prompts; confinement limits consequences but does not prove semantic correctness.
- Read access may expose repository secrets to a remote provider.
- Redaction is best effort, not data-loss prevention.
- A compromised Producer CLI, Node.js, Git binary, OS account, or Claude session can attack outside assumptions.
- Allowlist validation occurs after execution as well as through sandbox policy; a missing/defective OS boundary is not repaired by post-run detection.
- Acceptance is not cryptographically authenticated — a verified candidate is accepted by policy without a person under the default authority — and integration does not commit or merge.
