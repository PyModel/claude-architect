import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const temporaryPaths: string[] = [];
const bootstrapPath = fileURLToPath(new URL("../../runtime/bootstrap.mjs", import.meta.url));

async function fakeServer(root: string): Promise<string> {
  const serverPath = path.join(root, "fake-server.mjs");
  await writeFile(
    serverPath,
    "console.error('fake server ready'); export async function start() {}\n",
  );
  return serverPath;
}

async function nodeVersionPrelude(root: string, version: string): Promise<string> {
  const preludePath = path.join(root, `node-${version}.mjs`);
  await writeFile(
    preludePath,
    `Object.defineProperty(process.versions, 'node', { value: ${JSON.stringify(version)} });\n`,
  );
  // --import treats a bare `C:\...` path as a URL on Windows; hand it a file URL.
  return pathToFileURL(preludePath).href;
}

async function waitForFile(filePath: string, timeoutMs = 10_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      return await readFile(filePath, "utf8");
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
    }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for ${filePath}`);
}

async function waitForExit(child: ChildProcess, timeoutMs = 10_000): Promise<{
  code: number | null;
  signal: NodeJS.Signals | null;
}> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return { code: child.exitCode, signal: child.signalCode };
  }
  return await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("timed out waiting for bootstrap exit")), timeoutMs);
    child.once("error", error => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      resolve({ code, signal });
    });
  });
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") return false;
    throw error;
  }
}

async function waitForProcessGone(pid: number, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for process ${pid} to exit`);
}

/**
 * Reap the re-executed server unconditionally.
 *
 * These tests learn the server's pid by reading a file the server writes, and
 * every one of them assigns that pid inside the `try`. When the read times out
 * or the assertion above it throws, the pid is still 0, the `finally` reaps
 * only the bootstrap child, and the grandchild — which holds an unref'd
 * `setInterval` — survives as an orphan for the life of the machine. One such
 * orphan was found running nearly six hours after its temp directory had been
 * deleted. Re-read the pid file here so cleanup never depends on the step that
 * failed.
 */
async function reapServer(pidFile: string, knownPid: number): Promise<void> {
  let pid = knownPid;
  if (pid <= 1) {
    // The common leak is a pid read that timed out because the server was slow
    // to start. It usually does write the file a moment later, so poll briefly
    // rather than reading once and giving up on a process that is about to
    // exist.
    const deadline = Date.now() + 2_000;
    do {
      pid = Number(await readFile(pidFile, "utf8").catch(() => "0"));
      if (Number.isSafeInteger(pid) && pid > 1) break;
      await new Promise(resolve => setTimeout(resolve, 25));
    } while (Date.now() < deadline);
  }
  if (!Number.isSafeInteger(pid) || pid <= 1) return;
  try {
    if (isProcessAlive(pid)) process.kill(pid, "SIGKILL");
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ESRCH") throw error;
  }
}

afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map(entry =>
    rm(entry, { recursive: true, force: true })));
});

describe("runtime bootstrap", () => {
  it("starts the server on a supported runtime without writing protocol noise to stdout", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "ca-bootstrap-supported-"));
    temporaryPaths.push(root);
    const serverPath = await fakeServer(root);

    const result = spawnSync(process.execPath, [bootstrapPath], {
      encoding: "utf8",
      env: { ...process.env, CLAUDE_ARCHITECT_SERVER_PATH: serverPath },
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("fake server ready");
  });

  it.skipIf(process.platform === "win32")("re-execs a supported node found on PATH", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "ca-bootstrap-reexec-"));
    temporaryPaths.push(root);
    const serverPath = await fakeServer(root);
    const preludePath = await nodeVersionPrelude(root, "20.19.0");
    const bin = path.join(root, "bin");
    await mkdir(bin);
    await symlink(process.execPath, path.join(bin, "node"));

    const result = spawnSync(
      process.execPath,
      ["--import", preludePath, bootstrapPath],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: bin,
          CLAUDE_ARCHITECT_SERVER_PATH: serverPath,
        },
      },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("fake server ready");
  });

  it.skipIf(process.platform === "win32")("never re-execs a node from a relative PATH entry", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "ca-bootstrap-relative-"));
    temporaryPaths.push(root);
    const serverPath = await fakeServer(root);
    const preludePath = await nodeVersionPrelude(root, "20.19.0");
    await mkdir(path.join(root, "bin"));
    await symlink(process.execPath, path.join(root, "bin", "node"));

    const result = spawnSync(
      process.execPath,
      ["--import", preludePath, bootstrapPath],
      {
        cwd: root,
        encoding: "utf8",
        env: { ...process.env, PATH: "bin", CLAUDE_ARCHITECT_SERVER_PATH: serverPath },
      },
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).not.toContain("fake server ready");
  });

  it("uses the shipped parser to accept the Node.js 22 boundary", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "ca-bootstrap-boundary-"));
    temporaryPaths.push(root);
    const serverPath = await fakeServer(root);
    const preludePath = await nodeVersionPrelude(root, "22.0.0");
    const emptyBin = path.join(root, "empty-bin");
    await mkdir(emptyBin);

    const result = spawnSync(
      process.execPath,
      ["--import", preludePath, bootstrapPath],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: emptyBin,
          CLAUDE_ARCHITECT_SERVER_PATH: serverPath,
        },
      },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("fake server ready");
  });

  it.skipIf(process.platform === "win32")("propagates a re-executed server exit code", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "ca-bootstrap-exit-code-"));
    temporaryPaths.push(root);
    const serverPath = path.join(root, "exit-server.mjs");
    const preludePath = await nodeVersionPrelude(root, "20.19.0");
    const bin = path.join(root, "bin");
    await mkdir(bin);
    await symlink(process.execPath, path.join(bin, "node"));
    await writeFile(serverPath, "process.exit(7);\n");

    const result = spawnSync(
      process.execPath,
      ["--import", preludePath, bootstrapPath],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: bin,
          CLAUDE_ARCHITECT_SERVER_PATH: serverPath,
        },
      },
    );

    expect(result.status).toBe(7);
    expect(result.stdout).toBe("");
  });

  it("fails on stderr when no supported node exists on PATH", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "ca-bootstrap-missing-"));
    temporaryPaths.push(root);
    const preludePath = await nodeVersionPrelude(root, "20.19.0");
    const emptyBin = path.join(root, "empty-bin");
    await mkdir(emptyBin);

    const result = spawnSync(
      process.execPath,
      ["--import", preludePath, bootstrapPath],
      {
        encoding: "utf8",
        env: { ...process.env, PATH: emptyBin },
      },
    );

    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Node.js 22");
    expect(result.stderr).toContain("PATH");
  });

  // Regression: every signal test assigns serverPid inside the try that can
  // throw, so a pid read that times out used to leave the re-executed server —
  // which holds an interval timer — running forever. One such orphan was found
  // alive nearly six hours after its temp directory had been deleted. Reap must
  // not depend on the step that failed.
  it.skipIf(process.platform === "win32")(
    "reaps the re-executed server even when the pid read times out",
    async () => {
      const root = await mkdtemp(path.join(tmpdir(), "ca-bootstrap-slow-pid-"));
      temporaryPaths.push(root);
      const preludePath = await nodeVersionPrelude(root, "20.19.0");
      const bin = path.join(root, "bin");
      const serverPath = path.join(root, "signal-server.mjs");
      const pidFile = path.join(root, "server.pid");
      const startedFile = path.join(root, "server.started");
      await mkdir(bin);
      await symlink(process.execPath, path.join(bin, "node"));
      // Announces itself immediately so the test can prove the server exists
      // before simulating the failed read; writes the pid only afterwards, which
      // is the ordering that produced the orphan.
      await writeFile(serverPath, [
        "import { writeFileSync } from 'node:fs';",
        "writeFileSync(process.env.TEST_SERVER_STARTED_FILE, 'up');",
        "setTimeout(() => {",
        "  writeFileSync(process.env.TEST_SERVER_PID_FILE, String(process.pid));",
        "}, 400);",
        "setInterval(() => {}, 1000);",
        "",
      ].join("\n"));

      const child = spawn(process.execPath, ["--import", preludePath, bootstrapPath], {
        env: {
          ...process.env,
          PATH: bin,
          CLAUDE_ARCHITECT_SERVER_PATH: serverPath,
          TEST_SERVER_PID_FILE: pidFile,
          TEST_SERVER_STARTED_FILE: startedFile,
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let serverPid = 0;
      try {
        // Wait for the server to genuinely exist first. Killing the bootstrap
        // before it has spawned the grandchild leaves nothing to leak, which is
        // a vacuous pass — and on a slow runner that is exactly what happened.
        await waitForFile(startedFile);
        // Times out by construction, exactly as the leaking runs did.
        await expect(waitForFile(pidFile, 50)).rejects.toThrow();
      } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        await reapServer(pidFile, serverPid);
      }

      // The server does write its pid — just too late for the read above. Wait
      // for it here rather than reading once, so a regression fails on the
      // process still being alive instead of on an unwritten file.
      const leaked = Number(await waitForFile(pidFile, 5_000));
      expect(leaked).toBeGreaterThan(1);
      await waitForProcessGone(leaked, 5_000);
    },
  );

  it.skipIf(process.platform === "win32")("forwards SIGIO to a re-executed server", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "ca-bootstrap-signal-"));
    temporaryPaths.push(root);
    const preludePath = await nodeVersionPrelude(root, "20.19.0");
    const bin = path.join(root, "bin");
    const serverPath = path.join(root, "signal-server.mjs");
    const pidFile = path.join(root, "server.pid");
    const readyFile = path.join(root, "signal.ready");
    const armFile = path.join(root, "signal.arm");
    const signalFile = path.join(root, "signal.txt");
    await mkdir(bin);
    await symlink(process.execPath, path.join(bin, "node"));
    await writeFile(serverPath, [
      "import { existsSync, writeFileSync } from 'node:fs';",
      "process.on('SIGIO', () => {",
      "  if (!existsSync(process.env.TEST_SIGNAL_ARM_FILE)) {",
      "    writeFileSync(process.env.TEST_SIGNAL_READY_FILE, 'ready');",
      "    return;",
      "  }",
      "  writeFileSync(process.env.TEST_SIGNAL_FILE, 'SIGIO');",
      "  process.exit(47);",
      "});",
      "writeFileSync(process.env.TEST_SERVER_PID_FILE, String(process.pid));",
      "setInterval(() => {}, 1000);",
      "",
    ].join("\n"));

    const child = spawn(process.execPath, ["--import", preludePath, bootstrapPath], {
      env: {
        ...process.env,
        PATH: bin,
        CLAUDE_ARCHITECT_SERVER_PATH: serverPath,
        TEST_SERVER_PID_FILE: pidFile,
        TEST_SIGNAL_READY_FILE: readyFile,
        TEST_SIGNAL_ARM_FILE: armFile,
        TEST_SIGNAL_FILE: signalFile,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let serverPid = 0;
    try {
      serverPid = Number(await waitForFile(pidFile));
      const readiness = waitForFile(readyFile);
      const readinessProbe = setInterval(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGIO");
      }, 20);
      try {
        await readiness;
      } finally {
        clearInterval(readinessProbe);
      }
      await writeFile(armFile, "armed");
      child.kill("SIGIO");
      const exit = await waitForExit(child);
      await waitForProcessGone(serverPid);
      expect(await waitForFile(signalFile)).toBe("SIGIO");
      expect(Number.isSafeInteger(serverPid) && serverPid > 1).toBe(true);
      expect(exit).toEqual({ code: 47, signal: null });
      expect(isProcessAlive(serverPid)).toBe(false);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await reapServer(pidFile, serverPid);
    }
  });

  it.skipIf(process.platform === "win32")(
    "escalates when a re-executed server ignores termination",
    async () => {
      const root = await mkdtemp(path.join(tmpdir(), "ca-bootstrap-stubborn-signal-"));
      temporaryPaths.push(root);
      const preludePath = await nodeVersionPrelude(root, "20.19.0");
      const bin = path.join(root, "bin");
      const serverPath = path.join(root, "stubborn-server.mjs");
      const pidFile = path.join(root, "server.pid");
      const signalFile = path.join(root, "signal.txt");
      await mkdir(bin);
      await symlink(process.execPath, path.join(bin, "node"));
      await writeFile(serverPath, [
        "import { writeFileSync } from 'node:fs';",
        "writeFileSync(process.env.TEST_SERVER_PID_FILE, String(process.pid));",
        "process.on('SIGTERM', () => {",
        "  writeFileSync(process.env.TEST_SIGNAL_FILE, 'SIGTERM');",
        "});",
        "setInterval(() => {}, 1000);",
        "",
      ].join("\n"));

      const child = spawn(process.execPath, ["--import", preludePath, bootstrapPath], {
        env: {
          ...process.env,
          PATH: bin,
          CLAUDE_ARCHITECT_SERVER_PATH: serverPath,
          TEST_SERVER_PID_FILE: pidFile,
          TEST_SIGNAL_FILE: signalFile,
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let serverPid = 0;
      try {
        serverPid = Number(await waitForFile(pidFile));
        child.kill("SIGTERM");
        expect(await waitForFile(signalFile)).toBe("SIGTERM");
        const exit = await waitForExit(child, 15_000);
        await waitForProcessGone(serverPid);
        expect(exit).toEqual({ code: null, signal: "SIGTERM" });
        expect(isProcessAlive(serverPid)).toBe(false);
      } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        await reapServer(pidFile, serverPid);
      }
    },
  );

  it.skipIf(process.platform === "win32")("mirrors direct signal termination from the server", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "ca-bootstrap-child-signal-"));
    temporaryPaths.push(root);
    const preludePath = await nodeVersionPrelude(root, "20.19.0");
    const bin = path.join(root, "bin");
    const serverPath = path.join(root, "signal-server.mjs");
    const pidFile = path.join(root, "server.pid");
    await mkdir(bin);
    await symlink(process.execPath, path.join(bin, "node"));
    await writeFile(serverPath, [
      "import { writeFileSync } from 'node:fs';",
      "writeFileSync(process.env.TEST_SERVER_PID_FILE, String(process.pid));",
      "setInterval(() => {}, 1000);",
      "",
    ].join("\n"));

    const child = spawn(process.execPath, ["--import", preludePath, bootstrapPath], {
      env: {
        ...process.env,
        PATH: bin,
        CLAUDE_ARCHITECT_SERVER_PATH: serverPath,
        TEST_SERVER_PID_FILE: pidFile,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let serverPid = 0;
    try {
      serverPid = Number(await waitForFile(pidFile));
      process.kill(serverPid, "SIGTERM");
      const exit = await waitForExit(child);
      await waitForProcessGone(serverPid);
      expect(exit).toEqual({ code: null, signal: "SIGTERM" });
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await reapServer(pidFile, serverPid);
    }
  });
});
