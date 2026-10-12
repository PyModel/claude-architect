// tests/runtime/consolidator.test.ts
import { describe, expect, it } from "vitest";
import { consolidate, detectNonConvergence } from "../../src/pipeline/consolidator.js";
import type { FindingSeverity, RawFinding, ReviewReport } from "../../src/pipeline/report-types.js";

function finding(overrides: Partial<RawFinding>): RawFinding {
  return {
    severity: "minor", location: "src/a.ts:10", claim: "off-by-one in loop bound",
    evidence: "loop runs to <= n", reproduction: "n=0", requiredOutcome: "use < n",
    confidence: 0.8, ...overrides,
  };
}
function report(findings: RawFinding[]): ReviewReport {
  return { reportVersion: "1", verdict: findings.length ? "request-changes" : "approve", findings, coverageGaps: [] };
}

describe("consolidate", () => {
  it("dedupes identical findings across reviewers, preserving highest severity", () => {
    const out = consolidate([
      { reviewer: "correctness", report: report([finding({ severity: "major" })]) },
      { reviewer: "systems", report: report([finding({ severity: "blocker", claim: "  OFF-BY-ONE in loop bound " })]) },
    ]);
    expect(out.findings).toHaveLength(1);
    expect(out.findings[0]!.severity).toBe("blocker");
    expect(out.findings[0]!.reviewers.sort()).toEqual(["correctness", "systems"]);
  });

  it("assigns stable sequential ids ordered by severity then location", () => {
    const out = consolidate([
      { reviewer: "correctness", report: report([
        finding({ location: "src/z.ts:1", severity: "nit", claim: "typo" }),
        finding({ location: "src/a.ts:5", severity: "blocker", claim: "crash on null" }),
      ])},
    ]);
    expect(out.findings.map((f) => [f.id, f.severity])).toEqual([
      ["F-001", "blocker"],
      ["F-002", "nit"],
    ]);
  });

  it("is deterministic regardless of reviewer input order", () => {
    const a = { reviewer: "correctness", report: report([finding({ claim: "x" }), finding({ claim: "y", location: "src/b.ts:2" })]) };
    const b = { reviewer: "systems", report: report([finding({ claim: "z", location: "src/c.ts:3" })]) };
    expect(consolidate([a, b])).toEqual(consolidate([b, a]));
  });

  // Differently-worded outcomes at one location are usually complementary, and a
  // nit beside a major differs textually by construction. Inferring conflict from
  // that halted candidates that were independently green and reviewer-approved,
  // so a single round no longer yields a halt signal at all.
  it("does not infer a conflict from differently worded outcomes at one location", () => {
    const out = consolidate([
      { reviewer: "correctness", report: report([finding({ claim: "missing null check", requiredOutcome: "guard the argument" })]) },
      { reviewer: "systems", report: report([finding({ claim: "name is unclear", severity: "nit", requiredOutcome: "rename to itemCount" })]) },
    ]);
    expect(out.findings).toHaveLength(2);
    expect(out).not.toHaveProperty("contradictions");
  });

  describe("detectNonConvergence", () => {
    const at = (location: string, id: string, severity: FindingSeverity = "major") => ({
      ...finding({ severity, location }),
      id,
      reviewers: ["correctness"],
    });

    it("reports a blocking location that outlived a fix round", () => {
      const reasons = detectNonConvergence([
        { round: 1, findings: [at("src/a.ts:10", "F-001")], fixAttempted: true },
        { round: 2, findings: [at("src/a.ts:10", "F-001")], fixAttempted: false },
      ]);
      expect(reasons).toHaveLength(1);
      expect(reasons[0]).toContain("src/a.ts:10");
    });

    it("stays silent when no fix round has run yet", () => {
      expect(detectNonConvergence([
        { round: 1, findings: [at("src/a.ts:10", "F-001")], fixAttempted: false },
        { round: 2, findings: [at("src/a.ts:10", "F-001")], fixAttempted: false },
      ])).toEqual([]);
    });

    it("ignores advisory findings that repeat", () => {
      expect(detectNonConvergence([
        { round: 1, findings: [at("src/a.ts:10", "F-001", "nit")], fixAttempted: true },
        { round: 2, findings: [at("src/a.ts:10", "F-001", "nit")], fixAttempted: false },
      ])).toEqual([]);
    });

    it("stays silent for a blocking finding seen in only one round", () => {
      expect(detectNonConvergence([
        { round: 1, findings: [at("src/a.ts:10", "F-001")], fixAttempted: true },
        { round: 2, findings: [at("src/b.ts:2", "F-002")], fixAttempted: false },
      ])).toEqual([]);
    });
  });

  it("never drops a blocker or major", () => {
    const blockers = [finding({ severity: "blocker", claim: "c1" }), finding({ severity: "major", claim: "c2", location: "src/b.ts:1" })];
    const out = consolidate([{ reviewer: "systems", report: report(blockers) }]);
    expect(out.findings.filter((f) => f.severity === "blocker" || f.severity === "major")).toHaveLength(2);
  });
});
