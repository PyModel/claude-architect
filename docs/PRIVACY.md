# Privacy

Claude Architect is primarily a local orchestration and evidence system, but it can send repository-derived information to model providers through the Producer CLIs chosen by the user. Users should treat delegation as disclosure to the configured provider unless they have verified that the selected CLI uses a local model.

## Data stored locally

The plugin stores run state below the Claude Code-provided `$CLAUDE_PLUGIN_DATA` directory. `src/runtime/state-dir.ts` refuses to select an implicit production fallback. Typical contents include:

- `runs/<run-id>/manifest.json`, `result.json`, an optional decision record, redacted bounded stdout/stderr logs, and pipeline review/fix/verification JSON;
- records of each repository's managed worktree namespace; the worktrees themselves, including short-lived verification worktrees, live in that repository's main checkout under `.worktrees/claude-architect/`;
- lock, recovery, cleanup-journal, and quarantine/pruning state;
- Git objects and `refs/claude-architect/candidates/<run-id>` in the delegated repository, used to keep frozen candidate commits reachable.

The run manifest stores the canonical repository path, base commit, Producer id/version/model, effective and execution policies, environment variable names and provenance (not intended values), hashes of repository instruction content and the rendered prompt, packaged verifier identity, candidate manifest association, and its own manifest hash. The attempt result stores the changed-path manifest, patch, evidence, command metadata, redacted output references, and Producer summary. This data can reveal filenames, code changes, repository location, models used, test behavior, and task intent even when credentials are redacted.

Archives use restrictive creation modes, reject symlink/path escapes, bound individual reads, and use integrity checks. These controls protect against some local races; they are not encryption at rest. Any process with the user's filesystem authority may be able to read the data.

## Data sent to model providers

The initial Producer receives the objective, relevant context, success criteria, authorized/forbidden paths, and verification instructions. Because it can read files exposed within its sandbox, a CLI may include source code or other repository content in requests to its configured model. Pipeline reviewers receive at least the delegation spec, baseline and candidate identifiers, the candidate diff, and test evidence. Fixers additionally receive consolidated findings. The Claude architect session itself is governed by the privacy terms of the Claude Code/model configuration.

Codex normally contacts the OpenAI service configured by the Codex CLI. OpenCode, Pi, Pythinker, and Antigravity CLI (`agy`) are model harnesses and may contact whichever cloud or local provider the user's configuration selects; headless Claude Code (`claude`) uses the default Anthropic endpoint (`api.anthropic.com`). A local provider may keep traffic on the machine, but that depends on its endpoint and configuration. Claude Architect does not inspect TLS, pin destinations, or override provider telemetry/retention.

Verification commands run locally in a clean worktree. A command whose spec allows network may transmit repository or test data to destinations chosen by that command. Network-denied commands are only as private as the effective platform enforcement reported in verification evidence.

The opt-in Jev screen is off by default. With `CLAUDE_ARCHITECT_JEV=on` and a `TYPESAFE_API_KEY`, each otherwise autonomous acceptance sends the redacted candidate patch (first 50,000 characters) and up to 200 changed paths to `api.typesafe.ai`; retention there is governed by TypeSafe. Leave it off for code that must not reach that service.

## Environment and credentials

`src/runtime/environment-policy.ts` constructs a minimal environment from platform essentials, adapter allowlists, and explicit spec additions. Sensitive host and delegated environment values are registered with the redactor. The certified Codex invocation further configures an include-only shell environment. The design seeks to avoid forwarding credentials by default, but CLI authentication configuration under the user's home/config directories may necessarily be available to the selected CLI.

`src/runtime/redaction.ts` removes registered secret values and known credential patterns from persisted/output data. Sensitive keys in structured records are redacted, and persistence fails if a registered secret is still detected. Redaction does not recognize every secret. Short, encoded, transformed, split, unusually named, or source-embedded secrets can escape detection. Do not keep production secrets in repositories delegated to external models.

## Retention and deletion

The artifact store applies age/size pruning with crash-safe cleanup. The MCP server prunes the run archive once at startup, after crash recovery: it reclaims terminal runs older than 14 days, and the oldest terminal runs once the archive exceeds 1 GiB, while always retaining active, incomplete, and undecided runs. This bounds unattended growth but does not promise an exact retention period — a single long-lived session is not pruned until its next startup, and Git candidate refs may keep objects reachable. Local evidence otherwise remains until the next prune or user removal. Provider-side retention is controlled by the chosen model provider and account plan, not by Claude Architect.

To remove local data, first stop Claude Code and ensure no delegation is active. Uninstall/disable the plugin through Claude Code, remove its plugin data directory, and inspect/delete remaining `refs/claude-architect/candidates/*` if no audit or recovery need remains. Remove provider CLI caches, sessions, and credentials using each CLI's instructions. Deleting local data does not delete provider-side prompts, logs, or model-service records; use the provider's controls for those requests.

## User choices and limitations

Use the smallest possible context and write allowlist, choose local providers for sensitive code where appropriate, deny verification network unless required, review archived evidence before sharing it, and configure provider retention intentionally. Claude Architect provides redaction and confinement, not anonymity, end-to-end encryption of archives, data classification, or a guarantee that no repository content leaves the machine.
