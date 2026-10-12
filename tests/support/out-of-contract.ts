/**
 * For a test that deliberately feeds a value the types forbid (a spec with an
 * unsupported mode, say) to code that must still handle it. Naming the intent
 * at the call site keeps the one unchecked assertion here, not scattered.
 */
export function outOfContract<T>(value: unknown): T {
  return value as T;
}
