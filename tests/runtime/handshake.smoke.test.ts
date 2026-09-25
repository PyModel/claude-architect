import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer } from "../../src/mcp/server.js";
import type { PlatformServices } from "../../src/platform/platform-services.js";
import { getPlatformServices } from "../../src/platform/select-platform.js";
import { PROTOCOL_VERSION } from "../../src/protocol/versions.js";

const bootstrapPath = fileURLToPath(new URL("../../runtime/bootstrap.mjs", import.meta.url));
const serverPath = fileURLToPath(new URL("../../runtime/server.mjs", import.meta.url));
const temporaryPaths: string[] = [];
const validSpec = {
  specVersion: "1",
  objective: "change one file",
  context: "test",
  writeAllowlist: ["src/**"],
  forbiddenScope: [],
  successCriteria: ["tests pass"],
  verification: [{
    id: "check",
    executable: "node",
    args: ["-e", "process.exit(0)"],
    cwd: ".",
    timeoutMs: 60_000,
    network: "denied",
    expectedExitCodes: [0],
  }],
  executionMode: "edit",
  timeoutMs: 600_000,
  producerPreferences: ["codex"],
  expectedOutput: "candidate-patch",
};

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id?: number;
  result?: Record<string, unknown>;
  error?: Record<string, unknown>;
}

async function waitForExit(child: ChildProcessWithoutNullStreams, timeoutMs = 2_000): Promise<{
  code: number | null;
  signal: NodeJS.Signals | null;
}> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return { code: child.exitCode, signal: child.signalCode };
  }
  return await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("timed out waiting for MCP server exit")), timeoutMs);
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      resolve({ code, signal });
    });
  });
}

// createServer runs recovery AND pruneRuns against the ambient state root, so
// without a stubbed prune and an isolated CLAUDE_PLUGIN_DATA these tests reach
// into whatever archive the developer happens to have.
let previousPluginData: string | undefined;

beforeEach(async () => {
  previousPluginData = process.env.CLAUDE_PLUGIN_DATA;
  const stateRoot = await mkdtemp(path.join(tmpdir(), "ca-handshake-state-"));
  temporaryPaths.push(stateRoot);
  process.env.CLAUDE_PLUGIN_DATA = stateRoot;
});

afterEach(async () => {
  if (previousPluginData === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
  else process.env.CLAUDE_PLUGIN_DATA = previousPluginData;
  await Promise.all(temporaryPaths.splice(0).map(entry =>
    rm(entry, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })));
});

describe("MCP server handshake", () => {
  // The denial used to live only in `start`, but `createServer` is exported and
  // wires up the whole tool surface, autopilot included. A delegated Producer
  // reaching this function must not get a server at all.
  it("refuses to build the tool surface inside a delegated Producer", async () => {
    const previous = process.env.CLAUDE_ARCHITECT_DELEGATED;
    process.env.CLAUDE_ARCHITECT_DELEGATED = "1";
    try {
      await expect(createServer({
        recoverStaleRuns: async () => ({ recovered: [], quarantined: [] }),
        pruneRuns: async () => {},
      })).rejects.toThrow("CLAUDE_ARCHITECT_DELEGATED");
    } finally {
      if (previous === undefined) delete process.env.CLAUDE_ARCHITECT_DELEGATED;
      else process.env.CLAUDE_ARCHITECT_DELEGATED = previous;
    }
  });

  it("keeps read-only tools available but gates mutations while recovery is ambiguous", async () => {
    const recover = vi.fn(async () => ({
      recovered: [],
      quarantined: [],
      worktreeSweepIssues: [{
        worktreePath: "/private/repository/worktree",
        reason: "unverifiable checkout owner",
        repositoryIdentity: "/repo/.git",
      }],
    }));
    const ps = Object.create(getPlatformServices()) as PlatformServices;
    ps.canonicalizePath = async input => ({
      input,
      canonical: input,
      gitCommonDir: `${input}/.git`,
    });
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const server = await createServer({
      ps,
      recoverStaleRuns: recover,
      pruneRuns: async () => {},
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: "recovery-gate-test", version: "1.0.0" });
    await client.connect(clientTransport);
    try {
      const validation = await client.callTool({
        name: "validateDelegationSpec",
        arguments: { spec: validSpec, protocolVersion: PROTOCOL_VERSION },
      });
      expect(validation.isError).not.toBe(true);
      expect(recover).toHaveBeenCalledTimes(1);

      const unrelated = await client.callTool({
        name: "delegate",
        arguments: {
          checkoutPath: "/other",
          spec: validSpec,
          protocolVersion: PROTOCOL_VERSION,
        },
      });
      expect(JSON.stringify(unrelated)).not.toContain("mutating tools are unavailable");

      const delegated = await client.callTool({
        name: "delegate",
        arguments: {
          checkoutPath: "/repo",
          spec: validSpec,
          protocolVersion: PROTOCOL_VERSION,
        },
      });
      expect(delegated.isError).toBe(true);
      expect(JSON.stringify(delegated)).toContain("mutating tools are unavailable");
      expect(JSON.stringify(delegated)).not.toContain("/private/repository");
      expect(recover).toHaveBeenCalledTimes(3);
    } finally {
      log.mockRestore();
      await client.close();
      await server.close();
    }
  });

  it("advertises the source autopilot lifecycle schemas", async () => {
    const server = await createServer({
      recoverStaleRuns: async () => ({ recovered: [], quarantined: [] }),
      pruneRuns: async () => {},
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client(
      { name: "claude-architect-handshake-test", version: "1.0.0" },
      { capabilities: {} },
    );
    await client.connect(clientTransport);
    try {
      const listed = await client.listTools();
      const autopilot = listed.tools.filter(tool => tool.name.startsWith("autopilot"));
      expect(autopilot.map(tool => tool.name).sort()).toEqual([
        "autopilotResume",
        "autopilotStart",
        "autopilotStatus",
      ]);
      expect(autopilot.every(tool => tool.inputSchema.type === "object")).toBe(true);
      expect(autopilot.find(tool => tool.name === "autopilotStatus")?.annotations?.readOnlyHint)
        .toBe(true);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("lists lifecycle tools without non-protocol stdout", async () => {
    const stateRoot = await mkdtemp(path.join(tmpdir(), "ca-handshake-"));
    temporaryPaths.push(stateRoot);
    // Hermetic: when this suite itself runs under a delegated verification environment,
    // the inherited nested-delegation guard must not deny the server under test.
    const { CLAUDE_ARCHITECT_DELEGATED: _delegated, ...parentEnv } = process.env;
    const child = spawn(process.execPath, [bootstrapPath], {
      env: { ...parentEnv, CLAUDE_PLUGIN_DATA: stateRoot },
      stdio: ["pipe", "pipe", "pipe"],
    });
    child.stdin.on("error", () => {});
    let stdout = "";
    let stderr = "";
    let buffered = "";
    const responses = new Map<number, JsonRpcResponse>();
    const waiters = new Map<number, (response: JsonRpcResponse) => void>();
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", chunk => {
      stderr += chunk;
    });
    child.stdout.on("data", chunk => {
      stdout += chunk;
      buffered += chunk;
      while (buffered.includes("\n")) {
        const newline = buffered.indexOf("\n");
        const line = buffered.slice(0, newline).replace(/\r$/, "");
        buffered = buffered.slice(newline + 1);
        if (line === "") continue;
        const response = JSON.parse(line) as JsonRpcResponse;
        if (typeof response.id === "number") {
          responses.set(response.id, response);
          waiters.get(response.id)?.(response);
          waiters.delete(response.id);
        }
      }
    });

    const requestRaw = async (id: number, method: string, params: Record<string, unknown>) => {
      const response = responses.get(id) ?? await new Promise<JsonRpcResponse>((resolve, reject) => {
        const timeout = setTimeout(() => {
          waiters.delete(id);
          reject(new Error(`timed out waiting for ${method}`));
        }, 15_000); // generous: the smoke test runs under full-suite parallel load in verification worktrees
        waiters.set(id, value => {
          clearTimeout(timeout);
          resolve(value);
        });
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      });
      return response;
    };
    const request = async (id: number, method: string, params: Record<string, unknown>) => {
      const response = await requestRaw(id, method, params);
      if (response.error !== undefined) throw new Error(JSON.stringify(response.error));
      return response.result ?? {};
    };

    try {
      await request(1, "initialize", {
        protocolVersion: LATEST_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "claude-architect-test", version: "1.0.0" },
      });
      child.stdin.write(`${JSON.stringify({
        jsonrpc: "2.0",
        method: "notifications/initialized",
        params: {},
      })}\n`);
      const listed = await request(2, "tools/list", {});
      const tools = listed.tools as Array<{ name: string; outputSchema?: Record<string, unknown> }>;
      const names = tools.map(tool => tool.name).sort();
      const validated = await request(3, "tools/call", {
        name: "validateDelegationSpec",
        arguments: {
          protocolVersion: PROTOCOL_VERSION,
          spec: validSpec,
        },
      });
      const called = await request(4, "tools/call", {
        name: "delegate",
        arguments: {
          checkoutPath: "/unused-invalid-spec",
          protocolVersion: PROTOCOL_VERSION,
          spec: validSpec,
          expectedSpecSha256: "0".repeat(64),
        },
      });
      const diagnosed = await request(5, "tools/call", {
        name: "doctor",
        arguments: {},
      });
      // Distinct id: the doctor call above already used 5, and two requests
      // sharing an id race to match the same response.
      const mismatched = await requestRaw(6, "tools/call", {
        name: "delegate",
        arguments: {
          checkoutPath: "/unused-invalid-spec",
          protocolVersion: "2.0.0",
          spec: { specVersion: "1" },
        },
      });
      const mismatchDiagnostic = JSON.stringify(mismatched);

      expect(names).toEqual([
        "autopilotResume",
        "autopilotStart",
        "autopilotStatus",
        "decideCandidate",
        "delegate",
        "delegatePipeline",
        "doctor",
        "gitChangedFiles",
        "gitDiff",
        "gitLog",
        "gitStatus",
        "integrateCandidate",
        "reviewCandidate",
        "validateDelegationSpec",
      ]);
      expect(tools.every(tool => tool.outputSchema !== undefined)).toBe(true);
      expect(validated.structuredContent).toEqual({
        ok: true,
        specSha256: "75d6bdadedf7b97cbae5bce0b3d401bfb77a6099cf158d6f8fe5b39f3964eb69",
      });
      expect(called.structuredContent).toEqual({
        ok: false,
        error: "spec-identity-mismatch",
        diagnostic: "the validated Delegation Spec does not match expectedSpecSha256",
      });
      expect(called.content).toEqual([{
        type: "text",
        text: JSON.stringify(called.structuredContent),
      }]);
      expect(diagnosed.structuredContent).toMatchObject({
        runtimeVersion: expect.any(String),
        protocolVersion: PROTOCOL_VERSION,
        producers: expect.any(Array),
        issues: expect.any(Array),
      });
      expect(mismatchDiagnostic).toContain("protocol version mismatch");
      expect(mismatchDiagnostic).toContain("received 2.0.0");
      expect(mismatchDiagnostic).toContain("expected 3.0.0");
      expect(stdout.trim().split(/\r?\n/).every(line => {
        try {
          JSON.parse(line);
          return true;
        } catch {
          return false;
        }
      })).toBe(true);
      expect(stderr).toContain("claude-architect MCP server ready");
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      await waitForExit(child);
    }
  });

  it("refuses nested startup on stderr without protocol output", async () => {
    const result = await new Promise<{
      code: number | null;
      stdout: string;
      stderr: string;
    }>((resolve, reject) => {
      const child = spawn(process.execPath, [serverPath], {
        env: { ...process.env, CLAUDE_ARCHITECT_DELEGATED: "1" },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", chunk => {
        stdout += chunk;
      });
      child.stderr.on("data", chunk => {
        stderr += chunk;
      });
      child.once("error", reject);
      child.once("exit", code => resolve({ code, stdout, stderr }));
    });

    expect(result.code).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("CLAUDE_ARCHITECT_DELEGATED");
  });
});
