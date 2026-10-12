import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { freezeCandidate } from "../../../src/git/candidate-tree.js";
import { validateAutopilotSpec } from "../../../src/protocol/spec-validator.js";
import { ArtifactStore } from "../../../src/runtime/artifact-store.js";
import { structuralVerify } from "../../../src/verify/structural-verifier.js";
import { temporaryPaths, fixtureNumber, runGit, createRepository, delegation, autopilotSpec, createHarness, candidateWorktreeFixture, candidateArtifactWithEntries, installAutopilotAdversarialHooks } from "../../support/autopilot-adversarial-harness.js";

installAutopilotAdversarialHooks();

describe("autopilot adversarial trust boundaries", () => {
  it.each([
    ["candidate/pipeline", "result.json"],
    ["advisor/eligibility", path.join("pipeline", "post-pipeline-autopilot.json")],
  ])("detects %s persisted-byte tampering and fails before hand-off", async (_label, relative) => {
    const harness = await createHarness({
      afterEligibility: async runId => {
        const store = new ArtifactStore(runId);
        await writeFile(path.join(store.runDirectory, relative), "{}\n");
      },
    });
    await expect(harness.controller.start(harness.fixture.checkout, autopilotSpec()))
      .rejects.toBeDefined();
    expect(harness.handoffs).toEqual([]);
    await expect(harness.store.read()).resolves.toMatchObject({
      terminal: { classification: expect.stringMatching(/failed|human-decision-required/u) },
    });
  }, 120_000);

  it("rejects malformed workflow/decision bytes through their real stores", async () => {
    const harness = await createHarness();
    const result = await harness.controller.start(harness.fixture.checkout, autopilotSpec());
    const runId = result.tasks[0]!.runId!;
    await writeFile(path.join(new ArtifactStore(runId).runDirectory, "decision.json"), "{}\n");
    await expect(new ArtifactStore(runId).readDecision()).rejects.toBeDefined();
    await writeFile(harness.store.statePath, "{}\n");
    await expect(harness.store.read()).rejects.toBeDefined();
  }, 120_000);

  it.each([
    ["traversal", "../escape"],
    ["absolute", path.resolve("escape")],
  ])("rejects %s authorization at candidate freezing", async (_label, attackedPath) => {
    const fixture = await candidateWorktreeFixture();
    await writeFile(path.join(fixture.worktreePath, "candidate.txt"), "candidate bytes\n");

    await expect(freezeCandidate({
      repoRoot: fixture.checkout,
      worktreePath: fixture.worktreePath,
      baseCommitOid: fixture.baseCommitOid,
      runId: `path-attack-${fixtureNumber}`,
      writeAllowlist: [attackedPath],
      forbiddenScope: [],
    })).resolves.toEqual({
      ok: false,
      reason: "out-of-scope-write",
      paths: ["candidate.txt"],
    });
  });

  it.each([
    ["symlink escape", [{ path: "link.txt", mode: "120000" as const }], "modified-symlink"],
    ["case-collision pair", [
      { path: "Case.txt", mode: "100644" as const },
      { path: "case.txt", mode: "100644" as const },
    ], "case-collision"],
  ])("rejects a %s in the immutable candidate tree", async (_label, entries, finding) => {
    const fixture = await createRepository(temporaryPaths[0]!);
    const artifact = await candidateArtifactWithEntries(
      fixture,
      entries,
      finding === "case-collision",
    );

    const result = await structuralVerify({
      repoRoot: fixture.checkout,
      worktreePath: fixture.checkout,
      baseCommitOid: fixture.baseCommitOid,
      artifact,
      writeAllowlist: ["**"],
      forbiddenScope: [],
    });

    expect(result.ok).toBe(false);
    expect(result.failures).toContain(finding);
  });

  it("detects registration and ref substitution", async () => {
    const harness = await createHarness();
    const workflowId = `${harness.workflowId}-branch-substitution`;
    const branch = await harness.branchManager.create({
      workflowId,
      checkoutPath: harness.fixture.checkout,
      remote: "origin",
      baseBranch: "main",
    });
    const ownershipPath = path.join(
      process.env.CLAUDE_PLUGIN_DATA!,
      "autopilot-branches",
      `${createHash("sha256").update(workflowId).digest("hex")}.json`,
    );
    const ownershipBytes = await readFile(ownershipPath, "utf8");
    await writeFile(ownershipPath, ownershipBytes.replace(branch.branch, "feat/substituted"));
    await expect(harness.branchManager.revalidate(branch)).resolves.toMatchObject({
      ok: false,
      classification: "ownership-mismatch",
    });
    await writeFile(ownershipPath, ownershipBytes);
    await runGit(branch.worktreePath, ["checkout", "--detach", "-q"]);
    await expect(harness.branchManager.revalidate(branch)).resolves.toMatchObject({ ok: false });
  });

  // Spec-level rejection only: no commit is created here, so this cannot speak
  // to what the promoter would write.
  it("rejects trailer and newline injection in a spec commit message", () => {
    for (const commitMessage of [
      "feat: safe\n\nCo-Authored-By: attacker <attacker@example.invalid>",
      "feat: safe\nInjected: header",
    ]) {
      const spec = autopilotSpec({
        tasks: [{ id: "task-one", commitMessage, delegation: delegation() }],
      });
      expect(validateAutopilotSpec(spec)).toMatchObject({ ok: false });
    }
  });

  it("ignores malicious hooks and aliases during promotion and cleanup", async () => {
    const harness = await createHarness();
    const marker = path.join(temporaryPaths[0]!, "hook-ran");
    const hooks = path.join(temporaryPaths[0]!, "hooks");
    await mkdir(hooks);
    await writeFile(path.join(hooks, "pre-commit"), `#!/bin/sh\nprintf bad > ${marker}\n`);
    await runGit(harness.fixture.checkout, ["config", "core.hooksPath", hooks]);
    await runGit(harness.fixture.checkout, ["config", "alias.commit", "!exit 91"]);
    const included = path.join(temporaryPaths[0]!, "conditional.gitconfig");
    await writeFile(included, "[alias]\n\tpush = !exit 92\n");
    await runGit(harness.fixture.checkout, [
      "config",
      `includeIf.gitdir:${harness.fixture.checkout}/**.path`,
      included,
    ]);
    const result = await harness.controller.start(harness.fixture.checkout, autopilotSpec());
    expect(result.phase).toBe("ready-for-human-review");
    await expect(lstat(marker)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(harness.branchManager.load(harness.workflowId)).resolves.toBeNull();
  }, 120_000);

});
