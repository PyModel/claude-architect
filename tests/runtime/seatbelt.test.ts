import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ProducerInvocation } from "../../src/producers/producer-adapter.js";
import {
  buildReadOnlySeatbeltPolicy,
  buildSeatbeltProfile,
  wrapInvocationWithSeatbelt,
} from "../../src/platform/sandbox/seatbelt.js";

const invocation: ProducerInvocation = {
  executable: {
    kind: "native",
    command: "/usr/local/bin/opencode",
    prefixArgs: [],
    resolvedFrom: "path:/usr/local/bin/opencode",
  },
  args: ["run", "--dir", "/tmp/wt"],
  requiredEnv: [],
  network: "denied",
};

describe("seatbelt profile", () => {
  it("denies writes by default and allowlists worktree, temp home, and TMPDIR", () => {
    const profile = buildSeatbeltProfile({
      worktreePath: "/tmp/wt",
      tempHome: "/tmp/home",
      allowNetwork: false,
    });
    expect(profile).toContain("(deny file-write*)");
    expect(profile).toContain('(subpath "/tmp/wt")');
    expect(profile).toContain('(subpath "/tmp/home")');
    expect(profile).toContain("(deny network*)");
  });

  it.skipIf(process.platform !== "darwin")(
    "includes both raw and canonical writable paths",
    () => {
      const rawPath = mkdtempSync(join(tmpdir(), "claude-architect-seatbelt-path-"));

      try {
        const canonicalPath = realpathSync(rawPath);
        expect(canonicalPath).not.toBe(rawPath);

        const profile = buildSeatbeltProfile({
          worktreePath: rawPath,
          tempHome: null,
          allowNetwork: false,
        });
        expect(profile.split(`(subpath "${rawPath}")`)).toHaveLength(2);
        expect(profile.split(`(subpath "${canonicalPath}")`)).toHaveLength(2);
      } finally {
        rmSync(rawPath, { recursive: true, force: true });
      }
    },
  );

  it("falls back to the raw writable path when realpath fails", () => {
    const root = mkdtempSync(join(tmpdir(), "claude-architect-seatbelt-missing-"));
    const missingPath = join(root, "missing");

    try {
      expect(() => realpathSync(missingPath)).toThrow();

      const profile = buildSeatbeltProfile({
        worktreePath: missingPath,
        tempHome: null,
        allowNetwork: false,
      });
      // Mirror sbPath's escaping: win32 tmpdir paths contain backslashes.
      const escaped = missingPath.replace(/\\/gu, "\\\\").replace(/"/gu, '\\"');
      expect(profile.split(`(subpath "${escaped}")`)).toHaveLength(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("grants exactly the Producer's declared inherited-state paths without a temp home", () => {
    const wrapped = wrapInvocationWithSeatbelt({
      ...invocation,
      inheritedStateWritablePaths: ["/Users/test/.pi/agent", "/Users/test/.local/state/opencode"],
    }, {
      worktreePath: "/tmp/wt",
      tempHome: null,
      allowNetwork: false,
    });
    const profile = wrapped.args[1] ?? "";

    expect(profile).toContain('(subpath "/Users/test/.pi/agent")');
    expect(profile).toContain('(subpath "/Users/test/.local/state/opencode")');
    expect(profile).not.toContain('(subpath "/Users/test/.pi")');
    expect(profile).not.toContain('(subpath "/Users/test/.local/state")');
    expect(profile).not.toContain('(subpath "/Users/test")');
  });

  it("rejects invalid declared paths (root, relative, or not under home/state root) and emits no grants", () => {
    const rootWrapped = wrapInvocationWithSeatbelt({
      ...invocation,
      inheritedStateWritablePaths: ["/"],
    }, {
      worktreePath: "/tmp/wt",
      tempHome: null,
      allowNetwork: false,
    });
    expect(rootWrapped.args[1]).not.toContain('(subpath "/")');

    const relWrapped = wrapInvocationWithSeatbelt({
      ...invocation,
      inheritedStateWritablePaths: ["relative/path"],
    }, {
      worktreePath: "/tmp/wt",
      tempHome: null,
      allowNetwork: false,
    });
    expect(relWrapped.args[1]).not.toContain("relative/path");

    const mixedWrapped = wrapInvocationWithSeatbelt({
      ...invocation,
      inheritedStateWritablePaths: ["/Users/test/.pi/agent", "/"],
    }, {
      worktreePath: "/tmp/wt",
      tempHome: null,
      allowNetwork: false,
    });
    expect(mixedWrapped.args[1]).not.toContain('(subpath "/Users/test/.pi/agent")');

    const escapeWrapped = wrapInvocationWithSeatbelt({
      ...invocation,
      inheritedStateWritablePaths: ["/etc/passwd"],
    }, {
      worktreePath: "/tmp/wt",
      tempHome: null,
      allowNetwork: false,
    });
    expect(escapeWrapped.args[1]).not.toContain("/etc/passwd");
  });

  it("ignores declared inherited-state paths when a temp home replaces the real one", () => {
    const wrapped = wrapInvocationWithSeatbelt({
      ...invocation,
      inheritedStateWritablePaths: ["/Users/test/.pi/agent"],
    }, {
      worktreePath: "/tmp/wt",
      tempHome: "/tmp/home",
      allowNetwork: false,
    });
    const profile = wrapped.args[1] ?? "";

    expect(profile).toContain('(subpath "/tmp/home")');
    expect(profile).not.toContain('(subpath "/Users/test/.pi/agent")');
  });

  it("never derives writable state from executable identity or required env names", () => {
    // Earlier revisions sniffed `basename(command)` and `requiredEnv` to guess a
    // Producer's config directory; an adapter that forgot to be recognized ran
    // with zero host-state access. Only the explicit declaration counts now.
    const wrapped = wrapInvocationWithSeatbelt({
      ...invocation,
      executable: {
        kind: "native",
        command: "/usr/local/bin/agy",
        prefixArgs: [],
        resolvedFrom: "path:/usr/local/bin/agy",
      },
      requiredEnv: ["PI_API_KEY", "OPENCODE_CONFIG_DIR", "GEMINI_API_KEY"],
      env: { HOME: "/Users/test" },
    }, {
      worktreePath: "/tmp/wt",
      tempHome: null,
      allowNetwork: false,
    });
    const profile = wrapped.args[1] ?? "";

    expect(profile).not.toContain("/Users/test");
  });

  it("escapes quotes and rejects control characters in paths", () => {
    expect(() => buildSeatbeltProfile({
      worktreePath: "/tmp/a\nb",
      tempHome: null,
      allowNetwork: false,
    })).toThrow();
    const profile = buildSeatbeltProfile({
      worktreePath: '/tmp/a"b',
      tempHome: null,
      allowNetwork: true,
    });
    expect(profile).toContain('\\"');
    expect(profile).not.toContain("(deny network*)");
  });

  it("wraps the invocation as sandbox-exec -p <profile> -- cmd args", () => {
    const wrapped = wrapInvocationWithSeatbelt(invocation, {
      worktreePath: "/tmp/wt",
      tempHome: null,
      allowNetwork: false,
    });
    expect(wrapped.executable.command).toBe("/usr/bin/sandbox-exec");
    expect(wrapped.args[0]).toBe("-p");
    expect(wrapped.args.slice(2)).toEqual([
      "/usr/local/bin/opencode",
      "run",
      "--dir",
      "/tmp/wt",
    ]);
    expect(wrapped.network).toBe("denied");
    expect(wrapped.stdin).toBe(invocation.stdin);
  });

  it("preserves node-entrypoint prefix args inside the wrapped argv", () => {
    const wrapped = wrapInvocationWithSeatbelt(
      {
        ...invocation,
        executable: {
          kind: "node-entrypoint",
          command: process.execPath,
          prefixArgs: ["/x/cli.js"],
          resolvedFrom: "npm-entry:/x/cli.js",
        },
      },
      { worktreePath: "/tmp/wt", tempHome: null, allowNetwork: false },
    );
    expect(wrapped.args.slice(2)).toEqual([
      process.execPath,
      "/x/cli.js",
      "run",
      "--dir",
      "/tmp/wt",
    ]);
  });
});

describe("buildReadOnlySeatbeltPolicy", () => {
  it("grants no write access to the worktree", () => {
    const policy = buildReadOnlySeatbeltPolicy({ tempHome: "/tmp/role-home" });
    const profile = buildSeatbeltProfile(policy);
    expect(profile).toContain("(deny file-write*)");
    expect(profile).toContain('(subpath "/tmp/role-home")');
    expect(profile).not.toContain("worktrees");
  });

  it("allows network so role model sessions can reach the provider API", () => {
    const profile = buildSeatbeltProfile(buildReadOnlySeatbeltPolicy({ tempHome: null }));
    expect(profile).not.toContain("(deny network*)");
  });

  it("works with no temp home at all", () => {
    const profile = buildSeatbeltProfile(buildReadOnlySeatbeltPolicy({ tempHome: null }));
    expect(profile).toContain("(deny file-write*)");
  });
});
