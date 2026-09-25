// tests/runtime/gates.test.ts
import { describe, expect, it } from "vitest";
import {
  evaluateGates,
  type GateInput,
  type IncrementOutcome,
} from "../../src/pipeline/gates.js";
import type { Disposition, Finding, VerificationReport } from "../../src/pipeline/report-types.js";

const OID = "a".repeat(40);

function finding(id: string, severity: Finding["severity"]): Finding {
  return { id, severity, reviewers: ["correctness"], location: "src/a.ts:1", claim: "c",
    evidence: "e", reproduction: "r", requiredOutcome: "o", confidence: 0.9 };
}
function fixed(findingId: string): Disposition {
  return { findingId, disposition: "fixed", evidence: "done", commit: OID };
}
function passVerification(overrides: Partial<VerificationReport> = {}): VerificationReport {
  return { reportVersion: "1", pass: true, commandResults: [], workspaceClean: true,
    testsDeleted: 0, testsSkipped: 0, scopeViolations: [], ...overrides };
}
function base(overrides: Partial<GateInput> = {}): GateInput {
  return { findings: [], dispositions: [], verification: passVerification(),
    roundsUsed: 1, maxRounds: 2, finalRoundReviewed: true,
    artifactsValid: true, baselineDrift: false, ...overrides };
}

describe("evaluateGates", () => {
  it("clean run is decision-ready", () => {
    expect(evaluateGates(base())).toEqual({ decisionReady: true, requiresHumanDecision: false, reasons: [] });
  });

  it("routes a non-converging review to a human", () => {
    // A location whose blocking findings outlived a fix round will not be fixed
    // by more rounds. This replaced a check that inferred a contradiction from
    // differently worded outcomes, which halted green, approved candidates.
    const gate = evaluateGates(base({
      nonConvergence: ["blocking findings at src/a.ts:1 survived 2 review rounds despite a fix attempt: F-001"],
    }));
    expect(gate.decisionReady).toBe(false);
    expect(gate.requiresHumanDecision).toBe(true);
    expect(gate.reasons).toEqual([
      "review is not converging: blocking findings at src/a.ts:1 survived 2 review rounds despite a fix attempt: F-001",
    ]);
  });

  it("stays decision-ready when nothing is non-converging", () => {
    expect(evaluateGates(base({ nonConvergence: [] }))).toEqual({
      decisionReady: true,
      requiresHumanDecision: false,
      reasons: [],
    });
  });

  it("keeps the gate result byte-identical when incrementOutcome is absent", () => {
    const beforeIncrementOutcome = { decisionReady: true, requiresHumanDecision: false, reasons: [] };
    expect(JSON.stringify(evaluateGates(base()))).toBe(JSON.stringify(beforeIncrementOutcome));
  });

  it("does not add a gate reason when the increment loop completes", () => {
    expect(evaluateGates(base({ incrementOutcome: "complete" }))).toEqual({
      decisionReady: true,
      requiresHumanDecision: false,
      reasons: [],
    });
  });

  it.each<Exclude<IncrementOutcome, "complete">>([
    "budget-exhausted",
    "stalled",
    "blocked",
  ])("routes a %s increment outcome to human decision", (incrementOutcome) => {
    expect(evaluateGates(base({ incrementOutcome }))).toEqual({
      decisionReady: false,
      requiresHumanDecision: true,
      reasons: [`increment loop ended '${incrementOutcome}' without completion`],
    });
  });

  it("requires human decision when a fixed disposition was not re-reviewed", () => {
    const out = evaluateGates(base({
      findings: [finding("F-001", "blocker")],
      dispositions: [fixed("F-001")],
      finalRoundReviewed: false,
    }));
    expect(out).toEqual({
      decisionReady: false,
      requiresHumanDecision: true,
      reasons: ["final fix was not re-reviewed"],
    });
  });

  it.each<[string, GateInput, boolean]>([
    ["undispositioned blocker", base({ findings: [finding("F-001", "blocker")] }), true],
    ["blocker rejected_with_evidence", base({ findings: [finding("F-001", "blocker")],
      dispositions: [{ findingId: "F-001", disposition: "rejected_with_evidence", evidence: "not a bug" }] }), true],
    ["major marked blocked", base({ findings: [finding("F-001", "major")],
      dispositions: [{ findingId: "F-001", disposition: "blocked", evidence: "needs infra" }] }), true],
    ["fixed blocker missing commit", base({ findings: [finding("F-001", "blocker")],
      dispositions: [{ findingId: "F-001", disposition: "fixed", evidence: "done" }] }), false],
    ["failed verification", base({ verification: passVerification({ pass: false }) }), false],
    ["missing verification (fail closed)", base({ verification: null }), false],
    ["deleted tests", base({ verification: passVerification({ testsDeleted: 1 }) }), false],
    ["newly skipped tests", base({ verification: passVerification({ testsSkipped: 2 }) }), false],
    ["dirty verify worktree", base({ verification: passVerification({ workspaceClean: false }) }), false],
    ["out-of-scope diff", base({ verification: passVerification({ scopeViolations: ["src/forbidden.ts"] }) }), false],
    ["invalid artifact", base({ artifactsValid: false }), false],
    ["baseline drift", base({ baselineDrift: false, ...{ baselineDrift: true } }), false],
    ["round cap exceeded", base({ roundsUsed: 3 }), true],
  ])("%s → not decision-ready (human=%s)", (_name, input, expectHuman) => {
    const out = evaluateGates(input);
    expect(out.decisionReady).toBe(false);
    expect(out.reasons.length).toBeGreaterThan(0);
    expect(out.requiresHumanDecision).toBe(expectHuman);
  });

  it.each(["nit", "minor"] as const)("%s findings never block, even undispositioned", severity => {
    const out = evaluateGates(base({ findings: [finding("F-001", severity)] }));
    expect(out).toEqual({ decisionReady: true, requiresHumanDecision: false, reasons: [] });
  });

  it("fixed blocker with commit + passing verification is decision-ready", () => {
    const out = evaluateGates(base({ findings: [finding("F-001", "blocker")], dispositions: [fixed("F-001")] }));
    expect(out.decisionReady).toBe(true);
  });
});
