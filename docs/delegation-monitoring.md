# Monitoring a backgrounded delegation

`delegate` and `delegatePipeline` are synchronous, but the host auto-backgrounds
a long call (after roughly 120s) and then surfaces only a generic "1 MCP task
still running" line; the in-band progress phases stop being visible there. A
producer alone almost always runs longer than the background threshold, so most
of a real delegation happens after the collapse. When a call backgrounds, do not
go silent — report a real status line by reading the run's durable artifacts.

Correlate the run without guessing:

1. Before dispatch, snapshot the run directories under the state dir
   (`CLAUDE_PLUGIN_DATA/runs` on a host; `CLAUDE_ARCHITECT_STATE_DIR`/tmp under
   tests). Reading these directories is read-only observation only.
2. After the call backgrounds, take the newly appeared directory whose
   `run-start.json` `canonicalCommonDir` equals this checkout's `.git` and that
   has no `result.json` yet. If more than one new matching directory appears —
   another session may be delegating against the same repository — report the
   ambiguity and do not assume which run is yours.
3. Read `runs/<runId>/pipeline/<name>.json` for the latest stage: `round-N-…`,
   `verification`, then `pipeline-result`. No pipeline artifact yet means the
   implement attempt (baseline or producer) is still running. `result.json`
   appearing means the run finished.

After backgrounding the host returns control once; emit a single Live status
line (the FleetView-style format above) then. Continuous status requires scheduled wakeups (about 75s apart, each a full
turn) — only do this when the human explicitly asks for live status, tell them it
costs a turn per update, and never poll tighter than the round cadence.

Prefer the `delegation-lane` subagent path over run-dir polling; polling remains the fallback for direct calls and for lane-report recovery via `specSha256`.

## What the host's MCP call count means

One manual run uses a two-call MCP preflight: `validateDelegationSpec` is read-only and starts no Producer; then exactly one `delegate` or `delegatePipeline` execution call may start Producers. Claude Code may group both under “Calling plugin:claude-architect:runtime 2 times”; that count is MCP calls, not Producer attempts. A plain `delegate` execution run starts exactly one Producer attempt (the implementation attempt; edit mode may first launch the same selected Producer in a separate environment-preflight probe that cannot produce candidate bytes), while a `delegatePipeline` run may start multiple fresh Producers for implementation, review, and repair after that probe. Before a direct manual lifecycle, say `Preflight 1/2 · validate only · no Producer` before validation and `Dispatch 2/2 · one execution call · one run` before execution, so “one run” is never presented as “one runtime call.”

Once the execution call is pending — including while the host shows `producer running` or after it backgrounds — never invoke `delegate` or `delegatePipeline` again, revalidate in parallel, or interpret a heartbeat as permission to retry. Wait for the original result: a second execution call creates a second run. Repair and revalidate only after the original call has returned an explicit pre-start validation or spec-identity error.
