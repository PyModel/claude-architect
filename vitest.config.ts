import { defineConfig } from "vitest/config";
// Scope to tests/runtime/ only: all new runtime suites live there. The legacy
// tests/*.test.mjs files are node:test-based and run via `node`/`bash` in
// scripts/validate-release.sh — vitest must not collect them.
// hookTimeout is raised above vitest's 10s default because the runtime suites
// tear down real Git worktrees and state roots; on Windows those removals
// retry against open handles and routinely exceed ten seconds.
export default defineConfig({
  test: {
    include: ["tests/runtime/**/*.test.{ts,mjs}"],
    environment: "node",
    setupFiles: ["tests/support/isolated-state-dir.ts"],
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
