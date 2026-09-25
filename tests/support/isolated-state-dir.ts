import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll } from "vitest";

// Test files that name no state directory fall back to `os.tmpdir()`, which
// every parallel test file shares. Removal manifests there are repository-wide
// guards, so one file's pending manifest could block another's worktree
// mutations. Each file gets its own root unless it chooses one itself.
if (process.env.CLAUDE_PLUGIN_DATA === undefined
  && process.env.CLAUDE_ARCHITECT_STATE_DIR === undefined) {
  const stateDirectory = mkdtempSync(path.join(tmpdir(), "ca-test-state-"));
  process.env.CLAUDE_ARCHITECT_STATE_DIR = stateDirectory;
  afterAll(() => {
    rmSync(stateDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
}
