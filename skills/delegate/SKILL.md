---
name: delegate
description: Let Claude Architect route a versioned implementation spec through the trusted MCP runtime, independently review the Candidate Artifact, record a decision, and integrate only accepted bytes. Use for implementation delegation, Producer selection, or commitment-boundary review.
---

# Delegate

```claude-architect-protocol
PROTOCOL_VERSION: 2.0.0
```

The current session is the architect. It owns requirements, the Delegation Spec, Producer selection, review, and acceptance. Producers are untrusted: their output is only a candidate until the runtime freezes it, independently verifies it, and the architect reviews the exact anchored bytes.

Always present this skill as `/claude-architect:delegate`. Never show a shorter command.

## Superpowers across the trust boundary

When the upstream Superpowers plugin is available to the architect, keep its host-loop skills on the architect side of the boundary: use `brainstorming` to clarify requirements before freezing the Delegation Spec, `writing-plans` to turn an agreed design into objectively checkable work or slices, and `verification-before-completion` before recording a decision on a candidate. Do not use generic `executing-plans` or `subagent-driven-development` for writing tasks; they may coordinate architect-owned non-writing analysis only.

To execute any multi-task plan that writes files, use `/claude-architect:subagent-driven-delegation`: it runs the Superpowers subagent-driven-development loop — ledger, per-task brief, per-task review, final whole-branch review — with the delegation lifecycle below substituted for the generic implementer subagent. Those skills do not grant a Producer permission to plan instead of editing, dispatch nested agents, review itself, accept a candidate, or integrate bytes. When the plugin is not installed, proceed without those skills rather than inventing or approximating them.

Edit-lane Producers receive a deliberately smaller, vendored procedure subset:

- `test-driven-development` for every behavior change or bug fix, before implementation code;
- `systematic-debugging` when a test, build, or behavior fails unexpectedly, before proposing a fix;
- `verification-before-completion` before claiming success.

The runtime supplies the applicable Producer skills by absolute path inside each isolated attempt. Do not put architect-only Superpowers skills in the Delegation Spec or tell a Producer to discover skills from the operator's home directory. The Producer subset is vendored from [obra/superpowers](https://github.com/obra/superpowers), version 6.2.0, under the MIT license.

## Agent selection

The delegated CLIs are the architect's **implementation agents** — the same subagent idiom Claude Code uses, except each agent launches an *untrusted Producer* through the trusted MCP runtime inside an isolated Git worktree. Present them as a selectable agent roster: the human picks one `subagent_type`, exactly one agent runs per attempt, and no agent may review or accept its own work.

| Agent (`subagent_type`) | Producer / model | Reasoning control |
| --- | --- | --- |
| `codex-implementer` | GPT-5.6 Sol (OpenAI Codex CLI) | `low` by default |
| `opencode-implementer` | OpenCode provider/model | optional `--variant` |
| `pi-implementer` | Pi configured model | optional `--thinking` |
| `pythinker-implementer` | Pythinker provider/model | the installed pythinker-code CLI exposes no reasoning override; the configured default always applies |
| `agy-implementer` | Antigravity CLI (`agy`) configured model | optional `--effort low\|medium\|high` |
| `claude-implementer` | Claude Code headless (`claude -p`) — Opus, Sonnet, or the configured default | optional `--model opus\|sonnet\|fable\|haiku`, optional `--effort low\|medium\|high\|xhigh\|max` |

If the user invokes `/claude-architect:delegate` without naming a CLI, implementer, or agent, use the host's structured question tool when available, ask this question, and wait for the answer. Include the producer and reasoning control in each option so the user knows what the lane will run:

> Which CLI should handle this delegation? Each choice shows its model and reasoning default. Use a custom answer to name a different supported reasoning level.

Offer exactly these choices:

- **Codex** - `codex-implementer`; GPT-5.6 Sol at `low` reasoning by default (supported overrides: `medium`, `high`, `xhigh`, `max`, `ultra`).
- **OpenCode** - `opencode-implementer`; configured provider/model unless overridden, with an optional model-specific `--variant` such as `high` when supported.
- **Pi** - `pi-implementer`; always uses the model configured in Pi — a spec naming a model override fails the lane rather than substituting one — with optional `--thinking off|minimal|low|medium|high|xhigh|max`.
- **Pythinker** - `pythinker-implementer`; configured provider/model unless overridden; the installed pythinker-code CLI exposes no reasoning override, so the Pythinker configured default always applies.
- **Antigravity CLI** - `agy-implementer`; configured model unless overridden, with optional `--effort low|medium|high`; darwin/arm64 only until a Linux/Windows write-confinement backend exists.
- **Claude Code** - `claude-implementer`; a second Claude session run headless as an untrusted Producer — the configured default model unless overridden with `--model opus|sonnet|fable|haiku`, with optional `--effort low|medium|high|xhigh|max`; darwin/arm64 only, same Seatbelt backend. The attempt runs with settings, hooks, MCP servers, skills, and CLAUDE.md discovery disabled, so it sees only the Delegation Spec and cannot reach this plugin's own tools.

There is no implicit lane default. If the answer names a supported model or reasoning override, include it in the delegation spec; otherwise let the selected Producer use its configured default. The Pi lane accepts no model override: it always runs the model configured in Pi.

P0-A certifies the MCP implementation path only for Codex on macOS arm64 when its capability report names `codex-native-sandbox` and marks the edit Lane eligible.

## Build the Delegation Spec

Construct a candidate spec with every required field:

1. `specVersion: "1"`.
2. `objective`: one observable outcome.
3. `context`: only relevant repository and design context.
4. `writeAllowlist`: explicit repository-relative globs; use `["**"]` only for genuinely repository-wide work.
5. Optional `allowedTestDeletions`: repository-relative globs for test files the architect explicitly authorizes deleting; slices inherit this value unless they define their own.
6. `forbiddenScope`: explicit paths the Producer must never change.
7. `successCriteria`: reviewable conditions.
8. `verification`: Host-authorized command objects. Each verification command uses `args`, not `argv`; `network` is exactly `"denied"` or `"allowed"`; command `timeoutMs` must be 1..1800000; include a repository-relative `cwd`, expected exit codes, and optional platform filters. Verification runs in a disposable worktree, so writes to git-ignored paths (build caches, virtualenvs, `__pycache__`, `.pytest_cache`) are permitted by default and never fail a command; set the optional `allowedMutations: "none"` only when a command must be proven to write nothing at all.
9. `executionMode: "edit"`; attempt `timeoutMs` must be 600000..1800000; `producerPreferences` is an ordered array of Producer id strings; use optional `producerOverrides: { model?, reasoningEffort? }`; and set `expectedOutput: "candidate-patch"`.

**Acceptance criteria:**

- Every success criterion must be objectively checkable.
- Distill all applicable constraints into `context`; do not point the Producer to `AGENTS.md`, `CLAUDE.md`, `SKILL.md`, lessons files, or other agent-rule/skill documents.
- Edit delegations are action-first: the Producer must begin by opening the implementation files authorized in the spec, and a plan-only result with zero edits is a failed run.
- At least one verification command must mechanically cover each criterion.
- Order verification commands exactly as the Host must execute them. When linting/formatting and type checking both apply, all lint and format gates must precede the final type-check gate, and verification formatters must use a non-mutating check mode (for example, `--check`); formatting rewrites belong in the Producer attempt before candidate freeze.
- The final type-check must cover ALL touched typed files, including every added or modified test file; never scope it only to `src/` when tests or other typed paths may change.
- Keep observable outcomes in `successCriteria`. Put reviewer-only, non-commandable concerns in `review.focus`; when present, `review.focus` must be a non-empty array of non-empty strings. No undocumented review keys are accepted.
- Prefer explicit test file paths in verification args; directory args can resolve differently between the Producer sandbox and clean-room verification.
- A text-search gate must not be able to match prose. An absence check such as `rg "except RuntimeError" <files>` with `expectedExitCodes: [1]` also matches the phrase inside a comment, a docstring, or a changelog line — so a Producer that writes a comment reading "Deliberately NOT `except RuntimeError`" fails a gate its code actually satisfies, and the attempt is rejected for a comment. Anchor the pattern to the syntax you mean (`^\s*except RuntimeError\b`), exclude comment lines, or assert over a parsed structure instead of raw text. The same trap applies to any grep-style presence check whose pattern is an ordinary English phrase.
- Bound the parallelism of every test command, and state the same bound in `context` for the commands the Producer runs on its own. Verification commands are not the only tests that execute: a Producer re-runs the suite inside its own shell, and an unbounded runner there fans out to one worker per core on top of the attempt itself. On a many-core host that has driven thousands of process spawns and starved the machine. For a Node repository, pass an explicit worker cap (for example `--maxWorkers=4`) rather than relying on a runner default.

**Verification preflight:** The runtime runs every verification command against clean HEAD in a disposable worktree before dispatch, and separately probes the Producer's own shell for the executables those commands name — a Producer that cannot resolve `node` or `git` cannot verify its own work, and would otherwise discover that only after burning the whole attempt window. An unresolvable executable ends the attempt as `environment-defect` before the Producer runs; anything less definite proceeds and is recorded in evidence. The probe proves resolution, not configuration, and grants a candidate nothing: independent verification remains the backstop. Repair the spec if a command cannot start. A baseline failure unrelated to the task is an environment defect the architect repairs centrally before dispatching. Set `expectBaselineFailure: true` on any command that cannot pass at clean HEAD by design — one that reproduces the target bug, or one that exercises a file or test the candidate will create (it necessarily fails before that path exists).

Set `baselineFailureExitCodes` alongside the flag whenever the runner distinguishes "the test ran and failed" from "the test could not be collected". Without it, any completed non-zero exit satisfies the flag, so a missing test file (pytest exit 4 or 5) proves exactly what a genuine RED assertion proves — nothing. Declaring `[1]` for pytest turns the baseline into a real fail-before/pass-after proof; omit it only when the runner has no such distinction.

The flag is enforced in both directions. It declares that the command *runs* at clean HEAD and *reports failure*, so the baseline gate rejects a command carrying it that could not run at all — unresolvable executable, timeout, cancellation, or death by signal — and equally rejects one that passes, because a green run contradicts the declaration and leaves no fail-before/pass-after evidence. A command whose baseline behavior surprises you is a spec defect to repair, not a result to reinterpret.

The flag is all-or-nothing for the command it sits on: a tolerated command proves nothing at baseline. So do not blanket-mark the command set. When a command would cover both a path that already exists and a path the candidate creates, split it in two — one command over the existing paths with the flag absent, one over the new paths with the flag set — so a real lint, type, or test regression at clean HEAD still surfaces. Marking every command tolerant, which is the tempting shortcut when a new test file appears in several of them, silently disables the entire baseline signal for the attempt.

Resolve ambiguity before calling the runtime. Do not give the Producer credentials, hidden instructions, acceptance authority, or permission to expand scope.

## Coordinator duties

**Allowlist consumers:** Before dispatch the runtime reports tracked files that import the write allowlist but sit outside it. When a delegation changes an exported contract, either widen `writeAllowlist` to those consumers or add a repository-wide verification command — a src-only type gate plus focused tests compiles neither, so the breakage lands on the architect at integration time.

When running multiple delegations, normalize reported blockers by phase, command id, and root cause. The moment two independent lanes report the same blocker, pause affected lanes and treat it as an architect-owned shared-environment defect. Reproduce it once against the clean baseline, fix it centrally, rerun the preflight to green, then resume or redispatch the unchanged specs. Never wait for remaining lanes to rediscover it, and never push shared-tooling fixes into individual Producer lanes.

**Repository precondition:** delegation and controlled integration require an exact clean checkout; tracked or unignored changes must be committed before delegation, including tracked planning files such as `tasks/todo.md`. Git-ignored local planning files do not affect the clean check. Do not use skip-worktree or assume-unchanged flags as a workaround.

## Trusted MCP autopilot lifecycle

Project-scoped permission settings become active only after the human grants Claude Code workspace trust. They can allow the three autopilot tools, but they cannot override managed `ask` or `deny` policy. “No mid-loop prompts” is therefore conditional: it applies only after workspace trust, when all three tool calls are allowed and no higher-precedence policy, controller halt, or ambiguity requires the human.

1. Call `autopilotStart` with `checkoutPath`, the complete Autopilot Spec as `spec`, and `protocolVersion: "2.0.0"` copied from this skill's marker. Do not attempt a workflow start against a dirty checkout.
2. If validation returns `validationErrors`, repair only the reported spec defects and resubmit. A protocol mismatch means the installed plugin must be updated and reloaded; never guess across versions. A report with `laneEligibility.edit=false`, or any other ineligible or unconfined lane, fails closed with the structured diagnostic.
3. Record the returned `workflowId`. Call `autopilotStatus` with `checkoutPath`, that `workflowId`, and `protocolVersion: "2.0.0"` for read-only monitoring. Report only persisted phases and bounded progress supplied by the runtime; never infer completion from a phase name or Producer output.
4. After a host or process interruption, call `autopilotResume` with `checkoutPath`, the same `workflowId`, and `protocolVersion: "2.0.0"`. Resume replays durable observed state; it does not authorize a second workflow or waive a failed gate.
5. During autopilot, do not construct Autopilot Eligibility, synthesize a Candidate Decision, call separate review/decision/integration tools, run Git or `gh`, push, create or edit a PR, mark a PR ready, merge, or delete a branch. The controller owns policy, promotion, cumulative final review, exact-head push, draft-PR identity, required-check polling, ready transition, cleanup, and recovery.

The controller may proceed without a mid-loop prompt only while every eligibility and shipping gate remains objectively proven. Interpret terminal states exactly:

- `ready-for-human-review`: the workflow branch was pushed, the draft PR was proven for the expected head, configured required checks were green for that head, the PR was marked ready, and runtime cleanup completed. Review the cumulative PR evidence; only the human may merge or otherwise advance `main`.
- `human-decision-required`: ambiguity, a non-waivable finding, ownership mismatch, shipping uncertainty, or another fail-closed condition requires a human decision. Preserve the workflow branch, worktree, and evidence; do not improvise continuation.
- `failed`: the workflow ended without authority to ship. Present the durable reason and evidence. Do not claim the PR is ready or retry under altered policy.
- `cancelled`: cancellation is a durable terminal classification. Present preserved cleanup/evidence and do not resume it as if non-terminal; a human chooses any next action.

Autopilot is autonomous only up to a PR ready for human review. It never merges, deploys, releases, or deletes the remote feature branch. Successful cleanup removes temporary local workflow resources while retaining durable evidence and recovery records; fail-closed terminals retain what the runtime needs for inspection.

## Presenting workflow progress

Surface the workflow in the Claude Code subagent look and feel, but treat the card as presentation rather than evidence:

```text
▸ Autopilot · codex-implementer      workflow-owned branch
  Task    <3–5 word description>
  Model   GPT-5.6 Sol · reasoning low
  Phase   running-task      Workflow <workflowId>
```

Use one compact status line derived from `autopilotStatus`, for example `● running-task · task 1/2`. Use `◑` for `human-decision-required`, `✓` for `ready-for-human-review`, and `✗` for `failed` or `cancelled`. Never invent progress, display a Producer self-report as evidence, or equate policy acceptance with merge.

## Explicit manual fallback

Use the manual candidate lifecycle only when the human explicitly chooses it instead of autopilot. In that mode, call `delegate` or `delegatePipeline`, inspect the exact frozen evidence with `reviewCandidate`, invoke the configured Candidate Decision authority through `decideCandidate`, and use `integrateCandidate` only for an accepted candidate with integrable provenance and a matching hash. Manual integration stages bytes in the human checkout and does not commit, push, open a PR, merge, deploy, or release. Never switch a halted autopilot workflow into the manual lifecycle implicitly.

## Trusted MCP lifecycle

The `delegate` and `delegatePipeline` MCP calls are synchronous. Keep each call in the foreground until it returns; never hand it to Monitor or background execution.

One manual run uses a two-call MCP preflight: `validateDelegationSpec` is read-only and starts no Producer; then exactly one `delegate` or `delegatePipeline` execution call may start Producers. Claude Code may group both under “Calling plugin:claude-architect:runtime 2 times”; that count is MCP calls, not Producer attempts. A plain `delegate` execution run starts exactly one Producer attempt (the implementation attempt; edit mode may first launch the same selected Producer in a separate environment-preflight probe that cannot produce candidate bytes), while a `delegatePipeline` run may start multiple fresh Producers for implementation, review, and repair after that probe. Before a direct manual lifecycle, say `Preflight 1/2 · validate only · no Producer` before validation and `Dispatch 2/2 · one execution call · one run` before execution, so “one run” is never presented as “one runtime call.”

Once the execution call is pending — including while the host shows `producer running` or after it backgrounds — never invoke `delegate` or `delegatePipeline` again, revalidate in parallel, or interpret a heartbeat as permission to retry. Wait for the original result: a second execution call creates a second run. Repair and revalidate only after the original call has returned an explicit pre-start validation or spec-identity error.

1. Call `validateDelegationSpec` with the exact Delegation Spec and `protocolVersion: "2.0.0"` copied from this skill's `PROTOCOL_VERSION` marker. This read-only call starts no Producer. Keep its runtime-returned `specSha256` as the identity of the spec you dispatch. Never hash the spec file or reimplement the canonicalization algorithm; file bytes and object key order are not the runtime's canonical wire identity.
2. When validation returns `ok:false` with `validationErrors`, repair only the reported spec defects and revalidate. This repair loop must not touch a Producer.
3. Call `delegate` through `mcp__plugin_claude-architect_runtime__delegate` with `checkoutPath`, the validated candidate spec, the same `protocolVersion`, and `expectedSpecSha256` set to the runtime-returned `specSha256`. The runtime compares that identity before it touches the checkout or starts a Producer.
4. When dispatch returns `ok:false` with `validationErrors`, repair only the reported spec defects, call `validateDelegationSpec` again to obtain the replacement digest, and resubmit. This can catch a spec changed after validation without touching a Producer.
5. When dispatch returns `spec-identity-mismatch` or `spec-identity-unverifiable`, no work started. Do not trust a lane-supplied replacement digest and do not retry the same payload. Reuse the exact validated spec and retained runtime digest in a direct foreground dispatch, or rebuild a fresh lane prompt containing those exact values.
6. When either call returns a protocol/schema diagnostic, stop and tell the user to update the installed marketplace copy and reload Claude Code. Never guess across a version mismatch.
7. When the result is `unavailable`, `failed`, or `cancelled`, report the structured classification and evidence. Do not claim a candidate exists. A report with `laneEligibility.edit=false`, or any other ineligible or unconfined Lane, fails closed with the structured diagnostic.
8. When the result is `verified-candidate`, call `reviewCandidate` with `checkoutPath` and the run id. Read the exact unredacted patch, changed-path manifest, and verification evidence; compare them with every success criterion and repository convention.
9. Present the review outcome. Call `decideCandidate` with `checkoutPath`, the run id, and `accepted`, `rejected`, or `revision-requested`. Rejection discards the candidate anchor; a revision requires a new spec/attempt rather than editing frozen bytes.

   Under the shipped `autonomous` authority, `decideCandidate` records `accepted` as `policy-autonomous` without elicitation for any independently verified candidate carrying no failure and no advisory warnings from a readable archive — either a `delegatePipeline` candidate with a well-formed `pipelineGateCleared` record bound to the same candidate commit and `requiresHumanDecision:false`, or a plain `delegate` candidate, which carries no pipeline evidence at all and is judged on its independent verification result alone. Every other case — including rejection, revision, refusal, incomplete review, malformed or mismatched clearance, and every decision under `human` — raises an MCP elicitation prompt and records nothing unless a person confirms; `elicitation-unavailable`, `decision-not-confirmed`, and `elicitation-failed` all mean no decision was written. Do not treat a refused confirmation as a transient error to retry; report it and stop. The recorded decision carries `decidedBy` and the candidate `manifestHash` it binds to. Integration accepts `human-elicitation` and `policy-autonomous` provenance, while refusing a different artifact and any legacy or caller-asserted acceptance.
10. Only after an accepted decision, call `integrateCandidate` with `checkoutPath`, the run id, and the exact candidate `manifestHash` as `expectedArtifactHash`. Report `applied`, `conflicted`, or `aborted` truthfully. Integration stages the reviewed tree but does not commit it.

**Run the lifecycle without an extra conversational permission stop.** Once the user has asked for the work, carry it through review and call `decideCandidate`; the configured decision authority is the acceptance gate. Do not manufacture an extra prompt on the evidence-bound autonomous path, and never bypass or pre-answer MCP elicitation when the runtime requires it. Integrate only after an accepted decision with integrable provenance is recorded. Stop and report when the runtime refuses — a failed verification, a refused gate, an unconfirmed or unavailable required elicitation, or an integration that reports `conflicted` or `aborted`.

Never accept a Producer self-report as evidence, bypass `reviewCandidate`, call integration before an accepted decision, or substitute a different artifact hash.

## Lanes as native subagents

For visibility, dispatch delegation lanes through the host's `Agent` tool using the plugin's `delegation-lane` agent; the host then renders each lane as a native subagent row (spinner, stats, completion notice). This is a dispatch surface only — spec construction, `reviewCandidate`, the configured decision gate, and `integrateCandidate` stay in this session exactly as above.

Before dispatch, call `validateDelegationSpec` and use its runtime-returned `specSha256`; assign a short `laneId`. Each lane prompt contains only: `laneId`, that `specSha256`, `checkoutPath`, `protocolVersion`, `pipeline` true/false, and the complete Delegation Spec JSON. Nothing else.

Concurrency is honest, never advertised beyond the runtime:

- **Independent repositories** (disjoint `gitCommonDir`s): dispatch one lane agent per repository in a single message; they genuinely run concurrently.
- **Same repository**: the runtime serializes all attempts on the repository lock. Lanes may still be dispatched as subagents for visibility, but they execute one at a time; size timeouts accordingly and never present them as parallel.

The lane report is model-mediated and untrusted for anything but correlation. On completion, take only `runId` from the report and call `reviewCandidate` — passing `expectedSpecSha256` set to the runtime-returned digest retained before dispatch, never the one the lane echoed back. The lane names its own run, so without that argument you are trusting the reviewed party about which run to review; a lane naming a *different real* run returns a clean candidate for work you never asked for. `reviewCandidate` fails with `run-spec-mismatch` when the run was started from another spec, and with `run-spec-unverifiable` rather than silently succeeding when it cannot check. Every reviewable fact comes from that evidence. On a malformed or missing report, do not redispatch: locate the run directory whose recorded spec matches `specSha256` (per the monitoring section) and resume from its `result.json`; redispatch only when no matching run directory exists.

Decision and integration remain per-repository and serial: review → decision → integrate → stop until the human commits or discards the staged tree. At most one accepted candidate per clean checkout; never batch-accept multiple candidates targeting the same checkout. Human-required decisions for lanes on different repositories may be presented together in one structured question.

Single-lane delegation may still use the direct foreground MCP call; prefer the lane agent whenever the call will outlive the host's ~120s background threshold.

## Presenting delegations as subagents

When a lane runs through the `delegation-lane` agent, the host renders dispatch and live status natively; the cards below apply only to direct (non-subagent) MCP calls. This is presentation only: it renders the runtime's durable evidence and never replaces spec construction, `reviewCandidate`, the recorded decision, or `integrateCandidate`. A rendered card is not evidence; a Producer self-report is not evidence; acceptance stays gated on independent verification and its provenance is always recorded.

**Dispatch card** — emit when you call `delegate`/`delegatePipeline`, so the run reads like an `Agent` launch:

```text
▸ Agent · codex-implementer          edit · worktree-isolated
  Task    <3–5 word description>
  Model   GPT-5.6 Sol · reasoning low
  Mode    foreground        Pipeline  delegatePipeline
```

**Live status** — one FleetView-style line while the call runs and after the host collapses it to background. Derive it only from the run's durable artifacts using the rules in *Monitoring a backgrounded delegation*; never invent progress.

```text
● running · codex-implementer · verification · 4m12s
```

Status glyphs: `●` running (host-rendered for lane agents) · `◑` decision pending · `✓` verified/accepted · `✗` failed, unavailable, cancelled, or rejected. The decision line appears only on decision-bearing outcomes.

**Completion notification** — when the call returns, render one compact box populated from the `reviewCandidate` evidence and verification report (mirrors a background subagent's completion notice):

```text
┌ ✓ delegation-lane · codex · verified-candidate ─────────
│ lane task1 · 1 file changed · verification 2/2 pass
│ producer self-report conflicts: none
│ manifestHash cebcb2a8…
│ ◑ YOUR DECISION: accept / reject / revise
└──────────────────────────────────────────────────────────
```

The box summarizes; it does not decide. Still read the exact unredacted patch, changed-path manifest, and verification evidence before recommending a decision, and present `failed` or `human-decision-required` outcomes verbatim.

## Choosing delegate vs delegatePipeline

Use `delegatePipeline` by default for non-trivial tasks — anything with
meaningful correctness or systems risk (multiple files, state, concurrency,
security surface, or behavior existing code depends on). Use plain `delegate`
only for trivial tasks (typo-level fixes, single obvious one-liners, doc-only
edits).

## Pipeline lifecycle

1. Build the Delegation Spec exactly as for `delegate`. Optionally add:

   ```yaml
   review:
     reviewers: [correctness, systems]   # default
     maxRounds: 2                         # default
     focus:
       - Check platform-specific process cleanup.
   ```

2. Call `mcp__plugin_claude-architect_runtime__delegatePipeline` with
   `checkoutPath`, `spec`, `protocolVersion: "2.0.0"`, and
   `expectedSpecSha256` set to the runtime-returned digest.
3. Read the returned evidence bundle: attempt result, per-round review
   reports and consolidated findings, fix dispositions, verification report,
   and gate reasons.
   - `status: "decision-ready"` — review the evidence yourself, then call
     `decideCandidate` with `checkoutPath` and the run id and, if accepted,
     `integrateCandidate` with `checkoutPath`, the run id, and the candidate
     `manifestHash` as `expectedArtifactHash`.
   - `status: "human-decision-required"` — present the gate reasons,
     unresolved findings, and dispositions to the human verbatim. Never
     accept on their behalf.
   - `status: "failed"` — report the failure classification; retry or
     re-scope per the normal delegate failure guidance.
4. The pipeline never merges and never waives findings; acceptance remains with
   `decideCandidate` under the configured runtime authority and, where required,
   the human.

## Sliced pipeline

For a task that decomposes into ordered, independently testable steps, add a
top-level `slices` array to the spec. Each slice is a scoped mini-spec with its
own `objective`, `context`, `writeAllowlist`, `forbiddenScope`,
`successCriteria`, and — required — its own `verification`:

```yaml
slices:
  - objective: Add the parser for the new record type.
    context: The record grammar lives in docs/format.md.
    writeAllowlist: [src/parse/**]
    forbiddenScope: [src/emit/**]
    successCriteria:
      - New record type round-trips through the parser.
    verification:
      - id: parse-tests
        executable: npx
        args: [vitest, run, tests/parse]
        cwd: "."
        timeoutMs: 600000
        network: denied
        expectedExitCodes: [0]
  - objective: Emit the new record type.
    # ...its own scope and verification
```

Slice rules and guarantees:

- Each slice runs **fresh with no context** — a slice implementer sees only its
  own mini-spec, never a prior slice's conversation, and is gated only by its
  own `verification`. Each slice's `writeAllowlist` must be a subset of the
  spec's, and its verification `cwd` must stay inside the candidate root.
- A deterministic wayfinder routes each completed slice **advance / repair /
  halt** from objective gate results — the slice's own `verification`, plus its
  independent per-slice review findings when `review.perSlice` is enabled —
  never from model judgment or a Producer's self-report. A slice that passes
  advances; a slice that fails is repaired within its round budget; a slice that
  cannot be made to pass halts the run.
- Slices run **sequentially by default**. A slice may declare `dependsOn` — the
  1-based indices of the slices it must observe — and the spec may raise
  `sliceConcurrency`. Slices then run together only when their dependencies
  allow it *and* their write allowlists are pairwise disjoint, which is what
  makes composing their results a conflict-free union. Omitting `dependsOn`
  means "after every preceding slice", so an existing spec behaves exactly as
  before.
- Declaring `dependsOn` is a claim about what a slice needs to *see*, not only
  about what it writes. A slice that reads another slice's output depends on it
  even with disjoint allowlists. Nothing detects an under-declared dependency:
  a slice that runs too early is verified against a base without the work it
  needed, and the error surfaces at the composed verification below. Declare
  `dependsOn: []` only when a slice is genuinely independent.
- Review and the advisor judge the **composed candidate** at the end, over the
  whole slice branch, and that composed candidate always faces the spec's full
  `verification` regardless of how the slices were scheduled. Per-slice results
  never substitute for it. Per-slice review is off by default; opt in with
  `review.perSlice: true` to review each slice as it lands.
- A mid-run halt **after at least one slice has advanced** yields a **partial**
  candidate with `status: "human-decision-required"`, the halted slice index in
  `haltedSliceIndex`, and each slice's route in `slices`; the promoted partial
  branch (the advanced slices) is a real candidate the human may accept, reject,
  or revise, and the halted slice's attempts stay in `slices` as evidence. A
  halt on the very first slice, with nothing advanced, is reported `failed` with
  the slice evidence retained — there is no partial branch to accept. Present
  the completed slices, the halt reason, and the partial candidate to the human;
  never accept or continue past a halt on their behalf.

## Monitoring a backgrounded delegation

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
