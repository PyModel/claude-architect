# Domain Context

## Revised Verdict

Claude Architect must be a first-class, cross-platform Claude Code plugin whose trusted core runtime supports native macOS, native Linux, and native Windows from P0. WSL is a Linux execution environment and is not the implementation of native Windows support.

The protocol and orchestrator are universal; individual Producers are conditionally available. The plugin must always load, expose `/claude-architect:delegate`, inspect installed Producers, and return useful diagnostics on every supported Host platform. A Producer is eligible only where its CLI and the confinement required by the requested Lane are available.

The normal plugin path is a structured call from the Delegate Skill to a plugin-bundled MCP runtime. It must not depend on shell-generated command strings, the Bash tool's `PATH`, Bash shebangs, Unix file modes, or Unix-only process semantics.

## Ubiquitous Language

### Host

The environment that coordinates delegated work. The initial architecture has one Host: Claude Code. Claude Architect is a plugin running within that Host.

### Lane

The kind of work being delegated, such as implementation, review, investigation, testing, or planning. A Lane does not identify which external runtime performs the work.

### Producer

An external CLI runtime that performs delegated work. Agy, Claude, Codex, OpenCode, Pi, and Pythinker are Producers.

### Delegation Spec

Machine-readable intent, constraints, success criteria, verification, execution policy, and expected output for delegated work. A Delegation Spec must be valid before routing selects a Producer.

### Delegation Attempt

One execution of a valid Delegation Spec by a selected Producer under an explicit policy. An editing Delegation Attempt runs in its own isolated worktree.

### Attempt Runtime

The Producer-neutral module that executes a Delegation Attempt. It owns worktree allocation, environment construction, process supervision, timeout and cancellation, artifact collection, failure classification, and result verification orchestration.

### Producer Descriptor

A declarative specification defining a Producer's identification, executable resolution, CLI argument layout, prompt framing, isolation model, host state requirements, and capabilities. Descriptors parameterize common behavior across adapters, eliminating bespoke duplication.

### Producer Runtime

The unified execution layer for Producers. It coordinates capability probing, probe caching within a run, shared prompt rendering, launch planning (computing sandbox policy, environment, and secure temporary HOME only when isolation profiles mandate it), and process supervision with watchdog protection.

### Producer Adapter

A Producer Descriptor plus whatever custom code that CLI genuinely requires — nothing more. The descriptor states identification, executable resolution, argument layout, prompt framing, isolation model, and host state; custom code exists only where the CLI's own behavior differs, such as `buildInvocation` for an unusual argument shape or a native event format to normalize. An adapter never chooses the canonical Failure Classification and never gains acceptance authority.

### Attempt Result

The canonical, machine-readable outcome of a Delegation Attempt. It records artifacts, evidence, execution facts, and failure classification. An Attempt Result is a candidate outcome, not an accepted result.

### Host Decision

Claude's decision after reviewing a verified Candidate Artifact and its evidence. A Host Decision is `accepted`, `rejected`, or `revision-requested`. Evaluated via the unified `RunDecision` subsystem into one of five `RunVerdict` states: `accepted` (autonomous: true), `human-required`, `rejected`, `incomplete`, or `invalid`. Cross-file coherence of archived evidence, manifest, review snapshot, gate clearance, and decision is loaded concurrently via `readRunDecisionSnapshot`.

### RunDecision & RunVerdict

The unified subsystem (`src/runtime/run-decision.ts`) that determines candidate eligibility and authority clearance. It evaluates autonomous eligibility, provenance allowlists, and the accept-only rule once across all call sites, returning a typed `RunVerdict`.

### Integration Result

The outcome of applying an accepted Candidate Artifact to the main checkout through Controlled Integration. An Integration Result is `applied`, `conflicted`, or `aborted`.

### Acceptance Verification

Independent executable verification of an Attempt Result and its candidate artifacts. Acceptance Verification operates under named verification modes (`candidate`, `composed-slice`, and `final-branch`), with unified scope-checking via canonical path rules before controlled integration.

### Candidate Artifact

Output produced by an untrusted Producer, such as a patch, report, or review. For implementation work the canonical form is a base-bound, content-addressed Git tree constructed by the trusted runtime, accompanied by a changed-path manifest of paths, modes, and content hashes. A full-index, binary-capable patch is exported from that tree for review and portability but is not the artifact's sole identity. A Candidate Artifact cannot modify the main checkout until Acceptance Verification succeeds.

### Capability Report

A machine-readable observation of a Producer's availability, version, authentication state, supported execution modes, sandbox support, structured-output support, and other routing-relevant facts. Facts that cannot be observed safely are `unknown`, not inferred.

### Run Manifest

The reproducibility record for a Delegation Attempt. It identifies the base commit, Producer version and model, effective configuration policy, repository instruction paths and hashes, prompt hash, execution policy, and runtime version.

### Artifact Descriptor

The data record behind one kind of archived artifact in the Artifact Store: its file under the run directory, the validator that proves archived bytes are that kind on the way out, and, for kinds the store writes, the redaction-and-validation step on the way in plus the write mode (immutable, replace, or replace-if-present). Every typed store façade (`readManifest()`, `readDecision()`, …) is one line over the shared `readArtifact`/`writeArtifact` pair. A store is bound to one run at construction; its façades name no run id.

### Routing Policy

Host-owned rules that order Producer preferences and required capabilities. Routing Policy is distinct from the Producer registry, which contains machine facts rather than preferences.

### Failure Classification

The canonical reason a Delegation Attempt did not produce a verified Candidate Artifact. Native Producer errors are translated into this shared vocabulary.

### Sandbox Backend

An internal adapter used by the Attempt Runtime to enforce the execution policy on a supported operating system. Its defining responsibility is write confinement to the attempt worktree; process-tree supervision alone does not satisfy it. Producer-native confinement may satisfy the policy; otherwise a named, tested operating-system mechanism must. A platform without a proven write-confinement path remains operational for diagnostics but ineligible for the implementation Lane.

### PlatformSafety

The trusted orchestration layer for repository mutations, lease management, and crash-resilient file persistence. It wraps raw Platform Services checkout locking to enforce ambiguity checks under the lease (`withCheckoutLease`), provides named recovery lease paths (`withRecoveryLease`), and guarantees atomic disk durability and directory identity validation (`writeAtomic`, `DurableDirectorySession`). Higher runtime layers interact through `PlatformSafety` rather than naked platform locks or unguarded writes.

### Platform Services

The operating-system seam for executable resolution, supervised process creation, process-tree cancellation, checkout locking, secure temporary directories, and path canonicalization. P0 has distinct POSIX and native Windows implementations.

### Controlled Integration

The safe mutation of the main checkout with an accepted Candidate Artifact. Claude owns the decision; the trusted runtime owns the mutation, performed through the structured `integrateCandidate` tool rather than by Main Claude executing Git commands. Controlled Integration revalidates the unchanged base commit, clean checkout, artifact tree, and manifest hash before applying and reports `applied`, `conflicted`, or `aborted`. It is a runtime operation distinct from the Attempt Runtime that produced the candidate.

### Producer Configuration Profile

A per-adapter declaration of how a Producer stores credentials and behavioral configuration and whether the two can be separated. It records credential sources, behavioral-config sources, repository-instruction sources, environment dependencies, temporary-home strategy, and an isolation state of `controlled-config-supported`, `controlled-config-with-copied-credentials`, `inherited-config-only`, or `configuration-isolation-unsupported`. The runtime never silently inherits user-global configuration.

## Architectural Decisions In Force

### Core Model

- Claude Code is the only Host in the initial architecture.
- Lanes and Producers are independent dimensions.
- The Attempt Runtime is the primary deep module; Producer Adapters contain only Producer-specific variation.
- Routing occurs only after Delegation Spec validation and capability resolution.
- Producers are untrusted in the sense that their output, claims, path discipline, and failure reporting may be incorrect. P0 does not claim protection from a malicious installed CLI or kernel-level sandbox escape.
- A Producer is user-authorized to read repository content required by the Delegation Spec and to use network access needed for its model. P0 does not promise confidentiality from the selected Producer.
- Successful exit and self-reported verification do not imply acceptance.
- Agent prose provides guidance, not security enforcement.
- Host location and Producer discovery are separate modules. Host location finds packaged plugin assets; Producer discovery returns Capability Reports.
- The Producer registry contains machine facts and capability declarations only. Routing Policy remains Host-owned.
- Confinement policy belongs to the Attempt Runtime. Producer Adapters expose native capabilities and invocation facts but do not define the policy.

### P0 Scope

- The first trusted Attempt Runtime supports native macOS, native Linux, and native Windows. WSL 2 is treated as Linux and does not satisfy the native Windows requirement.
- The initial target matrix is macOS arm64 and x64; Linux x64 and arm64 on glibc and musl; and Windows x64 and arm64. Any reduction before release must be explicit in the published support matrix and cannot reduce native Windows to WSL-only support.
- The P0 Attempt Runtime supports the implementation Lane only. Other Lanes may reuse the protocol later but do not broaden the first trusted editing path.
- P0 includes shared-contract adapters for Codex, OpenCode, Pi, and Pythinker. Each adapter publishes a tested platform-capability matrix and reports honest unavailability when its Producer cannot satisfy the requested Lane on the current platform.
- Universal plugin availability does not imply universal Producer availability. The plugin remains operable and diagnostic when no Producer is eligible.
- The P0 Attempt Runtime is a TypeScript/Node executable and explicitly requires Node.js 22 or later, in addition to Claude Code, Git, and at least one eligible Producer CLI. Claude Architect must not be described as zero-dependency while this prerequisite remains.
- A small native helper is permitted where native Windows process-tree ownership requires it. Shell scripts may support repository development and CI but no shipped runtime feature may require them.
- P0 allows one active editing Delegation Attempt per base checkout. Parallel candidate generation and queueing are deferred.
- P0 requires a clean main checkout before an editing Delegation Attempt starts. Dirty-state snapshotting is deferred.
- P0 defines and tests at least one concrete write-confinement backend for every platform on which any Producer is certified for the implementation Lane. Process-tree supervision alone does not satisfy write confinement. A platform–Producer combination without a proven confinement path remains operational for diagnostics but ineligible for implementation.

### Plugin Surface And Invocation

- The marketplace-installed public command is the namespaced Skill `/claude-architect:delegate`. Documentation, examples, and screenshots must not present plain `/delegate` as the normal plugin command.
- The Delegate Skill has Main Claude construct a candidate Delegation Spec and invoke the Claude Architect runtime through a structured plugin-bundled MCP tool. Main Claude does not declare its own output valid; the runtime is the validation authority.
- The plugin MCP server owns schema validation, capability probing, routing, worktree management, process supervision, artifact collection, recovery, Acceptance Verification, and Controlled Integration. It returns a structured verified-candidate result for Main Claude's review.
- Spec validation is a repair loop. The runtime validates and normalizes the candidate spec and, on failure, returns structured validation errors so Main Claude can repair and resubmit. No Producer is probed or started before validation succeeds.
- The candidate lifecycle after a verified result is exposed as distinct structured tools: `reviewCandidate(runId)` returns the diff and evidence, `decideCandidate(runId, accepted | rejected | revision-requested)` records the Host Decision, and `integrateCandidate(runId, expectedArtifactHash)` performs Controlled Integration. Main Claude owns the decision; the runtime owns the mutation. `integrateCandidate` acquires the repository lock, revalidates the base commit and clean state, revalidates the artifact tree and manifest hash, applies into a disposable integration worktree or temporary index, detects conflicts or path divergence, updates the main checkout only when the whole operation can succeed, and returns `applied`, `conflicted`, or `aborted`.
- A `doctor` tool is exposed through MCP, not only through the development CLI, so `/claude-architect:delegate` can return a structured explanation when Node, Git, or Producers are unavailable.
- Plugin configuration resolves packaged assets through `${CLAUDE_PLUGIN_ROOT}`. Runtime access must not depend on a bare command being added to the Bash tool's `PATH`.
- `${CLAUDE_PLUGIN_ROOT}` changes on every plugin update and the previous version's directory is ephemeral, so no run state, archive, or lock is ever written under the plugin root. Persistent plugin state, including archived run data, lives in `${CLAUDE_PLUGIN_DATA}`, which survives updates. During a mid-session update, a running plugin MCP server keeps the previous version's path until `/reload-plugins`; the update-during-active-attempt contract builds on this documented Host behavior.
- The shipped path must not depend on Bash versus PowerShell, Bash shebangs, `chmod +x`, `.sh` launchers, Unix-only path syntax, or Claude composing a shell command string.
- A development CLI may expose `claude-architect doctor`, `claude-architect probe`, `claude-architect run --spec spec.json`, and `claude-architect recover`, but it is not the normal `/claude-architect:delegate` transport.
- The plugin-bundled advisor is strictly non-mutating and uses an explicit `Read, Grep, Glob` tool allowlist. It does not receive Bash, Write, or Edit. Non-mutating does not imply confidentiality-safe: the advisor can still read sensitive repository content, so it is described as a non-mutating advisor rather than a confidentiality-preserving one. Required Git observations are exposed through dedicated read-only operations such as status, diff, log, and changed-file queries; because Git history and diffs can reveal secrets, their outputs receive the same redaction discipline as run logs. Plugin agents cannot declare their own `mcpServers`, `hooks`, or `permissionMode`, so these Git operations are tools on the plugin-bundled MCP server, allowlisted in the advisor's `tools` frontmatter by their scoped names (`mcp__plugin_claude-architect_<server>__<tool>`).

The preferred shipped layout is:

```text
claude-architect/
|-- .claude-plugin/
|     `-- plugin.json
|-- skills/
|     `-- delegate/
|           `-- SKILL.md
|-- agents/
|     `-- advisor.md
|-- .mcp.json
|-- runtime/
|     |-- server.js
|     `-- schemas/
`-- native/
      `-- platform helpers
```

### MCP Bootstrap And Lifecycle

- `.mcp.json` resolves packaged assets through `${CLAUDE_PLUGIN_ROOT}` and starts a stdio MCP server. The protocol stream is emitted only on stdout; all diagnostics are emitted only on stderr so startup output cannot corrupt the protocol.
- The server has an explicit bootstrap contract: locate `node` (including native Windows resolution), verify version 22 or later and refuse an earlier version such as Node 20 even when found first, resolve the real runtime `server.js`, report runtime and schema version, acquire per-run or per-repository state, and otherwise fail with actionable installation diagnostics rather than a corrupt stream.
- Startup timeout, runtime crash behavior, and any automatic restart behavior are defined and tested. Concurrent tool calls against one repository are serialized to preserve the one-active-attempt rule.
- One server instance may serve multiple repositories; per-repository state and locking keep runs isolated.
- Updating the plugin while a server process is active has a defined, tested outcome that preserves run evidence and checkout integrity.
- The runtime, `SKILL.md`, and schemas carry compatible protocol versions; a version mismatch is reported as an actionable diagnostic rather than a silent failure.

```text
McpBootstrap
|-- locate Node
|-- verify >= 22
|-- resolve real runtime/server.js
|-- emit protocol only on stdout
|-- emit diagnostics only on stderr
|-- report runtime and schema version
|-- acquire per-run or per-repository state
`-- fail with actionable installation diagnostics
```

### Runtime Components

```text
Claude Code
|
|-- /claude-architect:delegate
|     Main Claude writes the Delegation Spec
|
|-- claude-architect:advisor
|     Strictly non-mutating Claude subagent
|
`-- Claude Architect MCP server
      |-- SpecValidator
      |-- ProducerRegistry
      |-- RoutingPolicy
      |-- ProducerRuntime
      |     |-- ProducerDescriptors (agy, claude, codex, opencode, pi, pythinker)
      |     |-- HostStoreResolver
      |     |-- SharedPromptRenderer
      |     |-- CliProbe (with abnormal-termination guard & run-scoped cache)
      |     `-- LaunchPlanner & Supervisor
      |-- PipelineRuntime
      |     |-- RunContext (run-scoped facts; no shared mutable closure)
      |     |-- PipelineRunState -> increments -> review rounds -> promote -> gate
      |     `-- SliceRunner
      |           |-- plan wave -> worktree -> launch -> freeze -> verify -> review
      |           `-- compose -> release anchor
      |-- AttemptRuntime
      |     |-- WorktreeManager
      |     |-- EnvironmentPolicy
      |     |-- ProcessSupervisor
      |     |-- ArtifactStore (run-bound; one ArtifactDescriptor per kind)
      |     `-- RecoveryManager
      |-- RunDecision
      |     |-- RunDecisionSnapshot (one read per decision)
      |     |-- RunVerdict (accepted | human-required | rejected | incomplete | invalid)
      |     `-- VerificationMode (candidate | composed-slice | final-branch)
      |-- PlatformSafety
      |     |-- withCheckoutLease / withRecoveryLease
      |     |-- writeAtomic & DurableDirectorySession
      |     |-- LockOwnership
      |     `-- PlatformServices
      |           |-- PosixPlatformServices
      |           `-- WindowsPlatformServices
      |-- AcceptanceVerifier
      |-- ControlledIntegrator
      `-- Doctor
```

### Specification And Routing

- Delegation Specs and Attempt Results are versioned, machine-readable data validated against schemas.
- A Delegation Spec must identify its objective, relevant context, positive write allowlist, forbidden scope, success criteria, verification commands, execution mode, timeout, Producer preferences, and expected output.
- Repository-wide write scope must be explicit rather than implied by an absent allowlist.
- The Host supplies an ordered Producer preference list. The Attempt Runtime filters it by required capabilities and selects the first available Producer; learned quality, speed, and cost scoring are deferred.
- Local availability and version probing runs before each P0 attempt, has no intentional side effects, and is cached within the process for the duration of a run keyed by (producer id, resolved executable path, host-store root, configuration revision). Probes are never cached across process restarts, and diagnostic checks (such as `doctor`) always probe fresh.
- Authentication, model availability, and remote capabilities are reported as `unknown` unless the Producer offers a documented local, non-mutating probe. P0 does not contact a remote service merely to complete a Capability Report.
- Capability Reports identify the operating system, architecture, environment type such as native Windows or WSL, resolved executable form, and Lane-specific eligibility. Unsupported platforms are reported as `available: false` with a machine-readable reason such as `unsupported-platform`.
- Native Windows and WSL capabilities are probed and certified separately. A Producer's WSL support is not evidence of native Windows support.
- P0 may select a fallback Producer only when capability probing reports pre-launch unavailability. After a Producer process starts, every failure is returned honestly and retry requires a new Host decision and Delegation Attempt.

### Worktree And Write Policy

- Each editing Delegation Attempt receives a separate worktree created from the recorded base commit.
- The Attempt Runtime never modifies the main checkout. After Acceptance Verification, it returns a verified Candidate Artifact for Host review and, on an accepted Host Decision, Controlled Integration by the runtime.
- Acceptance Verification rejects every tracked or untracked non-ignored changed path outside the positive write allowlist.
- P0 rejects new or modified symbolic links rather than attempting to prove that their targets remain confined.
- The Attempt Runtime inventories tracked, untracked, and ignored worktree paths before and after Producer execution and verification. Ignored artifacts are recorded but are not included in the candidate patch.
- The Attempt Runtime verifies that the main checkout's commit and clean state still match the recorded base before returning `verified-candidate`. A changed base preserves the Candidate Artifact but yields `verification-failed`.
- The canonical Candidate Artifact is a base-bound, content-addressed Git tree constructed by the trusted runtime. It records the base commit oid, the candidate tree oid, an optional candidate commit oid, the manifest hash, the changed-path manifest, and verification evidence. A full-index, binary-capable patch is exported for review and portability but is not the artifact's identity. The changed-path manifest — parsing, normalization, deterministic sorting, canonical serialization, and hashing — is owned by a single module that freeze, structural verification, and Controlled Integration all call, so the manifest hash is stable across those stages by construction rather than by independently maintained copies. Redacted git execution and Git ref operations remain separate seams the callers still own.
- After the Producer exits, the runtime stages the allowed tracked and untracked non-ignored changes in an isolated index and uses Git plumbing to write the candidate tree. The Producer does not create the trusted artifact. Content addressing represents file modes natively, makes binary files natural, and lets verification and Controlled Integration prove they operate on the exact tree Claude reviewed.
- The Candidate Artifact is frozen after Producer execution and structural inspection, before project verification begins.
- Controlled Integration rechecks the base commit, clean state, candidate tree oid, and manifest hash immediately before applying the Candidate Artifact. A failed recheck leaves the main checkout unchanged.
- The checkout lock is keyed by the canonical Git common directory, not the user-provided repository path, so path aliases, linked worktrees, symlinks, and Windows case differences cannot bypass the one-active-attempt rule.
- P0 defines an explicit repository precondition matrix rather than discovering unsupported states during execution. Supported states are a normal non-bare repository with an existing commit at `HEAD`, a clean checkout, no in-progress Git operation, no changed submodule entries, and no sparse checkout. Detected-and-rejected states include bare or unborn repositories, in-progress merge, rebase, cherry-pick, or bisect operations, candidate submodule modifications, and unsupported filesystem collisions such as case-only differences on case-insensitive filesystems.
- Detached `HEAD`, existing linked worktrees, Git LFS, `skip-worktree` or `assume-unchanged` entries, nested repositories, and repository paths reached through symlinks are explicitly classified as supported or rejected before P0, never encountered by accident.

```text
Supported:
- Normal non-bare repository
- Existing commit at HEAD
- Clean checkout
- No in-progress Git operation
- No changed submodule entries
- No sparse checkout

Detected but rejected:
- Bare or unborn repositories
- In-progress operations
- Candidate submodule modifications
- Unsupported filesystem collisions
```

### Producer Configuration And Environment

- The default Producer behavior policy is controlled configuration plus repository guidance. User-global behavior configuration is excluded.
- Producer credentials may come from documented credential stores or explicitly allowlisted environment variables without enabling unrelated user-global behavior configuration.
- Each Producer Adapter declares a Producer Configuration Profile. Because many CLIs store credentials and behavioral configuration under the same home or config directory, setting a temporary `HOME`, `XDG_CONFIG_HOME`, `APPDATA`, or `USERPROFILE` may hide both, while inheriting the real directory may re-enable unwanted global behavior. When a Producer cannot separate credentials from user-global behavior, the runtime marks controlled mode unavailable, offers an explicit inherited-configuration policy, or records the reduced reproducibility in the Run Manifest. It never silently inherits global configuration.
- Relevant repository instruction paths and content hashes are recorded in the Run Manifest.
- Producer subprocesses receive a layered environment: platform-essential variables, then the selected Producer Adapter's required allowlist, then explicit Delegation Spec additions. The Host environment is not inherited wholesale.
- Platform-essential variables include `SystemRoot`, `ComSpec`, `TEMP`, `TMP`, `USERPROFILE`, `APPDATA`, `LOCALAPPDATA`, and a canonical `Path` on native Windows, and `HOME`, `PATH`, `TMPDIR`, locale variables, and selected XDG variables on Unix.
- Sensitive environment values and known credential forms are redacted before any event, log, or result is persisted. The Run Manifest records environment variable names and redacted provenance, not secret values.
- The Attempt Runtime requires a Sandbox Backend or documented Producer-native confinement that satisfies the write policy. It fails closed when neither is available.
- Worktree checks detect policy violations but do not substitute for process confinement.
- P0 denies nested delegation unconditionally. The runtime sets `CLAUDE_ARCHITECT_DELEGATED=1` and refuses to start when that marker is already present.

### Confinement Matrix

- Process-tree control and write confinement are separate mechanisms. A Windows Job Object and a POSIX process group provide lifecycle control, not filesystem confinement.
- For every certified platform–Producer combination, the runtime records process supervision, write confinement, and network policy as `supported` or `unsupported`, and derives implementation-Lane eligibility from write confinement, not from supervision alone.
- The named backend for each platform is either documented Producer-native confinement or a tested operating-system mechanism. Combinations without a proven write-confinement path remain diagnostic-only.

```text
Platform    Process-tree control    Write confinement                              Network policy
macOS       Process group           Producer-native sandbox or named backend       Defined enforcement
Linux       Process group           Producer-native sandbox or named backend       Defined enforcement
Windows     Job Object / helper     Producer-native sandbox or named backend       Defined enforcement
```

### Process Supervision

- The Process Supervisor owns timeout validation and enforcement, Host cancellation, stream draining, output limits, exit normalization, and cleanup. Platform Services owns operating-system-specific executable and process-tree mechanics.
- The Attempt Runtime, not the Producer Adapter, selects and configures the Sandbox Backend from the execution policy and observed capabilities.
- Generic cancellation requests cooperative cancellation, waits for a bounded grace period, and then terminates the complete process tree. It does not require identical signal sequences on every operating system.
- `PosixPlatformServices` uses process groups, POSIX cancellation and termination signals, POSIX file modes, and Unix executable lookup.
- `WindowsPlatformServices` owns the process tree with a Windows Job Object or equivalent reliable mechanism, supports cooperative cancellation where available, forcibly terminates the complete tree when required, and implements Windows file locking, `PATHEXT` resolution, environment-key normalization, and drive, UNC, Unicode, and case-insensitive path handling.
- Calling `child.kill()` only on the direct Windows child does not satisfy process-tree supervision.
- Producer invocation uses executable and argument arrays. The Attempt Runtime does not use `eval`, interpolate untrusted values into command strings, or use `shell: true` with untrusted values.
- Windows executable resolution prefers a native `.exe` or `.com`. For an npm-installed CLI, it next resolves the underlying JavaScript entry point and invokes it as `node.exe <entrypoint> <args...>`.
- A trusted, fully resolved `.cmd` or `.bat` wrapper may be invoked through `cmd.exe /d /s /c` only when direct executable or Node entry-point resolution is unavailable. User-controlled values remain separate and are never concatenated into the command string.
- Windows discovery understands `.exe`, `.com`, `.cmd`, `.bat`, `.ps1`, `PATHEXT`, per-user npm locations, spaces and Unicode in paths, and case-insensitive `Path`/`PATH` keys. Environment construction emits one canonical path key rather than competing variants.
- Every Delegation Spec has a positive wall-clock timeout bounded by a runtime maximum. Cost-budget enforcement is deferred until Producers expose reliable usage facts.
- Stdout and stderr are always drained to prevent deadlock. Persisted output is bounded and includes explicit truncation facts while process supervision continues draining excess bytes.
- Network access follows the Producer Adapter's declared execution requirements. Acceptance Verification runs without network access unless the Delegation Spec explicitly authorizes it.

The Platform Services contract encapsulates raw operating system operations:

```ts
interface PlatformServices {
  os: "darwin" | "linux" | "win32";
  resolveExecutable(request: ExecutableRequest): Promise<ResolvedExecutable>;
  spawnSupervised(request: SpawnRequest): Promise<SupervisedProcess>;
  requestCooperativeCancellation(process: SupervisedProcess): Promise<void>;
  terminateProcessTree(process: SupervisedProcess): Promise<void>;
  acquireCheckoutLock(checkout: string, owner?: LockOwnerAnnotation): Promise<CheckoutLock>;
  createSecureTempDirectory(): Promise<string>;
  canonicalizePath(path: string): Promise<CanonicalPath>;
}
```

The higher-level `PlatformSafety` contract coordinates repository leases, ambiguity gates, and atomic disk durability:

```ts
class PlatformSafety {
  withCheckoutLease<T>(checkout: string, fn: (lease: CheckoutLock) => Promise<T>, options?: CheckoutLeaseOptions<T>): Promise<T>;
  withRecoveryLease<T>(checkout: string, fn: (lease: CheckoutLock) => Promise<T>, options?: CheckoutLeaseOptions<T>): Promise<T>;
  writeAtomic(session: DurableDirectorySession, name: string, bytes: Buffer | string, mode: DurableWriteMode): Promise<void>;
}
```

### Result And Failure Policy

- The Attempt Runtime constructs the canonical Attempt Result from observed process facts, normalized Producer events, Candidate Artifacts, and Acceptance Verification evidence. Producer-authored summaries are untrusted fields.
- An Attempt Result records status, summary, changed files, candidate patch, requested and executed verification, command outcomes, unresolved issues, evidence, bounded logs, Producer version and model, duration, session identifier, and Failure Classification.
- Canonical Attempt Result statuses are `unavailable`, `failed`, `cancelled`, and `verified-candidate`.
- `verified-candidate` means Acceptance Verification passed and a verified Candidate Artifact was produced. It does not mean Claude accepted the candidate or that the main checkout was modified.
- `unavailable` means no process started because the selected Producer could not satisfy the requested Lane. Its Failure Classification distinguishes causes such as unsupported platform, missing executable, ineligible capability, or authentication required.
- `failed` covers invalid specification, spawn failure, timeout, sandbox violation, invalid output, Producer failure, and verification failure; the required Failure Classification preserves the precise reason.
- `invalid-output` means the selected Producer Adapter could not normalize required native output or required Producer-authored payload into the adapter event contract. The Producer never constructs the canonical Attempt Result.
- The Attempt Runtime owns Failure Classification precedence: invalid specification; pre-launch unavailability or authentication requirement; spawn failure; cancellation or timeout according to the initiating runtime event; sandbox violation; invalid output; Producer failure; verification failure. If no failure applies and Acceptance Verification passes, the status is `verified-candidate`.
- `authentication-required` never triggers automatic fallback. A zero exit code does not override invalid output, scope violations, or failed verification.
- A timeout, cancellation, Producer failure, invalid output, or verification failure never triggers automatic fallback in P0.

The lifecycle states remain distinct:

```text
Producer completed
        !=
Candidate verified: AttemptResult = verified-candidate
        !=
Claude accepted: HostDecision = accepted
        !=
Changes integrated: IntegrationResult = applied
```

### Acceptance Verification

- Acceptance Verification executes only commands authorized by the Host in the validated Delegation Spec. Producer-suggested commands may be recorded as evidence but are not executed automatically.
- Verification commands are structured executable-and-argument data, not shell command strings. The runtime resolves verification executables through the same `PlatformServices.resolveExecutable()` path used for Producer CLIs. The structure supports monorepos and cross-platform verification without permitting arbitrary shell strings:

```ts
interface VerificationCommand {
  id: string;
  executable: string;
  args: string[];
  cwd: string;
  environment?: Record<string, string>;
  timeoutMs: number;
  network: "denied" | "allowed";
  expectedExitCodes: number[];
  platform?: {
    os?: Array<"darwin" | "linux" | "win32">;
    arch?: string[];
  };
}
```

- Acceptance Verification has two stages. A packaged structural verifier uses trusted runtime and Git executables without importing candidate code; project verification then runs Host-authorized commands as untrusted code under the same confinement and minimal-environment policy.
- Project verification runs against a disposable materialization of the frozen Candidate Artifact, not the artifact-producing worktree.
- After each project verification command, the structural verifier recomputes the complete tracked and non-ignored manifest: paths, file types, modes, and content hashes. Any divergence from the frozen Candidate Artifact yields `verification-failed`; verification mutations never enter the Candidate Artifact.
- The Run Manifest records the packaged verifier version and content hash.
- Acceptance Verification independently reruns declared checks, records real exit codes, compares all changed paths with allowed scope, detects empty success, and inspects tracked, untracked, and ignored files.
- Project verification success is evidence that Host-authorized checks exited successfully; it is not a claim that candidate-controlled test code is trustworthy.
- If code changes are required, an empty candidate patch cannot yield `verified-candidate`.
- Producer claims such as "tests pass" are evidence only and never substitute for verifier results.

### Retention And Recovery

- Attempt finalization archives bounded redacted logs, the Run Manifest, Attempt Result, and candidate patch, then deletes the attempt worktree after every terminal Attempt Result. Archives live under `${CLAUDE_PLUGIN_DATA}` or an explicit user-configured directory, never under the plugin root.
- Crash recovery detects stale runs, terminates surviving process trees through Platform Services, archives recoverable evidence, releases the checkout lock, and removes stale worktrees.
- Archived artifacts have configurable size and age limits; truncation and cleanup are recorded rather than silent.

### Verification Strategy

- Attempt Runtime tests exercise its interface with fake Producer processes rather than inspecting agent prose.
- Each Producer Adapter has invocation fixtures, Capability Report tests, captured native-event fixtures, and a published platform-capability matrix derived from real tests rather than assumptions.
- Process Supervisor integration tests cover POSIX process-group and Windows process-tree cancellation, timeout escalation, stream saturation, truncation, and orphan cleanup.
- Acceptance Verification tests cover out-of-scope writes, untracked files, symbolic links, empty success, changed base commits, failed commands, and dishonest Producer claims.
- Sandbox Backend tests prove fail-closed selection and policy enforcement separately on each supported operating system.
- Candidate-tree tests prove the runtime, not the Producer, constructs the content-addressed tree and that its oid and manifest hash are stable across freeze, verification, and integration.
- Controlled Integration tests cover stale bases, dirty checkouts, artifact and tree-oid tampering, binary files, modes, deletions, untracked files, and conflict or path divergence detection.
- Producer Configuration Profile tests prove that controlled mode isolates behavior without dropping credentials, and that an adapter unable to separate them is reported rather than silently inheriting global configuration.
- Acceptance Verification tests prove that commands cannot mutate the frozen Candidate Artifact or cause unverified bytes to reach Controlled Integration.
- Schema compatibility tests protect Delegation Spec and Attempt Result versioning.
- Existing CLI argument behavior tests move behind Producer Adapter interfaces. Prose-presence tests do not serve as executable behavior tests.

## Required Release Gates

Claude Architect must not be described as universal until these gates pass.

### Core Runtime Gates

- Integration tests pass on macOS, Linux, and native Windows for every platform claimed in the support matrix.
- Project, plugin, temporary, and Producer paths containing spaces and Unicode are covered.
- Cooperative cancellation and forced process-tree termination leave no surviving descendants.
- Worktree creation, removal, stale-run recovery, and checkout-lock release are covered.
- Native Windows locked-file behavior is handled and tested.
- Path-scope enforcement is tested with case differences, drive paths, and UNC paths on Windows.
- Producer discovery covers native executables and trusted `.cmd` wrappers.
- Structured event parsing accepts CRLF and LF without changing event semantics.
- Windows environment construction normalizes `Path` and `PATH` safely.
- Main-checkout commit and cleanliness integrity checks pass on all supported operating systems.

### Plugin Integration Gates

- Marketplace installation and update are tested on macOS, Linux, native Windows, and WSL where claimed.
- Plugin cache and installation paths containing spaces are tested.
- `/claude-architect:delegate` is visible and invokable after marketplace installation.
- The runtime is accessible through the plugin MCP configuration without depending on the Bash tool's `PATH`.
- MCP bootstrap is tested: Node location and the version-22 floor on every platform, stdout-protocol and stderr-diagnostic separation, startup timeout, crash and restart behavior, per-repository state isolation, serialization of concurrent tool calls, and runtime/schema version-mismatch reporting.
- The `reviewCandidate`, `decideCandidate`, and `integrateCandidate` tools are tested end to end, including that `integrateCandidate` refuses a stale base, dirty checkout, or mismatched artifact hash without mutating the main checkout.
- The `doctor` tool is reachable over MCP and returns structured, actionable diagnostics when Node, Git, or Producers are unavailable.
- Native Windows is tested both without Git Bash and with Git Bash installed.
- WSL installation is tested and reported as Linux rather than native Windows.
- Updating the plugin while a Delegation Attempt is active has a defined, tested outcome that preserves run evidence and checkout integrity.
- Plugin uninstall has defined, tested retain-data and delete-data behavior for archived run data.
- The advisor's effective tool set is verified to exclude Bash and all mutation tools.

### Producer Adapter Gates

- Codex, OpenCode, Pi, and Pythinker each implement the shared adapter contract even where their Capability Report returns unavailable.
- Each adapter publishes tested values for macOS, Linux, native Windows, and WSL, using states such as `certified`, `tested`, `conditional`, `unsupported`, or `unknown` with a reason.
- Native Windows and WSL results are never merged into one Windows claim.
- Producer availability reflects the tested CLI version, authentication state, requested Lane, structured-output support, and required confinement backend.
- Every platform–Producer combination certified for the implementation Lane names a proven write-confinement backend. Combinations without one are published as diagnostic-only, never as implementation-eligible.

The release evidence includes a table in this form, populated only from real test results:

```text
Producer    macOS       Linux       Windows native    WSL
Codex       <result>    <result>    <result>          <result>
OpenCode    <result>    <result>    <result>          <result>
Pi          <result>    <result>    <result>          <result>
Pythinker   <result>    <result>    <result>          <result>
```

### Release Sequencing

The final P0 gate spans three operating systems, four Producers, confinement, verification, recovery, integration, and plugin lifecycle. Implementation is staged so four adapters cannot obscure defects in the core runtime. The public release remains blocked until all required gates pass regardless of stage.

- P0-A — protocol and vertical slice: MCP bootstrap, schemas, Platform Services, the content-addressed Git tree artifact, the Codex adapter, one certified environment per operating system, Acceptance Verification, and Controlled Integration.
- P0-B — cross-platform hardening: the full claimed architecture matrix, the Windows process-tree helper, concrete Sandbox Backends, path, locking, Unicode, and wrapper tests, and crash recovery.
- P0-C — producer completion: the OpenCode, Pi, and Pythinker adapters, per-platform capability certification, and the final universal release gates.

## Product Description

Claude Architect is a cross-platform Claude Code plugin for macOS, Linux, and Windows. It adds `/claude-architect:delegate`, which lets Claude route well-scoped implementation subtasks to supported installations of Codex, OpenCode, Pi, or Pythinker.

Claude remains the architect. It creates a versioned Delegation Spec, selects an available Producer based on required capabilities, and runs the task inside an isolated Git worktree. The plugin supervises the delegated process, enforces timeouts and scope constraints, records a reproducible Run Manifest, and independently verifies the resulting diff and authorized checks.

External agents are untrusted Producers. Their output is returned as a verified Candidate Artifact, not automatically accepted work. Claude reviews the diff and verification evidence before deciding whether the changes should be integrated.

Claude Architect also includes a strictly non-mutating Claude advisor, cross-platform process supervision, crash recovery, bounded and redacted run logging, and Producer Adapters for Codex, OpenCode, Pi, and Pythinker. Producer availability depends on the operating system, installed CLI version, authentication state, requested Lane, and required execution capabilities.

The central architectural rule is: make the protocol universal, make native Windows part of P0, and allow individual Producers to be conditionally available. Plugin availability must not depend on every external CLI being equally portable.

## Reference Sources

- [Claude Code advanced setup](https://code.claude.com/docs/en/setup) defines supported installation environments and native Windows behavior.
- [Claude Code plugin reference](https://code.claude.com/docs/en/plugins-reference) defines plugin MCP configuration, `${CLAUDE_PLUGIN_ROOT}`, agent fields, and path behavior.
- [Claude Code plugin guide](https://code.claude.com/docs/en/plugins) defines namespaced plugin Skills, plugin structure, and the Bash-specific `bin/` `PATH` behavior.
- [Node.js child process documentation](https://nodejs.org/api/child_process.html) defines cross-platform spawn, detached-process, signal, Windows wrapper, and case-insensitive environment behavior.
- [OpenCode documentation](https://opencode.ai/docs/) documents native Windows installation options and its WSL recommendation.
- [Git plumbing documentation](https://git-scm.com/docs) defines the isolated-index, `write-tree`, `read-tree`, and `hash-object` operations used to construct and revalidate the content-addressed Candidate Artifact.
- [Model Context Protocol specification](https://modelcontextprotocol.io/specification) defines the stdio transport, protocol-versioning, and stdout/stderr separation that the MCP bootstrap contract depends on.

## Deferred Decisions

- Bundling the TypeScript runtime into standalone platform executables and the associated artifact selection, signing, and release process.
- Dirty-checkout baseline snapshots.
- Read-only and non-implementation Lanes.
- Parallel attempts, queueing, and integration-race policy.
- Learned quality, speed, and cost routing.
- Automatic retry after a Producer process starts.
- Cost-budget enforcement and historical Producer scoring.
- Bounded nested delegation.
- Resumable attempts.
