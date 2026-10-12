import { readFile, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { WorkflowBranchManager } from "../../../src/autopilot/branch-manager.js";
import { getPlatformServices } from "../../../src/platform/select-platform.js";
import { temporaryPaths, fixtureNumber, runGit, localRemoteTransport, createRepository, autopilotSpec, createHarness, installAutopilotAdversarialHooks } from "../../support/autopilot-adversarial-harness.js";

installAutopilotAdversarialHooks();

describe("autopilot adversarial trust boundaries", () => {
  it("serializes checkout-lock contenders without interleaving branch creation", async () => {
    const fixture = await createRepository(temporaryPaths[0]!);
    const operations: string[] = [];
    const local = localRemoteTransport(fixture.bareRemote);
    const manager = new WorkflowBranchManager({
      platformServices: getPlatformServices(),
      remoteTransport: {
        async listHeads(cwd, remoteUrl) {
          operations.push("list");
          return await local.listHeads(cwd, remoteUrl);
        },
        async fetch(cwd, remoteUrl, sourceRef, destinationRef) {
          operations.push("fetch");
          return await local.fetch(cwd, remoteUrl, sourceRef, destinationRef);
        },
      },
    });
    const [first, second] = await Promise.all([
      manager.create({
        workflowId: `checkout-race-a-${fixtureNumber}`,
        topic: "checkout-race-a",
        checkoutPath: fixture.checkout,
        remote: "origin",
        baseBranch: "main",
      }),
      manager.create({
        workflowId: `checkout-race-b-${fixtureNumber}`,
        topic: "checkout-race-b",
        checkoutPath: fixture.checkout,
        remote: "origin",
        baseBranch: "main",
      }),
    ]);

    expect(operations).toEqual(["list", "fetch", "list", "list", "fetch", "list"]);
    await manager.cleanup(first);
    await manager.cleanup(second);
  });

  it("rejects cross-repository workflow access", async () => {
    const harness = await createHarness();
    await harness.controller.start(harness.fixture.checkout, autopilotSpec());
    const other = await createRepository(temporaryPaths[0]!);
    await expect(harness.controller.status(other.checkout, harness.workflowId))
      .rejects.toMatchObject({ classification: "repository-identity-mismatch" });
  }, 120_000);

  it("never publishes anything: the remote gains no ref from a complete workflow", async () => {
    const harness = await createHarness();
    const remoteBefore = await runGit(harness.fixture.bareRemote, ["show-ref"]);

    const result = await harness.controller.start(harness.fixture.checkout, autopilotSpec());

    expect(result.phase).toBe("ready-for-human-review");
    expect(harness.handoffs).toEqual([result.headCommitOid]);
    expect(await runGit(harness.fixture.bareRemote, ["show-ref"])).toBe(remoteBefore);
    expect(await runGit(harness.fixture.checkout, ["rev-parse", `refs/heads/${result.branch}`]))
      .toBe(result.headCommitOid);
  }, 120_000);

  it("does not follow symlink-substituted workflow state", async () => {
    const harness = await createHarness();
    await harness.controller.start(harness.fixture.checkout, autopilotSpec());
    const outside = path.join(temporaryPaths[0]!, "outside-state.json");
    await writeFile(outside, await readFile(harness.store.statePath));
    await rm(harness.store.statePath);
    await symlink(outside, harness.store.statePath);
    await expect(harness.store.read()).rejects.toBeDefined();
  }, 120_000);
});
