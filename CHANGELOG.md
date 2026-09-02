# Changelog

All notable changes to Claude Architect are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[semantic versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- The repository moved to the `PyModel` GitHub organization. Every homepage,
  repository, issue, advisory, and release link now points at
  `PyModel/claude-architect`, and the install command is
  `claude plugin marketplace add PyModel/claude-architect`.
- README trimmed: the lead paragraph absorbs "Why it exists", lane overrides
  are a per-lane table (Claude Code takes model and reasoning effort only; Pi
  takes a thinking level and refuses a model override), and the filesystem
  and cleanup guarantees moved to `docs/operations.md`. The banner names all
  six lanes and no longer carries a stale version.

### Added

- `claude-implementer`: a sixth delegation-lane Producer that runs a headless
  Claude Code session (`claude -p --output-format json`) as an untrusted
  Producer, so the architect can delegate implementation to Opus or Sonnet
  (`producerOverrides.model`) with an optional `--effort` override. The attempt
  runs with `--strict-mcp-config`, `--setting-sources ""`,
  `--disable-slash-commands`, `--no-session-persistence`, and a built-in tool
  allowlist without `Agent`, so it sees only the Delegation Spec, cannot load
  this plugin's own MCP tools, and cannot nest subagents. darwin/arm64 only,
  confined by the same host Seatbelt backend as the Pi, OpenCode, Pythinker,
  and agy lanes.
- The delegate skill now names the architect-side roles a Claude subagent
  (Opus or Sonnet) may take — scouting, spec drafting, and independent candidate
  review through the new read-only `candidate-reviewer` agent — and the one it
  never takes: editing the checkout.

### Changed

- Producers declare their own host state directories through
  `ProducerInvocation.inheritedStateWritablePaths`; the macOS Seatbelt backend
  grants exactly those paths instead of guessing a Producer's config directory
  from its executable name or required environment variables. A new adapter
  therefore touches only its adapter file and the registry.
- The four OS-confined CLI adapters share one probe (`probeOsConfinedCli`)
  instead of four copies of the resolve → version → confinement → auth flow.

## [0.49.0] - 2026-08-08

### Changed

- The Pi delegation lane no longer accepts a `producerOverrides.model`
  override: it always runs the model configured in Pi itself, and a spec that
  names one fails the lane explicitly instead of silently substituting a
  different (possibly local) model. `--thinking` reasoning overrides are
  unchanged.

### Fixed

- MCP output contracts: the advertised `doctor` output schema now declares
  every key the tool returns (`git.path`, `sandboxBackends`, `dependencyClone`,
  `liveBundle`), and `delegatePipeline` declares the pipeline result's
  `failure` classification and the lane-mode correlation envelope. Strict MCP
  clients previously rejected these server-produced responses with -32602. A
  new output-schema contract test requires a byte-exact round-trip.
- The Pythinker adapter now forwards `PYTHINKER_CODE_HOME` to the invoked
  process. Previously the adapter used this variable to resolve the auth store
  and default `HOME`, and the Seatbelt policy already scoped write access to
  it, but the invoked `pythinker` process never received the variable itself
  and would silently fall back to its own default `~/.pythinker-code`. The
  adapter also disables Pythinker's background self-update
  (`PYTHINKER_CLI_NO_AUTO_UPDATE=1`, host-overridable) for the duration of a
  run, so the binary actually invoked cannot drift from the one just probed.
- Producer preflight no longer degrades every Pythinker run to "inconclusive".
  The preflight probe unconditionally forced a `reasoningEffort: "low"`
  override, which Pythinker's adapter rejects outright (by design, to avoid
  silently substituting an unsupported setting); the probe now retries once
  without the forced override when an adapter rejects it, restoring the
  preflight's actual purpose for that lane.

## [0.48.0] - 2026-08-04

### Added

- Antigravity CLI (`agy`) as a fifth delegation-lane Producer (`agy-implementer`),
  routed and confined by the existing `ProducerAdapter` contract: structured
  JSON output, `--add-dir`/`--new-project` worktree scoping, and Seatbelt
  write-confinement on macOS arm64, same platform ceiling as Pi and OpenCode.

### Changed

- Under the `autonomous` decision authority, `decideCandidate` now also
  auto-accepts a plain `delegate` result (not only `delegatePipeline`) when it
  is an independently verified candidate with no failure and no advisory
  warnings. A plain `delegate` run never enters the pipeline gate; its archive
  now records a positive `plainDelegate` provenance marker at the
  terminal-archive funnel, and autonomy keys on that marker plus its
  independent verification result. An archive carrying neither the marker nor
  pipeline-gate evidence proves nothing about its provenance and fails closed
  to a human, as does any failure, warning, or unreadable archive, through MCP
  elicitation, unchanged.

## [0.47.0] - 2026-08-04

### Fixed

- Seatbelt-confined Pi, OpenCode, and Pythinker edit-lane model sessions can
  reach their provider APIs while retaining filesystem write confinement;
  verification commands that deny network access remain OS-confined offline.

## [0.46.0] - 2026-08-03

### Fixed

- The Pythinker edit lane now invokes the documented non-interactive prompt
  mode without a conflicting permission flag and resolves authentication and
  configuration from `PYTHINKER_CODE_HOME` or `~/.pythinker-code`.

## [0.45.0] - 2026-08-03

### Fixed

- The Pythinker edit lane now emits the supported pythinker-code 0.5.1
  autonomous prompt and model arguments, rejects unsupported reasoning-effort
  overrides before spawn, and fails closed during probing when the CLI help
  surface lacks any option the adapter can emit.

## [0.44.0] - 2026-08-03

### Security

- Autonomous acceptance now requires a durable pipeline-gate clearance record
  bound to the archived candidate commit. Plain delegation and missing,
  malformed, human-required, or commit-mismatched evidence fail closed to human
  elicitation.

### Changed

- The verified SDD wrapper now distinguishes the architect-owned branch home
  from runtime-owned attempt worktrees and lets a repository-defined delivery
  gate supersede Superpowers' generic direct merge/push finish. This repository's
  agent policy routes Superpowers SDD through verified delegation, hands manual
  SDD branches to No Mistakes only after explicit authorization, and prevents
  stacking that gate with Claude Architect Autopilot.
- Manual delegation now labels its read-only spec validation and its single
  execution dispatch as two MCP calls but one execution run. It distinguishes
  plain delegation's one implementation attempt (after its separate edit-lane
  environment probe) from a pipeline's multiple fresh implementation, review,
  and repair Producers, and forbids a second dispatch
  while the original execution call is pending.

### Fixed

- Windows removal and validation reliability: identity-revalidating filesystem
  helper calls (directory open, ACL validation, delete disposition) retry
  bounded transient sharing violations — such as antivirus scans of freshly
  written files — instead of failing an entire cleanup transaction on the first
  denial; the bound-cleanup child now names its failing clause with redacted
  code-only diagnostics; and the checkout-lock wait deadline is calibrated for
  Windows process-spawn latency so designed serialization no longer reports
  spurious `checkout-locked` contention. Every path handed to the native
  filesystem helper is now `\\?\`-namespaced, so identity-bound removal and
  validation work on worktree paths past `MAX_PATH` instead of failing with
  `ERROR_PATH_NOT_FOUND`.
- Startup recovery now sweeps proven orphaned registered worktrees regardless
  of their names while preserving unproven directories and worktrees claimed by
  live, ambiguous, or independently owned runs and workflows. Removal uses
  bigint inode plus birth-time identity, inode-bound quarantine traversal,
  parent-directory durability syncs, and a durable staged transaction for only
  the exact Git registration under the checkout lease. Removal manifests replay
  before stale-run inspection, registration paths are compared canonically, and
  Autopilot stale registrations and run worktrees whose physical directories
  vanished use the same recoverable removal owner instead of raw recursive
  deletion. Unresolved removal manifests pause run/workflow cleanup; transient
  Git failures, malformed or conflicting ownership entries, symlinked metadata
  roots, and forged quarantine names fail closed. Creation publishes a bound
  intent before `git worktree add`, so an immediate crash or managed-root
  substitution can recover the hidden physical inode and exact registration.
  On POSIX upgrades, recovery
  safely tightens legacy runtime state/worktree directories from group/world-
  readable modes to `0700` after binding and rechecking their filesystem identity.
  Group/world-writable, wrong-owner, or substituted roots remain blocked; operators
  must restore the runtime-data owner and remove group/world write bits before restart.
  Newline/Unicode and
  case-equivalent Windows paths remain intact, and bounded redacted sweep issues
  are visible at MCP startup. Packaged x64/arm64 native helpers now validate
  Windows ACLs, flush directory metadata, and delete identity-matched handles;
  trusted runtime cleanup no longer depends on PowerShell. Cleanup-backend
  prerequisites are checked before Git creates a worktree and fail with an
  actionable classification.
- Final-review head-bound phases now retain one real checkout lease through
  materialization cleanup and every concluding head, tree, and branch-identity
  revalidation on both success and failure paths.
- Producer preflight now propagates managed worktree cleanup failures instead
  of recursively deleting the checkout and potentially stranding its Git
  registration. When probing, cancellation, or bounded probe-file reading also
  fails, the ordered aggregate retains that primary outcome before cleanup.
- Startup recovery now preserves a non-terminal run whose recorded owner
  process is verified alive even when its checkout lock entry has vanished,
  classifying owners through the shared lock-owner status rule instead of
  terminating them.
- MCP startup's mutation-recovery gate only resolves the caller's repository
  when a preserved sweep issue could belong to it, so ambiguity recorded for an
  unrelated repository no longer blocks another repository's mutating tools.
- Checkout locks now require the repository's Git common directory on every
  platform instead of falling back to the canonical checkout path.
- Workflow branch-registration reads no longer swallow filesystem errors:
  an absent record still reads as unregistered, while permission and I/O
  failures propagate as failures instead of masquerading as absent ownership.

## [0.43.0] - 2026-07-28

### Fixed

- Atomic workflow-state publication now compares bigint file identities and
  nanosecond timestamps. Windows 64-bit file IDs can lose precision as
  JavaScript numbers, which intermittently let a substituted temporary state
  file compare equal to the original during the fail-closed publication gate.

## [0.42.0] - 2026-07-28

### Added

- `/claude-architect:codex`, a direct, unverified Codex CLI lane for running
  `codex exec` against the user's checkout. The skill preserves the current
  model and reasoning roster, uses explicit sandbox modes, retains stderr
  diagnostics, closes harness stdin across platforms, and points users to
  `/claude-architect:delegate` when they need an isolated worktree, a frozen
  Candidate Artifact, independent verification, and controlled integration.

## [0.41.0] - 2026-07-27

### Security

- `@hono/node-server` now resolves to 2.0.12, past the 2.0.5 that patches
  GHSA-frvp-7c67-39w9 (path traversal in `serve-static` on Windows via an
  encoded backslash). `npm audit` reports no vulnerabilities. The package
  reaches this tree only as a transitive dependency of the MCP SDK, and SDK
  1.29.0 pinned it to `^1.19.9` — a range that cannot reach the patch, which is
  why Dependabot's own update job failed rather than proposing a bump. Upgrading
  `@modelcontextprotocol/sdk` to 1.30.0, which declares
  `^1.19.9 || ^2.0.5`, makes the fix reachable.

### Added

- Autopilot: a trusted controller that carries a multi-task workflow from spec
  to a draft pull request without a mid-loop prompt. It owns branch management,
  hash-bound eligibility, candidate promotion, cumulative final review of the
  whole branch, exact-head push, draft-PR identity, required-check polling, and
  recovery. Three MCP tools drive it — `autopilotStart`, `autopilotStatus`, and
  `autopilotResume`. Only a human may merge.
- An advisor stage between the pipeline and the decision gate, producing a
  frozen `AdvisorReport` bound to the evidence it reasoned over.
- `ReviewSnapshot`: the frozen, hash-bound bytes a reviewer sees.
  `reviewCandidate` now returns this instead of a loose patch bundle, so the
  decision and the review provably concern the same artifact.
- A durable, typed `RunStatus` in `status.json` carrying mode, slice, round,
  role, and Producer, plus an opt-in statusline that renders it.

### Changed

- **Protocol 1.4.0 → 2.0.0, Runtime 0.40.0 → 0.41.0.** `decideCandidate` now requires
  `expectedArtifactHash`, and `reviewCandidate` returns a `ReviewSnapshot`.
- Candidate decisions are versioned records carrying the authority that made
  them: `human`, `policy-autonomous`, `autopilot-policy`, or `caller-asserted`.
  The autonomous authority shipped in 0.39.0 survives as a first-class value
  rather than being recorded as a human decision — which candidates went in
  without a person is answerable by reading the archive, never inferred.
- Integration admits an acceptance only from an authority on the shared
  integrable list. `caller-asserted` and pre-provenance records are refused:
  both mean the runtime does not know how the decision was reached, which is a
  different thing from knowing it was policy.
- Terminality is expressed by the run phase rather than a separate flag, so a
  finished run can no longer read as one still working.
- `@modelcontextprotocol/sdk` 1.29.0 → 1.30.0, and `zod` 3.25.76 → 4.4.3. The
  SDK's new `zod: "^3.25 || ^4.0"` range removes the dual-copy `TS2589`
  constraint that held this project on zod 3. The only affected call site is the
  protocol-version input schema: `errorMap` became `error` returning a string,
  and `invalid_literal` no longer exists, so the received value is read from
  `issue.input` for both the wrong-value and the absent-key case. Both
  diagnostics are byte-identical to the previous behavior.

### Fixed

- Decision archives written by 0.39.0 and 0.40.0 are readable again. The
  candidate-decision parser accepted only the original two-field record, so
  every archive the shipped runtime produced failed to parse — which would have
  stranded recovery, integration, and prune's retain-undecided-runs branch.
- A baseline command that collected no tests is no longer accepted as proof of
  a red baseline. It cannot distinguish "the assertion failed" from "nothing
  ran", in either direction.
- The advisor role's prompt schema is stripped of `$schema` like every other
  role's, so the runtime stops inducing the invalid Producer output it then
  punishes.

## [0.40.0] - 2026-07-27

### Added

- `validateDelegationSpec` gives the architect a read-only, side-effect-free
  preflight that returns the runtime's canonical `specSha256`. A live lane
  exposed the missing contract: the controller hashed the spec file's raw bytes
  while the runtime hashes canonical JSON semantics, producing different
  identities for the same valid spec and making exact-spec review/recovery fail.
  The shared validator now also keeps direct and pipeline dispatch validation
  behavior identical, including unknown Producer diagnostics.
- Both dispatch tools accept an optional `expectedSpecSha256` guard. Native
  lanes pass the digest returned by `validateDelegationSpec`; a valid but
  different payload now fails before checkout access, locking, preflight, or
  Producer execution. Legacy callers may omit the field.
- Cancellation is now proven end-to-end, not just checked. Every existing
  cancellation test injects an `AbortSignal` directly into attempt or pipeline
  dependencies, which demonstrates the runtime honors a signal but cannot
  demonstrate one is ever raised — the test supplies the aborted signal itself.
  The link none of them covered is the one that failed in practice: a caller
  gives up, and whether that becomes an aborted `extra.signal` depends on the
  client emitting `notifications/cancelled` and the SDK wiring it through.
  `tests/runtime/mcp-cancellation.test.ts` drives a real SDK client over an
  in-memory transport, aborts a live `delegate` call, and asserts the signal the
  attempt runtime received fires. `ServerDependencies` gained a `transport` seam
  so a test can connect a client without a stdio process. Cancellation still
  depends on the host emitting `notifications/cancelled` on task-stop; that is
  the client's half of the protocol and remains unobserved live.

### Fixed

- Decision provenance is now enforced at integration, and decision retries are
  bound to it. Integration accepts `human-elicitation` and `policy-autonomous`
  provenance and refuses what the runtime cannot vouch for — `caller-asserted`
  records, and records predating the field — with
  `accepted-decision-not-confirmed`. A later confirmation no longer reports a
  false successful write over an immutable record: retries are idempotent only
  when the decision, provenance, and candidate binding all match, and otherwise
  return `decision-conflict`.

  The autonomous decision authority introduced in 0.39.0 is retained. A
  concurrent change briefly removed it and required `human-elicitation` at
  integration; that combination made an autonomous acceptance unspendable, which
  reintroduced the prompt by another route. The authority remains as documented:
  a candidate that is independently verified, unwarned, and readable is recorded
  without prompting; everything else still elicits and still fails closed, and
  `CLAUDE_ARCHITECT_DECISION_AUTHORITY=human` restores confirmation for every
  decision.
- The native delegation lane fails closed when its prompt omits the complete
  Delegation Spec JSON. In a live session it received only a spec-file path,
  despite having no filesystem tool, and invented two invalid payloads before
  the architect recovered by inlining the spec. The courier contract now
  forbids either dispatch call on an incomplete handoff, while the architect
  validates and obtains the canonical digest before creating the lane.
- Security documentation now matches the enforced boundary: which decisions
  prompt, which are recorded by policy, and which provenance may authorize
  integration. It still documents the real residual boundary accurately — where
  elicitation applies the host is trusted to present it faithfully, and no
  cryptographic human identity is established.
## [0.39.0] - 2026-07-27

### Changed

- **Delegation now runs to completion without asking permission, by default.**
  Making acceptance human-only in 0.36.0 put a prompt on the happy path — the
  case where the runtime had already proven everything it knows how to prove —
  and a delegation that stops mid-flight to request permission is not
  delegation. `decideCandidate` now records a decision without prompting when
  the candidate is an independently verified result with no failure, no advisory
  warnings, and a readable archive, marking it `decidedBy: "policy-autonomous"`.
  Every other case — unverified, gate-refused, review-incomplete, or an archive
  that could not be read — still raises MCP elicitation and fails closed without
  it. Set `CLAUDE_ARCHITECT_DECISION_AUTHORITY=human` to require confirmation
  for every decision; an unrecognized value fails closed to `human` with a
  warning, so a typo cannot silently select the permissive mode.

  Eligibility is a positive condition, deliberately not "no warnings were
  raised": a plain `delegate` run carries neither pipeline-gate nor review
  evidence, so keying autonomy off warning-absence would auto-accept whatever it
  produced. An unreadable archive refuses rather than downgrading to a prompt —
  under this policy a client may not advertise elicitation at all, so a silent
  downgrade would dead-end the run with no path forward.

  Human control moved to where it is load-bearing rather than disappearing.
  Independent verification still gates what may be accepted at all, integration
  still refuses a moved `HEAD`, a dirty tree, or a hash that does not match the
  reviewed artifact, and the provenance of every decision is recorded, so
  auditing which candidates went in without a person does not require inferring
  it. `AGENTS.md`, `README.md`, `docs/SECURITY_MODEL.md`, and the delegate skill
  were amended together — the trust invariant they stated is now the configured
  authority they describe, so a later session cannot read the old text as law
  and "fix" the code back.

## [0.38.0] - 2026-07-27

### Fixed

- Human decision elicitation waits 15 minutes instead of the MCP SDK's
  60-second default request timeout. Making acceptance human-only in 0.36.0
  passed no timeout option, so a person had one minute to read a candidate
  patch, weigh verification evidence, and decide; live acceptance attempts
  failed at exactly 60s. A gate that no human can pass in time does not enforce
  human control — it removes the supported path and pushes work to hand-applied
  changes outside the lifecycle, which is the outcome the gate exists to
  prevent.
- Checkout drift no longer fails a frozen candidate's verification. The
  `base-changed` structural failure covered three conditions at once: the
  artifact not matching its own base — intrinsic, and still a failure, now named
  `artifact-base-mismatch` — plus the shared checkout's HEAD having moved and the
  shared checkout being dirty. The latter two are mutable state extrinsic to a
  frozen artifact, re-checked authoritatively under the repository lock at
  integration, and free to change again in between, so failing verification on
  them discarded valid work while proving nothing. They are recorded as
  `checkoutDrift` evidence instead, visible to whoever decides integration.
  Integration still aborts unless the checkout matches the reviewed base.
  The sliced pipeline previously suppressed `base-changed` wholesale to survive
  this, which also suppressed the integrity half; that exemption is gone.
- Slice repair attempts receive the evidence from every earlier attempt.
  `runSliceToCompletion` accumulated each attempt's failing verification
  commands, blocking findings, and routing reason for the report a human reads
  afterwards, and handed the next attempt only a round number — so a
  fresh-context implementer could not see the failure it was dispatched to fix
  and reproduced it until the round budget was gone. The summary is bounded
  (reason, failing command ids, blocking findings) rather than replayed logs,
  and stays out of reviewer prompts: a reviewer judging loop history instead of
  the candidate is biased toward confirming the prior verdict.
- A sliced pipeline records the spec hash the caller dispatched. `scopeSpecToSlice`
  merges the slice over the spec and drops `slices`, so the attempt hashed a spec
  no caller ever wrote — meaning `reviewCandidate`'s `expectedSpecSha256` check,
  added in the same cycle, would have rejected every correct sliced run while
  proving nothing about incorrect ones. The dispatched identity is now passed
  down explicitly rather than derived from whatever spec the attempt receives.
- `status.json` records a terminal phase. It named every phase a run entered and
  none of its completion, so "archiving result" meant both "currently archiving"
  and "finished long ago", leaving the one question the file exists to answer —
  is this run still alive — unanswerable. Runs now end at `finished: <status>`
  with `terminal: true`, on the failure path as well.

## [0.37.0] - 2026-07-27

### Fixed

- A pipeline whose gate refused the candidate no longer archives an attempt that
  looks clean. The gate's verdict lived only in the `pipeline-result` artifact,
  but the accept path reads the archived *attempt* — which still said
  `verified-candidate` with no failure — so "blocking findings survived a fix
  round" or "clean-room verification failed" was invisible at decision time.
  `archiveSlicedFailure` already recorded incompleteness in attempt evidence for
  exactly this reason; the completed-but-refusing path did not. The refusal is
  now written to `pipelineGateRefused`, surfaced by `reviewCandidate`, and shown
  in the elicitation prompt, so a human cannot spend a decision without seeing
  it. Acceptance is still theirs to give: the gate advises, it does not veto.
- A run whose archive cannot be read reports that as a warning at decision time
  instead of presenting an unknown candidate as an unflagged one.

- `reviewCandidate` accepts `expectedSpecSha256` and proves the run it is asked
  about was started from that spec. A delegation lane reports its own `runId`
  and echoes back the spec hash it was handed, so both are claims by the party
  under review; a lane naming a *different real* run returned a clean candidate
  for unrequested work. `specSha256` was persisted at run start for exactly this
  comparison and nothing performed it. Omitting the argument preserves the
  previous behavior; supplying one that cannot be checked fails closed with
  `run-spec-unverifiable` rather than passing by omission.
- The spec hash is canonical. It was `sha256(JSON.stringify(spec))`, which
  depends on key insertion order, so the architect's digest and the runtime's
  could differ for structurally identical specs — failing the correspondence
  check on correct runs while proving nothing about wrong ones. Keys are now
  sorted at every depth; array order is preserved because it carries meaning.
- `delegatePipeline` bounds its ignored-path evidence. The 50-entry cap existed
  and `delegate` applied it, but the helper reads `value.evidence` while a
  pipeline's evidence sits at `result.attempt.evidence`, so this path returned
  the list untouched. Measured on a real run: 2026 `node_modules` paths,
  161,874 bytes — 68% of a 238 KB response, against 26,683 bytes for the actual
  candidate patch. The guard was written, tested on one path, and inert on the
  other.

### Security

- `fast-uri` moves to 3.1.4, clearing the high-severity advisory. It arrives
  through `ajv`, which is already at its latest release and declares
  `fast-uri: ^3.0.1` — the patched version was always inside that range and the
  lockfile had simply resolved lower, so nothing crossed a semver boundary.
- The remaining moderate advisory (`@hono/node-server` path traversal in
  `serve-static` on Windows) is left in place deliberately. It reaches the tree
  through `@modelcontextprotocol/sdk`, and npm's proposed remedy is to *downgrade*
  the SDK from 1.29.0 to 1.24.3. The vulnerable code neither ships nor runs here:
  the runtime uses `StdioServerTransport`, so the HTTP transport is never
  imported and `grep -c hono runtime/server.mjs` is 0, and `serve-static` is a
  file server this project never invokes. The real fix is SDK v2, which requires
  `zod >= 4.2` against a deliberate v3 pin (see AGENTS.md) and is still beta.

## [0.36.0] - 2026-07-27

### Breaking

- `decideCandidate` now requires MCP elicitation and fails closed without it. The
  runtime confirms the decision with a person itself rather than recording
  whatever the caller passed — an agent is a caller, which is how architect
  agents accepted and integrated their own candidates. Clients that do not
  advertise the `elicitation` capability cannot record a decision at all;
  degrading to caller-trust would silently restore the hole. Rejection and
  revision are gated identically, because an agent that can discard a candidate
  can bury work it dislikes.

### Fixed

- The consolidator no longer infers a contradiction from differently worded
  required outcomes at one location. Complementary findings qualified, and a nit
  beside a major differs textually by construction, so independently green,
  reviewer-approved candidates were halted — a regression introduced in 0.33.0
  when that signal became a hard stop. `detectNonConvergence` replaces it with an
  observable property: a location whose *blocking* findings outlived a fix round.
  The slice-level halt is removed outright, since a slice sees exactly one review
  round and non-convergence is not observable there.
- Decisions are auditable. `decision.json` was `{decision, recordedAt}` with no
  actor, so a human's acceptance and an agent's were indistinguishable even
  retrospectively. Records now carry `decidedBy` and the `candidateManifestHash`
  they bind to, and `integrateCandidate` aborts with `decision-artifact-mismatch`
  rather than spending an acceptance on a different artifact.
- `reviewCandidate` returns `manifestHash`, the exact value `integrateCandidate`
  requires, instead of forcing the architect to source it from another tool.
- `decideCandidate` and `integrateCandidate` are annotated destructive.
- `run-start.json` is archived before baseline verification instead of after it
  and after Producer selection, so a run killed during either is still
  correlatable. It now also records `specSha256`, which lane dispatch computes
  for exactly that recovery but which nothing persisted — making the documented
  "find the run whose recorded spec matches" impossible.

- Runs record their current phase durably in `status.json`. Phase transitions
  were reported only through an in-process callback, so the sole persisted trace
  of a live run was the single "attempt lock acquired" line written at startup —
  a pipeline ten minutes into a slice was indistinguishable from one wedged at
  the lock. The write is awaited before the phase it names begins, so an
  interrupted run is locatable, and a failed write stays advisory.
- A repository lock that times out now names its holder. `checkout is locked:
  <path>` was the identical message for a live sibling session mid-attempt, a
  lock file leaked by a process that died, and a record startup recovery refuses
  to parse — situations that resolve themselves, resolve at the next server
  start, and never resolve without a human, respectively. Lock records also
  carry `acquiredAt` and, where the acquirer knows it, `runId`, so contention
  reports how long the holder has had it and which run to look at. The probe is
  best-effort and bounded: any failure leaves the original timeout untouched,
  and the owner's process token is never disclosed.

### Added

- `baselineFailureExitCodes` on a verification command narrows which exit codes
  satisfy `expectBaselineFailure`. Without it any completed non-zero exit
  qualifies, so a missing test file proves the same thing as a test that ran and
  asserted false; declaring `[1]` for pytest makes the baseline a real
  fail-before/pass-after proof. Omitting it preserves the previous behavior.

## [0.35.0] - 2026-07-27

- fix: an ordinary verification failure no longer also claims the reported
  outcomes mismatch the declared commands. `command-outcome-mismatch` is a
  trust-boundary signal — the outcomes do not correspond to what the host asked
  to run — but the predicate behind it also tested `expectedExitCodes`, so every
  failing command raised it alongside `command-failed:<id>`. All 15 occurrences
  in the local run archive were this false pairing; none coincided with a real
  mismatch. The correspondence check now covers identity, count, skip semantics,
  and whether a result was reported at all, and leaves pass/fail to
  `command-failed`. This also restores the signal's meaning: a genuine mismatch
  is no longer indistinguishable from a failing test.
- fix: a producer id naming no shipped adapter is now rejected as a spec defect
  before dispatch. `producerPreferences` is typed as plain strings, so an agent
  name such as `codex-implementer` validated cleanly and surfaced much later as
  `unavailable / no-eligible-producer` — which reads as "Codex is not installed"
  rather than "that is not a producer id" — and bypassed the spec-repair loop
  that exists so a malformed spec never reaches a Producer. Both `delegate` and
  `delegatePipeline` now return `validationErrors` naming the offending index and
  the ids the registry actually ships.
- docs: `subagent-driven-delegation` now maps every Superpowers skill the
  methodology names — `dispatching-parallel-agents`, `test-driven-development`,
  `systematic-debugging`, `verification-before-completion`, and
  `requesting-code-review` — to how delegation realizes it, including that a
  repository is shared state, so same-repository lanes serialize and must never
  be presented as parallel.

## [0.34.0] - 2026-07-26

- fix: `expectBaselineFailure` no longer excuses a command that never ran. The
  flag asserts that a command executes at clean HEAD and reports failure — a
  claim about the command's verdict. The gate excused every failure mode
  instead, so an unresolvable executable, a timeout, a cancellation, or death by
  signal all satisfied it. That silently voided the environment-defect gate for
  any command carrying the flag: the runtime promises an unresolvable executable
  ends the attempt before the Producer runs, and for these commands it did not.
  Command execution now reports how the process terminated, and only a real
  completed exit can satisfy the flag. A command that fails because it could not
  start is a baseline failure again, as it always should have been.
- fix: a command declaring `expectBaselineFailure` that *passes* at clean HEAD is
  now a baseline failure too. The flag declares the command cannot pass by
  design; a green run contradicts the declaration, so the fail-before/pass-after
  evidence the flag exists to supply was never produced. Both halves of the
  declaration — that the command runs, and that it fails — are now enforced.
- docs: the spec-authoring guide now warns that a text-search verification gate
  must not be able to match prose. An absence check such as
  `rg "except RuntimeError"` expecting no match also matches the phrase inside a
  comment or docstring, so a Producer that documents why it avoided the pattern
  fails a gate its code actually satisfies — observed live, rejecting an
  otherwise clean attempt. Both the delegate and subagent-driven-delegation
  skills now say to anchor such patterns to syntax or assert over parsed
  structure. The guide also documents that `expectBaselineFailure` is enforced
  in both directions.
- fix: the bootstrap smoke tests no longer leak the re-executed server. All
  three signal tests learned the server's pid inside the `try` that could throw,
  so a timed-out pid read left the grandchild — which holds an interval timer —
  running as an orphan. One was found alive nearly six hours after its temp
  directory had been deleted. Cleanup now re-reads the pid file and never
  depends on the step that failed.
- feat: new `/claude-architect:subagent-driven-delegation` skill runs the
  Superpowers subagent-driven-development loop — ledger, per-task brief,
  per-task review, final whole-branch review — with the verified delegation
  lifecycle substituted for the generic implementer subagent. Each task becomes
  a Delegation Spec executed in an isolated worktree, frozen as a Candidate
  Artifact, and independently verified before review. The skill states the four
  points where a trust invariant overrides upstream SDD: there is no implementer
  resume, the controller never closes a task, implementer self-review is not a
  review, and the controller never fixes findings itself. Because integration
  stages rather than commits, the skill also gates each task on the user
  committing the staged tree and a confirmed clean checkout — without that gate
  the next task's dispatch would fail delegation's clean-checkout precondition.

## [0.33.0] - 2026-07-26

- fix: Producer git calls no longer spawn a full `xcodebuild` lookup each time.
  Codex runs commands through a login shell, so `/etc/zprofile` runs
  `path_helper`, which rebuilds `PATH` with the `/etc/paths` entries first; the
  per-attempt temp home has no `~/.zprofile` to re-prepend Homebrew, so `git`
  resolved to `/usr/bin/git`. That stub finds the real binary through `xcrun` and
  caches the answer in the macOS per-user temp directory, which the Producer
  sandbox denied — so the cache never persisted and every invocation re-ran
  `xcodebuild -find git`, measured at 1.01s per call against 0.012s cached. On a
  suite that shells out to git repeatedly this became hundreds of concurrent
  `xcodebuild` processes. The edit lane now receives that one directory as a
  writable root; the read-only lane receives no support roots at all.

  Scope of the relaxation, stated plainly: the runtime passes the host `TMPDIR`
  through unchanged and macOS normally points it at that same directory, so where
  that holds this reopens what `sandbox_workspace_write.exclude_tmpdir_env_var`
  closed. `exclude_slash_tmp` still applies, `/tmp` stays unwritable, and worktree
  confinement is unchanged. No narrower directory is possible: `xcrun` resolves
  the cache through `confstr(_CS_DARWIN_USER_TEMP_DIR)` and ignores `TMPDIR`.
  Only the Codex lane was affected; the Seatbelt profile used by the other
  Producers already made this directory writable.

- fix: a review whose findings demand conflicting outcomes at the same location
  no longer consumes the repair budget. No patch can satisfy both findings, so
  the slice gate now halts immediately and names the contradiction instead of
  spending every attempt to reach the same halt, and the final gate — which
  ignored contradictions entirely — routes them to a human decision.

- docs: `expectBaselineFailure` is all-or-nothing for the command it sits on, so
  a command covering both an existing path and one the candidate creates forces
  the flag on and suppresses the baseline signal for both. The delegate skill now
  requires splitting such a command rather than blanket-marking the set.

## [0.32.0] - 2026-07-26

- fix: a cancelled `delegate` or `delegatePipeline` request now actually stops
  the run. Every layer below the MCP boundary already honored an `AbortSignal`,
  but nothing supplied one, so cancelling a call left the Producer tree running
  and the pipeline advancing — and because a killed Producer never looked
  cancelled, the role runner retried it and launched a successor. The request's
  signal is now threaded into attempt and pipeline dependencies, and the
  increment and review-round loops stop rather than starting the next phase.
- fix: `git` is resolved once per search environment instead of on every
  invocation. Each call previously walked every `PATH` entry with an `fs.access`
  probe; the cache is keyed on `PATH`/`Path`/`PATHEXT` so a caller that installs
  a shim still resolves afresh.
- feat: `doctor` reports the resolved `git` path alongside its version. A host
  whose `PATH` selects a wrapper rather than a real git behaves very differently
  under load, and that was invisible from the version string alone.

## [0.31.0] - 2026-07-26

- feat: `/claude-architect:delegate` now separates architect-side Superpowers
  planning and coordination from the three vendored Producer procedures:
  test-driven development, systematic debugging, and verification before
  completion. Release validation fails when any of their `SKILL.md` files is
  missing or empty, and the README records the upstream 6.2.0 MIT attribution.
- feat: every edit-lane Producer prompt now carries a delegated-skill bootstrap
  naming those three procedures by absolute path, plus the skills that stay
  forbidden by trust invariant — nested delegation, self-review, branch
  acceptance, worktree creation, and the host-loop skills. Read-only lanes are
  unchanged. The bootstrap resolves lazily, so an incomplete install fails the
  edit lane instead of the whole runtime.
- docs: spec authoring now requires bounding test parallelism for the commands a
  Producer runs itself, not only for verification commands; an unbounded runner
  inside an attempt fans out to one worker per core on top of the attempt.

## [0.30.0] - 2026-07-24

- fix: the pre-push tag gate now requires the **exact tagged commit** to have a
  completed, successful `ci` run containing a green Windows job. The previous
  gate consulted the branch's latest run and treated a still-running workflow as
  "not failing", so `v0.29.0` was tagged while its own CI was mid-flight and
  about to fail on Windows. Without `gh` the tag gate refuses rather than
  degrading to a no-op.
- fix: a baseline verification failure retains each command's stdout and stderr,
  so it can be diagnosed without rerunning the attempt.
- test: the plugin wiring check asserts the shipped bundle embeds no
  worktree-relative `node_modules` paths, enforcing the rule that keeps
  `runtime/server.mjs` out of Producer write allowlists.

## [0.29.0] - 2026-07-23

- feat (protocol 1.4.0): slices may declare `dependsOn` — the 1-based indices of
  the slices they must observe — and a spec may raise `sliceConcurrency`. Slices
  run together only when their dependencies allow it *and* their write
  allowlists are pairwise disjoint; structural verification already confines each
  slice to its own allowlist, so disjoint allowlists mean disjoint changed paths
  and composing a wave is a conflict-free union with no merge to get wrong.
  Omitting `dependsOn` means "after every preceding slice", so existing specs
  behave exactly as before and parallelism stays opt-in.
  Composition is proven byte-identical to sequential application, and the
  composed candidate still faces the spec's full verification regardless of
  scheduling: an under-declared dependency fails at that gate rather than
  shipping. Worktree creation is serialized even while Producers run in parallel.

- fix: a worktree that cannot be cleaned up no longer erases the outcome of the
  work it held. A slice timeout previously came back as a hard runtime error with
  the graceful result lost and an orphan directory left behind (dogfood finding
  16); cleanup failures are now reported beside the result — in the run's
  `logs/cleanup-failure.log` and the server log — while the attempt, verification,
  and round outcomes stand. Terminal artifacts stay immutable.
- fix: worktree removal retries on every platform, not only Windows, since a
  Producer's test children can hold a worktree open anywhere. When Git still
  refuses, the checkout is removed directly and its registration pruned, so
  neither an orphan directory nor a dangling `.git/worktrees` entry survives. A
  path Git no longer tracks is left untouched.

- feat: both delegate handlers now name the tracked files that import the write
  allowlist but sit outside it, before dispatch. A delegation that changes an
  exported contract otherwise leaves its consumers unrepairable by the Producer
  and uncompiled by focused verification, surfacing as hand-fixing at integration
  time (dogfood findings 22, 0.27.0 #1, autopilot #2). Advisory only.
- refactor: the write-allowlist path matcher lived in three copies, two of which
  enforce the write boundary. They now share `src/util/glob.ts`; a matcher that
  can drift between the freeze check and the structural verifier is a hole
  waiting to open.

- feat: before an edit attempt spawns its Producer, the runtime probes the
  Producer's own shell and sandbox for the executables the spec's verification
  commands name, in a disposable worktree with the same temporary home, sandbox
  wrap, and environment the attempt will use. An unresolvable executable ends the
  attempt as `environment-defect` in seconds instead of at the attempt timeout.
  The runtime reads the probe file the Producer wrote rather than trusting a
  summary, and only an unambiguous miss blocks — a false positive would cost a
  whole delegation (dogfood findings 13, 23). Opt-in gate:
  `RUN_CODEX_PREFLIGHT_GATE=1`.

- fix: a role that cannot produce parseable structured output no longer destroys
  an independently verified candidate. The pipeline promotes and re-verifies the
  bytes that exist and returns `human-decision-required` carrying that candidate,
  recording in the archived result that its own review never completed. A
  candidate whose re-verification is red is demoted so the accept gate refuses it,
  while its bytes are retained. Previously a review or fix role failure archived
  `status: failed` with `candidate: null`, deleted the candidate anchor, and forced
  a full re-dispatch of work that had already passed (dogfood findings 6, 9, 10, 12).
- fix: a review round is recorded as soon as its reviews are consolidated, so a
  later fix failure no longer erases review work already written to
  `pipeline/round-*.json`.

- fix: the Codex Producer shell no longer starts without a `PATH`. Codex applies
  `include_only` as a filter over the inherited set, so `inherit="none"` yielded
  an empty shell environment: Producers could not resolve `node`, `npx`, or
  `git`, and burned whole attempts inventing workarounds. The adapter now uses
  `inherit="core"` with `set` for the non-core variables (nested-delegation
  guard, redirected Git object directories) and an explicit `exclude` for
  Codex's own credential and packaging variables, which it re-injects after the
  inherit filter runs.
- test: new opt-in gate (`RUN_CODEX_SHELL_ENV_GATE=1`) proves against real Codex
  that the Producer shell resolves `node` and `git`, carries
  `CLAUDE_ARCHITECT_DELEGATED=1` and the per-attempt `HOME`, and never sees
  `CODEX_HOME`.

## [0.28.0] - 2026-07-23

- feat: new `delegation-lane` subagent — dispatch any delegation lane as a native Claude Code subagent for live visibility (spinner, stats, completion row). Produce-only by construction: its tool allowlist is exactly `delegate` + `delegatePipeline`; review, decision, and integration remain in the architect session with the human gate unchanged.
- feat: `skills/delegate/SKILL.md` gains "Lanes as native subagents": `laneId`/`specSha256` correlation, honest same-repository serialization (the runtime lock is unchanged), one-accepted-candidate-per-clean-checkout rule, and the canonical decision card.
- test: plugin wiring now asserts the delegation-lane produce-only contract; the legacy per-producer agent files remain banned.

## [0.27.0] - 2026-07-21

### Added

- The MCP server now prunes the run archive once per boot, after crash
  recovery. Terminal runs older than 14 days, or the oldest terminal runs once
  the archive exceeds 1 GiB, are reclaimed; active, incomplete, and undecided
  runs are always retained. A prune failure only logs a redacted diagnostic and
  never blocks startup.

### Changed

- Prune-failure and recovery quarantine diagnostics now share a single bounded
  redaction helper (`boundedRedactedDiagnostic`) so filesystem and Git error
  messages are stripped of repository paths before any runtime log.

## [0.26.0] - 2026-07-19

### Changed

- Toolchain to latest: TypeScript 7.0.2 (stable native Go compiler), Vitest 4,
  esbuild 0.28. `zod` deliberately stays on latest v3 while the runtime uses
  `@modelcontextprotocol/sdk` v1.x (which pins `zod ^3`); see the dependency
  version policy in `AGENTS.md`.

## [0.25.0] - 2026-07-19

### Removed

- Removed the packaged legacy implementation/advisor lanes and their compatibility fallbacks from the documented workflow. All supported Producers now use the validated MCP lifecycle, fail closed when edit eligibility or confinement cannot be proven, and recovery no longer accepts PID-only checkout-lock ownership.

## [0.24.0] - 2026-07-19

### Added

- Optional top-level and per-slice `allowedTestDeletions` globs let architects
  authorize intentional test-file removals while preserving the pipeline's
  fail-closed guard and recording each authorized deletion in verification evidence.

## [0.23.0] - 2026-07-19

### Fixed

- Cleanup convergence when a delegating repository is deleted. Previously a
  vanished `repoRoot` made `canonicalizePath` throw: normal-path prune caught it
  and retained the run forever (its bytes never reclaimed, so `maxBytes`/`maxAge`
  could not converge), and — more seriously — a repo-gone *pending* cleanup intent
  made `validateRepositoryRoot` throw outside the per-record guard in
  `replayInterruptedPrunes`, aborting the entire crash-recovery pass on every run
  (a permanent block). Both paths now reconcile a repository-absent run without
  Git: prune reclaims the archive directly (no lease, no ref cleanup — the
  candidate and backup refs died with the repository, and no live checkout can
  integrate from a vanished repository), and recovery detects the absent
  repository before validation and completes or rolls back the archive by disk
  state, converging instead of aborting.

## [0.22.0] - 2026-07-19

### Fixed

- Crash-recovery cleanup journal: close a cross-process race where recovery's
  torn-tail truncation could erase a cleanup intent a concurrent process had just
  appended and fsynced. All journal appends (prune and recovery) and the torn-tail
  repair now hold a new state-dir-scoped cross-process mutex
  (`acquireCleanupJournalLock`), and recovery reads and repairs the journal as one
  critical section under that mutex. The mutex is a leaf lock — never held while
  acquiring the checkout lease or recovery lock, so ordering stays deadlock-free —
  and is reclaimed like any other lock when its owner dies.

## [0.21.0] - 2026-07-19

### Added

- Sliced delegation: a spec may carry a top-level `slices` array that decomposes
  the task into ordered, independently testable steps. Each slice is a scoped
  mini-spec with its own `writeAllowlist` (a subset of the spec's),
  `forbiddenScope`, `successCriteria`, and required `verification`, and runs
  fresh with no context from prior slices. A deterministic wayfinder routes each
  completed slice advance/repair/halt from its verification result alone. Review
  and the advisor judge the composed candidate over the whole slice branch at the
  end; per-slice review is opt-in via `review.perSlice: true`. A mid-run halt
  after at least one slice has advanced yields a partial `human-decision-required`
  candidate — the promoted advanced-slice branch, which the human may accept,
  reject, or revise — carrying `haltedSliceIndex` and each slice's route in
  `slices`; a halt on the first slice with nothing advanced is reported `failed`
  with the slice evidence retained.

### Changed

- The `delegatePipeline` result now exposes `slices` (per-slice routes) and
  `haltedSliceIndex` on the MCP wire. The MCP tool protocol advances 1.2.0 to
  1.3.0 (additive).

## [0.20.0] - 2026-07-18

### Added

- Fresh-context increment loop: `runPipeline` can drive multiple bounded
  implementation increments, each in a fresh isolated worktree working from the
  prior candidate toward a structured completion report, with every increment
  independently frozen and verified and recorded in the pipeline result.

### Changed

- Candidate lifecycle MCP tools (`reviewCandidate`, `decideCandidate`,
  `integrateCandidate`) now require an explicit `checkoutPath` whose canonical
  git-common-dir identity must equal the run's repository, and fail closed with
  `run-checkout-mismatch` otherwise. This closes a cross-project authority hole
  in the shared plugin state directory where any session could review, reject,
  accept, or integrate another project's candidate by run id alone. The MCP tool
  protocol advances 1.1.0 to 1.2.0; `decideCandidate` now records its decision
  under the cross-process checkout lock and `ArtifactStore.writeDecision` is an
  atomic compare-and-set that rejects contradictory decisions.
- Verification mutation scanning now permits writes to git-ignored paths by
  default. Because verification runs in a disposable worktree, git-ignored
  artifacts (build caches, virtualenvs, `__pycache__`, `.pytest_cache`) can
  never reach the frozen candidate tree or the primary checkout, so they no
  longer fail a command. This removes the recurring false-positive where a
  `uv`/`pytest` verification command was marked `verification-mutated` despite
  exiting 0. Strict all-mutations scanning remains available per command via
  `allowedMutations: "none"`; tracked-file, untracked non-ignored, index, and
  HEAD changes are still detected regardless.

### Fixed

- A failed implement phase now surfaces the attempt's own failure
  classification (for example `verification-failure` when a candidate is
  invalidated by an external base change) instead of flattening every
  non-verified implement phase to `producer-failure`, so a blameless checkout
  drift is triageable from `failure` alone.
- Attempts that end in a timeout or cancellation without a frozen candidate now
  archive a bounded, redacted worktree status+diff snapshot into evidence
  (`evidence.worktreeSnapshot`) before the disposable worktree is removed,
  preserving salvage evidence of finished-but-discarded producer work.
- The delegate skill now matches the closed Delegation Spec schema, documents
  exact command/network/timeout and Producer override fields, supports
  reviewer-only `review.focus`, and explains the clean-checkout precondition.
- Repository preflight now accepts tracked relative symlinks to direct contained
  regular files while continuing to reject absolute, symlink-chained, directory,
  external, broken, untracked, and Git-metadata links in write scope.
- The legacy Codex wrapper now owns read-only versus edit sandbox selection and
  physical cwd binding, so implementation lanes receive `workspace-write`
  without permitting caller scope overrides.

## [0.19.0] - 2026-07-17

Deferred-work remediation release: the confinement and reproducibility
redesigns deferred from the 0.16.0 scout pass, plus the remaining
robustness and hygiene items. Every fix was driven through the `delegate`
MCP lifecycle (Codex GPT-5.6 Sol) and independently verified.

### Security

- The pipeline fixer no longer receives the shared Git object database as a
  writable sandbox root. Fixer object writes go to a per-run private object
  directory (with the shared store as a read-only alternate), and trusted
  promotion imports exactly the promoted commit's objects via bounded
  `pack-objects` plumbing, verifying shared-store reachability without
  alternates before publishing the anchor; import failure fails closed.
- Aux verification worktrees no longer receive a live writable
  `node_modules` symlink/junction into the primary checkout. Matching
  lockfile sets produce a copy-on-write clone (APFS clonefile on macOS,
  reflink on Linux); platforms or filesystems without CoW fail closed to a
  new `skipped-cow-unsupported` dependency-link state instead of a
  writable link. Windows and non-reflink Linux therefore no longer inherit
  dependencies into aux worktrees; dependent verification commands fail
  visibly as environment defects.
- Checkout-lock release now verifies the lock file still records the
  releasing holder's pid and process token before deleting it, closing the
  ABA race where a stale former holder could remove a legitimately
  reclaimed and re-acquired lock.

### Fixed

- Run manifests written in production now record real reproducibility
  provenance: repository instruction files (`AGENTS.md`, `CLAUDE.md`)
  hashed from the committed base tree and the installed verifier bytes at
  the current runtime version. The silent `pending`/empty defaults are
  removed; unresolvable verifier bytes fail the attempt closed.
- Candidate freezing rejects any truncated Git output instead of
  publishing an incomplete review patch or changed-path listing.
- `verifyRunManifest` treats the archived `protocolVersion` as provenance
  with same-major compatibility, so protocol upgrades keep existing
  archives reviewable; different-major or malformed values are rejected
  with both versions named.

### Changed

- The `.opencode` lane mirrors now carry the full operating contract
  (foreground-only execution, bounded stall relaunch, worktree isolation,
  Git-state prohibitions, action-first preamble, failure-classification
  vocabulary), and stall handling is normalized everywhere to at most one
  relaunch — two producer invocations total — with the lane's outer
  timeout authoritative.
- Lane-contract tests reject negated normative text and permissive
  background-wait mentions, and the failure-precedence end-to-end test
  pins an explicit eleven-classification literal instead of comparing the
  production constant against itself.

## [0.18.0] - 2026-07-17

Second trust-hardening release from the same dogfood scouting pass, continuing
where 0.17.0 left off. Every fix was driven through the `delegate` /
`delegatePipeline` MCP lifecycle and independently verified.

### Changed

- Protocol contract advanced to `1.1.0` (the `environment-defect` classification
  and per-command `expectBaselineFailure` were added without a marker bump in
  0.17.x). `protocolVersion` is now a required strict literal on `delegate` /
  `delegatePipeline`, unknown MCP input keys are rejected, and a mismatch yields a
  diagnostic naming both versions.

### Fixed

- Pipeline fix rounds now validate fixer commit provenance (worktree HEAD match,
  descent from the reviewed candidate, disposition OIDs bound to real in-lineage
  objects), route the final verification through the AcceptanceVerifier so
  per-command logs are archived, and reject a zero-executed (all-skipped)
  verification instead of passing it.
- Non-Codex fixer roles now run inside a write-confined Seatbelt profile and fail
  closed with `sandbox-violation` when no usable confinement backend exists.
- Schema boundaries are closed (`additionalProperties: false`), the edit timeout
  floor is encoded in the delegation-spec schema with the env override honored
  only under test, run manifests are validated on write, archived
  `runtimeVersion` is treated as provenance instead of an upgrade-bricking
  equality gate, 64-hex SHA-256 commit OIDs are accepted, and
  `expectBaselineFailure` is per verification command so one expected-failing
  reproducer no longer suppresses unrelated baseline failures.
- Isolation scripts escalate a timed-out process tree with `timeout
  --kill-after` (mapping exit 137 to the timeout result), the Codex wrapper
  rejects sandbox-bypass and scope-expanding caller flags (including attached
  short-option forms), and runtime `git` invocations are insulated from host
  global/system/local/worktree config, hooks, fsmonitor, attributes, and content
  filters (failing closed on a corrupting filter-driver name).
- Persisted pipeline artifacts are redacted, doctor output no longer leaks
  absolute home paths, and baseline/verify auxiliary worktrees use
  run-id-derived names so crash recovery can reclaim them.
- Structural verification rejects gitlink (mode 160000) tree entries and enforces
  `forbiddenScope` for nested-repository paths; environment secret discovery now
  covers `DATABASE_URL`, `*_PAT`, `*_COOKIE`, and `*_DSN`; the verification
  mutation scan detects skip-worktree/assume-unchanged index bits that would hide
  a mutation; and Linux WSL detection fails closed on an ambiguous probe.
- Capability probes treat a timed-out or signal-terminated `--version` run as
  probe-failed, and producer routing screens out unavailable producers and those
  with no resolved executable.

### Known limitations

- Deferred to a later release: mandatory populated `packagedVerifier` /
  `repositoryInstructions` (fail-closed reproducibility provenance), the fixer
  private object store and read-only dependency mount (write-confinement
  redesign), portable candidate-patch handling, and the checkout-lock ABA guard.

## [0.17.0] - 2026-07-17

Trust-hardening release from a six-agent dogfood scouting pass (Codex GPT-5.6
Sol) that surfaced a large finding set across the runtime, pipeline, verifier,
and protocol layers. Every fix in this release was itself driven through the
`delegate`/`delegatePipeline` MCP lifecycle and independently verified.

### Fixed

- Candidate promotion: when a `delegatePipeline` fix round changes bytes, the
  runtime now promotes the fixer's final tree into a canonical single-parent
  candidate (re-frozen artifact, re-pointed anchor, re-archived result and
  manifest via a bounded `ArtifactStore` promotion that fails closed after a
  decision). Previously review, decision, and integration operated on the
  pre-fix tree and silently dropped the reviewed fix.
- Linked-worktree writable-root pointers are validated (plain-file `.git`,
  realpath'd containment under the common gitdir's `worktrees/`, plain objects
  directory); a tampered or malformed pointer makes the fixer fail closed with
  `sandbox-violation` instead of crashing or running unconfined.
- Dependency inheritance compares the full recognized lockfile set (not just the
  first) and refuses to inherit on any divergence; the recorded `dependencyLink`
  is surfaced in acceptance evidence.
- Baseline verification threads cancellation (a cancelled baseline yields
  `cancelled`, not `environment-defect`), detects command-induced worktree
  mutations, and reserves `environment-defect` for a completed baseline report
  with a failed command — operational errors now propagate as runtime errors.
- The cross-process checkout lock is acquired before repository preconditions and
  baseline verification (released on every path), and a verification command
  `cwd` that is absolute or escapes the checkout is rejected as
  `invalid-specification` up front.
- The review pipeline requires a clean final review before decision-ready: a fix
  applied on the final round without re-review now requires a human decision.

### Known limitations

- Fixer private object-store isolation and read-only dependency mounting (full
  prevention of writes to the shared object DB / primary `node_modules`) are
  deferred as a dedicated write-confinement change; lockfile-divergence skipping
  reduces the dependency exposure in the interim.

## [0.16.0] - 2026-07-16

Hardening release from a full-day dogfooding session that surfaced eleven
delegation-lane and runtime defects; every fix in this release was itself
implemented through `delegatePipeline`.

### Added

- Pre-dispatch verification baseline: the runtime now runs every spec
  verification command against clean HEAD in a disposable worktree before
  probing producers; unexpected failures stop the attempt with the new
  `environment-defect` classification (distinct from `verification-failure`),
  and `expectBaselineFailure: true` opts intentional bug-reproducer specs out.
  Read-only specs skip the baseline with explicit evidence.
- Clean-room dependency inheritance: verification and baseline worktrees
  symlink `node_modules` from the primary checkout when the lockfile is
  byte-identical, recorded as `dependencyLink` evidence — dependency-requiring
  verification commands (`npx tsc`, `vitest`) no longer fail falsely.
- Fixer commit capability: fix-round producers receive the linked worktree's
  private gitdir and shared object database as sandbox writable roots, so a
  `git commit` inside the sandbox succeeds instead of every fix round ending
  `blocked` on a denied `index.lock` (refs and config stay read-only).
- Action-first edit prompts: `CODEX_EDIT_ACTION_PREAMBLE` is prepended to all
  non-read-only codex prompts, forbidding rule/skill-file ingestion and
  plan-only zero-edit exits; the delegate skill requires distilled constraints
  in `context`.
- Edit timeout floor: `RUNTIME_MIN_EDIT_TIMEOUT_MS` (10 minutes) — edit-mode
  specs below it are rejected, not clamped; the isolated codex runner defaults
  `CODEX_TIMEOUT_SECONDS` to 600.
- Codex lane failure classification: reports carry `FAILURE CLASSIFICATION`
  (`sandbox-attributable | real | mixed | unresolved | not-applicable`) with a
  per-gate basis; a failing gate may be reported real only when the wrapper's
  outside-sandbox rerun also fails.
- Delegate skill gains **Verification preflight** and **Coordinator duties**
  sections (two lanes reporting the same blocker means the architect pauses
  lanes and repairs the environment centrally).

### Fixed

- Implementer lanes could end their turn "waiting" on a background monitor,
  completing with zero work product: all four lanes now mandate one foreground
  blocking Bash call (600000ms), exactly two valid turn endings, and
  PID-rejoin loops with 10-minute stall detection (kill, then one fresh
  relaunch or a concrete blocker report).
- Parallel legacy lanes shared one checkout, and one lane's `git stash` cycle
  destroyed another lane's uncommitted work: worktree isolation is now
  unconditional, tree-wide git-state mutations are forbidden on shared
  checkouts (propagated verbatim into producer prompts), pre-existence checks
  use a disposable worktree, and overlapping `writeAllowlist`s serialize with
  central integration.
- Verification ordering: lint/format gates must precede the final type-check,
  formatters run in non-mutating check mode, and the type-check covers all
  touched typed files including new tests.
- Producers never create commits (sandbox `.git/index.lock` denials are
  expected confinement, classified sandbox-attributable); the 600000ms
  lifetime must be the Bash tool's explicit `timeout` parameter; per-run
  private `mktemp -d` spec directories eliminate cross-lane temp collisions.
- The lane-contract test pins all of the above across both hosts.

## [0.15.0] - 2026-07-16

### Fixed

- **The review pipeline could never execute.** Dogfooding `delegatePipeline` end-to-end against real Codex exposed four stacked defects that each blocked the review/fix/verify roles from running at all; every one had escaped the suite because all pipeline tests used a fake adapter:
  - Read-only roles gated on the *selected producer's* write-confinement backend being OS-kind, but Codex always reports its own producer-native sandbox, so every review failed with `sandbox-violation`.
  - `macos-seatbelt` was still marked `unsupported`; certified darwin/arm64 via the opt-in confinement gate (worktree write permitted, outside write blocked).
  - The read-only Seatbelt profile denied all network, so reviewer/verifier model sessions could not reach the provider API.
  - Wrapping Codex in an outer read-only Seatbelt profile crashed its own sandbox init (`Operation not permitted`); producers with a native sandbox now confine read-only roles themselves via `--sandbox read-only`, and only backend-less producers get the host Seatbelt wrap.
- The Windows CI leg (red since 0.13.0): the Seatbelt profile builder joined paths with platform-dependent `node:path`, emitting backslash subpaths on Windows; switched to `node:path/posix`.

### Added

- Producer watchdog (`runtime/watchdog.mjs`): producers are spawned through a wrapper that polls the MCP server PID and terminates the producer's process group when the server dies, closing the orphaned-producer window.
- Pipeline role outputs are archived per round (`logs/role-<role>-round<N>.log`, redacted) whether or not structured-output parsing succeeds, and parse-failure gate reasons name the exact log reference.
- Reviewer prompts require a per-success-criterion verdict (`met | not-met | cannot-verify`) with cited diff-line evidence and explicit disclosure of anything unverifiable.
- Delegation specs now require a non-empty objective, at least one success criterion, and at least one verification command; the delegate skill documents the acceptance-criteria rules.
- Enabling the OpenCode, Pi, and Pythinker edit lanes on certified darwin/arm64 under Seatbelt confinement.

### Changed

- Pre-push gate (`.githooks/pre-push`): every push runs typecheck and the full suite; main/tag pushes also run the release validator and refuse a tag push while origin/main CI is red. CI workflow moved to least-privilege permissions and current action versions.

## [0.14.0] - 2026-07-16

### Added

- Routing failures now return a per-producer `considered` trail (selected / unknown-producer / authentication-required / ineligible with a reason) in attempt evidence and unresolved issues, so `no-eligible-producer` explains itself.
- Delegation-spec enum validation errors list the allowed values (e.g. `verification[].network` reports `allowed values: denied, allowed`).
- Repository precondition failures name the offending paths (dirty files, changed submodules, nested repositories), bounded to 20 entries.
- Prompt-injection hardening in the review pipeline: candidate diffs, test evidence, and consolidated findings are wrapped in explicit untrusted-data fences with a data-not-instructions preface, a 200k-character cap with truncation evidence, and fence-forgery neutralization.
- The pythinker implementer lane forwards a caller-supplied `TIMEOUT_SECONDS` (default 1800s) to the adapter and forbids background waits.

### Fixed

- The committed `runtime/server.mjs` bundle shipped with 0.13.0 was stale: it lacked the `delegatePipeline` tool, pinned `RUNTIME_VERSION` at 0.12.1, and a fresh rebuild broke schema resolution. Role-prompt schemas now resolve from both the source and bundled layouts, and the regenerated bundle actually exposes all ten MCP tools. Installed copies must update and reload to receive `delegatePipeline`.

## [0.13.0] - 2026-07-16

### Added

- `delegatePipeline` MCP tool: a deterministic delegate → review → fix → verify loop that runs the full lifecycle in one call, with a fail-closed gate evaluation, clean-room verify, and an evidence bundle per round.
- Fresh-context review pipeline: fresh-session role runner with fail-closed confinement, role prompt templates and role-spec builder, structured-output schemas with a single repair retry, and a deterministic finding consolidator.
- Optional `review` block on the delegation spec (including `maxRounds`) to configure the pipeline from the protocol side.
- Native producer adapters for OpenCode (plain-text contract), Pi (inherited-config profile, multi-provider), and Pythinker — all registered in the producer registry with per-producer certification smokes.
- macOS Seatbelt os-kind write-confinement backend, per-producer Seatbelt writable paths with Pythinker MCP isolation, and a read-only Seatbelt policy for review roles.
- End-to-end pipeline lifecycle test running against a temporary git repository, plus an opt-in Seatbelt certification gate.

### Changed

- The delegate skill now routes non-trivial delegations through `delegatePipeline` instead of the manual lifecycle tools.
- Lane docs: progress streams via the FINAL file (caller-supplied progress log), and the Pi lane is documented as multi-provider rather than local-only.

## [0.12.1] - 2026-07-15

### Added

- The Codex capability report's `authState` now reflects auth-store presence: `authenticated` or `unauthenticated` from a presence-only check of `auth.json` in the `CODEX_HOME`-or-`~/.codex` store (contents are never read). Unavailable producers keep `unknown`; doctor now shows whether the Codex lane is credentialed before a delegation.

## [0.12.0] - 2026-07-15

### Added

- Recorded real-Linux evidence from the opt-in confinement gate on arm64, kernel 7.0.11-orbstack, a `node:22` container, and codex-cli 0.144.4: the inside-worktree write succeeded with exact content and the outside-home write was blocked.
- Confirmed that the Codex Linux sandbox uses bubblewrap and requires unprivileged user namespaces. Where they are blocked, such as by Docker's default seccomp profile, Codex refuses to execute commands and provides no unsandboxed fallback.

### Changed

- Promoted the Linux native `codex-native-sandbox` backend to `tested`, enabling the Codex edit Lane on Linux.

## [0.11.1] - 2026-07-15

### Added

- Doctor now reports host-applicable sandbox backend states in `sandboxBackends` (`id`, `kind`, and `state` resolved for the current host with the same matching semantics as `selectSandboxBackend`), making edit-lane eligibility diagnosable from diagnostics output.

## [0.11.0] - 2026-07-15

### Added

- Added a 3-OS GitHub Actions CI matrix covering macOS 14, Ubuntu, and Windows, with the Windows leg compiling the native helper with MSVC. Evidence: [first fully green run](https://github.com/PyModel/claude-architect/actions/runs/29451055892).
- Committed `native/bin/win32-job-kill-x64.exe` (SHA-256 `a96636f4d9e564b978172662e005e2a521205dd3b2eaea271b511854a05ccd10`), including its new `token <pid>` creation-FILETIME mode for process-identity tokens without PowerShell.
- Enabled Windows worktrees with removal retries for transient Windows file locking.

### Fixed

- Made candidate materialization byte-exact under hostile `core.autocrlf` settings by pinning Git runs to `-c core.autocrlf=false`.
- Gave Win32 verification commands the Windows essential environment set. They previously ran without an essential environment, which could leave repository mutations undetected; verification now fails closed.
- Made release validation fail when the native helper binary is missing or empty, or when release version pins drift.

### Notes

- Sandbox backend states are intentionally unchanged: Linux and native Windows remain `unsupported` for the edit Lane because no real confinement evidence exists for them yet.

## [0.10.0] - 2026-07-15

### Added

- P0-B Windows groundwork now ships in the runtime: native Windows platform services (PATHEXT-aware executable resolution, supervised spawning, checkout locking, canonical paths, PowerShell process-start tokens), Job Object process-tree helper resolution that fails closed when the helper binary is absent, first-class win32 platform selection with the Windows essential environment set (canonical `Path` casing, `USERPROFILE`/`APPDATA`/`LOCALAPPDATA` isolation under a temporary home), and a named write-confinement backend registry — edit attempts fail closed before spawning when the capability report names no recognized, supported backend. The Windows helper binary and CI promotion land with the P0-B release gate.

### Fixed

- A freeze rejected for out-of-scope writes now names the offending repository paths (bounded to 25) in `evidence.freezeRejectPaths`, so a sandbox violation is diagnosable from the archived result instead of only reporting `out-of-scope-write`.
- Archived attempt results now preserve each verification command's `allowedMutations` policy, restoring post-hoc auditability of the effective verification policy.

## [0.9.3] - 2026-07-15

### Added

- `delegate` now streams MCP progress notifications while an attempt runs — probing, producer running, freezing, verifying, archiving — with elapsed seconds and a 15-second heartbeat, so the Host spinner shows live phase information instead of a silent multi-minute call.

### Fixed

- Delegate and review tool results bound `evidence.ignoredPaths` to 50 entries plus an `ignoredPathsOmitted` count. A repository with installed dependencies previously returned ~230 KB of ignored-path names in every result, overflowing the Host's tool-output limit; archived artifacts still record the complete list.

## [0.9.2] - 2026-07-15

### Added

- Verification commands may opt into `allowedMutations: "ignored-paths"`, permitting Git-ignored byproducts such as `node_modules` from a dependency install. Tracked, untracked, submodule, and HEAD mutations still fail verification, and the default remains strict (`none`). Verification runs in a clean materialization, so real projects need an install step before typechecks or tests can run.

## [0.9.1] - 2026-07-15

### Fixed

- Codex authentication now survives HOME isolation. When the Host has not set `CODEX_HOME`, the Codex adapter defaults it to the real `~/.codex` auth store (only when `auth.json` exists), supplied through a new adapter-values environment layer that never overrides a host-provided allowlisted value. Previously every sandboxed invocation failed with 401 Unauthorized because the per-attempt temporary HOME hid the auth store.

## [0.9.0] - 2026-07-15

### Fixed

- `delegate` now accepts a JSON-encoded string Delegation Spec. The tool declares `spec` as an untyped value, so schemaless MCP clients serialize the nested spec object as a string; the handler parses it before validation instead of rejecting every delegation with `#/type must be object`.

## [0.8.0] - 2026-07-14

### Added

- Added the trusted Node.js MCP runtime for the versioned delegation lifecycle: validated specs, isolated Codex production, content-addressed Candidate Artifacts, independent structural/project verification, explicit review decisions, and controlled integration.
- Added a strictly non-mutating `claude-architect:advisor` with only file reads and redacted read-only Git observations.

### Changed

- `/claude-architect:delegate` now drives the MCP `delegate` → `reviewCandidate` → `decideCandidate` → `integrateCandidate` flow. Legacy lane definitions remain packaged for migration; OpenCode, Pi, and Pythinker use them while their runtime adapters are pending, but Codex cannot bypass a failed confinement/edit-eligibility gate.
- Published the reduced P0-A support matrix: macOS arm64 is certified only when Codex reports its proven native sandbox; Linux and native Windows remain pending P0-B and diagnostics-only.
- Codex runtime invocations explicitly disable multi-agent behavior. Installed marketplace copies must update and reload Claude Code before the new runtime and controls take effect.
- Runtime startup now recovers interrupted attempts and prune transactions before serving, while the release gate exercises every canonical failure classification and the complete review/decision/integration lifecycle.

## [0.7.0] - 2026-07-14

### Added

- The shared process-isolation lifecycle now records every delegated run. `run-isolated.sh` appends one atomic line per run to `runs.log` under `${TMPDIR:-/tmp}/claude-architect-runs` (override with `RUN_ISOLATED_LOG_DIR`), capturing the delegated program's basename, argument count, duration, exit status, and result category (`ok`, `failed`, `timeout`, `signal`) so a failed delegation is diagnosable after the fact. Argument values are never logged, since a spec or prompt can travel in argv. Codex — the only lane whose stderr streams to the caller rather than into its result file — additionally mirrors stderr to a per-run `codex-<timestamp>-<pid>.stderr` file (override with `CODEX_LOG_DIR`). Logging is skipped silently when the host lacks the required utilities, and can never alter a delegation's exit status.

## [0.6.0] - 2026-07-14

### Changed

- Renamed the project, plugin, runtime namespace, documentation, and visual assets to Claude Architect (`claude-architect`). Existing installations under the previous identity must add the renamed marketplace and reinstall the plugin or OpenCode assets.
- Added Claude Code marketplace display metadata and an append-only plugin rename map for automatic settings migration on Claude Code 2.1.193 and later.

## [0.5.0] - 2026-07-13

### Added

- Each implementation lane now resolves its adapter script through a shared runtime resolver instead of hardcoding `$CLAUDE_PLUGIN_ROOT`, which subagent shells often don't export. The resolver walks up from the working directory for a plugin checkout, falls back to the newest installed copy under `~/.claude/plugins/cache`, and reports a structured error instead of failing silently.

### Changed

- `/delegate` now asks the user to choose Codex, OpenCode, Pi, or Pythinker when no CLI or agent is named instead of silently defaulting to Codex, and the question documents each lane's model and reasoning controls. GPT-5.6 Sol now defaults to low reasoning.
- Codex lanes now leave long tasks uncapped by default. The isolated runner enforces an explicit positive `CODEX_TIMEOUT_SECONDS` only when a timeout binary is available and rejects invalid values before Codex starts. Release validation now reports actionable diagnostics when the Claude Code or Node.js CLI is missing.
- Every implementation lane now uses one shared process-isolation lifecycle through its own CLI-specific adapter. Codex remains uncapped by default; Pi, Pythinker, and OpenCode default to a fail-closed 900-second cap, which their respective `PI_TIMEOUT_SECONDS=0`, `PYTHINKER_TIMEOUT_SECONDS=0`, or `OPENCODE_TIMEOUT_SECONDS=0` setting disables.
- Harness model, thinking, and variant overrides are optional. When absent, the adapters omit the relevant flags and defer to CLI configuration without a plugin-level default.
- OpenCode project and global installation now package the shared runtime and CLI adapters through `scripts/install-opencode.sh`.

## [0.4.0] - 2026-07-13

### Fixed

- Preserved standard input when the isolated Codex runner starts its process group, restoring the documented prompt-file invocation in both `setsid` and Perl fallback environments.

## [0.3.0] - 2026-07-13

### Fixed

- Corrected the Claude Code plugin manifest to use a string `repository` URL and removed the unsupported npm-style `bugs` field.

## [0.2.0] - 2026-07-13

### Fixed

- Routed all delegated Codex work away from the persistent rescue companion and isolated each run from user MCP configuration, preventing completed tasks from accumulating `node_repl` and other MCP worker subprocesses under the Codex app-server.

## [0.1.0] - 2026-07-12

Initial public release.

### Added

- `delegate` skill that turns a request into a five-part spec, routes it to a lane, and requires the architect to review the diff before accepting.
- Four implementation lanes: `codex-implementer` (GPT-5.6 Sol via the Codex CLI), `opencode-implementer` (any authenticated OpenCode provider), `pi-implementer` (local open-weight model at zero marginal token cost), and `pythinker-implementer` (autonomous, headless `--yolo`).
- `claude-advisor`, a read-only advisor for commitment-boundary decisions.
- Native OpenCode assets under `.opencode/` and `opencode.json`, so the same lanes and skill work outside Claude Code.
- SVG banner and shields badges for the README.

[Unreleased]: https://github.com/PyModel/claude-architect/compare/v0.43.0...HEAD
[0.43.0]: https://github.com/PyModel/claude-architect/compare/v0.42.0...v0.43.0
[0.42.0]: https://github.com/PyModel/claude-architect/compare/v0.41.0...v0.42.0
[0.16.0]: https://github.com/PyModel/claude-architect/compare/v0.15.0...v0.16.0
[0.15.0]: https://github.com/PyModel/claude-architect/compare/v0.14.0...v0.15.0
[0.14.0]: https://github.com/PyModel/claude-architect/compare/v0.13.0...v0.14.0
[0.13.0]: https://github.com/PyModel/claude-architect/compare/v0.12.1...v0.13.0
[0.12.1]: https://github.com/PyModel/claude-architect/compare/v0.12.0...v0.12.1
[0.12.0]: https://github.com/PyModel/claude-architect/compare/v0.11.1...v0.12.0
[0.11.1]: https://github.com/PyModel/claude-architect/compare/v0.11.0...v0.11.1
[0.11.0]: https://github.com/PyModel/claude-architect/compare/v0.10.0...v0.11.0
[0.10.0]: https://github.com/PyModel/claude-architect/compare/v0.9.3...v0.10.0
[0.9.3]: https://github.com/PyModel/claude-architect/compare/v0.9.2...v0.9.3
[0.9.2]: https://github.com/PyModel/claude-architect/compare/v0.9.1...v0.9.2
[0.9.1]: https://github.com/PyModel/claude-architect/compare/v0.9.0...v0.9.1
[0.9.0]: https://github.com/PyModel/claude-architect/compare/v0.8.0...v0.9.0
[0.8.0]: https://github.com/PyModel/claude-architect/compare/v0.7.0...v0.8.0
[0.7.0]: https://github.com/PyModel/claude-architect/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/PyModel/claude-architect/releases/tag/v0.6.0
[0.5.0]: https://github.com/PyModel/claude-architect/releases/tag/v0.5.0
[0.4.0]: https://github.com/PyModel/claude-architect/releases/tag/v0.4.0
[0.3.0]: https://github.com/PyModel/claude-architect/releases/tag/v0.3.0
[0.2.0]: https://github.com/PyModel/claude-architect/releases/tag/v0.2.0
[0.1.0]: https://github.com/PyModel/claude-architect/releases/tag/v0.1.0
