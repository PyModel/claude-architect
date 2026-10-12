# ADR-0001: Identity-bound ownership of runtime-allocated Producer HOMEs

Status: accepted (2026-10-11)

## Context

When a Producer's isolation profile requires a temporary HOME
(`controlled-config-supported`, `controlled-config-with-copied-credentials`),
`ProducerRuntime.planLaunch` allocated one with `createSecureTempDirectory()` in
the system temp directory. The attempt lane (`attempt-runtime.ts`) and the role
lane (`role-runner.ts`) later removed it with `rm(path, { recursive: true })`.

Two defects follow, both reproduced on `main` @ 532b439 by
`tests/runtime/producer-home.test.ts`:

1. **Replacement.** A Producer child that renames its HOME aside and plants a
   directory at the original pathname makes the runtime delete the replacement
   and leak the real allocation (which can hold credentials the Producer copied
   in). Seatbelt does not prevent it: the profile grants writes to `$TMPDIR`
   (`seatbelt.ts:189`), so the rename lands inside write scope, and a real
   `sandbox-exec` run confirmed `mv <home> <tmp>/x` succeeds.
2. **Planning rollback.** A failure after allocation inside `planLaunch`
   (adapter `buildInvocation` throws, an invalid environment name, the watchdog
   resolution) never returned the path to any caller, so nothing removed it.

Every lane funnels through `ProducerRuntime`: the attempt, its preflight (which
receives the attempt's HOME and never allocates its own), and every pipeline
role (`runRole` is the only role seam; slice runner, final-branch reviewer and
advisor all reach it).

### Audit of the earlier scope extension against `main`

- Seatbelt shared temp grant: now `seatbelt.ts:189` (was cited as :151);
  `:140` is the inherited-state guard, which already drops inherited grants
  whenever a temp HOME is set.
- The settled-tree / outside-write-scope precondition for bound removal is the
  comment at `bound-directory-cleanup.ts:476-479` (was cited as :430).
- The single PID slot is `run-start.ts:164-187` (`withRunStartPidRecording`
  overwrites `run-start.json` per spawn at :176-180). Still one slot per run.
- New since the extension was written: `moveDirectory` (`durable-write.ts:483`)
  renames within one durable directory session and proves identity.
- SBPL last-match-wins (needed for the deny below) was verified on this host
  with a real `sandbox-exec` profile: a later `deny` overrides an earlier
  `allow`, and a later `allow` re-opens a subpath of the denied root.

## Decision

### Allocation (A1)

- Owned HOMEs live under one private root, `<resolveStateDir()>/h`, created and
  validated with `ensurePrivateDirectory`. Each allocation is
  `<root>/<8 hex>` (short for Windows `MAX_PATH`), created exclusively with
  mode 0700, and its `DirectoryIdentity` (`requireBirthtimeIdentity`) is
  captured before the path reaches an adapter.
- The root must be outside the launch's explicit Producer write scope:
  `planLaunch` refuses (fails closed, nothing allocated) when the root and the
  worktree, any `extraWritableRoots`, or the Git object directories contain one
  another.
- Every Seatbelt profile that carries `protectedRoots` ends with
  `(deny file-write* (subpath <root>))` followed by
  `(allow file-write* (subpath <own HOME>))`. The root, sibling HOMEs, claims
  and quarantines are therefore unwritable by construction, even where the
  state directory sits under `$TMPDIR` or an inherited-state grant would cover
  it. Producer launches always pass the root.
- Borrowed HOMEs (`request.tempHome` supplied, e.g. the preflight) and launches
  without a temp HOME are unchanged: the runtime never deletes a HOME it did not
  allocate in that call.

### Claim record (A2)

One claim per allocation, `<root>/<id>.claim`, internal to `src/runtime/`
(not a public schema), written with `writeAtomic` (`immutable` to create,
`replace` to update). Only the allocating process writes its own claim, so
concurrent roles never share or overwrite a record. Fields, strictly
validated on read:

```json
{ "claimVersion": 1, "homeId": "<8 hex>",
  "identity": { "dev": "<dec>", "ino": "<dec>", "birthtimeNs": "<dec>" },
  "owner": { "pid": 123, "processToken": "<token>" },
  "producers": [{ "pid": 456, "processToken": "<token>|null" }],
  "phase": "held" | "launching" | "quarantined", "createdAt": "<ISO>" }
```

Ownership metadata only: never HOME contents, environment, or secrets.
Transitions: created (`held`, no producers) before exposure → `launching`
immediately before the spawn → `held` with the producer appended right after
it (as `withRunStartPidRecording` does, but per claim; a failed record
terminates the tree) → `quarantined` after the identity-checked rename →
removed after the quarantine is gone.

### Retirement (A3)

Only the owner retires, and only after `supervise` has returned (the process
tree is settled):

1. `lstat <root>/<id>`; it must be a plain directory with the claimed identity.
   Missing or different → touch nothing, keep the claim, return a conflict
   diagnostic.
2. `moveDirectory` to `<root>/.q-<id>`, with the expected identity checked on
   the same `lstat` the rename uses; persist `quarantined`.
3. `emptyBoundDirectory` + `removeBoundEmptyDirectory` on the quarantine
   (identity-bound, mount- and symlink-safe, backend availability checked).
4. Remove the claim.

Any failure keeps the directory and claim and returns a bounded
(`boundedRedactedDiagnostic`, paths become `[path]`) diagnostic. Callers keep
their primary outcome: the attempt lane records `evidence.cleanupFailure` and
`attempt-cleanup-failed`; the role lane returns its result with
`cleanupFailure`, archived beside the role log, and a replaced/missing HOME
additionally fails the role as `sandbox-violation`, since the Producer acted on
its own allocation from outside it. A planning failure retires the allocation
before rethrowing, aggregating a retirement failure with the primary error.
There is no pathname-only recursive deletion anywhere.

### Recovery

`recoverStaleRuns`, under the existing recovery lock, scans the root:

- A claim that fails strict parsing → preserved, diagnosed.
- Any recorded owner or producer `live` or `unverifiable`
  (`lockOwnerStatus`) → preserved silently (it may still be running).
- `launching` (the owner died between the spawn and its record, so a child
  may be running unrecorded) → preserved, diagnosed.
- All owners `dead` → replay from the phase: `held` with the identity at the
  allocation name → retire; at the quarantine name (crash between rename and
  phase write) → continue; `quarantined` with the quarantine gone → remove the
  claim; anything else → preserved, diagnosed.
- Allocation or quarantine directories without a claim are never inferred
  from their name or age: preserved and diagnosed.

Diagnostics join `worktreeSweepIssues` (redacted reason; the path is not under
a `worktrees` directory, so they inform startup without blocking mutation).

## Consequences and residual limits

- Producer-native sandboxes (Codex) define their own write scope; the Codex
  edit lane also grants the darwin per-user temp directory
  (`sandboxSupportWritableRoots`), which `planLaunch` cannot see. The default
  state directory (`CLAUDE_PLUGIN_DATA`) is not under it; a custom state
  directory placed under the user temp directory is only protected by the
  identity checks, not by write denial, on that lane.
- A Producer grandchild that escapes the supervised tree can still write its
  own HOME until it exits; quarantine moves it out of that pathname first, and
  under Seatbelt the quarantine name is denied.
- A runtime crash between spawn and the claim update leaves a `launching`
  claim that recovery preserves and reports; it is never reclaimed
  automatically.
