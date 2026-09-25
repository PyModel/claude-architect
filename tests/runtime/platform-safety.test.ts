import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PlatformSafety } from "../../src/platform/platform-safety.js";

let stateRoot: string;
let previousPluginData: string | undefined;

beforeEach(async () => {
  stateRoot = await mkdtemp(path.join(tmpdir(), "ca-platform-safety-"));
  previousPluginData = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = stateRoot;
});

afterEach(async () => {
  if (previousPluginData === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
  else process.env.CLAUDE_PLUGIN_DATA = previousPluginData;
  await rm(stateRoot, { recursive: true, force: true });
});

function safetyWithRelease(release: () => Promise<void>): PlatformSafety {
  return new PlatformSafety({
    acquireCheckoutLock: vi.fn(async () => ({
      key: "test-lock",
      repositoryIdentity: path.join(stateRoot, "repository.git"),
      release,
    })),
  });
}

describe("withCheckoutLease", () => {
  it("returns the result that onReleaseError substitutes after a failed release", async () => {
    const safety = safetyWithRelease(async () => { throw new Error("release refused"); });

    await expect(safety.withCheckoutLease(stateRoot, async () => ({ detail: "applied" }), {
      onReleaseError: (_error, result) => ({ detail: `${result.detail}; release failed` }),
    })).resolves.toEqual({ detail: "applied; release failed" });
  });

  it("throws the release error when no handler owns it", async () => {
    const safety = safetyWithRelease(async () => { throw new Error("release refused"); });

    await expect(safety.withCheckoutLease(stateRoot, async () => "done"))
      .rejects.toThrow("release refused");
  });

  it("keeps the primary failure visible when release also fails", async () => {
    const safety = safetyWithRelease(async () => { throw new Error("release refused"); });

    await expect(safety.withCheckoutLease(stateRoot, async () => { throw new Error("work failed"); }, {
      onReleaseError: () => { throw new Error("handler must not run for a failed operation"); },
    })).rejects.toThrow("work failed; checkout lock release failed");
  });
});
