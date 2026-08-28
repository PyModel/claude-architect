# Architecture

Claude Architect is a Claude Code plugin that turns a bounded implementation request into a reviewable candidate artifact. Claude remains the architect: it creates the Delegation Spec, selects a Producer, reviews evidence, and presents the acceptance decision. External coding CLIs are untrusted Producers. Their edits are never treated as accepted merely because the CLI exits successfully.

## Runtime shape

The plugin manifest is `.claude-plugin/plugin.json`; the packaged MCP entry point is `runtime/bootstrap.mjs`, which locates a suitable Node.js runtime and starts `runtime/server.mjs` over stdio. The TypeScript source is under `src/`. `src/mcp/server.ts` exposes `validateDelegationSpec`, `delegate`, `delegatePipeline`, `reviewCandidate`, `decideCandidate`, `integrateCandidate`, `doctor`, and four bounded Git read tools.

The normal MCP flow is:

1. `validateDelegationSpec` validates a versioned spec containing an objective, context, write allowlist, forbidden scope, success criteria, Producer preferences, timeout, and explicit verification commands, then returns the runtime's canonical `specSha256` without starting a Producer. `delegate` revalidates the same contract at dispatch and, when the caller supplies `expectedSpecSha256`, rejects a different valid spec before checkout access or Producer execution.
2. `src/runtime/attempt-runtime.ts` checks repository preconditions, selects an eligible Producer, creates a detached Git worktree under the plugin data directory, builds a sanitized environment, and supervises the Producer.
3. `src/git/candidate-tree.ts` inventories all changes, rejects paths outside the allowlist or inside forbidden scope, rejects unsafe symlink/submodule conditions, writes a Git tree and commit, and anchors it at `refs/claude-architect/candidates/<run-id>`.
4. The candidate's sorted changed-path manifest is SHA-256 hashed. `src/verify/acceptance-verifier.ts` performs structural checks and runs Host-authorized verification in a separate worktree created by `src/verify/project-verifier.ts`.
5. `src/runtime/artifact-store.ts` freezes the result, run manifest, redacted logs, and pipeline reports under `$CLAUDE_PLUGIN_DATA/runs/<run-id>/`.
6. `reviewCandidate` regenerates the exact binary/full-index patch from the anchored candidate tree and returns it with changed paths and verification evidence.
7. `decideCandidate` records `accepted`, `rejected`, or `revision-requested`. Only a verified candidate may be accepted.
8. `integrateCandidate` requires an accepted decision and the exact candidate manifest hash. `src/integrate/controlled-integrator.ts` rechecks base, anchor, tree, hash, and repository cleanliness, then applies the tree to the index and worktree. It does not commit.

## Fresh-context pipeline

`delegatePipeline` adds correctness and systems review rounds, optional fix rounds, gates, and a final clean-room verification. `src/pipeline/role-prompts.ts` labels candidate diffs and test evidence as untrusted data. Each reviewer and verifier is launched as a new Producer invocation; read-only roles receive an empty write allowlist, `forbiddenScope: ["**/*"]`, and a read-only sandbox request. A fixer receives the original bounded write policy. This is fresh process/model context, not a mathematical guarantee that a provider retains no server-side state.

## Platform and Producer model

The Codex adapter uses Codex's native sandbox, requests `workspace-write`, disables network, constrains shell environment inclusion, disables multi-agent delegation, and uses ephemeral configuration. The backend table in `src/platform/sandbox/backends.ts` marks native macOS arm64 Codex as certified, native Linux as tested, and native Windows as unsupported for the edit lane. The macOS Seatbelt backend is used by other MCP adapters where eligible. Linux confinement fails closed when the required backend is unavailable. Windows process supervision uses the packaged watchdog/helper, but this is not a certified Windows Codex edit sandbox.

OpenCode, Pi, Pythinker, Antigravity CLI (`agy`), and headless Claude Code (`claude -p`) use the same validated MCP attempt lifecycle and remain subject to adapter and platform eligibility checks. A requested Producer with no eligible confinement backend is unavailable: the runtime fails closed instead of selecting an unconfined path or substituting a different Producer. Certification claims remain specific to the Producer, platform, and backend reported by the capability registry.

## State and recovery

`CLAUDE_PLUGIN_DATA` is mandatory outside tests. It contains `runs/`, `worktrees/`, and lock/recovery state. Archives use restrictive file modes, no-follow checks, bounded reads, atomic create/link or rename patterns, and integrity hashes. Startup recovery in `src/runtime/recovery-manager.ts` validates directory identity and process start tokens before terminating or reclaiming stale work. Git candidate refs keep frozen commits reachable until rejection, successful integration, or pruning.

The architecture reduces the authority of a Producer; it does not make generated code trustworthy. Human review and the final integration boundary remain essential.
