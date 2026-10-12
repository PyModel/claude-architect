import { SANDBOX_BACKENDS, type SandboxBackend } from "../../src/platform/sandbox/backends.js";

export type SandboxPlatformRow = SandboxBackend["platforms"][number];

/**
 * Adds a platform row to a registered sandbox backend and returns the undo.
 *
 * The rows are a `ReadonlyArray`, so tests replace the backend's `platforms`
 * rather than mutate it. The undo removes this row by identity, so several
 * rows added to one backend can be undone in any order.
 */
export function addSandboxRow(
  backendId: string,
  row: SandboxPlatformRow,
  position: "first" | "last",
): () => void {
  const backend = SANDBOX_BACKENDS.find(candidate => candidate.id === backendId);
  if (backend === undefined) throw new Error(`${backendId} backend is missing`);
  backend.platforms = position === "first"
    ? [row, ...backend.platforms]
    : [...backend.platforms, row];
  return () => {
    backend.platforms = backend.platforms.filter(candidate => candidate !== row);
  };
}
