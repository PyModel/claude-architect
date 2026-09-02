import { open } from "node:fs/promises";
import type { ResolvedExecutable, SupervisedExit } from "../platform/platform-services.js";
import { SANDBOX_BACKENDS } from "../platform/sandbox/backends.js";
import type { DelegationSpec } from "../protocol/delegation-spec.js";
import type { AdapterEvent, ProbeContext } from "./producer-adapter.js";
export {
  EDIT_ACTION_PREAMBLE,
  LINT_BEFORE_TYPECHECK_INSTRUCTION,
  renderList,
  renderProducerPrompt,
  type PromptRenderOptions,
  type PromptRenderInput,
} from "./prompt-renderer.js";

const PLAIN_TEXT_LIMIT = 8_000;


export function normalizePlainText(raw: {
  stdout: string;
  stderr: string;
  exit: SupervisedExit;
}): { events: AdapterEvent[]; producerSummary: string | null; ok: boolean } {
  if (raw.exit.truncated.stdout) {
    return {
      events: [{ kind: "error", text: "stdout-truncated" }],
      producerSummary: null,
      ok: false,
    };
  }
  if (raw.exit.exitCode !== 0) {
    return {
      events: [{ kind: "error", text: raw.stderr.slice(-PLAIN_TEXT_LIMIT) }],
      producerSummary: null,
      ok: false,
    };
  }

  const trimmed = raw.stdout.trim();
  const summary = trimmed.length > PLAIN_TEXT_LIMIT
    ? trimmed.slice(-PLAIN_TEXT_LIMIT)
    : trimmed;
  if (summary.length === 0) return { events: [], producerSummary: null, ok: false };
  return {
    events: [{ kind: "final", text: summary }],
    producerSummary: summary,
    ok: true,
  };
}

export async function normalizeNodeShim(
  executable: ResolvedExecutable,
): Promise<ResolvedExecutable> {
  if (executable.kind !== "native") return executable;
  let handle;
  try {
    handle = await open(executable.command, "r");
    const buffer = Buffer.alloc(256);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const firstLine = buffer.subarray(0, bytesRead).toString("utf8").split(/\r?\n/u, 1)[0] ?? "";
    if (!/^#![^\r\n]*\bnode(?:\s|$)/u.test(firstLine)) return executable;
    return {
      kind: "node-entrypoint",
      command: process.execPath,
      prefixArgs: [executable.command, ...executable.prefixArgs],
      resolvedFrom: `${executable.resolvedFrom};node:${process.execPath}`,
    };
  } catch {
    return executable;
  } finally {
    await handle?.close();
  }
}

export function selectOsWriteConfinementBackend(ctx: ProbeContext): string | null {
  const backend = SANDBOX_BACKENDS.find(candidate =>
    candidate.id === "macos-seatbelt"
    && candidate.platforms.some(platform =>
      platform.os === ctx.os
      && platform.environmentType === ctx.environmentType
      && (platform.arch === undefined || platform.arch === ctx.arch)
      && (platform.state === "certified" || platform.state === "tested")));
  return backend?.id ?? null;
}
