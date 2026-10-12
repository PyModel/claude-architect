import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { afterEach, describe, expect, it } from "vitest";
import {
  resolveJobKillHelper,
  WindowsPlatformServices,
} from "../../src/platform/windows-platform-services.js";
import { windowsEssentialEnvironment } from "../../src/platform/windows-env.js";
import { resolveWindowsFilesystemHelper } from "../../src/platform/windows-filesystem-helper.js";

describe("Windows job helper resolution (all OSes)", () => {
  const tempDirectories: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirectories.splice(0).map(directory => fs.rm(directory, {
      recursive: true, force: true,
    })));
  });

  async function tempRoot(): Promise<string> {
    const directory = await fs.mkdtemp(path.join(tmpdir(), "windows-helper-"));
    tempDirectories.push(directory);
    return directory;
  }

  it("resolves each packaged native filesystem helper without PowerShell", async () => {
    const [x64, arm64] = await Promise.all([
      resolveWindowsFilesystemHelper("x64"),
      resolveWindowsFilesystemHelper("arm64"),
    ]);

    expect(x64.command).toMatch(/native[\\/]bin[\\/]win32-filesystem-x64\.exe$/u);
    expect(arm64.command).toMatch(/native[\\/]bin[\\/]win32-filesystem-arm64\.exe$/u);
    expect(x64.resolvedFrom).toBe("plugin-native-filesystem-helper");
  });

  it("fails closed for an unsupported filesystem-helper architecture", async () => {
    await expect(resolveWindowsFilesystemHelper("ia32"))
      .rejects.toMatchObject({ detail: { classification: "cleanup-backend-unavailable" } });
  });

  it("resolves the architecture-specific helper path", () => {
    const root = path.join("root", "plugin");
    expect(resolveJobKillHelper(root, "x64").path).toBe(
      path.join(root, "native", "bin", "win32-job-kill-x64.exe"),
    );
  });

  it("reports whether the helper is available", async () => {
    const root = await tempRoot();
    const helper = resolveJobKillHelper(root, "x64");
    expect(await helper.checkAvailable()).toBe(false);

    await fs.mkdir(path.dirname(helper.path), { recursive: true });
    await fs.writeFile(helper.path, "fixture", { mode: 0o755 });
    expect(await helper.checkAvailable()).toBe(true);
  });

  it("fails closed before spawning when the helper is missing", async () => {
    const root = await tempRoot();
    const helper = resolveJobKillHelper(root, "x64");
    const services = new WindowsPlatformServices(root, "x64");
    const spawnAttempt = services.spawnSupervised({
      executable: {
        kind: "native",
        command: path.join(root, "must-not-be-spawned"),
        prefixArgs: [],
        resolvedFrom: "test",
      },
      args: [],
      cwd: root,
      env: {},
      timeoutMs: 1_000,
      maxOutputBytes: 1_024,
    });

    await expect(spawnAttempt).rejects.toMatchObject({
      message: "windows process-tree helper missing",
      detail: { path: helper.path },
    });
  });

  async function servicesWithExec(
    fakeExec: (...args: unknown[]) => unknown,
  ): Promise<WindowsPlatformServices> {
    const root = await tempRoot();
    const helper = resolveJobKillHelper(root, "x64");
    await fs.mkdir(path.dirname(helper.path), { recursive: true });
    await fs.writeFile(helper.path, "fixture");
    return new WindowsPlatformServices(root, "x64", fakeExec as never);
  }

  it("passes only canonical essential environment to the kill helper", async () => {
    const previousSystemRoot = process.env.SystemRoot;
    const previousSecret = process.env.UNRELATED_SECRET;
    process.env.SystemRoot = "C:\\Windows";
    process.env.UNRELATED_SECRET = "must-not-leak";
    const calls: unknown[][] = [];
    const services = await servicesWithExec((...args: unknown[]) => {
      calls.push(args);
      (args[3] as (error: null, stdout: string) => void)(null, "");
    });

    try {
      await expect(services.terminateProcessTreeByPid(42)).resolves.toBeUndefined();
      const options = calls[0]?.[2] as { env: Record<string, string> };
      expect(options.env).toMatchObject({ SystemRoot: "C:\\Windows" });
      expect(options.env).not.toHaveProperty("UNRELATED_SECRET");
      expect(Object.keys(options.env).every(name => [
        "Path", "SystemRoot", "ComSpec", "TEMP", "TMP", "USERPROFILE", "APPDATA", "LOCALAPPDATA",
      ].includes(name))).toBe(true);
    } finally {
      if (previousSystemRoot === undefined) delete process.env.SystemRoot;
      else process.env.SystemRoot = previousSystemRoot;
      if (previousSecret === undefined) delete process.env.UNRELATED_SECRET;
      else process.env.UNRELATED_SECRET = previousSecret;
    }
  });

  it("uses the native helper token mode", async () => {
    const calls: unknown[][] = [];
    const services = await servicesWithExec((...args: unknown[]) => {
      calls.push(args);
      (args[3] as (error: null, stdout: string) => void)(null, "12345\n");
    });

    await expect(services.getProcessStartToken(42)).resolves.toBe("win32:12345");
    await expect(services.getProcessStartToken(42)).resolves.toBe("win32:12345");
    expect(calls).toHaveLength(2);
    expect(calls[0]?.[1]).toEqual(["token", "42"]);
    expect((calls[0]?.[2] as { env: Record<string, string> }).env)
      .toEqual(windowsEssentialEnvironment());
  });

  it("returns null for native helper exit 2 without PowerShell", async () => {
    const calls: unknown[][] = [];
    const services = await servicesWithExec((...args: unknown[]) => {
      calls.push(args);
      (args[3] as (error: Error & { code: number }, stdout: string) => void)(
        Object.assign(new Error("gone"), { code: 2 }),
        "",
      );
    });

    await expect(services.getProcessStartToken(42)).resolves.toBeNull();
    await expect(services.getProcessStartToken(42)).resolves.toBeNull();
    expect(calls).toHaveLength(2);
  });

  it("returns an unverifiable token when the native helper fails", async () => {
    const calls: unknown[][] = [];
    const services = await servicesWithExec((...args: unknown[]) => {
      calls.push(args);
      (args[3] as (error: Error, stdout: string) => void)(new Error("helper failed"), "");
    });

    await expect(services.getProcessStartToken(42)).resolves.toBeNull();
    expect(calls).toHaveLength(1);
  });

  it("memoizes a successful own-process token", async () => {
    let calls = 0;
    const services = await servicesWithExec((...args: unknown[]) => {
      calls += 1;
      (args[3] as (error: null, stdout: string) => void)(null, "12345");
    });

    await expect(services.getProcessStartToken(process.pid)).resolves.toBe("win32:12345");
    await expect(services.getProcessStartToken(process.pid)).resolves.toBe("win32:12345");
    expect(calls).toBe(1);
  });
});
