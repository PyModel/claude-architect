# Sliced Delegation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add architect-authored, test-gated vertical slicing to `delegatePipeline`, so a task can be executed as an ordered sequence of no-context slices whose progression is decided by objective per-slice verification rather than implementer self-report.

**Architecture:** An optional `slices` field on the delegation spec activates a sliced pre-phase in `runPipeline`. Each slice runs a fresh-context implementer in a worktree anchored on the prior slice's frozen output, is frozen, and is gated by its own `verification` commands. A deterministic **wayfinder** routes advance/repair/halt from objective gate results. When all slices advance, the accumulated branch flows through the existing composed-candidate review + final verification + human decision unchanged. A mid-run halt returns `human-decision-required` with a partial candidate.

**Tech Stack:** TypeScript (Node ESM, `.js` import specifiers), Ajv JSON Schema, Vitest, git worktrees via `WorktreeManager`.

## STATUS — T1–T8 complete; shipped in v0.21.0 (updated 2026-07-19)

Built by dogfooding the delegate pipeline (Codex, high effort). Each task independently reviewed/verified; full Vitest suite green after each.

| Task | Status | Commit |
|---|---|---|
| T1 Slice type + `slices`/`perSlice` fields + `resolveSlices` | ✅ done | `2485af3` |
| T2 JSON schema `slices` + `review.perSlice` | ✅ done | `3f85b24` |
| T3 Slice validation (allowlist-subset + cwd-escape) | ✅ done | `8bd267c` |
| T4 Deterministic wayfinder `routeSlice` | ✅ done | `ac15a0f` |
| T5 Pure git-free orchestrator `runSlicePhase` | ✅ done | `156df05` |
| T6 Wire into `runPipeline` (real `runSlice` + partial-halt) | ✅ done | feat branch integration; B1 halt fix `78f0e86` |
| T7 MCP surface + protocol bump `1.2.0`→`1.3.0` | ✅ done | `6e8b608` |
| T8 Skill prose + docs + version sync | ✅ done | `1ae71c6` |

**T5 was redesigned from the original plan below:** it is now a *pure, git-free* orchestrator taking an injected `runSlice(slice, index, base, attempt) => Promise<SliceAttempt>` callback and composing `routeSlice`; fully unit-tested. All git coupling moved to T6. See `src/pipeline/slice-runner.ts` for the real exported shape (`PipelineSlice`, `SliceAttempt`, `SlicePhaseDeps`, `SlicePhaseResult`, `runSlicePhase`).

**T6 was temporarily blocked** by a concurrent session continuously editing the same `pipeline-runtime.ts` (guaranteed conflict) and leaving the shared checkout dirty. Resolved: sliced execution landed on the feat branch (`pipeline-runtime.ts` integration tests) and the partial-halt result contract was corrected in `78f0e86` (advance-then-halt → `human-decision-required` with a promoted verified partial). Shipped in v0.21.0.

### Corrected T6 design (supersedes the stale Task 6 section below)

`runPipeline` unconditionally runs one full-spec initial attempt, then increments, then rounds. Slicing must **replace the initial-attempt + increment model** (it does not "insert before the rounds"):

1. When `resolveSlices(spec).length > 0`, run the initial `runAttemptFn` with a **slice-1-scoped spec** (objective/context/writeAllowlist/forbiddenScope/successCriteria/verification of slice 1; drop `slices`). That establishes runId/store/anchor and freezes slice 1 anchored on HEAD baseline.
2. Verify slice 1 via `verifyCandidate({ spec: slice1Spec, baselineCommit, candidateCommit: slice1Commit })` → `VerificationReport`; route via `routeSlice`. Slice-1 repair = re-run `runAttemptFn` (re-anchors on HEAD) up to `maxRounds`.
3. Slices 2..N via `runSlicePhase(slices.slice(1), slice1Commit, deps)` where the real `runSlice`:
   - runs the implementer with the slice-scoped spec anchored on the prior frozen commit in the **candidate worktree** using the increment machinery (`runIncrement` + `validateCandidateProvenance` + `importPromotedObjects`), **no `progress` note** (no-context);
   - runs `verifyCandidate({ spec: sliceSpec, baselineCommit: base, candidateCommit: frozen })` — note `baselineCommit` is the *prior slice's* commit so scope-checks see only this slice's diff against its own `writeAllowlist`;
   - returns `{ candidateCommit: frozen, verification }`.
   - `onSlice` durability hook writes `store.writePipelineArtifact(\`slice-${index}\`, pipelineSlice)`.
4. On `haltedSliceIndex !== null`: return `status: "human-decision-required"` with the **partial** composed candidate (`finalCandidateCommit` = last advanced slice), the populated `slices`, `haltedSliceIndex`, and halt reasons. Do not enter the review rounds.
5. All advanced → set `currentCandidateCommit = slicePhase.finalCandidateCommit` and fall through to the existing rounds → `verifyCandidate(full spec)` → `evaluateGates` tail unchanged (whole-branch final review).

`PipelineResult` gains `slices: PipelineSlice[]` (default `[]`) and `haltedSliceIndex: number | null` (default `null`); update the interface, `failedResult` (add a param), and the single terminal-result construction. Non-sliced path stays byte-identical. Integration test: model on the git harness in `tests/support/pipeline-runtime-harness.ts` (`dependencies({runId, roleRunner, edit})`, `incrementRoleRunner`, `fakeAttempt`).

**Dogfood bugs found** (regression-test ideas in `scratchpad.md`): leaked repo lock survives because owner is the long-lived MCP server; vitest only collects `tests/runtime/**` (tests elsewhere silently "pass by absence"); false-positive blocking review misreads line numbers and forces a redundant fix round; `reviewCandidate` returns the structural manifest, not the `candidateManifestHash` integration needs; `doctor` reports `issues:[]` while a checkout lock is held.


## Global Constraints

- Spec source of truth precedence: `runtime/schemas/` + `src/protocol/` first, then `src/`, then `tests/`. Update schema, TS types, validators, fixtures, contract tests, protocol marker, and docs together.
- `slices` is **additive and opt-in**: a spec with no `slices` field MUST behave exactly as today. Protocol bump is **minor** (`1.2.0` → `1.3.0`).
- All new external contract fields validate against the canonical schema before use; fail closed on ambiguity.
- Deterministic wayfinder only: routing is derived from objective gate results. No LLM may gate slice progression. Producer/implementer claims are never evidence.
- Only a human accepts the composed (or partial) candidate. The wayfinder recommends; it never accepts.
- Fresh context + fresh worktree per slice and per repair. No conversational/`progress` handoff between slices.
- Every slice's spec, frozen bytes, verification evidence, and route are written as durable pipeline artifacts as they complete.
- Import specifiers use `.js` extensions. Run `npx tsc --noEmit` and `npx vitest run` for every executable change; `bash scripts/validate-release.sh` and `claude plugin validate .` for release-facing work.
- **No AI co-author trailers or generated-by footers on any commit.**
- Packaged `runtime/` output must be regenerated from source and stay reproducible.

---

## File Structure

- `src/protocol/delegation-spec.ts` — add `Slice` type, `slices?` on `DelegationSpec`, `perSlice?` on `ReviewConfig`, `resolveSlices` helper.
- `runtime/schemas/delegation-spec.v1.json` — add `slices` array schema + `review.perSlice`.
- `src/protocol/spec-validator.ts` — slice-specific semantic validation (allowlist subset, ordering, cwd escape per slice command).
- `src/pipeline/wayfinder.ts` — **new** pure module: `routeSlice(input): SliceGateResult`.
- `src/pipeline/slice-runner.ts` — **new**: `runSlicePhase(...)` sequential slice loop reusing attempt/verify machinery.
- `src/pipeline/pipeline-runtime.ts` — call `runSlicePhase` before the review rounds; extend `PipelineResult` with `slices` + `haltedSliceIndex`.
- `src/pipeline/report-types.ts` — `SliceRoute`, `PipelineSlice` types (or co-locate in slice-runner and re-export).
- `skills/delegate/SKILL.md` — protocol marker bump + sliced-pipeline prose.
- Tests under `tests/` (contract + integration) as specified per task.
- `CHANGELOG.md`, `README.md` version badge, `tests/runtime/plugin-wiring.test.mjs`, `.claude-plugin/*.json` — version sync (release task).

Each task ends with an independently testable deliverable and a commit.

---

### Task 1: Slice type + spec fields (TypeScript)

**Files:**
- Modify: `src/protocol/delegation-spec.ts`
- Test: `tests/runtime/protocol/slice-types.test.ts` (create)

**Interfaces:**
- Consumes: existing `VerificationCommand`, `DelegationSpec`, `ReviewConfig`.
- Produces:
  - `interface Slice { objective: string; context: string; writeAllowlist: string[]; forbiddenScope: string[]; successCriteria: string[]; verification: VerificationCommand[]; }`
  - `DelegationSpec.slices?: Slice[]`
  - `ReviewConfig.perSlice?: boolean`
  - `function resolveSlices(spec: DelegationSpec): Slice[]` — returns `spec.slices ?? []`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/runtime/protocol/slice-types.test.ts
import { describe, it, expect } from "vitest";
import { resolveSlices } from "../../../src/protocol/delegation-spec.js";
import type { DelegationSpec } from "../../../src/protocol/delegation-spec.js";

const base = {
  specVersion: "1", objective: "x", context: "", writeAllowlist: ["**"],
  forbiddenScope: [], successCriteria: ["c"], verification: [],
  executionMode: "edit", timeoutMs: 600000, producerPreferences: ["codex"],
  expectedOutput: "candidate-patch",
} as unknown as DelegationSpec;

describe("resolveSlices", () => {
  it("returns [] when slices is absent", () => {
    expect(resolveSlices(base)).toEqual([]);
  });
  it("returns the slices array when present", () => {
    const spec = { ...base, slices: [{ objective: "s1", context: "", writeAllowlist: ["a/**"], forbiddenScope: [], successCriteria: ["c1"], verification: [] }] } as DelegationSpec;
    expect(resolveSlices(spec)).toHaveLength(1);
    expect(resolveSlices(spec)[0].objective).toBe("s1");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/runtime/protocol/slice-types.test.ts`
Expected: FAIL — `resolveSlices` is not exported.

- [ ] **Step 3: Add the types and helper**

In `src/protocol/delegation-spec.ts`, after `VerificationCommand`:

```ts
export interface Slice {
  objective: string;                   // one observable outcome for this chunk
  context: string;                     // durable context a fresh implementer needs
  writeAllowlist: string[];            // subset of the spec-level allowlist
  forbiddenScope: string[];
  successCriteria: string[];
  verification: VerificationCommand[]; // the "till test" gate; must be non-empty
}
```

Add `perSlice?: boolean;` to `ReviewConfig` and `slices?: Slice[];` to `DelegationSpec` (place `slices` after `implementation?`). Then:

```ts
export function resolveSlices(spec: DelegationSpec): Slice[] {
  return spec.slices ?? [];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/runtime/protocol/slice-types.test.ts` — Expected: PASS.
Run: `npx tsc --noEmit` — Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/protocol/delegation-spec.ts tests/runtime/protocol/slice-types.test.ts
git commit -m "feat(protocol): add Slice type and slices/perSlice spec fields"
```

---

### Task 2: Slice JSON schema (canonical + packaged)

**Files:**
- Modify: `runtime/schemas/delegation-spec.v1.json`
- Test: `tests/runtime/protocol/slice-schema.test.ts` (create)

**Interfaces:**
- Consumes: `loadSchemas().delegationSpec` (Ajv validator over the canonical schema).
- Produces: schema accepts `slices` (array of slice objects) and `review.perSlice` (boolean); rejects a slice missing `verification` or with empty `verification`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/runtime/protocol/slice-schema.test.ts
import { describe, it, expect } from "vitest";
import { loadSchemas } from "../../../src/protocol/schema-loader.js";

const schemas = loadSchemas();
const base = {
  specVersion: "1", objective: "x", context: "", writeAllowlist: ["**"],
  forbiddenScope: [], successCriteria: ["c"],
  verification: [{ id: "v", executable: "node", args: ["-v"], cwd: ".", timeoutMs: 1000, network: "denied", expectedExitCodes: [0] }],
  executionMode: "edit", timeoutMs: 600000, producerPreferences: ["codex"], expectedOutput: "candidate-patch",
};
const sliceVerif = [{ id: "sv", executable: "node", args: ["-v"], cwd: ".", timeoutMs: 1000, network: "denied", expectedExitCodes: [0] }];

describe("delegation-spec schema: slices", () => {
  it("accepts a valid slices array and review.perSlice", () => {
    const spec = { ...base, review: { reviewers: ["correctness"], maxRounds: 1, perSlice: true },
      slices: [{ objective: "s", context: "", writeAllowlist: ["a/**"], forbiddenScope: [], successCriteria: ["c"], verification: sliceVerif }] };
    expect(schemas.delegationSpec(spec)).toBe(true);
  });
  it("rejects a slice with empty verification", () => {
    const spec = { ...base, slices: [{ objective: "s", context: "", writeAllowlist: ["a/**"], forbiddenScope: [], successCriteria: ["c"], verification: [] }] };
    expect(schemas.delegationSpec(spec)).toBe(false);
  });
  it("still accepts a spec with no slices field", () => {
    expect(schemas.delegationSpec(base)).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/runtime/protocol/slice-schema.test.ts`
Expected: FAIL — schema has `additionalProperties: false`, so `slices`/`perSlice` are rejected (first test fails).

- [ ] **Step 3: Extend the schema**

In `runtime/schemas/delegation-spec.v1.json`:
1. Under `review.properties`, add: `"perSlice": { "type": "boolean" }`.
2. Under top-level `properties`, add a `slices` definition. Each slice item reuses the same command object shape as `verification.items` and requires a non-empty `verification`:

```json
"slices": {
  "type": "array",
  "items": {
    "type": "object",
    "additionalProperties": false,
    "required": ["objective", "context", "writeAllowlist", "forbiddenScope", "successCriteria", "verification"],
    "properties": {
      "objective": { "type": "string", "minLength": 1 },
      "context": { "type": "string" },
      "writeAllowlist": { "type": "array", "items": { "type": "string" }, "minItems": 1 },
      "forbiddenScope": { "type": "array", "items": { "type": "string" } },
      "successCriteria": { "type": "array", "items": { "type": "string", "minLength": 1 }, "minItems": 1 },
      "verification": { "$ref": "#/properties/verification" }
    }
  },
  "minItems": 1
}
```

Note: `#/properties/verification` already enforces `minItems: 1` and the full command shape, so an empty slice `verification` is rejected. Do NOT add `slices` to the top-level `required` array.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/runtime/protocol/slice-schema.test.ts` — Expected: PASS (all three).

- [ ] **Step 5: Commit**

```bash
git add runtime/schemas/delegation-spec.v1.json tests/runtime/protocol/slice-schema.test.ts
git commit -m "feat(schema): add slices and review.perSlice to delegation spec v1"
```

---

### Task 3: Slice semantic validation (allowlist subset + cwd escape)

**Files:**
- Modify: `src/protocol/spec-validator.ts`
- Test: `tests/runtime/protocol/slice-validation.test.ts` (create)

**Interfaces:**
- Consumes: `validateSpec(input): ValidateResult`, `resolveSlices`.
- Produces: `validateSpec` returns `ok:false` when (a) a slice `writeAllowlist` glob is not covered by the top-level `writeAllowlist`, or (b) a slice verification command `cwd` escapes the checkout. Error `path` uses `/slices/<i>/writeAllowlist/<j>` or `/slices/<i>/verification/<k>/cwd`.

**Subset rule (explicit, deterministic):** a slice glob `g` is covered if the top-level allowlist contains `**`, or contains `g` verbatim, or contains a prefix glob `p/**` where `g === p` or `g` starts with `p + "/"`. This is a conservative textual containment check — no filesystem access.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/runtime/protocol/slice-validation.test.ts
import { describe, it, expect } from "vitest";
import { validateSpec } from "../../../src/protocol/spec-validator.js";

const cmd = { id: "v", executable: "node", args: ["-v"], cwd: ".", timeoutMs: 1000, network: "denied", expectedExitCodes: [0] };
const base = {
  specVersion: "1", objective: "x", context: "", writeAllowlist: ["src/**"],
  forbiddenScope: [], successCriteria: ["c"], verification: [cmd],
  executionMode: "edit", timeoutMs: 600000, producerPreferences: ["codex"], expectedOutput: "candidate-patch",
};

describe("validateSpec: slices", () => {
  it("accepts a slice whose allowlist is within the top-level allowlist", () => {
    const spec = { ...base, slices: [{ objective: "s", context: "", writeAllowlist: ["src/a/**"], forbiddenScope: [], successCriteria: ["c"], verification: [cmd] }] };
    expect(validateSpec(spec).ok).toBe(true);
  });
  it("rejects a slice that widens write scope", () => {
    const spec = { ...base, slices: [{ objective: "s", context: "", writeAllowlist: ["tests/**"], forbiddenScope: [], successCriteria: ["c"], verification: [cmd] }] };
    const r = validateSpec(spec);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0].path).toBe("/slices/0/writeAllowlist/0");
  });
  it("rejects a slice verification cwd that escapes the checkout", () => {
    const spec = { ...base, slices: [{ objective: "s", context: "", writeAllowlist: ["src/a/**"], forbiddenScope: [], successCriteria: ["c"], verification: [{ ...cmd, cwd: "../etc" }] }] };
    const r = validateSpec(spec);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0].path).toBe("/slices/0/verification/0/cwd");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/runtime/protocol/slice-validation.test.ts`
Expected: FAIL — the widening and escaping cases currently pass schema validation and return `ok:true`.

- [ ] **Step 3: Add semantic checks**

In `src/protocol/spec-validator.ts`, inside the `if (schemaValid)` block, AFTER the existing top-level `verification` cwd loop and BEFORE `return { ok: true, spec }`, add slice checks. Add this helper above `validateSpec`:

```ts
function allowlistCovers(top: string[], glob: string): boolean {
  for (const p of top) {
    if (p === "**" || p === glob) return true;
    if (p.endsWith("/**")) {
      const prefix = p.slice(0, -3); // drop "/**"
      if (glob === prefix || glob.startsWith(prefix + "/")) return true;
    }
  }
  return false;
}
```

Then in the block:

```ts
    for (const [i, slice] of (spec.slices ?? []).entries()) {
      for (const [j, glob] of slice.writeAllowlist.entries()) {
        if (!allowlistCovers(spec.writeAllowlist, glob)) {
          return { ok: false, errors: [{ path: `/slices/${i}/writeAllowlist/${j}`,
            message: "slice writeAllowlist glob must be within the spec writeAllowlist" }] };
        }
      }
      for (const [k, command] of slice.verification.entries()) {
        const normalizedCwd = path.posix.normalize(command.cwd);
        if (path.isAbsolute(command.cwd) || normalizedCwd === ".." || normalizedCwd.startsWith("../")) {
          return { ok: false, errors: [{ path: `/slices/${i}/verification/${k}/cwd`,
            message: "must be a repository-relative path that does not escape the checkout" }] };
        }
      }
    }
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/runtime/protocol/slice-validation.test.ts` — Expected: PASS.
Run: `npx tsc --noEmit` — Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/protocol/spec-validator.ts tests/runtime/protocol/slice-validation.test.ts
git commit -m "feat(protocol): validate slice allowlist subset and cwd escape"
```

---

### Task 4: Deterministic wayfinder (pure routing)

**Files:**
- Create: `src/pipeline/wayfinder.ts`
- Test: `tests/runtime/pipeline/wayfinder.test.ts` (create)

**Interfaces:**
- Consumes: `VerificationReport` from `./report-types.js`, `ConsolidationResult` from `./consolidator.js` (only when `perSlice` review is enabled — pass `null` otherwise).
- Produces:
  - `type SliceRoute = "advance" | "repair" | "halt"`
  - `interface SliceGateInput { verification: VerificationReport | null; perSliceReview: ConsolidationResult | null; roundsUsed: number; maxRounds: number; hardBlocker: boolean; }`
  - `interface SliceGateResult { route: SliceRoute; reasons: string[]; }`
  - `function routeSlice(input: SliceGateInput): SliceGateResult`

**Routing rules (in order):**
1. `hardBlocker` true → `halt` (reason: "unrecoverable blocker").
2. verification `null` → treat as failed gate (fail closed).
3. gate green = `verification.pass === true` AND `testsDeleted === 0` AND `testsSkipped === 0` AND `workspaceClean === true` AND `scopeViolations.length === 0` AND (when `perSliceReview` present) no `blocker`/`major` finding. Green → `advance`.
4. gate red AND `roundsUsed < maxRounds` → `repair`.
5. gate red AND `roundsUsed >= maxRounds` → `halt`.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/runtime/pipeline/wayfinder.test.ts
import { describe, it, expect } from "vitest";
import { routeSlice } from "../../../src/pipeline/wayfinder.js";
import type { VerificationReport } from "../../../src/pipeline/report-types.js";

const green: VerificationReport = { pass: true, testsDeleted: 0, testsSkipped: 0, workspaceClean: true, scopeViolations: [] } as VerificationReport;
const red: VerificationReport = { ...green, pass: false };

describe("routeSlice", () => {
  it("advances on a green gate", () => {
    expect(routeSlice({ verification: green, perSliceReview: null, roundsUsed: 0, maxRounds: 2, hardBlocker: false }).route).toBe("advance");
  });
  it("repairs a red gate with rounds remaining", () => {
    expect(routeSlice({ verification: red, perSliceReview: null, roundsUsed: 0, maxRounds: 2, hardBlocker: false }).route).toBe("repair");
  });
  it("halts a red gate with rounds exhausted", () => {
    expect(routeSlice({ verification: red, perSliceReview: null, roundsUsed: 2, maxRounds: 2, hardBlocker: false }).route).toBe("halt");
  });
  it("halts immediately on a hard blocker", () => {
    expect(routeSlice({ verification: green, perSliceReview: null, roundsUsed: 0, maxRounds: 2, hardBlocker: true }).route).toBe("halt");
  });
  it("fails closed when verification is null", () => {
    expect(routeSlice({ verification: null, perSliceReview: null, roundsUsed: 2, maxRounds: 2, hardBlocker: false }).route).toBe("halt");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/runtime/pipeline/wayfinder.test.ts` — Expected: FAIL — module not found.

- [ ] **Step 3: Implement the wayfinder**

```ts
// src/pipeline/wayfinder.ts
import type { VerificationReport } from "./report-types.js";
import type { ConsolidationResult } from "./consolidator.js";

export type SliceRoute = "advance" | "repair" | "halt";

export interface SliceGateInput {
  verification: VerificationReport | null;
  perSliceReview: ConsolidationResult | null;
  roundsUsed: number;
  maxRounds: number;
  hardBlocker: boolean;
}

export interface SliceGateResult {
  route: SliceRoute;
  reasons: string[];
}

export function routeSlice(input: SliceGateInput): SliceGateResult {
  const reasons: string[] = [];
  if (input.hardBlocker) return { route: "halt", reasons: ["unrecoverable blocker"] };

  const v = input.verification;
  if (v === null) reasons.push("verification report missing (fail closed)");
  else {
    if (!v.pass) reasons.push("slice verification failed");
    if (v.testsDeleted > 0) reasons.push(`${v.testsDeleted} test(s) deleted`);
    if (v.testsSkipped > 0) reasons.push(`${v.testsSkipped} test(s) newly skipped`);
    if (!v.workspaceClean) reasons.push("verify worktree dirty after checks");
    if (v.scopeViolations.length > 0) reasons.push(`out-of-scope diff: ${v.scopeViolations.join(", ")}`);
  }
  if (input.perSliceReview) {
    const blocking = input.perSliceReview.findings.some(
      f => f.severity === "blocker" || f.severity === "major",
    );
    if (blocking) reasons.push("per-slice review found blocking findings");
  }

  if (reasons.length === 0) return { route: "advance", reasons };
  if (input.roundsUsed < input.maxRounds) return { route: "repair", reasons };
  return { route: "halt", reasons };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/runtime/pipeline/wayfinder.test.ts` — Expected: PASS (all five).
Run: `npx tsc --noEmit` — Expected: no errors.

> Note: confirm the exact field names on `VerificationReport` and `ConsolidationResult` by reading `src/pipeline/report-types.ts` and `src/pipeline/consolidator.ts` before writing Step 3; the field set above mirrors the existing checks in `src/pipeline/gates.ts` (`v.pass`, `v.testsDeleted`, `v.testsSkipped`, `v.workspaceClean`, `v.scopeViolations`). If a name differs, update both the test and the implementation.

- [ ] **Step 5: Commit**

```bash
git add src/pipeline/wayfinder.ts tests/runtime/pipeline/wayfinder.test.ts
git commit -m "feat(pipeline): add deterministic per-slice wayfinder router"
```

---

### Task 5: Slice runner (sequential no-context slice loop)

**Files:**
- Create: `src/pipeline/slice-runner.ts`
- Modify: `src/pipeline/pipeline-runtime.ts` (call the runner; extend result types)
- Test: `tests/runtime/pipeline/slice-runner.test.ts` (create)

**Read before implementing:** `runIncrement` (`src/pipeline/pipeline-runtime.ts:480`), the increment loop (`:791-924`), `verifyCandidate` usage (`:1125`), `defaultRunAttempt`, `ArtifactStore.writePipelineArtifact`, `WorktreeManager`, `resolveLinkedWorktreeWritableRoots`, `importPromotedObjects`, `validateCandidateProvenance`. The slice loop mirrors the increment loop's git-object isolation and promotion, with two differences: (1) each slice's implementer receives the slice's own scoped spec with **no `progress` field**; (2) progression is decided by `routeSlice` over that slice's verification, not by a self-reported `status`.

**Interfaces:**
- Consumes: `DelegationSpec`, `resolveSlices`, `resolveReviewConfig`, `routeSlice`, `PipelineDependencies`, `ArtifactStore`, the attempt/verify helpers above.
- Produces:
  - `interface PipelineSlice { index: number; objective: string; route: SliceRoute; candidateCommit: string; roundsUsed: number; verification: VerificationReport | null; reasons: string[]; roleLogRefs: string[]; }`
  - `interface SlicePhaseResult { slices: PipelineSlice[]; finalCandidateCommit: string; haltedSliceIndex: number | null; }`
  - `async function runSlicePhase(args: { checkoutPath: string; spec: DelegationSpec; deps: PipelineDependencies; store: ArtifactStore; runId: string; baselineCommit: string; startCommit: string; worktreePath: string; gitObjectAccess: LinkedWorktreeGitAccess; }): Promise<SlicePhaseResult>`

**Behavior:**
- Build a scoped `DelegationSpec` per slice: copy the parent spec, replace `objective`, `context`, `writeAllowlist`, `forbiddenScope`, `successCriteria`, `verification` with the slice's; drop `slices`; carry `executionMode`, `timeoutMs`, `producerPreferences`, `producerOverrides`, `expectedOutput`.
- For slice N: run the implementer (reuse the same producer path `runIncrement`/`defaultRunAttempt` uses) anchored on the current commit with **no progress note**; freeze; run `verifyCandidate` with the slice-scoped spec to produce a `VerificationReport`; call `routeSlice`.
  - `advance` → promote the slice commit into the shared object store (as the increment loop does at `:874-892`), set `currentCommit`, push `PipelineSlice`, continue.
  - `repair` → re-run the slice implementer fresh (increment `roundsUsed`), up to `resolveReviewConfig(spec).maxRounds`; re-verify; re-route.
  - `halt` → record the slice with `route:"halt"`, set `haltedSliceIndex = N`, stop the loop.
- Write a durable artifact per slice: `store.writePipelineArtifact(\`slice-${N}\`, pipelineSlice)` on every terminal route for that slice.
- Return the accumulated `currentCommit` as `finalCandidateCommit` and `haltedSliceIndex` (null if all advanced).

- [ ] **Step 1: Write the failing test (routing integration, deps injected)**

Model this test on the existing pipeline tests (find one that constructs `PipelineDependencies` with a fake `runAttempt`/`roleRunner` — e.g. under `tests/runtime/pipeline/`). Inject a fake implementer that produces a known commit and a fake verifier returning green for slice 1 and red for slice 2, and assert:

```ts
// tests/runtime/pipeline/slice-runner.test.ts (skeleton — fill deps from an existing pipeline test's harness)
import { describe, it, expect } from "vitest";
import { runSlicePhase } from "../../../src/pipeline/slice-runner.js";
// import the shared fake-deps builder used by other tests in tests/runtime/pipeline/

describe("runSlicePhase", () => {
  it("advances slice 1, halts slice 2 when its gate stays red past maxRounds", async () => {
    // Arrange: two slices; fake verify => green for slice 1, red for slice 2.
    // maxRounds = 1 so slice 2 halts after one repair.
    const result = await runSlicePhase(/* args with injected deps */);
    expect(result.slices[0].route).toBe("advance");
    expect(result.slices[1].route).toBe("halt");
    expect(result.haltedSliceIndex).toBe(2);
  });
});
```

> If constructing a real git harness is heavy, prefer factoring the verify + route decision into a thin injectable seam so this test exercises the loop's routing without a real worktree, and cover the real git promotion in the Task 6 integration test.

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/runtime/pipeline/slice-runner.test.ts` — Expected: FAIL — module not found.

- [ ] **Step 3: Implement `runSlicePhase`**

Write `src/pipeline/slice-runner.ts` following the Behavior spec above, reusing the increment loop's git-isolation/promotion helpers (imported from `pipeline-runtime.ts` — export them if currently module-private, or move the shared helpers into a small `src/pipeline/candidate-promotion.ts` and import from both). Keep the module focused: slice scoping + the loop + `routeSlice` calls + artifact writes. Do not duplicate the review-rounds logic — that stays in `pipeline-runtime.ts`.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/runtime/pipeline/slice-runner.test.ts` — Expected: PASS.
Run: `npx tsc --noEmit` — Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/pipeline/slice-runner.ts tests/runtime/pipeline/slice-runner.test.ts src/pipeline/*.ts
git commit -m "feat(pipeline): add sequential test-gated slice runner"
```

---

### Task 6: Wire slices into runPipeline + partial-halt result

**Files:**
- Modify: `src/pipeline/pipeline-runtime.ts`
- Test: `tests/runtime/pipeline/sliced-pipeline.test.ts` (create)

**Interfaces:**
- Consumes: `runSlicePhase`, `resolveSlices`.
- Produces: `PipelineResult` gains `slices: PipelineSlice[]` and `haltedSliceIndex: number | null`. When `resolveSlices(spec).length > 0`:
  - The slice phase runs **before** the review rounds, replacing the increment loop for that run (slices and increments are mutually exclusive: if `slices` is present, ignore `maxIncrements`).
  - If the slice phase halts, `runPipeline` returns `status: "human-decision-required"` with the partial candidate (`finalCandidateCommit` = last advanced slice's commit), the populated `slices`, `haltedSliceIndex`, and gate `reasons` from the halted slice. It does NOT run the composed review rounds.
  - If all slices advance, execution falls through to the existing review-rounds + `verifyCandidate` + `evaluateGates` tail unchanged, operating on the composed candidate.

**Behavior notes:**
- `PipelineResult.slices` defaults to `[]` and `haltedSliceIndex` to `null` on the non-sliced path (keep today's behavior byte-identical — add the fields to every `PipelineResult` construction site, including `failedResult`).
- The composed final review still covers the whole branch (`baselineCommit..finalCandidateCommit`), satisfying the "final review = whole branch" invariant.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/runtime/pipeline/sliced-pipeline.test.ts (fill deps from the shared pipeline test harness)
import { describe, it, expect } from "vitest";
import { runPipeline } from "../../../src/pipeline/pipeline-runtime.js";

describe("runPipeline with slices", () => {
  it("non-sliced spec behaves as today and returns slices: [] / haltedSliceIndex: null", async () => {
    const result = await runPipeline(/* checkout */, /* spec without slices */, /* deps */);
    expect(result.slices).toEqual([]);
    expect(result.haltedSliceIndex).toBeNull();
  });
  it("returns human-decision-required with a partial candidate when a slice halts", async () => {
    const result = await runPipeline(/* checkout */, /* 2-slice spec, slice 2 gate stays red */, /* deps */);
    expect(result.status).toBe("human-decision-required");
    expect(result.haltedSliceIndex).toBe(2);
    expect(result.slices[0].route).toBe("advance");
  });
  it("runs composed review then decision-ready when all slices advance", async () => {
    const result = await runPipeline(/* checkout */, /* 2-slice spec all green */, /* deps: reviews approve */);
    expect(result.haltedSliceIndex).toBeNull();
    expect(["decision-ready", "human-decision-required"]).toContain(result.status);
    expect(result.slices).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/runtime/pipeline/sliced-pipeline.test.ts` — Expected: FAIL — `slices`/`haltedSliceIndex` absent on `PipelineResult`.

- [ ] **Step 3: Implement the wiring**

1. Add `slices: PipelineSlice[]` and `haltedSliceIndex: number | null` to `PipelineResult` (`src/pipeline/pipeline-runtime.ts:67`). Import `PipelineSlice`/`runSlicePhase` from `./slice-runner.js`.
2. Update `failedResult` and every result-construction site to include `slices: []` (or the accumulated slices where available) and `haltedSliceIndex: null`.
3. In `runPipeline`, after establishing `candidateWorktree`/`gitObjectAccess`, branch: if `resolveSlices(spec).length > 0`, call `runSlicePhase(...)` INSTEAD of the `maxIncrements` loop. Set `currentCandidateCommit = slicePhase.finalCandidateCommit`. If `slicePhase.haltedSliceIndex !== null`, build and return a `human-decision-required` result with the partial candidate + `slices` + `haltedSliceIndex` (do not enter the rounds loop). Otherwise continue into the existing rounds tail, carrying `slices` into the final result.
4. Thread `slices`/`haltedSliceIndex` into the terminal `PipelineResult` returned at the end of the rounds/verify/gate tail.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/runtime/pipeline/sliced-pipeline.test.ts` — Expected: PASS.
Run: `npx vitest run` — Expected: full suite green (confirms non-sliced path unchanged).
Run: `npx tsc --noEmit` — Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/pipeline/pipeline-runtime.ts tests/runtime/pipeline/sliced-pipeline.test.ts
git commit -m "feat(pipeline): run test-gated slices before composed review with partial-halt handoff"
```

---

### Task 7: MCP surface + protocol marker bump

**Files:**
- Modify: the `delegatePipeline` MCP handler in `src/mcp/` (find via `grep -rl "delegatePipeline" src/mcp/`)
- Modify: `skills/delegate/SKILL.md` (protocol marker only in this task)
- Test: the MCP contract test that covers `delegatePipeline` input/output (find via `grep -rln "delegatePipeline" tests/`)

**Interfaces:**
- Consumes: `validateSpec`, `runPipeline` (now slices-aware), `PROTOCOL_VERSION`.
- Produces: the MCP handler accepts a spec containing `slices`, passes it through validation unchanged, and returns the pipeline evidence bundle including `slices` + `haltedSliceIndex`. Protocol version advertised is `1.3.0`.

- [ ] **Step 1: Write/extend the failing contract test**

Add a case asserting that a `delegatePipeline` call with a valid `slices` spec is accepted and its result payload includes `slices` and `haltedSliceIndex`. Assert the handler rejects a slices spec that widens write scope (surfacing the Task 3 validation error) with a structured `validationErrors` payload.

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run <that contract test file>` — Expected: FAIL until the handler forwards the new fields.

- [ ] **Step 3: Implement**

Ensure the handler does not strip `slices` (thin, validated pass-through — the handler must not re-shape the spec). Include `slices`/`haltedSliceIndex` in the serialized result. In `skills/delegate/SKILL.md`, bump the marker:

```
```claude-architect-protocol
PROTOCOL_VERSION: 1.3.0
```
```

Update any runtime compatibility check that compares against `1.2.0` to accept `1.3.0` (find via `grep -rn "1.2.0" src/`).

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run` — Expected: full suite green.
Run: `npx tsc --noEmit` — Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/mcp src/protocol skills/delegate/SKILL.md tests
git commit -m "feat(mcp): accept sliced pipeline specs and bump protocol to 1.3.0"
```

---

### Task 8: Skill prose, docs, changelog, version sync (release-facing)

**Files:**
- Modify: `skills/delegate/SKILL.md` (sliced-pipeline prose)
- Modify: `CHANGELOG.md`, `README.md` (version badge), `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`, `tests/runtime/plugin-wiring.test.mjs`
- Test: `tests/runtime/plugin-wiring.test.mjs` (version assertions)

**Interfaces:**
- Consumes: the shipped behavior from Tasks 1–7.
- Produces: user-facing docs describe when to add `slices`, the no-context guarantee, the deterministic wayfinder, the per-slice verification-only default with `review.perSlice` opt-in, and the partial-halt handoff. All version surfaces advance to the next **minor** marketplace version together.

- [ ] **Step 1: Update the skill prose**

In `skills/delegate/SKILL.md`, add a "Sliced pipeline" subsection under the pipeline lifecycle: how to author `slices` (each a scoped mini-spec ending in its own `verification`), that slices run fresh with no context and are gated by their own tests, that the wayfinder routes advance/repair/halt deterministically, that review + advisor judge the composed candidate at the end (per-slice review only when `review.perSlice: true`), and that a mid-run halt yields a partial `human-decision-required` candidate the human decides.

- [ ] **Step 2: Bump every version surface together**

Advance the marketplace **minor** version (e.g. `0.20.0` → `0.21.0`) in `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`, the `README.md` badge, and `tests/runtime/plugin-wiring.test.mjs`. Add a `CHANGELOG.md` entry under the new version describing sliced delegation.

- [ ] **Step 3: Run the release validators**

Run: `npx tsc --noEmit`
Run: `npx vitest run`
Run: `bash scripts/validate-release.sh`
Run: `claude plugin validate .`
Expected: all pass; version surfaces consistent.

- [ ] **Step 4: Regenerate packaged runtime if source drove changes**

Confirm `runtime/` reflects source (the schema was edited directly in `runtime/schemas/`; verify no generated drift). Run whatever build/pack step `scripts/validate-release.sh` expects; re-run it green.

- [ ] **Step 5: Commit**

```bash
git add skills/delegate/SKILL.md CHANGELOG.md README.md .claude-plugin tests/runtime/plugin-wiring.test.mjs runtime
git commit -m "docs(delegate): document sliced pipeline and release version sync"
```

---

## Self-Review

**Spec coverage** — every spec section maps to a task:
- Slice mini-spec + fields → Tasks 1, 2. Validation (subset/non-empty/cwd) → Tasks 2, 3.
- Execution model (fresh, no-context, anchored, freeze) → Task 5. Wayfinder (deterministic advance/repair/halt) → Task 4, invoked in Task 5.
- Verification-only default + `review.perSlice` knob → Task 4 (`perSliceReview` seam) + Task 1 (`perSlice` field); default is off since the field is optional.
- Composed candidate + advisor/final review → Task 6 (falls through to existing tail unchanged).
- Partial candidate at halt + durability artifacts → Tasks 5 (per-slice artifacts) + 6 (partial result).
- "No context" precise definition → Task 5 (no `progress` note; slice carries `context`).
- Schema/protocol change surface + MVP sequencing → Tasks 2, 7, 8.

**Placeholder scan** — runtime Tasks 5/6 intentionally reference existing functions by exact path/line rather than reproducing their bodies (git-isolation/promotion helpers), because the deliverable is *reusing* them; the loop logic, interfaces, and tests are fully specified. Tasks 1–4 are fully coded. No "TBD/TODO/handle edge cases" left.

**Type consistency** — `Slice`, `SliceRoute`, `SliceGateInput`/`SliceGateResult`, `PipelineSlice`, `SlicePhaseResult`, `runSlicePhase`, `routeSlice`, `resolveSlices`, `allowlistCovers` are named identically across the tasks that define and consume them. `PipelineResult` additions (`slices`, `haltedSliceIndex`) are consistent between Tasks 5 and 6.

**Open item flagged for the implementer:** confirm `VerificationReport` / `ConsolidationResult` field names against `report-types.ts` / `consolidator.ts` before Task 4 Step 3 (noted inline).
