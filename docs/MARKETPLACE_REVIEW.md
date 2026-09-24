# Marketplace Review Summary

Claude Architect is maintained by Mohamed Elkholy (`elkaix`) and published from `PyModel/claude-architect` under the MIT license. It is a Claude Code plugin for delegating bounded implementation tasks to external coding CLIs while keeping review, acceptance, and integration under the trusted Host runtime, Claude architect, and human operator.

## What the plugin does

The plugin validates a versioned Delegation Spec, selects an eligible Producer, creates an isolated detached Git worktree, supervises the Producer, rejects changes outside an explicit write allowlist or inside forbidden scope, freezes the result as an anchored Git candidate, computes a SHA-256 candidate manifest hash, independently reruns authorized verification in a separate worktree, and returns evidence for review. Non-trivial work can use fresh-context correctness/systems reviewers, a bounded fixer, and a read-only clean-room verifier.

No Producer can mark its own work accepted. `decideCandidate` records a provenance-bearing decision under the configured authority; `integrateCandidate` requires an accepted record with integrable provenance and the exact manifest hash, revalidates the candidate and base, and stages the candidate tree. It does not commit, merge, push, publish, or deploy.

## Component inventory

- Skill: `/claude-architect:delegate` in `skills/delegate/SKILL.md`.
- Read-only advisor: `advisor`.
- MCP tools: `validateDelegationSpec`, `delegate`, `delegatePipeline`, `reviewCandidate`, `decideCandidate`, `integrateCandidate`, `doctor`, `gitStatus`, `gitDiff`, `gitLog`, and `gitChangedFiles`.
- Packaged runtime: `runtime/bootstrap.mjs`, `runtime/server.mjs`, schemas, and Windows watchdog/helper support.
- Host modules: protocol validation, Producer adapters/routing, platform sandbox/process supervision, Git worktree/candidate handling, verification, pipeline gates, artifact storage/recovery, and controlled integration.
- Plugin hooks: none declared. The repository's `.githooks/pre-push` is contributor tooling, not a marketplace-installed Claude hook.

## Executables invoked

The plugin starts a suitable `node` executable and uses `git`. Depending on the chosen Producer it may invoke `codex`, `opencode`, `pi`, or `pythinker`. Platform confinement/supervision can invoke macOS `/usr/bin/sandbox-exec`, Linux sandbox tooling such as `bwrap` when that backend is selected, and Windows watchdog/helper binaries. Verification invokes only the executable and argv explicitly authorized in the Delegation Spec. The plugin does not expose an unrestricted shell MCP tool.

## Supported operating systems

The plugin is designed for macOS, Linux, and Windows process/runtime operation. Security capability is narrower than basic runtime compatibility: the Codex MCP edit path is certified on native macOS arm64 with `codex-native-sandbox`; native Linux is marked tested; native Windows Codex editing is unsupported and must fail eligibility checks. Every Producer/platform combination is capability-gated. An unavailable combination fails closed without unconfined execution or substitution, and certification must not be inferred across Producers, backends, or operating systems.

## Network destinations

There is no plugin-maintained fixed destination list. A cloud Producer CLI contacts the provider configured by that CLI: Codex normally uses its configured OpenAI service; OpenCode, Pi, and Pythinker can use various cloud or local endpoints. Claude Code separately contacts its configured Anthropic/model service. Verification commands may contact destinations only when their spec allows network, subject to effective platform enforcement. Codex's coding sandbox is configured with network disabled. Provider authentication, telemetry, transport, and retention are governed by the selected CLI/provider.

## Persistent state locations

Production state is rooted at `$CLAUDE_PLUGIN_DATA`; the runtime refuses an implicit fallback. Runs, decisions, manifests, bounded redacted logs, and pipeline reports live under `runs/<run-id>/`. Managed and verification worktrees, locks, recovery records, and cleanup journals also live below the plugin data root. Frozen candidates create Git objects and namespaced refs under `refs/claude-architect/candidates/` in the user's repository. Producer CLIs retain their own configuration, credentials, caches, or provider-side records independently.

## Permission model

The architect must specify repository-relative write allowlists and forbidden scopes, Host-authorized verification commands, timeouts, network policy, and expected exit codes. Producers execute in detached worktrees with sanitized environments. Certified Codex runs use native `workspace-write` confinement, no network, ephemeral/ignored user configuration, and disabled child-agent delegation. Reviewers and the final verifier use fresh invocations with an empty write allowlist, all paths forbidden, and read-only sandboxing. Post-run structural checks reject unauthorized changes even if a Producer reports success.

The Host runtime can read the selected repository and Git metadata; it writes plugin state, temporary worktrees, candidate refs, and—after acceptance—the target checkout/index. It does not automatically commit. Readable source or secrets may be transmitted by a configured cloud CLI, so users should minimize context and avoid delegating secret-bearing repositories.

## Decision and human approval points

The user chooses the Producer when none is named. After a verified candidate or pipeline evidence bundle is returned, the architect must show/review the evidence and call `decideCandidate` with `accepted`, `rejected`, or `revision-requested`. Under the shipped `autonomous` authority, the runtime records `accepted` without prompting only for an independently verified `delegatePipeline` candidate carrying durable gate clearance bound to the archived candidate commit, with no failure, human requirement, or advisory warning. Plain `delegate`, gate-refused, review-incomplete, malformed or mismatched evidence, non-accept verdicts, and every decision under `human` require positive MCP elicitation and fail closed without it. Only a recorded `accepted` decision with integrable provenance enables `integrateCandidate`, and integration additionally requires the exact candidate manifest hash. MCP elicitation is not cryptographic human authentication: a compromised or modified trusted host/client could synthesize confirmation. Final commit, merge, push, or release remains a separate human-controlled action.

## Threat-model summary and limitations

Primary threats are malicious Producer output, prompt injection in repository/diff content, a compromised Producer CLI, scope escape, forged test claims, candidate substitution, state races, credential leakage, and unauthorized acceptance. Mitigations include versioned validation, OS sandboxing where eligible, detached worktrees, environment minimization, timeouts/process-tree cleanup, post-run allowlist checks, Git object anchoring, manifest hashes, separate Host verification, read-only fresh reviewers, bounded/redacted archives, crash recovery with process start tokens, and hash-gated integration.

Known limitations are material: only macOS arm64 Codex is certified; Linux is tested and native Windows Codex editing is unsupported; other Producer/platform combinations depend on reported capability and eligibility; prompt injection and subtle malicious code can pass review/tests; provider retention is outside plugin control; redaction is best effort; same-user or host compromise is out of scope; policy acceptance is not proof of safety; and elicited decisions are not cryptographically authenticated.

## Installation

1. Install/enable the Claude Architect plugin from its Claude Code marketplace entry.
2. Restart or reload Claude Code so the packaged MCP server is registered.
3. Install and authenticate at least one supported Producer CLI. For the certified lane, use a supported Codex CLI on native macOS arm64 and confirm `doctor` reports `codex-native-sandbox` with edit eligibility.
4. Run the plugin's `doctor` MCP surface (or the corresponding Claude workflow) to inspect Node, Git, Producer, platform, and confinement status before delegating.
5. Invoke `/claude-architect:delegate`, choose a Producer, and review the generated scope and verification plan.

Exact marketplace CLI syntax can vary by Claude Code release; use the current Claude Code plugin-manager documentation rather than copying an unverified command.

## Uninstallation and data removal

1. Finish or cancel active runs and close/reload Claude Code.
2. Disable/uninstall Claude Architect through the Claude Code plugin manager.
3. If evidence retention is not required, remove the plugin's `$CLAUDE_PLUGIN_DATA` directory after confirming its exact path.
4. Inspect and delete stale `refs/claude-architect/candidates/*` with Git when those frozen candidates are no longer needed. This may make unreachable Git objects eligible for normal Git garbage collection.
5. Remove each Producer CLI's credentials, configuration, sessions, and caches separately if desired, and use provider account controls for remote data deletion.

Uninstalling plugin code alone does not guarantee removal of local run archives, Git candidate refs, CLI credentials, or model-provider records.
