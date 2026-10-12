import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  appendCleanupRecord,
  readPendingCleanupIntents,
  type CleanupRecord,
} from "../../src/runtime/cleanup-journal.js";
import { registerSecretValue, type SecretRegistration } from "../../src/runtime/redaction.js";
import { replayInterruptedPrunes } from "../../src/runtime/recovery-prune-journal.js";
import { platformServicesDouble } from "../helpers/platform-services-double.js";

// Passthrough recorder: every real file operation still runs; the test only
// observes which handle was written and which was fsynced, in order.
const fileEvents = vi.hoisted(() => [] as Array<{ op: "write" | "sync"; path: string }>);
// A directory lstat() can be armed to report no birth time, as on a Linux
// filesystem without statx btime support.
const birthtimeFault = vi.hoisted(() => ({ directory: null as string | null }));

vi.mock("node:fs/promises", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      const filename = path.resolve(String(args[0]));
      const writeFile = handle.writeFile.bind(handle);
      const sync = handle.sync.bind(handle);
      handle.writeFile = async (...writeArgs: Parameters<typeof handle.writeFile>) => {
        await writeFile(...writeArgs);
        fileEvents.push({ op: "write", path: filename });
      };
      handle.sync = async () => {
        await sync();
        fileEvents.push({ op: "sync", path: filename });
      };
      return handle;
    },
    lstat: async (...args: Parameters<typeof actual.lstat>) => {
      const metadata = await actual.lstat(...args);
      if (birthtimeFault.directory !== null && args[0] === birthtimeFault.directory
        && "birthtimeNs" in metadata && typeof metadata.birthtimeNs === "bigint") {
        metadata.birthtimeNs = 0n;
      }
      return metadata;
    },
  };
});

const temporaryPaths: string[] = [];
const registrations: SecretRegistration[] = [];
let previousPluginData: string | undefined;

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), prefix));
  temporaryPaths.push(directory);
  return directory;
}

function intentRecord(runId: string, repoRoot: string): CleanupRecord {
  return {
    event: "prune-cleanup-intent",
    runId,
    reason: "max-bytes",
    anchorCleanup: "pending",
    archiveBytes: 3,
    quarantineName: `.prune-${runId}-00000000-0000-4000-8000-000000000031`,
    repoRoot,
    anchorRef: `refs/claude-architect/candidates/${runId}`,
    backupRef: `refs/claude-architect/prune-backups/${runId}`,
    candidateCommitOid: "a".repeat(40),
    recordedAt: "2026-07-14T12:00:00.000Z",
  };
}

const platform = platformServicesDouble({
  os: "darwin",
  async getProcessStartToken() { return null; },
  async terminateProcessTreeByPid() {},
});

beforeEach(async () => {
  previousPluginData = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = await temporaryDirectory("ca-cleanup-journal-");
  fileEvents.length = 0;
});

afterEach(async () => {
  for (const registration of registrations.splice(0)) registration.dispose();
  if (previousPluginData === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
  else process.env.CLAUDE_PLUGIN_DATA = previousPluginData;
  await Promise.all(temporaryPaths.splice(0).map(entry =>
    rm(entry, { recursive: true, force: true })));
});

describe("cleanup journal recovery appends", () => {
  it("serializes a recovery append through the redacting serializer and syncs the runs directory after it", async () => {
    const runId = "run-recovery-append-redacted";
    const secret = "cleanup-journal-registered-secret-0123456789";
    const runsRoot = path.join(process.env.CLAUDE_PLUGIN_DATA!, "runs");
    const journal = path.join(runsRoot, "cleanup.ndjson");
    // The repository is gone, so replay takes the repo-absent rollback path and
    // its only effect is the recovery append of a rollback record.
    const repoRoot = path.join(process.env.CLAUDE_PLUGIN_DATA!, `gone-${secret}`);
    await mkdir(path.join(runsRoot, runId), { recursive: true });
    const intentLine = `${JSON.stringify(intentRecord(runId, repoRoot))}\n`;
    await writeFile(journal, intentLine);

    // A registered secret in a field must never reach the journal: the
    // redacting serializer refuses the append and the journal is untouched.
    const registration = registerSecretValue(secret);
    registrations.push(registration);
    await expect(replayInterruptedPrunes(runsRoot, platform))
      .rejects.toThrow(/safely persisted after redaction/i);
    await expect(readFile(journal, "utf8")).resolves.toBe(intentLine);
    registration.dispose();

    fileEvents.length = 0;
    await replayInterruptedPrunes(runsRoot, platform);

    const lines = (await readFile(journal, "utf8")).split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe(intentLine.trimEnd());
    // The redacting serializer escapes every property key; plain JSON does not.
    expect(lines[1]).toMatch(/^\{"\\u0065\\u0076\\u0065\\u006e\\u0074":/);
    expect(JSON.parse(lines[1]!)).toMatchObject({
      event: "prune-cleanup-rollback",
      runId,
      anchorCleanup: "already-absent",
    });
    expect(lines[2]).toBe("");

    const lastJournalWrite = fileEvents.findLastIndex(event =>
      event.op === "write" && event.path === path.resolve(journal));
    expect(lastJournalWrite).toBeGreaterThanOrEqual(0);
    const directorySynced = fileEvents.slice(lastJournalWrite + 1).some(event =>
      event.op === "sync" && event.path === path.resolve(runsRoot));
    // Windows cannot fsync a directory handle; the flush is a documented no-op there.
    if (process.platform !== "win32") expect(directorySynced).toBe(true);
  });
});

describe("cleanup journal", () => {
  it("repairs a torn final line and computes pending intents from complete lines only", async () => {
    const runsRoot = path.join(process.env.CLAUDE_PLUGIN_DATA!, "runs");
    const journal = path.join(runsRoot, "cleanup.ndjson");
    await mkdir(runsRoot, { recursive: true });
    const repoRoot = path.join(process.env.CLAUDE_PLUGIN_DATA!, "repo");
    const finished = intentRecord("run-finished", repoRoot);
    const pending = intentRecord("run-pending", repoRoot);
    const complete = `${[
      JSON.stringify(finished),
      JSON.stringify(pending),
      JSON.stringify({ ...finished, event: "prune-cleanup-complete", anchorCleanup: "deleted" }),
    ].join("\n")}\n`;
    // The torn fragment is an intent for a third run; it must not count as pending.
    const torn = JSON.stringify(intentRecord("run-torn", repoRoot)).slice(0, 60);
    await writeFile(journal, complete + torn);

    const intents = await readPendingCleanupIntents(runsRoot);

    expect([...intents.keys()]).toEqual(["run-pending"]);
    expect(intents.get("run-pending")).toEqual(pending);
    await expect(readFile(journal, "utf8")).resolves.toBe(complete);

    // A record appended after the repair starts on its own line.
    await appendCleanupRecord(runsRoot, {
      ...pending,
      event: "prune-cleanup-rollback",
      anchorCleanup: "deleted",
    });
    await expect(readPendingCleanupIntents(runsRoot)).resolves.toEqual(new Map());
  });

  it("an append after a torn final line repairs the tail so the journal stays parseable", async () => {
    const runsRoot = path.join(process.env.CLAUDE_PLUGIN_DATA!, "runs");
    const journal = path.join(runsRoot, "cleanup.ndjson");
    await mkdir(runsRoot, { recursive: true });
    const repoRoot = path.join(process.env.CLAUDE_PLUGIN_DATA!, "repo");
    const first = intentRecord("run-first", repoRoot);
    const complete = `${JSON.stringify(first)}\n`;
    // Another process crashed mid-append: no read has repaired the tail yet.
    await writeFile(journal, complete + JSON.stringify(intentRecord("run-torn", repoRoot)).slice(0, 60));

    const second = intentRecord("run-second", repoRoot);
    await appendCleanupRecord(runsRoot, second);

    const intents = await readPendingCleanupIntents(runsRoot);
    expect([...intents.keys()]).toEqual(["run-first", "run-second"]);
    expect(intents.get("run-second")).toEqual(second);
    const text = await readFile(journal, "utf8");
    expect(text.startsWith(complete)).toBe(true);
    expect(text.endsWith("\n")).toBe(true);
  });

  it("refuses to repair or append in a runs root without birth-time identity", async () => {
    const runsRoot = path.join(process.env.CLAUDE_PLUGIN_DATA!, "runs");
    const journal = path.join(runsRoot, "cleanup.ndjson");
    await mkdir(runsRoot, { recursive: true });
    const repoRoot = path.join(process.env.CLAUDE_PLUGIN_DATA!, "repo");
    const before = `${JSON.stringify(intentRecord("run-first", repoRoot))}\n`
      + JSON.stringify(intentRecord("run-torn", repoRoot)).slice(0, 60);
    await writeFile(journal, before);

    birthtimeFault.directory = runsRoot;
    try {
      await expect(appendCleanupRecord(runsRoot, intentRecord("run-second", repoRoot)))
        .rejects.toThrow("cleanup journal root lacks stable birth-time identity");
    } finally {
      birthtimeFault.directory = null;
    }
    await expect(readFile(journal, "utf8")).resolves.toBe(before);
  });

  it("lands every concurrent append from one process as a complete, parseable line", async () => {
    const runsRoot = path.join(process.env.CLAUDE_PLUGIN_DATA!, "runs");
    await mkdir(runsRoot, { recursive: true });
    const repoRoot = path.join(process.env.CLAUDE_PLUGIN_DATA!, "repo");
    const runIds = Array.from({ length: 24 }, (_, index) => `run-concurrent-${index}`);

    await Promise.all(runIds.map(runId => appendCleanupRecord(runsRoot, intentRecord(runId, repoRoot))));

    const text = await readFile(path.join(runsRoot, "cleanup.ndjson"), "utf8");
    expect(text.endsWith("\n")).toBe(true);
    const lines = text.slice(0, -1).split("\n");
    expect(lines).toHaveLength(runIds.length);
    const records = lines.map(line => JSON.parse(line) as CleanupRecord);
    expect(records.map(record => record.runId).sort()).toEqual([...runIds].sort());
    for (const record of records) expect(record).toEqual(intentRecord(record.runId, repoRoot));
    const intents = await readPendingCleanupIntents(runsRoot);
    expect([...intents.keys()].sort()).toEqual([...runIds].sort());
  });
});
