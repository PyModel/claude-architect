import { spawn, execFile } from "node:child_process";
import { constants, promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import nodeProcess from "node:process";
import { BoundedBuffer } from "../util/bounded-buffer.js";
import { gitPathOutput } from "../git/git-output.js";
import { RuntimeError, errorCode } from "../util/errors.js";
import { logger } from "../util/logger.js";
import type {
  CanonicalPath, CheckoutLock, ExecutableRequest, FileLock, LockOwnerAnnotation, PlatformServices,
  ResolvedExecutable, SpawnRequest, SupervisedExit, SupervisedProcess,
} from "./platform-services.js";
import { acquireCheckoutLock, acquireCleanupJournalLock } from "./checkout-lock.js";
import { sameDirectoryIdentity, type DirectoryIdentity } from "./durable-directory.js";

async function gitCommonDir(cwd: string): Promise<string> {
  // Intentional bootstrap exception until Task 8 provides the shared argv-based Git helper.
  return new Promise((resolve, reject) => {
    execFile("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd }, (error, stdout) => {
      if (error) reject(error);
      else {
        try { resolve(gitPathOutput(stdout, "Git common directory")); }
        catch (parseError) { reject(parseError); }
      }
    });
  });
}

function killProcessGroup(pid: number, signal: NodeJS.Signals): void {
  // pid <= 1 is never a valid spawned-child group: -1 is the "no pid" sentinel from a failed
  // spawn(), 0 means "current process group", and 1 is init/a container's PID-1 entrypoint.
  // Negating any of these into process.kill(-pid, ...) would signal a group we must never touch.
  if (pid <= 1) {
    logger.warn("skipped process-group terminate for invalid pid", { pid, signal });
    return;
  }
  try { nodeProcess.kill(-pid, signal); }
  catch (error) { if (errorCode(error) !== "ESRCH") throw error; }
}

export class PosixPlatformServices implements PlatformServices {
  readonly os = nodeProcess.platform === "darwin" ? "darwin" : "linux";

  async resolveExecutable(request: ExecutableRequest): Promise<ResolvedExecutable> {
    if (request.explicitPath !== undefined) {
      try { await fs.access(request.explicitPath, constants.X_OK); }
      catch (cause) { throw new RuntimeError(`executable is not accessible: ${request.explicitPath}`, { cause }); }
      return {
        kind: "native", command: request.explicitPath, prefixArgs: [],
        resolvedFrom: `explicit:${request.explicitPath}`,
      };
    }
    for (const directory of (request.searchPath ?? nodeProcess.env.PATH ?? "").split(path.delimiter)) {
      const candidate = path.join(directory, request.name);
      try {
        await fs.access(candidate, constants.X_OK);
        return { kind: "native", command: candidate, prefixArgs: [], resolvedFrom: `path:${candidate}` };
      } catch { /* continue searching PATH */ }
    }
    throw new RuntimeError(`executable not found on PATH: ${request.name}`);
  }

  async spawnSupervised(req: SpawnRequest): Promise<SupervisedProcess> {
    const child = spawn(req.executable.command, [...req.executable.prefixArgs, ...req.args], {
      cwd: req.cwd, env: req.env, detached: true, stdio: ["pipe", "pipe", "pipe"],
    });
    const outBuf = new BoundedBuffer(req.maxOutputBytes), errBuf = new BoundedBuffer(req.maxOutputBytes);
    child.stdout.on("data", (c: Buffer) => outBuf.push(c));   // always drain, even after truncation, to avoid deadlock
    child.stderr.on("data", (c: Buffer) => errBuf.push(c));
    if (req.stdin != null) { child.stdin?.on("error", () => {}); child.stdin?.write(req.stdin); child.stdin?.end(); }
    let settled = false;
    const done = new Promise<SupervisedExit>((resolve) => {
      const finish = (e: SupervisedExit) => { if (!settled) { settled = true; resolve(e); } };
      // MANDATORY: without this, a failed spawn (ENOENT/EACCES) emits 'error' with no listener → uncaught
      // exception crashes the MCP server. Instead settle done with a spawn-failure marker.
      child.on("error", (err) => finish({
        exitCode: null, signal: null, timedOut: false, cancelled: false,
        stdout: outBuf.toString(), stderr: errBuf.toString(),
        truncated: { stdout: outBuf.truncated, stderr: errBuf.truncated }, spawnError: err,
      }));
      child.on("close", (code, signal) => finish({
        exitCode: code, signal: signal as NodeJS.Signals | null, timedOut: false, cancelled: false,
        stdout: outBuf.toString(), stderr: errBuf.toString(),
        truncated: { stdout: outBuf.truncated, stderr: errBuf.truncated },
      }));
    });
    return { pid: child.pid ?? -1, done, stdout: child.stdout, stderr: child.stderr };
  }

  async requestCooperativeCancellation(proc: SupervisedProcess): Promise<void> {
    killProcessGroup(proc.pid, "SIGTERM");
  }

  async terminateProcessTree(proc: SupervisedProcess): Promise<void> {
    killProcessGroup(proc.pid, "SIGKILL");
  }

  async getProcessStartToken(pid: number): Promise<string | null> {
    if (!Number.isSafeInteger(pid) || pid <= 1) return null;
    if (nodeProcess.platform === "linux") {
      try {
        const stat = await fs.readFile(`/proc/${pid}/stat`, "utf8");
        const afterComm = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
        const starttime = afterComm[19];
        return starttime ? `linux:${starttime}` : null;
      } catch {
        return null;
      }
    }
    return new Promise(resolve => {
      try {
        execFile("ps", ["-o", "lstart=", "-p", String(pid)], (error, stdout) => {
          const line = stdout.trim();
          resolve(error || line.length === 0 ? null : `darwin:${line}`);
        });
      } catch {
        resolve(null);
      }
    });
  }

  async terminateProcessTreeByPid(pid: number, expectedToken?: string | null): Promise<void> {
    if (typeof expectedToken === "string") {
      const liveToken = await this.getProcessStartToken(pid);
      if (liveToken !== expectedToken) return;
    }
    killProcessGroup(pid, "SIGKILL");
  }

  async acquireCheckoutLock(
    checkout: string,
    owner: LockOwnerAnnotation = {},
  ): Promise<CheckoutLock> {
    return acquireCheckoutLock(this, checkout, owner);
  }

  async acquireCleanupJournalLock(): Promise<FileLock> {
    return acquireCleanupJournalLock(this);
  }

  async createSecureTempDirectory(): Promise<string> {
    return fs.mkdtemp(path.join(tmpdir(), "claude-architect-"));
  }

  async assertDirectoryWriteIntegrity(
    directory: string,
    expectedIdentity: DirectoryIdentity,
  ): Promise<void> {
    const metadata = await fs.lstat(directory, { bigint: true });
    const uid = nodeProcess.getuid?.();
    if (!metadata.isDirectory()
      || metadata.isSymbolicLink()
      || metadata.birthtimeNs <= 0n
      || !sameDirectoryIdentity(metadata, expectedIdentity)
      || uid === undefined
      || metadata.uid !== BigInt(uid)
      || (metadata.mode & 0o022n) !== 0n) {
      throw new RuntimeError("directory lacks stable write integrity");
    }
  }

  async canonicalizePath(input: string): Promise<CanonicalPath> {
    const canonical = await fs.realpath(input);
    let commonDir: string | null = null;
    try { commonDir = await fs.realpath(await gitCommonDir(canonical)); }
    catch { commonDir = null; }
    return { input, canonical, gitCommonDir: commonDir };
  }
}
