import { AgyAdapter } from "./agy-adapter.js";
import { ClaudeAdapter } from "./claude-adapter.js";
import { CodexAdapter } from "./codex-adapter.js";
import { OpenCodeAdapter } from "./opencode-adapter.js";
import { PiAdapter } from "./pi-adapter.js";
import type { ProducerAdapter } from "./producer-adapter.js";
import { PythinkerAdapter } from "./pythinker-adapter.js";

export class ProducerRegistry {
  private readonly adapters: ProducerAdapter[];

  constructor(adapters: readonly ProducerAdapter[]) {
    this.adapters = [...adapters];
  }

  get(id: string): ProducerAdapter | undefined {
    return this.adapters.find(adapter => adapter.producerId === id);
  }

  all(): ProducerAdapter[] {
    return [...this.adapters];
  }
}

export const registry = new ProducerRegistry([new CodexAdapter(), new OpenCodeAdapter(), new PiAdapter(), new PythinkerAdapter(), new AgyAdapter(), new ClaudeAdapter()]);
