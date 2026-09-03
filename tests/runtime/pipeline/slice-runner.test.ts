import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ConsolidationResult } from '../../../src/pipeline/consolidator.js';
import type { VerificationReport } from '../../../src/pipeline/report-types.js';
import {
  SliceRunner,
  type PipelineSlice,
  type SliceAttempt,
  type SliceAttemptEvidence,
} from '../../../src/pipeline/slice-runner.js';
import { createRunContext } from '../../../src/pipeline/run-context.js';
import { ArtifactStore } from '../../../src/runtime/artifact-store.js';
import type { AttemptResult } from '../../../src/protocol/attempt-result.js';
import type { DelegationSpec } from '../../../src/protocol/delegation-spec.js';
import { getPlatformServices } from '../../../src/platform/select-platform.js';
import type { Slice } from '../../../src/protocol/delegation-spec.js';

function slice(objective: string): Slice {
  return {
    objective,
    context: '',
    writeAllowlist: [],
    forbiddenScope: [],
    successCriteria: [],
    verification: [],
  };
}

function verification(pass: boolean): VerificationReport {
  return {
    reportVersion: '1',
    pass,
    commandResults: [{ id: 'verify', exitCode: pass ? 0 : 1, ok: pass }],
    testsDeleted: 0,
    testsSkipped: 0,
    workspaceClean: true,
    scopeViolations: [],
  };
}

function attempt(candidateCommit: string, pass: boolean, hardBlocker = false): SliceAttempt {
  return {
    candidateCommit,
    verification: verification(pass),
    hardBlocker,
  };
}

function review(severity: 'blocker' | 'major' | 'minor'): ConsolidationResult {
  return {
    findings: [{
      id: 'F-001',
      severity,
      location: 'src/example.ts:1',
      claim: 'objective finding',
      evidence: 'review evidence',
      reproduction: 'inspect the candidate',
      requiredOutcome: 'correct the candidate',
      confidence: 1,
      reviewers: ['correctness'],
    }],
  };
}

function evidencedAttempt(candidateCommit: string, severity: 'major' | 'minor' = 'minor') {
  return {
    ...attempt(candidateCommit, true),
    perSliceReview: review(severity),
    roleLogRefs: ['logs/objective.log'],
  } satisfies SliceAttempt;
}

function mutateNestedEvidence(evidence: {
  verification: VerificationReport | null;
  perSliceReview?: ConsolidationResult | null;
}): void {
  if (evidence.verification === null || evidence.perSliceReview == null) {
    throw new Error('test requires complete objective evidence');
  }
  evidence.verification.pass = false;
  evidence.verification.commandResults[0]!.id = 'mutated';
  evidence.verification.commandResults.push({ id: 'injected', exitCode: 1, ok: false });
  evidence.verification.scopeViolations.push('mutated-scope');
  evidence.perSliceReview.findings[0]!.severity = 'blocker';
  evidence.perSliceReview.findings[0]!.reviewers.push('mutator');
}

function expectObjectiveEvidence(
  evidence: {
    verification: VerificationReport | null;
    perSliceReview?: ConsolidationResult | null;
  },
  severity: 'major' | 'minor' = 'minor',
): void {
  expect(evidence.verification).toEqual(verification(true));
  expect(evidence.perSliceReview).toEqual(review(severity));
}

// These drive the real `SliceRunner`, not a stand-in for it. A slice whose
// first attempt is supplied as `initialAttempt` is routed without launching a
// Producer or creating a worktree, which is what lets the routing and evidence-
// isolation rules be exercised here rather than through a whole pipeline.

const temporaryRoots: string[] = [];
let previousPluginData: string | undefined;

beforeEach(async () => {
  previousPluginData = process.env.CLAUDE_PLUGIN_DATA;
  const root = await mkdtemp(path.join(tmpdir(), 'ca-slice-runner-'));
  temporaryRoots.push(root);
  process.env.CLAUDE_PLUGIN_DATA = root;
});

afterEach(async () => {
  if (previousPluginData === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
  else process.env.CLAUDE_PLUGIN_DATA = previousPluginData;
  await Promise.all(temporaryRoots.splice(0).map(async root =>
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })));
});

const RUN_ID = 'slice-runner-unit';

function spec(): DelegationSpec {
  return {
    specVersion: '1',
    objective: 'slice runner unit',
    context: '',
    writeAllowlist: [],
    forbiddenScope: [],
    successCriteria: [],
    verification: [],
  } as unknown as DelegationSpec;
}

function runnerContext(): ReturnType<typeof createRunContext> {
  return createRunContext({
    runId: RUN_ID,
    checkoutPath: temporaryRoots.at(-1)!,
    spec: spec(),
    store: new ArtifactStore(RUN_ID),
    ps: getPlatformServices(),
  });
}

async function runOneSlice(args: {
  objective: string;
  initialAttempt: SliceAttempt;
  maxRounds?: number;
  onAttempt?: (evidence: SliceAttemptEvidence) => Promise<void>;
  onSlice?: (recorded: PipelineSlice) => Promise<void>;
}) {
  const runner = new SliceRunner({
    // A Producer must never be reachable from these cases: every one of them
    // is satisfied by the supplied initial attempt, so a launch would mean the
    // routing rule under test did not hold.
    roleRunner: async () => {
      throw new Error('SliceRunner launched a Producer for an already-attempted slice');
    },
  });
  return await runner.run({
    context: runnerContext(),
    slices: [slice(args.objective)],
    baselineCommit: 'start',
    attempt: { runId: RUN_ID, candidate: null } as unknown as AttemptResult,
    initialAttempt: args.initialAttempt,
    maxRounds: args.maxRounds ?? 0,
    ...(args.onAttempt === undefined ? {} : { onAttempt: args.onAttempt }),
    ...(args.onSlice === undefined ? {} : { onSlice: args.onSlice }),
  });
}

describe('SliceRunner evidence isolation', () => {
  it('snapshots the source attempt before onAttempt can mutate it', async () => {
    const sourceAttempt = evidencedAttempt('source-commit');

    const result = await runOneSlice({
      objective: 'source isolation',
      initialAttempt: sourceAttempt,
      onAttempt: async () => {
        sourceAttempt.candidateCommit = 'mutated-source-commit';
        sourceAttempt.hardBlocker = true;
        sourceAttempt.roleLogRefs.push('logs/mutated-source.log');
        mutateNestedEvidence(sourceAttempt);
      },
    });

    expect(result).toMatchObject({
      finalCandidateCommit: 'source-commit',
      haltedSliceIndex: null,
    });
    expect(result.slices[0]).toMatchObject({
      candidateCommit: 'source-commit',
      route: 'advance',
      reasons: [],
    });
    expectObjectiveEvidence(result.slices[0]!);
    expectObjectiveEvidence(result.slices[0]!.attempts[0]!);
  });

  it('isolates retained evidence from nested onAttempt mutations', async () => {
    const result = await runOneSlice({
      objective: 'attempt callback isolation',
      initialAttempt: evidencedAttempt('callback-commit'),
      onAttempt: async evidence => {
        evidence.candidateCommit = 'mutated-callback-commit';
        evidence.reasons.push('mutated callback reason');
        evidence.roleLogRefs.push('logs/mutated-callback.log');
        mutateNestedEvidence(evidence);
      },
    });

    expect(result.slices[0]).toMatchObject({
      candidateCommit: 'callback-commit',
      route: 'advance',
      reasons: [],
    });
    expectObjectiveEvidence(result.slices[0]!);
    expectObjectiveEvidence(result.slices[0]!.attempts[0]!);
  });

  it('isolates an advanced result from nested onSlice mutations', async () => {
    const result = await runOneSlice({
      objective: 'slice callback isolation',
      initialAttempt: evidencedAttempt('advanced-commit'),
      onSlice: async recorded => {
        recorded.candidateCommit = 'mutated-advanced-commit';
        recorded.reasons.push('mutated slice reason');
        recorded.attempts[0]!.candidateCommit = 'mutated-nested-commit';
        mutateNestedEvidence(recorded);
      },
    });

    expect(result).toMatchObject({
      finalCandidateCommit: 'advanced-commit',
      haltedSliceIndex: null,
    });
    expect(result.slices[0]).toMatchObject({
      candidateCommit: 'advanced-commit',
      route: 'advance',
      reasons: [],
    });
    expectObjectiveEvidence(result.slices[0]!);
    expect(result.slices[0]!.attempts[0]!.candidateCommit).toBe('advanced-commit');
  });

  it('isolates a halted result from nested onSlice mutations', async () => {
    const halting = attempt('halted-commit', false);

    const result = await runOneSlice({
      objective: 'halted callback isolation',
      initialAttempt: halting,
      onSlice: async recorded => {
        recorded.candidateCommit = 'mutated-halted-commit';
        recorded.reasons.push('mutated halt reason');
      },
    });

    expect(result.haltedSliceIndex).toBe(1);
    expect(result.slices[0]).toMatchObject({ candidateCommit: 'halted-commit' });
    expect(result.slices[0]!.reasons).not.toContain('mutated halt reason');
  });

  it('halts immediately on a hard blocker', async () => {
    const result = await runOneSlice({
      objective: 'hard blocker',
      initialAttempt: attempt('blocked-commit', true, true),
      maxRounds: 3,
    });

    expect(result.haltedSliceIndex).toBe(1);
    expect(result.slices[0]?.roundsUsed).toBe(0);
  });
});
