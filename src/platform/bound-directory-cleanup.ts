import { constants } from "node:fs";
import { access, lstat, open, rmdir, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { supervise } from "./process-supervisor.js";
import type { PlatformServices } from "./platform-services.js";
import { resolveWindowsFilesystemHelper } from "./windows-filesystem-helper.js";
import { windowsEssentialEnvironment } from "./windows-env.js";
import { RuntimeError } from "../util/errors.js";

const DEFAULT_EMPTY_DIRECTORY_TIMEOUT_MS = 120_000;
export const EMPTY_DIRECTORY_TIMEOUT_ENV = "CLAUDE_ARCHITECT_EMPTY_DIRECTORY_TIMEOUT_MS";

/**
 * How long the quarantine-emptying helper may run before a disposable
 * worktree's teardown is classified as timed out. The default budget is sized
 * for an ordinary checkout; a large `node_modules`/monorepo tree can
 * routinely exceed it. A worktree-teardown timeout no longer discards the
 * result it interrupts (baseline-verifier.ts records it as `cleanupIssue`
 * instead of overwriting the run's outcome), but the run still burns the
 * whole budget and defers the physical removal to a later recovery pass on
 * every single attempt against such a repository. Override this for
 * repositories with unusually large disposable worktrees; unset, empty, or
 * invalid values fail closed to the default rather than silently disabling
 * the bound (an unbounded budget would leave a wedged Producer process
 * uncleanable).
 */
export function resolveEmptyDirectoryTimeoutMs(
  env: NodeJS.ProcessEnv = process.env,
  warn: (message: string) => void = message => console.error(message),
): number {
  const raw = env[EMPTY_DIRECTORY_TIMEOUT_ENV];
  if (raw === undefined || raw === "") return DEFAULT_EMPTY_DIRECTORY_TIMEOUT_MS;
  const parsed = Number(raw);
  if (Number.isInteger(parsed) && parsed > 0) return parsed;
  warn(
    `${EMPTY_DIRECTORY_TIMEOUT_ENV}="${raw}" is not a positive integer; using the default `
    + `${DEFAULT_EMPTY_DIRECTORY_TIMEOUT_MS}ms.`,
  );
  return DEFAULT_EMPTY_DIRECTORY_TIMEOUT_MS;
}
const EMPTY_DIRECTORY_SCRIPT = String.raw`
const { execFileSync } = require("node:child_process");
const { randomUUID } = require("node:crypto");
const { constants, readFileSync } = require("node:fs");
const { lstat, open, readlink, realpath, readdir, rename, rmdir, unlink } = require("node:fs/promises");
const path = require("node:path");
const decodeMountPath = encoded => encoded.replace(/\\([0-7]{3})/g, (_, octal) =>
  String.fromCharCode(Number.parseInt(octal, 8)));
const isMountPoint = entry => {
  const absolute = path.resolve(entry);
  try {
    if (process.platform === "linux") {
      const mountInfo = readFileSync("/proc/self/mountinfo", "utf8");
      return mountInfo.split("\n").some(line => {
        const encoded = line.split(" ")[4];
        return encoded !== undefined && decodeMountPath(encoded) === absolute;
      });
    }
    if (process.platform === "darwin") {
      const output = execFileSync("/bin/df", ["-P", absolute], {
        encoding: "utf8",
        env: { LC_ALL: "C" },
        maxBuffer: 16_384,
        timeout: 5_000,
      });
      const line = output.trim().split("\n").at(-1) ?? "";
      const match = /^\S+\s+\d+\s+\d+\s+\d+\s+\d+%\s+(.+)$/u.exec(line);
      if (match === null) process.exit(40);
      return path.resolve(match[1]) === absolute;
    }
    return false;
  } catch {
    process.exit(40);
  }
};
const sameIdentity = (left, right) => left.dev === right.dev
  && left.ino === right.ino
  && left.birthtimeNs > 0n
  && left.birthtimeNs === right.birthtimeNs
  && left.isDirectory() === right.isDirectory()
  && left.isSymbolicLink() === right.isSymbolicLink();
// One lsof spawn resolves a whole batch of handles; per-directory spawns made
// large trees (node_modules) blow the cleanup budget.
const darwinHandlePaths = fds => {
  const output = execFileSync("/usr/sbin/lsof", [
    "-a", "-p", String(process.pid), "-d", fds.join(","), "-F0pn",
  ], { encoding: "utf8", env: {}, maxBuffer: 1_048_576, timeout: 5_000 });
  const paths = new Map();
  for (const match of output.matchAll(/(?:^|[\n\u0000])f(\d+)\u0000n([^\u0000]*)\u0000/gu)) {
    if (paths.has(match[1])) process.exit(50);
    paths.set(match[1], match[2]);
  }
  if (fds.some(fd => !paths.has(String(fd)))) process.exit(50);
  return paths;
};
const identityKey = stats => stats.dev + ":" + stats.ino + ":" + stats.birthtimeNs;
const DIRECTORY_BATCH = 64;
const removeDarwinBoundDirectories = async directories => {
  for (let start = 0; start < directories.length; start += DIRECTORY_BATCH) {
    const batch = directories.slice(start, start + DIRECTORY_BATCH);
    const handles = [];
    try {
      for (const [entry, expected] of batch) {
        const handle = await open(entry, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
        handles.push(handle);
        if (!sameIdentity(await handle.stat({ bigint: true }), expected)) process.exit(51);
      }
      const fds = handles.map(handle => handle.fd);
      const originalPaths = darwinHandlePaths(fds);
      for (const [index, [entry, expected]] of batch.entries()) {
        if (!sameIdentity(await lstat(entry, { bigint: true }), expected)) process.exit(61);
        await rmdir(entry);
        if (!sameIdentity(await handles[index].stat({ bigint: true }), expected)) process.exit(53);
      }
      const removedPaths = darwinHandlePaths(fds);
      for (const fd of fds) {
        if (removedPaths.get(String(fd)) !== originalPaths.get(String(fd))) process.exit(55);
      }
    } finally {
      for (const handle of handles) await handle.close();
    }
    const removed = new Set(batch.map(([, expected]) => identityKey(expected)));
    for (const sibling of await readdir(".")) {
      if (removed.has(identityKey(await lstat(sibling, { bigint: true })))) process.exit(46);
    }
  }
};
const removeBoundDirectories = async directories => {
  if (process.platform === "darwin") {
    await removeDarwinBoundDirectories(directories);
    return;
  }
  for (const [entry, expected] of directories) {
    await removeBoundEntry(entry, expected, true);
    for (const sibling of await readdir(".")) {
      if (sameIdentity(await lstat(sibling, { bigint: true }), expected)) process.exit(46);
    }
  }
};
// darwin resolves directory handles in batches (removeDarwinBoundDirectories).
const boundHandlePath = async fd => process.platform === "linux"
  ? await readlink("/proc/self/fd/" + fd)
  : null;
const removeBoundUnopenedEntry = async (entry, expected) => {
  const tombstone = ".remove-symlink-" + randomUUID();
  await rename(entry, tombstone);
  if (!sameIdentity(await lstat(tombstone, { bigint: true }), expected)) process.exit(59);
  await unlink(tombstone);
  for (const sibling of await readdir(".")) {
    if (sameIdentity(await lstat(sibling, { bigint: true }), expected)) process.exit(60);
  }
};
const removeBoundEntry = async (entry, expected, directory) => {
  if (process.platform === "win32" && !expected.isSymbolicLink()) {
    const helper = process.env.CLAUDE_ARCHITECT_WINDOWS_FILESYSTEM_HELPER;
    if (!helper) process.exit(58);
    const { CLAUDE_ARCHITECT_WINDOWS_FILESYSTEM_HELPER: _helper, ...helperEnvironment } =
      process.env;
    // Resolve through the live cwd HANDLE, not the cwd string: realpath(".")
    // uses GetFinalPathNameByHandle, so the absolute path stays correct even
    // if an ancestor of this quarantine was renamed after the spawn. The path
    // is then \\?\-namespaced: Node creates deep worktree paths past MAX_PATH
    // through its own extended-length handling, and CreateFileW without the
    // prefix rejects those very paths with ERROR_PATH_NOT_FOUND (3).
    // Helper exit 3 (open failed) and 5 (delete disposition refused) include
    // transient sharing violations from antivirus scans of freshly written
    // files; the helper revalidates the bound identity on every attempt, so
    // retrying is safe. Anything else is a real refusal and fails immediately.
    for (let attempt = 1; ; attempt += 1) {
      const here = await realpath(".");
      const target = path.join(here, entry);
      try {
        execFileSync(helper, [
          "remove",
          path.toNamespacedPath(target),
          expected.dev.toString(),
          expected.ino.toString(),
          expected.birthtimeNs.toString(),
          directory ? "true" : "false",
        ], {
          cwd: here,
          env: helperEnvironment,
          maxBuffer: 16_384,
          timeout: 30_000,
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"],
        });
        return;
      } catch (error) {
        // ~10s budget: CI antivirus scan queues under process-spawn storms hold
        // freshly written files well past the 2s a shorter budget covered.
        const transient = error.status === 3 || error.status === 5;
        if (transient && attempt < 50) {
          await new Promise(resolve => setTimeout(resolve, 200));
          continue;
        }
        // The helper's stderr carries code-only clauses (open-error=<GetLastError>
        // and friends); the extension is a bounded token, never a path segment.
        const helperStderr = String(error.stderr ?? "")
          .replace(/[^\x20-\x7e]+/g, " ").trim().slice(0, 120);
        const extension = /\.([A-Za-z0-9]{1,10})$/.exec(path.basename(entry));
        process.stderr.write("clause=helper-remove status=" + String(error.status)
          + " signal=" + String(error.signal) + " code=" + String(error.code)
          + " kind=" + (directory ? "directory" : "file")
          + " ext=" + (extension === null ? "none" : extension[1])
          + " attempts=" + String(attempt)
          + " len=" + String(target.length)
          + " cwdMoved=" + String(here !== process.cwd())
          + (helperStderr.length === 0 ? "" : " helper[" + helperStderr + "]") + "\n");
        process.exit(57);
      }
    }
  }
  if (expected.isSymbolicLink()) {
    await removeBoundUnopenedEntry(entry, expected);
    return;
  }
  const handle = await open(entry, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    if (!sameIdentity(await handle.stat({ bigint: true }), expected)) process.exit(51);
    const originalPath = directory ? await boundHandlePath(handle.fd) : null;
    if (directory && originalPath === null) process.exit(52);
    if (!sameIdentity(await lstat(entry, { bigint: true }), expected)) process.exit(61);
    if (directory) await rmdir(entry);
    else await unlink(entry);
    const removed = await handle.stat({ bigint: true });
    if (!sameIdentity(removed, expected)) process.exit(53);
    if (!directory) {
      if (expected.nlink <= 0n || removed.nlink !== expected.nlink - 1n) process.exit(54);
    } else {
      const removedPath = await boundHandlePath(handle.fd);
      if (process.platform === "linux") {
        if (removed.nlink !== 0n || removedPath !== originalPath + " (deleted)") process.exit(54);
      } else if (removedPath !== originalPath) {
        process.exit(55);
      }
    }
  } finally {
    await handle.close();
  }
};
const emptyBoundDirectory = async expected => {
  if (!sameIdentity(await lstat(".", { bigint: true }), expected)) process.exit(41);
  const emptiedDirectories = [];
  for (const entry of await readdir(".")) {
    const child = await lstat(entry, { bigint: true });
    if (child.birthtimeNs <= 0n) process.exit(42);
    if (child.isDirectory() && !child.isSymbolicLink()) {
      const parent = await lstat(".", { bigint: true });
      const absoluteEntry = path.resolve(entry);
      if (child.dev !== parent.dev
        || isMountPoint(entry)
        || (process.platform !== "win32" && await realpath(entry) !== absoluteEntry)) {
        process.exit(42);
      }
      process.chdir(entry);
      if (!sameIdentity(await lstat(".", { bigint: true }), child)) process.exit(43);
      await emptyBoundDirectory(child);
      process.chdir("..");
      if (!sameIdentity(await lstat(".", { bigint: true }), parent)) process.exit(44);
      if (!sameIdentity(await lstat(entry, { bigint: true }), child)) process.exit(45);
      emptiedDirectories.push([entry, child]);
    } else {
      if (!sameIdentity(await lstat(entry, { bigint: true }), child)) process.exit(47);
      if (!child.isFile() || child.isSymbolicLink()) {
        await removeBoundUnopenedEntry(entry, child);
      } else {
        await removeBoundEntry(entry, child, false);
      }
    }
  }
  await removeBoundDirectories(emptiedDirectories);
  if (!sameIdentity(await lstat(".", { bigint: true }), expected)) process.exit(48);
};
(async () => {
  const expected = {
    dev: BigInt(process.argv[1]),
    ino: BigInt(process.argv[2]),
    birthtimeNs: BigInt(process.argv[3]),
    isDirectory: () => true,
    isSymbolicLink: () => false,
  };
  await emptyBoundDirectory(expected);
})().catch(error => {
  // Codes only, never paths: this lands in bounded redacted diagnostics.
  process.stderr.write("clause=uncaught code=" + String(error && error.code)
    + " errno=" + String(error && error.errno)
    + " name=" + String(error && error.name) + "\n");
  process.exit(49);
});
`;

export interface BoundDirectoryIdentity {
  dev: bigint;
  ino: bigint;
  birthtimeNs: bigint;
}

function sameBoundIdentity(
  metadata: { dev: bigint; ino: bigint; birthtimeNs: bigint },
  expected: BoundDirectoryIdentity,
): boolean {
  return metadata.dev === expected.dev
    && metadata.ino === expected.ino
    && metadata.birthtimeNs > 0n
    && metadata.birthtimeNs === expected.birthtimeNs;
}

async function closeBoundHandle(handle: FileHandle | undefined, primaryError: unknown) {
  try {
    await handle?.close();
  } catch (closeError) {
    if (primaryError !== undefined) {
      throw new AggregateError(
        [primaryError, closeError],
        "bound directory removal failed and its handle could not be closed",
      );
    }
    throw closeError;
  }
}

async function darwinHandlePath(
  directory: string,
  handle: FileHandle,
  platformServices: PlatformServices,
): Promise<string> {
  const result = await supervise(platformServices, {
    executable: {
      kind: "native",
      command: "/usr/sbin/lsof",
      prefixArgs: [],
      resolvedFrom: "darwin-system-lsof",
    },
    args: [
      "-a",
      "-p",
      process.pid.toString(),
      "-d",
      handle.fd.toString(),
      "-F0pn",
    ],
    cwd: path.dirname(directory),
    env: {},
    timeoutMs: 5_000,
    maxOutputBytes: 16_384,
  }, { graceMs: 1_000 });
  const name = /(?:^|[\n\u0000])n([^\u0000]*)\u0000/u.exec(result.stdout)?.[1];
  if (result.spawnError !== undefined
    || result.exitCode !== 0
    || result.signal !== null
    || result.timedOut
    || result.cancelled
    || result.truncated.stdout
    || result.truncated.stderr
    || name === undefined) {
    throw new RuntimeError("validated directory handle path is unavailable");
  }
  return name;
}

async function removeWindowsBoundEmptyDirectory(
  directory: string,
  expectedIdentity: BoundDirectoryIdentity,
  platformServices: PlatformServices,
): Promise<void> {
  const helper = await resolveWindowsFilesystemHelper();
  // Exit 3 (open failed) and 5 (delete disposition refused) include transient
  // sharing violations from antivirus scans; the helper revalidates the bound
  // identity on every attempt, so a bounded retry is safe.
  for (let attempt = 1; ; attempt += 1) {
    const result = await supervise(platformServices, {
      executable: helper,
      args: [
        "remove",
        path.toNamespacedPath(directory),
        expectedIdentity.dev.toString(),
        expectedIdentity.ino.toString(),
        expectedIdentity.birthtimeNs.toString(),
        "true",
      ],
      cwd: path.dirname(directory),
      env: windowsEssentialEnvironment(),
      timeoutMs: 30_000,
      maxOutputBytes: 16_384,
    }, { graceMs: 1_000 });
    if (result.spawnError === undefined
      && result.exitCode === 0
      && result.signal === null
      && !result.timedOut
      && !result.cancelled
      && !result.truncated.stdout
      && !result.truncated.stderr) {
      return;
    }
    if ((result.exitCode === 3 || result.exitCode === 5) && attempt < 50) {
      await new Promise(resolve => setTimeout(resolve, 200));
      continue;
    }
    throw new RuntimeError(
      `validated Windows directory could not be removed (exitCode=${result.exitCode})`,
    );
  }
}

export async function verifyBoundDirectoryCleanupSupport(
  platformServices: PlatformServices,
): Promise<void> {
  try {
    if (platformServices.os === "linux") {
      await Promise.all([
        access("/proc/self/mountinfo", constants.R_OK),
        access("/proc/self/fd", constants.R_OK),
      ]);
      return;
    }
    if (platformServices.os === "darwin") {
      await Promise.all([
        access("/usr/sbin/lsof", constants.X_OK),
        access("/bin/df", constants.X_OK),
      ]);
      return;
    }
    if (platformServices.os === "win32") {
      await resolveWindowsFilesystemHelper();
      return;
    }
    throw new RuntimeError(`unsupported cleanup platform: ${platformServices.os}`);
  } catch (error) {
    throw new RuntimeError(
      `${platformServices.os} bound-directory cleanup backend is unavailable`,
      {
        classification: "cleanup-backend-unavailable",
        toolError: "cleanup-backend-unavailable",
        cause: error,
      },
    );
  }
}

export async function removeBoundEmptyDirectory(
  directory: string,
  expectedIdentity: BoundDirectoryIdentity,
  platformServices: PlatformServices,
  remove?: typeof rmdir,
): Promise<void> {
  await verifyBoundDirectoryCleanupSupport(platformServices);
  if (platformServices.os === "win32") {
    if (remove !== undefined) {
      throw new RuntimeError("custom pathname removal is unavailable on Windows");
    }
    await removeWindowsBoundEmptyDirectory(directory, expectedIdentity, platformServices);
    return;
  }
  let handle: FileHandle | undefined;
  let primaryError: unknown;
  try {
    const named = await lstat(directory, { bigint: true });
    if (!named.isDirectory()
      || named.isSymbolicLink()
      || !sameBoundIdentity(named, expectedIdentity)) {
      throw new RuntimeError("directory identity changed before bound removal");
    }
    handle = await open(directory, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = await handle.stat({ bigint: true });
    if (!opened.isDirectory() || !sameBoundIdentity(opened, expectedIdentity)) {
      throw new RuntimeError("opened directory identity changed before bound removal");
    }
    const settledNamed = await lstat(directory, { bigint: true });
    if (!settledNamed.isDirectory()
      || settledNamed.isSymbolicLink()
      || !sameBoundIdentity(settledNamed, expectedIdentity)) {
      throw new RuntimeError("directory identity changed before final bound removal");
    }
    const darwinPath = platformServices.os === "darwin"
      ? await darwinHandlePath(directory, handle, platformServices)
      : undefined;
    // POSIX rmdir/unlink remove directory entries by name, not by an opened
    // object handle. Rebind at the syscall boundary after every potentially
    // blocking probe; callers reach this only after the supervised Producer
    // tree has settled and the quarantine is outside Producer write scope.
    const removalTarget = await lstat(directory, { bigint: true });
    if (!removalTarget.isDirectory()
      || removalTarget.isSymbolicLink()
      || !sameBoundIdentity(removalTarget, expectedIdentity)) {
      throw new RuntimeError("directory identity changed at the final removal boundary");
    }
    await (remove ?? rmdir)(directory);
    const removed = await handle.stat({ bigint: true });
    if (!sameBoundIdentity(removed, expectedIdentity)) {
      throw new RuntimeError("directory handle identity changed during removal");
    }
    if (platformServices.os === "linux") {
      if (removed.nlink !== 0n) {
        throw new RuntimeError("validated Linux directory inode remains linked after removal");
      }
    } else if (platformServices.os === "darwin") {
      const removedPath = await darwinHandlePath(directory, handle, platformServices);
      if (removedPath !== darwinPath) {
        throw new RuntimeError("removed directory handle escaped its validated path");
      }
    } else {
      throw new RuntimeError("bound directory removal is unsupported on this platform");
    }
  } catch (error) {
    primaryError = error;
  }
  await closeBoundHandle(handle, primaryError);
  if (primaryError !== undefined) throw primaryError;
}

export async function emptyBoundDirectory(
  directory: string,
  expectedIdentity: BoundDirectoryIdentity,
  platformServices: PlatformServices,
): Promise<void> {
  await verifyBoundDirectoryCleanupSupport(platformServices);
  const helper = platformServices.os === "win32"
    ? await resolveWindowsFilesystemHelper()
    : null;
  const result = await supervise(platformServices, {
    executable: {
      kind: "native",
      command: globalThis.process.execPath,
      prefixArgs: [],
      resolvedFrom: "runtime-node",
    },
    args: [
      "-e",
      EMPTY_DIRECTORY_SCRIPT,
      expectedIdentity.dev.toString(),
      expectedIdentity.ino.toString(),
      expectedIdentity.birthtimeNs.toString(),
    ],
    cwd: directory,
    env: helper === null
      ? {}
      : {
        ...windowsEssentialEnvironment(),
        CLAUDE_ARCHITECT_WINDOWS_FILESYSTEM_HELPER: helper.command,
      },
    timeoutMs: resolveEmptyDirectoryTimeoutMs(),
    maxOutputBytes: 16_384,
  }, { graceMs: 1_000 });
  if (result.spawnError !== undefined
    || result.exitCode !== 0
    || result.timedOut
    || result.cancelled
    || result.truncated.stdout
    || result.truncated.stderr) {
    // The script writes only clause codes to stderr, never paths, so the
    // condition summary is safe for bounded redacted diagnostics.
    const condition = result.spawnError !== undefined
      ? "spawnError"
      : result.timedOut
        ? "timedOut=true"
        : result.cancelled
          ? "cancelled=true"
          : `exitCode=${result.exitCode}${result.signal === null ? "" : ` signal=${result.signal}`}`;
    const stderr = result.stderr.slice(0, 512).trim();
    throw new RuntimeError(
      `quarantined directory contents could not be removed (${condition})${stderr.length === 0 ? "" : `: ${stderr}`}`,
    );
  }
}
