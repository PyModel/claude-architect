import { describe, expect, it } from "vitest";
import { CodexAdapter } from "../../src/producers/codex-adapter.js";

const exit = {
  exitCode: 0,
  signal: null,
  timedOut: false,
  cancelled: false,
  stdout: "",
  stderr: "",
  truncated: { stdout: false, stderr: false },
};

const eventLines = [
  JSON.stringify({
    type: "item.completed",
    item: { type: "file_change", path: "src/ünï cödé/α.ts" },
  }),
  JSON.stringify({
    type: "item.completed",
    item: { type: "agent_message", text: "complete" },
  }),
  JSON.stringify({ type: "turn.completed" }),
];

function normalize(stdout: string) {
  return new CodexAdapter().normalizeEvents({ stdout, stderr: "", exit });
}

describe("CodexAdapter CRLF event streams", () => {
  it("parses CRLF and LF streams into identical Unicode-bearing events", () => {
    const lf = normalize(`${eventLines.join("\n")}\n`);
    const crlf = normalize(`${eventLines.join("\r\n")}\r\n`);

    expect(crlf).toEqual(lf);
    expect(crlf.events[0]?.raw).toMatchObject({
      item: { path: "src/ünï cödé/α.ts" },
    });
  });

  it("parses mixed line endings without phantom events", () => {
    const mixed = normalize(`${eventLines[0]}\r\n${eventLines[1]}\n${eventLines[2]}\r\n`);

    expect(mixed.ok).toBe(true);
    expect(mixed.events).toHaveLength(2);
    expect(mixed.events.map(event => event.kind)).toEqual(["tool", "final"]);
  });
});
