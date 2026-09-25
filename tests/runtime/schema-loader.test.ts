import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { loadSchemas, checkVersionCompat } from "../../src/protocol/schema-loader.js";
import {
  AUTOPILOT_SPEC_VERSION,
  PROTOCOL_VERSION,
} from "../../src/protocol/versions.js";

const validDelegationSpec = {
  specVersion: "1",
  objective: "do the thing",
  context: "some context",
  writeAllowlist: ["src/**"],
  forbiddenScope: [],
  successCriteria: ["ok"],
  verification: [{
    id: "check",
    executable: "node",
    args: ["-e", "process.exit(0)"],
    cwd: ".",
    timeoutMs: 60000,
    network: "denied",
    expectedExitCodes: [0],
  }],
  executionMode: "edit",
  timeoutMs: 600000,
  producerPreferences: ["codex"],
  expectedOutput: "candidate-patch",
};

const validAttemptResult = {
  resultVersion: "1",
  runId: "run-schema",
  status: "failed",
  failure: "producer-failure",
  summary: "producer failed",
  producerSummary: null,
  candidate: null,
  requestedVerification: [],
  executedVerification: [],
  unresolvedIssues: [],
  evidence: {},
  logsRef: "logs/producer.log",
  producerId: "codex",
  producerVersion: "1.0.0",
  producerModel: null,
  durationMs: 1,
  sessionId: null,
};

describe("schema loader", () => {
  it("compiles delegation-spec and attempt-result validators", () => {
    const v = loadSchemas();
    expect(typeof v.delegationSpec).toBe("function");
    expect(typeof v.autopilotSpec).toBe("function");
    expect(typeof v.attemptResult).toBe("function");
    expect(v.delegationSpec({ specVersion: "1" })).toBe(false); // missing required fields
  });

  // Both paths this used to walk resolved to one runtime/schemas/autopilot-spec file,
  // so the "source versus packaged" comparison read one file twice and could not
  // have caught a divergence. There is only one schema file; assert that the
  // packaged runtime resolves it and that the loader agrees.
  it("loads the Autopilot Spec from the packaged runtime schema path", () => {
    const packagedRuntimeUrl = new URL("../../runtime/server.mjs", import.meta.url);
    const schemaUrl = new URL(`./schemas/autopilot-spec.v${AUTOPILOT_SPEC_VERSION}.json`, packagedRuntimeUrl);
    const schema = JSON.parse(fs.readFileSync(fileURLToPath(schemaUrl), "utf8"));

    expect(schema.$id).toBe(`autopilot-spec.v${AUTOPILOT_SPEC_VERSION}.json`);

    expect(loadSchemas().autopilotSpec({ specVersion: AUTOPILOT_SPEC_VERSION })).toBe(false);
  }, 5_000);

  it("accepts a valid, fully-populated delegation spec", () => {
    const v = loadSchemas();
    expect(v.delegationSpec(validDelegationSpec)).toBe(true);
  });

  it("rejects unknown delegation fields while preserving the environment map", () => {
    const v = loadSchemas();
    expect(v.delegationSpec({ ...validDelegationSpec, expectBaselineFailures: true })).toBe(false);
    expect(v.delegationSpec({
      ...validDelegationSpec,
      verification: [{
        ...validDelegationSpec.verification[0],
        environment: { CUSTOM_FLAG: "yes" },
        typo: true,
      }],
    })).toBe(false);
    expect(v.delegationSpec({
      ...validDelegationSpec,
      verification: [{
        ...validDelegationSpec.verification[0],
        environment: { CUSTOM_FLAG: "yes" },
      }],
    })).toBe(true);
  });

  it("encodes the edit timeout floor in the canonical schema", () => {
    const v = loadSchemas();
    expect(v.delegationSpec({ ...validDelegationSpec, timeoutMs: 599_999 })).toBe(false);
    expect(v.delegationSpec({ ...validDelegationSpec, timeoutMs: 600_000 })).toBe(true);
  });

  it("rejects a delegation spec with a wrong const value", () => {
    const v = loadSchemas();
    expect(
      v.delegationSpec({ ...validDelegationSpec, expectedOutput: "wrong" }),
    ).toBe(false);
  });

  it("accepts a valid attempt result", () => {
    const v = loadSchemas();
    expect(v.attemptResult(validAttemptResult)).toBe(true);
  });

  it("closes attempt-result command objects but preserves evidence maps", () => {
    const v = loadSchemas();
    expect(v.attemptResult({
      ...validAttemptResult,
      evidence: { verifierSpecific: { freeForm: true } },
    })).toBe(true);
    expect(v.attemptResult({ ...validAttemptResult, unexpected: true })).toBe(false);
    expect(v.attemptResult({
      ...validAttemptResult,
      requestedVerification: [{
        ...validDelegationSpec.verification[0],
        expectBaselineFailure: true,
        unexpected: true,
      }],
    })).toBe(false);
  });

  it("rejects an attempt result with a wrong status value", () => {
    const v = loadSchemas();
    expect(
      v.attemptResult({ ...validAttemptResult, status: "nope" }),
    ).toBe(false);
  });

  it("rejects an attempt result with a wrong failure value", () => {
    const v = loadSchemas();
    expect(
      v.attemptResult({ ...validAttemptResult, failure: "nope" }),
    ).toBe(false);
  });

  it("rejects incomplete and contradictory attempt results", () => {
    const v = loadSchemas();
    const { runId, ...missingRunId } = validAttemptResult;
    expect(v.attemptResult(missingRunId)).toBe(false);
    expect(v.attemptResult({
      ...validAttemptResult,
      status: "verified-candidate",
      failure: "verification-failure",
    })).toBe(false);
    expect(v.attemptResult({
      ...validAttemptResult,
      status: "failed",
      failure: null,
    })).toBe(false);
    const preservedCandidate = {
      baseCommitOid: "1".repeat(40),
      candidateTreeOid: "2".repeat(40),
      candidateCommitOid: "3".repeat(40),
      anchorRef: "refs/claude-architect/candidates/run-schema",
      manifestHash: "4".repeat(64),
      changedPaths: [],
      patch: "",
    };
    expect(v.attemptResult({
      ...validAttemptResult,
      failure: "spawn-failure",
      candidate: preservedCandidate,
    })).toBe(false);
    expect(v.attemptResult({
      ...validAttemptResult,
      failure: "verification-failure",
      candidate: preservedCandidate,
    })).toBe(true);
    expect(v.attemptResult({
      ...validAttemptResult,
      failure: "verification-failure",
      candidate: {
        ...preservedCandidate,
        baseCommitOid: "1".repeat(64),
        candidateTreeOid: "2".repeat(64),
        candidateCommitOid: "3".repeat(64),
        changedPaths: [{
          path: "src/example.ts",
          changeType: "modified",
          mode: "100644",
          contentHash: "4".repeat(64),
        }],
      },
    })).toBe(true);
    expect(v.attemptResult({
      ...validAttemptResult,
      failure: "verification-failure",
      candidate: { ...preservedCandidate, candidateCommitOid: "3".repeat(41) },
    })).toBe(false);
    expect(v.attemptResult({
      ...validAttemptResult,
      failure: "verification-failure",
      candidate: {
        ...preservedCandidate,
        changedPaths: [{
          path: "src/example.ts",
          changeType: "modified",
          mode: "100644",
          contentHash: "4".repeat(41),
        }],
      },
    })).toBe(false);
  });
});

describe("checkVersionCompat", () => {
  it("reports ok for a matching protocol version", () => {
    const result = checkVersionCompat(PROTOCOL_VERSION);
    expect(result).toEqual({ ok: true });
  });

  it("reports a diagnostic for a mismatched protocol version", () => {
    const result = checkVersionCompat("1.3.0");
    expect(result.ok).toBe(false);
    expect(typeof result.diagnostic).toBe("string");
    expect((result.diagnostic as string).length).toBeGreaterThan(0);
  });

  it("rejects every non-matching protocol version", () => {
    for (const version of ["1.0.0", "2.0.0", "2.99.0", "4.0.0", "not-semver"]) {
      const result = checkVersionCompat(version);
      expect(result.ok).toBe(false);
      expect(result.diagnostic).toContain(`skill declares ${version}`);
      expect(result.diagnostic).toContain(`runtime expects ${PROTOCOL_VERSION}`);
    }
  });
});
