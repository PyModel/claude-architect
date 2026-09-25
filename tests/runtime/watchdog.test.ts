import { describe, expect, it } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const WATCHDOG = fileURLToPath(new URL("../../runtime/watchdog.mjs", import.meta.url));

describe("producer watchdog", () => {
  it("forwards the child's exit code when the supervisor stays alive", () => {
    const result = spawnSync(process.execPath, [
      WATCHDOG, String(process.pid), "--", process.execPath, "-e", "process.exit(7)",
    ], { timeout: 15_000 });
    expect(result.status).toBe(7);
  });

  it("kills the child when the supervisor dies", async () => {
    const supervisor = spawn(process.execPath, ["-e", "setTimeout(() => {}, 1_000)"]);
    await new Promise(resolve => supervisor.once("spawn", resolve));
    // The runtime always starts the watchdog as a process-group leader.
    const child = spawn(process.execPath, [
      WATCHDOG, String(supervisor.pid), "--", process.execPath, "-e", "setInterval(() => {}, 1000)",
    ], { detached: process.platform !== "win32" });
    const exit = await new Promise<number | null>(resolve => {
      const timer = setTimeout(() => resolve(null), 30_000);
      child.once("exit", code => { clearTimeout(timer); resolve(code ?? 0); });
    });
    expect(exit).not.toBeNull();
  }, 40_000);

  it.runIf(process.platform !== "win32")(
    "a group SIGKILL reaches a producer that ignores SIGTERM",
    async () => {
      const producer = "process.on('SIGTERM', () => {}); process.stdout.write(String(process.pid)); setInterval(() => {}, 1000)";
      const watchdog = spawn(process.execPath, [
        WATCHDOG, String(process.pid), "--", process.execPath, "-e", producer,
      ], { detached: true, stdio: ["ignore", "pipe", "ignore"] });
      const producerPid = await new Promise<number>(resolve =>
        watchdog.stdout!.once("data", chunk => resolve(Number(String(chunk)))));

      // What supervise's escalation and startup recovery both do.
      process.kill(-watchdog.pid!, "SIGTERM");
      await new Promise(resolve => setTimeout(resolve, 300));
      process.kill(-watchdog.pid!, "SIGKILL");
      await new Promise(resolve => setTimeout(resolve, 300));

      expect(() => process.kill(producerPid, 0)).toThrow();
    },
    20_000,
  );
});
