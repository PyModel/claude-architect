import { execFile } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { chmod, lstat, mkdir, mkdtemp, open, rm, rmdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { verifyBoundDirectoryCleanupSupport } from "../../src/platform/bound-directory-cleanup.js";
import { getPlatformServices } from "../../src/platform/select-platform.js";
import {
  assertWindowsDirectoryWriteIntegrity,
  assertWindowsPrivateDirectory,
  ensurePrivateDirectory,
  requireBirthtimeIdentity,
  sameDevIno,
  sameDirectoryIdentity,
  syncDirectoryMetadata,
  syncDirectoryTreeMetadata,
} from "../../src/platform/durable-directory.js";

function stableDirectoryInspection() {
  const inspect = vi.fn<typeof lstat>();
  inspect.mockResolvedValue({
    isDirectory: () => true,
    isSymbolicLink: () => false,
    dev: 11n,
    ino: 22n,
    birthtimeNs: 33n,
  } as never);
  return inspect;
}

describe("directory metadata durability", () => {
  it("classifies an unavailable bound-cleanup backend before mutation", async () => {
    const services = Object.create(getPlatformServices());
    Object.defineProperty(services, "os", { value: "aix" });

    await expect(verifyBoundDirectoryCleanupSupport(services)).rejects.toMatchObject({
      message: "aix bound-directory cleanup backend is unavailable",
      detail: { classification: "cleanup-backend-unavailable" },
    });
  });

  it.skipIf(process.platform === "win32")(
    "migrates a runtime-owned POSIX directory through the shared platform policy",
    async () => {
      const directory = await mkdtemp(path.join(tmpdir(), "ca-private-migration-"));
      try {
        await chmod(directory, 0o755);
        const identity = await ensurePrivateDirectory(directory, {
          description: "test state directory",
          create: false,
          migratePermissions: true,
        });
        const settled = await lstat(directory, { bigint: true });
        expect(settled.mode & 0o077n).toBe(0n);
        expect(identity).toEqual({
          dev: settled.dev,
          ino: settled.ino,
          birthtimeNs: settled.birthtimeNs,
        });
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "rejects a POSIX state directory writable by another principal",
    async () => {
      const directory = await mkdtemp(path.join(tmpdir(), "ca-public-state-"));
      try {
        await chmod(directory, 0o770);
        await expect(ensurePrivateDirectory(directory, {
          description: "test state directory",
          create: false,
          migratePermissions: true,
        })).rejects.toThrow("writable by another principal");
      } finally {
        await chmod(directory, 0o700);
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

  it("flushes bounded file contents and parent directories bottom-up", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "ca-durable-tree-"));
    const nested = path.join(directory, "nested");
    const synced: string[] = [];
    try {
      await mkdir(nested);
      await writeFile(path.join(nested, "registration"), "durable bytes\n");

      await syncDirectoryTreeMetadata(directory, {
        syncDirectory: async candidate => {
          synced.push(candidate);
          await syncDirectoryMetadata(candidate);
        },
      });

      expect(synced).toEqual([nested, directory]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.runIf(process.platform === "win32")(
    "validates an actual private Windows directory ACL",
    async () => {
      const directory = await mkdtemp(path.join(tmpdir(), "ca-private-directory-"));
      try {
        const metadata = await lstat(directory, { bigint: true });
        await expect(assertWindowsPrivateDirectory(directory, {
          dev: metadata.dev,
          ino: metadata.ino,
          birthtimeNs: metadata.birthtimeNs,
        })).resolves.toBeUndefined();
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

  it.runIf(process.platform === "win32")(
    "rejects an actual Windows directory with an untrusted read ACE",
    async () => {
      const directory = await mkdtemp(path.join(tmpdir(), "ca-public-directory-"));
      const runIcacls = async (args: string[]) => await new Promise<void>((resolve, reject) => {
        execFile("icacls.exe", args, { windowsHide: true }, error => {
          if (error === null) resolve();
          else reject(error);
        });
      });
      try {
        await runIcacls([directory, "/grant", "*S-1-1-0:(R)"]);
        const metadata = await lstat(directory, { bigint: true });
        const identity = {
          dev: metadata.dev,
          ino: metadata.ino,
          birthtimeNs: metadata.birthtimeNs,
        };
        await expect(assertWindowsPrivateDirectory(directory, identity))
          .rejects.toThrow("ACL validation failed");
        await expect(assertWindowsDirectoryWriteIntegrity(directory, identity))
          .resolves.toBeUndefined();
      } finally {
        await runIcacls([directory, "/remove:g", "*S-1-1-0"]).catch(() => {});
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

  it.runIf(process.platform === "win32")(
    "rejects an actual Windows directory with an untrusted write ACE",
    async () => {
      const directory = await mkdtemp(path.join(tmpdir(), "ca-writable-directory-"));
      const runIcacls = async (args: string[]) => await new Promise<void>((resolve, reject) => {
        execFile("icacls.exe", args, { windowsHide: true }, error => {
          if (error === null) resolve();
          else reject(error);
        });
      });
      try {
        await runIcacls([directory, "/grant", "*S-1-1-0:(W)"]);
        const metadata = await lstat(directory, { bigint: true });
        await expect(assertWindowsDirectoryWriteIntegrity(directory, {
          dev: metadata.dev,
          ino: metadata.ino,
          birthtimeNs: metadata.birthtimeNs,
        })).rejects.toThrow("ACL validation failed");
      } finally {
        await runIcacls([directory, "/remove:g", "*S-1-1-0"]).catch(() => {});
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

  it.runIf(process.platform === "win32")(
    "flushes an actual Windows directory through the native fallback",
    async () => {
      const directory = await mkdtemp(path.join(tmpdir(), "ca-directory-sync-"));
      try {
        await expect(syncDirectoryMetadata(directory)).resolves.toBeUndefined();
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

  it.each(["EISDIR", "EINVAL", "ENOTSUP", "EPERM"])(
    "uses an explicit Windows fallback for %s",
    async code => {
      const openDirectory = vi.fn<typeof open>();
      openDirectory.mockRejectedValue(Object.assign(new Error(code), { code }));
      const syncWindowsDirectory = vi.fn(async () => {});
      const inspect = stableDirectoryInspection();

      await expect(syncDirectoryMetadata("C:\\state", {
        platform: "win32",
        open: openDirectory,
        lstat: inspect,
        syncWindowsDirectory,
      })).resolves.toBeUndefined();

      expect(syncWindowsDirectory).toHaveBeenCalledWith("C:\\state", {
        dev: 11n,
        ino: 22n,
        birthtimeNs: 33n,
      });
    },
  );

  it("fails closed when the Windows fallback cannot flush the directory", async () => {
    const openDirectory = vi.fn<typeof open>();
    openDirectory.mockRejectedValue(Object.assign(new Error("unsupported"), { code: "EISDIR" }));
    const fallbackError = new Error("native flush failed");

    await expect(syncDirectoryMetadata("C:\\state", {
      platform: "win32",
      open: openDirectory,
      lstat: stableDirectoryInspection(),
      syncWindowsDirectory: async () => { throw fallbackError; },
    })).rejects.toBe(fallbackError);
  });

  it("rejects pathname substitution after flushing the opened directory inode", async () => {
    const original = {
      isDirectory: () => true,
      isSymbolicLink: () => false,
      dev: 11n,
      ino: 22n,
      birthtimeNs: 33n,
    };
    const replacement = { ...original, ino: 44n };
    const inspect = vi.fn<typeof lstat>();
    inspect.mockResolvedValueOnce(original as never).mockResolvedValueOnce(replacement as never);
    const openDirectory = vi.fn<typeof open>();
    openDirectory.mockResolvedValue({
      stat: async () => original,
      sync: async () => {},
      close: async () => {},
    } as never);

    await expect(syncDirectoryMetadata("/state", {
      platform: "linux",
      open: openDirectory,
      lstat: inspect,
    })).rejects.toThrow("identity changed during flush");
  });

  it("does not suppress the same filesystem errors on POSIX", async () => {
    const openDirectory = vi.fn<typeof open>();
    const permissionError = Object.assign(new Error("permission denied"), { code: "EPERM" });
    openDirectory.mockRejectedValue(permissionError);
    const syncWindowsDirectory = vi.fn(async () => {});

    await expect(syncDirectoryMetadata("/state", {
      platform: "linux",
      open: openDirectory,
      lstat: stableDirectoryInspection(),
      syncWindowsDirectory,
    })).rejects.toBe(permissionError);
    expect(syncWindowsDirectory).not.toHaveBeenCalled();
  });
});

describe("canonical directory identity", () => {
  it("rejects a directory removed and recreated at the same path", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "ca-directory-identity-"));
    try {
      const directory = path.join(root, "target");
      await mkdir(directory);
      const original = await lstat(directory, { bigint: true });
      await rmdir(directory);
      // Hold the freed inode so the recreated directory cannot reuse it.
      await mkdir(path.join(root, "placeholder"));
      await mkdir(directory);
      const recreated = await lstat(directory, { bigint: true });
      expect(sameDirectoryIdentity(original, original)).toBe(true);
      expect(sameDirectoryIdentity(recreated, original)).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("compares all three fields exactly, so two zero birth times are equal", () => {
    const zero = { dev: 1n, ino: 2n, birthtimeNs: 0n };
    expect(sameDirectoryIdentity(zero, { ...zero })).toBe(true);
    expect(sameDirectoryIdentity(zero, { ...zero, birthtimeNs: 5n })).toBe(false);
    expect(sameDirectoryIdentity({ ...zero, birthtimeNs: 5n }, zero)).toBe(false);
    expect(sameDirectoryIdentity(zero, { ...zero, ino: 3n })).toBe(false);
    expect(sameDirectoryIdentity(zero, { ...zero, dev: 3n })).toBe(false);
  });

  it("refuses a zero birth time when capturing an identity that guards a destructive operation", () => {
    expect(() => requireBirthtimeIdentity({ dev: 1n, ino: 2n, birthtimeNs: 0n }, "quarantine"))
      .toThrow("quarantine lacks stable birth-time identity");
    expect(() => requireBirthtimeIdentity({ dev: 1n, ino: 2n, birthtimeNs: -1n }, "quarantine"))
      .toThrow("quarantine lacks stable birth-time identity");
    expect(requireBirthtimeIdentity(
      { dev: 1n, ino: 2n, birthtimeNs: 7n, size: 9n } as { dev: bigint; ino: bigint; birthtimeNs: bigint },
      "quarantine",
    )).toEqual({ dev: 1n, ino: 2n, birthtimeNs: 7n });
  });

  it("distinguishes directory identities whose values collide under Number()", () => {
    const base = 2n ** 60n;
    const identity = { dev: base, ino: base, birthtimeNs: 7n };
    expect(Number(base) === Number(base + 1n)).toBe(true);
    expect(sameDirectoryIdentity(identity, { ...identity })).toBe(true);
    expect(sameDirectoryIdentity(identity, { ...identity, dev: base + 1n })).toBe(false);
    expect(sameDirectoryIdentity(identity, { ...identity, ino: base + 1n })).toBe(false);
  });

  it("treats device or inode values that differ only above 2^53 as different", () => {
    const base = 2n ** 60n;
    expect(Number(base) === Number(base + 1n)).toBe(true); // lossy as a number
    expect(sameDevIno({ dev: base, ino: 1n }, { dev: base + 1n, ino: 1n })).toBe(false);
    expect(sameDevIno({ dev: 1n, ino: base }, { dev: 1n, ino: base + 1n })).toBe(false);
    expect(sameDevIno({ dev: base, ino: base }, { dev: base, ino: base })).toBe(true);
  });
});
