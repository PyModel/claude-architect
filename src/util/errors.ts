export class RuntimeError extends Error {
  constructor(message: string, readonly detail?: Record<string, unknown>) { super(message); this.name = "RuntimeError"; }
}
export class NestedDelegationError extends RuntimeError {   // CLAUDE_ARCHITECT_DELEGATED already set
  constructor() { super("nested delegation denied"); this.name = "NestedDelegationError"; }
}

/** The errno-style `code` a thrown value carries, if any. */
export function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

export function isMissing(error: unknown): boolean {
  return errorCode(error) === "ENOENT";
}
