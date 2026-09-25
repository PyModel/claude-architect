# Documentation index

Every document under `docs/` is listed here with a status. Nothing is unlabeled:
an unlabeled design document is indistinguishable from a current contract, and
this repository keeps its historical plans on purpose.

| Status | Meaning |
|---|---|
| **Current** | Describes the runtime as it ships today. Keep it true. |
| **Historical** | A record of work that shipped. Accurate about its moment, not about today. Do not implement from it. |
| **Superseded** | Replaced by a named document. Read the successor instead. |

When prose here disagrees with an executable contract, the precedence in
`AGENTS.md` § Sources of truth decides, and the prose is what gets corrected.

## Current reference

| Document | Covers |
|---|---|
| [ARCHITECTURE.md](ARCHITECTURE.md) | Subsystems, their boundaries, and which one owns each trust invariant. |
| [SECURITY_MODEL.md](SECURITY_MODEL.md) | What the runtime defends, and the mechanism that defends it. |
| [TRUST_BOUNDARIES.md](TRUST_BOUNDARIES.md) | Where untrusted input crosses into trusted code, and what validates it. |
| [THREAT_MODEL.md](THREAT_MODEL.md) | Adversaries, their capabilities, and the controls that stop them. |
| [PLUGIN_COMPONENTS.md](PLUGIN_COMPONENTS.md) | What the packaged plugin contains and how Claude Code loads it. |
| [operations.md](operations.md) | Filesystem layout, retention, cleanup guarantees, and recovery for operators. |
| [PRIVACY.md](PRIVACY.md) | What leaves the machine, per Producer. |
| [MARKETPLACE_REVIEW.md](MARKETPLACE_REVIEW.md) | Confinement matrix and the evidence behind each lane/platform claim. |

## Design review

| Document | Status | Note |
|---|---|---|
| [design-review/reference-spec.md](design-review/reference-spec.md) | Current | The fresh-context delegation CLI contract the runtime implements. |
| [design-review/02-role-separation.md](design-review/02-role-separation.md) | Current | Role separation and the review pipeline; the trust invariants in `AGENTS.md` restate it. |
| [design-review/enhancement-plan.md](design-review/enhancement-plan.md) | Historical | Dynamic delegation workflow proposals; the sliced pipeline that shipped is specified in `superpowers/specs/2026-07-18-sliced-delegation-design.md`. |

## Research

Point-in-time investigations. Each is accurate as of its date and is not
maintained afterwards.

| Document | Status | Note |
|---|---|---|
| [research/2026-07-13-fable-5-safeguard-trigger.md](research/2026-07-13-fable-5-safeguard-trigger.md) | Historical | Why a model switch fired during `/delegate`. |
| [research/2026-07-27-github-actions-runner-design.md](research/2026-07-27-github-actions-runner-design.md) | Current | The cross-platform CI matrix in use. |
| [research/2026-08-08-dynamic-workflow-analysis.md](research/2026-08-08-dynamic-workflow-analysis.md) | Historical | Dynamic-workflow analysis behind the autopilot lifecycle. |

## Design specifications

A spec states the contract a change was built to. It is historical once the
change ships and the runtime becomes the contract, unless it is still the
clearest statement of a rule that has not moved.

| Document | Status | Note |
|---|---|---|
| [specs/2026-07-14-disable-codex-multi-agent-design.md](superpowers/specs/2026-07-14-disable-codex-multi-agent-design.md) | Current | Nested delegation is still refused exactly as specified. |
| [specs/2026-07-15-fresh-context-review-pipeline-design.md](superpowers/specs/2026-07-15-fresh-context-review-pipeline-design.md) | Current | Fresh-context implement/review/repair rounds. |
| [specs/2026-07-17-delegation-contract-repair-design.md](superpowers/specs/2026-07-17-delegation-contract-repair-design.md) | Historical | Shipped in 0.17.0. |
| [specs/2026-07-17-legacy-codex-mcp-migration-design.md](superpowers/specs/2026-07-17-legacy-codex-mcp-migration-design.md) | Historical | Migration completed in 0.25.0; no legacy path remains. |
| [specs/2026-07-18-agent-guide-hardening-design.md](superpowers/specs/2026-07-18-agent-guide-hardening-design.md) | Superseded | Superseded by `AGENTS.md` at the repository root, which is the live agent contract. |
| [specs/2026-07-18-ralph-loop-integration-design.md](superpowers/specs/2026-07-18-ralph-loop-integration-design.md) | Current | Iterative implementation increments. |
| [specs/2026-07-18-sliced-delegation-design.md](superpowers/specs/2026-07-18-sliced-delegation-design.md) | Current | Slice waves, dependencies, and composition. |
| [specs/2026-07-23-native-subagent-delegation-design.md](superpowers/specs/2026-07-23-native-subagent-delegation-design.md) | Current | Which architect-side roles a Claude subagent may take. |
| [specs/2026-07-27-pr-23-ci-and-review-cleanup-design.md](superpowers/specs/2026-07-27-pr-23-ci-and-review-cleanup-design.md) | Historical | One PR's cleanup; shipped in 0.41.0. |
| [specs/2026-08-04-agy-producer-adapter-design.md](superpowers/specs/2026-08-04-agy-producer-adapter-design.md) | Superseded | The adapter is now a Producer Descriptor; see `ARCHITECTURE.md` § ProducerRuntime. |
| [specs/2026-08-04-agy-lane-smoke-test.md](superpowers/specs/2026-08-04-agy-lane-smoke-test.md) | Current | The opt-in real-adapter smoke procedure for the agy lane. |
| [specs/2026-08-27-claude-producer-adapter-design.md](superpowers/specs/2026-08-27-claude-producer-adapter-design.md) | Superseded | The adapter is now a Producer Descriptor; see `ARCHITECTURE.md` § ProducerRuntime. |

## Implementation plans

Every plan below shipped. They record what was intended and in what order; the
runtime, its schemas, and its tests are what it actually does. All are
**Historical**.

| Plan | Shipped in |
|---|---|
| [plans/2026-07-13-codex-runner-stdin-forwarding.md](superpowers/plans/2026-07-13-codex-runner-stdin-forwarding.md) | Pre-0.9.0 Codex lane |
| [plans/2026-07-13-lane-architecture-enhancements.md](superpowers/plans/2026-07-13-lane-architecture-enhancements.md) | Pre-0.9.0 lane architecture |
| [plans/2026-07-14-bounded-delegation-attempt.md](superpowers/plans/2026-07-14-bounded-delegation-attempt.md) | Attempt Runtime bounds |
| [plans/2026-07-14-disable-codex-multi-agent.md](superpowers/plans/2026-07-14-disable-codex-multi-agent.md) | Nested-delegation refusal |
| [plans/2026-07-14-p0-runtime-implementation.md](superpowers/plans/2026-07-14-p0-runtime-implementation.md) | P0 runtime |
| [plans/2026-07-15-fresh-context-review-pipeline.md](superpowers/plans/2026-07-15-fresh-context-review-pipeline.md) | Review pipeline |
| [plans/2026-07-15-p0b-cross-platform-hardening.md](superpowers/plans/2026-07-15-p0b-cross-platform-hardening.md) | 0.9.0 |
| [plans/2026-07-15-p0c-producer-completion.md](superpowers/plans/2026-07-15-p0c-producer-completion.md) | 0.13.0 |
| [plans/2026-07-16-dogfood-hardening-wave.md](superpowers/plans/2026-07-16-dogfood-hardening-wave.md) | 0.14.0 |
| [plans/2026-07-16-orphan-cleanup-and-spec-tightening.md](superpowers/plans/2026-07-16-orphan-cleanup-and-spec-tightening.md) | 0.15.0 |
| [plans/2026-07-17-delegation-contract-repair.md](superpowers/plans/2026-07-17-delegation-contract-repair.md) | 0.17.0 |
| [plans/2026-07-17-legacy-codex-mcp-migration.md](superpowers/plans/2026-07-17-legacy-codex-mcp-migration.md) | 0.25.0 |
| [plans/2026-07-18-ralph-loop-integration.md](superpowers/plans/2026-07-18-ralph-loop-integration.md) | Iterative increments |
| [plans/2026-07-18-sliced-delegation.md](superpowers/plans/2026-07-18-sliced-delegation.md) | 0.21.0–0.23.0 |
| [plans/2026-07-23-native-subagent-delegation-phase-a.md](superpowers/plans/2026-07-23-native-subagent-delegation-phase-a.md) | 0.29.0 |
