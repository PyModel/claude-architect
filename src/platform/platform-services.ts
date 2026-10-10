import type { DirectoryIdentity } from "./durable-directory.js";

export interface ExecutableRequest {
  name: string;                     // e.g. "codex", "git", "node"
  explicitPath?: string;
  searchPath?: string;              // overrides process PATH when set
}
export interface ResolvedExecutable {
  kind: "native" | "node-entrypoint" | "cmd-wrapper";
  command: string;                  // argv[0] actually spawned
  prefixArgs: string[];             // e.g. ["<entry.js>"] for node-entrypoint
  resolvedFrom: string;             // provenance for the Run Manifest
}
export interface SpawnRequest {
  executable: ResolvedExecutable;
  args: string[];
  cwd: string;
  env: Record<string, string>;      // fully constructed; host env NOT inherited wholesale
  timeoutMs: number;
  stdin?: string;
  maxOutputBytes: number;
}
export interface SupervisedProcess {
  pid: number;
  done: Promise<SupervisedExit>;
  stdout: NodeJS.ReadableStream;
  stderr: NodeJS.ReadableStream;
}
export interface SupervisedExit {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  cancelled: boolean;
  stdout: string;                   // bounded; truncation recorded in truncated
  stderr: string;
  truncated: { stdout: boolean; stderr: boolean };
  spawnError?: unknown;             // set when the child emitted 'error' before start (→ spawn-failure)
}
export interface FileLock {
  key: string;
  release(): Promise<void>;
}
export interface CheckoutLock extends FileLock {
  readonly repositoryIdentity: string;
}
export interface CanonicalPath { input: string; canonical: string; gitCommonDir: string | null; }

/**
 * Diagnostic-only fields recorded alongside a lock's owner. They name the work
 * that holds the lock so a contending caller can say which run to look at.
 * Never consulted when deciding whether a lock may be reclaimed.
 */
export interface LockOwnerAnnotation { runId?: string }

export interface PlatformServices {
  os: "darwin" | "linux" | "win32";
  resolveExecutable(request: ExecutableRequest): Promise<ResolvedExecutable>;
  spawnSupervised(request: SpawnRequest): Promise<SupervisedProcess>;
  requestCooperativeCancellation(process: SupervisedProcess): Promise<void>;
  terminateProcessTree(process: SupervisedProcess): Promise<void>;
  /** Opaque per-boot-stable identity for a live pid; null when dead/undeterminable. */
  getProcessStartToken(pid: number): Promise<string | null>;
  terminateProcessTreeByPid(pid: number, expectedToken?: string | null): Promise<void>;   // crash recovery: kill a tree by recorded pid (no live SupervisedProcess). POSIX: kill(-pid); ESRCH treated as success.
  acquireCheckoutLock(checkout: string, owner?: LockOwnerAnnotation): Promise<CheckoutLock>;
  /**
   * Cross-process mutex over the shared cleanup journal (state-dir scoped, fixed
   * key). All journal appends and the recovery torn-tail truncation acquire it so
   * a truncation can never erase an intent a concurrent process appended+fsynced.
   * A leaf lock: never held while acquiring another lock. Reclaimed like any lock.
   */
  acquireCleanupJournalLock(): Promise<FileLock>;
  createSecureTempDirectory(): Promise<string>;
  canonicalizePath(path: string): Promise<CanonicalPath>;
  assertDirectoryWriteIntegrity(
    directory: string,
    expectedIdentity: DirectoryIdentity,
  ): Promise<void>;
}
