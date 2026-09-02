# Codex Runner Stdin Forwarding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore the documented Codex prompt-over-stdin path in both process-isolation branches, protect it with deterministic regression coverage, and ship the source fix as marketplace release `0.4.0`.

**Architecture:** Keep the existing isolated process-group lifecycle unchanged. Add an explicit `<&0` redirection to each background launch so Bash does not replace stdin with `/dev/null`; test both launch branches using controlled `PATH` shims and a fake Codex executable that records stdin. Publish from tracked source, then reinstall through Claude's normal marketplace flow rather than editing generated mirrors.

**Tech Stack:** Bash, Perl/POSIX `setsid`, Node.js manifest test, Claude Code plugin CLI, Git.

## Global Constraints

- Do not edit `~/.claude/plugins/cache/**` or `~/.claude/plugins/marketplaces/**` by hand.
- Keep the production patch to the two launch lines in `scripts/run-codex-isolated.sh`; do not introduce fd 3, a new environment switch, or a launcher abstraction.
- Preserve all existing process-group cleanup, timeout, Codex flags, exit-status, and trap behavior.
- Cover both the external-`setsid` and Perl-fallback branches without invoking real Codex or repeating the five delegated task experiment.
- Do not change `agents/codex-implementer.md`; its `- < "$SPEC"` contract is already correct.
- Do not attempt to “fix” the false fib lane report in code; independent architect verification already remains mandatory in `agents/codex-implementer.md` and `skills/delegate/SKILL.md`.
- The next marketplace release is `0.4.0`, not a patch version.
- Keep `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`, the README badge, and `CHANGELOG.md` synchronized at `0.4.0`.
- Run `bash scripts/validate-release.sh` successfully before creating or pushing `v0.4.0`.
- Obtain explicit user confirmation immediately before `git push`; never bypass hooks or signing.

## Confirmed Baseline

- Commits `71ed13e` and `960bdcf` changed manifest/release surfaces, not `scripts/run-codex-isolated.sh`.
- Commit `130d4a7` introduced both background launches now at `scripts/run-codex-isolated.sh:35,37`.
- `agents/codex-implementer.md:56-64` invokes the runner with `- < "$SPEC"`.
- `tests/codex-lifecycle.test.sh:27-49` checks arguments and worker cleanup but does not read or assert stdin and follows only the host-selected isolation branch.
- The current `0.3.0` release gate passes, which is expected because stdin is not covered.

## Design Decision

Use `<&0` directly on both background commands. The fd-3 variant is valid but adds descriptor setup and cleanup with no benefit here; consolidating the two launch branches would reduce one duplicated token sequence but expands a two-line correctness fix into an unnecessary structural refactor.

## File Map

- Modify `tests/codex-lifecycle.test.sh`: deterministically exercise both isolation branches and assert exact stdin forwarding plus existing argument/cleanup behavior.
- Modify `scripts/run-codex-isolated.sh`: preserve stdin on both asynchronous launch commands.
- Modify `.claude-plugin/plugin.json`: bump release version to `0.4.0`.
- Modify `.claude-plugin/marketplace.json`: bump marketplace version to `0.4.0`.
- Modify `README.md`: bump the version badge to `0.4.0`.
- Modify `CHANGELOG.md`: document the stdin fix and add the `0.4.0` release link.

---

### Task 1: Preserve and Regression-Test Runner Stdin

**Files:**
- Modify: `tests/codex-lifecycle.test.sh:1-56`
- Modify: `scripts/run-codex-isolated.sh:34-38`

**Interfaces:**
- Consumes: runner stdin exactly as supplied by `bash ... - < "$SPEC"`.
- Produces: unchanged runner arguments, exit status, timeout semantics, and process-group cleanup; exact stdin reaches `codex exec` in both isolation branches.

- [ ] **Step 1: Replace the lifecycle test with deterministic two-branch coverage**

Use this complete content for `tests/codex-lifecycle.test.sh`:

```bash
#!/usr/bin/env bash

set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)

assert_contains() {
  local file=$1
  local pattern=$2

  if ! grep -Eq -- "$pattern" "$file"; then
    printf 'FAIL: %s does not contain %s\n' "$file" "$pattern" >&2
    exit 1
  fi
}

assert_contains "$ROOT/agents/codex-implementer.md" 'run-codex-isolated\.sh'
assert_contains "$ROOT/.opencode/agents/codex-implementer.md" '--ignore-user-config'
assert_contains "$ROOT/.opencode/agents/codex-implementer.md" '--ephemeral'
assert_contains "$ROOT/skills/delegate/SKILL.md" 'claude-architect:codex-implementer'
assert_contains "$ROOT/skills/delegate/SKILL.md" 'codex:codex-rescue'
assert_contains "$ROOT/skills/delegate/SKILL.md" 'app-server'

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

BASH_BIN=$(command -v bash)
CAT_BIN=$(command -v cat)
PERL_BIN=$(command -v perl)
SLEEP_BIN=$(command -v sleep)

write_codex_stub() {
  local bin=$1

  cat > "$bin/codex" <<EOF
#!$BASH_BIN
printf '%s\n' "\$@" > "\$CODEX_TEST_ARGS"
"$CAT_BIN" > "\$CODEX_TEST_STDIN"
"$SLEEP_BIN" 30 &
printf '%s\n' "\$!" > "\$CODEX_TEST_WORKER_PID"
EOF
  chmod +x "$bin/codex"
}

write_setsid_stub() {
  local bin=$1

  cat > "$bin/setsid" <<EOF
#!$BASH_BIN
exec "$PERL_BIN" -MPOSIX -e 'POSIX::setsid() >= 0 or die "setsid: \$!"; exec @ARGV or die "exec: \$!"' "\$@"
EOF
  chmod +x "$bin/setsid"
}

run_case() {
  local mode=$1
  local bin="$TMP/$mode/bin"
  local state="$TMP/$mode/state"
  local expected_stdin="$state/expected-stdin"
  local actual_stdin="$state/actual-stdin"
  local worker_pid

  mkdir -p "$bin" "$state"
  write_codex_stub "$bin"
  ln -s "$PERL_BIN" "$bin/perl"
  ln -s "$SLEEP_BIN" "$bin/sleep"

  if [[ "$mode" == setsid ]]; then
    write_setsid_stub "$bin"
  fi

  printf 'objective: preserve stdin\nconstraint: keep process isolation\n' > "$expected_stdin"

  PATH="$bin" \
    CODEX_TIMEOUT_SECONDS=0 \
    CODEX_TEST_ARGS="$state/args" \
    CODEX_TEST_STDIN="$actual_stdin" \
    CODEX_TEST_WORKER_PID="$state/worker-pid" \
    "$BASH_BIN" "$ROOT/scripts/run-codex-isolated.sh" --model test-model - \
    < "$expected_stdin"

  grep -Fxq -- 'exec' "$state/args"
  grep -Fxq -- '--ignore-user-config' "$state/args"
  grep -Fxq -- '--ephemeral' "$state/args"
  grep -Fxq -- '--model' "$state/args"
  grep -Fxq -- 'test-model' "$state/args"

  if ! cmp -s "$expected_stdin" "$actual_stdin"; then
    printf 'FAIL: %s branch did not preserve runner stdin\n' "$mode" >&2
    diff -u "$expected_stdin" "$actual_stdin" >&2 || true
    exit 1
  fi

  worker_pid=$(<"$state/worker-pid")
  if kill -0 "$worker_pid" 2>/dev/null; then
    printf 'FAIL: %s branch left delegated worker %s running\n' "$mode" "$worker_pid" >&2
    exit 1
  fi

  printf 'PASS: %s branch preserves stdin and cleans up workers.\n' "$mode"
}

run_case setsid
run_case perl
```

The restricted `PATH` makes branch selection deterministic: the `setsid` case supplies a session-creating shim, while the `perl` case intentionally omits `setsid`. The fake Codex reads stdin before creating the worker whose cleanup is already under test.

- [ ] **Step 2: Run the regression test before changing the runner**

Run:

```bash
bash tests/codex-lifecycle.test.sh
```

Expected: non-zero exit at the exact-payload comparison, with `FAIL: setsid branch did not preserve runner stdin`. This is the TDD red state; do not weaken the assertion.

- [ ] **Step 3: Apply the minimal two-line runner fix**

Change only the launch block in `scripts/run-codex-isolated.sh`:

```diff
 if command -v setsid >/dev/null 2>&1; then
-  setsid "${COMMAND[@]}" &
+  setsid "${COMMAND[@]}" <&0 &
 else
-  perl -MPOSIX -e 'POSIX::setsid() >= 0 or die "setsid: $!"; exec @ARGV or die "exec: $!"' "${COMMAND[@]}" &
+  perl -MPOSIX -e 'POSIX::setsid() >= 0 or die "setsid: $!"; exec @ARGV or die "exec: $!"' "${COMMAND[@]}" <&0 &
 fi
```

- [ ] **Step 4: Verify both branches pass**

Run:

```bash
bash tests/codex-lifecycle.test.sh
```

Expected:

```text
PASS: setsid branch preserves stdin and cleans up workers.
PASS: perl branch preserves stdin and cleans up workers.
```

- [ ] **Step 5: Run focused static checks**

Run:

```bash
shellcheck scripts/run-codex-isolated.sh tests/codex-lifecycle.test.sh
git diff --check
```

Expected: both commands exit `0` with no output.

- [ ] **Step 6: Review the fix diff**

Run:

```bash
git diff -- scripts/run-codex-isolated.sh tests/codex-lifecycle.test.sh
```

Expected: one focused test-harness expansion and exactly two production-line changes; no agent, cache, marketplace-mirror, or unrelated edits.

- [ ] **Step 7: Commit the tested source fix**

```bash
git add scripts/run-codex-isolated.sh tests/codex-lifecycle.test.sh
git commit -m "Fix stdin forwarding in isolated Codex runner"
```

---

### Task 2: Prepare Marketplace Release 0.4.0

**Files:**
- Modify: `.claude-plugin/plugin.json:3`
- Modify: `.claude-plugin/marketplace.json:14`
- Modify: `README.md:17`
- Modify: `CHANGELOG.md:7-31`

**Interfaces:**
- Consumes: the tested runner fix from Task 1.
- Produces: a synchronized `0.4.0` marketplace release candidate accepted by the existing release gate.

- [ ] **Step 1: Bump every required version surface**

Apply these exact replacements:

```diff
-  "version": "0.3.0",
+  "version": "0.4.0",
```

in both `.claude-plugin/plugin.json` and `.claude-plugin/marketplace.json`.

In `README.md`, change only the version badge:

```diff
-  <img alt="version" src="https://img.shields.io/badge/version-0.3.0-9aa4b2?style=flat-square&labelColor=0b0e14">
+  <img alt="version" src="https://img.shields.io/badge/version-0.4.0-9aa4b2?style=flat-square&labelColor=0b0e14">
```

- [ ] **Step 2: Add the 0.4.0 changelog entry and link**

Insert above `0.3.0` in `CHANGELOG.md`:

```markdown
## [0.4.0] - 2026-07-13

### Fixed

- Preserved standard input when the isolated Codex runner starts its process group, restoring the documented prompt-file invocation in both `setsid` and Perl fallback environments.
```

Add this link before the existing `0.3.0` link:

```markdown
[0.4.0]: https://github.com/PyModel/claude-architect/releases/tag/v0.4.0
```

- [ ] **Step 3: Run the manifest test**

Run:

```bash
node tests/plugin-manifest.test.mjs
```

Expected:

```text
PASS: Claude plugin manifest uses the supported schema.
```

- [ ] **Step 4: Run the complete release gate**

Run:

```bash
bash scripts/validate-release.sh
```

Expected: exit `0`, including strict marketplace validation, the manifest PASS line, and PASS lines for both lifecycle-test branches. Stop here on any failure; do not tag or push.

- [ ] **Step 5: Check release diff integrity**

Run:

```bash
git diff --check
git diff -- .claude-plugin/plugin.json .claude-plugin/marketplace.json README.md CHANGELOG.md
```

Expected: no whitespace errors and only the synchronized `0.4.0` metadata/changelog changes.

- [ ] **Step 6: Commit the release candidate**

```bash
git add .claude-plugin/plugin.json .claude-plugin/marketplace.json README.md CHANGELOG.md
git commit -m "Release 0.4.0 with Codex stdin forwarding"
```

---

### Task 3: Publish and Resync the Installed Plugin

**Files:**
- Modify: none in the repository.
- Verify generated artifact: `~/.claude/plugins/cache/claude-architect/claude-architect/0.4.0/`

**Interfaces:**
- Consumes: clean `main` with the Task 1 fix commit and Task 2 release commit.
- Produces: annotated `v0.4.0`, pushed source, and a freshly installed cache artifact matching tracked source.

- [ ] **Step 1: Re-run the release gate immediately before publication**

Run:

```bash
bash scripts/validate-release.sh
git status --short
git log -2 --oneline
```

Expected: validation exits `0`, status prints nothing, and the two planned commits are at the tip of `main`. Stop on any mismatch.

- [ ] **Step 2: Obtain explicit user approval for network writes**

Show the validation result and proposed commands. Do not create the tag or push until the user explicitly approves in the active session.

- [ ] **Step 3: Create and push the release after approval**

```bash
git tag -a v0.4.0 -m "Release 0.4.0"
git push origin main
git push origin v0.4.0
```

Expected: both pushes succeed without force and without skipped hooks.

- [ ] **Step 4: Refresh through Claude's supported plugin flow**

```bash
claude plugin marketplace update claude-architect
claude plugin update claude-architect@claude-architect
claude plugin list
```

Expected: `claude-architect@claude-architect` is enabled at version `0.4.0`.

- [ ] **Step 5: Verify the installed artifact came from the release**

```bash
LIVE_ROOT="$HOME/.claude/plugins/cache/claude-architect/claude-architect/0.4.0"
test -f "$LIVE_ROOT/scripts/run-codex-isolated.sh"
cmp scripts/run-codex-isolated.sh "$LIVE_ROOT/scripts/run-codex-isolated.sh"
bash "$LIVE_ROOT/tests/codex-lifecycle.test.sh"
```

Expected: `test`, `cmp`, and the cached lifecycle test all exit `0`; the test prints PASS lines for both isolation branches. If the `0.4.0` cache directory is absent, troubleshoot the marketplace/update command—do not copy or edit cache files manually.

- [ ] **Step 6: Start a fresh Claude Code session before the next real delegation**

The new session must load plugin version `0.4.0`. Treat future lane completion claims as untrusted until the architect independently reads the diff and re-runs verification, preserving the acceptance boundary that caught the false fib report.
