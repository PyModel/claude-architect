import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  access,
  lstat,
  open,
  realpath,
  rename,
  rm,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  PlatformServices,
  ResolvedExecutable,
  SpawnRequest,
  SupervisedProcess,
} from "../platform/platform-services.js";
import { RuntimeError } from "../util/errors.js";
import type { ArtifactStore } from "./artifact-store.js";
import { flushDirectory } from "../platform/durable-directory.js";

const NO_FOLLOW = constants.O_NOFOLLOW ?? 0;

export interface RunStartRecord {
  runId: string;
  lockKey: string;
  canonicalCommonDir: string;
  pid: number | null;
  processToken: string | null;
  startedAt: string;
  /**
   * SHA-256 over the canonical spec JSON. Lane dispatch computes this to
   * correlate a run whose report was lost or fabricated, but nothing persisted
   * it, so the documented recovery ("find the run whose recorded spec matches")
   * was impossible. Absent on records written before it was recorded.
   */
  specSha256?: string;
}

export interface RunStartTarget {
  publicDirectory: string;
  canonicalDirectory: string;
  identity: { dev: number; ino: number };
}

export interface RunStartContext {
  target: RunStartTarget;
  record: RunStartRecord;
}

export async function resolveWatchdogPath(): Promise<string> {
  // Source layout: src/runtime/ → ../../runtime/.
  // Bundled layout: runtime/server.mjs → ./.
  const candidates = [
    new URL("../../runtime/watchdog.mjs", import.meta.url),
    new URL("./watchdog.mjs", import.meta.url),
  ];
  let lastError: unknown;
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return fileURLToPath(candidate);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

export async function parentDeathWatchdogInvocation(
  executable: ResolvedExecutable,
  args: string[],
): Promise<{ executable: ResolvedExecutable; args: string[] }> {
  return {
    executable: {
      kind: "native",
      command: process.execPath,
      prefixArgs: [],
      resolvedFrom: "runtime-watchdog",
    },
    args: [
      await resolveWatchdogPath(),
      String(process.pid),
      "--",
      executable.command,
      ...executable.prefixArgs,
      ...args,
    ],
  };
}

function assertDirectoryIdentity(target: RunStartTarget): Promise<void> {
  return Promise.all([
    lstat(target.publicDirectory),
    realpath(target.publicDirectory),
  ]).then(([metadata, canonical]) => {
    if (!metadata.isDirectory()
      || metadata.isSymbolicLink()
      || metadata.dev !== target.identity.dev
      || metadata.ino !== target.identity.ino
      || canonical !== target.canonicalDirectory) {
      throw new RuntimeError("run archive directory identity changed");
    }
  });
}

export async function writeRunStart(
  target: RunStartTarget,
  record: RunStartRecord,
  create: boolean,
): Promise<void> {
  await assertDirectoryIdentity(target);
  const destination = path.join(target.canonicalDirectory, "run-start.json");
  const serialized = `${JSON.stringify(record, null, 2)}\n`;
  if (create) {
    const handle = await open(
      destination,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NO_FOLLOW,
      0o600,
    );
    try {
      await handle.writeFile(serialized, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await flushDirectory(target.canonicalDirectory);
    await assertDirectoryIdentity(target);
    return;
  }

  const temporaryPath = path.join(
    target.canonicalDirectory,
    `.run-start.${randomUUID()}.tmp`,
  );
  let created = false;
  let handle;
  try {
    handle = await open(
      temporaryPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NO_FOLLOW,
      0o600,
    );
    created = true;
    await handle.writeFile(serialized, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await assertDirectoryIdentity(target);
    await rename(temporaryPath, destination);
    created = false;
    await flushDirectory(target.canonicalDirectory);
    await assertDirectoryIdentity(target);
  } finally {
    await handle?.close();
    if (created) await rm(temporaryPath, { force: true });
  }
}

export async function initializeRunStart(
  store: ArtifactStore,
  record: RunStartRecord,
): Promise<RunStartContext> {
  await store.writeLog("lifecycle", "attempt lock acquired\n");
  const canonicalDirectory = await realpath(store.runDirectory);
  const metadata = await lstat(store.runDirectory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new RuntimeError("run archive directory is not a plain directory");
  }
  const target: RunStartTarget = {
    publicDirectory: store.runDirectory,
    canonicalDirectory,
    identity: { dev: metadata.dev, ino: metadata.ino },
  };
  await writeRunStart(target, record, true);
  return { target, record };
}

export function withRunStartPidRecording(
  ps: PlatformServices,
  context: RunStartContext,
): PlatformServices {
  return {
    os: ps.os,
    resolveExecutable: request => ps.resolveExecutable(request),
    async spawnSupervised(request: SpawnRequest): Promise<SupervisedProcess> {
      const process = await ps.spawnSupervised(request);
      if (process.pid > 1) {
        try {
          const processToken = await ps.getProcessStartToken(process.pid).catch(() => null);
          await writeRunStart(
            context.target,
            { ...context.record, pid: process.pid, processToken },
            false,
          );
        } catch (error) {
          await ps.terminateProcessTree(process).catch(() => {});
          throw error;
        }
      }
      return process;
    },
    requestCooperativeCancellation: process => ps.requestCooperativeCancellation(process),
    terminateProcessTree: process => ps.terminateProcessTree(process),
    getProcessStartToken: pid => ps.getProcessStartToken(pid),
    terminateProcessTreeByPid: (pid, expectedToken) =>
      ps.terminateProcessTreeByPid(pid, expectedToken),
    acquireCheckoutLock: checkout => ps.acquireCheckoutLock(checkout),
    acquireCleanupJournalLock: () => ps.acquireCleanupJournalLock(),
    createSecureTempDirectory: () => ps.createSecureTempDirectory(),
    canonicalizePath: input => ps.canonicalizePath(input),
    assertDirectoryWriteIntegrity: (directory, identity) =>
      ps.assertDirectoryWriteIntegrity(directory, identity),
  };
}
