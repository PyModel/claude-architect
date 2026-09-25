# Presenting a delegation

Card and status-line templates for autopilot workflows and direct MCP calls.
Presentation only: a rendered card is not evidence.

Presentation only. A rendered card is not evidence; it renders the runtime's durable
artifacts and never replaces spec construction, `reviewCandidate`, the recorded decision,
or `integrateCandidate`. Never invent progress, display a Producer self-report as
evidence, or equate policy acceptance with merge.

Status glyphs, everywhere: `●` running (host-rendered for lane agents) · `◑` decision
pending or `human-decision-required` · `✓` verified, accepted, or
`ready-for-human-review` · `✗` failed, unavailable, cancelled, or rejected.

## Autopilot workflows

Surface the workflow in the Claude Code subagent look and feel, but treat the card as presentation rather than evidence:

```text
▸ Autopilot · codex-implementer      workflow-owned branch
  Task    <3–5 word description>
  Model   GPT-5.6 Sol · reasoning low
  Phase   running-task      Workflow <workflowId>
```

Use one compact status line derived from `autopilotStatus`, for example `● running-task · task 1/2`. Use `◑` for `human-decision-required`, `✓` for `ready-for-human-review`, and `✗` for `failed` or `cancelled`. Never invent progress, display a Producer self-report as evidence, or equate policy acceptance with merge.

## Direct MCP calls

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
