# Claude Code (`claude`) Producer adapter — design

Date: 2026-08-27
Status: implemented in the same change

## Goal

Add a headless Claude Code session as a sixth delegation-lane Producer so the
architect (any model, including Fable) can delegate implementation to Opus or
Sonnet under the same trust invariants as every other lane: fresh context,
isolated worktree, frozen candidate, independent verification. `claude-implementer`
is a selectable lane in `skills/delegate/SKILL.md`; no protocol bump; no
changes to `src/pipeline/`, `src/verify/`, or `src/integrate/`.

This change also deepens the Producer seam so the adapter is self-contained
(see "Seam change" below). Adding this lane touched `src/producers/` and the
registry; the Seatbelt sandbox was edited only to add generic fail-closed validation
for declared writable paths (rejecting root, relative, and non-home/state-root entries).

## Evidence base

Every claim below is grounded in the installed binary (`claude` 2.1.250) —
`--help` output plus live `claude -p --output-format json` invocations run from
a scratch directory during this session. Nothing is taken from secondary docs.

### 1. Auth needs `USER` and the real HOME — not HOME-redirectable

| Environment | Result |
| --- | --- |
| `env -i HOME PATH` | `is_error:true`, `"Not logged in · Please run /login"` (exit 1) |
| `env -i HOME PATH USER` | `OK` |
| `env -i HOME=<empty temp dir> PATH USER` | `Not logged in`; the CLI created `<temp>/.claude/` and `<temp>/.claude.json` |

The OAuth credential is resolved through the login keychain (keyed by user
name) together with the `oauthAccount` record in `~/.claude.json`. So the lane
is `inherited-config-only` (same class as Pi, Pythinker, agy): real HOME, with
`USER`, `CLAUDE_CONFIG_DIR`, and `ANTHROPIC_API_KEY` forwarded by declared
policy, and `~/.claude` + `~/.claude.json` granted as writable state because
the CLI rewrites both on every run.

### 2. Nested-delegation and hidden-instruction surface — closed by argv

The obvious hazard of a Claude Producer inside a Claude session: the child
loads the user's MCP servers (including this plugin's runtime, i.e. a nested
`delegate` tool), user/project hooks, plugins, and can spawn `Agent`
subagents. Live checks:

- `--strict-mcp-config` with no `--mcp-config`: zero MCP servers.
- `--tools "Read,Edit,Write,Bash,Grep,Glob"`: the model reports exactly
  `Bash, Edit, Glob, Grep, Read, Write` — no `Agent`, no web, no artifacts.
- `--setting-sources ""`: a project `UserPromptSubmit` hook that touches a
  marker file did **not** run (it did run with `--setting-sources project` and
  with no flag); the user-level hooks did not run either (they did with
  `--setting-sources user`). It also disables `CLAUDE.md`/`AGENTS.md`
  discovery: a project `CLAUDE.md` declaring a "secret fruit" was not seen.
  The Producer therefore sees only the rendered Delegation Spec —
  `repositoryInstructionSources: []`.
- `--bare` and `CLAUDE_CODE_SIMPLE=1` would give the same isolation but force
  API-key auth (`Not logged in` under OAuth), so they are not used.
- `--no-session-persistence`: nothing resumable; `--continue`/`--resume` are
  never passed.
- The host runtime's environment policy already forwards only allowlisted
  variables, so `CLAUDECODE`, `CLAUDE_CODE_SESSION_ID`, and the messaging
  socket/token of the parent session never reach the child.

### 3. Structured output, confirmed live

`--output-format json` prints one envelope: `{"type":"result","subtype":
"success"|…, "is_error":bool, "result":string, …}`. Observed: an API-level
failure exits **1** but some paths report `is_error:true` with a `result`
message — `normalizeEvents` therefore keys on `exitCode === 0 && !is_error &&
subtype === "success" && typeof result === "string"`, and surfaces the
`result` text on failure. Warning lines can precede the envelope on the
combined stream, so the parser starts at the first `{`.

### 4. Seatbelt confinement, confirmed live

Under `sandbox-exec` with the worktree, `~/.claude`, `~/.claude.json`, and
TMPDIR writable, a `haiku` run created `made.txt` in the worktree and got
`EPERM` writing `$HOME/escape-probe.txt`. Platform ceiling: darwin/arm64 via
`macos-seatbelt`, same as Pi/OpenCode/Pythinker/agy; win32 unsupported.

### 5. Prompt on stdin

`echo <prompt> | claude -p …` works; the prompt travels on stdin like Pi and
OpenCode, keeping argv free of spec text.

## Overrides

- `producerOverrides.model` → `--model <alias|full id>` (`opus`, `sonnet`,
  `fable`, `haiku`). Absent: the CLI's configured default.
- `producerOverrides.reasoningEffort` → `--effort low|medium|high|xhigh|max`;
  any other value throws before spawn (the CLI would reject it after burning
  the attempt window).

## Seam change (producers module)

Before this change the Seatbelt backend decided which host directories a
Producer could write by sniffing `basename(executable)` and `requiredEnv`
names — four producer-specific functions inside `src/platform/sandbox/`. An
adapter the sandbox did not recognize silently ran with no state access, and
every new lane had to edit the sandbox.

Now `ProducerInvocation.inheritedStateWritablePaths` is the declaration: each
adapter states its own auth/config/state paths, and the sandbox validates each
entry (requiring absolute paths under home or a declared state root, never `/`)
and grants exactly those when no temporary home is in effect. Depth moved to the right side of the
seam — the sandbox knows nothing about Producers, and the adapter is the single
place that knows where its CLI keeps state. The four OS-confined CLI probes
also collapsed into `probeOsConfinedCli` (resolve → `--version` → optional
surface check → confinement backend → auth), with Pythinker's `--help`
inspection supplied as a hook.

## Architect-side Claude subagents (not Producers)

Separately, the delegate skill now states which roles a Claude subagent
dispatched through the host `Agent` tool (Opus or Sonnet) may take: scout,
spec drafter, candidate reviewer (`agents/candidate-reviewer.md`, read-only +
`reviewCandidate`), and advisor. None of them edit the checkout or call
`decideCandidate`/`integrateCandidate`; an Opus/Sonnet *implementer* is the
`claude-implementer` lane, never a bare subagent.

## Verification

- `tests/runtime/claude-adapter.test.ts`: probe, auth resolution (OAuth file,
  `CLAUDE_CONFIG_DIR`, API key), exact argv, tool allowlist, read-only tools,
  overrides, writable-state declaration, Seatbelt wrap, envelope parsing
  (success, `is_error` with exit 0, non-success subtype, non-zero exit,
  truncation, non-envelope JSON), configuration profile.
- Opt-in real smoke (`CLAUDE_ARCHITECT_CLAUDE_SMOKE=1`, darwin/arm64): a
  confined headless attempt on `haiku` creates `smoke.txt` in an isolated
  worktree.
- Seatbelt tests now prove the declaration seam (grants exactly the declared
  paths; ignores them under a temp home; never derives paths from executable
  identity or env names); each adapter test asserts its own declaration.
