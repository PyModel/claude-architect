---
name: subagent-driven-delegation
description: Execute an implementation plan with the Superpowers subagent-driven-development loop while every task is implemented by a verified Claude Architect Producer — isolated worktree, frozen Candidate Artifact, independent verification, fresh-context review, runtime-gated acceptance. Use when executing a multi-task plan through delegation rather than editing directly.
---

# Subagent-Driven Delegation

```claude-architect-protocol
PROTOCOL_VERSION: 3.0.0
```

Superpowers `subagent-driven-development` (SDD) dispatches a fresh implementer subagent per task, reviews each task, and reviews the whole branch at the end. This skill runs that same loop with one substitution: **the implementer is a Claude Architect delegation, not a generic subagent.** Each task becomes a versioned Delegation Spec executed by an untrusted Producer in an isolated worktree, frozen as a Candidate Artifact, and independently verified by the runtime before any reviewer sees it.

Always present this skill as `/claude-architect:subagent-driven-delegation`.

Use `/claude-architect:delegate` for a single delegation. Use this skill when a plan has multiple tasks and you want the SDD ledger, per-task review, and final whole-branch review on top of verified delegation.

## What the substitution buys

Upstream SDD's task reviewer reads a diff and the implementer's report; it trusts that the implementer ran the tests it claims. Here that trust is removed:

| SDD stage | Generic subagent | Verified delegation |
| --- | --- | --- |
| Implement | Subagent edits the branch | Producer edits an isolated worktree it cannot escape |
| Test evidence | Implementer's report | Runtime re-runs verification on frozen bytes |
| Task review | Reviews a diff | Reviews the exact anchored candidate, never the implementer's context |
| Complete | Controller marks done | The configured runtime authority records acceptance, then integration is hash-matched |

The Producer's self-report is never evidence. It is a correlation aid and a summary; every reviewable fact comes from runtime evidence.

## Where this diverges from upstream SDD

Follow upstream SDD except on these four points, where a trust invariant governs. Do not "restore" the upstream behavior.

1. **No implementer resume.** Upstream says fix rounds 1–3 resume the original implementer with its context intact. Claude Architect forbids it: every attempt starts with fresh context in a fresh worktree. Every fix round is therefore a **new attempt** carrying the findings in a revised spec. The report file, not conversational memory, is the continuity.
2. **The controller never marks a task complete directly.** Upstream lets the controller close a task after a clean review. Here a task closes only after `decideCandidate` records `accepted` under the configured authority and `integrateCandidate` reports `applied`.
3. **Implementer self-review is not a review.** Upstream's implementer self-reviews before handing off. A Producer may summarize, but the gate is runtime verification plus `reviewCandidate`. Never let a self-report shorten the review.
4. **The controller never fixes findings.** Upstream already says this to protect controller context; here it is also a trust rule. The architect authors specs and reviews bytes. It does not edit Producer output into shape.

## Mapping to the Superpowers skills

Each upstream skill keeps its meaning; delegation supplies the enforcement.

| Superpowers skill | How it is realized here |
| --- | --- |
| `subagent-driven-development` | The loop itself, with the four divergences above. |
| `dispatching-parallel-agents` | A repository is shared state. Lanes on **disjoint** repositories are genuinely independent and dispatch concurrently; lanes on the **same** repository serialize on the repository lock and must never be presented as parallel. |
| `test-driven-development` | `expectBaselineFailure` is the fail-before/pass-after proof, and the runtime enforces it: the command must run at clean HEAD and must fail. A Producer's claim to have written a failing test first is not evidence. |
| `systematic-debugging` | A failed verification is evidence to read, not a reason to re-dispatch. Start from `unresolvedIssues`, then the per-command `stdoutRef`/`stderrRef`, then the frozen patch. Re-running an unchanged spec is the delegation form of guessing. |
| `verification-before-completion` | Independent verification runs on frozen bytes before any reviewer sees them, and `reviewCandidate` gates the Candidate Decision. Neither is skippable because the Producer says the work is done. |
| `requesting-code-review` | `reviewCandidate` is the per-task review; the final whole-branch review covers the cumulative attempts. The reviewer never shares the implementer's context, so the independence upstream asks for is structural rather than conventional. |

Two upstream assumptions do not survive the trust boundary, and the table above is where they break: an implementer cannot be resumed (fresh context per attempt), and a controller cannot self-certify completion (acceptance is a durable runtime decision with recorded provenance).

## Setup

1. **Isolated workspace.** Delegation already isolates each attempt, but the *branch* still needs a home. Use `superpowers:using-git-worktrees`, or confirm the current branch is not `main`/`master` without the user's explicit consent. This is the architect-owned integration workspace only: pass it as `checkoutPath`, but never dispatch a generic implementer to edit it. The runtime gives every implementation or repair attempt fresh context in its own isolated worktree. A repository delivery gate may later create another managed worktree; never reuse or expose one layer's worktree as another layer's workspace.
2. **Clean checkout.** The repository precondition in `/claude-architect:delegate` applies unchanged to every task in this loop.
3. **Workspace and ledger.** When Superpowers is installed, run its `scripts/sdd-workspace PLAN_FILE` and use the directory it prints. Otherwise use `<repo-root>/.claude-architect/sdd/<plan-basename>/`. Create `progress.md` whose first line is `# SDD ledger — plan: <plan file path>`. A ledger naming a different plan belongs to that plan: leave it alone and start your own.
4. **Resume, don't redo.** A task with a `Task <N>: complete` line is done. Re-dispatching completed tasks is the most expensive recoverable failure in this loop, and delegation makes it costly in Producer time as well. Trust the ledger and `git log` over your own recollection.
5. **Plan conflict scan.** Read the plan once. Batch every contradiction — between tasks, against Global Constraints, or a mandate that the review rubric treats as a defect — into one question before Task 1. Add one delegation-specific check: any task whose success criteria are not objectively checkable cannot become a Delegation Spec. Sharpen those criteria with the user now, because a Producer cannot be verified against a vague goal.

## The task loop

Record `BASE` (`git rev-parse HEAD`) before each task.

### 1. Brief

Run Superpowers' `scripts/task-brief PLAN_FILE N` (or extract the task's full text to a uniquely named file yourself). The brief is the single source of requirements and holds every exact value verbatim. Never make a subagent or Producer read the whole plan.

### 2. Author the Delegation Spec

Translate the brief into a spec per `/claude-architect:delegate` — success criteria, `writeAllowlist`, and verification commands. Two rules matter more here than in single delegation:

- **Verification commands carry the task's acceptance.** Whatever the brief calls "done" must be an executable check, because the runtime — not the Producer — decides whether it passed. A brief's acceptance criterion that cannot become a command is a plan defect to raise, not a criterion to review by eye.
- **A task's scope is narrower than the plan's.** Each task's `writeAllowlist` covers that task and its allowlist consumers, never the whole plan; a later task must not be able to reach back into an earlier task's files unannounced.

Every other spec-authoring rule — allowlist consumers, `expectBaselineFailure`, text-search gates, test-parallelism bounds — is stated once in `/claude-architect:delegate` § Build the Delegation Spec and applies here unchanged.

### 3. Dispatch

Dispatch through the host's `Agent` tool using the `delegation-lane` agent so the task renders as a native subagent row, or call `delegate`/`delegatePipeline` directly in the foreground for short attempts. Never dispatch two implementation lanes against the same repository as if they were parallel — the runtime serializes them on the repository lock.

Correlate the lane report exactly as `/claude-architect:delegate` § Lanes as native subagents requires; a lane report is never evidence for a task's completion.

### 4. Review the task

The runtime has already frozen the candidate and independently verified it. Now call `reviewCandidate` and read the exact unredacted patch, changed-path manifest, and verification evidence against the brief.

This is SDD's task review, and both verdicts are still required: **spec compliance** and **task quality**. A green verification report answers only the first. Never skip the review because verification passed.

Resolve any "cannot verify from the candidate" item yourself — you hold the plan and cross-task context. A confirmed gap is a failed spec review and enters the fix loop.

### 5. The fix loop

Blocking findings — spec ❌, Critical, or Important — enter the loop. Minor findings go to the ledger as deferred and are handed to the final review; they never extend the loop. A finding that conflicts with the plan's text is the user's call: present the finding beside the plan text and ask which governs.

Five rounds maximum per task. Each round is one new attempt plus one scoped re-review:

- Call `decideCandidate` with `revision-requested`. Frozen bytes are never edited.
- Author a **revised spec** carrying the open findings verbatim and a verification command covering each one. Rounds 4–5 raise the Producer's model or reasoning tier, and say plainly in the spec that prior attempts failed and why.
- Re-review the new candidate against the findings list: each finding ADDRESSED or NOT ADDRESSED, plus new breakage in this candidate only.
- Append: `Task <N>: fix round <R>/5 (<X> addressed, <Y> open — <one-liners>; run <runId>)`.

**The breaker.** When round 5 still leaves findings open, stop dispatching and adjudicate each one. Park a contestable or non-load-bearing finding with a written ruling. A finding that is real *and* load-bearing — a later task builds on it, or it reveals a plan defect — is a STOP: append `Task <N>: BLOCKED — <reason>` and report to the user with the finding, the plan text it collides with, and the attempt history. Adjudicate only at the cap; adjudicating earlier is pre-judging. Every adjudication is a ledger entry — silent discards are forbidden.

### 6. Close the task

Present the review outcome and your recommendation, then run `decideCandidate` and — only on an accepted decision with integrable provenance — `integrateCandidate` with the exact candidate `manifestHash` as `expectedArtifactHash`, exactly as `/claude-architect:delegate` § Manual candidate lifecycle steps 9–10 specify. Nothing about the decision gate changes because a task is part of a plan.

Then append `Task <N>: complete (run <runId>, manifest <hash7>, review clean)` — or `…, <K> parked` after a tripped breaker.

**Gate before the next task.** Integration leaves the checkout dirty, and delegation requires an exact clean checkout — so the loop cannot advance until the staged tree is resolved. Stop here and have the user commit (or discard) it, then confirm `git status` is clean before authoring Task N+1's spec. This is the one mandatory pause per task; it is not a progress check-in, and it exists because the next `delegate` call will otherwise fail its precondition. Record the commit in the ledger alongside the completion line so the ledger stays a usable recovery map.

## Final review

After the last task, review the **whole candidate branch and the cumulative attempts**, not just the final diff — a defect introduced in Task 2 and papered over in Task 6 is only visible across the range. Dispatch the final review on the most capable available model — the `candidate-reviewer` agent on `opus`, or `claude-advisor` on `fable` — point it at the ledger's deferred-minor and parked lines, and give it the branch range from the merge base.

If it returns findings, handle them as one fix wave — a single revised delegation carrying the complete findings list, not one delegation per finding — then exactly one scoped re-review. Residual findings are adjudicated as at the breaker.

When the final review is clean and integrated, inspect the repository instructions before deleting the plan workspace or invoking a finishing skill:

- If the repository defines a delivery gate, that gate supersedes `superpowers:finishing-a-development-branch`. Require the final branch to be committed and clean, obtain whatever launch authorization the repository requires, and start the gate only from the architect session after every delegation run is terminal. Do not merge or push directly, and do not let a Producer, reviewer, or active delegation start the gate. Preserve the plan workspace and branch home while the gate owns the branch; clean them up only when the gate's live state and branch-custody instructions permit it.
- If the repository defines no delivery gate, delete this plan's workspace; git history is the record. Then use `superpowers:finishing-a-development-branch`.

## Rationalizations

| Excuse | Reality |
| --- | --- |
| "Verification passed, skip the review" | Verification proves the checks ran, not that the spec was met. Both verdicts are required. |
| "I'll just resume the Producer with the findings" | There is no resume. Fresh context per attempt is a trust invariant; author a revised spec. |
| "The candidate is obviously fine, I'll accept it" | A recommendation is not acceptance. Call `decideCandidate`; only the configured runtime authority records the durable decision. |
| "It's a one-line finding, I'll patch it myself" | Controller edits skip review and cross the trust boundary. Revise the spec. |
| "The Producer says it ran the tests" | A self-report is never evidence. Read the runtime's verification report. |
| "Both lanes are on the same repo but they'll run in parallel" | The repository lock serializes them. Size timeouts accordingly. |
| "Round 6 will converge" | Past the cap the failure is structural. Adjudicate and route. |
| "Integration staged it, I can start the next task" | A staged tree is a dirty checkout, and delegation requires a clean one. The next task's dispatch will fail until the user commits. |
