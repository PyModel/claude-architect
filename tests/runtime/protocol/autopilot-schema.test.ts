import { describe, expect, it } from "vitest";
import { validateAutopilotSpec } from "../../../src/protocol/spec-validator.js";

const verification = [{
  id: "typecheck",
  executable: "npx",
  args: ["tsc", "--noEmit"],
  cwd: ".",
  timeoutMs: 120_000,
  network: "denied" as const,
  expectedExitCodes: [0],
}];

function verificationCommands() {
  return verification.map(command => ({
    ...command,
    args: [...command.args],
    expectedExitCodes: [...command.expectedExitCodes],
  }));
}

function delegation(objective: string) {
  return {
    specVersion: "1",
    objective,
    context: "Repository contracts are authoritative.",
    writeAllowlist: ["src/**", "tests/**"],
    forbiddenScope: [".git/**"],
    successCriteria: ["The named behavior is covered by a failing-first test."],
    verification: verificationCommands(),
    executionMode: "edit",
    timeoutMs: 600_000,
    producerPreferences: ["codex"],
    expectedOutput: "candidate-patch",
  };
}

// Deliberately not exported: importing a fixture from a `.test.ts` module
// would re-run this suite's describe blocks in the importing suite.
function validAutopilotSpec() {
  return {
    specVersion: "2",
    topic: "delegation-autopilot",
    base: { remote: "origin", branch: "main" },
    tasks: [
      {
        id: "contracts",
        commitMessage: "feat(runtime): add autopilot contracts",
        delegation: delegation("Add contracts"),
      },
      {
        id: "controller",
        commitMessage: "feat(runtime): add autopilot controller",
        delegation: delegation("Add controller"),
      },
    ],
    finalSuccessCriteria: ["The complete branch passes every release gate."],
    finalVerification: verificationCommands(),
  };
}

describe("Autopilot Spec v2", () => {
  it("accepts the canonical fixture", () => {
    expect(validateAutopilotSpec(validAutopilotSpec())).toMatchObject({ ok: true });
  }, 5_000);

  it("names the retired v1 contract instead of reporting a generic schema error", () => {
    const spec: any = validAutopilotSpec();
    spec.specVersion = "1";
    expect(validateAutopilotSpec(spec)).toEqual({
      ok: false,
      errors: [expect.objectContaining({
        path: "#/specVersion",
        message: expect.stringContaining("final-reviewed local branch"),
      })],
    });
  });

  it("accepts inclusive task, topic, and commit-byte boundaries", () => {
    const spec = validAutopilotSpec();
    spec.topic = "abc";
    spec.tasks = [spec.tasks[0]!];
    spec.tasks[0]!.commitMessage = "a".repeat(200);
    expect(validateAutopilotSpec(spec)).toMatchObject({ ok: true });

    spec.topic = `a${"b".repeat(46)}z`;
    expect(validateAutopilotSpec(spec)).toMatchObject({ ok: true });
  }, 5_000);

  it.each([
    ["unknown top-level key", (s: any) => { s.extra = true; }],
    ["unknown base key", (s: any) => { s.base.extra = true; }],
    ["unknown task key", (s: any) => { s.tasks[0].extra = true; }],
    ["unknown embedded delegation key", (s: any) => {
      s.tasks[0].delegation.extra = true;
    }],
    ["unknown final verification key", (s: any) => {
      s.finalVerification[0].extra = true;
    }],
    ["a shipping section (v1 contract)", (s: any) => {
      s.shipping = { provider: "github", draft: true };
    }],
    ["no tasks", (s: any) => { s.tasks = []; }],
    ["more than 32 tasks", (s: any) => {
      s.tasks = Array.from({ length: 33 }, (_, index) => ({
        id: `task-${index}`,
        commitMessage: `feat: add task ${index}`,
        delegation: delegation(`Add task ${index}`),
      }));
    }],
    ["duplicate task id", (s: any) => { s.tasks[1].id = s.tasks[0].id; }],
    ["invalid short topic", (s: any) => { s.topic = "ab"; }],
    ["invalid long topic", (s: any) => { s.topic = `a${"b".repeat(48)}`; }],
    ["invalid topic characters", (s: any) => { s.topic = "Delegation_Autopilot"; }],
    ["empty final criteria", (s: any) => { s.finalSuccessCriteria = []; }],
    ["empty final verification", (s: any) => { s.finalVerification = []; }],
    ["non-origin remote", (s: any) => { s.base.remote = "upstream"; }],
    ["non-main target", (s: any) => { s.base.branch = "develop"; }],
    ["the retired v1 version", (s: any) => { s.specVersion = "1"; }],
    ["multiline commit message", (s: any) => {
      s.tasks[0].commitMessage = "feat: x\nbody";
    }],
    ["control character in commit message", (s: any) => {
      s.tasks[0].commitMessage = "feat: x\u0000";
    }],
    ["Co-Authored-By attribution", (s: any) => {
      s.tasks[0].commitMessage = "feat: x Co-Authored-By: model";
    }],
    ["generated-by attribution", (s: any) => {
      s.tasks[0].commitMessage = "feat: x Generated-By: Claude";
    }],
    ["AI-generated attribution", (s: any) => {
      s.tasks[0].commitMessage = "feat: x (AI-generated)";
    }],
    ["generated-with attribution", (s: any) => {
      s.tasks[0].commitMessage = "feat: x (Generated with Claude Code)";
    }],
    ["OpenAI generated-with attribution", (s: any) => {
      s.tasks[0].commitMessage = "feat: x (Generated with OpenAI)";
    }],
    ["Anthropic generated-by attribution", (s: any) => {
      s.tasks[0].commitMessage = "feat: x (Generated by Anthropic)";
    }],
    ["unrecognized-producer generated-with attribution", (s: any) => {
      s.tasks[0].commitMessage = "feat: x (Generated with FutureProducer)";
    }],
    ["empty commit message", (s: any) => { s.tasks[0].commitMessage = ""; }],
    ["whitespace-only commit message", (s: any) => { s.tasks[0].commitMessage = "   "; }],
    ["commit message over 200 UTF-8 bytes", (s: any) => {
      s.tasks[0].commitMessage = "é".repeat(101);
    }],
  ] as const)("rejects %s", (_name, mutate) => {
    const spec = validAutopilotSpec();
    mutate(spec);
    const result = validateAutopilotSpec(spec);
    expect(result).toMatchObject({ ok: false });
    // A rejection must always name a reason: schema errors are filtered when
    // they are re-reported per task, and a filtered-to-empty list would reject
    // the spec while telling the caller nothing.
    if (result.ok) return;
    expect(result.errors.length).toBeGreaterThan(0);
  }, 5_000);

  it("prefixes canonical Delegation Spec errors with the task id", () => {
    const spec = validAutopilotSpec();
    spec.tasks[0]!.delegation.verification[0]!.cwd = "../escape";

    const result = validateAutopilotSpec(spec);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toContainEqual({
      path: "#/tasks/contracts/delegation/verification/0/cwd",
      message: "must be a repository-relative path that does not escape the checkout",
    });
  }, 5_000);

  it("emits structural Delegation Spec errors once with the task id prefix", () => {
    const spec = validAutopilotSpec();
    delete (spec.tasks[0]!.delegation as Partial<ReturnType<typeof delegation>>).objective;

    const result = validateAutopilotSpec(spec);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    const objectiveErrors = result.errors.filter(error => error.message.includes("objective"));
    expect(objectiveErrors).toEqual([{
      path: "#/tasks/contracts/delegation/required",
      message: "must have required property 'objective'",
    }]);
    expect(result.errors.some(error => error.path.startsWith("/tasks/0/delegation"))).toBe(false);
  }, 5_000);
});
