import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { ProducerDescriptor } from "./producer-adapter.js";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function stringProperty(value: unknown, name: string): string | undefined {
  if (!isRecord(value)) return undefined;
  const property = value[name];
  return typeof property === "string" ? property : undefined;
}

export interface HostStoreContext {
  env: Record<string, string | undefined>;
  homeDirectory: string;
  hasAuthStore?: (directory: string) => boolean;
  hasOauthAccount?: (accountFile: string) => boolean;
  hasConfigDir?: (directory: string) => boolean;
}

export interface HostStateDescriptor {
  resolveStore: (ctx: HostStoreContext) => string;
  authMarker?: string | ((store: string, ctx: HostStoreContext) => boolean);
  inheritedWritablePaths?: (store: string, ctx: HostStoreContext) => string[];
  defaultEnv?: (store: string, ctx: HostStoreContext) => Record<string, string>;
  apiKeyEnv?: string[];
}

export function defaultHasOauthAccount(accountFile: string): boolean {
  if (!existsSync(accountFile)) return false;
  try {
    const parsed: unknown = JSON.parse(readFileSync(accountFile, "utf8"));
    return isRecord(parsed) && isRecord(parsed.oauthAccount);
  } catch {
    return false;
  }
}

export function resolveHostStoreRoot(
  descriptor: ProducerDescriptor,
  ctx: HostStoreContext,
): string | null {
  return descriptor.hostState ? descriptor.hostState.resolveStore(ctx) : null;
}

export function isProducerAuthenticated(
  descriptor: ProducerDescriptor,
  ctx: HostStoreContext,
): boolean {
  const hostState = descriptor.hostState;
  if (!hostState) return false;

  if (hostState.apiKeyEnv !== undefined) {
    for (const key of hostState.apiKeyEnv) {
      const val = ctx.env[key];
      if (val !== undefined && val.length > 0) return true;
    }
  }

  const store = hostState.resolveStore(ctx);

  if (typeof hostState.authMarker === "function") {
    return hostState.authMarker(store, ctx);
  }

  if (typeof hostState.authMarker === "string") {
    const checker = ctx.hasAuthStore ?? (dir => existsSync(join(dir, hostState.authMarker as string)));
    return checker(store);
  }

  return false;
}

export function resolveInheritedWritablePaths(
  descriptor: ProducerDescriptor,
  ctx: HostStoreContext,
): string[] {
  const hostState = descriptor.hostState;
  if (!hostState?.inheritedWritablePaths) return [];
  const store = hostState.resolveStore(ctx);
  return hostState.inheritedWritablePaths(store, ctx);
}

export function resolveDefaultEnv(
  descriptor: ProducerDescriptor,
  ctx: HostStoreContext,
): Record<string, string> {
  const hostState = descriptor.hostState;
  if (!hostState?.defaultEnv) return {};
  const store = hostState.resolveStore(ctx);
  return hostState.defaultEnv(store, ctx);
}

export function resolveConfigRevision(
  descriptor: ProducerDescriptor,
  ctx: HostStoreContext,
): string {
  const hostState = descriptor.hostState;
  if (!hostState) return "";
  try {
    const store = hostState.resolveStore(ctx);
    const parts: string[] = [];
    if (existsSync(store)) {
      parts.push(`store:${statSync(store).mtimeMs}`);
    }
    if (typeof hostState.authMarker === "string") {
      const markerPath = join(store, hostState.authMarker);
      if (existsSync(markerPath)) {
        parts.push(`marker:${statSync(markerPath).mtimeMs}`);
      }
    }
    if (hostState.apiKeyEnv) {
      for (const envKey of hostState.apiKeyEnv) {
        const val = ctx.env[envKey];
        if (val !== undefined && val.length > 0) parts.push(`${envKey}:${val}`);
      }
    }
    return parts.join(";");
  } catch {
    return "";
  }
}
