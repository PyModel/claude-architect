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
  worktree, any `extraWritableRoots`, the Git object directories, or (for a
  producer-native backend) the descriptor's `nativeWritableRoots` contain one
  another.
- Every Seatbelt profile that carries `protectedRoots` ends with
  `(deny file-write* (subpath <root>))` followed by
  `(allow file-write* (regex #"^<own HOME>/"))` for the raw path and its
  realpath. The regex matches only entries beneath the HOME, never the HOME
  pathname itself (a `subpath` reopen does, and real `sandbox-exec` then lets
  the Producer rename its HOME into `$TMPDIR` or recreate it). Under Seatbelt
  the root, sibling HOMEs, claims, quarantines and the HOME name are therefore
  unwritable by construction, even where the state directory sits under
  `$TMPDIR` or an inherited-state grant would cover it. The Producer can still
  move its own *subdirectories* out to writable `$TMPDIR`; that changes only
  what it keeps, and the HOME itself is caught by the identity checks at
  retirement. Producer launches always pass the root.
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
(`boundedRedactedDiagnostic`, paths become `[path]`) diagnostic. A
replaced/missing HOME fails the run as `sandbox-violation`, since the Producer
acted on its own allocation from outside it: the attempt lane retires the HOME
as soon as the Producer settles and before archiving, so the archived result
itself is the failure (`producer-home-conflict`, `evidence.producerHomeFailure`)
and no acceptance rule reads the candidate as clean; the role lane returns
`ok: false` with `cleanupFailure`, archived beside the role log. Any other
retirement failure keeps the primary outcome and is recorded beside it
(`evidence.cleanupFailure` and `attempt-cleanup-failed`; the role's
`cleanupFailure`). A planning failure retires the allocation before
rethrowing the primary error, with the retirement diagnostic attached.
There is no pathname-only recursive deletion anywhere.

### Recovery

`recoverStaleRuns`, under the existing recovery lock, scans the root:

- A claim that fails strict parsing → preserved, diagnosed.
- Any recorded owner or producer `live` (`lockOwnerStatus`) → preserved
  silently, as run recovery treats a live run.
- Otherwise any `unverifiable` (alive, but its start token cannot be
  confirmed) → preserved, diagnosed.
- `launching` (the owner died between the spawn and its record, so a child
  may be running unrecorded) → preserved, diagnosed.
- All owners `dead` → replay from the phase: `held` with the identity at the
  allocation name → retire; at the quarantine name (crash between rename and
  phase write) → continue; `quarantined` with the quarantine gone → remove the
  claim; anything else → preserved, diagnosed.
- Owner dead but a recorded Producer still `live` → an orphaned Producer may
  still use the HOME: preserved, diagnosed.
- Allocation or quarantine directories without a claim are never inferred
  from their name or age: preserved and diagnosed, after re-checking that a
  concurrent owner did not just claim or remove them.
- A leftover claim temporary (`.<id>.claim.<uuid>.tmp`) from a crashed write
  is removed only when it is a plain single-link file older than ten minutes;
  a younger one is left alone, anything else is reported.

Diagnostics are returned as `producerHomeIssues` (redacted reasons), logged
once at server start, and kept out of `worktreeSweepIssues` so a preserved
HOME never gates repository mutation or re-runs recovery per call.

## Consequences and residual limits

- Producer-native sandboxes (Codex) define their own write scope. Their extra
  writable roots are declared on the descriptor (`nativeWritableRoots`; the
  Codex edit lane declares the darwin per-user temp directory) and join the
  placement check, so a state directory under them is refused. Writes the
  native sandbox does not declare cannot be seen by the runtime.
- A Producer grandchild that escapes the supervised tree can still write its
  own HOME until it exits; quarantine moves it out of that pathname first, and
  under Seatbelt the quarantine name is denied.
- A runtime crash between spawn and the claim update leaves a `launching`
  claim that recovery preserves and reports; it is never reclaimed
  automatically.
