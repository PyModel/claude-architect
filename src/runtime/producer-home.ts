import { randomBytes } from "node:crypto";
import { lstat, mkdir, readdir, readFile, realpath, rm, rmdir } from "node:fs/promises";
import path from "node:path";
import nodeProcess from "node:process";
import {
  emptyBoundDirectory,
  removeBoundEmptyDirectory,
  verifyBoundDirectoryCleanupSupport,
} from "../platform/bound-directory-cleanup.js";
import {
  ensurePrivateDirectory,
  flushDirectory,
  sameDirectoryIdentity,
  type DirectoryIdentity,
} from "../platform/durable-directory.js";
import {
  DurableDirectorySession,
  moveDirectory,
  writeAtomic,
} from "../platform/durable-write.js";
import { lockOwnerStatus } from "../platform/lock-ownership.js";
import type { PlatformServices } from "../platform/platform-services.js";
import { getPlatformServices } from "../platform/select-platform.js";
import { RuntimeError, errorCode, isMissing } from "../util/errors.js";
import { boundedRedactedDiagnostic } from "./redaction.js";
import { resolveStateDir } from "./state-dir.js";

/**
 * Runtime-owned Producer HOMEs (ADR-0001). Each allocation is a private
 * directory `<state>/h/<id>` bound to its birth-time identity and to one
 * durable claim `<state>/h/<id>.claim` that names the processes owning it.
 * Retirement never deletes by pathname: it renames the identity-matched
 * directory to `<state>/h/.q-<id>` and removes it with the bound cleanup
 * primitives. Anything else is preserved and reported.
 */

const ROOT_NAME = "h";
const HOME_ID = /^[0-9a-f]{8}$/u;
const CLAIM_SUFFIX = ".claim";
const QUARANTINE_PREFIX = ".q-";
const CLAIM_VERSION = 1;
const MAX_CLAIM_BYTES = 16_384;
const MAX_CLAIM_PRODUCERS = 16;
const MAX_DIAGNOSTIC_BYTES = 2_000;
const DECIMAL = /^(0|[1-9][0-9]{0,19})$/u;
const CONFLICT = "producer-home-conflict";

type ClaimPhase = "held" | "launching" | "quarantined";

interface ClaimProcess {
  pid: number;
  processToken: string | null;
}

interface HomeClaim {
  claimVersion: typeof CLAIM_VERSION;
  homeId: string;
  identity: DirectoryIdentity;
  owner: { pid: number; processToken: string };
  producers: ClaimProcess[];
  phase: ClaimPhase;
  createdAt: string;
}

export interface ProducerHomeRetirement {
  ok: boolean;
  /** The allocation was replaced or removed by someone other than the runtime. */
  conflict: boolean;
  /** Bounded and redacted; never a path. */
  diagnostic: string | null;
}

export interface ProducerHomeIssue {
  path: string;
  error: unknown;
}

/** The private root every runtime-owned Producer HOME lives under. */
export function producerHomeRoot(stateDir: string = resolveStateDir()): string {
  return path.join(stateDir, ROOT_NAME);
}

function conflict(message: string): RuntimeError {
  return new RuntimeError(message, { classification: CONFLICT });
}

function isConflict(error: unknown): boolean {
  return error instanceof RuntimeError && error.detail?.classification === CONFLICT;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function validPid(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 1;
}

function validToken(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256;
}

function serializeClaim(claim: HomeClaim): string {
  return `${JSON.stringify({
    claimVersion: claim.claimVersion,
    homeId: claim.homeId,
    identity: {
      dev: claim.identity.dev.toString(),
      ino: claim.identity.ino.toString(),
      birthtimeNs: claim.identity.birthtimeNs.toString(),
    },
    owner: claim.owner,
    producers: claim.producers,
    phase: claim.phase,
    createdAt: claim.createdAt,
  })}\n`;
}

/** Strict: any unknown, missing, or out-of-range field rejects the claim. */
function parseClaim(text: string, homeId: string): HomeClaim {
  const invalid = () => new RuntimeError("Producer HOME claim is malformed");
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw invalid();
  }
  if (!isRecord(value) || !hasExactKeys(value, [
    "claimVersion", "homeId", "identity", "owner", "producers", "phase", "createdAt",
  ])) throw invalid();
  const { identity, owner, producers, phase, createdAt } = value;
  if (value.claimVersion !== CLAIM_VERSION) {
    throw new RuntimeError("Producer HOME claim has an unsupported version");
  }
  if (value.homeId !== homeId) throw invalid();
  if (!isRecord(identity) || !hasExactKeys(identity, ["dev", "ino", "birthtimeNs"])) throw invalid();
  for (const field of [identity.dev, identity.ino, identity.birthtimeNs]) {
    if (typeof field !== "string" || !DECIMAL.test(field)) throw invalid();
  }
  const parsedIdentity: DirectoryIdentity = {
    dev: BigInt(identity.dev as string),
    ino: BigInt(identity.ino as string),
    birthtimeNs: BigInt(identity.birthtimeNs as string),
  };
  if (parsedIdentity.birthtimeNs <= 0n) throw invalid();
  if (!isRecord(owner) || !hasExactKeys(owner, ["pid", "processToken"])
    || !validPid(owner.pid) || !validToken(owner.processToken)) throw invalid();
  if (!Array.isArray(producers) || producers.length > MAX_CLAIM_PRODUCERS) throw invalid();
  const parsedProducers: ClaimProcess[] = producers.map(entry => {
    if (!isRecord(entry) || !hasExactKeys(entry, ["pid", "processToken"])
      || !validPid(entry.pid)
      || !(entry.processToken === null || validToken(entry.processToken))) throw invalid();
    return { pid: entry.pid, processToken: entry.processToken };
  });
  if (phase !== "held" && phase !== "launching" && phase !== "quarantined") throw invalid();
  if (typeof createdAt !== "string" || !Number.isFinite(Date.parse(createdAt))) throw invalid();
  return {
    claimVersion: CLAIM_VERSION,
    homeId,
    identity: parsedIdentity,
    owner: { pid: owner.pid, processToken: owner.processToken },
    producers: parsedProducers,
    phase,
    createdAt,
  };
}

async function lstatOrNull(target: string) {
  try {
    return await lstat(target, { bigint: true });
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

function isPlainDirectoryWithIdentity(
  metadata: Awaited<ReturnType<typeof lstatOrNull>>,
  identity: DirectoryIdentity,
): boolean {
  return metadata !== null
    && metadata.isDirectory()
    && !metadata.isSymbolicLink()
    && sameDirectoryIdentity(metadata, identity);
}

function caseFolded(value: string): string {
  return nodeProcess.platform === "win32" ? value.toLowerCase() : value;
}

function contains(parent: string, child: string): boolean {
  const relative = path.relative(caseFolded(parent), caseFolded(child));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function canonical(target: string): Promise<string> {
  try {
    return await realpath(target);
  } catch {
    return path.resolve(target);
  }
}

/**
 * Refuse a HOME root that a Producer could write through another grant: the
 * worktree, linked-worktree Git roots, or object directories. Either
 * containing the other is unsafe.
 */
export async function assertOutsideProducerWriteScope(
  root: string,
  writeScope: readonly string[],
): Promise<void> {
  const canonicalRoot = await canonical(root);
  for (const entry of writeScope) {
    if (entry.length === 0) continue;
    const scope = await canonical(entry);
    if (contains(scope, canonicalRoot) || contains(canonicalRoot, scope)) {
      throw new RuntimeError(
        "the Producer HOME root overlaps the Producer's writable scope; place the plugin data directory outside the repository and its worktrees",
        { classification: "unsafe-state-directory" },
      );
    }
  }
}

interface RootHandle {
  directory: string;
  identity: DirectoryIdentity;
}

async function ensureRoot(): Promise<RootHandle> {
  const stateDir = resolveStateDir();
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  const root = producerHomeRoot(stateDir);
  const identity = await ensurePrivateDirectory(root, { description: "Producer HOME root" });
  const directory = await realpath(root);
  const settled = await lstat(directory, { bigint: true });
  if (!isPlainDirectoryWithIdentity(settled, identity)) {
    throw new RuntimeError("Producer HOME root identity changed during validation");
  }
  return { directory, identity };
}

function rootSession(root: RootHandle): DurableDirectorySession {
  // Hot path: flushDirectory never spawns the Windows directory helper.
  return new DurableDirectorySession(root.directory, root.identity, { syncDirectory: flushDirectory });
}

async function writeClaim(root: RootHandle, claim: HomeClaim, create: boolean): Promise<void> {
  await writeAtomic(
    rootSession(root),
    `${claim.homeId}${CLAIM_SUFFIX}`,
    serializeClaim(claim),
    create ? "immutable" : "replace",
  );
}

async function removeClaim(root: RootHandle, homeId: string): Promise<void> {
  await rootSession(root).assertIdentity();
  await rm(path.join(root.directory, `${homeId}${CLAIM_SUFFIX}`));
  await flushDirectory(root.directory);
}

/**
 * Quarantine and remove the claimed allocation. Throws a conflict when the
 * directory at the allocation name is not the claimed one; touches nothing in
 * that case.
 */
async function retireClaimed(
  root: RootHandle,
  claim: HomeClaim,
  ps: PlatformServices,
): Promise<void> {
  const quarantineName = `${QUARANTINE_PREFIX}${claim.homeId}`;
  const quarantinePath = path.join(root.directory, quarantineName);
  // Nothing moves unless the bound removal can finish.
  await verifyBoundDirectoryCleanupSupport(ps);
  if (claim.phase !== "quarantined") {
    const allocated = await lstatOrNull(path.join(root.directory, claim.homeId));
    if (isPlainDirectoryWithIdentity(allocated, claim.identity)) {
      try {
        await moveDirectory(rootSession(root), claim.homeId, quarantineName, claim.identity);
      } catch (error) {
        if (error instanceof RuntimeError
          && error.detail?.classification === "directory-identity-changed") {
          throw conflict("the Producer HOME changed identity at retirement");
        }
        throw error;
      }
    } else if (!isPlainDirectoryWithIdentity(await lstatOrNull(quarantinePath), claim.identity)) {
      // Neither name holds the allocation: it was replaced or moved away by
      // someone other than the runtime. Preserve whatever is there.
      throw conflict(allocated === null
        ? "the Producer HOME was moved away before retirement"
        : "the Producer HOME was replaced before retirement");
    }
    await writeClaim(root, { ...claim, phase: "quarantined" }, false);
  }
  const quarantined = await lstatOrNull(quarantinePath);
  if (quarantined !== null) {
    if (!isPlainDirectoryWithIdentity(quarantined, claim.identity)) {
      throw conflict("the quarantined Producer HOME changed identity");
    }
    await emptyBoundDirectory(quarantinePath, claim.identity, ps);
    await removeBoundEmptyDirectory(quarantinePath, claim.identity, ps);
  }
  await removeClaim(root, claim.homeId);
}

function retirementFailure(error: unknown): ProducerHomeRetirement {
  return {
    ok: false,
    conflict: isConflict(error),
    diagnostic: `Producer HOME preserved: ${boundedRedactedDiagnostic(error, MAX_DIAGNOSTIC_BYTES)}`,
  };
}

/** One runtime-allocated HOME and its claim. Only its allocating process uses it. */
export class ProducerHomeLease {
  private claim: HomeClaim;
  private retirement: Promise<ProducerHomeRetirement> | undefined;

  constructor(
    private readonly root: RootHandle,
    claim: HomeClaim,
  ) {
    this.claim = claim;
  }

  get path(): string {
    return path.join(this.root.directory, this.claim.homeId);
  }

  get rootDirectory(): string {
    return this.root.directory;
  }

  private async update(next: HomeClaim): Promise<void> {
    if (this.retirement !== undefined) throw new RuntimeError("Producer HOME is already retired");
    await writeClaim(this.root, next, false);
    this.claim = next;
  }

  /** Persist that a spawn is about to happen, so a crash before its record is never reclaimed blindly. */
  async beforeSpawn(): Promise<void> {
    await this.update({ ...this.claim, phase: "launching" });
  }

  async recordProducer(pid: number, processToken: string | null): Promise<void> {
    if (this.claim.producers.length >= MAX_CLAIM_PRODUCERS) {
      throw new RuntimeError("Producer HOME claim records too many processes");
    }
    await this.update({
      ...this.claim,
      phase: "held",
      producers: [...this.claim.producers, { pid, processToken }],
    });
  }

  /**
   * Retire after the Producer process tree has settled. Never throws and never
   * deletes by pathname; a failure preserves the allocation and its claim.
   * Cleanup runs on the host platform: it is the runtime's own filesystem
   * work, not a Producer operation.
   */
  retire(ps: PlatformServices = getPlatformServices()): Promise<ProducerHomeRetirement> {
    this.retirement ??= retireClaimed(this.root, this.claim, ps).then(
      () => ({ ok: true, conflict: false, diagnostic: null }),
      retirementFailure,
    );
    return this.retirement;
  }
}

let ownProcessToken: Promise<string | null> | undefined;

/** `writeAtomic`'s temporary for a claim: `.<id>.claim.<uuid>.tmp`. */
const CLAIM_TEMPORARY = /^\.[0-9a-f]{8}\.claim\.[0-9a-f-]{36}\.tmp$/u;
/** Far longer than any claim write; younger temporaries may still be in use. */
const CLAIM_TEMPORARY_STALE_MS = 10 * 60 * 1000;

/** Remove a crashed claim write's temporary: only a stale plain single-link file. */
async function removeStaleClaimTemporary(target: string): Promise<void> {
  const metadata = await lstatOrNull(target);
  if (metadata === null) return;
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1n) {
    throw new RuntimeError("a Producer HOME claim temporary is not a plain file");
  }
  if (Date.now() - Number(metadata.mtimeMs) < CLAIM_TEMPORARY_STALE_MS) return;
  await rm(target);
}

/**
 * Allocate a private HOME under the state directory, capture its identity and
 * record its claim before any adapter sees the path.
 */
export async function allocateProducerHome(args: {
  writeScope: readonly string[];
  /** The runtime's own start token; probed once per process by default. */
  processToken?: () => Promise<string | null>;
}): Promise<ProducerHomeLease> {
  const ownerToken = args.processToken !== undefined
    ? await args.processToken().catch(() => null)
    : await (ownProcessToken ??= getPlatformServices().getProcessStartToken(nodeProcess.pid))
      .catch(() => null);
  if (ownerToken === null) {
    if (args.processToken === undefined) ownProcessToken = undefined;
    throw new RuntimeError("the runtime process identity is unavailable; a Producer HOME cannot be claimed");
  }
  const root = await ensureRoot();
  await assertOutsideProducerWriteScope(root.directory, args.writeScope);
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const homeId = randomBytes(4).toString("hex");
    const homePath = path.join(root.directory, homeId);
    try {
      await mkdir(homePath, { mode: 0o700 });
    } catch (error) {
      if (errorCode(error) === "EEXIST") continue;
      throw error;
    }
    try {
      const identity = await ensurePrivateDirectory(homePath, {
        description: "Producer HOME",
        create: false,
      });
      const claim: HomeClaim = {
        claimVersion: CLAIM_VERSION,
        homeId,
        identity,
        owner: { pid: nodeProcess.pid, processToken: ownerToken },
        producers: [],
        phase: "held",
        createdAt: new Date().toISOString(),
      };
      await writeClaim(root, claim, true);
      return new ProducerHomeLease(root, claim);
    } catch (error) {
      // Never exposed to a Producer: the empty directory this call created is
      // still the runtime's own, so removing it by name cannot hit a stranger.
      await rmdir(homePath).catch(() => undefined);
      throw error;
    }
  }
  throw new RuntimeError("a unique Producer HOME name could not be allocated");
}

/**
 * Startup recovery: reclaim allocations whose every recorded owner is proven
 * dead. A live owner's allocation is preserved silently; unverifiable owners
 * and malformed, conflicting, unclaimed, or interrupted-launch allocations are
 * preserved and reported. Callers hold the recovery lock.
 */
export async function recoverProducerHomes(args: {
  stateRoot: string;
  ps: PlatformServices;
  isProcessAlive: (pid: number) => boolean;
}): Promise<ProducerHomeIssue[]> {
  const rootPath = producerHomeRoot(args.stateRoot);
  if (await lstatOrNull(rootPath) === null) return [];
  const issues: ProducerHomeIssue[] = [];
  let root: RootHandle;
  try {
    const identity = await ensurePrivateDirectory(rootPath, {
      description: "Producer HOME root",
      create: false,
    });
    root = { directory: await realpath(rootPath), identity };
  } catch (error) {
    return [{ path: rootPath, error }];
  }
  const entries = await readdir(root.directory, { withFileTypes: true });
  const claimed = new Set<string>();
  for (const entry of entries) {
    if (!entry.name.endsWith(CLAIM_SUFFIX)) continue;
    const homeId = entry.name.slice(0, -CLAIM_SUFFIX.length);
    if (!HOME_ID.test(homeId)) continue;
    claimed.add(homeId);
    const claimPath = path.join(root.directory, entry.name);
    try {
      if (!entry.isFile() || entry.isSymbolicLink()) {
        throw new RuntimeError("Producer HOME claim is not a plain file");
      }
      const metadata = await lstat(claimPath, { bigint: true });
      if (metadata.size > BigInt(MAX_CLAIM_BYTES)) throw new RuntimeError("Producer HOME claim is oversized");
      const claim = parseClaim(await readFile(claimPath, "utf8"), homeId);
      const status = (process: ClaimProcess) => lockOwnerStatus(
        process,
        args.isProcessAlive,
        pid => args.ps.getProcessStartToken(pid),
      ).catch(() => "unverifiable" as const);
      const ownerStatus = await status(claim.owner);
      // A live owner is an allocation in use: preserved without a report, as
      // run recovery treats a live run.
      if (ownerStatus === "live") continue;
      const statuses = new Set<string>([ownerStatus]);
      for (const producer of claim.producers) statuses.add(await status(producer));
      if (statuses.has("live")) {
        throw new RuntimeError("an orphaned Producer outlived its dead owner and may still use its HOME");
      }
      if (statuses.has("unverifiable")) {
        throw new RuntimeError(
          "a recorded Producer HOME owner is running but its identity cannot be verified",
        );
      }
      if (claim.phase === "launching") {
        throw new RuntimeError(
          "the Producer HOME owner exited between a spawn and its record; a child may still use it",
        );
      }
      await retireClaimed(root, claim, args.ps);
    } catch (error) {
      issues.push({ path: path.join(root.directory, homeId), error });
    }
  }
  for (const entry of entries) {
    const entryPath = path.join(root.directory, entry.name);
    if (CLAIM_TEMPORARY.test(entry.name)) {
      try {
        await removeStaleClaimTemporary(entryPath);
      } catch (error) {
        issues.push({ path: entryPath, error });
      }
      continue;
    }
    const homeId = entry.name.startsWith(QUARANTINE_PREFIX)
      ? entry.name.slice(QUARANTINE_PREFIX.length)
      : entry.name;
    if (!HOME_ID.test(homeId) || claimed.has(homeId)) continue;
    // A concurrent owner may have finished claiming or removing it mid-scan.
    if (await lstatOrNull(entryPath) === null) continue;
    if (await lstatOrNull(path.join(root.directory, `${homeId}${CLAIM_SUFFIX}`)) !== null) continue;
    issues.push({
      path: entryPath,
      error: new RuntimeError("a Producer HOME without an ownership claim was preserved"),
    });
  }
  return issues;
}
