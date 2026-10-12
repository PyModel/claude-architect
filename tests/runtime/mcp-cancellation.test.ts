import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { start } from "../../src/mcp/server.js";
import type { PlatformServices } from "../../src/platform/platform-services.js";
import type { DelegationSpec } from "../../src/protocol/delegation-spec.js";
import { PROTOCOL_VERSION } from "../../src/protocol/versions.js";
import { noAllowlistGaps, notSelfHosted, pruneNothing } from "../support/server-stubs.js";

/**
 * Cancellation is only real if the caller's abort actually reaches the runtime.
 *
 * Every other cancellation test injects an `AbortSignal` straight into the
 * pipeline or attempt dependencies. Those prove the runtime *checks* a signal —
 * they cannot prove one is ever raised, because the test supplies the aborted
 * signal itself. The link they skip is the one that failed in practice: a caller
 * gives up, and whether that becomes an aborted `extra.signal` depends on the
 * client emitting `notifications/cancelled` and the SDK wiring it through.
 *
 * So drive a real SDK client over an in-memory transport and abort a live call.
 */

const spec: DelegationSpec = {
  specVersion: "1",
  objective: "block until cancelled",
  context: "cancellation test",
  writeAllowlist: ["src/**"],
  forbiddenScope: [],
  successCriteria: ["never reached"],
  verification: [{
    id: "check",
    executable: "node",
    args: ["-e", "process.exit(0)"],
    cwd: ".",
    timeoutMs: 60_000,
    network: "denied",
    expectedExitCodes: [0],
  }],
  executionMode: "edit",
  timeoutMs: 600_000,
  producerPreferences: ["codex"],
  expectedOutput: "candidate-patch",
};

function fakePlatform(): PlatformServices {
  return {
    os: "darwin",
    canonicalizePath: async input => ({
      input,
      canonical: "/canonical/repo",
      gitCommonDir: "/canonical/repo/.git",
    }),
    acquireCheckoutLock: async checkout => ({
      key: checkout,
      repositoryIdentity: "/canonical/repo/.git",
      release: async () => {},
    }),
  } as PlatformServices;
}

describe("MCP cancellation reaches the runtime", () => {
  it("aborts the in-flight attempt when the client cancels the request", async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    // Resolves with the signal the attempt runtime actually received, once the
    // attempt has started — so the test cancels a live call, not a pending one.
    let reportRunning = (_signal: AbortSignal | undefined) => {};
    const running = new Promise<AbortSignal | undefined>(resolve => {
      reportRunning = resolve;
    });

    await start({
      transport: serverTransport,
      recoverStaleRuns: async () => ({ recovered: [], quarantined: [] }),
      pruneRuns: pruneNothing,
      ps: fakePlatform(),
      checkLiveBundle: notSelfHosted,
      checkAllowlistSufficiency: noAllowlistGaps,
      runAttempt: async (_checkout, _spec, deps) => {
        reportRunning(deps.abortSignal);
        // Model a Producer that outlives the caller: never finish on its own.
        // Only cancellation can end this call.
        await new Promise(() => {});
        throw new Error("unreachable");
      },
    });

    const client = new Client({ name: "cancellation-test", version: "1.0.0" });
    await client.connect(clientTransport);

    const controller = new AbortController();
    const call = client.callTool(
      {
        name: "delegate",
        arguments: { checkoutPath: "/repo", spec, protocolVersion: PROTOCOL_VERSION },
      },
      undefined,
      { signal: controller.signal },
    );
    // Swallow the client-side rejection; the assertion is about the server.
    const settled = call.then(() => "resolved", () => "rejected");

    const runtimeSignal = await running;
    expect(runtimeSignal).toBeDefined();
    expect(runtimeSignal?.aborted).toBe(false);

    controller.abort();

    // The server's signal must fire — this is the link the injected-signal
    // tests cannot cover. Bounded, so a regression reports "never fired"
    // instead of hanging until the suite-level timeout.
    const fired = await new Promise<boolean>(resolve => {
      if (runtimeSignal?.aborted === true) {
        resolve(true);
        return;
      }
      const timer = setTimeout(() => resolve(false), 5_000);
      runtimeSignal?.addEventListener("abort", () => {
        clearTimeout(timer);
        resolve(true);
      }, { once: true });
    });

    expect(fired, "client cancellation never reached the attempt runtime").toBe(true);
    expect(runtimeSignal?.aborted).toBe(true);
    expect(await settled).toBe("rejected");

    await client.close();
  });
});
