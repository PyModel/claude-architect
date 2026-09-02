import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, link, lstat, mkdir, mkdtemp, open, realpath, rm } from "node:fs/promises";
import path from "node:path";
import type { CheckoutLock, PlatformServices } from "../platform/platform-services.js";
import { getPlatformServices } from "../platform/select-platform.js";
import { resolveStateDir } from "../runtime/state-dir.js";
import { PlatformSafety } from "../platform/platform-safety.js";
import { syncDirectoryMetadata } from "../platform/durable-directory.js";
import { RuntimeError } from "../util/errors.js";
import { logger } from "../util/logger.js";
import { readStableRegularFile } from "../util/stable-file.js";
import { boundedRedactedDiagnostic, redact } from "../runtime/redaction.js";
import { git, type GitResult } from "../git/git-exec.js";
import { gitNulRecords, gitPathOutput } from "../git/git-output.js";
import { checkInProgressOperation } from "../git/repo-preconditions.js";
import { canonicalizeWorktreePath } from "../git/worktree-registration.js";
import {
  managedWorktreeDirectoryIdentity,
  removeStaleWorktreeRegistration,
  WorktreeManager,
  type ManagedWorktreeDirectoryIdentity,
  type WorktreeManagerDependencies,
} from "../runtime/worktree-manager.js";

const TOPIC = /^[a-z0-9](?:[a-z0-9-]{1,46}[a-z0-9])$/;
const WORKFLOW_ID = /^[a-z0-9][a-z0-9-]{7,127}$/;
const GITHUB_COMPONENT = /^[A-Za-z0-9_.-]+$/;
const REWRITE_KEYS = "^url\\..*\\.(insteadof|pushinsteadof)$";
const OWNERSHIP_VERSION = "1";

type GitRunner = typeof git;

export interface RemoteTransport {
  fetch(
    cwd: string,
    canonicalUrl: string,
    sourceRef: string,
    destinationRef: string,
  ): Promise<GitResult>;
  listHeads(cwd: string, canonicalUrl: string): Promise<GitResult>;
}

export interface WorkflowBranchManagerDependencies {
  git?: GitRunner;
  remoteTransport?: RemoteTransport;
  removeOwnership?: (ownershipPath: string) => Promise<void>;
  platformServices?: Pick<PlatformServices, "acquireCheckoutLock" | "canonicalizePath" | "os">
    & Partial<Pick<PlatformServices, "getProcessStartToken">>;
  worktreeManagerDependencies?: WorktreeManagerDependencies;
}

export interface CreateWorkflowBranchRequest {
  checkoutPath: string;
  workflowId: string;
  topic: string;
  remote: string;
  baseBranch: string;
}

export interface WorkflowBranchIdentity {
  ownershipVersion: "1";
  workflowId: string;
  checkoutPath: string;
  gitCommonDir: string;
  repositoryIdentity: string;
  worktreePath: string;
  worktreeGitDir: string;
  branch: string;
  branchRef: string;
  baseRef: string;
  baseBranch: string;
  baseCommitOid: string;
  remote: "origin";
  remoteUrl: string;
  ownerRepo: string;
}

export interface WorkflowBranchBootstrapOwnerRecord {
  workflowId: string;
  pid: number;
  processToken: string | null;
  createdAt: string;
}

interface WorkflowBranchRegistration extends WorkflowBranchIdentity {
  bootstrapOwner: WorkflowBranchBootstrapOwnerRecord;
}

export type BranchRevalidationClassification =
  | "ownership-mismatch"
  | "repository-identity-changed"
  | "remote-identity-changed"
  | "base-ref-changed"
  | "remote-base-changed"
  | "worktree-missing"
  | "worktree-path-changed"
  | "worktree-registration-changed"
  | "branch-changed"
  | "head-changed"
  | "dirty-worktree"
  | "in-progress-operation"
  | "in-progress-operation-scan-failed"
  | "git-command-failed";

export type BranchRevalidationResult =
  | { ok: true }
  | { ok: false; classification: BranchRevalidationClassification };

export type BranchCleanupResult =
  | { ok: true; worktreeRemoved: boolean; refsRemoved: boolean }
  | { ok: false; classification: "cleanup-failed" };

export class WorkflowBranchError extends RuntimeError {
  constructor(readonly classification: string, message = classification) {
    super(message, { classification });
    this.name = "WorkflowBranchError";
  }
}

interface RemoteIdentity {
  url: string;
  ownerRepo: string;
}

function succeeded(result: GitResult): boolean {
  return result.exitCode === 0
    && result.truncated?.stdout !== true
    && result.truncated?.stderr !== true;
}

function transportFailure(action: string): GitResult {
  return { exitCode: 2, stdout: "", stderr: `${action} failed in isolated transport` };
}

export function createIsolatedRemoteTransport(runGit: GitRunner = git): RemoteTransport {
  const isolatedEnvironment = (repository: string): Record<string, string> => {
    const nullDevice = process.platform === "win32" ? "NUL" : "/dev/null";
    return {
      GIT_CONFIG_GLOBAL: nullDevice,
      GIT_CONFIG_SYSTEM: nullDevice,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_COUNT: "0",
      GIT_CONFIG_PARAMETERS: "",
      HOME: repository,
      XDG_CONFIG_HOME: repository,
    };
  };
  const runIsolatedGit = (
    repository: string,
    args: string[],
    options: Parameters<GitRunner>[2] = {},
  ): Promise<GitResult> => {
    const normalizedOptions = typeof options === "string" ? { indexFile: options } : options;
    return runGit(repository, args, {
      ...normalizedOptions,
      env: {
        ...normalizedOptions.env,
        ...isolatedEnvironment(repository),
      },
    });
  };
  const createRepository = async (): Promise<string> => {
    const root = path.join(resolveStateDir(), "autopilot-remote");
    await mkdir(root, { recursive: true, mode: 0o700 });
    await chmod(root, 0o700);
    const repository = await mkdtemp(path.join(root, "operation-"));
    await chmod(repository, 0o700);
    const initialized = await runIsolatedGit(repository, ["init", "--bare", "--quiet", "."]);
    if (!succeeded(initialized)) {
      await rm(repository, { recursive: true, force: true });
      throw new RuntimeError("isolated remote repository initialization failed");
    }
    return repository;
  };

  return {
    async listHeads(_cwd, canonicalUrl) {
      let repository: string | undefined;
      let result: GitResult;
      try {
        repository = await createRepository();
        result = await runIsolatedGit(repository, ["ls-remote", "--heads", canonicalUrl]);
      } catch {
        result = transportFailure("git ls-remote");
      }
      if (repository !== undefined) {
        try {
          await rm(repository, { recursive: true });
        } catch {
          return transportFailure("isolated remote repository cleanup");
        }
      }
      return result;
    },

    async fetch(cwd, canonicalUrl, sourceRef, destinationRef) {
      let repository: string | undefined;
      let fetchedOid: string | undefined;
      let result: GitResult = transportFailure("git fetch");
      try {
        repository = await createRepository();
        const quarantineRef = "refs/claude-architect/transport/base";
        result = await runIsolatedGit(repository, [
          "fetch",
          "--no-tags",
          "--no-write-fetch-head",
          canonicalUrl,
          `${sourceRef}:${quarantineRef}`,
        ]);
        if (succeeded(result)) {
          const resolved = await runIsolatedGit(repository, ["rev-parse", "--verify", quarantineRef]);
          if (!succeeded(resolved) || !isOid(resolved.stdout.trim())) {
            result = succeeded(resolved) ? transportFailure("git resolve fetched base") : resolved;
          } else {
            fetchedOid = resolved.stdout.trim();
            const bundlePath = path.join(repository, "base.bundle");
            const bundled = await runIsolatedGit(
              repository,
              ["bundle", "create", bundlePath, quarantineRef],
            );
            if (!succeeded(bundled)) {
              result = bundled;
              fetchedOid = undefined;
            } else {
              const imported = await runIsolatedGit(cwd, ["bundle", "unbundle", bundlePath]);
              result = imported;
              if (!succeeded(imported)) fetchedOid = undefined;
            }
          }
        }
      } catch {
        result = transportFailure("git fetch");
      } finally {
        if (repository !== undefined) {
          try {
            await rm(repository, { recursive: true });
          } catch {
            result = transportFailure("isolated remote repository cleanup");
            fetchedOid = undefined;
          }
        }
      }
      if (!succeeded(result) || fetchedOid === undefined) return result;
      return runIsolatedGit(cwd, [
        "update-ref",
        destinationRef,
        fetchedOid,
        "0".repeat(fetchedOid.length),
      ]);
    },
  };
}

function fail(classification: string, message?: string): never {
  throw new WorkflowBranchError(classification, message);
}

function canonicalGithubUrl(raw: string): RemoteIdentity {
  if (raw.includes("\n") || raw.includes("\r") || raw.includes("\0")) {
    fail("remote-url-invalid");
  }
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    fail("remote-url-invalid");
  }
  if (parsed.protocol !== "https:") fail("remote-url-not-https");
  if (parsed.hostname.toLowerCase() !== "github.com" || parsed.port !== "") {
    fail("remote-host-not-github");
  }
  if (parsed.username !== "" || parsed.password !== "" || parsed.search !== "" || parsed.hash !== "") {
    fail("remote-url-has-credentials-or-suffix");
  }
  if (parsed.pathname.includes("%") || parsed.pathname.endsWith("/") || parsed.pathname.includes("//")) {
    fail("remote-url-invalid");
  }
  const components = parsed.pathname.slice(1).split("/");
  if (components.length !== 2) fail("remote-url-invalid");
  const owner = components[0]!;
  const repositoryWithSuffix = components[1]!;
  const repository = repositoryWithSuffix.endsWith(".git")
    ? repositoryWithSuffix.slice(0, -4)
    : repositoryWithSuffix;
  if (!GITHUB_COMPONENT.test(owner)
    || !GITHUB_COMPONENT.test(repository)
    || owner === "."
    || owner === ".."
    || repository === "."
    || repository === "..") {
    fail("remote-url-invalid");
  }
  const canonicalOwner = owner.toLowerCase();
  const canonicalRepository = repository.toLowerCase();
  return {
    url: `https://github.com/${canonicalOwner}/${canonicalRepository}.git`,
    ownerRepo: `${canonicalOwner}/${canonicalRepository}`,
  };
}

function parseRemoteHeads(output: string): Map<string, string> {
  const heads = new Map<string, string>();
  for (const line of output.split("\n")) {
    if (line === "") continue;
    const match = /^([0-9a-f]+)\trefs\/heads\/(.+)$/.exec(line);
    if (match === null) fail("remote-response-invalid");
    heads.set(match[2]!, match[1]!);
  }
  return heads;
}

function isOid(value: string): boolean {
  return /^[0-9a-f]{40}$/.test(value) || /^[0-9a-f]{64}$/.test(value);
}

interface WorktreeRegistration {
  worktree: string;
  head?: string;
  branch?: string;
}

async function parseWorktreeRegistrations(
  output: string,
  allowMissing = false,
): Promise<WorktreeRegistration[] | null> {
  const registrations: WorktreeRegistration[] = [];
  let registration: Partial<WorktreeRegistration> = {};
  for (const field of gitNulRecords(output, "Autopilot Git worktree list")) {
    if (field === "") {
      if (Object.keys(registration).length === 0) continue;
      if (registration.worktree === undefined) return null;
      registrations.push(registration as WorktreeRegistration);
      registration = {};
      continue;
    }
    const separator = field.indexOf(" ");
    const key = separator === -1 ? field : field.slice(0, separator);
    const value = separator === -1 ? "" : field.slice(separator + 1);
    if (key === "worktree") registration.worktree = path.resolve(value);
    else if (key === "HEAD") registration.head = value;
    else if (key === "branch") registration.branch = value;
  }
  if (Object.keys(registration).length !== 0) return null;
  for (const parsed of registrations) {
    parsed.worktree = await canonicalizeWorktreePath(parsed.worktree, allowMissing);
  }
  return registrations;
}

function sameOwnership(left: WorkflowBranchIdentity, right: WorkflowBranchIdentity): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function hasExactKeys(value: object, expected: readonly string[]): boolean {
  const keys = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return keys.length === sortedExpected.length
    && keys.every((key, index) => key === sortedExpected[index]);
}

function isBootstrapOwnerRecord(
  value: unknown,
  workflowId: string,
): value is WorkflowBranchBootstrapOwnerRecord {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Partial<WorkflowBranchBootstrapOwnerRecord>;
  return hasExactKeys(value, ["workflowId", "pid", "processToken", "createdAt"])
    && record.workflowId === workflowId
    && Number.isSafeInteger(record.pid)
    && record.pid! > 0
    && (record.processToken === null
      || (typeof record.processToken === "string"
        && record.processToken.length > 0
        && record.processToken.length <= 256))
    && typeof record.createdAt === "string"
    && !Number.isNaN(Date.parse(record.createdAt));
}

function parseRegistration(
  value: unknown,
  workflowId: string,
): WorkflowBranchRegistration | null {
  if (typeof value !== "object" || value === null) return null;
  const parsed = value as Partial<WorkflowBranchRegistration>;
  if (!hasExactKeys(value, [
    "ownershipVersion",
    "workflowId",
    "checkoutPath",
    "gitCommonDir",
    "repositoryIdentity",
    "worktreePath",
    "worktreeGitDir",
    "branch",
    "branchRef",
    "baseRef",
    "baseBranch",
    "baseCommitOid",
    "remote",
    "remoteUrl",
    "ownerRepo",
    "bootstrapOwner",
  ])
    || parsed.ownershipVersion !== OWNERSHIP_VERSION
    || parsed.workflowId !== workflowId
    || typeof parsed.checkoutPath !== "string"
    || !path.isAbsolute(parsed.checkoutPath)
    || path.resolve(parsed.checkoutPath) !== parsed.checkoutPath
    || typeof parsed.gitCommonDir !== "string"
    || !path.isAbsolute(parsed.gitCommonDir)
    || path.resolve(parsed.gitCommonDir) !== parsed.gitCommonDir
    || typeof parsed.repositoryIdentity !== "string"
    || parsed.repositoryIdentity !== parsed.gitCommonDir
    || typeof parsed.worktreePath !== "string"
    || !path.isAbsolute(parsed.worktreePath)
    || path.resolve(parsed.worktreePath) !== parsed.worktreePath
    || typeof parsed.worktreeGitDir !== "string"
    || !path.isAbsolute(parsed.worktreeGitDir)
    || path.resolve(parsed.worktreeGitDir) !== parsed.worktreeGitDir
    || typeof parsed.branch !== "string"
    || parsed.branchRef !== `refs/heads/${parsed.branch}`
    || parsed.baseRef !== `refs/claude-architect/autopilot/${workflowId}/base`
    || typeof parsed.baseBranch !== "string"
    || !isOid(parsed.baseCommitOid ?? "")
    || parsed.remote !== "origin"
    || typeof parsed.remoteUrl !== "string"
    || typeof parsed.ownerRepo !== "string"
    || !isBootstrapOwnerRecord(parsed.bootstrapOwner, workflowId)) return null;
  return parsed as WorkflowBranchRegistration;
}

async function readRegistrationFile(
  ownershipPath: string,
  expectedWorkflowId?: string,
): Promise<WorkflowBranchRegistration | null> {
  const contents = await readStableRegularFile(ownershipPath, 32_768n);
  if (contents === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents.toString("utf8")) as unknown;
  } catch (error) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
  const workflowId = expectedWorkflowId
    ?? (typeof parsed === "object" && parsed !== null
      && typeof (parsed as { workflowId?: unknown }).workflowId === "string"
      ? (parsed as { workflowId: string }).workflowId
      : null);
  return workflowId === null || !WORKFLOW_ID.test(workflowId)
    ? null
    : parseRegistration(parsed, workflowId);
}

export async function workflowOwnershipRecordWorkflowId(
  ownershipPath: string,
): Promise<string> {
  const registration = await readRegistrationFile(ownershipPath);
  if (registration === null) {
    throw new RuntimeError("workflow ownership record is malformed");
  }
  return registration.workflowId;
}

export interface WorkflowWorktreeOwnershipClaim {
  workflowId: string;
  bootstrapOwner: WorkflowBranchBootstrapOwnerRecord;
}

/** Validate and return the durable owner of one managed workflow worktree. */
export async function workflowWorktreeOwnershipClaim(
  ownershipPath: string,
  worktreePath: string,
): Promise<WorkflowWorktreeOwnershipClaim> {
  const registration = await readRegistrationFile(ownershipPath);
  if (registration === null) {
    throw new RuntimeError("workflow ownership record is malformed");
  }
  const ownershipHash = createHash("sha256").update(registration.workflowId).digest("hex");
  const expectedOwnershipPath = path.join(
    resolveStateDir(),
    "autopilot-branches",
    `${ownershipHash}.json`,
  );
  if (path.resolve(ownershipPath) !== path.resolve(expectedOwnershipPath)) {
    throw new RuntimeError("workflow ownership filename does not match its workflow id");
  }
  const [canonicalOwnershipPath, canonicalExpectedOwnershipPath, canonicalWorktreePath] =
    await Promise.all([
      realpath(ownershipPath),
      realpath(expectedOwnershipPath),
      realpath(worktreePath),
    ]);
  let canonicalRegisteredWorktreePath: string;
  try {
    canonicalRegisteredWorktreePath = await realpath(registration.worktreePath);
  } catch (error) {
    throw new RuntimeError("workflow ownership worktree path is unavailable", { cause: error });
  }
  const settledRegistration = await readRegistrationFile(ownershipPath);
  if (settledRegistration === null
    || JSON.stringify(settledRegistration) !== JSON.stringify(registration)) {
    throw new RuntimeError("workflow ownership record changed during validation");
  }
  const managedName = `workflow-${ownershipHash.slice(0, 32)}`;
  const candidateName = path.basename(canonicalWorktreePath);
  const ownsPrimary = candidateName === managedName
    && canonicalRegisteredWorktreePath === canonicalWorktreePath;
  const legacyFinalName = `final-${createHash("sha256")
    .update(JSON.stringify(registration.workflowId)).digest("hex").slice(0, 24)}`;
  const ownsFinalMaterialization = (candidateName === `${managedName}-final`
    || candidateName === legacyFinalName)
    && path.basename(canonicalRegisteredWorktreePath) === managedName
    && path.dirname(canonicalRegisteredWorktreePath) === path.dirname(canonicalWorktreePath);
  if (canonicalOwnershipPath !== canonicalExpectedOwnershipPath
    || (!ownsPrimary && !ownsFinalMaterialization)) {
    throw new RuntimeError("workflow ownership record names a different worktree");
  }
  return {
    workflowId: registration.workflowId,
    bootstrapOwner: structuredClone(registration.bootstrapOwner),
  };
}

/** Validate a durable workflow registration as the owner of one managed worktree. */
export async function workflowOwnershipClaimsWorktree(
  ownershipPath: string,
  worktreePath: string,
): Promise<boolean> {
  await workflowWorktreeOwnershipClaim(ownershipPath, worktreePath);
  return true;
}

function operationFailure(action: string, result: GitResult): never {
  const diagnostic = boundedRedactedDiagnostic(
    (result.stderr || result.stdout).trim(),
    2_000,
  );
  fail("git-command-failed", `${action} failed${diagnostic ? `: ${diagnostic}` : ""}`);
}

export class WorkflowBranchManager {
  private readonly runGit: GitRunner;
  private readonly remoteTransport: RemoteTransport;
  private readonly removeOwnership: (ownershipPath: string) => Promise<void>;
  private readonly platformServices: Pick<
    PlatformServices,
    "acquireCheckoutLock" | "canonicalizePath" | "os"
  >;
  private readonly getProcessStartToken: PlatformServices["getProcessStartToken"];
  private readonly worktreeManagerDependencies: WorktreeManagerDependencies;

  constructor(dependencies: WorkflowBranchManagerDependencies = {}) {
    this.runGit = dependencies.git ?? git;
    this.remoteTransport = dependencies.remoteTransport ?? createIsolatedRemoteTransport(this.runGit);
    this.removeOwnership = dependencies.removeOwnership ?? (ownershipPath => rm(ownershipPath));
    const platformServices = dependencies.platformServices ?? getPlatformServices();
    this.platformServices = platformServices;
    this.getProcessStartToken = platformServices.getProcessStartToken?.bind(platformServices)
      ?? getPlatformServices().getProcessStartToken.bind(getPlatformServices());
    this.worktreeManagerDependencies = {
      ...dependencies.worktreeManagerDependencies,
      git: this.runGit,
    };
  }

  private ownershipPath(workflowId: string): string {
    const name = createHash("sha256").update(workflowId).digest("hex");
    return path.join(resolveStateDir(), "autopilot-branches", `${name}.json`);
  }

  private async readRegistration(workflowId: string): Promise<WorkflowBranchRegistration | null> {
    try {
      return await readRegistrationFile(this.ownershipPath(workflowId), workflowId);
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error
        && ["ENOENT", "ENOTDIR"].includes(String(error.code))) return null;
      throw error;
    }
  }

  private async readOwnership(identity: WorkflowBranchIdentity): Promise<boolean> {
    const registration = await this.readRegistration(identity.workflowId);
    if (registration === null) return false;
    const { bootstrapOwner: _bootstrapOwner, ...registeredIdentity } = registration;
    return sameOwnership(registeredIdentity, identity);
  }

  async load(workflowId: string): Promise<WorkflowBranchIdentity | null> {
    if (!WORKFLOW_ID.test(workflowId)) fail("ownership-mismatch");
    const registration = await this.readRegistration(workflowId);
    if (registration === null) return null;
    const { bootstrapOwner: _bootstrapOwner, ...identity } = registration;
    return identity;
  }

  async readBootstrapOwner(
    workflowId: string,
  ): Promise<WorkflowBranchBootstrapOwnerRecord | null> {
    if (!WORKFLOW_ID.test(workflowId)) fail("ownership-mismatch");
    const registration = await this.readRegistration(workflowId);
    return registration === null ? null : { ...registration.bootstrapOwner };
  }

  private async ownershipExists(workflowId: string): Promise<boolean> {
    try {
      await lstat(this.ownershipPath(workflowId));
      return true;
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
        return false;
      }
      throw error;
    }
  }

  private async persistOwnership(
    identity: WorkflowBranchIdentity,
    bootstrapOwner: WorkflowBranchBootstrapOwnerRecord,
  ): Promise<void> {
    const ownershipPath = this.ownershipPath(identity.workflowId);
    const directory = path.dirname(ownershipPath);
    await mkdir(directory, { recursive: true });
    const temporaryPath = path.join(directory, `.${path.basename(ownershipPath)}.${randomUUID()}.tmp`);
    const bytes = Buffer.from(`${JSON.stringify({ ...identity, bootstrapOwner })}\n`);
    let temporaryExists = false;
    let ownershipLinked = false;
    try {
      const handle = await open(
        temporaryPath,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
        0o600,
      );
      temporaryExists = true;
      try {
        await handle.writeFile(bytes);
        await handle.sync();
      } finally {
        await handle.close();
      }
      try {
        await link(temporaryPath, ownershipPath);
        ownershipLinked = true;
      } catch (error) {
        if (typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST") {
          fail("workflow-already-owned");
        }
        throw error;
      }
      await rm(temporaryPath);
      temporaryExists = false;
      await syncDirectoryMetadata(directory);
      ownershipLinked = false;
    } finally {
      if (temporaryExists) await rm(temporaryPath, { force: true });
      if (ownershipLinked) await rm(ownershipPath, { force: true });
    }
  }

  private async resolveRemote(checkoutPath: string): Promise<RemoteIdentity> {
    const rewrites = await this.runGit(checkoutPath, [
      "config", "--includes", "--get-regexp", REWRITE_KEYS,
    ]);
    if (rewrites.exitCode === 0) fail("remote-url-rewrite-configured");
    if (rewrites.exitCode !== 1) operationFailure("git config URL rewrite scan", rewrites);

    const pushUrls = await this.runGit(checkoutPath, [
      "config", "--includes", "--get-all", "remote.origin.pushurl",
    ]);
    if (pushUrls.exitCode === 0) fail("remote-pushurl-configured");
    if (pushUrls.exitCode !== 1) operationFailure("git config pushurl scan", pushUrls);

    const urls = await this.runGit(checkoutPath, [
      "config", "--includes", "--get-all", "remote.origin.url",
    ]);
    if (!succeeded(urls)) operationFailure("git config remote URL", urls);
    const values = urls.stdout.split("\n").filter(value => value !== "");
    if (values.length !== 1) fail("remote-url-ambiguous");
    return canonicalGithubUrl(values[0]!);
  }

  async create(request: CreateWorkflowBranchRequest): Promise<WorkflowBranchIdentity> {
    if (request.remote !== "origin") fail("remote-not-origin");
    if (request.baseBranch !== "main") fail("base-branch-not-main");
    if (!TOPIC.test(request.topic)) fail("topic-invalid");
    if (!WORKFLOW_ID.test(request.workflowId)) fail("workflow-id-invalid");

    const branch = `feat/${request.topic}-${request.workflowId.slice(0, 8)}`;
    const branchRef = `refs/heads/${branch}`;
    const baseRef = `refs/claude-architect/autopilot/${request.workflowId}/base`;
    const fetchedRef = `refs/claude-architect/autopilot/${request.workflowId}/fetch-${randomUUID()}`;
    const initial = await this.platformServices.canonicalizePath(request.checkoutPath);
    if (initial.gitCommonDir === null) fail("not-a-repository");
    let attached: Awaited<ReturnType<WorktreeManager["createAttached"]>> | undefined;
    let refsCreated = false;
    let fetchedCreated = false;
    let fetchedOidForCleanup: string | undefined;
    let completedIdentity: WorkflowBranchIdentity | undefined;
    let operationError: unknown;
    const workflowHash = createHash("sha256").update(request.workflowId).digest("hex");
    const remoteIdentity = await this.resolveRemote(initial.canonical);
    const safety = new PlatformSafety(this.platformServices as PlatformServices);
    try {
      await safety.withCheckoutLease(initial.canonical, async (lock) => {
        try {
          const locked = await this.platformServices.canonicalizePath(initial.canonical);
          if (locked.gitCommonDir === null
            || locked.gitCommonDir !== initial.gitCommonDir
            || lock.repositoryIdentity !== initial.gitCommonDir) {
            fail("repository-identity-mismatch");
          }
          if (await this.ownershipExists(request.workflowId)) {
            fail("workflow-already-owned");
          }

          const checkedBranch = await this.runGit(initial.canonical, [
            "check-ref-format", "--branch", branch,
          ]);
          if (!succeeded(checkedBranch)) fail("branch-name-invalid");
          for (const candidate of [baseRef, fetchedRef]) {
            const checked = await this.runGit(initial.canonical, ["check-ref-format", candidate]);
            if (!succeeded(checked)) fail("branch-name-invalid");
          }

          const localHeads = await this.runGit(initial.canonical, ["for-each-ref", "--format=%(refname)", "refs/heads/"]);
          if (!succeeded(localHeads)) operationFailure("git branch scan", localHeads);
          const localCollision = localHeads.stdout.split("\n").filter(Boolean)
            .some(ref => ref.toLowerCase() === branchRef.toLowerCase());
          if (localCollision) fail("local-branch-exists");
          for (const privateRef of [baseRef, fetchedRef]) {
            const exists = await this.runGit(initial.canonical, ["show-ref", "--verify", "--quiet", privateRef]);
            if (exists.exitCode === 0) fail("workflow-ref-exists");
            if (exists.exitCode !== 1) operationFailure("git private ref scan", exists);
          }

          const advertised = await this.remoteTransport.listHeads(initial.canonical, remoteIdentity.url);
          if (!succeeded(advertised)) operationFailure("git remote branch scan", advertised);
          const remoteHeads = parseRemoteHeads(advertised.stdout);
          if ([...remoteHeads.keys()].some(name => name.toLowerCase() === branch.toLowerCase())) {
            fail("remote-branch-exists");
          }
          const advertisedBase = remoteHeads.get(request.baseBranch);
          if (advertisedBase === undefined || !isOid(advertisedBase)) fail("remote-base-missing");

          const fetched = await this.remoteTransport.fetch(
            initial.canonical,
            remoteIdentity.url,
            `refs/heads/${request.baseBranch}`,
            fetchedRef,
          );
          if (!succeeded(fetched)) operationFailure("git fetch base", fetched);
          fetchedCreated = true;
          const fetchedOidResult = await this.runGit(initial.canonical, ["rev-parse", "--verify", fetchedRef]);
          if (!succeeded(fetchedOidResult)) operationFailure("git resolve fetched base", fetchedOidResult);
          const fetchedOid = fetchedOidResult.stdout.trim();
          if (!isOid(fetchedOid)) fail("stale-fetched-base");
          fetchedOidForCleanup = fetchedOid;
          if (fetchedOid !== advertisedBase) fail("stale-fetched-base");
          const commit = await this.runGit(initial.canonical, ["cat-file", "-e", `${fetchedOid}^{commit}`]);
          if (!succeeded(commit)) fail("fetched-base-not-commit");

          const confirmed = await this.remoteTransport.listHeads(initial.canonical, remoteIdentity.url);
          if (!succeeded(confirmed)) operationFailure("git remote base confirmation", confirmed);
          const confirmedHeads = parseRemoteHeads(confirmed.stdout);
          if ([...confirmedHeads.keys()].some(name => name.toLowerCase() === branch.toLowerCase())) {
            fail("remote-branch-exists");
          }
          if (confirmedHeads.get(request.baseBranch) !== fetchedOid) {
            fail("remote-base-changed-during-create");
          }

          const transaction = await this.runGit(initial.canonical, ["update-ref", "--stdin"], {
            stdin: [
              "start",
              `create ${baseRef} ${fetchedOid}`,
              `create ${branchRef} ${fetchedOid}`,
              `delete ${fetchedRef} ${fetchedOid}`,
              "prepare",
              "commit",
              "",
            ].join("\n"),
          });
          if (!succeeded(transaction)) operationFailure("git create workflow refs", transaction);
          fetchedCreated = false;
          refsCreated = true;

          const worktreeManager = new WorktreeManager(
            initial.canonical,
            `workflow-${createHash("sha256").update(request.workflowId).digest("hex").slice(0, 32)}`,
            { os: this.platformServices.os },
            { ...this.worktreeManagerDependencies, borrowedCheckoutLease: lock },
          );
          attached = await worktreeManager.createAttached(branch, fetchedOid);
          const worktreePath = await realpath(attached.path);
          const worktreeGitDirResult = await this.runGit(worktreePath, [
            "rev-parse", "--path-format=absolute", "--git-dir",
          ]);
          if (!succeeded(worktreeGitDirResult)) {
            operationFailure("git resolve worktree administrative directory", worktreeGitDirResult);
          }
          const worktreeGitDir = await realpath(gitPathOutput(
            worktreeGitDirResult.stdout,
            "workflow worktree Git directory",
          ));
          const identity: WorkflowBranchIdentity = {
            ownershipVersion: OWNERSHIP_VERSION,
            workflowId: request.workflowId,
            checkoutPath: initial.canonical,
            gitCommonDir: initial.gitCommonDir,
            repositoryIdentity: lock.repositoryIdentity,
            worktreePath,
            worktreeGitDir,
            branch,
            branchRef,
            baseRef,
            baseBranch: request.baseBranch,
            baseCommitOid: fetchedOid,
            remote: "origin",
            remoteUrl: remoteIdentity.url,
            ownerRepo: remoteIdentity.ownerRepo,
          };
          const bootstrapOwner: WorkflowBranchBootstrapOwnerRecord = {
            workflowId: request.workflowId,
            pid: process.pid,
            processToken: await this.getProcessStartToken(process.pid).catch(() => null),
            createdAt: new Date().toISOString(),
          };
          await this.persistOwnership(identity, bootstrapOwner);
          completedIdentity = identity;
        } catch (error) {
          const cleanupErrors: unknown[] = [];
          if (attached !== undefined) {
            try { await attached.cleanup(); } catch (cleanupError) { cleanupErrors.push(cleanupError); }
          }
          if (refsCreated && fetchedOidForCleanup !== undefined) {
            const rollback = await this.runGit(initial.canonical, ["update-ref", "--stdin"], {
              stdin: [
                `delete ${branchRef} ${fetchedOidForCleanup}`,
                `delete ${baseRef} ${fetchedOidForCleanup}`,
                "",
              ].join("\n"),
            });
            if (!succeeded(rollback)) cleanupErrors.push(new RuntimeError("workflow ref rollback failed"));
          } else if (refsCreated) {
            cleanupErrors.push(new RuntimeError("workflow ref identity unavailable for safe rollback"));
          } else if (fetchedCreated && fetchedOidForCleanup !== undefined) {
            const rollback = await this.runGit(initial.canonical, [
              "update-ref", "-d", fetchedRef, fetchedOidForCleanup,
            ]);
            if (!succeeded(rollback)) cleanupErrors.push(new RuntimeError("fetched ref rollback failed"));
          } else if (fetchedCreated) {
            cleanupErrors.push(new RuntimeError("fetched ref identity unavailable for safe rollback"));
          }
          if (cleanupErrors.length > 0) {
            operationError = new AggregateError(
              [error, ...cleanupErrors],
              "workflow branch creation and cleanup failed",
            );
          } else {
            operationError = error;
          }
          throw operationError;
        }
      });
    } catch (error) {
      if (completedIdentity !== undefined) {
        logger.warn("checkout lock release failed after workflow branch creation", {
          event: "checkout-lock-release-failed",
          workflowId: completedIdentity.workflowId,
          reason: redact(String(error)),
        });
      } else {
        if (error instanceof RuntimeError
          && error.detail?.classification === "recovery-ambiguous") {
          fail("recovery-ambiguous", error.message);
        }
        if (operationError !== undefined) {
          throw error;
        }
        fail("checkout-locked");
      }
    }

    return completedIdentity!;
  }

  private async validateLocked(
    identity: WorkflowBranchIdentity,
    expectedHead: string,
    allowStagedBytes = false,
  ): Promise<BranchRevalidationResult> {
    if (!await this.readOwnership(identity)) return { ok: false, classification: "ownership-mismatch" };
    let checkout;
    let worktree;
    try {
      checkout = await this.platformServices.canonicalizePath(identity.checkoutPath);
      worktree = await this.platformServices.canonicalizePath(identity.worktreePath);
    } catch {
      return { ok: false, classification: "worktree-missing" };
    }
    if (checkout.gitCommonDir !== identity.gitCommonDir
      || worktree.gitCommonDir !== identity.gitCommonDir) {
      return { ok: false, classification: "repository-identity-changed" };
    }
    if (worktree.canonical !== identity.worktreePath) {
      return { ok: false, classification: "worktree-path-changed" };
    }

    let remoteIdentity: RemoteIdentity;
    try {
      remoteIdentity = await this.resolveRemote(identity.checkoutPath);
    } catch {
      return { ok: false, classification: "remote-identity-changed" };
    }
    if (remoteIdentity.url !== identity.remoteUrl || remoteIdentity.ownerRepo !== identity.ownerRepo) {
      return { ok: false, classification: "remote-identity-changed" };
    }

    const registered = await this.runGit(identity.checkoutPath, [
      "worktree", "list", "--porcelain", "-z",
    ]);
    if (!succeeded(registered)) return { ok: false, classification: "git-command-failed" };
    const registrations = await parseWorktreeRegistrations(registered.stdout);
    if (registrations === null) return { ok: false, classification: "git-command-failed" };
    const expectedRegistration = registrations.find(
      registration => registration.worktree === identity.worktreePath,
    );
    if (expectedRegistration === undefined) {
      return { ok: false, classification: "worktree-registration-changed" };
    }

    const symbolic = await this.runGit(identity.worktreePath, [
      "symbolic-ref", "--quiet", "--short", "HEAD",
    ]);
    if (!succeeded(symbolic) || symbolic.stdout.trim() !== identity.branch) {
      return { ok: false, classification: "branch-changed" };
    }
    if (expectedRegistration.branch !== identity.branchRef) {
      return { ok: false, classification: "worktree-registration-changed" };
    }
    const head = await this.runGit(identity.worktreePath, ["rev-parse", "--verify", "HEAD"]);
    if (!succeeded(head)) return { ok: false, classification: "git-command-failed" };
    if (head.stdout.trim() !== expectedHead) return { ok: false, classification: "head-changed" };

    const status = await this.runGit(identity.worktreePath, [
      "status", "--porcelain=v1", "--untracked-files=all", "--ignore-submodules=none",
    ]);
    if (!succeeded(status)) return { ok: false, classification: "git-command-failed" };
    if (!allowStagedBytes && status.stdout !== "") {
      return { ok: false, classification: "dirty-worktree" };
    }

    const inProgress = await checkInProgressOperation(identity.worktreePath, this.runGit);
    if (inProgress === "in-progress") return { ok: false, classification: "in-progress-operation" };
    if (inProgress === "scan-failed") {
      return { ok: false, classification: "in-progress-operation-scan-failed" };
    }

    const base = await this.runGit(identity.checkoutPath, ["rev-parse", "--verify", identity.baseRef]);
    if (!succeeded(base) || base.stdout.trim() !== identity.baseCommitOid) {
      return { ok: false, classification: "base-ref-changed" };
    }
    const remote = await this.remoteTransport.listHeads(identity.checkoutPath, identity.remoteUrl);
    if (!succeeded(remote)) return { ok: false, classification: "git-command-failed" };
    let remoteHeads: Map<string, string>;
    try {
      remoteHeads = parseRemoteHeads(remote.stdout);
    } catch {
      return { ok: false, classification: "git-command-failed" };
    }
    if (remoteHeads.get(identity.baseBranch) !== identity.baseCommitOid) {
      return { ok: false, classification: "remote-base-changed" };
    }
    return { ok: true };
  }

  async revalidate(
    identity: WorkflowBranchIdentity,
    expectedHead = identity.baseCommitOid,
  ): Promise<BranchRevalidationResult> {
    const safety = new PlatformSafety(this.platformServices as PlatformServices);
    try {
      return await safety.withCheckoutLease(identity.checkoutPath, async (lock) => {
        if (lock.repositoryIdentity !== identity.repositoryIdentity) {
          return { ok: false, classification: "repository-identity-changed" };
        }
        try {
          return await this.validateLocked(identity, expectedHead);
        } catch {
          return { ok: false, classification: "git-command-failed" };
        }
      }, {
        onReleaseError: (releaseError, result) => {
          logger.warn("checkout lock release failed after workflow branch revalidation", {
            event: "checkout-lock-release-failed",
            workflowId: identity.workflowId,
            reason: redact(String(releaseError)),
          });
          return result;
        },
      });
    } catch {
      return { ok: false, classification: "repository-identity-changed" };
    }
  }


  async revalidateUnderLock(
    identity: WorkflowBranchIdentity,
    expectedHead: string,
    borrowedCheckoutLock: CheckoutLock,
  ): Promise<BranchRevalidationResult> {
    if (!isOid(expectedHead)
      || borrowedCheckoutLock.repositoryIdentity !== identity.repositoryIdentity) {
      return { ok: false, classification: "repository-identity-changed" };
    }
    try {
      return await this.validateLocked(identity, expectedHead);
    } catch {
      return { ok: false, classification: "git-command-failed" };
    }
  }

  /**
   * Revalidate every durable repository and branch identity while preserving a
   * caller-proven staged candidate. The caller must prove the exact index,
   * worktree, and status bytes separately while retaining the same checkout
   * lease.
   */
  async revalidateForStagedPromotionUnderLock(
    identity: WorkflowBranchIdentity,
    expectedHead: string,
    borrowedCheckoutLock: CheckoutLock,
  ): Promise<BranchRevalidationResult> {
    if (!isOid(expectedHead)
      || borrowedCheckoutLock.repositoryIdentity !== identity.repositoryIdentity) {
      return { ok: false, classification: "repository-identity-changed" };
    }
    try {
      return await this.validateLocked(identity, expectedHead, true);
    } catch {
      return { ok: false, classification: "git-command-failed" };
    }
  }

  private async cleanupLocked(
    identity: WorkflowBranchIdentity,
    expectedHead: string,
    checkoutLease: CheckoutLock,
  ): Promise<BranchCleanupResult> {
    if (!await this.readOwnership(identity)) {
      return { ok: false, classification: "cleanup-failed" };
    }
    const checkout = await this.platformServices.canonicalizePath(identity.checkoutPath);
    if (checkout.gitCommonDir !== identity.gitCommonDir) {
      return { ok: false, classification: "cleanup-failed" };
    }
    const checkedBranch = await this.runGit(identity.checkoutPath, [
      "check-ref-format", "--branch", identity.branch,
    ]);
    const checkedBranchRef = await this.runGit(identity.checkoutPath, [
      "check-ref-format", identity.branchRef,
    ]);
    const checkedBaseRef = await this.runGit(identity.checkoutPath, [
      "check-ref-format", identity.baseRef,
    ]);
    if (!succeeded(checkedBranch) || !succeeded(checkedBranchRef) || !succeeded(checkedBaseRef)) {
      return { ok: false, classification: "cleanup-failed" };
    }

    const registered = await this.runGit(identity.checkoutPath, [
      "worktree", "list", "--porcelain", "-z",
    ]);
    if (!succeeded(registered)) return { ok: false, classification: "cleanup-failed" };
    const registrations = await parseWorktreeRegistrations(registered.stdout, true);
    if (registrations === null) return { ok: false, classification: "cleanup-failed" };
    const expectedRegistration = registrations.find(
      registration => registration.worktree === identity.worktreePath,
    );
    const registrationPresent = expectedRegistration !== undefined;
    let physicalWorktreeIdentity: ManagedWorktreeDirectoryIdentity | null;
    try {
      physicalWorktreeIdentity = await managedWorktreeDirectoryIdentity(identity.worktreePath);
    } catch {
      return { ok: false, classification: "cleanup-failed" };
    }
    const physicalWorktreePresent = physicalWorktreeIdentity !== null;

    if (registrationPresent) {
      if (expectedRegistration.branch !== identity.branchRef
        || expectedRegistration.head !== expectedHead) {
        return { ok: false, classification: "cleanup-failed" };
      }
      if (physicalWorktreePresent) {
        const worktree = await this.platformServices.canonicalizePath(identity.worktreePath);
        if (worktree.canonical !== identity.worktreePath
          || worktree.gitCommonDir !== identity.gitCommonDir) {
          return { ok: false, classification: "cleanup-failed" };
        }
        const actualGitDir = await this.runGit(identity.worktreePath, [
          "rev-parse", "--path-format=absolute", "--git-dir",
        ]);
        if (!succeeded(actualGitDir)
          || await realpath(gitPathOutput(
            actualGitDir.stdout,
            "workflow worktree Git directory",
          )) !== identity.worktreeGitDir) {
          return { ok: false, classification: "cleanup-failed" };
        }
        const symbolic = await this.runGit(identity.worktreePath, [
          "symbolic-ref", "--quiet", "--short", "HEAD",
        ]);
        const head = await this.runGit(identity.worktreePath, ["rev-parse", "--verify", "HEAD"]);
        if (!succeeded(symbolic)
          || symbolic.stdout.trim() !== identity.branch
          || !succeeded(head)
          || head.stdout.trim() !== expectedHead) {
          return { ok: false, classification: "cleanup-failed" };
        }
      }
    } else if (physicalWorktreePresent) {
      return { ok: false, classification: "cleanup-failed" };
    }

    const branchPresence = await this.runGit(identity.checkoutPath, [
      "show-ref", "--verify", "--quiet", identity.branchRef,
    ]);
    const basePresence = await this.runGit(identity.checkoutPath, [
      "show-ref", "--verify", "--quiet", identity.baseRef,
    ]);
    const refsPresent = branchPresence.exitCode === 0 && basePresence.exitCode === 0;
    const refsAbsent = branchPresence.exitCode === 1 && basePresence.exitCode === 1;
    if ((!refsPresent && !refsAbsent) || (refsAbsent && registrationPresent)) {
      return { ok: false, classification: "cleanup-failed" };
    }
    if (refsPresent) {
      const branch = await this.runGit(identity.checkoutPath, [
        "rev-parse", "--verify", identity.branchRef,
      ]);
      const base = await this.runGit(identity.checkoutPath, [
        "rev-parse", "--verify", identity.baseRef,
      ]);
      if (!succeeded(branch)
        || !succeeded(base)
        || branch.stdout.trim() !== expectedHead
        || base.stdout.trim() !== identity.baseCommitOid) {
        return { ok: false, classification: "cleanup-failed" };
      }
    }

    const manager = new WorktreeManager(
      identity.checkoutPath,
      `workflow-${createHash("sha256").update(identity.workflowId).digest("hex").slice(0, 32)}`,
      { os: this.platformServices.os },
      { ...this.worktreeManagerDependencies, borrowedCheckoutLease: checkoutLease },
    );
    if (registrationPresent) {
      if (physicalWorktreeIdentity !== null) {
        await manager.remove(identity.worktreePath, physicalWorktreeIdentity);
      } else {
        await removeStaleWorktreeRegistration(
          identity.checkoutPath,
          identity.worktreePath,
          identity.worktreeGitDir,
          identity.branchRef,
          this.worktreeManagerDependencies,
        );
      }
    }
    if (refsPresent) {
      const refs = await this.runGit(identity.checkoutPath, ["update-ref", "--stdin"], {
        stdin: [
          "start",
          `delete ${identity.branchRef} ${expectedHead}`,
          `delete ${identity.baseRef} ${identity.baseCommitOid}`,
          "prepare",
          "commit",
          "",
        ].join("\n"),
      });
      if (!succeeded(refs)) return { ok: false, classification: "cleanup-failed" };
    }
    await this.removeOwnership(this.ownershipPath(identity.workflowId));
    return {
      ok: true,
      worktreeRemoved: registrationPresent,
      refsRemoved: refsPresent,
    };
  }

  async cleanup(
    identity: WorkflowBranchIdentity,
    expectedHead = identity.baseCommitOid,
  ): Promise<BranchCleanupResult> {
    if (!isOid(expectedHead)
      || !isOid(identity.baseCommitOid)
      || !WORKFLOW_ID.test(identity.workflowId)
      || typeof identity.worktreeGitDir !== "string"
      || identity.branchRef !== `refs/heads/${identity.branch}`
      || identity.baseRef !== `refs/claude-architect/autopilot/${identity.workflowId}/base`) {
      return { ok: false, classification: "cleanup-failed" };
    }
    let result: BranchCleanupResult;
    const safety = new PlatformSafety(this.platformServices as PlatformServices);
    try {
      result = await safety.withCheckoutLease(identity.checkoutPath, async (lock) => {
        if (lock.repositoryIdentity !== identity.repositoryIdentity) {
          return { ok: false, classification: "cleanup-failed" };
        }
        return await this.cleanupLocked(identity, expectedHead, lock);
      }, {
        onReleaseError: (releaseError, res) => {
          logger.warn("checkout lock release failed after workflow branch cleanup", {
            event: "checkout-lock-release-failed",
            workflowId: identity.workflowId,
            reason: redact(String(releaseError)),
          });
          return res;
        },
      });
    } catch {
      return { ok: false, classification: "cleanup-failed" };
    }
    return result;

  }
}
