import type { WorkflowJournalJson } from "../../src/autopilot/workflow-store.js";

/**
 * Journal completions are JSON by contract. Tests pass typed domain objects
 * (an `AutopilotSpec`, a branch identity), which interfaces cannot express as
 * `WorkflowJournalJson`; a JSON round trip is the honest conversion and
 * mirrors what the journal does when it persists the value.
 */
export function asJournalJson(value: unknown): WorkflowJournalJson {
  return JSON.parse(JSON.stringify(value));
}

/**
 * A fake archive serves one fixed document through a reader whose result type
 * the caller picks (`readPipelineArtifact<T>`). The fake cannot know `T`, so
 * the document is read back through JSON, which is how a real archive yields
 * it, instead of asserting a type over the fixture.
 */
export function readBackAs<T>(value: unknown): T {
  return JSON.parse(JSON.stringify(value));
}
