import type { DelegationSpec } from "../protocol/delegation-spec.js";
import { renderSkillBootstrap } from "./skill-bootstrap.js";

export const EDIT_ACTION_PREAMBLE = [
  "This is an action-first edit run.",
  "Constraints are fully pre-digested in this spec.",
  "Do not read repository AGENTS.md, CLAUDE.md, SKILL.md, lessons files, or any repository agent-rule/skill documents; the delegated skill files named below are permitted.",
  "Begin by opening the implementation files authorized in the spec.",
  "A plan-only final message with zero edits is a failed run.",
].join("\n");

export const LINT_BEFORE_TYPECHECK_INSTRUCTION =
  "If you run linting, formatting, or type checking, complete all linting and formatting first, then run a final type-check covering every typed file you changed, including new or modified tests.";

export function renderList(values: string[]): string {
  return values.length === 0 ? "- (none)" : values.map(value => `- ${value}`).join("\n");
}

export interface PromptRenderOptions {
  readOnly?: boolean;
  actionPreamble?: boolean;
  bootstrapPlacement?: "before" | "after";
}

export type PromptRenderInput =
  | boolean
  | PromptRenderOptions
  | { prompt?: PromptRenderOptions; readOnly?: boolean };

export function renderProducerPrompt(
  spec: DelegationSpec,
  options: PromptRenderInput = false,
): string {
  let opts: PromptRenderOptions;
  if (typeof options === "boolean") {
    opts = { readOnly: options };
  } else if ("prompt" in options && options.prompt !== undefined) {
    opts = {
      ...options.prompt,
      ...(options.readOnly !== undefined ? { readOnly: options.readOnly } : {}),
    };
  } else {
    opts = options as PromptRenderOptions;
  }
  const readOnly = opts.readOnly === true;
  const includeActionPreamble = opts.actionPreamble ?? !readOnly;
  const placement = opts.bootstrapPlacement ?? "before";

  const promptBody = [
    "You are an untrusted implementation Producer operating inside an isolated worktree.",
    "Do not delegate to other agents or expand the authorized scope.",
    ...(readOnly || placement !== "after" ? [] : ["", renderSkillBootstrap()]),
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
    LINT_BEFORE_TYPECHECK_INSTRUCTION,
    "",
    "Make only the requested edits. Return a concise final summary of the work performed.",
  ].join("\n");

  if (readOnly) {
    return promptBody;
  }

  const prefixParts: string[] = [];
  if (includeActionPreamble) {
    prefixParts.push(EDIT_ACTION_PREAMBLE);
  }
  if (placement === "before") {
    prefixParts.push(renderSkillBootstrap());
  }

  if (prefixParts.length === 0) {
    return promptBody;
  }

  return `${prefixParts.join("\n\n")}\n\n${promptBody}`;
}
