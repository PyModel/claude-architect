import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { candidateReviewPatch } from "../../src/git/candidate-tree.js";
import { gitChecked, reviewDiff } from "../../src/git/checked-git.js";
import { git } from "../../src/git/git-exec.js";

const temporaryPaths: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map(candidate =>
    rm(candidate, { recursive: true, force: true })));
});

async function commitAll(repo: string, message: string): Promise<string> {
  await gitChecked(repo, ["add", "-A"]);
  await gitChecked(repo, [
    "-c", "user.name=Review Diff Test",
    "-c", "user.email=review-diff@example.invalid",
    "commit", "-q", "-m", message,
  ]);
  return (await gitChecked(repo, ["rev-parse", "HEAD"])).trim();
}

async function hiddenCandidate(): Promise<{ repo: string; base: string; head: string }> {
  const repo = await mkdtemp(path.join(tmpdir(), "ca-review-diff-"));
  temporaryPaths.push(repo);
  await gitChecked(repo, ["init", "-q"]);
  await writeFile(path.join(repo, "payload.ts"), "export const safe = true;\n");
  await writeFile(path.join(repo, "image.png"), Buffer.from([0x89, 0x50, 0x00, 0x01]));
  const base = await commitAll(repo, "base");
  // A Producer marks its own source as binary so a plain diff hides it.
  await writeFile(path.join(repo, ".gitattributes"), "payload.ts -diff\n");
  await writeFile(path.join(repo, "payload.ts"), "export const safe = true;\nexfiltrate();\n");
  await writeFile(path.join(repo, "image.png"), Buffer.from([0x89, 0x50, 0x00, 0x02]));
  const head = await commitAll(repo, "candidate");
  return { repo, base, head };
}

describe("review diffs", () => {
  it("shows source a Producer marked -diff while real binaries stay binary", async () => {
    const { repo, base, head } = await hiddenCandidate();

    const plain = await gitChecked(repo, ["diff", `${base}..${head}`]);
    const reviewed = await reviewDiff(repo, base, head);

    expect(plain).not.toContain("exfiltrate()");
    expect(reviewed).toContain("+exfiltrate();");
    expect(reviewed).toContain("Binary files a/image.png and b/image.png differ");
  });

  it("renders the same content in the archived human review patch", async () => {
    const { repo, base, head } = await hiddenCandidate();

    const patch = await candidateReviewPatch(repo, base, head);

    expect(patch).toContain("+exfiltrate();");
    expect(patch).toContain("[[BINARY_PATCH_PAYLOAD_OMITTED]]");
  });
});

describe("gitChecked", () => {
  it("treats truncated output as a failure, never as a partial answer", async () => {
    const { repo, base, head } = await hiddenCandidate();

    const bounded = await git(repo, ["diff", `${base}..${head}`], { maxOutputBytes: 16 });
    expect(bounded.exitCode).toBe(0);
    expect(bounded.truncated?.stdout).toBe(true);
    await expect(gitChecked(repo, ["diff", `${base}..${head}`], { maxOutputBytes: 16 }))
      .rejects.toThrow("git diff output exceeded the runtime bound");
  });
});
