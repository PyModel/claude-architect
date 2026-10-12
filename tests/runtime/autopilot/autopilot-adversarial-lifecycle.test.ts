import { describe, expect, it } from "vitest";
import { WorkflowStore } from "../../../src/autopilot/workflow-store.js";
import { autopilotSpec, createHarness, installAutopilotAdversarialHooks } from "../../support/autopilot-adversarial-harness.js";

installAutopilotAdversarialHooks();

describe("autopilot adversarial trust boundaries", () => {
  it("persists terminal cancellation and performs no later hand-off", async () => {
    const abort = new AbortController();
    const harness = await createHarness({ mode: "cancel", abortSignal: abort.signal });
    let producerStarted: (() => void) | undefined;
    const started = new Promise<void>(resolve => { producerStarted = resolve; });
    harness.producer.invocationStarted = () => producerStarted?.();
    const running = harness.controller.start(harness.fixture.checkout, autopilotSpec());
    await started;
    await new Promise<void>(resolve => setTimeout(resolve, 100));
    abort.abort();
    await expect(running)
      .rejects.toMatchObject({ classification: "cancelled" });
    const durable = await harness.store.read();
    expect(durable).toMatchObject({
      phase: "cancelled",
      terminal: { classification: "cancelled" },
    });
    expect(durable.cleanup).toBeNull();
    await expect(harness.branchManager.load(harness.workflowId)).resolves.not.toBeNull();
    expect(harness.handoffs).toEqual([]);
    // Unlike the sibling cancellation tests, this one aborts while the Producer
    // is mid-flight, so it also pays for terminating a live process tree —
    // markedly slower on Windows, where 120s was not enough.
  }, 240_000);

  it("halts durably when cancellation fires after promotion and before hand-off", async () => {
    const abort = new AbortController();
    const harness = await createHarness({
      abortSignal: abort.signal,
      afterPromotion: () => abort.abort(),
    });

    await expect(harness.controller.start(harness.fixture.checkout, autopilotSpec()))
      .rejects.toMatchObject({ classification: "cancelled" });
    await expect(harness.store.read()).resolves.toMatchObject({
      phase: "cancelled",
      terminal: { classification: "cancelled", reason: "cancelled" },
    });
    expect(harness.handoffs).toEqual([]);
  }, 120_000);

  it("bounds oversized producer output and fails closed before hand-off", async () => {
    const harness = await createHarness({ mode: "oversize" });
    await expect(harness.controller.start(harness.fixture.checkout, autopilotSpec()))
      .rejects.toBeDefined();
    const durable = await harness.store.read();
    expect(["failed", "human-decision-required"]).toContain(durable.phase);
    expect(harness.handoffs).toEqual([]);
  }, 120_000);

  it("serializes duplicate workflow starts and rejects a live-owner resume", async () => {
    const abort = new AbortController();
    const harness = await createHarness({ mode: "cancel", abortSignal: abort.signal });
    let releaseStarted: (() => void) | undefined;
    const started = new Promise<void>(resolve => { releaseStarted = resolve; });
    harness.producer.invocationStarted = () => releaseStarted?.();
    const first = harness.controller.start(harness.fixture.checkout, autopilotSpec());
    await started;
    const liveStore = new WorkflowStore(harness.workflowId);
    await expect(liveStore.adoptLease()).rejects.toMatchObject({
      detail: { toolError: "workflow-lease-conflict" },
    });
    const second = harness.controller.resume(harness.fixture.checkout, harness.workflowId);
    await new Promise<void>(resolve => setTimeout(resolve, 100));
    abort.abort();
    await expect(first).rejects.toMatchObject({ classification: "cancelled" });
    await expect(second).resolves.toMatchObject({ phase: "cancelled" });
    expect(harness.handoffs).toEqual([]);
    // Same reason as the terminal-cancellation test above: aborting while the
    // Producer is mid-flight pays for tearing down a live process tree, which
    // is far slower on Windows than the 120s this suite assumed.
  }, 240_000);

  it("allows exactly one concurrent start for the same workflow id", async () => {
    const harness = await createHarness();
    const starts = await Promise.allSettled([
      harness.controller.start(harness.fixture.checkout, autopilotSpec()),
      harness.controller.start(harness.fixture.checkout, autopilotSpec()),
    ]);

    expect(starts.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(starts.filter(result => result.status === "rejected")).toHaveLength(1);
    expect(harness.handoffs).toHaveLength(1);
  }, 120_000);

});
