---
name: codex
description: Run the Codex CLI directly in the user's checkout for code analysis, refactoring, or automated editing without Claude Architect's verified delegation lifecycle.
---

# Codex Skill Guide

Always present this skill as `/architect:codex`. Never show a shorter command.

## Trust boundary

`/architect:codex` is the direct, unverified lane: it runs `codex exec` against the user's checkout without an isolated worktree, frozen Candidate Artifact, or independent verification. Use it for direct CLI assistance when those controls are not required. Use `/architect:delegate` for the verified lane when changes need isolation, a frozen Candidate Artifact, independent verification, and controlled integration.

Only `/architect:delegate` produces a frozen, independently verified Candidate Artifact and drives review, decision, and guarded integration. This direct skill must never call itself verified or invoke those lifecycle tools.

## Running a Task
1. For a new session (resumes inherit the prior model/effort — see step 5), ask the user (via `AskUserQuestion`) which **model** AND which **reasoning effort** to use, in a **single prompt with two questions**. When the user expresses no preference, default to `gpt-6.1-sol` at `high`.
   - **Model** — default `gpt-6.1-sol`:
     - *GPT-6:* `gpt-6.1-sol` (latest workhorse — **default**), `gpt-6-astra` (frontier), `gpt-6-sol` (previous generation), `gpt-6-luna` (fast & affordable)
     - *Legacy (kept for compatibility):* `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`, `gpt-5.5`, `gpt-5.4`, `gpt-5.4-mini`, `gpt-5.3-codex-spark`, `gpt-5.3-codex`
   - **Reasoning effort** — default `high`: `low`, `medium`, `high`, `xhigh`, `max`, `ultra`.
     - `max`/`ultra` require a GPT-6 model or a legacy GPT-5.6 model; `ultra` is only on `gpt-6.1-sol`, `gpt-6-astra`, `gpt-6-sol` and legacy `gpt-5.6-sol`/`gpt-5.6-terra` (luna variants cap at `max`); other legacy models cap at `xhigh`.
     - `ultra` = maximum reasoning **with automatic task delegation** (slowest and most expensive — reserve for the hardest jobs).
     - If the chosen effort exceeds the chosen model's maximum, fall back to that model's highest supported effort and tell the user.
2. Select the sandbox mode required for the task; default to `--sandbox read-only` unless edits or network access are necessary.
3. Assemble the command with the appropriate options:
   - `-m, --model <MODEL>`
   - `--config model_reasoning_effort="<low|medium|high|xhigh|max|ultra>"` (max/ultra only on GPT-6 and legacy GPT-5.6 models; ultra not on luna — see step 1)
   - `--sandbox <read-only|workspace-write|danger-full-access>`
   - `-C, --cd <DIR>`
   - `--skip-git-repo-check`
   - `"your prompt here"` (as final positional argument)
4. Always use --skip-git-repo-check.
5. When continuing a previous session, prefer the positional form `codex exec --skip-git-repo-check resume --last "prompt"`. Resumed sessions inherit the prior model, reasoning effort, and sandbox. Do not add configuration flags unless the user explicitly requests an override; any such flags belong between `exec` and `resume`.
6. **IMPORTANT (stderr)**: Never discard stderr. `codex exec` sends progress, warnings, and diagnostics to stderr and its final agent message to stdout. Capture both streams separately, preserve a nonzero exit as failure, and summarize progress only after retaining actionable diagnostics.
7. **IMPORTANT (stdin)**: Prefer a positional prompt for new and resumed sessions. In a harness that may leave stdin open, close it explicitly without redirecting stderr:
   - POSIX: append `</dev/null`, for example `codex exec --skip-git-repo-check --sandbox read-only "prompt" </dev/null`.
   - PowerShell: prefix the native command with `$null |`, for example `$null | codex exec --skip-git-repo-check --sandbox read-only "prompt"`.
   - `cmd.exe`: append `<NUL`, for example `codex exec --skip-git-repo-check --sandbox read-only "prompt" <NUL`.
   - Process APIs: spawn with `stdio: ["ignore", "pipe", "pipe"]` so stdin is closed while stdout and stderr remain distinct.
8. Run the command, capture stdout and stderr separately, and summarize the outcome for the user.
9. **After Codex completes**, inform the user: "You can resume this Codex session at any time by saying 'codex resume' or asking me to continue with additional analysis or changes."

### Quick Reference
| Use case | Command |
| --- | --- |
| Read-only review or analysis | `codex exec --skip-git-repo-check --sandbox read-only "prompt"` |
| Apply local edits | `codex exec --skip-git-repo-check --sandbox workspace-write "prompt"` |
| Permit network or broad access | `codex exec --skip-git-repo-check --sandbox danger-full-access "prompt"` |
| Resume recent session | `codex exec --skip-git-repo-check resume --last "prompt"` |
| Run from an explicit directory | `codex exec --skip-git-repo-check -C . --sandbox read-only "prompt"` |

## Execution timeouts

Codex streams intermediate progress to stderr and writes the final agent message to stdout. An empty stdout does not prove the process is hung; inspect retained stderr and the process state. If the process is killed before finishing, treat the run as failed even if it emitted partial output.

**Preferred approach:** run synchronously — eliminates timeout risk entirely and the conversation waits for the result anyway.

**If running in background**, set the execution timeout based on reasoning effort:

| Reasoning effort | Timeout |
|---|---|
| `low` | 150s |
| `medium` | 300s |
| `high` | 600s |
| `xhigh` | 1200s |
| `max` | 1800s |
| `ultra` | 1800s |

## Following Up
- After every `codex` command, immediately use `AskUserQuestion` to confirm next steps, collect clarifications, or decide whether to resume with `codex exec resume --last`.
- When resuming, pass the new prompt positionally: `codex exec --skip-git-repo-check resume --last "new prompt"`. The resumed session automatically uses the same model, reasoning effort, and sandbox mode from the original session.
- Restate the chosen model, reasoning effort, and sandbox mode when proposing follow-up actions.

## Critical Evaluation of Codex Output

Codex is powered by OpenAI models with their own knowledge cutoffs and limitations. Treat Codex as a **colleague, not an authority**.

### Guidelines
- **Trust your own knowledge** when confident. If Codex claims something you know is incorrect, push back directly.
- **Research disagreements** using WebSearch or documentation before accepting Codex's claims. Share findings with Codex via resume if needed.
- **Remember knowledge cutoffs** - Codex may not know about recent releases, APIs, or changes that occurred after its training data.
- **Don't defer blindly** - Codex can be wrong. Evaluate its suggestions critically, especially regarding:
  - Model names and capabilities
  - Recent library versions or API changes
  - Best practices that may have evolved

### When Codex is Wrong
1. State your disagreement clearly to the user
2. Provide evidence (your own knowledge, web search, docs)
3. Optionally resume the Codex session to discuss the disagreement. **Identify yourself as Claude** so Codex knows it's a peer AI discussion. Use your actual model name (e.g., the model you are currently running as) instead of a hardcoded name:
   ```bash
   codex exec --skip-git-repo-check resume --last "This is Claude (<your current model name>) following up. I disagree with [X] because [evidence]. What's your take on this?"
   ```
4. Frame disagreements as discussions, not corrections - either AI could be wrong
5. Let the user decide how to proceed if there's genuine ambiguity

## Error Handling
- Stop and report failures whenever `codex --version` or a `codex exec` command exits non-zero; request direction before retrying.
- Before you use high-impact flags (`--sandbox danger-full-access`, `--skip-git-repo-check`) ask the user for permission using AskUserQuestion unless it was already given.
- When output includes warnings or partial results, summarize them and ask how to adjust using `AskUserQuestion`.
