import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { PlatformServices, ResolvedExecutable } from "../../src/platform/platform-services.js";
import type { DelegationSpec } from "../../src/protocol/delegation-spec.js";
import {
  EDIT_ACTION_PREAMBLE,
  LINT_BEFORE_TYPECHECK_INSTRUCTION,
  renderList,
  renderProducerPrompt,
} from "../../src/producers/prompt-renderer.js";
import { renderSkillBootstrap } from "../../src/producers/skill-bootstrap.js";
import { AgyAdapter, agyDescriptor } from "../../src/producers/agy-adapter.js";
import { ClaudeAdapter, claudeDescriptor } from "../../src/producers/claude-adapter.js";
import { CodexAdapter, codexDescriptor } from "../../src/producers/codex-adapter.js";
import { OpenCodeAdapter, openCodeDescriptor } from "../../src/producers/opencode-adapter.js";
import { PiAdapter, piDescriptor } from "../../src/producers/pi-adapter.js";
import { PythinkerAdapter, pythinkerDescriptor } from "../../src/producers/pythinker-adapter.js";
import {
  DescriptorAdapter,
  type InvocationContext,
  type ProducerAdapter,
  type ProducerDescriptor,
} from "../../src/producers/producer-adapter.js";

const executable: ResolvedExecutable = {
  kind: "native",
  command: "/usr/local/bin/test-cli",
  prefixArgs: [],
  resolvedFrom: "test",
};

function invocationContext(readOnly = false): InvocationContext {
  return {
    executable,
    worktreePath: "/tmp/worktree",
    tempHome: "/tmp/home",
    readOnly,
  };
}

function sampleSpec(): DelegationSpec {
  return {
    id: "cross-lane-spec-001",
    objective: "Implement unified cross-lane prompt rendering",
    context: "Slice 2.2 unifies prompt assembly across all producer descriptors.",
    writeAllowlist: ["src/producers/prompt-renderer.ts", "tests/runtime/cross-lane-prompt.test.ts"],
    forbiddenScope: ["runtime/schemas/*"],
    successCriteria: [
      "Every edit-lane prompt carries action-first preamble",
      "Every edit-lane prompt carries lint-before-typecheck ordering",
    ],
    executionMode: "edit",
    timeoutMs: 30_000,
  };
}

function extractPrompt(adapterId: string, args: string[], stdin?: string): string {
  if (stdin !== undefined) return stdin;
  if (adapterId === "agy") {
    const idx = args.indexOf("-p");
    return idx >= 0 ? args[idx + 1]! : "";
  }
  if (adapterId === "pythinker") {
    const idx = args.indexOf("--prompt");
    return idx >= 0 ? args[idx + 1]! : "";
  }
  throw new Error(`Unknown prompt extraction for ${adapterId}`);
}

describe("Cross-Lane Prompt Renderer (Slice 2.2)", () => {
  const lanes: { id: string; descriptor: ProducerDescriptor; createAdapter: () => ProducerAdapter }[] = [
    { id: "codex", descriptor: codexDescriptor, createAdapter: () => new CodexAdapter() },
    { id: "agy", descriptor: agyDescriptor, createAdapter: () => new AgyAdapter() },
    { id: "claude", descriptor: claudeDescriptor, createAdapter: () => new ClaudeAdapter() },
    { id: "opencode", descriptor: openCodeDescriptor, createAdapter: () => new OpenCodeAdapter() },
    { id: "pi", descriptor: piDescriptor, createAdapter: () => new PiAdapter() },
    { id: "pythinker", descriptor: pythinkerDescriptor, createAdapter: () => new PythinkerAdapter() },
  ];

  it("declares actionPreamble and bootstrapPlacement on every producer descriptor", () => {
    for (const lane of lanes) {
      expect(lane.descriptor.prompt).toBeDefined();
      expect(lane.descriptor.prompt?.actionPreamble).toBe(true);
      expect(lane.descriptor.prompt?.bootstrapPlacement).toBe("before");
    }
  });

  it("asserts every edit-lane prompt carries the action-first preamble and lint-before-typecheck ordering", () => {
    const spec = sampleSpec();
    const ctx = invocationContext(false);

    for (const lane of lanes) {
      const adapter = lane.createAdapter();
      const invocation = adapter.buildInvocation(spec, ctx);
      const prompt = extractPrompt(lane.id, invocation.args, invocation.stdin);

      // Action-first preamble must be at the very top
      expect(
        prompt.startsWith(`${EDIT_ACTION_PREAMBLE}\n\n`),
        `Lane ${lane.id} prompt must start with action preamble`,
      ).toBe(true);

      // Must include delegated skill bootstrap
      expect(
        prompt.includes(renderSkillBootstrap()),
        `Lane ${lane.id} prompt must contain delegated skill bootstrap`,
      ).toBe(true);

      // Must include untrusted notice
      expect(
        prompt.includes("You are an untrusted implementation Producer operating inside an isolated worktree."),
        `Lane ${lane.id} prompt must contain untrusted notice`,
      ).toBe(true);

      // Must include spec elements
      expect(prompt).toContain(spec.objective);
      expect(prompt).toContain(spec.context);
      expect(prompt).toContain("src/producers/prompt-renderer.ts");
      expect(prompt).toContain("runtime/schemas/*");
      expect(prompt).toContain("Every edit-lane prompt carries action-first preamble");

      // Must include lint-before-typecheck instruction
      expect(
        prompt.includes(LINT_BEFORE_TYPECHECK_INSTRUCTION),
        `Lane ${lane.id} prompt must contain lint-before-typecheck instruction`,
      ).toBe(true);

      // Ordering: preamble before bootstrap, bootstrap before untrusted notice,
      // untrusted notice before objective, lint instruction before final summary
      const preambleIdx = prompt.indexOf(EDIT_ACTION_PREAMBLE);
      const bootstrapIdx = prompt.indexOf(renderSkillBootstrap());
      const noticeIdx = prompt.indexOf("You are an untrusted implementation Producer");
      const objectiveIdx = prompt.indexOf("Objective:");
      const lintIdx = prompt.indexOf(LINT_BEFORE_TYPECHECK_INSTRUCTION);
      const summaryIdx = prompt.indexOf("Make only the requested edits. Return a concise final summary");

      expect(preambleIdx).toBe(0);
      expect(bootstrapIdx).toBeGreaterThan(preambleIdx);
      expect(noticeIdx).toBeGreaterThan(bootstrapIdx);
      expect(objectiveIdx).toBeGreaterThan(noticeIdx);
      expect(lintIdx).toBeGreaterThan(objectiveIdx);
      expect(summaryIdx).toBeGreaterThan(lintIdx);
    }
  });

  it("produces byte-identical prompt content across all six edit lanes", () => {
    const spec = sampleSpec();
    const ctx = invocationContext(false);

    const prompts = lanes.map(lane => {
      const adapter = lane.createAdapter();
      const invocation = adapter.buildInvocation(spec, ctx);
      return {
        id: lane.id,
        prompt: extractPrompt(lane.id, invocation.args, invocation.stdin),
      };
    });

    const canonicalPrompt = renderProducerPrompt(spec, false);
    for (const { id, prompt } of prompts) {
      expect(prompt, `Lane ${id} prompt must match canonical prompt`).toBe(canonicalPrompt);
    }
  });

  it("omits the action preamble and skill bootstrap from read-only prompts across all lanes", () => {
    const spec = sampleSpec();
    const ctx = invocationContext(true);

    for (const lane of lanes) {
      const adapter = lane.createAdapter();
      const invocation = adapter.buildInvocation(spec, ctx);
      const prompt = extractPrompt(lane.id, invocation.args, invocation.stdin);

      expect(prompt).not.toContain(EDIT_ACTION_PREAMBLE);
      expect(prompt).not.toContain("## Delegated procedure skills");
      expect(prompt).toContain("You are an untrusted implementation Producer");
      expect(prompt).toContain(spec.objective);
      expect(prompt).toContain(LINT_BEFORE_TYPECHECK_INSTRUCTION);
    }
  });

  it("parameterizes actionPreamble and bootstrapPlacement from descriptor data", () => {
    const spec = sampleSpec();

    // Case 1: placement = "after", actionPreamble = false (legacy plain-text style)
    const afterNoPreambleDesc: ProducerDescriptor = {
      id: "test-after-no-preamble",
      executable: { name: "test" },
      isolation: "inherited-config-only",
      prompt: {
        actionPreamble: false,
        bootstrapPlacement: "after",
      },
    };
    const promptAfterNoPreamble = renderProducerPrompt(spec, afterNoPreambleDesc);
    expect(promptAfterNoPreamble).not.toContain(EDIT_ACTION_PREAMBLE);
    expect(promptAfterNoPreamble.startsWith("You are an untrusted implementation Producer")).toBe(true);
    const noticePos = promptAfterNoPreamble.indexOf("Do not delegate to other agents");
    const bootstrapPos = promptAfterNoPreamble.indexOf(renderSkillBootstrap());
    const objPos = promptAfterNoPreamble.indexOf("Objective:");
    expect(bootstrapPos).toBeGreaterThan(noticePos);
    expect(objPos).toBeGreaterThan(bootstrapPos);

    // Case 2: placement = "before", actionPreamble = false
    const beforeNoPreambleDesc: ProducerDescriptor = {
      id: "test-before-no-preamble",
      executable: { name: "test" },
      isolation: "inherited-config-only",
      prompt: {
        actionPreamble: false,
        bootstrapPlacement: "before",
      },
    };
    const promptBeforeNoPreamble = renderProducerPrompt(spec, beforeNoPreambleDesc);
    expect(promptBeforeNoPreamble).not.toContain(EDIT_ACTION_PREAMBLE);
    expect(promptBeforeNoPreamble.startsWith(renderSkillBootstrap())).toBe(true);

    // Case 3: placement = "after", actionPreamble = true
    const afterWithPreambleDesc: ProducerDescriptor = {
      id: "test-after-with-preamble",
      executable: { name: "test" },
      isolation: "inherited-config-only",
      prompt: {
        actionPreamble: true,
        bootstrapPlacement: "after",
      },
    };
    const promptAfterWithPreamble = renderProducerPrompt(spec, afterWithPreambleDesc);
    expect(promptAfterWithPreamble.startsWith(`${EDIT_ACTION_PREAMBLE}\n\n`)).toBe(true);
    const bootstrapInAfter = promptAfterWithPreamble.indexOf(renderSkillBootstrap());
    const noticeInAfter = promptAfterWithPreamble.indexOf("You are an untrusted implementation Producer");
    expect(bootstrapInAfter).toBeGreaterThan(noticeInAfter);

    // Case 4: DescriptorAdapter automatically routes through descriptor prompt configuration
    const customAdapter = new DescriptorAdapter(afterNoPreambleDesc);
    const customInvocation = customAdapter.buildInvocation(spec, invocationContext(false));
    expect(customInvocation.stdin).toBe(promptAfterNoPreamble);
  });

  it("documents the change in prompt hashes for the five non-Codex lanes", () => {
    const spec = sampleSpec();
    const currentPrompt = renderProducerPrompt(spec, false);
    const currentHash = createHash("sha256").update(currentPrompt).digest("hex");

    // Reconstruct the legacy non-Codex prompt (without preamble, without lint instruction, bootstrap in body)
    const legacyPrompt = [
      "You are an untrusted implementation Producer operating inside an isolated worktree.",
      "Do not delegate to other agents or expand the authorized scope.",
      "",
      renderSkillBootstrap(),
      "",
      "Objective:",
      spec.objective,
      "",
      "Context:",
      spec.context,
      "",
      "Authorized write allowlist:",
      renderList(spec.writeAllowlist),
      "",
      "Forbidden scope:",
      renderList(spec.forbiddenScope),
      "",
      "Success criteria:",
      renderList(spec.successCriteria),
      "",
      "Make only the requested edits. Return a concise final summary of the work performed.",
    ].join("\n");
    const legacyHash = createHash("sha256").update(legacyPrompt).digest("hex");

    // The legacy hash and current hash differ because of actionPreamble and lint-before-typecheck instruction
    expect(currentHash).not.toBe(legacyHash);

    // For Codex, its prompt previously matched currentPrompt (with preamble and lint-before-typecheck)
    // For agy, claude, opencode, pi, pythinker, their prompt changed from legacy to current
    for (const lane of lanes) {
      const adapter = lane.createAdapter();
      const invocation = adapter.buildInvocation(spec, invocationContext(false));
      const prompt = extractPrompt(lane.id, invocation.args, invocation.stdin);
      const hash = createHash("sha256").update(prompt).digest("hex");
      expect(hash).toBe(currentHash);
    }
  });

  it("renderList formats empty and populated string arrays correctly", () => {
    expect(renderList([])).toBe("- (none)");
    expect(renderList(["a"])).toBe("- a");
    expect(renderList(["item 1", "item 2"])).toBe("- item 1\n- item 2");
  });
});
