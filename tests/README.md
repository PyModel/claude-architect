# Test surface

Each row names the test file, the primary `src/` module (or script) it exercises, the 1-4 exported
symbols that make up the interface being crossed, its layer per AGENTS.md's testing taxonomy (unit /
contract / integration / adversarial / smoke), and whether it reaches past that public interface. The
rule: a test names one module and crosses only that module's exported surface — direct calls to its
exported functions/classes, or (for shell tests) its documented CLI contract. Anything else — mocking a
Node builtin, mocking/spying an internal `src/` module to replace its behavior, importing a symbol the
named module doesn't actually export, reaching into another module's internals instead of its public
surface, or hand-building an evidence bag/manifest that only the real runtime should produce — is a
boundary violation, listed under "Past the interface" below, and should be moved onto the real
interface or deleted (unless it is a deliberate, justified adversarial fault-injection test, per
AGENTS.md's own carve-out, which never mocks the component whose security property it is proving).

## Map

| File | Module under test | Interface crossed | Layer | Past the interface |
|---|---|---|---|---|
| tests/claude-runtime-resolver.test.sh | agents/, runtime/bootstrap.mjs, runtime/server.mjs | file presence (CLI contract) | contract | no |
| tests/delegate-routing.test.mjs | skills/delegate/SKILL.md | doc-text assertions | contract | no |
| tests/install-opencode.test.sh | scripts/install-opencode.sh | installer script behavior | integration | no |
| tests/lane-launchers.test.sh | scripts/, agents/, src/mcp/server.ts, src/producers/*-adapter.ts, skills/delegate/SKILL.md | file-presence/grep checks | contract | no |
| tests/plugin-manifest.test.mjs | .claude-plugin/plugin.json, marketplace.json | JSON field assertions | contract | no |
| tests/runtime/acceptance-verifier.test.ts | src/verify/acceptance-verifier.ts | AcceptanceVerifier | unit | no |
| tests/runtime/agy-adapter.test.ts | src/producers/agy-adapter.ts | AgyAdapter, renderProducerPrompt, producerRuntime, renderSkillBootstrap | contract | no |
| tests/runtime/allowlist-sufficiency.test.ts | src/mcp/allowlist-sufficiency.ts | resolveImport, checkAllowlistSufficiency, allowlistSufficiencyDiagnostic | unit | no |
| tests/runtime/artifact-store-bytes.test.ts | src/runtime/artifact-store.ts, src/runtime/run-manifest.ts | ArtifactStore, buildRunManifest | contract | no |
| tests/runtime/artifact-store.test.ts | src/runtime/artifact-store.ts | ArtifactStore, pruneRuns, buildRunManifest, sanitizeRunManifest | adversarial | YES — `vi.mock("node:fs/promises", ...)` wraps `open` to inject write failures |
| tests/runtime/attempt-result.test.ts | src/protocol/attempt-result.ts | classifyFailure | unit | no |
| tests/runtime/attempt-runtime.test.ts | src/runtime/attempt-runtime.ts | runAttempt | integration | YES — `vi.spyOn(WorktreeManager.prototype, "create")` (L582) replaces internal worktree creation |
| tests/runtime/autopilot/autopilot-adversarial.test.ts | src/autopilot/autopilot-controller.ts, branch-manager.ts, candidate-promoter.ts, final-branch-reviewer.ts | AutopilotController, WorkflowBranchManager, CandidatePromoter, FinalBranchReviewer | adversarial | no |
| tests/runtime/autopilot/autopilot-controller.test.ts | src/autopilot/autopilot-controller.ts | AutopilotController, AutopilotControllerDependencies | unit | no |
| tests/runtime/autopilot/autopilot-doctor.test.ts | src/mcp/doctor.ts | doctor | integration | no |
| tests/runtime/autopilot/autopilot-e2e.test.ts | src/autopilot/autopilot-controller.ts, src/pipeline/pipeline-runtime.ts | AutopilotController, runPipeline | integration | no |
| tests/runtime/autopilot/autopilot-mcp.test.ts | src/mcp/server.ts | createServer (via MCP Client/InMemoryTransport) | contract | no |
| tests/runtime/autopilot/autopilot-recovery-cutpoints.test.ts | src/runtime/recovery-autopilot.ts | recoverStaleRuns | adversarial | no |
| tests/runtime/autopilot/autopilot-recovery.test.ts | src/runtime/recovery-autopilot.ts | recoverStaleRuns | integration | no |
| tests/runtime/autopilot/autopilot-windows.test.ts | src/autopilot/autopilot-controller.ts, src/pipeline/pipeline-runtime.ts | AutopilotController, runPipeline | integration | no |
| tests/runtime/autopilot/branch-manager.test.ts | src/autopilot/branch-manager.ts | WorkflowBranchManager | integration | YES (minor) — `vi.spyOn(logger, "warn")` (L911) silences internal logger |
| tests/runtime/autopilot/candidate-promoter.integration.test.ts | src/autopilot/candidate-promoter.ts | CandidatePromoter | integration | no |
| tests/runtime/autopilot/candidate-promoter.test.ts | src/autopilot/candidate-promoter.ts | CandidatePromoter | unit | YES (minor) — `vi.spyOn(logger, "warn")` (L447) |
| tests/runtime/autopilot/final-branch-reviewer.test.ts | src/autopilot/final-branch-reviewer.ts | FinalBranchReviewer, WorkflowStore, WorkflowBranchManager | adversarial | YES — `vi.spyOn(branchManager, "revalidateUnderLock").mockImplementation(...)` (L637) replaces the real revalidation path |
| tests/runtime/autopilot/workflow-state-schema.test.ts | src/protocol/schema-loader.ts, src/autopilot/types.ts | loadSchemas, AutopilotWorkflowState | contract | no |
| tests/runtime/autopilot/workflow-store.test.ts | src/autopilot/workflow-store.ts | WorkflowStore, LEGAL_WORKFLOW_PHASE_EDGES | integration | no |
| tests/runtime/baseline-verifier.test.ts | src/verify/baseline-verifier.ts | verifyBaseline, WorktreeManager | integration | no |
| tests/runtime/bootstrap-check.test.ts | src/mcp/bootstrap-check.ts | isNodeSupported, formatMissingNodeDiagnostic | unit | no |
| tests/runtime/bootstrap.smoke.test.ts | runtime/bootstrap.mjs | spawned CLI process | smoke | no |
| tests/runtime/bound-directory-cleanup.test.ts | src/platform/bound-directory-cleanup.ts | resolveEmptyDirectoryTimeoutMs | unit | no |
| tests/runtime/candidate-decision.test.ts | src/protocol/candidate-decision.ts, src/protocol/schema-loader.ts | loadSchemas, CandidateDecision types | contract | no |
| tests/runtime/candidate-tree.test.ts | src/git/candidate-tree.ts | freezeCandidate | integration | YES — `vi.mock("../../src/git/git-exec.js", ...)` (L439) wraps `git()` to inject failures |
| tests/runtime/capability-probe.test.ts | src/producers/capability-probe.ts | probeAll, CodexAdapter, ProducerRegistry | contract | no |
| tests/runtime/changed-path-manifest.test.ts | src/git/changed-path-manifest.ts | computeChangedPathManifest, parseRawDiff, manifestHashOf | unit | no |
| tests/runtime/checked-git.test.ts | src/git/checked-git.ts | gitChecked, gitSucceeded, reviewDiffArgs | unit | no |
| tests/runtime/claude-adapter.test.ts | src/producers/claude-adapter.ts | ClaudeAdapter, renderProducerPrompt | contract | no |
| tests/runtime/codex-adapter.test.ts | src/producers/codex-adapter.ts | CodexAdapter, codexDescriptor, sandboxSupportWritableRoots | contract | no |
| tests/runtime/consolidator.test.ts | src/pipeline/consolidator.ts | consolidate, detectNonConvergence | unit | no |
| tests/runtime/controlled-integrator.test.ts | src/integrate/controlled-integrator.ts | applyCandidateTree, stageCandidateTreeUnderLock | integration | YES — `vi.mock("../../src/git/git-exec.js", ...)` (L797) injects mid-operation git failures |
| tests/runtime/crlf-events.test.ts | src/producers/codex-adapter.ts | CodexAdapter.normalizeEvents | unit | no |
| tests/runtime/cross-lane-launch.test.ts | src/producers/producer-runtime.ts, producer-registry.ts | producerRuntime, registry | contract | no |
| tests/runtime/cross-lane-probe.test.ts | src/producers/*-adapter.ts (6 adapters) | probe() on each ProducerAdapter | contract | no |
| tests/runtime/cross-lane-prompt.test.ts | src/producers/prompt-renderer.ts | renderProducerPrompt, renderList, DescriptorAdapter | unit | no |
| tests/runtime/decision-authority.test.ts | src/mcp/decision-authority.ts, src/mcp/server.ts | decisionAuthority, autonomousEligibility, start | integration | no |
| tests/runtime/dependency-link.test.ts | src/verify/dependency-link.ts | linkPrimaryDependencies, probeCowSupport | integration | no |
| tests/runtime/doctor.test.ts | src/mcp/doctor.ts | doctor | contract | no |
| tests/runtime/durable-directory.test.ts | src/platform/durable-directory.ts | ensurePrivateDirectory, syncDirectoryMetadata | integration | no |
| tests/runtime/durable-write.test.ts | src/platform/durable-write.ts | openDurableDirectorySession, writeAtomic | integration | no |
| tests/runtime/e2e-pipeline.test.ts | src/pipeline/pipeline-runtime.ts, src/mcp/tools.ts | runPipeline, handleDelegatePipeline, handleDecideCandidate | integration | no |
| tests/runtime/e2e-vertical-slice.test.ts | src/mcp/tools.ts | handleDelegate, handleReviewCandidate, handleIntegrateCandidate | integration | no |
| tests/runtime/environment-policy.test.ts | src/runtime/environment-policy.ts | buildEnvironment, registerSensitiveEnvironment | unit | no |
| tests/runtime/gates.test.ts | src/pipeline/gates.ts | evaluateGates | unit | no |
| tests/runtime/git-exec.test.ts | src/git/git-exec.ts | git, getPlatformServices | integration | YES — `vi.spyOn(services, "resolveExecutable")` (L118) mocks an internal PlatformServices method to observe caching |
| tests/runtime/git-read-tools.test.ts | src/mcp/git-read-tools.ts | gitLog, gitStatus, gitDiff, gitChangedFiles | integration | no |
| tests/runtime/git-writable-roots.test.ts | src/pipeline/git-writable-roots.ts | resolveLinkedWorktreeWritableRoots | integration | no |
| tests/runtime/handshake.smoke.test.ts | src/mcp/server.ts (via runtime/server.mjs) | createServer, MCP handshake | smoke | no |
| tests/runtime/human-decision-gate.test.ts | src/mcp/server.ts | confirmWithHuman | unit | no |
| tests/runtime/legacy-decision-provenance.test.ts | src/runtime/artifact-store.ts | ArtifactStore | integration | YES — hand-writes `decision.json` bytes in a prior release's shape (~L498-816) instead of via a real decision flow |
| tests/runtime/live-bundle.test.ts | src/mcp/live-bundle.ts | checkLiveBundle, liveBundleDiagnostic | unit | no |
| tests/runtime/lock-contention.test.ts | src/platform/select-platform.ts | getPlatformServices, acquireCheckoutLock | integration | no |
| tests/runtime/lock-ownership.test.ts | src/platform/lock-ownership.ts | formatLockRecord, parseLockRecord, reclaimDeadLock, lockOwnerStatus | unit/contract | YES — `vi.spyOn(logger, "warn")` (L690-691) mocks internal logger |
| tests/runtime/mcp-cancellation.test.ts | src/mcp/server.ts | start (MCP server) | integration | no |
| tests/runtime/mcp-decision-gate.test.ts | src/mcp/server.ts, src/runtime/artifact-store.ts | start, ArtifactStore | integration | no |
| tests/runtime/mcp-input-schema.test.ts | src/mcp/server.ts | delegateInputSchema, delegatePipelineInputSchema | contract | no |
| tests/runtime/mcp-output-schema.test.ts | src/mcp/server.ts, src/mcp/doctor.ts | delegatePipelineOutput, doctorOutput, doctor | contract | no |
| tests/runtime/opencode-adapter.test.ts | src/producers/opencode-adapter.ts | OpenCodeAdapter | integration | no |
| tests/runtime/jev-screen.test.ts | src/mcp/jev-screen.ts | jevScreen | unit | no — the TypeSafe API is reached through an injected `fetch` |
| tests/runtime/pi-adapter.test.ts | src/producers/pi-adapter.ts | PiAdapter | integration | no |
| tests/runtime/pipeline-runtime.test.ts | src/pipeline/pipeline-runtime.ts | runPipeline, runIncrement, runReviews, verifyCandidate | integration | YES — extensive `vi.spyOn(AcceptanceVerifier.prototype, "verify")`, `ArtifactStore.prototype.*`, `WorktreeManager.prototype.create` (L792,927,933,1010,1180,1239,1378,1483,2076,3345,3424) replace internal src behavior |
| tests/runtime/pipeline/advisor-stage.test.ts | src/pipeline/advisor-stage.ts | runAdvisorStage | integration | no |
| tests/runtime/pipeline/autopilot-eligibility.test.ts | src/autopilot/autopilot-eligibility.ts | evaluateAutopilotEligibility | unit | no |
| tests/runtime/pipeline/slice-runner.test.ts | src/pipeline/slice-runner.ts | SliceRunner, PipelineSlice, SliceAttempt | integration | no |
| tests/runtime/pipeline/wayfinder.test.ts | src/pipeline/wayfinder.ts | routeSlice | unit | no |
| tests/runtime/platform-safety.test.ts | src/platform/platform-safety.ts | PlatformSafety.withCheckoutLease | unit | no |
| tests/runtime/platform-path.test.ts | src/util/platform-path.ts | platformPathsEqual | unit | no |
| tests/runtime/plugin-wiring.test.mjs | .mcp.json, runtime/bootstrap.mjs, runtime/server.mjs, agents/advisor.md | file/wiring assertions | contract | no |
| tests/runtime/posix-platform-services.test.ts | src/platform/posix-platform-services.ts | PosixPlatformServices, CLEANUP_JOURNAL_LOCK_KEY | integration | no |
| tests/runtime/pre-push-hook.test.ts | .githooks/pre-push | shell script source assertions | contract | no |
| tests/runtime/probe-cache.test.ts | src/producers/producer-runtime.ts, producer-registry.ts | ProducerRuntime, ProducerRegistry, ProducerAdapter | unit | no |
| tests/runtime/process-supervisor.test.ts | src/platform/process-supervisor.ts | supervise | integration | no |
| tests/runtime/process-token.test.ts | src/platform/posix-platform-services.ts | getProcessStartToken, terminateProcessTreeByPid | integration | no |
| tests/runtime/producer-adapter.test.ts | src/producers/producer-adapter.ts | detectEnvironmentType, DescriptorAdapter, ProducerAdapter | unit | no |
| tests/runtime/producer-preflight.test.ts | src/runtime/producer-preflight.ts | preflightExecutables, preflightProbeCommand, readProbe, runProducerPreflight | integration | no |
| tests/runtime/project-verifier.test.ts | src/verify/project-verifier.ts | projectVerify | integration | no |
| tests/runtime/protocol/autopilot-schema.test.ts | src/protocol/spec-validator.ts | validateAutopilotSpec | contract | no |
| tests/runtime/protocol/slice-schema.test.ts | src/protocol/schema-loader.ts | loadSchemas().delegationSpec | contract | no |
| tests/runtime/protocol/slice-types.test.ts | src/protocol/delegation-spec.ts | resolveSlices | unit | no |
| tests/runtime/protocol/slice-validation.test.ts | src/protocol/spec-validator.ts | validateSpec | unit | no |
| tests/runtime/pythinker-adapter.test.ts | src/producers/pythinker-adapter.ts | PythinkerAdapter, producerRuntime, renderProducerPrompt | integration | no |
| tests/runtime/recovery-manager.test.ts | src/runtime/recovery-manager.ts | recoverStaleRuns | integration | YES — `vi.spyOn(logger, "warn")`/`console.error` on internal logger (L897-903); also mocks external `@modelcontextprotocol/sdk` (L864/870, not src) |
| tests/runtime/redaction.test.ts | src/runtime/redaction.ts | redact, redactRecord, registerSecretValue | unit | no |
| tests/runtime/repo-preconditions.test.ts | src/git/repo-preconditions.ts | checkPreconditions | adversarial | YES — `vi.mock("node:fs/promises")` (L982) injects access/opendir/realpath failures |
| tests/runtime/report-schemas.test.ts | src/protocol/schema-loader.ts | loadSchemas() report validators | contract | no |
| tests/runtime/reproducibility.test.ts | src/runtime/reproducibility.ts | collectReproducibilityInputs | integration | no |
| tests/runtime/review-manifest-echo.test.ts | src/mcp/tools.ts, src/mcp/server.ts | handleReviewCandidate, reviewCandidateOutputSchema | contract | no |
| tests/runtime/review-snapshot.test.ts | src/runtime/review-snapshot.ts | createReviewSnapshot, reviewSnapshotHash | unit | no |
| tests/runtime/role-prompts.test.ts | src/pipeline/role-prompts.ts | buildRoleSpec, renderRolePrompt | unit | no |
| tests/runtime/role-runner.test.ts | src/pipeline/role-runner.ts | runRole | integration | no |
| tests/runtime/routing-policy.test.ts | src/producers/routing-policy.ts | route | unit | no |
| tests/runtime/run-decision.test.ts | src/runtime/run-decision.ts | RunDecision, runDecision, readRunDecisionSnapshot | unit | no |
| tests/runtime/run-manifest.test.ts | src/runtime/run-manifest.ts | buildRunManifest, verifyRunManifest | unit | no |
| tests/runtime/run-status.test.ts | src/runtime/run-status.ts, src/runtime/attempt-runtime.ts | StatusEmitter, runAttempt, initializeRunStart | integration | YES — `vi.spyOn(ArtifactStore.prototype, "writeRunStatus")` + `vi.spyOn(logger, "warn")` (L1661-1663) force failure paths mid-run |
| tests/runtime/sandbox-backends.test.ts | src/platform/sandbox/backends.ts | selectSandboxBackend, SANDBOX_BACKENDS | unit | no |
| tests/runtime/scaffold.test.ts | src/util/logger.ts | logger | unit | no |
| tests/runtime/schema-loader.test.ts | src/protocol/schema-loader.ts | loadSchemas, checkVersionCompat | contract | no |
| tests/runtime/seatbelt.test.ts | src/platform/sandbox/seatbelt.ts | buildSeatbeltProfile, buildReadOnlySeatbeltPolicy, wrapInvocationWithSeatbelt | unit | no |
| tests/runtime/serialize.test.ts | src/mcp/serialize.ts | withRepoLock | unit | no |
| tests/runtime/skill-bootstrap.test.ts | src/producers/skill-bootstrap.ts | renderSkillBootstrap | unit | YES — `vi.doMock("node:fs")` (~L59) stubs `existsSync` to force a fail-closed branch |
| tests/runtime/slice-composer.test.ts | src/pipeline/slice-composer.ts | composeSliceOntoHead, parseRawDiffEntries | integration | no |
| tests/runtime/slice-scheduler.test.ts | src/pipeline/slice-scheduler.ts | planSliceWaves | unit | no |
| tests/runtime/spec-hash.test.ts | src/protocol/spec-hash.ts | canonicalSpecJson, specSha256 | unit | no |
| tests/runtime/spec-validator-review.test.ts | src/protocol/spec-validator.ts | validateSpec, resolveImplementationConfig, resolveReviewConfig | contract | no |
| tests/runtime/spec-validator.test.ts | src/protocol/spec-validator.ts | validateSpec | contract | no |
| tests/runtime/stable-file.test.ts | src/runtime (stable-file reader) | readStableRegularFile | adversarial | no |
| tests/runtime/structural-verifier.test.ts | src/verify/structural-verifier.ts | structuralVerify, isWithinScope, pathsCaseCollide | integration | no |
| tests/runtime/structured-output.test.ts | src/pipeline/structured-output.ts | extractJson, parseStructuredReport | unit | no |
| tests/runtime/tools.test.ts | src/mcp/tools.ts | handleDelegate, handleDelegatePipeline, handleReviewCandidate, handleIntegrateCandidate | contract | no |
| tests/runtime/verification-mode.test.ts | src/verify/structural-verifier.ts, src/verify/acceptance-verifier.ts | MODE_STRUCTURAL_FAILURES, isAllowed, AcceptanceVerifier | unit | no |
| tests/runtime/watchdog.test.ts | runtime/watchdog.mjs | spawned process | integration | no |
| tests/runtime/windows-filesystem-helper.test.ts | src/platform/windows-filesystem-helper.ts | resolveWindowsFilesystemHelper, removeBoundEmptyDirectory | smoke | no |
| tests/runtime/windows-helper-resolve.test.ts | src/platform/windows-platform-services.ts | resolveJobKillHelper, WindowsPlatformServices, resolveWindowsFilesystemHelper | unit | no |
| tests/runtime/windows-job-kill.test.ts | src/platform/windows-platform-services.ts | resolveJobKillHelper, WindowsPlatformServices | smoke | no |
| tests/runtime/windows-platform.test.ts | src/platform/windows-platform-services.ts | canonicalizeForScope, acquireWxFileLock, WindowsPlatformServices | unit | no |
| tests/runtime/windows-resolve.test.ts | src/platform/windows-env.ts, src/platform/windows-platform-services.ts | normalizeWindowsEnv, resolveWindowsExecutable | unit | no |
| tests/runtime/worktree-manager.test.ts | src/runtime/worktree-manager.ts | WorktreeManager, managedWorktreeDirectoryIdentity, removeManagedWorktreeDirectory | integration | no |
| tests/runtime/worktree-registration.test.ts | src/git/worktree-registration.ts | findWorktreeRegistration | unit | no |
| tests/runtime/worktree-removal-manifest.test.ts | src/runtime/worktree-removal-manifest.ts | persistWorktreeRemovalManifest, readPendingWorktreeRemovalManifests, replaceWorktreeRemovalManifest, assertNoPendingWorktreeRemovalForRepository | integration | no |
| tests/runtime/worktree-sweep.test.ts | src/runtime/recovery-worktree-sweep.ts | recoverStaleRuns, WorktreeManager | integration | no |
| tests/validate-release.test.sh | scripts/validate-release.sh | validate-release CLI contract | integration | no |

## Past the interface

Rule applied: a spy that calls through to the real implementation and only
observes (lease held, call count) or injects one fault the real system cannot
produce deterministically (disk write failure, git dying mid-sequence, a
cleanup that throws) stays. A mock that replaces the component whose property
the test claims to prove is forbidden by AGENTS.md and must move or go. Every
site below was read; each verdict names the reason.

| Site | What it does | Verdict |
| --- | --- | --- |
| `tests/runtime/artifact-store.test.ts` (`vi.mock("node:fs/promises")`) | wraps `open` to fail a write | keep: OS fault injection; the store's durability is what is being proven, and it is real |
| `tests/runtime/attempt-runtime.test.ts:582` | `WorktreeManager.prototype.create` calls through, then makes `cleanup` throw | keep: fault injection on a real worktree; proves the outcome survives cleanup failure |
| `tests/runtime/autopilot/final-branch-reviewer.test.ts:637` | `revalidateUnderLock` replaced to assert the lock is held and count calls after cleanup | keep: observes ordering of a real lock; the property proven is the caller's sequencing, not revalidation itself |
| `tests/runtime/candidate-tree.test.ts:439`, `tests/runtime/controlled-integrator.test.ts:797` | `git-exec` wrapped to fail one call mid-sequence | keep: a real repository cannot make git die at step N deterministically; every other call is real git |
| `tests/runtime/git-exec.test.ts:118` | spies `resolveExecutable` to count resolutions | keep: the cache is the unit under test and its contract is "resolve once" |
| `tests/runtime/legacy-decision-provenance.test.ts` | hand-writes legacy `decision.json` bytes | keep: the current runtime no longer produces that shape; reading it is the contract |
| `tests/runtime/pipeline-runtime.test.ts` (11 sites) | `AcceptanceVerifier.prototype.verify`, `ArtifactStore.prototype.*`, `WorktreeManager.prototype.create` spied; each calls through and either asserts the lease is held, counts calls, or fails once | keep: every spy runs the real method; the pipeline, store, verifier, and worktrees are real. Sites that never call through (`1180`, `1483`) reject a single durable write to prove the failure is reported, not swallowed |
| `tests/runtime/run-status.test.ts:1661` | `writeRunStatus` rejected once; `logger.warn` observed | keep: proves status is advisory and never breaks control flow |
| `tests/runtime/repo-preconditions.test.ts:982`, `tests/runtime/skill-bootstrap.test.ts:59` | `node:fs` failures forced | keep: fail-closed branches unreachable without an injected fault |
| `branch-manager.test.ts:911`, `candidate-promoter.test.ts:447`, `lock-ownership.test.ts:690`, `recovery-manager.test.ts:897` | `logger.warn` / `console.error` spied | keep: log observation, no behaviour substituted |

Nothing was moved or deleted: no test replaces the component whose property it
proves. Any future entry here must carry a verdict in this table.

## Helpers

- `tests/helpers/platform-services-double.ts` — builds a complete `PlatformServices` test double (real platform + per-test overrides) via prototype delegation, used by recovery/platform tests.
- `tests/runtime/helpers/git-fixture-env.ts` — `scrubbedGitEnv()` strips `GIT_*` location env vars so fixture repos don't inherit the outer repo's git context.
- `tests/runtime/pipeline/autopilot-fixtures.ts` — shared autopilot fixture builders (manifest hashes, dead-owner mutation helpers) used across autopilot recovery/branch tests.
- `tests/runtime/fixtures/codex-garbage.txt` — malformed fixture input for Codex adapter parsing tests.
- `tests/runtime/fixtures/codex-success.json` — well-formed Codex event fixture.
- `tests/runtime/fixtures/echo-sleep.mjs` — spawnable helper process used by process-supervisor/watchdog tests.
- `tests/runtime/fixtures/edit-file.mjs` — spawnable helper process that mutates a file, used by worktree/producer tests.

## Symbol audit

Every named import from a src module resolves to an export of that module. No "symbol not exported"
violations were found across the full test suite (135 files, 5 independent batch audits, each verifying
its flagged imports against `export` declarations via grep).
