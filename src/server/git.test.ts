import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBranchReader, parseBranchHead, parseGitDirFile, readBranch } from "./git";

const made: string[] = [];

async function dir(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "hwc-git-"));
  made.push(path);
  return path;
}

afterEach(async () => {
  for (const path of made.splice(0)) await rm(path, { recursive: true, force: true });
});

test("a checked out branch comes from the head file", () => {
  expect(parseBranchHead("ref: refs/heads/main\n")).toBe("main");
  expect(parseBranchHead("ref: refs/heads/feat/paste-images\n")).toBe("feat/paste-images");
  // detached HEAD はブランチではない。
  expect(parseBranchHead("0123456789abcdef\n")).toBeNull();
  expect(parseBranchHead("ref: refs/tags/v1\n")).toBeNull();
});

test("a linked worktree points at its own git dir", () => {
  expect(parseGitDirFile("gitdir: /repo/.git/worktrees/wt\n")).toBe("/repo/.git/worktrees/wt");
  expect(parseGitDirFile("nonsense")).toBeNull();
});

test("a plain checkout reads .git/HEAD", async () => {
  const root = await dir();
  await mkdir(join(root, ".git"));
  await writeFile(join(root, ".git", "HEAD"), "ref: refs/heads/main\n");
  expect(await readBranch(root)).toBe("main");
});

test("a linked worktree follows the gitdir file", async () => {
  const root = await dir();
  const gitDir = join(root, "store", "worktrees", "wt");
  await mkdir(gitDir, { recursive: true });
  await writeFile(join(gitDir, "HEAD"), "ref: refs/heads/feat/tree\n");
  const checkout = join(root, "checkout");
  await mkdir(checkout);
  await writeFile(join(checkout, ".git"), `gitdir: ${gitDir}\n`);
  expect(await readBranch(checkout)).toBe("feat/tree");
});

test("a place without git has no branch", async () => {
  const root = await dir();
  expect(await readBranch(root)).toBeNull();
});

test("the reader keeps the branch for a moment instead of reading every time", async () => {
  const root = await dir();
  await mkdir(join(root, ".git"));
  await writeFile(join(root, ".git", "HEAD"), "ref: refs/heads/main\n");
  let at = 0;
  const read = createBranchReader({ ttlMs: 1_000, now: () => at });

  expect(await read(root)).toBe("main");
  await writeFile(join(root, ".git", "HEAD"), "ref: refs/heads/other\n");
  at = 500;
  expect(await read(root)).toBe("main");
  at = 1_500;
  expect(await read(root)).toBe("other");
});
