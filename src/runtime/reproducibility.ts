import { readFile } from "node:fs/promises";
import { git, type GitResult } from "../git/git-exec.js";
import { RUNTIME_VERSION } from "../protocol/versions.js";
import { RuntimeError, errorCode } from "../util/errors.js";
import { redact } from "./redaction.js";
import type {
  PackagedVerifierInput,
  RepositoryInstructionInput,
} from "./run-manifest.js";

const REPOSITORY_INSTRUCTION_PATHS = ["AGENTS.md", "CLAUDE.md"] as const;

export interface ReproducibilityInputs {
  repositoryInstructions: RepositoryInstructionInput[];
  packagedVerifier: PackagedVerifierInput;
}

export interface ReproducibilityCollectorDependencies {
  git?: typeof git;
  readModule?: (url: URL) => Promise<Buffer>;
  verifierModuleUrls?: readonly URL[];
}

function gitFailure(action: string, result: GitResult): RuntimeError {
  const diagnostic = redact(result.stderr || result.stdout).trim().slice(0, 2_000);
  return new RuntimeError(`${action} failed${diagnostic ? `: ${diagnostic}` : ""}`);
}

function assertCompleteGitOutput(action: string, result: GitResult): void {
  if (result.exitCode !== 0) throw gitFailure(action, result);
  if (result.truncated?.stdout === true) {
    throw new RuntimeError(`${action} output exceeded the runtime limit`);
  }
}

async function collectRepositoryInstructions(
  repoRoot: string,
  baseCommitOid: string,
  runGit: typeof git,
): Promise<RepositoryInstructionInput[]> {
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(baseCommitOid)) {
    throw new RuntimeError("reproducibility base commit oid is invalid");
  }

  const tree = await runGit(repoRoot, [
    "ls-tree",
    "--full-tree",
    "-z",
    baseCommitOid,
    "--",
    ...REPOSITORY_INSTRUCTION_PATHS,
  ]);
  assertCompleteGitOutput("collect repository instruction paths", tree);

  const presentPaths: string[] = [];
  for (const record of tree.stdout.split("\0")) {
    if (record.length === 0) continue;
    const separator = record.indexOf("\t");
    const metadata = separator === -1 ? "" : record.slice(0, separator);
    const instructionPath = separator === -1 ? "" : record.slice(separator + 1);
    if (!/^\d{6} blob [0-9a-f]+$/.test(metadata)
      || !REPOSITORY_INSTRUCTION_PATHS.includes(
        instructionPath as (typeof REPOSITORY_INSTRUCTION_PATHS)[number],
      )) {
      throw new RuntimeError("repository instruction tree entry is invalid");
    }
    presentPaths.push(instructionPath);
  }

  const instructions: RepositoryInstructionInput[] = [];
  for (const instructionPath of presentPaths) {
    const blob = await runGit(repoRoot, ["show", `${baseCommitOid}:${instructionPath}`]);
    assertCompleteGitOutput(`collect repository instruction ${instructionPath}`, blob);
    instructions.push({ path: instructionPath, content: blob.stdout });
  }
  return instructions;
}

function defaultVerifierModuleUrls(): URL[] {
  return [
    new URL("../verify/acceptance-verifier.js", import.meta.url),
    new URL("../verify/acceptance-verifier.ts", import.meta.url),
    new URL(import.meta.url),
  ];
}

function isMissingModule(error: unknown): boolean {
  const code = errorCode(error);
  return code === "ENOENT" || code === "ENOTDIR";
}

async function collectPackagedVerifier(
  dependencies: ReproducibilityCollectorDependencies,
): Promise<PackagedVerifierInput> {
  const readModule = dependencies.readModule ?? (url => readFile(url));
  const candidates = dependencies.verifierModuleUrls ?? defaultVerifierModuleUrls();
  let lastMissingError: unknown;
  for (const candidate of candidates) {
    let bytes: Buffer;
    try {
      bytes = await readModule(candidate);
    } catch (error) {
      if (!isMissingModule(error)) {
        throw new RuntimeError("packaged verifier module could not be read");
      }
      lastMissingError = error;
      continue;
    }
    if (bytes.length === 0) {
      throw new RuntimeError("packaged verifier module is empty");
    }
    return { version: RUNTIME_VERSION, content: bytes.toString("utf8") };
  }
  throw new RuntimeError("packaged verifier module could not be resolved", {
    cause: lastMissingError instanceof Error ? lastMissingError.message : "no module candidates",
  });
}

export async function collectReproducibilityInputs(
  repoRoot: string,
  baseCommitOid: string,
  dependencies: ReproducibilityCollectorDependencies = {},
): Promise<ReproducibilityInputs> {
  const [repositoryInstructions, packagedVerifier] = await Promise.all([
    collectRepositoryInstructions(repoRoot, baseCommitOid, dependencies.git ?? git),
    collectPackagedVerifier(dependencies),
  ]);
  return { repositoryInstructions, packagedVerifier };
}
