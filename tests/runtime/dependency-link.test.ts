import { access, lstat, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  linkPrimaryDependencies,
  probeCowSupport,
} from "../../src/verify/dependency-link.js";

const temporaryPaths: string[] = [];

async function fixture(): Promise<{ primary: string; worktree: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "ca-dependency-link-"));
  temporaryPaths.push(root);
  const primary = path.join(root, "primary");
  const worktree = path.join(root, "worktree");
  await mkdir(path.join(primary, "node_modules"), { recursive: true });
  await mkdir(worktree);
  await writeFile(path.join(primary, "node_modules", "sentinel"), "safe\n");
  return { primary, worktree };
}

afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map(candidate =>
    rm(candidate, { recursive: true, force: true })));
});

describe("probeCowSupport", () => {
  it.skipIf(process.platform !== "darwin" && process.platform !== "linux")(
    "reports whether the host supports the platform CoW strategy",
    async () => {
      const result = await probeCowSupport();
      const strategy = process.platform === "darwin" ? "clonefile" : "reflink";
      if (!result.cowSupported) {
        expect(result).toEqual({ cowSupported: false, strategy });
        return;
      }
      expect(result).toEqual({ cowSupported: true, strategy });
    },
  );

  // The probe resolves the host's system `cp` by absolute path before cloning.
  it.skipIf(process.platform !== "darwin" && process.platform !== "linux")(
    "reports a forced clone failure and removes the probe directory", async () => {
    let probeRoot: string | undefined;

    await expect(probeCowSupport({
      platform: "linux",
      execFile: async (file, args) => {
        expect(["/bin/cp", "/usr/bin/cp"]).toContain(file);
        expect(args.slice(0, 2)).toEqual(["-a", "--reflink=always"]);
        probeRoot = path.dirname(args.at(-1)!);
        throw new Error("forced cp failure");
      },
    })).resolves.toEqual({ cowSupported: false, strategy: "reflink" });

    expect(probeRoot).toBeDefined();
    await expect(access(probeRoot!)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reports unsupported without invoking cp on Windows", async () => {
    let invoked = false;

    await expect(probeCowSupport({
      platform: "win32",
      execFile: async () => {
        invoked = true;
        throw new Error("must not run");
      },
    })).resolves.toEqual({ cowSupported: false, strategy: "unsupported" });
    expect(invoked).toBe(false);
  });
});

describe("linkPrimaryDependencies", () => {
  it.skipIf(process.platform !== "darwin" && process.platform !== "linux")(
    "clones node_modules privately when package locks match",
    async () => {
      const paths = await fixture();
      await writeFile(path.join(paths.primary, "package-lock.json"), "{}\n");
      await writeFile(path.join(paths.worktree, "package-lock.json"), "{}\n");

      const link = await linkPrimaryDependencies(paths.primary, paths.worktree);
      // CI Linux runners use ext4 (no reflink); the fail-closed skip is the correct outcome there.
      if (link === "skipped-cow-unsupported") return;
      expect(link).toBe("inherited");
      const worktreeModules = path.join(paths.worktree, "node_modules");
      expect((await lstat(worktreeModules)).isDirectory()).toBe(true);
      expect((await lstat(worktreeModules)).isSymbolicLink()).toBe(false);

      await writeFile(path.join(worktreeModules, "private-write"), "worktree only\n");
      await expect(access(path.join(paths.primary, "node_modules", "private-write")))
        .rejects.toMatchObject({ code: "ENOENT" });
      await expect(access(path.join(paths.primary, "node_modules", "sentinel")))
        .resolves.toBeUndefined();
    },
  );

  it("skips the link when package locks differ", async () => {
    const paths = await fixture();
    await writeFile(path.join(paths.primary, "package-lock.json"), "primary\n");
    await writeFile(path.join(paths.worktree, "package-lock.json"), "candidate\n");

    await expect(linkPrimaryDependencies(paths.primary, paths.worktree)).resolves.toBe(
      "skipped-lockfile-mismatch",
    );
    await expect(access(path.join(paths.worktree, "node_modules"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("skips the link when a non-first lockfile differs", async () => {
    const paths = await fixture();
    await writeFile(path.join(paths.primary, "package-lock.json"), "{}\n");
    await writeFile(path.join(paths.worktree, "package-lock.json"), "{}\n");
    await writeFile(path.join(paths.primary, "pnpm-lock.yaml"), "primary\n");
    await writeFile(path.join(paths.worktree, "pnpm-lock.yaml"), "candidate\n");

    await expect(linkPrimaryDependencies(paths.primary, paths.worktree)).resolves.toBe(
      "skipped-lockfile-mismatch",
    );
  });

  it("skips the link when a lockfile is present on only one side", async () => {
    const paths = await fixture();
    await writeFile(path.join(paths.primary, "package-lock.json"), "{}\n");
    await writeFile(path.join(paths.worktree, "package-lock.json"), "{}\n");
    await writeFile(path.join(paths.worktree, "yarn.lock"), "candidate\n");

    await expect(linkPrimaryDependencies(paths.primary, paths.worktree)).resolves.toBe(
      "skipped-lockfile-mismatch",
    );
  });

  it.skipIf(process.platform !== "darwin" && process.platform !== "linux")(
    "clones node_modules when all recognized lockfiles match",
    async () => {
      const paths = await fixture();
      for (const lockfile of ["package-lock.json", "bun.lockb", "pnpm-lock.yaml", "yarn.lock"]) {
        await writeFile(path.join(paths.primary, lockfile), `${lockfile}\n`);
        await writeFile(path.join(paths.worktree, lockfile), `${lockfile}\n`);
      }

      const link = await linkPrimaryDependencies(paths.primary, paths.worktree);
      expect(["inherited", "skipped-cow-unsupported"]).toContain(link);
    },
  );

  it("fails closed and removes partial output when copy-on-write cloning fails", async () => {
    const paths = await fixture();
    await writeFile(path.join(paths.primary, "package-lock.json"), "{}\n");
    await writeFile(path.join(paths.worktree, "package-lock.json"), "{}\n");

    await expect(linkPrimaryDependencies(paths.primary, paths.worktree, {
      platform: "linux",
      execFile: async (_file, args) => {
        await mkdir(args[args.length - 1]!);
        throw new Error("forced cp failure");
      },
    })).resolves.toBe("skipped-cow-unsupported");
    await expect(access(path.join(paths.worktree, "node_modules")))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("fails closed without invoking cp on unsupported platforms", async () => {
    const paths = await fixture();
    await writeFile(path.join(paths.primary, "package-lock.json"), "{}\n");
    await writeFile(path.join(paths.worktree, "package-lock.json"), "{}\n");
    let invoked = false;

    await expect(linkPrimaryDependencies(paths.primary, paths.worktree, {
      platform: "win32",
      execFile: async () => {
        invoked = true;
        throw new Error("must not run");
      },
    })).resolves.toBe("skipped-cow-unsupported");
    expect(invoked).toBe(false);
    await expect(access(path.join(paths.worktree, "node_modules")))
      .rejects.toMatchObject({ code: "ENOENT" });
  });
});
