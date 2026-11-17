import { expect, test } from "bun:test";
import { gitStatusLabel, parseGitHubRemote, parseUpstream } from "./git";

test("an upstream with no divergence has zero counts", () => {
  expect(parseUpstream("origin/main\t\trefs/remotes/origin/main\torigin")).toEqual({
    upstream: "origin/main",
    upstreamBranch: "main",
    ahead: 0,
    behind: 0,
  });
});

test("an upstream track reports ahead and behind in either direction", () => {
  expect(
    parseUpstream("origin/main\t[ahead 2, behind 1]\trefs/remotes/origin/main\torigin"),
  ).toEqual({
    upstream: "origin/main",
    upstreamBranch: "main",
    ahead: 2,
    behind: 1,
  });
  expect(parseUpstream("origin/main\t[ahead 2]\trefs/remotes/origin/main\torigin")).toEqual({
    upstream: "origin/main",
    upstreamBranch: "main",
    ahead: 2,
    behind: 0,
  });
  expect(parseUpstream("origin/main\t[behind 3]\trefs/remotes/origin/main\torigin")).toEqual({
    upstream: "origin/main",
    upstreamBranch: "main",
    ahead: 0,
    behind: 3,
  });
});

// ワークツリーのローカル名（worktree/...）と push 先の名前は違うことがある。PR は
// ローカルの名前では引けないので、upstream から head の名前だけを取り出す。
test("the upstream branch is the remote branch name, not the local one", () => {
  expect(
    parseUpstream("origin/feat/file-preview\t\trefs/remotes/origin/feat/file-preview\torigin")
      .upstreamBranch,
  ).toBe("feat/file-preview");
});

test("the upstream branch keeps the remote name out of the branch", () => {
  // リモート名に `/` が入っていても、剥がす名前は remotename の値で決める。
  expect(parseUpstream("my/fork/docs\t\trefs/remotes/my/fork/docs\tmy/fork").upstreamBranch).toBe(
    "docs",
  );
});

test("a local upstream is read from the heads namespace", () => {
  expect(parseUpstream("local\t\trefs/heads/local\t.").upstreamBranch).toBe("local");
});

test("a branch without an upstream has no counts", () => {
  expect(parseUpstream("")).toEqual({
    upstream: null,
    upstreamBranch: null,
    ahead: 0,
    behind: 0,
  });
  expect(parseUpstream("\n")).toEqual({
    upstream: null,
    upstreamBranch: null,
    ahead: 0,
    behind: 0,
  });
  expect(parseUpstream("\t\t\t")).toEqual({
    upstream: null,
    upstreamBranch: null,
    ahead: 0,
    behind: 0,
  });
});

test("a deleted upstream is treated as no upstream but keeps its branch", () => {
  expect(parseUpstream("origin/old\t[gone]\trefs/remotes/origin/old\torigin")).toEqual({
    upstream: null,
    upstreamBranch: "old",
    ahead: 0,
    behind: 0,
  });
});

test("the status label explains each direction", () => {
  expect(
    gitStatusLabel({
      upstream: "origin/main",
      upstreamBranch: "main",
      ahead: 0,
      behind: 0,
      hasRemote: true,
      repoUrl: null,
    }),
  ).toBe("origin/main と同期しています");
  expect(
    gitStatusLabel({
      upstream: "origin/main",
      upstreamBranch: "main",
      ahead: 2,
      behind: 0,
      hasRemote: true,
      repoUrl: null,
    }),
  ).toBe("origin/main より 2 コミット進んでいます");
  expect(
    gitStatusLabel({
      upstream: "origin/main",
      upstreamBranch: "main",
      ahead: 0,
      behind: 3,
      hasRemote: true,
      repoUrl: null,
    }),
  ).toBe("origin/main より 3 コミット遅れています");
  expect(
    gitStatusLabel({
      upstream: "origin/main",
      upstreamBranch: "main",
      ahead: 2,
      behind: 3,
      hasRemote: true,
      repoUrl: null,
    }),
  ).toBe("origin/main より 2 コミット進み、3 コミット遅れています");
  expect(
    gitStatusLabel({
      upstream: null,
      upstreamBranch: null,
      ahead: 0,
      behind: 0,
      hasRemote: true,
      repoUrl: null,
    }),
  ).toBe("上流ブランチがありません");
});

test("a GitHub remote is normalized to the repository top", () => {
  expect(parseGitHubRemote("https://github.com/u7chan/hwc.git")).toBe(
    "https://github.com/u7chan/hwc",
  );
  expect(parseGitHubRemote("https://github.com/u7chan/hwc")).toBe("https://github.com/u7chan/hwc");
  expect(parseGitHubRemote("https://github.com/u7chan/hwc/")).toBe("https://github.com/u7chan/hwc");
  expect(parseGitHubRemote("http://github.com/u7chan/hwc.git")).toBe(
    "https://github.com/u7chan/hwc",
  );
  expect(parseGitHubRemote("git@github.com:u7chan/hwc.git")).toBe("https://github.com/u7chan/hwc");
  expect(parseGitHubRemote("github.com:u7chan/hwc")).toBe("https://github.com/u7chan/hwc");
  expect(parseGitHubRemote("ssh://git@github.com/u7chan/hwc.git")).toBe(
    "https://github.com/u7chan/hwc",
  );
  expect(parseGitHubRemote("ssh://git@github.com:22/u7chan/hwc.git")).toBe(
    "https://github.com/u7chan/hwc",
  );
});

test("anything that is not a GitHub repository top is rejected", () => {
  expect(parseGitHubRemote("https://gitlab.com/u7chan/hwc.git")).toBeNull();
  expect(parseGitHubRemote("https://github.com.evil.com/u7chan/hwc.git")).toBeNull();
  expect(parseGitHubRemote("git@github.com.evil.com:u7chan/hwc.git")).toBeNull();
  expect(parseGitHubRemote("https://github.com/u7chan/hwc/tree/main")).toBeNull();
  expect(parseGitHubRemote("https://github.com/u7chan/hwc?tab=readme")).toBeNull();
  expect(parseGitHubRemote("/home/u7dev/hwc")).toBeNull();
  expect(parseGitHubRemote("file:///home/u7dev/hwc")).toBeNull();
  expect(parseGitHubRemote("https://github.com/owner/.git")).toBeNull();
});
