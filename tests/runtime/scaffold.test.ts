import { describe, it, expect } from "vitest";
import { logger } from "../../src/util/logger.js";

describe("logger", () => {
  it("writes to stderr and never stdout", () => {
    const outChunks: string[] = [];
    const errChunks: string[] = [];
    const out = process.stdout.write.bind(process.stdout);
    const err = process.stderr.write.bind(process.stderr);
    process.stdout.write = (c: string) => { outChunks.push(String(c)); return true; };
    process.stderr.write = (c: string) => { errChunks.push(String(c)); return true; };
    try { logger.info("hello", { a: 1 }); } finally {
      process.stdout.write = out; process.stderr.write = err;
    }
    expect(outChunks.join("")).toBe("");
    expect(errChunks.join("")).toContain("hello");
  });
});
