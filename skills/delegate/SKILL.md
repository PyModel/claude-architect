---
name: delegate
description: Let Claude Architect route a versioned implementation spec through the trusted MCP runtime, independently review the Candidate Artifact, record a decision, and integrate only accepted bytes. Use for implementation delegation, Producer selection, or commitment-boundary review.
---

# Delegate

```claude-architect-protocol
PROTOCOL_VERSION: 3.0.0
```

The current session is the architect: it owns requirements, the Delegation Spec, Producer selection, review, and acceptance. Producers are untrusted — their output is only a candidate until the runtime freezes it, independently verifies it, and the architect reviews the exact anchored bytes.

Always present this skill as `/claude-architect:delegate`. Never show a shorter command.

## Superpowers across the trust boundary

When the upstream Superpowers plugin is available, keep its host-loop skills on the architect side: `brainstorming` before freezing the Delegation Spec, `writing-plans` to turn an agreed design into objectively checkable work or slices, `verification-before-completion` before recording a decision. Generic `executing-plans` and `subagent-driven-development` may coordinate architect-owned non-writing analysis only, never a writing task.

To execute any multi-task plan that writes files, use `/claude-architect:subagent-driven-delegation`: the Superpowers subagent-driven-development loop — ledger, per-task brief, per-task review, final whole-branch review — with the delegation lifecycle below replacing the generic implementer subagent. No skill grants a Producer permission to plan instead of editing, dispatch nested agents, review itself, accept a candidate, or integrate bytes. Without the plugin, proceed without those skills rather than approximating them.

Edit-lane Producers receive a deliberately smaller, vendored procedure subset:

- `test-driven-development` for every behavior change or bug fix, before implementation code;
- `systematic-debugging` when a test, build, or behavior fails unexpectedly, before proposing a fix;
- `verification-before-completion` before claiming success.

The runtime supplies these by absolute path inside each isolated attempt. Never put architect-only skills in the Delegation Spec or tell a Producer to discover skills from the operator's home directory. Vendored from [obra/superpowers](https://github.com/obra/superpowers) 6.2.0, MIT.

## Agent selection

The delegated CLIs are the architect's **implementation agents** — Claude Code's subagent idiom, except each agent launches an *untrusted Producer* through the trusted MCP runtime inside an isolated Git worktree. Present them as a roster: the human picks one `subagent_type`, exactly one agent runs per attempt, and no agent may review or accept its own work.

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

### Architect-side Claude subagents

The architect session — whatever model it runs, including Fable — may dispatch Claude subagents through the host's `Agent` tool (`model`: `opus`, `sonnet`, or `fable`) for **non-writing** roles, in parallel with a running lane:

- **Scout** (`sonnet`, or `Explore`): read-only reconnaissance before a spec is frozen — call sites, nearby patterns, which files an allowlist must cover.
- **Spec drafter** (`sonnet`): turn an agreed design into candidate `successCriteria` and verification commands for the architect to review; the architect still owns and freezes the spec.
- **Candidate reviewer** (`candidate-reviewer`, `opus`): an independent review of the frozen bytes through `reviewCandidate`, with no Producer context. Use it for the per-task review and for the whole-branch final review, then let the architect weigh the verdict and call `decideCandidate`.
- **Advisor** (`claude-advisor`, `fable`): commitment-boundary second opinion.

A Claude subagent is never an implementer: it edits nothing, calls neither `decideCandidate` nor `integrateCandidate`, and never dispatches a lane; only the `delegation-lane` courier calls `delegate`/`delegatePipeline`. When the work is implementation and you want Opus or Sonnet, that is the `claude-implementer` lane above — the same model, run as an untrusted Producer in an isolated worktree, frozen, and independently verified.

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
- A text-search gate must not be able to match prose: anchor an absence check to the
  syntax you mean, exclude comment lines, or assert over a parsed structure, so a
  Producer cannot fail a gate its code satisfies by writing a comment that mentions the
  pattern ([docs/verification-preflight.md](../../docs/verification-preflight.md)).
- Bound the parallelism of every test command, and state the same bound in `context` for the commands the Producer runs on its own. Verification commands are not the only tests that execute: a Producer re-runs the suite inside its own shell, and an unbounded runner there fans out to one worker per core on top of the attempt itself. On a many-core host that has driven thousands of process spawns and starved the machine. For a Node repository, pass an explicit worker cap (for example `--maxWorkers=4`) rather than relying on a runner default.

**Verification preflight:** The runtime runs every verification command against clean HEAD in a disposable worktree before dispatch, and separately probes the Producer's own shell for the executables those commands name — a Producer that cannot resolve `node` or `git` cannot verify its own work, and would otherwise discover that only after burning the whole attempt window. An unresolvable executable ends the attempt as `environment-defect` before the Producer runs; anything less definite proceeds and is recorded in evidence. The probe proves resolution, not configuration, and grants a candidate nothing: independent verification remains the backstop. Repair the spec if a command cannot start. A baseline failure unrelated to the task is an environment defect the architect repairs centrally before dispatching. Set `expectBaselineFailure: true` on any command that cannot pass at clean HEAD by design — one that reproduces the target bug, or one that exercises a file or test the candidate will create (it necessarily fails before that path exists).

Set `baselineFailureExitCodes` alongside the flag whenever the runner distinguishes "the test ran and failed" from "the test could not be collected". The flag is enforced in both directions — it rejects a command that could not run at all and one that passes — and is all-or-nothing for the command it sits on, so never blanket-mark the command set. Why each part of that holds: [docs/verification-preflight.md](../../docs/verification-preflight.md).

Resolve ambiguity before calling the runtime. Do not give the Producer credentials, hidden instructions, acceptance authority, or permission to expand scope.

## Coordinator duties

**Allowlist consumers:** Before dispatch the runtime reports tracked files that import the write allowlist but sit outside it. When a delegation changes an exported contract, either widen `writeAllowlist` to those consumers or add a repository-wide verification command — a src-only type gate plus focused tests compiles neither, so the breakage lands on the architect at integration.

When running multiple delegations, normalize reported blockers by phase, command id, and root cause. The moment two independent lanes report the same blocker, pause affected lanes and treat it as an architect-owned shared-environment defect: reproduce it once against the clean baseline, fix it centrally, rerun the preflight to green, then resume or redispatch the unchanged specs. Never push shared-tooling fixes into individual Producer lanes.

**Repository precondition:** delegation and controlled integration require an exact clean checkout; tracked or unignored changes must be committed before delegation, including tracked planning files. Git-ignored files do not affect the clean check. Never use skip-worktree or assume-unchanged as a workaround.

## Trusted MCP lifecycle

Two lifecycles share one rule: the runtime's durable evidence decides, and a Producer's
self-report never does. Autopilot is the default; the manual candidate lifecycle runs
only when the human explicitly chooses it. Never switch a halted autopilot workflow into
the manual lifecycle implicitly.

In both, never accept a Producer self-report as evidence, bypass `reviewCandidate`, call
integration before an accepted decision, or substitute a different artifact hash.

### Autopilot

Project-scoped permission settings become active only after the human grants Claude Code workspace trust. They can allow the three autopilot tools, but they cannot override managed `ask` or `deny` policy. “No mid-loop prompts” is therefore conditional: it applies only after workspace trust, when all three tool calls are allowed and no higher-precedence policy, controller halt, or ambiguity requires the human.

1. Call `autopilotStart` with `checkoutPath`, the complete Autopilot Spec as `spec`, and `protocolVersion: "3.0.0"` copied from this skill's marker. Do not attempt a workflow start against a dirty checkout.
2. If validation returns `validationErrors`, repair only the reported spec defects and resubmit. A protocol mismatch means the installed plugin must be updated and reloaded; never guess across versions. A report with `laneEligibility.edit=false`, or any other ineligible or unconfined lane, fails closed with the structured diagnostic.
3. Record the returned `workflowId`. Call `autopilotStatus` with `checkoutPath`, that `workflowId`, and `protocolVersion: "3.0.0"` for read-only monitoring. Report only persisted phases and bounded progress supplied by the runtime; never infer completion from a phase name or Producer output.
4. After a host or process interruption, call `autopilotResume` with `checkoutPath`, the same `workflowId`, and `protocolVersion: "3.0.0"`. Resume replays durable observed state; it does not authorize a second workflow or waive a failed gate.
5. During autopilot, do not construct Autopilot Eligibility, synthesize a Candidate Decision, call separate review/decision/integration tools, run Git or `gh`, push, create or edit a PR, merge, or delete a branch. The controller owns policy, promotion, cumulative final review, cleanup, and recovery. It refuses to start under `CLAUDE_ARCHITECT_DECISION_AUTHORITY=human` (`decision-authority-human`) and without a configured Git identity (`git-identity-missing`), because promotions are committed under the user's name.

The controller may proceed without a mid-loop prompt only while every eligibility gate
remains objectively proven. Autopilot is autonomous only up to a final-reviewed local
branch: it never pushes, opens a PR, merges, deploys, or releases. Deliver that branch
through the repository's delivery gate only with the human's approval.
Interpret `ready-for-human-review`, `human-decision-required`, `failed`, and `cancelled`
exactly as [docs/autopilot-terminal-states.md](../../docs/autopilot-terminal-states.md)
defines them; every one is terminal, and none authorizes improvised continuation.

### Manual candidate lifecycle

When the human chooses it, call `delegate` or `delegatePipeline`, inspect the exact frozen evidence with `reviewCandidate`, invoke the configured Candidate Decision authority through `decideCandidate`, and use `integrateCandidate` only for an accepted candidate with integrable provenance and a matching hash. Manual integration stages bytes in the human checkout and does not commit, push, open a PR, merge, deploy, or release.

The `delegate` and `delegatePipeline` MCP calls are synchronous. Keep each call in the foreground until it returns; never hand it to Monitor or background execution.

One manual run is a two-call MCP preflight: `validateDelegationSpec` is read-only and
starts no Producer; then exactly one `delegate` or `delegatePipeline` execution call may
start Producers. Claude Code may group both under one runtime entry; that count is MCP calls, not Producer attempts.
A plain `delegate` execution run starts exactly one Producer attempt, while a `delegatePipeline` run may start multiple fresh Producers for implementation, review, and repair. Once the execution call is pending — including while the host shows
`producer running` or after it backgrounds — never invoke `delegate` or `delegatePipeline` again, revalidate in
parallel, or read a heartbeat as permission to retry: a second execution call creates a
second run. Repair and revalidate only after the original call returned an explicit
pre-start validation or spec-identity error. Announcement wording and what the host's
call count does and does not mean:
[docs/delegation-monitoring.md](../../docs/delegation-monitoring.md).

1. Call `validateDelegationSpec` with the exact Delegation Spec and `protocolVersion: "3.0.0"` copied from this skill's `PROTOCOL_VERSION` marker. This read-only call starts no Producer. Keep its runtime-returned `specSha256` as the identity of the spec you dispatch. Never hash the spec file or reimplement the canonicalization algorithm; file bytes and object key order are not the runtime's canonical wire identity.
2. When validation returns `ok:false` with `validationErrors`, repair only the reported spec defects and revalidate. This repair loop must not touch a Producer.
3. Call `delegate` through `mcp__plugin_claude-architect_runtime__delegate` with `checkoutPath`, the validated candidate spec, the same `protocolVersion`, and `expectedSpecSha256` set to the runtime-returned `specSha256`. The runtime compares that identity before it touches the checkout or starts a Producer.
4. When dispatch returns `ok:false` with `validationErrors`, repair only the reported defects, revalidate for the replacement digest, and resubmit — this catches a spec changed after validation without touching a Producer.
5. On `spec-identity-mismatch` or `spec-identity-unverifiable`, no work started. Never trust a lane-supplied replacement digest or retry the same payload: reuse the exact validated spec and retained runtime digest in a direct foreground dispatch, or rebuild a lane prompt containing those exact values.
6. When either call returns a protocol/schema diagnostic, stop and tell the user to update the installed marketplace copy and reload Claude Code. Never guess across a version mismatch.
7. When the result is `unavailable`, `failed`, or `cancelled`, report the structured classification and evidence. Do not claim a candidate exists. A report with `laneEligibility.edit=false`, or any other ineligible or unconfined Lane, fails closed with the structured diagnostic.
8. On `verified-candidate`, call `reviewCandidate` with `checkoutPath` and the run id. Read the exact unredacted patch, changed-path manifest, and verification evidence against every success criterion and repository convention.
9. Present the review outcome, then call `decideCandidate` with `checkoutPath`, the run id, and `accepted`, `rejected`, or `revision-requested`. Rejection discards the candidate anchor; a revision needs a new spec/attempt, never an edit to frozen bytes.

   Under the shipped `autonomous` authority, `decideCandidate` records `accepted` as
   `policy-autonomous` without elicitation only for an independently verified candidate
   carrying no failure and no advisory warnings from a readable archive. Every other
   case raises an MCP elicitation prompt and records nothing unless a person confirms;
   a refused confirmation is not a transient error to retry. See
   [docs/decision-authority.md](../../docs/decision-authority.md).
10. Only after an accepted decision, call `integrateCandidate` with `checkoutPath`, the run id, and the exact candidate `manifestHash` as `expectedArtifactHash`. Report `applied`, `conflicted`, or `aborted` truthfully. Integration stages the reviewed tree but does not commit it.

**No extra conversational permission stop.** Once the user has asked for the work, carry it through review and call `decideCandidate`; the configured decision authority is the acceptance gate. Never manufacture a prompt on the evidence-bound autonomous path, and never bypass or pre-answer MCP elicitation the runtime requires. Stop and report when the runtime refuses — failed verification, refused gate, unconfirmed or unavailable elicitation, or an integration reporting `conflicted` or `aborted`.

## Lanes as native subagents

For visibility, dispatch lanes through the host's `Agent` tool using the plugin's `delegation-lane` agent; the host renders each as a native subagent row. This is a dispatch surface only — spec construction, `reviewCandidate`, the decision gate, and `integrateCandidate` stay in this session exactly as above.

Before dispatch, call `validateDelegationSpec` and keep its runtime-returned `specSha256`; assign a short `laneId`. Each lane prompt contains only `laneId`, that `specSha256`, `checkoutPath`, `protocolVersion`, `pipeline` true/false, and the complete Delegation Spec JSON.

Concurrency is honest, never advertised beyond the runtime:

- **Independent repositories** (disjoint `gitCommonDir`s): dispatch one lane agent per repository in a single message; they genuinely run concurrently.
- **Same repository**: the runtime serializes all attempts on the repository lock. Lanes may still be dispatched as subagents for visibility, but they execute one at a time; size timeouts accordingly and never present them as parallel.

The lane report is model-mediated and untrusted for anything but correlation. Take only `runId` from it and call `reviewCandidate` with `expectedSpecSha256` set to the runtime-returned digest you retained before dispatch — never the one the lane echoed back. Without that argument you are trusting the reviewed party about which run to review, and a lane naming a *different real* run returns a clean candidate for work you never asked for. `reviewCandidate` fails with `run-spec-mismatch` when the run was started from another spec, and with `run-spec-unverifiable` rather than silently succeeding when it cannot check. On a malformed or missing report, do not redispatch: locate the run directory whose recorded spec matches `specSha256` ([docs/delegation-monitoring.md](../../docs/delegation-monitoring.md)) and resume from its `result.json`; redispatch only when no matching run directory exists.

Decision and integration stay per-repository and serial: review → decision → integrate → stop until the human commits or discards the staged tree. At most one accepted candidate per clean checkout; never batch-accept multiple candidates targeting the same checkout. Human-required decisions for *different* repositories may be presented together in one structured question.

Single-lane delegation may use the direct foreground MCP call; prefer the lane agent whenever the call will outlive the host's ~120s background threshold.

## Presenting progress

Presentation only. A rendered card is not evidence; it renders the runtime's durable
artifacts and never replaces spec construction, `reviewCandidate`, the recorded decision,
or `integrateCandidate`. Never invent progress, display a Producer self-report as
evidence, or equate policy acceptance with merge.

Status glyphs: `●` running (host-rendered for lane agents) · `◑` decision pending or
`human-decision-required` · `✓` verified, accepted, or `ready-for-human-review` · `✗`
failed, unavailable, cancelled, or rejected.

Card and status-line templates for both autopilot workflows and direct MCP calls:
[docs/delegation-presentation.md](../../docs/delegation-presentation.md).
## delegatePipeline

Use `delegatePipeline` by default for non-trivial tasks — anything with meaningful
correctness or systems risk (multiple files, state, concurrency, security surface, or
behavior existing code depends on). Use plain `delegate` only for trivial tasks
(typo-level fixes, single obvious one-liners, doc-only edits).

Build the spec exactly as for `delegate`, optionally adding `review` (`reviewers`
defaults to `[correctness, systems]`, `maxRounds` to `2`, and `focus` is reviewer-only
guidance). Call it with `checkoutPath`, `spec`, `protocolVersion: "3.0.0"`, and
`expectedSpecSha256` set to the runtime-returned digest, then read the returned evidence
bundle: attempt result, per-round review reports and consolidated findings, fix
dispositions, verification report, and gate reasons.

Statuses map onto the manual lifecycle above: `decision-ready` proceeds to
`decideCandidate` and, if accepted, `integrateCandidate`; `human-decision-required`
presents the gate reasons, unresolved findings, and dispositions verbatim and never
accepts on the human's behalf; `failed` reports the failure classification. The pipeline
never merges and never waives findings.

For a task that decomposes into ordered, independently testable steps, add a top-level
`slices` array — each a scoped mini-spec with its own required `verification`, run fresh
with no context and routed advance/repair/halt by a deterministic wayfinder:
[docs/sliced-pipeline.md](../../docs/sliced-pipeline.md).
