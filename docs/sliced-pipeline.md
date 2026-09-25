# Sliced pipeline

Reference for the `slices` array in a Delegation Spec. The delegate skill
points here; the rules below are the contract the runtime enforces.

For a task that decomposes into ordered, independently testable steps, add a
top-level `slices` array to the spec. Each slice is a scoped mini-spec with its
own `objective`, `context`, `writeAllowlist`, `forbiddenScope`,
`successCriteria`, and — required — its own `verification`:

```yaml
slices:
  - objective: Add the parser for the new record type.
    context: The record grammar lives in docs/format.md.
    writeAllowlist: [src/parse/**]
    forbiddenScope: [src/emit/**]
    successCriteria:
      - New record type round-trips through the parser.
    verification:
      - id: parse-tests
        executable: npx
        args: [vitest, run, tests/parse]
        cwd: "."
        timeoutMs: 600000
        network: denied
        expectedExitCodes: [0]
  - objective: Emit the new record type.
    # ...its own scope and verification
```

Slice rules and guarantees:

- Each slice runs **fresh with no context** — a slice implementer sees only its
  own mini-spec, never a prior slice's conversation, and is gated only by its
  own `verification`. Each slice's `writeAllowlist` must be a subset of the
  spec's, and its verification `cwd` must stay inside the candidate root.
- A deterministic wayfinder routes each completed slice **advance / repair /
  halt** from objective gate results — the slice's own `verification`, plus its
  independent per-slice review findings when `review.perSlice` is enabled —
  never from model judgment or a Producer's self-report. A slice that passes
  advances; a slice that fails is repaired within its round budget; a slice that
  cannot be made to pass halts the run.
- Slices run **sequentially by default**. A slice may declare `dependsOn` — the
  1-based indices of the slices it must observe — and the spec may raise
  `sliceConcurrency`. Slices then run together only when their dependencies
  allow it *and* their write allowlists are pairwise disjoint, which is what
  makes composing their results a conflict-free union. Omitting `dependsOn`
  means "after every preceding slice", so an existing spec behaves exactly as
  before.
- Declaring `dependsOn` is a claim about what a slice needs to *see*, not only
  about what it writes. A slice that reads another slice's output depends on it
  even with disjoint allowlists. Nothing detects an under-declared dependency:
  a slice that runs too early is verified against a base without the work it
  needed, and the error surfaces at the composed verification below. Declare
  `dependsOn: []` only when a slice is genuinely independent.
- Review and the advisor judge the **composed candidate** at the end, over the
  whole slice branch, and that composed candidate always faces the spec's full
  `verification` regardless of how the slices were scheduled. Per-slice results
  never substitute for it. Per-slice review is off by default; opt in with
  `review.perSlice: true` to review each slice as it lands.
- A mid-run halt **after at least one slice has advanced** yields a **partial**
  candidate with `status: "human-decision-required"`, the halted slice index in
  `haltedSliceIndex`, and each slice's route in `slices`; the promoted partial
  branch (the advanced slices) is a real candidate the human may accept, reject,
  or revise, and the halted slice's attempts stay in `slices` as evidence. A
  halt on the very first slice, with nothing advanced, is reported `failed` with
  the slice evidence retained — there is no partial branch to accept. Present
  the completed slices, the halt reason, and the partial candidate to the human;
  never accept or continue past a halt on their behalf.
