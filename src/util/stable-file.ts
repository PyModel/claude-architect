import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { NO_FOLLOW } from "../platform/durable-directory.js";

export interface StableFileDependencies {
  open?: typeof open;
  lstat?: typeof lstat;
}

/** Read one bounded, single-linked regular file only if its named identity stays stable. */
export async function readStableRegularFile(
  filename: string,
  maxBytes: bigint,
  dependencies: StableFileDependencies = {},
): Promise<Buffer | null> {
  const handle = await (dependencies.open ?? open)(
    filename,
    constants.O_RDONLY
      | NO_FOLLOW
      | (constants.O_NONBLOCK ?? 0),
  );
  let primaryError: unknown;
  try {
    const metadata = await handle.stat({ bigint: true });
    const named = await (dependencies.lstat ?? lstat)(filename, { bigint: true });
    if (!metadata.isFile()
      || metadata.nlink !== 1n
      || metadata.birthtimeNs <= 0n
      || metadata.size > maxBytes
      || !named.isFile()
      || named.isSymbolicLink()
      || named.birthtimeNs <= 0n
      || named.nlink !== 1n
      || named.dev !== metadata.dev
      || named.ino !== metadata.ino
      || named.birthtimeNs !== metadata.birthtimeNs
      || named.size !== metadata.size) return null;

    if (maxBytes < 0n || maxBytes >= BigInt(Number.MAX_SAFE_INTEGER)) return null;
    const limit = Math.min(Number(maxBytes) + 1, Number(metadata.size) + 1);
    const buffer = Buffer.alloc(limit);
    let bytesRead = 0;
    while (bytesRead < limit) {
      const read = await handle.read(buffer, bytesRead, limit - bytesRead, null);
      if (read.bytesRead === 0) break;
      bytesRead += read.bytesRead;
    }
    if (bytesRead > Number(maxBytes)) return null;
    const contents = buffer.subarray(0, bytesRead);
    const settled = await handle.stat({ bigint: true });
    const settledNamed = await (dependencies.lstat ?? lstat)(filename, { bigint: true });
    if (!settled.isFile()
      || settled.nlink !== 1n
      || settled.birthtimeNs <= 0n
      || settled.dev !== metadata.dev
      || settled.ino !== metadata.ino
      || settled.birthtimeNs !== metadata.birthtimeNs
      || settled.size !== metadata.size
      || settled.mtimeNs !== metadata.mtimeNs
      || settled.ctimeNs !== metadata.ctimeNs
      || !settledNamed.isFile()
      || settledNamed.isSymbolicLink()
      || settledNamed.birthtimeNs <= 0n
      || settledNamed.nlink !== 1n
      || settledNamed.dev !== metadata.dev
      || settledNamed.ino !== metadata.ino
      || settledNamed.birthtimeNs !== metadata.birthtimeNs
      || settledNamed.size !== metadata.size
      || settledNamed.mtimeNs !== settled.mtimeNs
      || settledNamed.ctimeNs !== settled.ctimeNs
      || BigInt(contents.byteLength) !== metadata.size) return null;
    return contents;
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    try {
      await handle.close();
    } catch (closeError) {
      if (primaryError === undefined) throw closeError;
      throw new AggregateError(
        [primaryError, closeError],
        "stable file read failed and its handle could not be closed",
      );
    }
  }
}
