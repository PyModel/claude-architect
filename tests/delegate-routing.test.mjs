import assert from "node:assert/strict";
import fs from "node:fs";

const skill = fs.readFileSync(new URL("../skills/delegate/SKILL.md", import.meta.url), "utf8");

assert.match(skill, /If the user invokes `\/claude-architect:delegate` without naming a CLI, implementer, or agent, use the host's structured question tool when available, ask this question, and wait for the answer\./);
assert.match(skill, /Which CLI should handle this delegation\?.*Use a custom answer to name a different supported reasoning level\./);

for (const lane of ["codex-implementer", "opencode-implementer", "pi-implementer", "pythinker-implementer", "agy-implementer", "claude-implementer"]) {
  assert.ok(skill.includes(`\`${lane}\``), `delegate question must offer ${lane}`);
}

assert.match(skill, /GPT-5\.6 Sol at `low` reasoning by default \(supported overrides: `medium`, `high`, `xhigh`, `max`, `ultra`\)/);
assert.match(skill, /model-specific `--variant`/);
assert.match(skill, /`--thinking off\|minimal\|low\|medium\|high\|xhigh\|max`/);
assert.match(skill, /`pi-implementer`; always uses the model configured in Pi/);
assert.match(skill, /The Pi lane accepts no model override: it always runs the model configured in Pi/);
assert.doesNotMatch(skill, /--thinking-effort/);
assert.match(skill, /the installed pythinker-code CLI exposes no reasoning override, so the Pythinker configured default always applies/);
assert.match(skill, /`--effort low\|medium\|high`/);
assert.match(skill, /`--model opus\|sonnet\|fable\|haiku`/);
assert.match(skill, /`--effort low\|medium\|high\|xhigh\|max`/);
assert.match(skill, /include it in the delegation spec/);

assert.doesNotMatch(skill, /Use Codex by default|default implementation lane/);
assert.doesNotMatch(skill, /^## Legacy migration fallback$/mu);

assert.match(skill, /verification command uses `args`, not `argv`/u);
assert.match(skill, /`network` is exactly `"denied"` or `"allowed"`/u);
assert.match(skill, /command `timeoutMs` must be 1\.\.1800000/u);
assert.match(skill, /attempt `timeoutMs` must be 600000\.\.1800000/u);
assert.match(skill, /`producerPreferences` is an ordered array of Producer id strings/u);
assert.match(skill, /`producerOverrides: \{ model\?, reasoningEffort\? \}`/u);
assert.match(skill, /when present, `review\.focus` must be a non-empty array of non-empty strings/u);
assert.match(skill, /tracked or unignored changes must be committed before delegation/u);

console.log("PASS: unspecified delegations require an explicit CLI selection.");
