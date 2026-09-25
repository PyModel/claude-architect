import { createHash, randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import {
  lstat,
  link,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  rm,
} from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import { getPlatformServices } from "../platform/select-platform.js";
import { loadSchemas } from "../protocol/schema-loader.js";
import { resolveStateDir } from "../runtime/state-dir.js";
import { RuntimeError, errorCode, isMissing } from "../util/errors.js";
import type { AutopilotPhase, AutopilotWorkflowState } from "./types.js";
import { flushDirectory } from "../platform/durable-directory.js";

const NO_FOLLOW = constants.O_NOFOLLOW ?? 0;
const MAX_WRITER_LOCK_BYTES = 512;
const MAX_WORKFLOW_OWNER_BYTES = 1_024;
export const MAX_WORKFLOW_STATE_BYTES = 1_000_000;
export const MAX_WORKFLOW_JOURNAL_BYTES = 16_000_000;

export type WorkflowJournalJson =
  | null
  | boolean
  | number
  | string
  | WorkflowJournalJson[]
  | { [key: string]: WorkflowJournalJson };

export interface WorkflowIntentFailure {
  classification: string;
  message: string;
  evidenceRefs?: readonly string[];
}

export interface BeginWorkflowIntent {
  expectedRevision: number;
  operation: string;
  idempotencyKey: string;
  expectedIdentities?: Record<string, string | null>;
}

export interface CompleteWorkflowIntent {
  expectedRevision?: number;
  idempotencyKey: string;
  completion?: WorkflowJournalJson;
  failure?: WorkflowIntentFailure;
}

interface WorkflowJournalEntryBase {
  journalVersion: "1";
  sequence: number;
  event: "intent" | "completion";
  workflowId: string;
  revision: number;
  operation: string;
  idempotencyKey: string;
  expectedIdentities: Record<string, string | null>;
  recordedAt: string;
  previousEntryHash: string | null;
  completion: WorkflowJournalJson | null;
  failure: WorkflowIntentFailure | null;
}

export interface WorkflowJournalEntry extends WorkflowJournalEntryBase {
  entryHash: string;
}

export interface WorkflowIntentStatus {
  intent: WorkflowJournalEntry;
  completion: WorkflowJournalEntry | null;
}

export interface WorkflowIntentJournal {
  entries: WorkflowJournalEntry[];
  intents: WorkflowIntentStatus[];
  tornTail: boolean;
}

export const TERMINAL_PHASES = new Set<AutopilotPhase>([
  "ready-for-human-review",
  "human-decision-required",
  "failed",
  "cancelled",
]);

export const LEGAL_WORKFLOW_PHASE_EDGES: Readonly<
  Record<AutopilotPhase, readonly AutopilotPhase[]>
> = Object.freeze({
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

interface DirectoryIdentity {
  dev: number;
  ino: number;
  canonicalPath: string;
}

interface PreciseFileIdentity {
  dev: bigint;
  ino: bigint;
}

interface WriterLockRecord {
  lockVersion: "1";
  pid: number;
  processToken: string | null;
  token: string;
}

interface WriterLockIdentity {
  dev: number;
  ino: number;
  ownerPath: string;
  record: WriterLockRecord;
}

export interface WorkflowOwnerRecord {
  workflowId: string;
  pid: number;
  processToken: string | null;
  acquiredAt: string;
}

interface WorkflowOwnerIdentity {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  bytes: Buffer;
  record: WorkflowOwnerRecord;
}

type WorkflowOwnerStatus = "dead" | "live" | "unverifiable";

type MutableStateFields = Omit<
  AutopilotWorkflowState,
  | "stateVersion"
  | "workflowId"
  | "repositoryIdentity"
  | "baseCommitOid"
  | "workflowRef"
  | "worktreePath"
  | "autopilotSpecHash"
  | "revision"
  | "phase"
  | "createdAt"
  | "updatedAt"
>;

export interface WorkflowTransition {
  expectedRevision: number;
  to: AutopilotPhase;
  patch?: Partial<MutableStateFields>;
  update?: (draft: AutopilotWorkflowState) => void;
}

export interface WorkflowUpdate {
  expectedRevision: number;
  patch?: Partial<MutableStateFields>;
  update?: (draft: AutopilotWorkflowState) => void;
}

export interface WorkflowStoreOptions {
  stateDirectory?: string;
  now?: () => string;
  maxStateBytes?: number;
  maxJournalBytes?: number;
  isProcessAlive?: (pid: number) => boolean;
  getProcessStartToken?: (pid: number) => Promise<string | null>;
}

interface JournalRead extends WorkflowIntentJournal {
  completeByteLength: number;
  fileSize: number;
  identity: { dev: number; ino: number } | null;
  mtimeMs: number | null;
  ctimeMs: number | null;
}

function workflowError(message: string, toolError: string): RuntimeError {
  return new RuntimeError(message, { toolError });
}

function isPlainDirectory(metadata: Stats): boolean {
  return metadata.isDirectory() && !metadata.isSymbolicLink();
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) !== "ESRCH";
  }
}

async function isWriterAlive(record: WriterLockRecord): Promise<boolean> {
  if (!isProcessAlive(record.pid)) return false;
  if (record.processToken === null) return true;
  const currentToken = await getPlatformServices()
    .getProcessStartToken(record.pid)
    .catch(() => null);
  return currentToken === null || currentToken === record.processToken;
}

function parseWriterLock(bytes: Buffer): WriterLockRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8")) as unknown;
  } catch {
    throw workflowError("workflow state lock is malformed", "unsafe-workflow-state");
  }
  if (!isRecord(parsed)
    || !exactKeys(parsed, ["lockVersion", "pid", "processToken", "token"])
    || parsed.lockVersion !== "1"
    || !Number.isSafeInteger(parsed.pid)
    || (parsed.pid as number) < 1
    || (parsed.processToken !== null
      && (typeof parsed.processToken !== "string"
        || parsed.processToken.length < 1
        || parsed.processToken.length > 256))
    || typeof parsed.token !== "string"
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
      .test(parsed.token)) {
    throw workflowError("workflow state lock is malformed", "unsafe-workflow-state");
  }
  return parsed as unknown as WriterLockRecord;
}

function parseWorkflowOwner(bytes: Buffer, workflowId: string): WorkflowOwnerRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8")) as unknown;
  } catch {
    throw workflowError("workflow owner record is malformed", "unsafe-workflow-owner");
  }
  if (!isRecord(parsed)
    || !exactKeys(parsed, ["workflowId", "pid", "processToken", "acquiredAt"])
    || parsed.workflowId !== workflowId
    || !Number.isSafeInteger(parsed.pid)
    || (parsed.pid as number) < 1
    || (parsed.processToken !== null
      && (typeof parsed.processToken !== "string"
        || parsed.processToken.length < 1
        || parsed.processToken.length > 256))
    || typeof parsed.acquiredAt !== "string"
    || Number.isNaN(Date.parse(parsed.acquiredAt))) {
    throw workflowError("workflow owner record is malformed", "unsafe-workflow-owner");
  }
  return parsed as unknown as WorkflowOwnerRecord;
}

async function workflowOwnerStatus(
  record: WorkflowOwnerRecord,
  processAlive: (pid: number) => boolean,
  getProcessStartToken: (pid: number) => Promise<string | null>,
): Promise<WorkflowOwnerStatus> {
  if (!processAlive(record.pid)) return "dead";
  if (record.processToken === null) return "unverifiable";
  const currentToken = await getProcessStartToken(record.pid).catch(() => null);
  if (currentToken === null) return "unverifiable";
  return currentToken === record.processToken ? "live" : "dead";
}

function sameIdentity(metadata: Stats, identity: DirectoryIdentity): boolean {
  return metadata.dev === identity.dev && metadata.ino === identity.ino;
}

async function inspectPlainDirectory(directory: string): Promise<DirectoryIdentity> {
  const metadata = await lstat(directory);
  if (!isPlainDirectory(metadata)) {
    throw workflowError(
      "workflow state directory must be a plain directory",
      "unsafe-workflow-state",
    );
  }
  return {
    dev: metadata.dev,
    ino: metadata.ino,
    canonicalPath: await realpath(directory),
  };
}

async function assertDirectoryIdentity(
  directory: string,
  expected: DirectoryIdentity,
): Promise<void> {
  const [metadata, canonicalPath] = await Promise.all([
    lstat(directory),
    realpath(directory),
  ]);
  if (!isPlainDirectory(metadata)
    || !sameIdentity(metadata, expected)
    || canonicalPath !== expected.canonicalPath) {
    throw workflowError("workflow state directory identity changed", "unsafe-workflow-state");
  }
}

async function readHandleBytes(handle: FileHandle, size: number): Promise<Buffer> {
  const bytes = Buffer.alloc(size);
  let offset = 0;
  while (offset < size) {
    const result = await handle.read(bytes, offset, size - offset, offset);
    if (result.bytesRead === 0) break;
    offset += result.bytesRead;
  }
  if (offset !== size) {
    throw workflowError("workflow state changed during read", "unsafe-workflow-state");
  }
  return bytes;
}

/** The single definition of a workflow id that is safe as a path component. */
export const SAFE_WORKFLOW_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

/**
 * Read an open single-link regular file twice and prove that neither the open
 * file nor the name changed underneath the read. Every workflow record except
 * the writer lock (which legitimately gains a second link) is read this way.
 */
async function readSingleLinkFile(
  handle: FileHandle,
  filename: string,
  limits: { minBytes: number; maxBytes: number },
  errors: { unsafe: () => RuntimeError; oversized: () => RuntimeError; changed: () => RuntimeError },
): Promise<{ bytes: Buffer; metadata: Stats }> {
  const metadata = await handle.stat();
  const named = await lstat(filename);
  if (metadata.isFile() && metadata.size > limits.maxBytes) throw errors.oversized();
  if (!metadata.isFile()
    || metadata.nlink !== 1
    || metadata.size < limits.minBytes
    || !named.isFile()
    || named.isSymbolicLink()
    || named.nlink !== 1
    || named.dev !== metadata.dev
    || named.ino !== metadata.ino
    || named.size !== metadata.size) throw errors.unsafe();
  const first = await readHandleBytes(handle, metadata.size);
  const second = await readHandleBytes(handle, metadata.size);
  const settled = await handle.stat();
  const settledNamed = await lstat(filename);
  if (!first.equals(second)
    || !settled.isFile()
    || settled.nlink !== 1
    || settled.size !== metadata.size
    || settled.mtimeMs !== metadata.mtimeMs
    || settled.ctimeMs !== metadata.ctimeMs
    || !settledNamed.isFile()
    || settledNamed.isSymbolicLink()
    || settledNamed.dev !== metadata.dev
    || settledNamed.ino !== metadata.ino
    || settledNamed.size !== metadata.size) throw errors.changed();
  return { bytes: first, metadata };
}

function assertWorkflowId(workflowId: string): void {
  if (!SAFE_WORKFLOW_ID.test(workflowId)) {
    throw workflowError("workflow id is not a safe path component", "invalid-workflow-state");
  }
}

function assertSemanticState(state: AutopilotWorkflowState, workflowId: string): void {
  if (state.workflowId !== workflowId
    || !Number.isSafeInteger(state.revision)
    || !Number.isSafeInteger(state.currentTaskIndex)
    || state.currentTaskIndex > state.tasks.length
    || !Number.isSafeInteger(state.intentJournal.entryCount)) {
    throw workflowError("workflow state invariants are invalid", "invalid-workflow-state");
  }
  const taskIds = new Set(state.tasks.map(task => task.id));
  if (taskIds.size !== state.tasks.length) {
    throw workflowError("workflow task ids must be unique", "invalid-workflow-state");
  }
  const terminal = TERMINAL_PHASES.has(state.phase);
  if (terminal !== (state.terminal !== null)
    || (state.terminal !== null && state.terminal.classification !== state.phase)) {
    throw workflowError(
      "workflow terminal record must match the terminal phase",
      "invalid-workflow-state",
    );
  }
  if (state.phase === "ready-for-human-review"
    && (state.cleanup?.status !== "succeeded"
      || !state.cleanup.worktreeRemoved
      || !state.cleanup.lockReleased)) {
    throw workflowError(
      "ready-for-human-review requires successful cleanup",
      "invalid-workflow-state",
    );
  }
}

const validateWorkflowState = loadSchemas().autopilotWorkflowState;

function validateState(value: unknown, workflowId: string): AutopilotWorkflowState {
  if (isRecord(value) && value.stateVersion === "1") {
    throw workflowError(
      "workflow was created by a runtime that shipped branches itself (state v1); "
        + "finish or cancel it with that runtime, or start a new workflow",
      "workflow-state-version-unsupported",
    );
  }
  if (!validateWorkflowState(value)) {
    throw workflowError("workflow state does not match its schema", "invalid-workflow-state");
  }
  const state = value as AutopilotWorkflowState;
  assertSemanticState(state, workflowId);
  return state;
}

function serializeState(
  state: AutopilotWorkflowState,
  workflowId: string,
  maxStateBytes: number,
): Buffer {
  validateState(state, workflowId);
  let serialized: string;
  try {
    serialized = `${JSON.stringify(state, null, 2)}\n`;
  } catch {
    throw workflowError("workflow state is not JSON serializable", "invalid-workflow-state");
  }
  const bytes = Buffer.from(serialized, "utf8");
  if (bytes.byteLength > maxStateBytes) {
    throw workflowError("workflow state exceeds its size limit", "workflow-state-too-large");
  }
  validateState(JSON.parse(serialized) as unknown, workflowId);
  return bytes;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype
      || Object.getPrototypeOf(value) === null);
}

function normalizeJournalJson(
  value: unknown,
  label: string,
  ancestors = new Set<object>(),
): WorkflowJournalJson {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) {
    if (ancestors.has(value)) {
      throw workflowError(`${label} must not contain cycles`, "invalid-workflow-intent");
    }
    const nested = new Set(ancestors).add(value);
    return value.map(item => normalizeJournalJson(item, label, nested));
  }
  if (isRecord(value)) {
    if (ancestors.has(value)) {
      throw workflowError(`${label} must not contain cycles`, "invalid-workflow-intent");
    }
    const nested = new Set(ancestors).add(value);
    const normalized = Object.create(null) as Record<string, WorkflowJournalJson>;
    for (const key of Object.keys(value).sort()) {
      normalized[key] = normalizeJournalJson(value[key], label, nested);
    }
    return normalized;
  }
  throw workflowError(`${label} must contain only JSON values`, "invalid-workflow-intent");
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(normalizeJournalJson(value, "workflow journal record"));
}

function journalEntryHash(entry: WorkflowJournalEntryBase): string {
  return createHash("sha256").update(canonicalJson(entry), "utf8").digest("hex");
}

function serializeJournalEntry(entry: WorkflowJournalEntryBase): {
  entry: WorkflowJournalEntry;
  bytes: Buffer;
} {
  const complete: WorkflowJournalEntry = {
    ...entry,
    entryHash: journalEntryHash(entry),
  };
  return {
    entry: complete,
    bytes: Buffer.from(`${canonicalJson(complete)}\n`, "utf8"),
  };
}

function assertBoundedString(
  value: unknown,
  label: string,
  maximum: number,
): asserts value is string {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum) {
    throw workflowError(`${label} is invalid`, "invalid-workflow-intent");
  }
}

function normalizedExpectedIdentities(
  state: AutopilotWorkflowState,
  additional: Record<string, string | null> | undefined,
): Record<string, string | null> {
  const expected: Record<string, string | null> = Object.create(null) as Record<
    string,
    string | null
  >;
  expected.autopilotSpecHash = state.autopilotSpecHash;
  expected.baseCommitOid = state.baseCommitOid;
  expected.repositoryIdentity = state.repositoryIdentity;
  expected.workflowRef = state.workflowRef;
  expected.worktreePath = state.worktreePath;
  if (additional !== undefined) {
    if (!isRecord(additional)) {
      throw workflowError("expected identities are invalid", "invalid-workflow-intent");
    }
    for (const key of Object.keys(additional).sort()) {
      assertBoundedString(key, "expected identity name", 128);
      const value = additional[key];
      if (value !== null && (typeof value !== "string" || value.length > 4096)) {
        throw workflowError("expected identity value is invalid", "invalid-workflow-intent");
      }
      if (Object.hasOwn(expected, key) && expected[key] !== value) {
        throw workflowError("core workflow identity cannot be overridden", "invalid-workflow-intent");
      }
      expected[key] = value;
    }
  }
  return Object.fromEntries(Object.entries(expected).sort(([left], [right]) =>
    left.localeCompare(right)));
}

function normalizeFailure(failure: WorkflowIntentFailure): WorkflowIntentFailure {
  if (!isRecord(failure)
    || (!exactKeys(failure, ["classification", "message"])
      && !exactKeys(failure, ["classification", "message", "evidenceRefs"]))) {
    throw workflowError("workflow intent failure is invalid", "invalid-workflow-intent");
  }
  assertBoundedString(failure.classification, "failure classification", 128);
  assertBoundedString(failure.message, "failure message", 4096);
  const evidenceRefs = failure.evidenceRefs ?? [];
  if (!Array.isArray(evidenceRefs) || evidenceRefs.length > 128) {
    throw workflowError("failure evidence references are invalid", "invalid-workflow-intent");
  }
  for (const reference of evidenceRefs) {
    assertBoundedString(reference, "failure evidence reference", 4096);
  }
  return {
    classification: failure.classification,
    message: failure.message,
    evidenceRefs: [...evidenceRefs],
  };
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index]);
}

const JOURNAL_ENTRY_KEYS = [
  "journalVersion",
  "sequence",
  "event",
  "workflowId",
  "revision",
  "operation",
  "idempotencyKey",
  "expectedIdentities",
  "recordedAt",
  "previousEntryHash",
  "completion",
  "failure",
  "entryHash",
] as const;

function parseJournalEntry(
  line: string,
  workflowId: string,
  previous: WorkflowJournalEntry | undefined,
): WorkflowJournalEntry {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line) as unknown;
  } catch {
    throw workflowError("workflow journal contains malformed JSON", "invalid-workflow-journal");
  }
  if (!isRecord(parsed) || !exactKeys(parsed, JOURNAL_ENTRY_KEYS)) {
    throw workflowError("workflow journal entry has an invalid shape", "invalid-workflow-journal");
  }
  const entry = parsed as unknown as WorkflowJournalEntry;
  if (entry.journalVersion !== "1"
    || entry.workflowId !== workflowId
    || !Number.isSafeInteger(entry.sequence)
    || entry.sequence !== (previous?.sequence ?? 0) + 1
    || !Number.isSafeInteger(entry.revision)
    || entry.revision < 0
    || (entry.event !== "intent" && entry.event !== "completion")
    || typeof entry.recordedAt !== "string"
    || Number.isNaN(Date.parse(entry.recordedAt))
    || entry.previousEntryHash !== (previous?.entryHash ?? null)
    || typeof entry.entryHash !== "string"
    || !/^[0-9a-f]{64}$/u.test(entry.entryHash)) {
    throw workflowError("workflow journal entry invariants are invalid", "invalid-workflow-journal");
  }
  assertBoundedString(entry.operation, "journal operation", 128);
  assertBoundedString(entry.idempotencyKey, "journal idempotency key", 255);
  if (!isRecord(entry.expectedIdentities)) {
    throw workflowError("journal expected identities are invalid", "invalid-workflow-journal");
  }
  for (const [key, value] of Object.entries(entry.expectedIdentities)) {
    if (key.length < 1 || key.length > 128
      || (value !== null && (typeof value !== "string" || value.length > 4096))) {
      throw workflowError("journal expected identities are invalid", "invalid-workflow-journal");
    }
  }
  if (entry.event === "intent" && (entry.completion !== null || entry.failure !== null)) {
    throw workflowError("workflow intent entry has an outcome", "invalid-workflow-journal");
  }
  if (entry.event === "completion") {
    if (entry.failure !== null && entry.completion !== null) {
      throw workflowError(
        "workflow completion has both a result and failure",
        "invalid-workflow-journal",
      );
    }
    if (entry.failure !== null) normalizeFailure(entry.failure);
    normalizeJournalJson(entry.completion, "journal completion");
  }
  const { entryHash, ...unsigned } = entry;
  if (journalEntryHash(unsigned) !== entryHash) {
    throw workflowError("workflow journal hash chain is invalid", "invalid-workflow-journal");
  }
  return structuredClone(entry);
}

function indexJournalEntries(entries: WorkflowJournalEntry[]): WorkflowIntentStatus[] {
  const indexed = new Map<string, WorkflowIntentStatus>();
  for (const entry of entries) {
    const existing = indexed.get(entry.idempotencyKey);
    if (entry.event === "intent") {
      if (existing !== undefined) {
        throw workflowError("workflow journal contains a duplicate intent", "invalid-workflow-journal");
      }
      indexed.set(entry.idempotencyKey, { intent: entry, completion: null });
      continue;
    }
    if (existing === undefined
      || existing.completion !== null
      || entry.operation !== existing.intent.operation
      || canonicalJson(entry.expectedIdentities)
        !== canonicalJson(existing.intent.expectedIdentities)) {
      throw workflowError("workflow journal completion does not match its intent", "invalid-workflow-journal");
    }
    existing.completion = entry;
  }
  return [...indexed.values()].map(status => structuredClone(status));
}

function journalTimestamp(now: () => string): string {
  const timestamp = now();
  if (typeof timestamp !== "string" || Number.isNaN(Date.parse(timestamp))) {
    throw workflowError("workflow journal timestamp is invalid", "invalid-workflow-intent");
  }
  return timestamp;
}

export class WorkflowStore {
  readonly workflowId: string;
  readonly workflowsDirectory: string;
  readonly workflowDirectory: string;
  readonly statePath: string;
  readonly journalPath: string;
  readonly lockPath: string;
  readonly ownerPath: string;

  private readonly stateRoot: string;
  private readonly now: () => string;
  private readonly maxStateBytes: number;
  private readonly maxJournalBytes: number;
  private readonly isOwnerProcessAlive: (pid: number) => boolean;
  private readonly getProcessStartToken: (pid: number) => Promise<string | null>;

  constructor(workflowId: string, options: WorkflowStoreOptions = {}) {
    assertWorkflowId(workflowId);
    this.workflowId = workflowId;
    this.stateRoot = path.resolve(options.stateDirectory ?? resolveStateDir());
    this.workflowsDirectory = path.join(this.stateRoot, "workflows");
    this.workflowDirectory = path.join(this.workflowsDirectory, workflowId);
    this.statePath = path.join(this.workflowDirectory, "state.json");
    this.journalPath = path.join(this.workflowDirectory, "journal.ndjson");
    this.lockPath = path.join(this.workflowDirectory, "state.lock");
    this.ownerPath = path.join(this.workflowDirectory, "owner.json");
    this.now = options.now ?? (() => new Date().toISOString());
    this.maxStateBytes = options.maxStateBytes ?? MAX_WORKFLOW_STATE_BYTES;
    this.maxJournalBytes = options.maxJournalBytes ?? MAX_WORKFLOW_JOURNAL_BYTES;
    this.isOwnerProcessAlive = options.isProcessAlive ?? isProcessAlive;
    this.getProcessStartToken = options.getProcessStartToken
      ?? (pid => getPlatformServices().getProcessStartToken(pid));
    if (!Number.isSafeInteger(this.maxStateBytes) || this.maxStateBytes < 1) {
      throw new TypeError("maxStateBytes must be a positive safe integer");
    }
    if (!Number.isSafeInteger(this.maxJournalBytes) || this.maxJournalBytes < 1) {
      throw new TypeError("maxJournalBytes must be a positive safe integer");
    }
  }

  async create(initialState: AutopilotWorkflowState): Promise<AutopilotWorkflowState> {
    if (initialState.revision !== 0
      || initialState.phase !== "preflighting"
      || initialState.terminal !== null
      || initialState.cleanup !== null
      || initialState.intentJournal.ref !== "journal.ndjson"
      || initialState.intentJournal.entryCount !== 0
      || initialState.intentJournal.lastEntryHash !== null) {
      throw workflowError(
        "a workflow must be created at revision 0 in preflighting",
        "invalid-workflow-state",
      );
    }
    const state = structuredClone(initialState);
    const bytes = serializeState(state, this.workflowId, this.maxStateBytes);
    const directory = await this.ensureWorkflowDirectory();
    return await this.withWriterLock(directory, async () => {
      const existing = await this.readFromDirectory(directory);
      if (existing !== null) {
        throw workflowError("workflow state already exists", "workflow-state-conflict");
      }
      await this.publish(bytes, directory, true);
      return structuredClone(state);
    });
  }

  async read(): Promise<AutopilotWorkflowState> {
    const directory = await this.existingWorkflowDirectory();
    const state = await this.readFromDirectory(directory);
    if (state === null) {
      throw workflowError("workflow state does not exist", "workflow-state-not-found");
    }
    const journal = await this.readJournalFromDirectory(directory);
    return structuredClone(this.withJournalCheckpoint(state, journal));
  }

  async acquireLease(): Promise<WorkflowOwnerRecord> {
    const directory = await this.ensureWorkflowDirectory();
    return await this.withWriterLock(directory, async () =>
      await this.createWorkflowOwner(directory));
  }

  async adoptLease(): Promise<WorkflowOwnerRecord> {
    const directory = await this.existingWorkflowDirectory();
    return await this.withWriterLock(directory, async () => {
      const existing = await this.readWorkflowOwner(directory);
      const status = await workflowOwnerStatus(
        existing.record,
        this.isOwnerProcessAlive,
        this.getProcessStartToken,
      );
      if (status !== "dead") {
        throw workflowError(
          status === "live"
            ? "workflow owner is still active"
            : "workflow owner liveness cannot be verified",
          "workflow-lease-conflict",
        );
      }
      if (!await this.removeWorkflowOwner(existing, directory)) {
        throw workflowError("workflow owner changed during adoption", "workflow-lease-conflict");
      }
      return await this.createWorkflowOwner(directory);
    });
  }

  async releaseLease(): Promise<void> {
    const directory = await this.existingWorkflowDirectory();
    await this.withWriterLock(directory, async () => {
      const existing = await this.readWorkflowOwner(directory);
      const processToken = await this.getProcessStartToken(process.pid).catch(() => null);
      if (existing.record.pid !== process.pid
        || existing.record.processToken !== processToken) {
        throw workflowError("workflow lease is owned by another process", "workflow-lease-conflict");
      }
      if (!await this.removeWorkflowOwner(existing, directory)) {
        throw workflowError("workflow owner changed during release", "workflow-lease-conflict");
      }
    });
  }

  /**
   * Hold the workflow writer lease while a caller performs an identity-sensitive
   * operation. The callback receives the current, checkpointed state only after
   * the expected revision has been revalidated under that lease.
   */
  async withLockedState<T>(
    expectedRevision: number,
    operation: (state: AutopilotWorkflowState) => Promise<T>,
  ): Promise<T> {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
      throw workflowError("expected revision is invalid", "workflow-revision-conflict");
    }
    const directory = await this.existingWorkflowDirectory();
    return await this.withWriterLock(directory, async () => {
      const persisted = await this.readFromDirectory(directory);
      if (persisted === null || persisted.revision !== expectedRevision) {
        throw workflowError("workflow revision does not match", "workflow-revision-conflict");
      }
      const current = this.withJournalCheckpoint(
        persisted,
        await this.readJournalFromDirectory(directory),
      );
      return await operation(structuredClone(current));
    });
  }

  async readIntentJournal(): Promise<WorkflowIntentJournal> {
    const directory = await this.existingWorkflowDirectory();
    const state = await this.readFromDirectory(directory);
    if (state === null) {
      throw workflowError("workflow state does not exist", "workflow-state-not-found");
    }
    const journal = await this.readJournalFromDirectory(directory);
    this.withJournalCheckpoint(state, journal);
    return {
      entries: structuredClone(journal.entries),
      intents: structuredClone(journal.intents),
      tornTail: journal.tornTail,
    };
  }

  async beginIntent(args: BeginWorkflowIntent): Promise<WorkflowIntentStatus> {
    if (!Number.isSafeInteger(args.expectedRevision) || args.expectedRevision < 0) {
      throw workflowError("expected revision is invalid", "workflow-revision-conflict");
    }
    assertBoundedString(args.operation, "workflow operation", 128);
    assertBoundedString(args.idempotencyKey, "workflow idempotency key", 255);
    const directory = await this.existingWorkflowDirectory();
    return await this.withWriterLock(directory, async () => {
      const persisted = await this.readFromDirectory(directory);
      if (persisted === null) {
        throw workflowError("workflow state does not exist", "workflow-state-not-found");
      }
      let journal = await this.readJournalForAppend(directory);
      const current = this.withJournalCheckpoint(persisted, journal);
      const expectedIdentities = normalizedExpectedIdentities(current, args.expectedIdentities);
      const existing = journal.intents.find(status =>
        status.intent.idempotencyKey === args.idempotencyKey);
      if (existing !== undefined) {
        if (existing.intent.revision !== args.expectedRevision
          || existing.intent.operation !== args.operation
          || canonicalJson(existing.intent.expectedIdentities)
            !== canonicalJson(expectedIdentities)) {
          throw workflowError("workflow idempotency key conflicts", "workflow-intent-conflict");
        }
        await this.publishJournalCheckpointIfNeeded(persisted, journal, directory);
        return structuredClone(existing);
      }
      if (persisted.revision !== args.expectedRevision) {
        throw workflowError("workflow revision does not match", "workflow-revision-conflict");
      }
      const serialized = serializeJournalEntry({
        journalVersion: "1",
        sequence: journal.entries.length + 1,
        event: "intent",
        workflowId: this.workflowId,
        revision: current.revision,
        operation: args.operation,
        idempotencyKey: args.idempotencyKey,
        expectedIdentities,
        recordedAt: journalTimestamp(this.now),
        previousEntryHash: journal.entries.at(-1)?.entryHash ?? null,
        completion: null,
        failure: null,
      });
      await this.appendJournalEntry(serialized.bytes, directory, journal.fileSize);
      journal = await this.readJournalFromDirectory(directory);
      const status = journal.intents.find(item =>
        item.intent.idempotencyKey === args.idempotencyKey);
      if (status === undefined || status.intent.entryHash !== serialized.entry.entryHash) {
        throw workflowError("workflow intent was not durably appended", "invalid-workflow-journal");
      }
      await this.publishJournalCheckpoint(current, journal, directory);
      return structuredClone(status);
    });
  }

  async completeIntent(args: CompleteWorkflowIntent): Promise<WorkflowIntentStatus> {
    assertBoundedString(args.idempotencyKey, "workflow idempotency key", 255);
    if (args.expectedRevision !== undefined
      && (!Number.isSafeInteger(args.expectedRevision) || args.expectedRevision < 0)) {
      throw workflowError("expected revision is invalid", "workflow-revision-conflict");
    }
    if (args.failure !== undefined && args.completion !== undefined) {
      throw workflowError(
        "workflow intent cannot have both a completion and failure",
        "invalid-workflow-intent",
      );
    }
    const completion = args.completion === undefined
      ? null
      : normalizeJournalJson(args.completion, "workflow intent completion");
    const failure = args.failure === undefined ? null : normalizeFailure(args.failure);
    const directory = await this.existingWorkflowDirectory();
    return await this.withWriterLock(directory, async () => {
      const persisted = await this.readFromDirectory(directory);
      if (persisted === null) {
        throw workflowError("workflow state does not exist", "workflow-state-not-found");
      }
      let journal = await this.readJournalForAppend(directory);
      const current = this.withJournalCheckpoint(persisted, journal);
      const status = journal.intents.find(item =>
        item.intent.idempotencyKey === args.idempotencyKey);
      if (status === undefined) {
        throw workflowError("workflow intent does not exist", "workflow-intent-not-found");
      }
      if (status.completion !== null) {
        if (canonicalJson(status.completion.completion) !== canonicalJson(completion)
          || canonicalJson(status.completion.failure) !== canonicalJson(failure)) {
          throw workflowError("workflow completion conflicts", "workflow-intent-conflict");
        }
        await this.publishJournalCheckpointIfNeeded(persisted, journal, directory);
        return structuredClone(status);
      }
      if (args.expectedRevision !== undefined && persisted.revision !== args.expectedRevision) {
        throw workflowError("workflow revision does not match", "workflow-revision-conflict");
      }
      const serialized = serializeJournalEntry({
        journalVersion: "1",
        sequence: journal.entries.length + 1,
        event: "completion",
        workflowId: this.workflowId,
        revision: current.revision,
        operation: status.intent.operation,
        idempotencyKey: status.intent.idempotencyKey,
        expectedIdentities: status.intent.expectedIdentities,
        recordedAt: journalTimestamp(this.now),
        previousEntryHash: journal.entries.at(-1)?.entryHash ?? null,
        completion,
        failure,
      });
      await this.appendJournalEntry(serialized.bytes, directory, journal.fileSize);
      journal = await this.readJournalFromDirectory(directory);
      const completed = journal.intents.find(item =>
        item.intent.idempotencyKey === args.idempotencyKey);
      if (completed?.completion?.entryHash !== serialized.entry.entryHash) {
        throw workflowError("workflow completion was not durably appended", "invalid-workflow-journal");
      }
      await this.publishJournalCheckpoint(current, journal, directory);
      return structuredClone(completed);
    });
  }

  async transition(args: WorkflowTransition): Promise<AutopilotWorkflowState> {
    return await this.writeState(args, args.to);
  }

  async update(args: WorkflowUpdate): Promise<AutopilotWorkflowState> {
    return await this.writeState(args);
  }

  private async writeState(
    args: WorkflowUpdate,
    transitionTo?: AutopilotPhase,
  ): Promise<AutopilotWorkflowState> {
    if (!Number.isSafeInteger(args.expectedRevision) || args.expectedRevision < 0) {
      throw workflowError("expected revision is invalid", "workflow-revision-conflict");
    }
    const directory = await this.existingWorkflowDirectory();
    return await this.withWriterLock(directory, async () => {
      const persisted = await this.readFromDirectory(directory);
      if (persisted === null || persisted.revision !== args.expectedRevision) {
        throw workflowError("workflow revision does not match", "workflow-revision-conflict");
      }
      const current = this.withJournalCheckpoint(
        persisted,
        await this.readJournalFromDirectory(directory),
      );
      if (transitionTo === undefined && TERMINAL_PHASES.has(current.phase)) {
        throw workflowError(
          `cannot update terminal workflow in ${current.phase}`,
          "invalid-workflow-transition",
        );
      }
      if (transitionTo !== undefined
        && !LEGAL_WORKFLOW_PHASE_EDGES[current.phase].includes(transitionTo)) {
        throw workflowError(
          `cannot transition workflow from ${current.phase} to ${transitionTo}`,
          "invalid-workflow-transition",
        );
      }

      const next = structuredClone(current);
      if (args.patch !== undefined) Object.assign(next, structuredClone(args.patch));
      args.update?.(next);
      next.stateVersion = current.stateVersion;
      next.workflowId = current.workflowId;
      next.repositoryIdentity = current.repositoryIdentity;
      next.baseCommitOid = current.baseCommitOid;
      next.workflowRef = current.workflowRef;
      next.worktreePath = current.worktreePath;
      next.autopilotSpecHash = current.autopilotSpecHash;
      next.intentJournal = structuredClone(current.intentJournal);
      next.createdAt = current.createdAt;
      next.branch = current.branch;
      next.revision = current.revision + 1;
      next.phase = transitionTo ?? current.phase;
      next.updatedAt = this.now();
      if (transitionTo !== undefined
        && TERMINAL_PHASES.has(transitionTo)
        && next.terminal === null) {
        next.terminal = {
          classification: transitionTo as NonNullable<
            AutopilotWorkflowState["terminal"]
          >["classification"],
          reason: null,
          evidenceRefs: [],
          completedAt: next.updatedAt,
        };
      }

      const bytes = serializeState(next, this.workflowId, this.maxStateBytes);
      await this.assertCurrentRevision(directory, current.revision);
      await this.publish(bytes, directory, false);
      return structuredClone(next);
    });
  }

  private async ensureWorkflowDirectory(): Promise<DirectoryIdentity> {
    const root = await inspectPlainDirectory(this.stateRoot);
    await mkdir(this.workflowsDirectory, { mode: 0o700 }).catch(error => {
      if (errorCode(error) !== "EEXIST") throw error;
    });
    await assertDirectoryIdentity(this.stateRoot, root);
    const workflows = await inspectPlainDirectory(this.workflowsDirectory);
    if (path.dirname(workflows.canonicalPath) !== root.canonicalPath) {
      throw workflowError("workflows directory escapes plugin data", "unsafe-workflow-state");
    }
    await mkdir(this.workflowDirectory, { mode: 0o700 }).catch(error => {
      if (errorCode(error) !== "EEXIST") throw error;
    });
    await assertDirectoryIdentity(this.workflowsDirectory, workflows);
    const workflow = await inspectPlainDirectory(this.workflowDirectory);
    if (path.dirname(workflow.canonicalPath) !== workflows.canonicalPath) {
      throw workflowError("workflow directory escapes plugin data", "unsafe-workflow-state");
    }
    return workflow;
  }

  private async existingWorkflowDirectory(): Promise<DirectoryIdentity> {
    const root = await inspectPlainDirectory(this.stateRoot);
    const workflows = await inspectPlainDirectory(this.workflowsDirectory);
    const workflow = await inspectPlainDirectory(this.workflowDirectory);
    if (path.dirname(workflows.canonicalPath) !== root.canonicalPath
      || path.dirname(workflow.canonicalPath) !== workflows.canonicalPath) {
      throw workflowError("workflow state path escapes plugin data", "unsafe-workflow-state");
    }
    return workflow;
  }

  private async createWorkflowOwner(
    directory: DirectoryIdentity,
  ): Promise<WorkflowOwnerRecord> {
    await assertDirectoryIdentity(this.workflowDirectory, directory);
    const record: WorkflowOwnerRecord = {
      workflowId: this.workflowId,
      pid: process.pid,
      processToken: await this.getProcessStartToken(process.pid).catch(() => null),
      acquiredAt: this.now(),
    };
    if (Number.isNaN(Date.parse(record.acquiredAt))) {
      throw workflowError("workflow owner timestamp is invalid", "invalid-workflow-owner");
    }
    const bytes = Buffer.from(`${JSON.stringify(record)}\n`, "utf8");
    if (bytes.byteLength > MAX_WORKFLOW_OWNER_BYTES) {
      throw workflowError("workflow owner record exceeds its size limit", "invalid-workflow-owner");
    }

    let handle: FileHandle;
    try {
      handle = await open(
        this.ownerPath,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NO_FOLLOW,
        0o600,
      );
    } catch (error) {
      if (errorCode(error) === "EEXIST") {
        throw workflowError("workflow already has an owner", "workflow-lease-conflict");
      }
      throw error;
    }

    let identity: WorkflowOwnerIdentity | undefined;
    try {
      await handle.writeFile(bytes);
      await handle.sync();
      const metadata = await handle.stat();
      const named = await lstat(this.ownerPath);
      if (!metadata.isFile()
        || metadata.nlink !== 1
        || metadata.size !== bytes.byteLength
        || !named.isFile()
        || named.isSymbolicLink()
        || named.nlink !== 1
        || named.dev !== metadata.dev
        || named.ino !== metadata.ino
        || named.size !== metadata.size) {
        throw workflowError("workflow owner was substituted", "unsafe-workflow-owner");
      }
      identity = {
        dev: metadata.dev,
        ino: metadata.ino,
        size: metadata.size,
        mtimeMs: metadata.mtimeMs,
        ctimeMs: metadata.ctimeMs,
        bytes,
        record,
      };
    } finally {
      await handle.close();
    }

    if (identity === undefined) {
      throw workflowError("workflow owner was not created", "unsafe-workflow-owner");
    }
    await flushDirectory(this.workflowDirectory);
    await assertDirectoryIdentity(this.workflowDirectory, directory);
    return structuredClone(record);
  }

  private async readWorkflowOwner(
    directory: DirectoryIdentity,
  ): Promise<WorkflowOwnerIdentity> {
    await assertDirectoryIdentity(this.workflowDirectory, directory);
    let handle: FileHandle;
    try {
      handle = await open(this.ownerPath, constants.O_RDONLY | NO_FOLLOW);
    } catch (error) {
      if (isMissing(error)) {
        throw workflowError("workflow owner does not exist", "workflow-lease-not-found");
      }
      throw error;
    }
    try {
      const unsafe = () => workflowError("workflow owner is unsafe", "unsafe-workflow-owner");
      const { bytes: first, metadata } = await readSingleLinkFile(
        handle,
        this.ownerPath,
        { minBytes: 1, maxBytes: MAX_WORKFLOW_OWNER_BYTES },
        {
          unsafe,
          oversized: unsafe,
          changed: () => workflowError("workflow owner changed during read", "unsafe-workflow-owner"),
        },
      );
      return {
        dev: metadata.dev,
        ino: metadata.ino,
        size: metadata.size,
        mtimeMs: metadata.mtimeMs,
        ctimeMs: metadata.ctimeMs,
        bytes: first,
        record: parseWorkflowOwner(first, this.workflowId),
      };
    } finally {
      await handle.close();
    }
  }

  private async removeWorkflowOwner(
    identity: WorkflowOwnerIdentity,
    directory: DirectoryIdentity,
  ): Promise<boolean> {
    let handle: FileHandle;
    try {
      handle = await open(this.ownerPath, constants.O_RDONLY | NO_FOLLOW);
    } catch (error) {
      if (isMissing(error)) return false;
      throw error;
    }
    try {
      const metadata = await handle.stat();
      let named = await lstat(this.ownerPath);
      if (!metadata.isFile()
        || metadata.nlink !== 1
        || metadata.dev !== identity.dev
        || metadata.ino !== identity.ino
        || metadata.size !== identity.size
        || metadata.mtimeMs !== identity.mtimeMs
        || metadata.ctimeMs !== identity.ctimeMs
        || !named.isFile()
        || named.isSymbolicLink()
        || named.nlink !== 1
        || named.dev !== identity.dev
        || named.ino !== identity.ino) return false;
      const bytes = await readHandleBytes(handle, metadata.size);
      const settled = await handle.stat();
      named = await lstat(this.ownerPath);
      if (!bytes.equals(identity.bytes)
        || settled.dev !== identity.dev
        || settled.ino !== identity.ino
        || settled.size !== identity.size
        || settled.mtimeMs !== identity.mtimeMs
        || settled.ctimeMs !== identity.ctimeMs
        || named.dev !== identity.dev
        || named.ino !== identity.ino) return false;
      await rm(this.ownerPath);
    } catch (error) {
      if (isMissing(error)) return false;
      throw error;
    } finally {
      await handle.close();
    }
    await flushDirectory(this.workflowDirectory);
    await assertDirectoryIdentity(this.workflowDirectory, directory);
    return true;
  }

  private async withWriterLock<T>(
    directory: DirectoryIdentity,
    operation: () => Promise<T>,
  ): Promise<T> {
    await assertDirectoryIdentity(this.workflowDirectory, directory);
    let ownerHandle: FileHandle | undefined;
    let lockIdentity: WriterLockIdentity | undefined;
    let operationError: unknown;
    try {
      for (let attempt = 0; attempt < 4; attempt += 1) {
        const token = randomUUID();
        const ownerPath = path.join(this.workflowDirectory, `.state.lock.${token}.owner`);
        ownerHandle = await open(
          ownerPath,
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NO_FOLLOW,
          0o600,
        );
        const record: WriterLockRecord = {
          lockVersion: "1",
          pid: process.pid,
          processToken: await getPlatformServices()
            .getProcessStartToken(process.pid)
            .catch(() => null),
          token,
        };
        await ownerHandle.writeFile(`${JSON.stringify(record)}\n`, "utf8");
        await ownerHandle.sync();
        const ownerMetadata = await ownerHandle.stat();
        const namedOwner = await lstat(ownerPath);
        if (!ownerMetadata.isFile()
          || ownerMetadata.nlink !== 1
          || ownerMetadata.size > MAX_WRITER_LOCK_BYTES
          || !namedOwner.isFile()
          || namedOwner.isSymbolicLink()
          || namedOwner.dev !== ownerMetadata.dev
          || namedOwner.ino !== ownerMetadata.ino) {
          throw workflowError("workflow state lock owner was substituted", "unsafe-workflow-state");
        }
        try {
          await link(ownerPath, this.lockPath);
        } catch (error) {
          await ownerHandle.close();
          ownerHandle = undefined;
          await rm(ownerPath, { force: true });
          if (errorCode(error) !== "EEXIST") throw error;
          const existing = await this.readWriterLock(directory);
          if (await isWriterAlive(existing.record)) {
            throw workflowError(
              "workflow state writer is already active",
              "workflow-revision-conflict",
            );
          }
          if (await this.retireWriterLock(existing, directory)) {
            await this.retireWriterOwner(existing, directory);
          }
          continue;
        }
        const namedLock = await lstat(this.lockPath);
        if (!namedLock.isFile()
          || namedLock.isSymbolicLink()
          || namedLock.dev !== ownerMetadata.dev
          || namedLock.ino !== ownerMetadata.ino) {
          throw workflowError("workflow state lock was substituted", "unsafe-workflow-state");
        }
        lockIdentity = {
          dev: ownerMetadata.dev,
          ino: ownerMetadata.ino,
          ownerPath,
          record,
        };
        await flushDirectory(this.workflowDirectory);
        break;
      }
      if (lockIdentity === undefined) {
        throw workflowError("workflow state lock recovery did not settle", "workflow-revision-conflict");
      }
      await assertDirectoryIdentity(this.workflowDirectory, directory);
      await this.recoverAbandonedStateFiles(directory);
      return await operation();
    } catch (error) {
      operationError = error;
      throw error;
    } finally {
      // A cleanup failure must stay visible without erasing the primary
      // outcome: callers classify on the surfaced error, so replacing a real
      // pipeline failure with an unrelated filesystem error misreports the run.
      try {
        await ownerHandle?.close();
        if (lockIdentity !== undefined) {
          await this.retireWriterLock(lockIdentity, directory);
          await rm(lockIdentity.ownerPath, { force: true });
          await flushDirectory(this.workflowDirectory);
        }
      } catch (cleanupError) {
        if (operationError === undefined) throw cleanupError;
        throw new AggregateError(
          [operationError, cleanupError],
          "workflow state operation failed and lock retirement failed",
        );
      }
    }
  }

  private async readWriterLock(directory: DirectoryIdentity): Promise<WriterLockIdentity> {
    await assertDirectoryIdentity(this.workflowDirectory, directory);
    const handle = await open(this.lockPath, constants.O_RDONLY | NO_FOLLOW);
    try {
      const metadata = await handle.stat();
      const named = await lstat(this.lockPath);
      if (!metadata.isFile()
        || metadata.nlink < 1
        || metadata.nlink > 2
        || metadata.size < 1
        || metadata.size > MAX_WRITER_LOCK_BYTES
        || !named.isFile()
        || named.isSymbolicLink()
        || named.dev !== metadata.dev
        || named.ino !== metadata.ino
        || named.size !== metadata.size) {
        throw workflowError("workflow state lock is unsafe", "unsafe-workflow-state");
      }
      const first = await readHandleBytes(handle, metadata.size);
      const second = await readHandleBytes(handle, metadata.size);
      const settled = await handle.stat();
      if (!first.equals(second)
        || settled.size !== metadata.size
        || settled.mtimeMs !== metadata.mtimeMs
        || settled.ctimeMs !== metadata.ctimeMs) {
        throw workflowError("workflow state lock changed during read", "unsafe-workflow-state");
      }
      const record = parseWriterLock(first);
      return {
        dev: metadata.dev,
        ino: metadata.ino,
        ownerPath: path.join(this.workflowDirectory, `.state.lock.${record.token}.owner`),
        record,
      };
    } finally {
      await handle.close();
    }
  }

  private async retireWriterLock(
    identity: WriterLockIdentity,
    directory: DirectoryIdentity,
  ): Promise<boolean> {
    let handle: FileHandle;
    try {
      handle = await open(this.lockPath, constants.O_RDONLY | NO_FOLLOW);
    } catch (error) {
      if (isMissing(error)) return false;
      throw error;
    }
    try {
      const metadata = await handle.stat();
      let named = await lstat(this.lockPath);
      if (!metadata.isFile()
        || metadata.dev !== identity.dev
        || metadata.ino !== identity.ino
        || !named.isFile()
        || named.isSymbolicLink()
        || named.dev !== identity.dev
        || named.ino !== identity.ino) return false;
      const contents = await readHandleBytes(handle, metadata.size);
      const record = parseWriterLock(contents);
      if (record.pid !== identity.record.pid
        || record.processToken !== identity.record.processToken
        || record.token !== identity.record.token) return false;
      const settled = await handle.stat();
      named = await lstat(this.lockPath);
      if (settled.dev !== identity.dev
        || settled.ino !== identity.ino
        || settled.size !== metadata.size
        || settled.mtimeMs !== metadata.mtimeMs
        || settled.ctimeMs !== metadata.ctimeMs
        || named.dev !== identity.dev
        || named.ino !== identity.ino) return false;
      await rm(this.lockPath);
    } catch (error) {
      if (isMissing(error)) return false;
      throw error;
    } finally {
      await handle.close();
    }
    await flushDirectory(this.workflowDirectory);
    await assertDirectoryIdentity(this.workflowDirectory, directory);
    return true;
  }

  private async retireWriterOwner(
    identity: WriterLockIdentity,
    directory: DirectoryIdentity,
  ): Promise<boolean> {
    let handle: FileHandle;
    try {
      handle = await open(identity.ownerPath, constants.O_RDONLY | NO_FOLLOW);
    } catch (error) {
      if (isMissing(error)) return false;
      throw error;
    }
    try {
      const metadata = await handle.stat();
      let named = await lstat(identity.ownerPath);
      if (!metadata.isFile()
        || metadata.nlink !== 1
        || metadata.dev !== identity.dev
        || metadata.ino !== identity.ino
        || metadata.size < 1
        || metadata.size > MAX_WRITER_LOCK_BYTES
        || !named.isFile()
        || named.isSymbolicLink()
        || named.dev !== identity.dev
        || named.ino !== identity.ino) return false;
      const contents = await readHandleBytes(handle, metadata.size);
      const record = parseWriterLock(contents);
      if (record.pid !== identity.record.pid
        || record.processToken !== identity.record.processToken
        || record.token !== identity.record.token) return false;
      const settled = await handle.stat();
      named = await lstat(identity.ownerPath);
      if (settled.nlink !== 1
        || settled.size !== metadata.size
        || settled.mtimeMs !== metadata.mtimeMs
        || settled.ctimeMs !== metadata.ctimeMs
        || named.dev !== identity.dev
        || named.ino !== identity.ino) return false;
      await rm(identity.ownerPath);
    } catch (error) {
      if (isMissing(error)) return false;
      throw error;
    } finally {
      await handle.close();
    }
    await flushDirectory(this.workflowDirectory);
    await assertDirectoryIdentity(this.workflowDirectory, directory);
    return true;
  }

  private async recoverAbandonedStateFiles(directory: DirectoryIdentity): Promise<void> {
    await assertDirectoryIdentity(this.workflowDirectory, directory);
    const names = (await readdir(this.workflowDirectory)).filter(name =>
      /^\.state\.[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(?:tmp|publish)$/u
        .test(name));
    if (names.length === 0) return;

    const artifacts: Array<{
      filePath: string;
      metadata: Stats;
    }> = [];
    for (const name of names) {
      const filePath = path.join(this.workflowDirectory, name);
      const handle = await open(filePath, constants.O_RDONLY | NO_FOLLOW);
      try {
        const metadata = await handle.stat();
        const named = await lstat(filePath);
        if (!metadata.isFile()
          || metadata.nlink < 1
          || metadata.nlink > 2
          || metadata.size > this.maxStateBytes
          || !named.isFile()
          || named.isSymbolicLink()
          || named.dev !== metadata.dev
          || named.ino !== metadata.ino
          || named.size !== metadata.size) {
          throw workflowError("abandoned workflow state file is unsafe", "unsafe-workflow-state");
        }
        artifacts.push({ filePath, metadata });
      } finally {
        await handle.close();
      }
    }

    const stateMetadata = await lstat(this.statePath).catch(error => {
      if (isMissing(error)) return null;
      throw error;
    });
    const linksByIdentity = new Map<string, number>();
    for (const artifact of artifacts) {
      const identity = `${artifact.metadata.dev}:${artifact.metadata.ino}`;
      linksByIdentity.set(identity, (linksByIdentity.get(identity) ?? 0) + 1);
    }
    for (const artifact of artifacts) {
      const identity = `${artifact.metadata.dev}:${artifact.metadata.ino}`;
      const stateLink = stateMetadata !== null
        && stateMetadata.isFile()
        && !stateMetadata.isSymbolicLink()
        && stateMetadata.dev === artifact.metadata.dev
        && stateMetadata.ino === artifact.metadata.ino
        ? 1
        : 0;
      if (artifact.metadata.nlink !== (linksByIdentity.get(identity) ?? 0) + stateLink) {
        throw workflowError(
          "abandoned workflow state file has an external hard link",
          "unsafe-workflow-state",
        );
      }
    }
    for (const artifact of artifacts) {
      const named = await lstat(artifact.filePath);
      if (!named.isFile()
        || named.isSymbolicLink()
        || named.dev !== artifact.metadata.dev
        || named.ino !== artifact.metadata.ino) {
        throw workflowError("abandoned workflow state file changed", "unsafe-workflow-state");
      }
      await rm(artifact.filePath);
    }
    await flushDirectory(this.workflowDirectory);
    await assertDirectoryIdentity(this.workflowDirectory, directory);
  }

  private async readFromDirectory(
    directory: DirectoryIdentity,
  ): Promise<AutopilotWorkflowState | null> {
    await assertDirectoryIdentity(this.workflowDirectory, directory);
    let handle: FileHandle | undefined;
    try {
      try {
        handle = await open(this.statePath, constants.O_RDONLY | NO_FOLLOW);
      } catch (error) {
        if (isMissing(error)) return null;
        throw error;
      }
      const message = "workflow state must be a bounded regular single-link file";
      const { bytes: first } = await readSingleLinkFile(
        handle,
        this.statePath,
        { minBytes: 0, maxBytes: this.maxStateBytes },
        {
          unsafe: () => workflowError(message, "unsafe-workflow-state"),
          oversized: () => workflowError(message, "workflow-state-too-large"),
          changed: () => workflowError("workflow state changed during read", "unsafe-workflow-state"),
        },
      );
      let parsed: unknown;
      try {
        parsed = JSON.parse(first.toString("utf8")) as unknown;
      } catch {
        throw workflowError("workflow state contains malformed JSON", "invalid-workflow-state");
      }
      await assertDirectoryIdentity(this.workflowDirectory, directory);
      return validateState(parsed, this.workflowId);
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    } finally {
      await handle?.close();
    }
  }

  private withJournalCheckpoint(
    state: AutopilotWorkflowState,
    journal: JournalRead,
  ): AutopilotWorkflowState {
    if (state.intentJournal.ref !== "journal.ndjson"
      || state.intentJournal.entryCount < 0
      || state.intentJournal.entryCount > journal.entries.length) {
      throw workflowError("workflow journal checkpoint is invalid", "invalid-workflow-journal");
    }
    const checkpointHash = state.intentJournal.entryCount === 0
      ? null
      : journal.entries[state.intentJournal.entryCount - 1]?.entryHash ?? null;
    if (checkpointHash !== state.intentJournal.lastEntryHash) {
      throw workflowError("workflow journal checkpoint hash does not match", "invalid-workflow-journal");
    }
    const coreIdentities = normalizedExpectedIdentities(state, undefined);
    for (const entry of journal.entries) {
      for (const [key, value] of Object.entries(coreIdentities)) {
        if (entry.expectedIdentities[key] !== value) {
          throw workflowError(
            "workflow journal identity does not match state",
            "invalid-workflow-journal",
          );
        }
      }
    }
    const current = structuredClone(state);
    current.intentJournal.entryCount = journal.entries.length;
    current.intentJournal.lastEntryHash = journal.entries.at(-1)?.entryHash ?? null;
    return current;
  }

  private async publishJournalCheckpointIfNeeded(
    persisted: AutopilotWorkflowState,
    journal: JournalRead,
    directory: DirectoryIdentity,
  ): Promise<void> {
    const current = this.withJournalCheckpoint(persisted, journal);
    if (persisted.intentJournal.entryCount !== current.intentJournal.entryCount
      || persisted.intentJournal.lastEntryHash !== current.intentJournal.lastEntryHash) {
      await this.publishJournalCheckpoint(current, journal, directory);
    }
  }

  private async publishJournalCheckpoint(
    state: AutopilotWorkflowState,
    journal: JournalRead,
    directory: DirectoryIdentity,
  ): Promise<void> {
    const next = this.withJournalCheckpoint(state, journal);
    const bytes = serializeState(next, this.workflowId, this.maxStateBytes);
    await this.assertCurrentRevision(directory, state.revision);
    await this.publish(bytes, directory, false);
  }

  private async readJournalForAppend(directory: DirectoryIdentity): Promise<JournalRead> {
    let journal = await this.readJournalFromDirectory(directory);
    if (!journal.tornTail) return journal;
    await this.truncateTornJournalTail(directory, journal);
    journal = await this.readJournalFromDirectory(directory);
    if (journal.tornTail) {
      throw workflowError("workflow journal torn tail could not be repaired", "invalid-workflow-journal");
    }
    return journal;
  }

  private async readJournalFromDirectory(directory: DirectoryIdentity): Promise<JournalRead> {
    await assertDirectoryIdentity(this.workflowDirectory, directory);
    let handle: FileHandle | undefined;
    try {
      try {
        handle = await open(this.journalPath, constants.O_RDONLY | NO_FOLLOW);
      } catch (error) {
        if (isMissing(error)) {
          await assertDirectoryIdentity(this.workflowDirectory, directory);
          return {
            entries: [],
            intents: [],
            tornTail: false,
            completeByteLength: 0,
            fileSize: 0,
            identity: null,
            mtimeMs: null,
            ctimeMs: null,
          };
        }
        throw error;
      }
      const message = "workflow journal must be a bounded regular single-link file";
      const { bytes: first, metadata } = await readSingleLinkFile(
        handle,
        this.journalPath,
        { minBytes: 0, maxBytes: this.maxJournalBytes },
        {
          unsafe: () => workflowError(message, "unsafe-workflow-state"),
          oversized: () => workflowError(message, "workflow-journal-too-large"),
          changed: () => workflowError("workflow journal changed during read", "unsafe-workflow-state"),
        },
      );
      const finalNewline = first.lastIndexOf(0x0a);
      const tornTail = first.byteLength > 0 && finalNewline !== first.byteLength - 1;
      const completeByteLength = tornTail ? finalNewline + 1 : first.byteLength;
      const complete = first.subarray(0, completeByteLength).toString("utf8");
      const entries: WorkflowJournalEntry[] = [];
      if (complete !== "") {
        for (const line of complete.slice(0, -1).split("\n")) {
          if (line.trim() === "") {
            throw workflowError("workflow journal contains a blank record", "invalid-workflow-journal");
          }
          entries.push(parseJournalEntry(line, this.workflowId, entries.at(-1)));
        }
      }
      await assertDirectoryIdentity(this.workflowDirectory, directory);
      return {
        entries,
        intents: indexJournalEntries(entries),
        tornTail,
        completeByteLength,
        fileSize: metadata.size,
        identity: { dev: metadata.dev, ino: metadata.ino },
        mtimeMs: metadata.mtimeMs,
        ctimeMs: metadata.ctimeMs,
      };
    } finally {
      await handle?.close();
    }
  }

  private async truncateTornJournalTail(
    directory: DirectoryIdentity,
    snapshot: JournalRead,
  ): Promise<void> {
    if (!snapshot.tornTail || snapshot.identity === null) return;
    await assertDirectoryIdentity(this.workflowDirectory, directory);
    const handle = await open(this.journalPath, constants.O_RDWR | NO_FOLLOW);
    try {
      const metadata = await handle.stat();
      const named = await lstat(this.journalPath);
      if (!metadata.isFile()
        || metadata.nlink !== 1
        || metadata.dev !== snapshot.identity.dev
        || metadata.ino !== snapshot.identity.ino
        || metadata.size !== snapshot.fileSize
        || metadata.mtimeMs !== snapshot.mtimeMs
        || metadata.ctimeMs !== snapshot.ctimeMs
        || !named.isFile()
        || named.isSymbolicLink()
        || named.dev !== metadata.dev
        || named.ino !== metadata.ino) {
        throw workflowError("workflow journal changed during torn-tail repair", "unsafe-workflow-state");
      }
      await handle.truncate(snapshot.completeByteLength);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await flushDirectory(this.workflowDirectory);
    await assertDirectoryIdentity(this.workflowDirectory, directory);
  }

  private async appendJournalEntry(
    bytes: Buffer,
    directory: DirectoryIdentity,
    expectedSize: number,
  ): Promise<void> {
    if (expectedSize + bytes.byteLength > this.maxJournalBytes) {
      throw workflowError("workflow journal exceeds its size limit", "workflow-journal-too-large");
    }
    await assertDirectoryIdentity(this.workflowDirectory, directory);
    const handle = await open(
      this.journalPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | NO_FOLLOW,
      0o600,
    );
    try {
      const metadata = await handle.stat();
      const named = await lstat(this.journalPath);
      if (!metadata.isFile()
        || metadata.nlink !== 1
        || metadata.size !== expectedSize
        || !named.isFile()
        || named.isSymbolicLink()
        || named.nlink !== 1
        || named.dev !== metadata.dev
        || named.ino !== metadata.ino) {
        throw workflowError("workflow journal changed before append", "unsafe-workflow-state");
      }
      await handle.writeFile(bytes);
      await handle.sync();
      const settled = await handle.stat();
      if (settled.size !== expectedSize + bytes.byteLength) {
        throw workflowError("workflow journal append was incomplete", "invalid-workflow-journal");
      }
      await assertDirectoryIdentity(this.workflowDirectory, directory);
    } finally {
      await handle.close();
    }
    await flushDirectory(this.workflowDirectory);
    await assertDirectoryIdentity(this.workflowDirectory, directory);
  }

  private async assertCurrentRevision(
    directory: DirectoryIdentity,
    expectedRevision: number,
  ): Promise<void> {
    const current = await this.readFromDirectory(directory);
    if (current === null || current.revision !== expectedRevision) {
      throw workflowError("workflow revision changed before publication", "workflow-revision-conflict");
    }
  }

  private async publish(
    bytes: Buffer,
    directory: DirectoryIdentity,
    create: boolean,
  ): Promise<void> {
    const temporaryPath = path.join(
      this.workflowDirectory,
      `.state.${randomUUID()}.tmp`,
    );
    const publicationPath = path.join(
      this.workflowDirectory,
      `.state.${randomUUID()}.publish`,
    );
    let handle: FileHandle | undefined;
    let temporaryExists = false;
    let publicationExists = false;
    let temporaryIdentity: PreciseFileIdentity | undefined;
    try {
      handle = await open(
        temporaryPath,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NO_FOLLOW,
        0o600,
      );
      temporaryExists = true;
      await handle.writeFile(bytes);
      await handle.sync();
      const metadata = await handle.stat({ bigint: true });
      const named = await lstat(temporaryPath, { bigint: true });
      if (!metadata.isFile()
        || metadata.nlink !== 1n
        || metadata.size !== BigInt(bytes.byteLength)
        || !named.isFile()
        || named.isSymbolicLink()
        || named.dev !== metadata.dev
        || named.ino !== metadata.ino) {
        throw workflowError("workflow state temporary file changed", "unsafe-workflow-state");
      }
      temporaryIdentity = { dev: metadata.dev, ino: metadata.ino };
      await handle.close();
      handle = undefined;
      await assertDirectoryIdentity(this.workflowDirectory, directory);
      if (create) {
        try {
          await lstat(this.statePath);
          throw workflowError("workflow state already exists", "workflow-state-conflict");
        } catch (error) {
          if (!isMissing(error)) throw error;
        }
      }
      await this.stageStatePublication(
        temporaryPath,
        publicationPath,
        bytes,
        temporaryIdentity,
      );
      publicationExists = true;
      await this.assertStagedPublication(
        temporaryPath,
        publicationPath,
        bytes,
        temporaryIdentity,
      );
      await rm(temporaryPath);
      temporaryExists = false;
      await rename(publicationPath, this.statePath);
      publicationExists = false;
      await this.assertPublishedState(bytes, temporaryIdentity);
      await flushDirectory(this.workflowDirectory);
      await assertDirectoryIdentity(this.workflowDirectory, directory);
    } finally {
      await handle?.close();
      if (temporaryExists) await rm(temporaryPath, { force: true });
      if (publicationExists) await rm(publicationPath, { force: true });
    }
  }

  protected async stageStatePublication(
    temporaryPath: string,
    publicationPath: string,
    expectedBytes: Buffer,
    expectedIdentity: PreciseFileIdentity,
  ): Promise<void> {
    let linked = false;
    try {
      await link(temporaryPath, publicationPath);
      linked = true;
      const publication = await lstat(publicationPath, { bigint: true });
      if (!publication.isFile()
        || publication.isSymbolicLink()
        || publication.nlink !== 2n
        || publication.dev !== expectedIdentity.dev
        || publication.ino !== expectedIdentity.ino
        || publication.size !== BigInt(expectedBytes.byteLength)) {
        throw workflowError("workflow state publication source changed", "unsafe-workflow-state");
      }
    } catch (error) {
      if (linked) await rm(publicationPath, { force: true });
      throw error;
    }
  }

  private async assertStagedPublication(
    temporaryPath: string,
    publicationPath: string,
    expectedBytes: Buffer,
    expectedIdentity: PreciseFileIdentity,
  ): Promise<void> {
    const handle = await open(publicationPath, constants.O_RDONLY | NO_FOLLOW);
    try {
      const metadata = await handle.stat({ bigint: true });
      const [publication, temporary] = await Promise.all([
        lstat(publicationPath, { bigint: true }),
        lstat(temporaryPath, { bigint: true }),
      ]);
      if (!metadata.isFile()
        || metadata.nlink !== 2n
        || metadata.size !== BigInt(expectedBytes.byteLength)
        || metadata.dev !== expectedIdentity.dev
        || metadata.ino !== expectedIdentity.ino
        || !publication.isFile()
        || publication.isSymbolicLink()
        || publication.dev !== expectedIdentity.dev
        || publication.ino !== expectedIdentity.ino
        || !temporary.isFile()
        || temporary.isSymbolicLink()
        || temporary.dev !== expectedIdentity.dev
        || temporary.ino !== expectedIdentity.ino) {
        throw workflowError("workflow state publication changed before commit", "unsafe-workflow-state");
      }
      const published = await readHandleBytes(handle, Number(metadata.size));
      const settled = await handle.stat({ bigint: true });
      if (!published.equals(expectedBytes)
        || settled.nlink !== metadata.nlink
        || settled.size !== metadata.size
        || settled.mtimeNs !== metadata.mtimeNs
        || settled.ctimeNs !== metadata.ctimeNs) {
        throw workflowError("workflow state publication changed before commit", "unsafe-workflow-state");
      }
    } finally {
      await handle.close();
    }
  }

  private async assertPublishedState(
    expectedBytes: Buffer,
    expectedIdentity: PreciseFileIdentity,
  ): Promise<void> {
    const handle = await open(this.statePath, constants.O_RDONLY | NO_FOLLOW);
    try {
      const metadata = await handle.stat({ bigint: true });
      const named = await lstat(this.statePath, { bigint: true });
      if (!metadata.isFile()
        || metadata.nlink !== 1n
        || metadata.size !== BigInt(expectedBytes.byteLength)
        || metadata.dev !== expectedIdentity.dev
        || metadata.ino !== expectedIdentity.ino
        || !named.isFile()
        || named.isSymbolicLink()
        || named.nlink !== 1n
        || named.dev !== metadata.dev
        || named.ino !== metadata.ino
        || named.size !== metadata.size) {
        throw workflowError("published workflow state identity changed", "unsafe-workflow-state");
      }
      const published = await readHandleBytes(handle, Number(metadata.size));
      const settled = await handle.stat({ bigint: true });
      if (!published.equals(expectedBytes)
        || settled.size !== metadata.size
        || settled.mtimeNs !== metadata.mtimeNs
        || settled.ctimeNs !== metadata.ctimeNs) {
        throw workflowError("published workflow state bytes changed", "unsafe-workflow-state");
      }
    } finally {
      await handle.close();
    }
  }
}
