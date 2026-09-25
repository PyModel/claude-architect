import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildEnvironment,
  registerSensitiveEnvironment,
} from "../../src/runtime/environment-policy.js";
import {
  clearRegisteredSecrets,
  redact,
} from "../../src/runtime/redaction.js";

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  process.env = {
    ...ORIGINAL_ENV,
    HOME: "/host/home",
    PATH: "/host/bin",
    TASK10_ALLOWED: "adapter-value",
    TASK10_UNLISTED: "must-not-leak",
  };
  clearRegisteredSecrets();
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  clearRegisteredSecrets();
});

describe("buildEnvironment", () => {
  it("redacts every value handed to the Producer, whatever its name", () => {
    const result = buildEnvironment({
      os: "darwin",
      adapterAllowlist: [],
      specAdditions: { VENDOR_WEBHOOK: "hooks-x9Y8z7W6v5", CACHE_DIR: "/abs/cache/path" },
    });
    try {
      expect(redact("posting to hooks-x9Y8z7W6v5")).not.toContain("hooks-x9Y8z7W6v5");
      expect(redact("cache at /abs/cache/path")).toContain("/abs/cache/path");
    } finally {
      result.secretRegistration.dispose();
    }
  });

  it("refuses a spec that overrides a confinement input", () => {
    expect(() => buildEnvironment({
      os: "darwin",
      adapterAllowlist: [],
      specAdditions: { PATH: "/attacker/bin" },
    })).toThrow('delegation environment may not override "PATH"');
  });

  it("constructs a layered allowlisted environment with names-only provenance", () => {
    const result = buildEnvironment({
      os: "darwin",
      adapterAllowlist: ["TASK10_ALLOWED"],
      specAdditions: { TASK10_SPEC: "spec-value" },
    });

    expect(result.env.PATH).toBe("/host/bin");
    expect(result.env.TASK10_ALLOWED).toBe("adapter-value");
    expect(result.env.TASK10_SPEC).toBe("spec-value");
    expect(result.env.TASK10_UNLISTED).toBeUndefined();
    expect(result.env.CLAUDE_ARCHITECT_DELEGATED).toBe("1");

    expect(result.provenance).toEqual(expect.arrayContaining([
      { name: "PATH", source: "platform" },
      { name: "TASK10_ALLOWED", source: "adapter" },
      { name: "TASK10_SPEC", source: "spec" },
      { name: "CLAUDE_ARCHITECT_DELEGATED", source: "platform" },
    ]));
    expect(JSON.stringify(result.provenance)).not.toContain("adapter-value");
    expect(JSON.stringify(result.provenance)).not.toContain("spec-value");
  });

  it("applies adapter-supplied values without overriding host-provided allowlisted values", () => {
    process.env.TASK10_ALLOWED = "adapter-value";
    delete process.env.CODEX_HOME;
    const result = buildEnvironment({
      os: "darwin",
      adapterAllowlist: ["TASK10_ALLOWED", "CODEX_HOME"],
      adapterValues: { CODEX_HOME: "/hosthome/.codex", TASK10_ALLOWED: "must-not-win" },
    });

    expect(result.env.CODEX_HOME).toBe("/hosthome/.codex");
    expect(result.env.TASK10_ALLOWED).toBe("adapter-value");
    expect(result.provenance).toEqual(expect.arrayContaining([
      { name: "CODEX_HOME", source: "adapter" },
    ]));
  });

  it("merges platform, adapter, and spec layers in order and applies a temporary home", () => {
    process.env.HOME = "/adapter/home";

    const result = buildEnvironment({
      os: "linux",
      adapterAllowlist: ["HOME"],
      specAdditions: {
        HOME: "/spec/home",
        CLAUDE_ARCHITECT_DELEGATED: "0",
      },
      tempHome: "/temporary/home",
    });

    expect(result.env.HOME).toBe("/spec/home");
    expect(result.env.CLAUDE_ARCHITECT_DELEGATED).toBe("1");
    expect(result.provenance).toEqual(expect.arrayContaining([
      { name: "HOME", source: "spec" },
      { name: "CLAUDE_ARCHITECT_DELEGATED", source: "platform" },
    ]));
  });

  it("does not inherit host XDG configuration when using a temporary home", () => {
    process.env.XDG_CONFIG_HOME = "/host/config";
    process.env.XDG_CACHE_HOME = "/host/cache";
    process.env.XDG_DATA_HOME = "/host/data";
    process.env.XDG_STATE_HOME = "/host/state";

    const result = buildEnvironment({
      os: "darwin",
      adapterAllowlist: ["XDG_CONFIG_HOME"],
      tempHome: "/temporary/home",
    });

    expect(result.env.HOME).toBe("/temporary/home");
    expect(result.env.XDG_CONFIG_HOME).toBeUndefined();
    expect(result.env.XDG_CACHE_HOME).toBeUndefined();
    expect(result.env.XDG_DATA_HOME).toBeUndefined();
    expect(result.env.XDG_STATE_HOME).toBeUndefined();
  });

  it("normalizes Windows platform environment names", () => {
    process.env.PATH = "uppercase-path";
    process.env.Path = "canonical-path";

    const result = buildEnvironment({
      os: "win32",
      adapterAllowlist: [],
    });

    expect(result.env.Path).toBe("canonical-path");
    expect(result.env.PATH).toBeUndefined();
    expect(Object.keys(result.env).filter(name => name.toLowerCase() === "path")).toEqual(["Path"]);
    expect(result.provenance).toContainEqual({ name: "Path", source: "platform" });
  });

  it("applies Windows temporary home paths and the delegation marker", () => {
    const tempHome = "C:\\temporary\\home";

    const result = buildEnvironment({
      os: "win32",
      adapterAllowlist: [],
      tempHome,
    });

    expect(result.env.USERPROFILE).toBe(tempHome);
    expect(result.env.APPDATA).toBe(path.win32.join(tempHome, "AppData", "Roaming"));
    expect(result.env.LOCALAPPDATA).toBe(path.win32.join(tempHome, "AppData", "Local"));
    expect(result.env.CLAUDE_ARCHITECT_DELEGATED).toBe("1");
  });

  it.each([
    { additions: { "": "value" }, label: "an empty name" },
    { additions: { "SAFE=OVERRIDE": "value" }, label: "an equals sign in a name" },
    { additions: { "BAD\0NAME": "value" }, label: "a NUL byte in a name" },
    { additions: { SAFE: "bad\0value" }, label: "a NUL byte in a value" },
  ])("rejects $label", ({ additions }) => {
    expect(() => buildEnvironment({
      os: "darwin",
      adapterAllowlist: [],
      specAdditions: additions,
    })).toThrow(/invalid environment/);
  });

  it("registers sensitive host and constructed values with the redactor", () => {
    process.env.ENTERPRISE_CREDENTIAL = "host-secret-without-known-prefix";

    buildEnvironment({
      os: "darwin",
      adapterAllowlist: [],
      specAdditions: { CUSTOM_TOKEN: "spec-secret-without-known-prefix" },
    });

    const output = redact(
      "host-secret-without-known-prefix spec-secret-without-known-prefix",
    );
    expect(output).not.toContain("host-secret-without-known-prefix");
    expect(output).not.toContain("spec-secret-without-known-prefix");
  });

  it.each([
    "PGPASSWORD",
    "MYSQL_PWD",
    "REDISCLI_AUTH",
    "apiKey",
    "clientSecret",
    "GOOGLE_APPLICATION_CREDENTIALS",
    "DATABASE_URL",
    "DEPLOY_PAT",
  ])("registers the standard sensitive name %s", name => {
    const secret = `value-for-${name}`;

    const result = buildEnvironment({
      os: "darwin",
      adapterAllowlist: [],
      specAdditions: { [name]: secret },
    });

    expect(redact(secret)).toBe("[s]");
    result.secretRegistration.dispose();
  });

  it("releases attempt secrets without clearing another active registration", () => {
    const first = buildEnvironment({
      os: "darwin",
      adapterAllowlist: [],
      specAdditions: { API_TOKEN: "shared-attempt-secret" },
    });
    const second = buildEnvironment({
      os: "darwin",
      adapterAllowlist: [],
      specAdditions: { API_TOKEN: "shared-attempt-secret" },
    });

    first.secretRegistration.dispose();
    first.secretRegistration.dispose();
    expect(redact("shared-attempt-secret")).toBe("[s]");

    second.secretRegistration.dispose();
    expect(redact("shared-attempt-secret")).toBe("shared-attempt-secret");
  });
});

describe("registerSensitiveEnvironment", () => {
  it("registers sensitive verification-command environment values", () => {
    const registration = registerSensitiveEnvironment({
      ORDINARY: "visible-value",
      VERIFICATION_PASSWORD: "verification-secret-value",
    });

    const output = redact("visible-value verification-secret-value");
    expect(output).toContain("visible-value");
    expect(output).not.toContain("verification-secret-value");

    registration.dispose();
    expect(redact("verification-secret-value")).toBe("verification-secret-value");
  });
});
