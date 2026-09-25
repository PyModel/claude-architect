import type {
  CapabilityReport,
  ProbeContext,
} from "./producer-adapter.js";
import {
  ProducerRegistry,
  registry,
} from "./producer-registry.js";
import { producerRuntime, type ProbeOptions } from "./producer-runtime.js";

export async function probeAll(
  ctx: ProbeContext,
  producerRegistry: ProducerRegistry = registry,
  options?: ProbeOptions,
): Promise<CapabilityReport[]> {
  return producerRuntime.probeAll(ctx, { fresh: true, ...options }, producerRegistry);
}
