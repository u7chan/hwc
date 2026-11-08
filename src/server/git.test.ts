import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createBranchReader,
  createGitClient,
  parseBranchHead,
  parseGitDirFile,
  readBranch,
} from "./git";

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

test("a subdirectory of a checkout keeps the branch", async () => {
  const root = await dir();
  await mkdir(join(root, ".git"));
  await writeFile(join(root, ".git", "HEAD"), "ref: refs/heads/main\n");
  const sub = join(root, "src", "client");
  await mkdir(sub, { recursive: true });
  expect(await readBranch(sub)).toBe("main");
});

test("a relative place is never read", async () => {
  expect(await readBranch("")).toBeNull();
  expect(await readBranch("relative/dir")).toBeNull();
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

test("the sync reader parses the upstream and its divergence", async () => {
  const calls: string[][] = [];
  const client = createGitClient({
    runRead: async (_path, args) => {
      calls.push(args);
      if (args[0] === "remote") return "origin\n";
      return "origin/main\t[ahead 1, behind 2]\n";
    },
  });

  expect(await client.read({ checkoutPath: "/repo", branch: "main" })).toEqual({
    upstream: "origin/main",
    ahead: 1,
    behind: 2,
    hasRemote: true,
  });
  expect(calls).toEqual([
    ["remote"],
    ["for-each-ref", "--format=%(upstream:short)\t%(upstream:track)", "refs/heads/main"],
  ]);
});

test("a branch without an upstream keeps the remote but has no counts", async () => {
  const client = createGitClient({
    runRead: async (_path, args) => (args[0] === "remote" ? "origin\n" : ""),
  });

  expect(await client.read({ checkoutPath: "/repo", branch: "feat/new" })).toEqual({
    upstream: null,
    ahead: 0,
    behind: 0,
    hasRemote: true,
  });
});

test("a repo without a remote is still readable", async () => {
  const client = createGitClient({
    runRead: async (_path, args) => (args[0] === "remote" ? "" : "origin/main\t\n"),
  });

  expect(await client.read({ checkoutPath: "/repo", branch: "main" })).toEqual({
    upstream: "origin/main",
    ahead: 0,
    behind: 0,
    hasRemote: false,
  });
});

test("the sync reader caches per checkout and branch", async () => {
  let at = 0;
  let reads = 0;
  const client = createGitClient({
    ttlMs: 1_000,
    now: () => at,
    runRead: async (_path, args) => {
      reads += 1;
      return args[0] === "remote" ? "origin\n" : "origin/main\t[ahead 1]\n";
    },
  });

  await client.read({ checkoutPath: "/repo", branch: "main" });
  await client.read({ checkoutPath: "/repo", branch: "main" });
  expect(reads).toBe(2);

  at = 500;
  await client.read({ checkoutPath: "/repo", branch: "main" });
  expect(reads).toBe(2);

  at = 1_500;
  await client.read({ checkoutPath: "/repo", branch: "main" });
  expect(reads).toBe(4);

  await client.read({ checkoutPath: "/repo", branch: "other" });
  expect(reads).toBe(6);
});

test("invalidate drops the cached sync of a checkout", async () => {
  let reads = 0;
  const client = createGitClient({
    runRead: async (_path, args) => {
      reads += 1;
      return args[0] === "remote" ? "origin\n" : "origin/main\t\n";
    },
  });

  await client.read({ checkoutPath: "/repo", branch: "main" });
  client.invalidate("/repo");
  await client.read({ checkoutPath: "/repo", branch: "main" });

  expect(reads).toBe(4);
});

test("a read that overlaps an invalidate does not cache its stale result", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let reads = 0;
  const client = createGitClient({
    runRead: async (_path, args) => {
      reads += 1;
      if (args[0] === "remote") return "origin\n";
      // 最初の for-each-ref だけを遅らせ、読み取り中に invalidate を割り込ませる。
      if (reads === 2) await gate;
      return reads <= 2 ? "origin/main\t[ahead 1, behind 2]\n" : "origin/main\t[ahead 1]\n";
    },
  });

  const pending = client.read({ checkoutPath: "/repo", branch: "main" });
  // read() は開始時に世代を取っている。invalidate を先に進めても、
  // 遅れて解決した古い値をキャッシュへ戻してはいけない。
  client.invalidate("/repo");
  release();

  expect(await pending).toEqual({
    upstream: "origin/main",
    ahead: 1,
    behind: 2,
    hasRemote: true,
  });
  expect(await client.read({ checkoutPath: "/repo", branch: "main" })).toEqual({
    upstream: "origin/main",
    ahead: 1,
    behind: 0,
    hasRemote: true,
  });
});

test("a git read failure yields no sync and does not throw", async () => {
  const client = createGitClient({
    runRead: async () => {
      throw new Error("git is not installed");
    },
  });

  expect(await client.read({ checkoutPath: "/repo", branch: "main" })).toBeNull();
});

test("a relative checkout is never read", async () => {
  let called = false;
  const client = createGitClient({
    runRead: async () => {
      called = true;
      return "";
    },
  });

  expect(await client.read({ checkoutPath: "repo", branch: "main" })).toBeNull();
  expect(called).toBe(false);
});

test("fetch and pull use the expected git commands", async () => {
  const actions: string[][] = [];
  const client = createGitClient({
    runAction: async (_path, args) => {
      actions.push(args);
    },
  });

  await client.fetch("/repo");
  await client.pull("/repo");

  expect(actions).toEqual([["fetch"], ["pull", "--ff-only"]]);
});
