import { execFile, spawn, type ChildProcess } from "node:child_process";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import nodeProcess from "node:process";
import { fileURLToPath } from "node:url";
import { BoundedBuffer } from "../util/bounded-buffer.js";
import { gitPathOutput } from "../git/git-output.js";
import { RuntimeError } from "../util/errors.js";
import type {
  CanonicalPath, CheckoutLock, ExecutableRequest, FileLock, LockOwnerAnnotation, PlatformServices,
  ResolvedExecutable, SpawnRequest, SupervisedExit, SupervisedProcess,
} from "./platform-services.js";
import { acquireCheckoutLock, acquireCleanupJournalLock } from "./checkout-lock.js";
import { normalizeWindowsEnv, windowsEssentialEnvironment } from "./windows-env.js";
import { assertWindowsDirectoryWriteIntegrity, type DirectoryIdentity } from "./durable-directory.js";

const childHandles = new WeakMap<SupervisedProcess, ChildProcess>();

interface WindowsExecutableDependencies {
  pathEntries: string[];
  pathext: string[];
  fs: {
    isFile(path: string): Promise<boolean>;
    readFile(path: string): Promise<string>;
  };
  nodeExe: string;
  comSpec?: string;
  npmEntryProbe?: string[];
}

export interface JobKillHelper {
  path: string;
  checkAvailable(): Promise<boolean>;
}

type TokenExecFile = typeof execFile;

export function resolveJobKillHelper(pluginRoot: string, arch: string): JobKillHelper {
  const helperPath = path.join(pluginRoot, "native", "bin", `win32-job-kill-${arch}.exe`);
  return {
    path: helperPath,
    async checkAvailable(): Promise<boolean> {
      try { await fs.access(helperPath); return true; }
      catch { return false; }
    },
  };
}

async function findPluginRoot(): Promise<string> {
  let directory = path.dirname(fileURLToPath(import.meta.url));
  for (;;) {
    try { await fs.access(path.join(directory, "package.json")); return directory; }
    catch { /* continue walking */ }
    const parent = path.dirname(directory);
    if (parent === directory) throw new RuntimeError("unable to locate plugin root");
    directory = parent;
  }
}

async function packageBinEntries(
  request: ExecutableRequest,
  directory: string,
  fileSystem: WindowsExecutableDependencies["fs"],
): Promise<string[]> {
  const packageDirectory = path.win32.join(directory, "node_modules", request.name);
  const packagePath = path.win32.join(packageDirectory, "package.json");
  if (!await fileSystem.isFile(packagePath.toLowerCase())) return [];

  try {
    const parsed: unknown = JSON.parse(await fileSystem.readFile(packagePath));
    if (typeof parsed !== "object" || parsed === null || !("bin" in parsed)) return [];
    const bin: unknown = parsed.bin;
    if (typeof bin === "string") {
      return [path.win32.relative(directory, path.win32.join(packageDirectory, bin))];
    }
    if (typeof bin !== "object" || bin === null) return [];
    const namedBin = (bin as Record<string, unknown>)[request.name];
    if (typeof namedBin === "string") {
      return [path.win32.relative(directory, path.win32.join(packageDirectory, namedBin))];
    }
  } catch {
    return [];
  }
  return [];
}

export async function resolveWindowsExecutable(
  request: ExecutableRequest,
  deps: WindowsExecutableDependencies,
): Promise<ResolvedExecutable> {
  if (request.explicitPath !== undefined) {
    if (!await deps.fs.isFile(request.explicitPath.toLowerCase())) {
      throw new RuntimeError(`executable is not accessible: ${request.explicitPath}`, {
        path: request.explicitPath,
      });
    }
    return {
      kind: "native", command: request.explicitPath, prefixArgs: [],
      resolvedFrom: `explicit:${request.explicitPath}`,
    };
  }

  for (const directory of deps.pathEntries) {
    for (const extension of deps.pathext) {
      const candidate = path.win32.join(directory, `${request.name}${extension.toLowerCase()}`);
      if (!await deps.fs.isFile(candidate.toLowerCase())) continue;

      const normalizedExtension = extension.toLowerCase();
      if (normalizedExtension === ".exe" || normalizedExtension === ".com") {
        return {
          kind: "native", command: candidate, prefixArgs: [],
          resolvedFrom: `pathext:${candidate}`,
        };
      }

      if (normalizedExtension === ".cmd" || normalizedExtension === ".bat") {
        const entries = deps.npmEntryProbe
          ?? await packageBinEntries(request, directory, deps.fs);
        for (const entry of entries) {
          const absoluteEntry = path.win32.join(directory, entry);
          if (await deps.fs.isFile(absoluteEntry.toLowerCase())) {
            return {
              kind: "node-entrypoint", command: deps.nodeExe, prefixArgs: [absoluteEntry],
              resolvedFrom: `npm-entry:${absoluteEntry}`,
            };
          }
        }
        return {
          kind: "cmd-wrapper",
          command: deps.comSpec ?? "C:\\Windows\\System32\\cmd.exe",
          prefixArgs: ["/d", "/s", "/c", candidate],
          resolvedFrom: `cmd-wrapper:${candidate}`,
        };
      }
    }
  }
  throw new RuntimeError("executable was not found", { name: request.name });
}

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

export function canonicalizeForScope(candidate: string, root: string): boolean {
  const stripExtendedLengthPrefix = (value: string): string => {
    if (value.toUpperCase().startsWith("\\\\?\\UNC\\")) return `\\\\${value.slice(8)}`;
    return value.startsWith("\\\\?\\") ? value.slice(4) : value;
  };
  const normalizeVolume = (value: string): string => value.replace(
    /^[a-z]:/u,
    match => match.toUpperCase(),
  );
  const normalizedCandidate = normalizeVolume(
    path.win32.normalize(stripExtendedLengthPrefix(candidate)),
  );
  let normalizedRoot = normalizeVolume(path.win32.normalize(stripExtendedLengthPrefix(root)));
  if (normalizedRoot.endsWith("\\") && path.win32.parse(normalizedRoot).root !== normalizedRoot) {
    normalizedRoot = normalizedRoot.slice(0, -1);
  }
  return normalizedCandidate === normalizedRoot || normalizedCandidate.startsWith(`${normalizedRoot}\\`);
}

export class WindowsPlatformServices implements PlatformServices {
  readonly os = "win32";
  private ownProcessStartToken?: string;

  constructor(
    private readonly pluginRoot?: string,
    private readonly arch = nodeProcess.arch,
    private readonly tokenExecFile: TokenExecFile = execFile,
  ) {}

  private async jobKillHelper(): Promise<JobKillHelper> {
    return resolveJobKillHelper(this.pluginRoot ?? await findPluginRoot(), this.arch);
  }

  private async runJobKillHelper(pid: number): Promise<void> {
    const helper = await this.jobKillHelper();
    await new Promise<void>((resolve, reject) => {
      this.tokenExecFile(helper.path, [String(pid)], {
        windowsHide: true,
        shell: false,
        env: windowsEssentialEnvironment(),
      }, error => {
        if (error === null || error.code === 2) resolve();
        else reject(new RuntimeError("windows process-tree termination failed", {
          path: helper.path, pid, cause: error,
        }));
      });
    });
  }

  async resolveExecutable(request: ExecutableRequest): Promise<ResolvedExecutable> {
    const pathext = (nodeProcess.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD")
      .split(";").filter(Boolean).map(extension => extension.toUpperCase());
    const pathEntries = (request.searchPath ?? nodeProcess.env.Path ?? nodeProcess.env.PATH ?? "")
      .split(";").filter(Boolean);
    const realFs = {
      async isFile(candidate: string): Promise<boolean> {
        try { return (await fs.stat(candidate)).isFile(); }
        catch { return false; }
      },
      async readFile(candidate: string): Promise<string> { return fs.readFile(candidate, "utf8"); },
    };
    const commonDeps = { pathEntries, pathext, fs: realFs, nodeExe: nodeProcess.execPath };
    return nodeProcess.env.ComSpec === undefined
      ? resolveWindowsExecutable(request, commonDeps)
      : resolveWindowsExecutable(request, { ...commonDeps, comSpec: nodeProcess.env.ComSpec });
  }

  async spawnSupervised(req: SpawnRequest): Promise<SupervisedProcess> {
    const helper = await this.jobKillHelper();
    if (!await helper.checkAvailable()) {
      throw new RuntimeError("windows process-tree helper missing", { path: helper.path });
    }
    const child = spawn(req.executable.command, [...req.executable.prefixArgs, ...req.args], {
      cwd: req.cwd, env: normalizeWindowsEnv(req.env), detached: false, windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
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
    const proc = { pid: child.pid ?? -1, done, stdout: child.stdout, stderr: child.stderr };
    childHandles.set(proc, child);
    return proc;
  }

  async requestCooperativeCancellation(proc: SupervisedProcess): Promise<void> {
    const child = childHandles.get(proc);
    if (child === undefined) return;
    try { child.kill("SIGTERM"); }
    catch { /* process already exited */ }
  }
  async terminateProcessTree(proc: SupervisedProcess): Promise<void> {
    await this.runJobKillHelper(proc.pid);
  }
  async getProcessStartToken(pid: number): Promise<string | null> {
    if (!Number.isSafeInteger(pid) || pid <= 1) return null;
    if (pid === nodeProcess.pid && this.ownProcessStartToken !== undefined) {
      return this.ownProcessStartToken;
    }
    try {
      const helper = await this.jobKillHelper();
      if (await helper.checkAvailable()) {
        const nativeToken = await new Promise<string | null | undefined>(resolve => {
          try {
            this.tokenExecFile(
              helper.path,
              ["token", String(pid)],
              {
                windowsHide: true,
                shell: false,
                env: windowsEssentialEnvironment(),
              },
              (error, stdout) => {
                const token = stdout.trim();
                if (error === null && token.length > 0) resolve(`win32:${token}`);
                else if (error?.code === 2) resolve(null);
                else resolve(undefined);
              },
            );
          } catch {
            resolve(undefined);
          }
        });
        if (nativeToken !== undefined) {
          if (pid === nodeProcess.pid && nativeToken !== null) this.ownProcessStartToken = nativeToken;
          return nativeToken;
        }
      }
    } catch { /* native helper unavailability is reported as an unverifiable token */ }
    return null;
  }
  async terminateProcessTreeByPid(pid: number, expectedToken?: string | null): Promise<void> {
    if (typeof expectedToken === "string") {
      const liveToken = await this.getProcessStartToken(pid);
      if (liveToken !== expectedToken) return;
    }
    await this.runJobKillHelper(pid);
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
    await assertWindowsDirectoryWriteIntegrity(directory, expectedIdentity, this);
  }

  async canonicalizePath(input: string): Promise<CanonicalPath> {
    const canonical = await fs.realpath(input);
    let commonDir: string | null = null;
    try { commonDir = await fs.realpath(await gitCommonDir(canonical)); }
    catch { commonDir = null; }
    return { input, canonical, gitCommonDir: commonDir };
  }
}
