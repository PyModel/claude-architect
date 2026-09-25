import type { CheckoutLock, PlatformServices } from "../platform/platform-services.js";
import type { CandidateArtifact, CommandOutcome } from "../protocol/attempt-result.js";
import type { DelegationSpec } from "../protocol/delegation-spec.js";
import type { ArtifactStore } from "../runtime/artifact-store.js";
import { RuntimeError } from "../util/errors.js";
import {
  projectVerify,
  type ProjectVerifyArgs,
  type ProjectCommandEvidence,
  type ProjectVerifyResult,
} from "./project-verifier.js";
import {
  structuralVerify,
  type StructuralVerifyArgs,
  type StructuralVerifyResult,
  type VerificationMode,
} from "./structural-verifier.js";

export interface AcceptanceVerifyArgs {
  mode?: VerificationMode;
  repoRoot: string;
  worktreePath: string;
  baseCommitOid: string;
  artifact: CandidateArtifact;
  spec: DelegationSpec;
  ps: PlatformServices;
  artifactStore: Pick<ArtifactStore, "writeLog">;
  verificationId?: () => string;
  logNamePrefix?: string;
  borrowedCheckoutLease?: CheckoutLock;
}

export interface AcceptanceVerifyResult {
  ok: boolean;
  failures: string[];
  evidence: Record<string, unknown>;
  commandOutcomes: CommandOutcome[];
}

export interface AcceptanceVerifierDependencies {
  mode?: VerificationMode;
  structural?: (args: StructuralVerifyArgs, mode?: VerificationMode) => Promise<StructuralVerifyResult>;
  project?: (args: ProjectVerifyArgs) => Promise<ProjectVerifyResult>;
}

function expectedLogRefs(project: ProjectVerifyResult): Set<string> {
  const refs = project.commandOutcomes.flatMap(outcome => [outcome.stdoutRef, outcome.stderrRef]);
  const unique = new Set(refs);
  if (unique.size !== refs.length) {
    throw new RuntimeError("project verification returned duplicate command log references");
  }
  return unique;
}

async function archiveProjectLogs(
  project: ProjectVerifyResult,
  store: Pick<ArtifactStore, "writeLog">,
): Promise<void> {
  const expected = expectedLogRefs(project);
  const predicted = project.outputLogs.map(log => `logs/${log.name}.log`);
  if (new Set(predicted).size !== predicted.length
    || predicted.length !== expected.size
    || predicted.some(ref => !expected.has(ref))) {
    throw new RuntimeError("project verification log references do not match command outcomes");
  }

  for (let index = 0; index < project.outputLogs.length; index += 1) {
    const log = project.outputLogs[index]!;
    const archivedRef = await store.writeLog(log.name, log.text);
    if (archivedRef !== predicted[index]) {
      throw new RuntimeError("artifact store returned an unexpected verification log reference");
    }
  }
}

function cloneCommandEvidence(command: ProjectCommandEvidence): ProjectCommandEvidence {
  return {
    ...command,
    ...(command.truncated === undefined ? {} : { truncated: { ...command.truncated } }),
  };
}

function outcomesMatchHostCommands(
  commands: DelegationSpec["verification"],
  outcomes: CommandOutcome[],
  evidence: ProjectVerifyResult["evidence"]["commands"],
  os: PlatformServices["os"],
  arch: string,
): boolean {
  const byId = new Map(commands.map(command => [command.id, command]));
  if (byId.size !== commands.length) return false;
  const byOutcomeId = new Map(outcomes.map(outcome => [outcome.id, outcome]));
  const byEvidenceId = new Map(evidence.map(command => [command.id, command]));
  if (byOutcomeId.size !== outcomes.length
    || byEvidenceId.size !== evidence.length
    || evidence.length !== commands.length
    || outcomes.some(outcome => !byId.has(outcome.id))
    || evidence.some(command => !byId.has(command.id))) return false;

  return commands.every(command => {
    const commandEvidence = byEvidenceId.get(command.id);
    if (commandEvidence === undefined) return false;
    const skipReason = command.platform?.os !== undefined && !command.platform.os.includes(os)
      ? "platform-os"
      : command.platform?.arch !== undefined && !command.platform.arch.includes(arch)
        ? "platform-arch"
        : null;
    const outcome = byOutcomeId.get(command.id);
    if (skipReason !== null) {
      return commandEvidence.skipped
        && commandEvidence.skipReason === skipReason
        && outcome === undefined;
    }
    // Correspondence only: the command was not skipped, and it produced exactly
    // one outcome that actually reported a result. Whether that result was the
    // *expected* exit code is a pass/fail judgement, not a correspondence one,
    // and `command-failed:<id>` already carries it. Testing `expectedExitCodes`
    // here made every ordinary verification failure also claim the outcomes did
    // not match the declared commands — a trust-boundary accusation — which
    // masked the real signal and would have hidden a genuine mismatch.
    return !commandEvidence.skipped
      && outcome !== undefined
      && outcome.exitCode !== null
      && !outcome.timedOut;
  });
}

export class AcceptanceVerifier {
  private readonly mode: VerificationMode;
  private readonly structural: ((args: StructuralVerifyArgs, mode?: VerificationMode) => Promise<StructuralVerifyResult>) | undefined;
  private readonly project: (args: ProjectVerifyArgs) => Promise<ProjectVerifyResult>;

  constructor(dependencies: AcceptanceVerifierDependencies = {}) {
    this.mode = dependencies.mode ?? "candidate";
    this.structural = dependencies.structural;
    this.project = dependencies.project ?? projectVerify;
  }

  async verify(args: AcceptanceVerifyArgs): Promise<AcceptanceVerifyResult> {
    const effectiveMode = args.mode ?? this.mode;
    const structuralArgs: StructuralVerifyArgs = {
      repoRoot: args.repoRoot,
      worktreePath: args.worktreePath,
      baseCommitOid: args.baseCommitOid,
      artifact: args.artifact,
      writeAllowlist: args.spec.writeAllowlist,
      forbiddenScope: args.spec.forbiddenScope,
    };
    const structural = this.structural !== undefined
      ? await this.structural(structuralArgs, effectiveMode)
      : await structuralVerify(structuralArgs, effectiveMode);
    const structuralEvidence = {
      manifestHash: structural.manifestHash,
      failures: [...structural.failures],
    };
    if (!structural.ok) {
      return {
        ok: false,
        failures: [...structural.failures],
        evidence: { structural: structuralEvidence },
        commandOutcomes: [],
      };
    }

    const project = await this.project({
      repoRoot: args.repoRoot,
      artifact: args.artifact,
      commands: args.spec.verification,
      ps: args.ps,
      ...(args.borrowedCheckoutLease === undefined
        ? {}
        : { borrowedCheckoutLease: args.borrowedCheckoutLease }),
      ...(args.verificationId === undefined ? {} : { verificationId: args.verificationId }),
      ...(args.logNamePrefix === undefined ? {} : { logNamePrefix: args.logNamePrefix }),
    });
    await archiveProjectLogs(project, args.artifactStore);

    const failures = [...project.failures];
    if (project.mutated && !failures.includes("verification-mutated")) {
      failures.push("verification-mutated");
    }
    if (project.commandOutcomes.length === 0 && failures.length === 0) {
      failures.push("empty-verification");
    }
    if (!outcomesMatchHostCommands(
      args.spec.verification,
      project.commandOutcomes,
      project.evidence.commands,
      args.ps.os,
      process.arch,
    )
      && !failures.includes("command-outcome-mismatch")) {
      failures.push("command-outcome-mismatch");
    }
    const verificationPolicy = project.evidence.commands.map(cloneCommandEvidence);

    return {
      ok: failures.length === 0,
      failures,
      evidence: {
        structural: structuralEvidence,
        project: {
          mutated: project.mutated,
          failures: [...project.failures],
          commands: verificationPolicy.map(cloneCommandEvidence),
          dependencyLink: project.evidence.dependencyLink,
        },
        verificationPolicy,
      },
      commandOutcomes: project.commandOutcomes.map(outcome => ({
        ...outcome,
        args: [...outcome.args],
      })),
    };
  }
}
