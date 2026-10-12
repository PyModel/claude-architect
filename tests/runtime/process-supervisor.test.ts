import { describe, it, expect, vi } from "vitest";
import { supervise } from "../../src/platform/process-supervisor.js";
import { getPlatformServices } from "../../src/platform/select-platform.js";
import type {
  PlatformServices,
  SupervisedExit,
  SupervisedProcess,
} from "../../src/platform/platform-services.js";
import { fileURLToPath } from "node:url";
const ps = getPlatformServices();
const fixture = fileURLToPath(new URL("./fixtures/echo-sleep.mjs", import.meta.url));
async function run(args: string[], timeoutMs: number, onCancel?: AbortSignal) {
  const node = await ps.resolveExecutable({ name: "node", explicitPath: process.execPath });
  return supervise(ps, { executable: node, args: [fixture, ...args], cwd: process.cwd(),
    env: { PATH: process.env.PATH ?? "" }, timeoutMs, maxOutputBytes: 1_000_000 },
    onCancel === undefined ? {} : { onCancel });
}
describe("supervise", () => {
  it("returns exit 0 for a fast process", async () => expect((await run(["hi", "", "0"], 5000)).exitCode).toBe(0));
  it("times out a stubborn process and kills the tree", async () => {
    const exit = await run(["", "", "60000", "stubborn"], 800);
    expect(exit.timedOut).toBe(true);
  }, 15000);
  it("cancels via AbortSignal", async () => {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 100);
    const exit = await run(["", "", "60000"], 30000, ac.signal);
    expect(exit.cancelled).toBe(true);
  }, 15000);
  it("still schedules forced termination when cooperative cancellation fails", async () => {
    const settled: SupervisedExit = {
      exitCode: 0,
      signal: null,
      timedOut: false,
      cancelled: false,
      stdout: "",
      stderr: "",
      truncated: { stdout: false, stderr: false },
    };
    const proc: SupervisedProcess = {
      pid: 4242,
      done: new Promise(resolve => setTimeout(() => resolve(settled), 30)),
      stdout: {} as NodeJS.ReadableStream,
      stderr: {} as NodeJS.ReadableStream,
    };
    const terminateProcessTree = vi.fn(async () => {});
    const failingServices = {
      spawnSupervised: async () => proc,
      async requestCooperativeCancellation() { throw new Error("signal denied"); },
      terminateProcessTree,
    } as unknown as PlatformServices;

    const exit = await supervise(failingServices, {
      executable: { kind: "native", command: "unused", prefixArgs: [], resolvedFrom: "test" },
      args: [],
      cwd: process.cwd(),
      env: {},
      timeoutMs: 1,
      maxOutputBytes: 1_000,
    }, { graceMs: 0 });

    expect(exit.timedOut).toBe(true);
    expect(terminateProcessTree).toHaveBeenCalledWith(proc);
  });
  it("returns spawn-failure marker for a missing executable", async () => {
    const exit = await supervise(ps, { executable: { kind: "native", command: "/no/such/bin", prefixArgs: [], resolvedFrom: "test" },
      args: [], cwd: process.cwd(), env: {}, timeoutMs: 5000, maxOutputBytes: 1000 }, {});
    expect(exit.spawnError).toBeDefined();
  });
});
