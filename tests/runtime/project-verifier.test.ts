import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { freezeCandidate } from "../../src/git/candidate-tree.js";
import { git } from "../../src/git/git-exec.js";
import type {
  PlatformServices,
  SupervisedProcess,
} from "../../src/platform/platform-services.js";
import { getPlatformServices } from "../../src/platform/select-platform.js";
import type { CandidateArtifact } from "../../src/protocol/attempt-result.js";
import type { VerificationCommand } from "../../src/protocol/delegation-spec.js";
import { clearRegisteredSecrets, redact } from "../../src/runtime/redaction.js";
import { projectVerify, verificationConfinementBackend } from "../../src/verify/project-verifier.js";

interface Fixture {
  repoRoot: string;
  artifact: CandidateArtifact;
}

const temporaryPaths: string[] = [];
let previousPluginData: string | undefined;

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  temporaryPaths.push(directory);
  return directory;
}

async function runGit(cwd: string, args: string[]): Promise<string> {
  const result = await git(cwd, args);
  expect(result.exitCode, result.stderr).toBe(0);
  return result.stdout.trim();
}

async function frozenFixture(candidateLock?: string): Promise<Fixture> {
  const root = await temporaryDirectory("ca-project-verifier-");
  const repoRoot = join(root, "repo");
  const producerWorktree = join(root, "producer-worktree");
  await mkdir(repoRoot);
  await runGit(repoRoot, ["init", "-q"]);
  await writeFile(join(repoRoot, "a.txt"), "hello\n");
  await writeFile(join(repoRoot, ".gitignore"), "ignored-output/\nnode_modules/\n");
  await writeFile(join(repoRoot, "package-lock.json"), "{}\n");
  await runGit(repoRoot, ["add", "-A"]);
  await runGit(repoRoot, ["commit", "-q", "-m", "initial"]);
  await mkdir(join(repoRoot, "node_modules"));
  await writeFile(join(repoRoot, "node_modules", "sentinel"), "safe\n");
  const baseCommitOid = await runGit(repoRoot, ["rev-parse", "HEAD"]);
  await runGit(repoRoot, [
    "worktree",
    "add",
    "--detach",
    "-q",
    producerWorktree,
    baseCommitOid,
  ]);
  if (candidateLock !== undefined) {
    await writeFile(join(producerWorktree, "package-lock.json"), candidateLock);
  }
  await writeFile(join(producerWorktree, "a.txt"), "candidate\n");
  const frozen = await freezeCandidate({
    repoRoot,
    worktreePath: producerWorktree,
    baseCommitOid,
    runId: "project-verifier",
    writeAllowlist: ["a.txt", "package-lock.json"],
    forbiddenScope: [],
  });
  expect(frozen.ok).toBe(true);
  if (!frozen.ok) throw new Error(`freeze failed: ${frozen.reason}`);
  return { repoRoot, artifact: frozen.artifact };
}

function command(overrides: Partial<VerificationCommand> = {}): VerificationCommand {
  return {
    id: "pass",
    executable: process.execPath,
    args: ["-e", "process.exit(0)"],
    cwd: ".",
    timeoutMs: 5_000,
    network: "denied",
    expectedExitCodes: [0],
    ...overrides,
  };
}

beforeEach(async () => {
  clearRegisteredSecrets();
  previousPluginData = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = await temporaryDirectory("ca-project-verifier-state-");
});

afterEach(async () => {
  clearRegisteredSecrets();
  if (previousPluginData === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
  else process.env.CLAUDE_PLUGIN_DATA = previousPluginData;
  await Promise.all(temporaryPaths.splice(0).map(path => rm(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })));
});

describe("projectVerify", () => {
  it("derives its managed worktree name from the artifact run id", async () => {
    const fixture = await frozenFixture();

    const result = await projectVerify({
      repoRoot: fixture.repoRoot,
      artifact: fixture.artifact,
      commands: [command({ args: ["-e", "process.stdout.write(process.cwd())"] })],
    });

    expect(result.outputLogs[0]?.text).toMatch(/verify-project-verifier$/);
  });

  it("evaluates verificationId once to select its managed worktree name", async () => {
    const fixture = await frozenFixture();
    let calls = 0;

    const result = await projectVerify({
      repoRoot: fixture.repoRoot,
      artifact: fixture.artifact,
      commands: [command({ args: ["-e", "process.stdout.write(process.cwd())"] })],
      verificationId: () => {
        calls += 1;
        return "slice-2-attempt-0";
      },
    });

    expect(calls).toBe(1);
    expect(result.outputLogs[0]?.text).toMatch(/verify-slice-2-attempt-0$/);
  });

  it("records a passing Host-authorized command without mutation", async () => {
    const fixture = await frozenFixture();

    const result = await projectVerify({
      repoRoot: fixture.repoRoot,
      artifact: fixture.artifact,
      commands: [command()],
    });

    expect(result.mutated).toBe(false);
    expect(result.failures).toEqual([]);
    expect(result.commandOutcomes).toHaveLength(1);
    expect(result.commandOutcomes[0]).toMatchObject({
      id: "pass",
      executable: process.execPath,
      args: ["-e", "process.exit(0)"],
      exitCode: 0,
      timedOut: false,
    });
    expect(result.evidence.commands).toEqual([
      expect.objectContaining({
        id: "pass",
        confinement: verificationConfinementBackend(process.platform as never, process.arch)
          ?? "none",
        networkPolicy: "unenforced",
        requestedNetwork: "denied",
        skipped: false,
      }),
    ]);
    expect(["inherited", "skipped-cow-unsupported"]).toContain(result.evidence.dependencyLink);
    expect(result.commandOutcomes[0]).toMatchObject({
      stdoutRef: "logs/verification-0-stdout.log",
      stderrRef: "logs/verification-0-stderr.log",
    });
    // Resolve the reported paths: git forward-slashes them on Windows, so a
    // raw substring check against the state root can never fail there.
    const registered = (await runGit(fixture.repoRoot, ["worktree", "list", "--porcelain"]))
      .split(/\r?\n/u).filter(line => line.startsWith("worktree "))
      .map(line => resolve(line.slice("worktree ".length)));
    const stateRoot = resolve(process.env.CLAUDE_PLUGIN_DATA!);
    expect(registered.filter(entry =>
      entry === stateRoot || entry.startsWith(`${stateRoot}${sep}`))).toEqual([]);
  });

  it("records a skipped dependency link when the candidate changes the lockfile", async () => {
    const fixture = await frozenFixture('{"changed":true}\n');

    const result = await projectVerify({
      repoRoot: fixture.repoRoot,
      artifact: fixture.artifact,
      commands: [command()],
    });

    expect(result.failures).toEqual([]);
    expect(result.evidence.dependencyLink).toBe("skipped-lockfile-mismatch");
  });

  it("resolves and runs git by name", async () => {
    const fixture = await frozenFixture();

    const result = await projectVerify({
      repoRoot: fixture.repoRoot,
      artifact: fixture.artifact,
      commands: [command({ id: "git-version", executable: "git", args: ["--version"] })],
    });

    expect(result.failures).toEqual([]);
    expect(result.commandOutcomes[0]).toMatchObject({ id: "git-version", exitCode: 0 });
    expect(result.outputLogs[0]?.text).toContain("git version");
  });

  it("detects a verification command that mutates the materialized candidate", async () => {
    const fixture = await frozenFixture();

    const result = await projectVerify({
      repoRoot: fixture.repoRoot,
      artifact: fixture.artifact,
      commands: [command({
        id: "mutate",
        args: [
          "-e",
          "require('node:fs').writeFileSync('generated.txt', 'changed\\n')",
        ],
      })],
    });

    expect(result.mutated).toBe(true);
    expect(result.failures).toContain("verification-mutated");
  });

  it("detects a tracked mutation hidden by the skip-worktree index bit", async () => {
    const fixture = await frozenFixture();

    // Confinement blocks these writes outright; exercise detection where no
    // confinement backend exists.
    const result = await projectVerify({
      repoRoot: fixture.repoRoot,
      artifact: fixture.artifact,
      arch: "unconfined-test-arch",
      commands: [command({
        id: "hidden-mutation",
        args: [
          "-e",
          "require('node:child_process').execFileSync('git', ['update-index', '--skip-worktree', 'a.txt']); require('node:fs').writeFileSync('a.txt', 'hidden change\\n')",
        ],
      })],
    });

    expect(result.mutated).toBe(true);
    expect(result.failures).toContain("verification-mutated");
  });

  it("does not run later commands after verification mutates the candidate", async () => {
    const fixture = await frozenFixture();
    const marker = join(await temporaryDirectory("ca-project-verifier-marker-"), "marker.txt");

    const result = await projectVerify({
      repoRoot: fixture.repoRoot,
      artifact: fixture.artifact,
      commands: [
        command({
          id: "mutate-first",
          args: ["-e", "require('node:fs').writeFileSync('generated.txt', 'changed')"],
        }),
        command({
          id: "must-not-run",
          args: [
            "-e",
            `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`,
          ],
        }),
      ],
    });

    expect(result.mutated).toBe(true);
    expect(result.commandOutcomes.map(outcome => outcome.id)).toEqual(["mutate-first"]);
    await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("permits writes to ignored paths by default in the disposable materialization", async () => {
    const fixture = await frozenFixture();

    const result = await projectVerify({
      repoRoot: fixture.repoRoot,
      artifact: fixture.artifact,
      commands: [command({
        id: "ignored-mutation",
        args: [
          "-e",
          "require('node:fs').mkdirSync('ignored-output', { recursive: true }); require('node:fs').writeFileSync('ignored-output/result.txt', 'changed')",
        ],
      })],
    });

    expect(result.mutated).toBe(false);
    expect(result.failures).toEqual([]);
  });

  it("detects writes to ignored paths under strict allowedMutations:none", async () => {
    const fixture = await frozenFixture();

    const result = await projectVerify({
      repoRoot: fixture.repoRoot,
      artifact: fixture.artifact,
      commands: [command({
        id: "ignored-mutation-strict",
        allowedMutations: "none",
        args: [
          "-e",
          "require('node:fs').mkdirSync('ignored-output', { recursive: true }); require('node:fs').writeFileSync('ignored-output/result.txt', 'changed')",
        ],
      })],
    });

    expect(result.mutated).toBe(true);
    expect(result.failures).toContain("verification-mutated");
  });

  it("permits ignored-path writes when the command opts into ignored-paths mutations", async () => {
    const fixture = await frozenFixture();

    const result = await projectVerify({
      repoRoot: fixture.repoRoot,
      artifact: fixture.artifact,
      commands: [command({
        id: "dependency-install",
        allowedMutations: "ignored-paths",
        args: [
          "-e",
          "require('node:fs').mkdirSync('ignored-output', { recursive: true }); require('node:fs').writeFileSync('ignored-output/result.txt', 'changed')",
        ],
      })],
    });

    expect(result.mutated).toBe(false);
    expect(result.failures).toEqual([]);
  });

  it("still detects tracked and untracked mutations when ignored-paths are permitted", async () => {
    const fixture = await frozenFixture();

    const result = await projectVerify({
      repoRoot: fixture.repoRoot,
      artifact: fixture.artifact,
      commands: [command({
        id: "untracked-mutation",
        allowedMutations: "ignored-paths",
        args: [
          "-e",
          "require('node:fs').writeFileSync('stray-untracked.txt', 'changed')",
        ],
      })],
    });

    expect(result.mutated).toBe(true);
    expect(result.failures).toContain("verification-mutated");
  });

  it("detects a clean status after the verification command changes HEAD", async () => {
    const fixture = await frozenFixture();

    // Confinement blocks these writes outright; exercise detection where no
    // confinement backend exists.
    const result = await projectVerify({
      repoRoot: fixture.repoRoot,
      artifact: fixture.artifact,
      arch: "unconfined-test-arch",
      commands: [command({
        id: "move-head",
        executable: "git",
        args: ["reset", "--hard", fixture.artifact.baseCommitOid],
      })],
    });

    expect(result.mutated).toBe(true);
    expect(result.failures).toContain("verification-mutated");
  });

  it("records an unexpected exit code as a verification failure", async () => {
    const fixture = await frozenFixture();

    const result = await projectVerify({
      repoRoot: fixture.repoRoot,
      artifact: fixture.artifact,
      commands: [command({ id: "fail", args: ["-e", "process.exit(1)"] })],
    });

    expect(result.commandOutcomes[0]?.exitCode).toBe(1);
    expect(result.failures).toContain("command-failed:fail");
  });

  it("records an unavailable verification executable as a failed outcome", async () => {
    const fixture = await frozenFixture();
    const missing = join(tmpdir(), "claude-architect-missing-verifier");

    const result = await projectVerify({
      repoRoot: fixture.repoRoot,
      artifact: fixture.artifact,
      commands: [command({ id: "missing", executable: missing })],
    });

    expect(result.commandOutcomes[0]).toMatchObject({
      id: "missing",
      executable: missing,
      exitCode: null,
    });
    expect(result.failures).toContain("command-failed:missing");
    expect(result.outputLogs[1]?.text).toContain("executable is not accessible");
  });

  it("bounds a thrown executable-resolution diagnostic before returning it as a log", async () => {
    const fixture = await frozenFixture();
    const ps = Object.create(getPlatformServices()) as PlatformServices;
    ps.resolveExecutable = async () => {
      throw new Error("x".repeat(1_100_000));
    };

    const result = await projectVerify({
      repoRoot: fixture.repoRoot,
      artifact: fixture.artifact,
      commands: [command({ id: "huge-error", executable: "missing" })],
      ps,
    });

    expect(Buffer.byteLength(result.outputLogs[1]?.text ?? "")).toBeLessThanOrEqual(1_000_000);
    expect(result.evidence.commands[0]?.truncated?.stderr).toBe(true);
  });

  it("fails a timed-out command even when the process exits zero", async () => {
    const fixture = await frozenFixture();
    const selected = getPlatformServices();
    const ps = Object.create(selected) as PlatformServices;
    // Fake only the verify command: on Windows the ACL-validation helper also
    // routes through spawnSupervised and must run for real.
    ps.spawnSupervised = async (request): Promise<SupervisedProcess> => {
      if (request.executable.resolvedFrom === "plugin-native-filesystem-helper") {
        return selected.spawnSupervised(request);
      }
      return {
        pid: 4242,
        stdout: {} as NodeJS.ReadableStream,
        stderr: {} as NodeJS.ReadableStream,
        done: Promise.resolve({
          exitCode: 0,
          signal: null,
          timedOut: true,
          cancelled: false,
          stdout: "",
          stderr: "",
          truncated: { stdout: false, stderr: false },
        }),
      };
    };

    const result = await projectVerify({
      repoRoot: fixture.repoRoot,
      artifact: fixture.artifact,
      commands: [command({
        id: "timeout",
        timeoutMs: 100,
      })],
      ps,
    });

    // Process-supervisor tests own signal delivery and escalation. This unit
    // injects the exact ambiguous outcome deterministically so host load cannot
    // prevent a child from installing its signal handler before a 100ms timer.
    expect(result.commandOutcomes[0]).toMatchObject({ exitCode: 0, timedOut: true });
    expect(result.failures).toContain("command-failed:timeout");
  });

  it("rejects a command working directory outside the materialized candidate", async () => {
    const fixture = await frozenFixture();

    const result = await projectVerify({
      repoRoot: fixture.repoRoot,
      artifact: fixture.artifact,
      commands: [command({ id: "escape", cwd: ".." })],
    });

    expect(result.commandOutcomes).toEqual([]);
    expect(result.failures).toContain("invalid-command-cwd:escape");
  });

  it("rejects a candidate commit that does not materialize the verified tree", async () => {
    const fixture = await frozenFixture();

    const result = await projectVerify({
      repoRoot: fixture.repoRoot,
      artifact: {
        ...fixture.artifact,
        candidateCommitOid: fixture.artifact.baseCommitOid,
      },
      commands: [command()],
    });

    expect(result.commandOutcomes).toEqual([]);
    expect(result.failures).toEqual(["candidate-materialization-mismatch"]);
  });

  it("skips commands excluded by Host OS or architecture filters", async () => {
    const fixture = await frozenFixture();

    const result = await projectVerify({
      repoRoot: fixture.repoRoot,
      artifact: fixture.artifact,
      commands: [command({
        id: "other-platform",
        platform: { arch: ["not-this-architecture"] },
      })],
    });

    expect(result.commandOutcomes).toEqual([]);
    expect(result.failures).toEqual([]);
    expect(result.evidence.commands).toEqual([
      expect.objectContaining({
        id: "other-platform",
        skipped: true,
        skipReason: "platform-arch",
      }),
    ]);
  });

  it("redacts command-environment secrets before disposing their registration", async () => {
    const fixture = await frozenFixture();
    const secret = "verification-enterprise-secret";

    const result = await projectVerify({
      repoRoot: fixture.repoRoot,
      artifact: fixture.artifact,
      commands: [command({
        id: "secret-output",
        args: ["-e", "process.stdout.write(process.env.VERIFY_API_TOKEN ?? '')"],
        environment: { VERIFY_API_TOKEN: secret },
      })],
    });

    expect(result.outputLogs[0]?.text).toBe("[s]");
    expect(result.outputLogs.some(log => log.text.includes(secret))).toBe(false);
    expect(redact(secret)).toBe(secret);
  });
});

describe.runIf(verificationConfinementBackend(process.platform as never, process.arch) !== null)(
  "confined verification",
  () => {
    it("cannot write outside its worktree or read credential stores", async () => {
      const fixture = await frozenFixture();
      const outside = join(await temporaryDirectory("ca-verify-outside-"), "escaped.txt");
      const home = await temporaryDirectory("ca-verify-home-");
      await mkdir(join(home, ".ssh"));
      await writeFile(join(home, ".ssh", "id_ed25519"), "PRIVATE KEY\n");
      const previousHome = process.env.HOME;
      process.env.HOME = home;
      try {
        const result = await projectVerify({
          repoRoot: fixture.repoRoot,
          artifact: fixture.artifact,
          commands: [
            command({
              id: "escape",
              args: ["-e", `require('node:fs').writeFileSync(${JSON.stringify(outside)}, 'x')`],
            }),
            command({
              id: "steal",
              args: [
                "-e",
                `process.stdout.write(require('node:fs').readFileSync(${
                  JSON.stringify(join(home, ".ssh", "id_ed25519"))}, 'utf8'))`,
              ],
            }),
            command({
              id: "local-write",
              args: ["-e", "require('node:fs').writeFileSync(require('node:os').tmpdir() + '/ok', 'x')"],
            }),
          ],
        });

        expect(result.failures).toEqual(expect.arrayContaining([
          "command-failed:escape",
          "command-failed:steal",
        ]));
        expect(result.failures).not.toContain("command-failed:local-write");
        expect(result.outputLogs.map(log => log.text).join("")).not.toContain("PRIVATE KEY");
        await expect(access(outside)).rejects.toMatchObject({ code: "ENOENT" });
        expect(result.evidence.commands.every(entry => entry.confinement === "macos-seatbelt"))
          .toBe(true);
      } finally {
        if (previousHome === undefined) delete process.env.HOME;
        else process.env.HOME = previousHome;
      }
    });
  },
);

