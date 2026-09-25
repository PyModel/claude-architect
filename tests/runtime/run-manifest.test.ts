import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { PROTOCOL_VERSION } from "../../src/protocol/versions.js";
import {
  buildRunManifest,
  type BuildRunManifestArgs,
  type RunManifest,
  verifyRunManifest,
} from "../../src/runtime/run-manifest.js";

function manifestArgs(): BuildRunManifestArgs {
  return {
    runId: "run-protocol-provenance",
    repoRoot: "/canonical/repo",
    baseCommitOid: "a".repeat(40),
    candidateManifestHash: null,
    producer: { id: "codex", version: "1", model: "test" },
    effectivePolicy: {},
    repositoryInstructions: [],
    prompt: "implement",
    executionPolicy: {},
    environment: [],
    packagedVerifier: { version: "1", content: "verifier" },
  };
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([, child]) => child !== undefined)
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([key, child]) => [key, canonicalize(child)]));
}

function withProtocolVersion(protocolVersion: string): RunManifest {
  const manifest = { ...buildRunManifest(manifestArgs()), protocolVersion };
  const { manifestHash: _manifestHash, ...body } = manifest;
  return {
    ...body,
    manifestHash: createHash("sha256")
      .update(JSON.stringify(canonicalize(body)))
      .digest("hex"),
  };
}

describe("run manifest protocol provenance", () => {
  it("accepts an archived protocol version with the current major", () => {
    const manifest = withProtocolVersion("3.0.0");

    expect(verifyRunManifest(manifest)).toEqual(manifest);
  });

  it("accepts a same-major archive from a different minor", () => {
    const manifest = withProtocolVersion("3.7.0");

    expect(verifyRunManifest(manifest)).toEqual(manifest);
  });

  it.each(["1.0.0", "2.0.0", "4.0.0", "not-a-version"])(
    "rejects incompatible archived protocol %s with both versions in the diagnostic",
    archivedVersion => {
      expect(() => verifyRunManifest(withProtocolVersion(archivedVersion))).toThrow(
        `archived run manifest protocol ${archivedVersion} is incompatible with runtime protocol ${PROTOCOL_VERSION}`,
      );
    },
  );

  it("stamps new manifests with the exact current protocol version", () => {
    expect(buildRunManifest(manifestArgs()).protocolVersion).toBe(PROTOCOL_VERSION);
  });
});
