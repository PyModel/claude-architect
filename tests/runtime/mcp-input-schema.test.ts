import { describe, expect, it } from "vitest";
import {
  decideCandidateInputSchema,
  delegateInputSchema,
  delegatePipelineInputSchema,
  integrateCandidateInputSchema,
  reviewCandidateInputSchema,
  validateDelegationSpecInputSchema,
} from "../../src/mcp/server.js";
import { PROTOCOL_VERSION } from "../../src/protocol/versions.js";

const validInput = {
  checkoutPath: "/repo",
  spec: { specVersion: "1" },
  protocolVersion: PROTOCOL_VERSION,
};

describe("validateDelegationSpec MCP input", () => {
  it("requires only the exact protocol version and spec", () => {
    expect(validateDelegationSpecInputSchema.safeParse({
      spec: validInput.spec,
      protocolVersion: PROTOCOL_VERSION,
    }).success).toBe(true);
    expect(validateDelegationSpecInputSchema.safeParse({
      checkoutPath: "/repo",
      spec: validInput.spec,
      protocolVersion: PROTOCOL_VERSION,
    }).success).toBe(false);
    expect(validateDelegationSpecInputSchema.safeParse({
      spec: validInput.spec,
      protocolVersion: "1.0.0",
    }).success).toBe(false);
  });
});

describe.each([
  ["delegate", delegateInputSchema],
  ["delegatePipeline", delegatePipelineInputSchema],
])("%s MCP input", (_name, schema) => {
  it("requires the exact protocol version", () => {
    expect(schema.safeParse(validInput).success).toBe(true);

    // Assert each case names what it actually received. An alternation over
    // both spellings would pass even if the two branches collapsed into one —
    // and they are separate branches in the error map, so a regression there
    // would otherwise be invisible.
    for (const [input, received] of [
      [{ checkoutPath: "/repo", spec: {} }, "(missing)"],
      [{ ...validInput, protocolVersion: "1.0.0" }, "1.0.0"],
    ] as const) {
      const result = schema.safeParse(input);
      expect(result.success).toBe(false);
      if (result.success) continue;
      const diagnostic = result.error.issues.map(issue => issue.message).join("\n");
      expect(diagnostic).toContain(
        `protocol version mismatch: received ${received}, expected ${PROTOCOL_VERSION}`,
      );
    }
  });

  it("rejects unknown input keys", () => {
    const result = schema.safeParse({ ...validInput, protocolVersions: PROTOCOL_VERSION });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues[0]?.code).toBe("unrecognized_keys");
  });

  it("accepts an optional expected canonical spec digest", () => {
    expect(schema.safeParse({
      ...validInput,
      expectedSpecSha256: "a".repeat(64),
    }).success).toBe(true);
    expect(schema.safeParse({
      ...validInput,
      expectedSpecSha256: 42,
    }).success).toBe(false);
  });
  it("diagnoses the previous 2.0.0 protocol and names expected 3.0.0", () => {
    const result = schema.safeParse({ ...validInput, protocolVersion: "2.0.0" });

    expect(result.success).toBe(false);
    if (result.success) return;
    const diagnostic = result.error.issues.map(issue => issue.message).join("\n");
    expect(diagnostic).toContain("protocol version mismatch");
    expect(diagnostic).toContain("received 2.0.0");
    expect(diagnostic).toContain("expected 3.0.0");
  }, 5_000);
});

describe.each([
  ["reviewCandidate", reviewCandidateInputSchema, { runId: "run-test" }],
  ["decideCandidate", decideCandidateInputSchema, {
    runId: "run-test",
    decision: "accepted",
    expectedArtifactHash: "a".repeat(64),
  }],
  ["integrateCandidate", integrateCandidateInputSchema, {
    runId: "run-test",
    expectedArtifactHash: "a".repeat(64),
  }],
])("%s MCP input", (_name, schema, input) => {
  it("requires checkoutPath", () => {
    expect(schema.safeParse({ checkoutPath: "/repo", ...input }).success).toBe(true);
    expect(schema.safeParse(input).success).toBe(false);
  });

  it("rejects unknown input keys", () => {
    const result = schema.safeParse({ checkoutPath: "/repo", ...input, checkoutPaths: ["/repo"] });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues[0]?.code).toBe("unrecognized_keys");
  });
});

describe("decideCandidate MCP input hash binding", () => {
  const input = {
    checkoutPath: "/repo",
    runId: "run-test",
    decision: "accepted" as const,
    expectedArtifactHash: "a".repeat(64),
  };

  it("requires an exact lowercase SHA-256 artifact hash", () => {
    expect(decideCandidateInputSchema.safeParse(input).success).toBe(true);
    expect(decideCandidateInputSchema.safeParse({
      ...input,
      expectedArtifactHash: undefined,
    }).success).toBe(false);
    expect(decideCandidateInputSchema.safeParse({
      ...input,
      expectedArtifactHash: "a".repeat(63),
    }).success).toBe(false);
    expect(decideCandidateInputSchema.safeParse({
      ...input,
      expectedArtifactHash: "A".repeat(64),
    }).success).toBe(false);
  });

  it("does not expose an authority input", () => {
    const result = decideCandidateInputSchema.safeParse({ ...input, authority: "human" });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues[0]?.code).toBe("unrecognized_keys");
  });
});
