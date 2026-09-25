import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AutopilotControllerError,
  type AutopilotStartResult,
} from "../../../src/autopilot/autopilot-controller.js";
import type { AutopilotWorkflowState } from "../../../src/autopilot/types.js";
import type { AutopilotSpec } from "../../../src/protocol/autopilot-spec.js";
import { PROTOCOL_VERSION } from "../../../src/protocol/versions.js";
import { createServer } from "../../../src/mcp/server.js";

const CHECKOUT = "/canonical/repository";
const WORKFLOW_ID = "workflow-mcp-12345678";
const OID = "1".repeat(40);
const HASH = "a".repeat(64);
const NOW = "2026-07-21T12:00:00.000Z";

function verification() {
  return [{
    id: "typecheck",
    executable: "npx",
    args: ["tsc", "--noEmit"],
    cwd: ".",
    timeoutMs: 120_000,
    network: "denied" as const,
    expectedExitCodes: [0],
  }];
}

function validSpec(): AutopilotSpec {
  return {
    specVersion: "2",
    topic: "autopilot-mcp",
    base: { remote: "origin", branch: "main" },
    tasks: [{
      id: "mcp-surface",
      commitMessage: "feat(runtime): expose autopilot MCP tools",
      delegation: {
        specVersion: "1",
        objective: "Expose the autopilot workflow over MCP.",
        context: "Runtime contracts are authoritative.",
        writeAllowlist: ["src/**", "tests/**"],
        forbiddenScope: [".git/**"],
        successCriteria: ["The tools are validated and discoverable."],
        verification: verification(),
        executionMode: "edit",
        timeoutMs: 600_000,
        producerPreferences: ["codex"],
        expectedOutput: "candidate-patch",
      },
    }],
    finalSuccessCriteria: ["The MCP surface passes its protocol tests."],
    finalVerification: verification(),
  };
}

function workflowState(): AutopilotWorkflowState {
  return {
    stateVersion: "2",
    workflowId: WORKFLOW_ID,
    repositoryIdentity: `${CHECKOUT}/.git`,
    baseCommitOid: OID,
    workflowRef: `refs/claude-architect/autopilot/${WORKFLOW_ID}/base`,
    worktreePath: "/state/autopilot-worktree",
    autopilotSpecHash: HASH,
    revision: 3,
    phase: "running-task",
    currentTaskIndex: 0,
    tasks: [{
      id: "mcp-surface",
      runId: null,
      candidateManifestHash: null,
      eligibilityHash: null,
      promotionCommitOid: null,
      status: "running",
    }],
    intentJournal: { ref: "journal.ndjson", entryCount: 2, lastEntryHash: HASH },
    finalGate: null,
    branch: "feat/autopilot-mcp-workflow",
    cleanup: null,
    terminal: null,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

/** Mirrors the controller's own redaction projection for mock returns. */
function redactedProjectionOf(state: AutopilotWorkflowState): AutopilotWorkflowState {
  state.repositoryIdentity = "[redacted]";
  state.worktreePath = "[redacted]";
  return state;
}

function structured(result: Awaited<ReturnType<Client["callTool"]>>): Record<string, unknown> {
  return result.structuredContent ?? {};
}

function toolErrorText(result: Awaited<ReturnType<Client["callTool"]>>): string {
  expect(result.isError).toBe(true);
  return result.content.map(item => "text" in item ? item.text : "").join("\n");
}

describe("autopilot MCP surface", () => {
  let client: Client;
  let server: McpServer;
  const start = vi.fn(async (): Promise<AutopilotStartResult> => ({
    ...workflowState(),
    status: "ready-for-human-review",
    headCommitOid: OID,
    pullRequest: {
      number: 42,
      url: "https://github.com/example/repository/pull/42",
      repository: "example/repository",
      baseBranch: "main",
      headBranch: "feat/autopilot-mcp-workflow",
      headCommitOid: OID,
      draft: false,
    },
  }));
  const status = vi.fn(async (checkoutPath: string, workflowId: string) => {
    if (workflowId === "unknown-workflow") {
      throw new AutopilotControllerError("workflow-state-not-found");
    }
    if (checkoutPath !== CHECKOUT) {
      throw new AutopilotControllerError("repository-identity-mismatch");
    }
    return redactedProjectionOf(workflowState());
  });
  const resume = vi.fn(async () => workflowState());

  beforeEach(async () => {
    vi.clearAllMocks();
    server = await createServer({
      recoverStaleRuns: async () => ({ recovered: [], skipped: [] }),
      autopilotControllerFactory: () => ({ start, status, resume }),
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    client = new Client(
      { name: "autopilot-mcp-test", version: "1.0.0" },
      { capabilities: {} },
    );
    await client.connect(clientTransport);
  });

  afterEach(async () => {
    await client.close();
    await server.close();
  });

  it("discovers all three tools with object schemas and only status read-only", async () => {
    const listed = await client.listTools();
    const tools = listed.tools.filter(tool => tool.name.startsWith("autopilot"));
    expect(tools.map(tool => tool.name).sort()).toEqual([
      "autopilotResume",
      "autopilotStart",
      "autopilotStatus",
    ]);
    expect(tools.every(tool => tool.inputSchema.type === "object")).toBe(true);
    expect(tools.find(tool => tool.name === "autopilotStatus")?.annotations?.readOnlyHint)
      .toBe(true);
    expect(tools.find(tool => tool.name === "autopilotStart")?.annotations?.readOnlyHint)
      .not.toBe(true);
    expect(tools.find(tool => tool.name === "autopilotResume")?.annotations?.readOnlyHint)
      .not.toBe(true);
  });

  it("does not let an unrelated startup sweep issue block another repository", async () => {
    await client.close();
    await server.close();
    server = await createServer({
      recoverStaleRuns: async () => ({
        recovered: [],
        quarantined: [],
        worktreeSweepIssues: [{ worktreePath: "/redacted", reason: "ambiguous removal" }],
      }),
      pruneRuns: async () => {},
      autopilotControllerFactory: () => ({ start, status, resume }),
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    client = new Client(
      { name: "autopilot-mcp-ambiguity-test", version: "1.0.0" },
      { capabilities: {} },
    );
    await client.connect(clientTransport);

    const observed = await client.callTool({
      name: "autopilotStatus",
      arguments: { checkoutPath: CHECKOUT, workflowId: WORKFLOW_ID, protocolVersion: PROTOCOL_VERSION },
    });
    const resumed = await client.callTool({
      name: "autopilotResume",
      arguments: { checkoutPath: CHECKOUT, workflowId: WORKFLOW_ID, protocolVersion: PROTOCOL_VERSION },
    });

    expect(structured(observed)).toMatchObject({ ok: true });
    expect(structured(resumed)).toMatchObject({ ok: true });
    expect(resume).toHaveBeenCalledOnce();
  });

  it("passes validated start, status, and resume inputs through", async () => {
    const started = await client.callTool({
      name: "autopilotStart",
      arguments: { checkoutPath: CHECKOUT, spec: validSpec(), protocolVersion: PROTOCOL_VERSION },
    });
    const observed = await client.callTool({
      name: "autopilotStatus",
      arguments: { checkoutPath: CHECKOUT, workflowId: WORKFLOW_ID, protocolVersion: PROTOCOL_VERSION },
    });
    const resumed = await client.callTool({
      name: "autopilotResume",
      arguments: { checkoutPath: CHECKOUT, workflowId: WORKFLOW_ID, protocolVersion: PROTOCOL_VERSION },
    });

    expect(structured(started)).toMatchObject({ ok: true, result: { workflowId: WORKFLOW_ID } });
    expect(structured(observed)).toMatchObject({ ok: true, result: { workflowId: WORKFLOW_ID } });
    expect(structured(resumed)).toMatchObject({ ok: true, result: { workflowId: WORKFLOW_ID } });
    expect(start).toHaveBeenCalledWith(CHECKOUT, validSpec());
    expect(status).toHaveBeenCalledWith(CHECKOUT, WORKFLOW_ID);
    expect(resume).toHaveBeenCalledWith(CHECKOUT, WORKFLOW_ID);
  });

  // This suite mocks the controller, and the controller is what redacts
  // (`redactedState`, src/autopilot/autopilot-controller.ts). Asserting
  // "[redacted]" here only proved the mock returned what the mock was told to
  // return. Redaction itself is proven against the real controller in
  // autopilot-controller.test.ts ("returns redacted status using only
  // read-only collaborators"); what this layer owns is passing the controller's
  // projection through to the client without widening it.
  it("passes the controller status projection through start and resume unchanged", async () => {
    const sensitive = workflowState();
    const projected = redactedProjectionOf(sensitive);
    status.mockResolvedValueOnce(projected);
    status.mockResolvedValueOnce(projected);
    resume.mockResolvedValueOnce(projected);

    const started = await client.callTool({
      name: "autopilotStart",
      arguments: { checkoutPath: CHECKOUT, spec: validSpec(), protocolVersion: PROTOCOL_VERSION },
    });
    const resumed = await client.callTool({
      name: "autopilotResume",
      arguments: { checkoutPath: CHECKOUT, workflowId: WORKFLOW_ID, protocolVersion: PROTOCOL_VERSION },
    });

    for (const output of [structured(started), structured(resumed)]) {
      const serialized = JSON.stringify(output);
      expect(serialized).not.toContain(`${CHECKOUT}/.git`);
      expect(serialized).not.toContain("/state/autopilot-worktree");
      expect(serialized).not.toContain("https://");
      expect(output).toMatchObject({
        ok: true,
        result: {
          repositoryIdentity: "[redacted]",
          worktreePath: "[redacted]",
        },
      });
    }
  });

  it.each(["authority", "gate", "hash", "branch", "argv"])(
    "strictly rejects the extra %s field on every input shape",
    async field => {
      const invalidStart = await client.callTool({
        name: "autopilotStart",
        arguments: {
          checkoutPath: CHECKOUT,
          spec: validSpec(),
          protocolVersion: PROTOCOL_VERSION,
          [field]: field === "argv" ? ["gh", "pr", "ready"] : "forbidden",
        },
      });
      const invalidResume = await client.callTool({
        name: "autopilotResume",
        arguments: {
          checkoutPath: CHECKOUT,
          workflowId: WORKFLOW_ID,
          protocolVersion: PROTOCOL_VERSION,
          [field]: field === "argv" ? ["git", "push"] : "forbidden",
        },
      });
      expect(toolErrorText(invalidStart)).toMatch(/unrecognized|invalid/iu);
      expect(toolErrorText(invalidStart)).toContain(field);
      expect(toolErrorText(invalidResume)).toMatch(/unrecognized|invalid/iu);
      expect(toolErrorText(invalidResume)).toContain(field);
    },
  );

  it("rejects the wrong protocol version before invoking the controller", async () => {
    const result = await client.callTool({
      name: "autopilotStatus",
      arguments: { checkoutPath: CHECKOUT, workflowId: WORKFLOW_ID, protocolVersion: "1.3.0" },
    });
    expect(toolErrorText(result))
      .toMatch(/protocol version mismatch.*received 1\.3\.0.*expected 3\.0\.0/isu);
    expect(status).not.toHaveBeenCalled();
  });

  it("returns structured errors for unknown workflows and repository mismatches", async () => {
    const unknown = await client.callTool({
      name: "autopilotStatus",
      arguments: {
        checkoutPath: CHECKOUT,
        workflowId: "unknown-workflow",
        protocolVersion: PROTOCOL_VERSION,
      },
    });
    const mismatch = await client.callTool({
      name: "autopilotStatus",
      arguments: {
        checkoutPath: "/different/repository",
        workflowId: WORKFLOW_ID,
        protocolVersion: PROTOCOL_VERSION,
      },
    });
    expect(structured(unknown)).toMatchObject({ ok: false, error: "workflow-state-not-found" });
    expect(structured(mismatch)).toMatchObject({ ok: false, error: "repository-identity-mismatch" });
  });

  it("rejects malformed autopilot specs before invoking the controller", async () => {
    const result = await client.callTool({
      name: "autopilotStart",
      arguments: {
        checkoutPath: CHECKOUT,
        spec: { specVersion: "1", authority: "autopilot" },
        protocolVersion: PROTOCOL_VERSION,
      },
    });
    expect(structured(result)).toMatchObject({
      ok: false,
      error: "invalid-spec",
      validationErrors: expect.any(Array),
    });
    expect(start).not.toHaveBeenCalled();
  });
});
