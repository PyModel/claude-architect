#!/usr/bin/env bash

set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)

fail() {
  printf 'FAIL: %s\n' "$1" >&2
  exit 1
}

# This gate retains the old release-test entrypoint while enforcing its
# post-migration contract: implementation is available only through the MCP
# runtime, never through a packaged prose agent or shell launcher.
for launcher in \
  run-isolated.sh \
  run-codex-isolated.sh \
  run-opencode-isolated.sh \
  run-pi-isolated.sh \
  run-pythinker-isolated.sh; do
  [[ ! -e "$ROOT/scripts/$launcher" ]] || fail "retired launcher still exists: scripts/$launcher"
done

for agent in \
  codex-implementer.md \
  opencode-implementer.md \
  pi-implementer.md \
  pythinker-implementer.md; do
  [[ ! -e "$ROOT/agents/$agent" ]] || fail "retired Claude agent still exists: agents/$agent"
done

if [[ -d "$ROOT/.opencode/agents" ]]; then
  while IFS= read -r legacy_agent; do
    fail "retired OpenCode agent still exists: ${legacy_agent#"$ROOT/"}"
  done < <(find "$ROOT/.opencode/agents" -type f -print)
fi

[[ -f "$ROOT/runtime/bootstrap.mjs" ]] || fail 'missing MCP bootstrap runtime'
[[ -f "$ROOT/runtime/server.mjs" ]] || fail 'missing packaged MCP server runtime'
[[ -f "$ROOT/src/mcp/server.ts" ]] || fail 'missing MCP server source'

for producer in codex opencode pi pythinker agy claude; do
  [[ -f "$ROOT/src/producers/$producer-adapter.ts" ]] ||
    fail "missing MCP Producer adapter: src/producers/$producer-adapter.ts"
done

grep -Fq 'each agent launches an *untrusted Producer* through the trusted MCP runtime' \
  "$ROOT/skills/delegate/SKILL.md" || fail 'delegate skill does not route all Producers through MCP'
grep -Fq 'fails closed with the structured diagnostic' \
  "$ROOT/skills/delegate/SKILL.md" || fail 'delegate skill does not fail closed on ineligible lanes'

printf 'PASS: retired lane launchers are absent and every Producer routes through the MCP runtime.\n'
