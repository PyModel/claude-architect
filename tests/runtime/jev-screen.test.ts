import { describe, expect, it } from "vitest";
import { jevScreen } from "../../src/mcp/jev-screen.js";
import type { CandidateArtifact } from "../../src/protocol/attempt-result.js";

const candidate = {
  patch: "diff --git a/a.ts b/a.ts\n+const token = \"ghp_abcdefghijklmnopqrstuvwxyz0123456789\";\n",
  changedPaths: [{ path: "a.ts", changeType: "modified", mode: "100644", contentHash: null }],
} as unknown as CandidateArtifact;

const enabled = { CLAUDE_ARCHITECT_JEV: "on", TYPESAFE_API_KEY: "test-key" };

function answering(nouls: Record<string, unknown>, status = 200): {
  fetch: typeof globalThis.fetch;
  requests: { url: string; init: RequestInit }[];
} {
  const requests: { url: string; init: RequestInit }[] = [];
  const fetch = (async (url: string, init: RequestInit) => {
    requests.push({ url, init });
    const answers = Object.fromEntries(Object.entries(nouls).map(([id, noul]) => [id, { type: "noul", noul }]));
    return new Response(JSON.stringify({ model: "jev-test", answers }), { status });
  }) as unknown as typeof globalThis.fetch;
  return { fetch, requests };
}

describe("jevScreen", () => {
  it("does nothing, and sends nothing, unless explicitly enabled", async () => {
    const { fetch, requests } = answering({});
    await expect(jevScreen(candidate, { env: { TYPESAFE_API_KEY: "k" }, fetch }))
      .resolves.toEqual({ status: "disabled" });
    expect(requests).toHaveLength(0);
  });

  it("is unavailable, not a concern, without a key", async () => {
    await expect(jevScreen(candidate, { env: { CLAUDE_ARCHITECT_JEV: "on" } }))
      .resolves.toEqual({ status: "unavailable", reason: "TYPESAFE_API_KEY is not set" });
  });

  it("sends only the redacted patch and changed paths", async () => {
    const { fetch, requests } = answering({ weakens_verification: 0.1, security_sensitive: 0.1 });
    await expect(jevScreen(candidate, { env: enabled, fetch })).resolves.toEqual({ status: "clear" });
    const body = JSON.parse(String(requests[0]!.init.body));
    expect(requests[0]!.url).toBe("https://api.typesafe.ai/v1/systemone");
    expect(body.state.changedPaths).toEqual(["a.ts"]);
    expect(body.state.patch).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123456789");
    expect(Object.keys(body.questions)).toEqual(["weakens_verification", "security_sensitive"]);
  });

  it("reports each flagged risk as a concern", async () => {
    const { fetch } = answering({ weakens_verification: 0.8, security_sensitive: 0.05 });
    await expect(jevScreen(candidate, { env: enabled, fetch })).resolves.toEqual({
      status: "concern",
      reasons: ["an independent screen (Jev) flagged the candidate as weakening verification (p=0.80)"],
    });
  });

  it.each([
    ["an HTTP error", answering({}, 529).fetch, "HTTP 529"],
    ["a malformed answer", answering({ weakens_verification: "yes", security_sensitive: 0.1 }).fetch, "malformed answer"],
    ["a missing answer", answering({ weakens_verification: 0.1 }).fetch, "malformed answer"],
    ["a network failure", (async () => { throw new TypeError("fetch failed"); }) as unknown as typeof globalThis.fetch, "TypeError"],
  ])("treats %s as unavailable", async (_name, fetch, reason) => {
    await expect(jevScreen(candidate, { env: enabled, fetch }))
      .resolves.toEqual({ status: "unavailable", reason });
  });
});
