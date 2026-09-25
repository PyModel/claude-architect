import {
  appendFile,
  link,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  LEGAL_WORKFLOW_PHASE_EDGES,
  WorkflowStore,
} from "../../../src/autopilot/workflow-store.js";
import type { WorkflowStoreOptions } from "../../../src/autopilot/workflow-store.js";
import type {
  AutopilotPhase,
  AutopilotWorkflowState,
} from "../../../src/autopilot/types.js";

const temporaryDirectories: string[] = [];
const PRIMARY_PATH: AutopilotPhase[] = [
  "preflighting",
  "running-task",
  "promoting-task",
  "final-review",
  "cleaning-up",
];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory =>
    rm(directory, { recursive: true, force: true })));
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "workflow-store-"));
  temporaryDirectories.push(directory);
  return directory;
}

function initialState(workflowId: string): AutopilotWorkflowState {
  return {
    stateVersion: "2",
    workflowId,
    repositoryIdentity: "/canonical/repository/.git",
    baseCommitOid: "1".repeat(40),
    workflowRef: `refs/heads/autopilot/${workflowId}`,
    worktreePath: `/runtime/worktrees/${workflowId}`,
    autopilotSpecHash: "2".repeat(64),
    revision: 0,
    phase: "preflighting",
    currentTaskIndex: 0,
    tasks: [{
      id: "task-1",
      runId: null,
      candidateManifestHash: null,
      eligibilityHash: null,
      promotionCommitOid: null,
      status: "pending",
    }],
    intentJournal: {
      ref: "journal.ndjson",
      entryCount: 0,
      lastEntryHash: null,
    },
    finalGate: null,
    branch: `autopilot/${workflowId}`,
    cleanup: null,
    terminal: null,
    createdAt: "2026-07-20T18:00:00.000Z",
    updatedAt: "2026-07-20T18:00:00.000Z",
  };
}

async function createStore(
  workflowId = "workflow-1",
  options: Pick<
    WorkflowStoreOptions,
    "isProcessAlive" | "getProcessStartToken"
  > = {},
): Promise<WorkflowStore> {
  const stateDirectory = await temporaryDirectory();
  const store = new WorkflowStore(workflowId, {
    stateDirectory,
    now: () => "2026-07-20T18:01:00.000Z",
    ...options,
  });
  await store.create(initialState(workflowId));
  return store;
}

async function advanceTo(
  store: WorkflowStore,
  target: AutopilotPhase,
): Promise<AutopilotWorkflowState> {
  let state = await store.read();
  for (const phase of PRIMARY_PATH.slice(1)) {
    if (state.phase === target) return state;
    state = await store.transition({ expectedRevision: state.revision, to: phase });
  }
  return state;
}

describe("WorkflowStore", () => {
  it("creates and reads an independently cloned, schema-validated state", async () => {
    const stateDirectory = await temporaryDirectory();
    const state = initialState("create-read");
    const store = new WorkflowStore("create-read", { stateDirectory });

    const created = await store.create(state);
    created.tasks[0]!.status = "halted";
    state.tasks[0]!.status = "running";

    expect((await store.read()).tasks[0]!.status).toBe("pending");
    await expect(store.create(initialState("create-read")))
      .rejects.toMatchObject({ detail: { toolError: "workflow-state-conflict" } });
  });

  it("acquires the durable workflow lease exclusively", async () => {
    const store = await createStore("lease-acquire", {
      getProcessStartToken: async () => "current-process-token",
    });

    const owner = await store.acquireLease();

    expect(owner).toEqual({
      workflowId: "lease-acquire",
      pid: process.pid,
      processToken: "current-process-token",
      acquiredAt: "2026-07-20T18:01:00.000Z",
    });
    expect(JSON.parse(await readFile(store.ownerPath, "utf8"))).toEqual(owner);
    await expect(store.acquireLease())
      .rejects.toMatchObject({ detail: { toolError: "workflow-lease-conflict" } });
  });

  it("adopts a workflow lease whose process is dead", async () => {
    const store = await createStore("lease-adopt-dead");
    const child = spawn(process.execPath, ["-e", "process.exit(0)"]);
    const deadPid = child.pid;
    if (deadPid === undefined) throw new Error("child process did not start");
    await once(child, "exit");
    await writeFile(store.ownerPath, `${JSON.stringify({
      workflowId: store.workflowId,
      pid: deadPid,
      processToken: "dead-process-token",
      acquiredAt: "2026-07-20T17:00:00.000Z",
    })}\n`, { mode: 0o600 });

    const owner = await store.adoptLease();

    expect(owner).toMatchObject({ workflowId: store.workflowId, pid: process.pid });
    expect(JSON.parse(await readFile(store.ownerPath, "utf8"))).toEqual(owner);
  });

  it("refuses to adopt a workflow lease whose owner is alive", async () => {
    const processDependencies = {
      isProcessAlive: () => true,
      getProcessStartToken: async () => "current-process-token",
    };
    const store = await createStore("lease-refuse-live", processDependencies);
    const owner = await store.acquireLease();
    const competing = new WorkflowStore(store.workflowId, {
      stateDirectory: path.dirname(path.dirname(store.workflowDirectory)),
      ...processDependencies,
    });

    await expect(competing.adoptLease())
      .rejects.toMatchObject({ detail: { toolError: "workflow-lease-conflict" } });
    expect(JSON.parse(await readFile(store.ownerPath, "utf8"))).toEqual(owner);
  });

  it("releases the workflow lease without enforcing terminal state", async () => {
    const store = await createStore("lease-release");
    await store.acquireLease();

    await store.releaseLease();

    await expect(readFile(store.ownerPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await store.read()).toMatchObject({ phase: "preflighting", terminal: null });
  });

  it("adopts an alive PID when its process token proves PID reuse", async () => {
    const store = await createStore("lease-pid-reuse", {
      isProcessAlive: () => true,
      getProcessStartToken: async () => "current-process-token",
    });
    const original = await store.acquireLease();
    expect(original.processToken).toEqual(expect.any(String));
    const staleOwner = {
      ...original,
      processToken: `${original.processToken}-stale`,
      acquiredAt: "2026-07-20T17:00:00.000Z",
    };
    await writeFile(store.ownerPath, `${JSON.stringify(staleOwner)}\n`, { mode: 0o600 });

    const adopted = await store.adoptLease();

    expect(adopted).toEqual(original);
    expect(JSON.parse(await readFile(store.ownerPath, "utf8"))).toEqual(original);
  });

  it("holds the workflow writer lease across an identity-sensitive operation", async () => {
    const store = await createStore("locked-state-operation");
    let enterOperation!: () => void;
    let releaseOperation!: () => void;
    const entered = new Promise<void>(resolve => { enterOperation = resolve; });
    const release = new Promise<void>(resolve => { releaseOperation = resolve; });
    const operation = store.withLockedState(0, async state => {
      expect(state).toMatchObject({ revision: 0, phase: "preflighting" });
      enterOperation();
      await release;
      return state.workflowId;
    });
    await entered;

    await expect(store.transition({ expectedRevision: 0, to: "running-task" }))
      .rejects.toMatchObject({ detail: { toolError: "workflow-revision-conflict" } });
    releaseOperation();
    await expect(operation).resolves.toBe("locked-state-operation");
  });

  it("rejects an illegal edge without changing persisted state", async () => {
    const store = await createStore("illegal-edge");

    await expect(store.transition({ expectedRevision: 0, to: "cleaning-up" }))
      .rejects.toMatchObject({ detail: { toolError: "invalid-workflow-transition" } });
    expect(await store.read()).toMatchObject({ revision: 0, phase: "preflighting" });
  });

  it("defines every legal edge and makes all terminal phases absorbing", () => {
    expect(LEGAL_WORKFLOW_PHASE_EDGES).toEqual({
      preflighting: ["running-task", "human-decision-required", "failed", "cancelled"],
      "running-task": ["promoting-task", "human-decision-required", "failed", "cancelled"],
      "promoting-task": [
        "running-task",
        "final-review",
        "human-decision-required",
        "failed",
        "cancelled",
      ],
      "final-review": ["cleaning-up", "human-decision-required", "failed", "cancelled"],
      "cleaning-up": ["ready-for-human-review", "human-decision-required", "failed", "cancelled"],
      "ready-for-human-review": [],
      "human-decision-required": [],
      failed: [],
      cancelled: [],
    });
  });

  it("allows exactly one concurrent writer for a revision", async () => {
    const store = await createStore("cas-race");
    const results = await Promise.allSettled([
      store.transition({ expectedRevision: 0, to: "running-task" }),
      store.transition({ expectedRevision: 0, to: "failed" }),
    ]);

    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter(result => result.status === "rejected")).toHaveLength(1);
    expect((await store.read()).revision).toBe(1);
    await expect(store.transition({ expectedRevision: 0, to: "running-task" }))
      .rejects.toMatchObject({ detail: { toolError: "workflow-revision-conflict" } });
  });

  it("recovers an abandoned writer lock after abrupt process termination", async () => {
    const store = await createStore("crashed-writer-lock");
    const childScript = [
      "const fs = require('node:fs');",
      "const crypto = require('node:crypto');",
      "const directory = process.argv[1];",
      "const lockPath = process.argv[2];",
      "const token = crypto.randomUUID();",
      "const ownerPath = require('node:path').join(directory, `.state.lock.${token}.owner`);",
      "const record = JSON.stringify({ lockVersion: '1', pid: process.pid, processToken: null, token }) + '\\n';",
      "const fd = fs.openSync(ownerPath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);",
      "fs.writeFileSync(fd, record);",
      "fs.fsyncSync(fd);",
      "fs.linkSync(ownerPath, lockPath);",
      "process.stdout.write('locked\\n');",
      "setInterval(() => {}, 60_000);",
    ].join("\n");
    const child = spawn(process.execPath, [
      "-e",
      childScript,
      store.workflowDirectory,
      store.lockPath,
    ], { stdio: ["ignore", "pipe", "pipe"] });
    const locked = new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.stdout.once("data", chunk => {
        if (chunk.toString("utf8").includes("locked")) resolve();
        else reject(new Error(`unexpected child output: ${chunk.toString("utf8")}`));
      });
    });
    await locked;
    expect(child.kill()).toBe(true);
    await once(child, "exit");

    const restarted = new WorkflowStore("crashed-writer-lock", {
      stateDirectory: path.dirname(path.dirname(store.workflowDirectory)),
    });
    const competing = new WorkflowStore("crashed-writer-lock", {
      stateDirectory: path.dirname(path.dirname(store.workflowDirectory)),
    });
    const results = await Promise.allSettled([
      restarted.transition({ expectedRevision: 0, to: "running-task" }),
      competing.transition({ expectedRevision: 0, to: "failed" }),
    ]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter(result => result.status === "rejected")).toHaveLength(1);
    expect(await restarted.read()).toMatchObject({ revision: 1 });
    expect((await readdir(store.workflowDirectory)).filter(name => name.endsWith(".owner")))
      .toEqual([]);
  }, 10_000);

  it("requires final review then cleaning-up and successful cleanup before success", async () => {
    const store = await createStore("successful-ending");
    let state = await advanceTo(store, "final-review");

    await expect(store.transition({
      expectedRevision: state.revision,
      to: "ready-for-human-review",
    })).rejects.toMatchObject({ detail: { toolError: "invalid-workflow-transition" } });

    state = await store.transition({ expectedRevision: state.revision, to: "cleaning-up" });
    await expect(store.transition({
      expectedRevision: state.revision,
      to: "ready-for-human-review",
    })).rejects.toMatchObject({ detail: { toolError: "invalid-workflow-state" } });

    state = await store.transition({
      expectedRevision: state.revision,
      to: "ready-for-human-review",
      patch: {
        cleanup: {
          status: "succeeded",
          worktreeRemoved: true,
          lockReleased: true,
          error: null,
          completedAt: "2026-07-20T18:01:00.000Z",
        },
      },
    });
    expect(state).toMatchObject({
      phase: "ready-for-human-review",
      terminal: { classification: "ready-for-human-review" },
    });
    await expect(store.transition({ expectedRevision: state.revision, to: "failed" }))
      .rejects.toMatchObject({ detail: { toolError: "invalid-workflow-transition" } });
  });

  it("increments revisions while preserving immutable identity and the hand-off branch", async () => {
    const store = await createStore("immutable-fields");
    const state = await store.transition({
      expectedRevision: 0,
      to: "running-task",
      update: draft => {
        draft.repositoryIdentity = "/substituted";
        draft.branch = "substituted/branch";
        draft.tasks[0]!.status = "running";
      },
    });

    expect(state).toMatchObject({
      revision: 1,
      phase: "running-task",
      repositoryIdentity: "/canonical/repository/.git",
      branch: initialState("immutable-fields").branch,
      tasks: [{ status: "running" }],
    });
  });

  it("records a CAS update that preserves the phase", async () => {
    const store = await createStore("cas-update");
    const running = await advanceTo(store, "running-task");
    const updated = await store.update({
      expectedRevision: running.revision,
      patch: { currentTaskIndex: 0 },
    });

    expect(updated).toMatchObject({ revision: running.revision + 1, phase: "running-task" });
    await expect(store.update({
      expectedRevision: running.revision,
      patch: { currentTaskIndex: 0 },
    })).rejects.toMatchObject({ detail: { toolError: "workflow-revision-conflict" } });
  });

  it("names a workflow persisted by the shipping (v1) runtime instead of calling it malformed", async () => {
    const store = await createStore("retired-v1-state");
    const persisted = JSON.parse(await readFile(store.statePath, "utf8"));
    await writeFile(store.statePath, JSON.stringify({ ...persisted, stateVersion: "1" }), "utf8");
    await expect(store.read())
      .rejects.toMatchObject({ detail: { toolError: "workflow-state-version-unsupported" } });
  });

  it("rejects malformed, oversize, and symlink-substituted persisted state", async () => {
    const malformed = await createStore("malformed-state");
    await writeFile(malformed.statePath, "{not-json", "utf8");
    await expect(malformed.read())
      .rejects.toMatchObject({ detail: { toolError: "invalid-workflow-state" } });

    const oversize = await createStore("oversize-state");
    await writeFile(oversize.statePath, "x".repeat(1_000_001), "utf8");
    await expect(oversize.read())
      .rejects.toMatchObject({ detail: { toolError: "workflow-state-too-large" } });

    if (process.platform !== "win32") {
      const substituted = await createStore("symlink-state");
      const external = path.join(await temporaryDirectory(), "external.json");
      await writeFile(external, await readFile(substituted.statePath));
      await rm(substituted.statePath);
      await symlink(external, substituted.statePath, "file");
      await expect(substituted.read()).rejects.toBeDefined();
      expect(JSON.parse(await readFile(external, "utf8"))).toMatchObject({ revision: 0 });
    }
  });

  it("validates input before publishing and leaves no state on failure", async () => {
    const stateDirectory = await temporaryDirectory();
    const store = new WorkflowStore("invalid-create", { stateDirectory });
    const invalid = initialState("invalid-create") as AutopilotWorkflowState & {
      unexpected?: boolean;
    };
    invalid.unexpected = true;

    await expect(store.create(invalid))
      .rejects.toMatchObject({ detail: { toolError: "invalid-workflow-state" } });
    await expect(readFile(store.statePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects temporary-file substitution before atomic publication", async () => {
    class SubstitutingStore extends WorkflowStore {
      substitute = false;

      protected override async stageStatePublication(
        temporaryPath: string,
        publicationPath: string,
        expectedBytes: Buffer,
        expectedIdentity: { dev: bigint; ino: bigint },
      ): Promise<void> {
        expect(typeof expectedIdentity.dev).toBe("bigint");
        expect(typeof expectedIdentity.ino).toBe("bigint");
        if (!this.substitute) {
          return await super.stageStatePublication(
            temporaryPath,
            publicationPath,
            expectedBytes,
            expectedIdentity,
          );
        }
        const displacedPath = `${temporaryPath}.displaced`;
        await rename(temporaryPath, displacedPath);
        await writeFile(temporaryPath, expectedBytes);
        try {
          await super.stageStatePublication(
            temporaryPath,
            publicationPath,
            expectedBytes,
            expectedIdentity,
          );
        } finally {
          await rm(displacedPath, { force: true });
        }
      }
    }

    const stateDirectory = await temporaryDirectory();
    const store = new SubstitutingStore("publication-substitution", { stateDirectory });
    await store.create(initialState("publication-substitution"));
    store.substitute = true;

    await expect(store.transition({ expectedRevision: 0, to: "running-task" }))
      .rejects.toMatchObject({ detail: { toolError: "unsafe-workflow-state" } });
    expect(await store.read()).toMatchObject({ revision: 0, phase: "preflighting" });
  });

  it("preserves the previous state when the staged publication is substituted", async () => {
    class PostStageSubstitutingStore extends WorkflowStore {
      substitute = false;

      protected override async stageStatePublication(
        temporaryPath: string,
        publicationPath: string,
        expectedBytes: Buffer,
        expectedIdentity: { dev: bigint; ino: bigint },
      ): Promise<void> {
        await super.stageStatePublication(
          temporaryPath,
          publicationPath,
          expectedBytes,
          expectedIdentity,
        );
        if (this.substitute) {
          await rm(publicationPath);
          await writeFile(publicationPath, "substituted", "utf8");
        }
      }
    }

    const stateDirectory = await temporaryDirectory();
    const store = new PostStageSubstitutingStore("post-stage-substitution", { stateDirectory });
    await store.create(initialState("post-stage-substitution"));
    store.substitute = true;

    await expect(store.transition({ expectedRevision: 0, to: "running-task" }))
      .rejects.toMatchObject({ detail: { toolError: "unsafe-workflow-state" } });
    expect(await store.read()).toMatchObject({ revision: 0, phase: "preflighting" });
  });

  it("removes verified abandoned state publication files before writing", async () => {
    const store = await createStore("abandoned-publication-files");
    const token = "00000000-0000-4000-8000-000000000001";
    const temporaryPath = path.join(store.workflowDirectory, `.state.${token}.tmp`);
    const publicationPath = path.join(store.workflowDirectory, `.state.${token}.publish`);
    await writeFile(temporaryPath, "partial state", "utf8");
    await link(temporaryPath, publicationPath);

    await store.update({
      expectedRevision: 0,
      update: draft => { draft.tasks[0]!.status = "running"; },
    });

    expect((await readdir(store.workflowDirectory)).filter(name =>
      name === path.basename(temporaryPath) || name === path.basename(publicationPath)))
      .toEqual([]);
  });

  it("appends hash-chained intent and completion records and checkpoints state", async () => {
    const store = await createStore("journal-happy-path");

    const pending = await store.beginIntent({
      expectedRevision: 0,
      operation: "create-workflow-branch",
      idempotencyKey: "branch:journal-happy-path",
      expectedIdentities: { expectedHead: "3".repeat(40) },
    });
    expect(pending).toMatchObject({
      intent: {
        event: "intent",
        workflowId: "journal-happy-path",
        revision: 0,
        operation: "create-workflow-branch",
        idempotencyKey: "branch:journal-happy-path",
        expectedIdentities: {
          repositoryIdentity: "/canonical/repository/.git",
          expectedHead: "3".repeat(40),
        },
        previousEntryHash: null,
      },
      completion: null,
    });
    expect(await store.read()).toMatchObject({
      revision: 0,
      intentJournal: {
        ref: "journal.ndjson",
        entryCount: 1,
        lastEntryHash: pending.intent.entryHash,
      },
    });

    const completed = await store.completeIntent({
      expectedRevision: 0,
      idempotencyKey: "branch:journal-happy-path",
      completion: { branch: "autopilot/journal-happy-path" },
    });
    expect(completed.completion).toMatchObject({
      event: "completion",
      completion: { branch: "autopilot/journal-happy-path" },
      failure: null,
      previousEntryHash: pending.intent.entryHash,
    });

    const lines = (await readFile(store.journalPath, "utf8")).trimEnd().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[1]!)).toMatchObject({
      entryHash: completed.completion!.entryHash,
      previousEntryHash: pending.intent.entryHash,
    });
    expect(await store.read()).toMatchObject({
      revision: 0,
      intentJournal: {
        entryCount: 2,
        lastEntryHash: completed.completion!.entryHash,
      },
    });
  });

  it("makes intent and completion retries idempotent and rejects key reuse", async () => {
    const store = await createStore("journal-idempotency");
    const intent = {
      expectedRevision: 0,
      operation: "push-branch",
      idempotencyKey: "push:one",
      expectedIdentities: { expectedRemoteHead: null },
    } as const;

    const first = await store.beginIntent(intent);
    await expect(store.beginIntent(intent)).resolves.toEqual(first);
    await expect(store.beginIntent({ ...intent, operation: "create-pr" }))
      .rejects.toMatchObject({ detail: { toolError: "workflow-intent-conflict" } });

    const completion = {
      expectedRevision: 0,
      idempotencyKey: intent.idempotencyKey,
      failure: {
        classification: "remote-rejected",
        message: "push was rejected",
        evidenceRefs: ["push-diagnostic.json"],
      },
    } as const;
    const finished = await store.completeIntent(completion);
    await expect(store.completeIntent(completion)).resolves.toEqual(finished);
    await expect(store.completeIntent({
      expectedRevision: 0,
      idempotencyKey: intent.idempotencyKey,
      completion: { pushed: true },
    })).rejects.toMatchObject({ detail: { toolError: "workflow-intent-conflict" } });
    await store.transition({ expectedRevision: 0, to: "running-task" });
    await expect(store.beginIntent(intent)).resolves.toEqual(finished);
    await expect(store.completeIntent(completion)).resolves.toEqual(finished);

    expect((await readFile(store.journalPath, "utf8")).trimEnd().split("\n"))
      .toHaveLength(2);
  });

  it("hash-binds special expected identity property names", async () => {
    const store = await createStore("journal-special-property");
    const expectedIdentities = JSON.parse('{"__proto__":"must-bind"}') as Record<
      string,
      string | null
    >;

    const status = await store.beginIntent({
      expectedRevision: 0,
      operation: "push-branch",
      idempotencyKey: "push:special-property",
      expectedIdentities,
    });
    const persisted = JSON.parse((await readFile(store.journalPath, "utf8")).trim()) as {
      expectedIdentities: Record<string, string | null>;
    };

    expect(Object.hasOwn(status.intent.expectedIdentities, "__proto__")).toBe(true);
    expect(status.intent.expectedIdentities.__proto__).toBe("must-bind");
    expect(Object.hasOwn(persisted.expectedIdentities, "__proto__")).toBe(true);
    expect(persisted.expectedIdentities.__proto__).toBe("must-bind");
  });

  it("detects an intent left incomplete by a process crash", async () => {
    const store = await createStore("journal-crash");
    await store.beginIntent({
      expectedRevision: 0,
      operation: "promote-candidate",
      idempotencyKey: "promote:task-1",
    });

    const restarted = new WorkflowStore("journal-crash", {
      stateDirectory: path.dirname(path.dirname(store.workflowDirectory)),
    });
    const journal = await restarted.readIntentJournal();
    expect(journal).toMatchObject({
      tornTail: false,
      intents: [{
        intent: {
          operation: "promote-candidate",
          idempotencyKey: "promote:task-1",
        },
        completion: null,
      }],
    });
  });

  it("ignores a torn final record and repairs only that tail before the next append", async () => {
    const store = await createStore("journal-torn-tail");
    const first = await store.beginIntent({
      expectedRevision: 0,
      operation: "run-task",
      idempotencyKey: "run:task-1",
    });
    const durablePrefix = await readFile(store.journalPath);
    await appendFile(store.journalPath, '{"event":"intent"');

    await expect(store.readIntentJournal()).resolves.toMatchObject({
      tornTail: true,
      entries: [{ entryHash: first.intent.entryHash }],
    });
    await store.beginIntent({
      expectedRevision: 0,
      operation: "run-task",
      idempotencyKey: "run:task-2",
    });

    const repaired = await readFile(store.journalPath);
    expect(repaired.subarray(0, durablePrefix.byteLength)).toEqual(durablePrefix);
    expect(repaired.toString("utf8")).not.toContain('{"event":"intent"{');
    await expect(store.readIntentJournal()).resolves.toMatchObject({
      tornTail: false,
      entries: [{ sequence: 1 }, { sequence: 2 }],
    });
  });
});
