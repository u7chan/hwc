import { expect, test } from "bun:test";
import { gitStatusLabel, parseGitHubRemote, parseUpstreamTrack } from "./git";

test("an upstream with no divergence has zero counts", () => {
  expect(parseUpstreamTrack("origin/main\t")).toEqual({
    upstream: "origin/main",
    ahead: 0,
    behind: 0,
  });
});

test("an upstream track reports ahead and behind in either direction", () => {
  expect(parseUpstreamTrack("origin/main\t[ahead 2, behind 1]")).toEqual({
    upstream: "origin/main",
    ahead: 2,
    behind: 1,
  });
  expect(parseUpstreamTrack("origin/main\t[ahead 2]")).toEqual({
    upstream: "origin/main",
    ahead: 2,
    behind: 0,
  });
  expect(parseUpstreamTrack("origin/main\t[behind 3]")).toEqual({
    upstream: "origin/main",
    ahead: 0,
    behind: 3,
  });
});

test("a branch without an upstream has no counts", () => {
  expect(parseUpstreamTrack("")).toEqual({ upstream: null, ahead: 0, behind: 0 });
  expect(parseUpstreamTrack("\n")).toEqual({ upstream: null, ahead: 0, behind: 0 });
});

test("a deleted upstream is treated as no upstream", () => {
  expect(parseUpstreamTrack("origin/old\t[gone]")).toEqual({
    upstream: null,
    ahead: 0,
    behind: 0,
  });
});

test("the status label explains each direction", () => {
  expect(
    gitStatusLabel({
      upstream: "origin/main",
      ahead: 0,
      behind: 0,
      hasRemote: true,
      repoUrl: null,
    }),
  ).toBe("origin/main と同期しています");
  expect(
    gitStatusLabel({
      upstream: "origin/main",
      ahead: 2,
      behind: 0,
      hasRemote: true,
      repoUrl: null,
    }),
  ).toBe("origin/main より 2 コミット進んでいます");
  expect(
    gitStatusLabel({
      upstream: "origin/main",
      ahead: 0,
      behind: 3,
      hasRemote: true,
      repoUrl: null,
    }),
  ).toBe("origin/main より 3 コミット遅れています");
  expect(
    gitStatusLabel({
      upstream: "origin/main",
      ahead: 2,
      behind: 3,
      hasRemote: true,
      repoUrl: null,
    }),
  ).toBe("origin/main より 2 コミット進み、3 コミット遅れています");
  expect(
    gitStatusLabel({
      upstream: null,
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
