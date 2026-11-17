import { expect, test } from "bun:test";
import { createPullRequestReader, pullRequestBranches } from "./pull-request";
import type { PullRequest } from "../shared/pull-request";

const pullRequest: PullRequest = {
  number: 123,
  url: "https://github.com/example/acme/pull/123",
  title: "Add an empty state",
  state: "OPEN",
};

function reader(
  responses: (checkoutPath: string, branch: string) => Promise<unknown>,
  options: { now?: () => number } = {},
) {
  const calls: { checkoutPath: string; branch: string }[] = [];
  const read = createPullRequestReader({
    run: (checkoutPath, branch) => {
      calls.push({ checkoutPath, branch });
      return responses(checkoutPath, branch);
    },
    ttlMs: 1_000,
    missingTtlMs: 10_000,
    now: options.now,
  });
  return { read, calls };
}

test("the candidate branches put the pushed branch first", () => {
  expect(pullRequestBranches("worktree/silver-meadow", "feat/x")).toEqual([
    "feat/x",
    "worktree/silver-meadow",
  ]);
  // 同じ名前なら 1 つ。gh を同じブランチで 2 回起動しない。
  expect(pullRequestBranches("feat/x", "feat/x")).toEqual(["feat/x"]);
  // 上流が無い（push していない・上流を設定していない）ときはローカル名だけ。
  expect(pullRequestBranches("worktree/silver-meadow", null)).toEqual(["worktree/silver-meadow"]);
});

test("the reader returns the latest pull request of the checkout", async () => {
  const { read, calls } = reader(async () => [pullRequest]);
  expect(await read({ checkoutPath: "/work/acme", branches: ["feat/x"] })).toEqual(pullRequest);
  expect(calls).toEqual([{ checkoutPath: "/work/acme", branch: "feat/x" }]);
});

// Herdr のワークツリー名（worktree/...）のままでは PR を引けない。PR の head は push 先の
// 名前になるので、push 先を先に引き、見つかった時点でローカル名は引かない。
test("the pushed branch is looked up before the local one", async () => {
  const { read, calls } = reader(async (_checkoutPath, branch) =>
    branch === "feat/x" ? [pullRequest] : [],
  );
  expect(
    await read({ checkoutPath: "/work/acme", branches: ["feat/x", "worktree/silver-meadow"] }),
  ).toEqual(pullRequest);
  expect(calls).toEqual([{ checkoutPath: "/work/acme", branch: "feat/x" }]);
});

test("the local branch is looked up when the pushed branch has no pull request", async () => {
  const { read, calls } = reader(async (_checkoutPath, branch) =>
    branch === "worktree/silver-meadow" ? [pullRequest] : [],
  );
  expect(
    await read({ checkoutPath: "/work/acme", branches: ["feat/x", "worktree/silver-meadow"] }),
  ).toEqual(pullRequest);
  expect(calls.map((call) => call.branch)).toEqual(["feat/x", "worktree/silver-meadow"]);
});

test("the same branch is looked up once even when it is both candidates", async () => {
  const { read, calls } = reader(async () => []);
  expect(await read({ checkoutPath: "/work/acme", branches: ["feat/x", "feat/x", ""] })).toBeNull();
  expect(calls.map((call) => call.branch)).toEqual(["feat/x"]);
});

test("a failing candidate falls through to the next one", async () => {
  const { read, calls } = reader(async (_checkoutPath, branch) => {
    if (branch === "feat/x") throw new Error("gh is not installed");
    return [pullRequest];
  });
  expect(
    await read({ checkoutPath: "/work/acme", branches: ["feat/x", "worktree/silver-meadow"] }),
  ).toEqual(pullRequest);
  expect(calls).toHaveLength(2);
});

// push して upstream が付くと候補が変わる。現在の head に PR ができた可能性があるので、
// 空を覚えていてもそのキーでは引き直す。
test("a changed candidate set is looked up again", async () => {
  let now = 0;
  const { read, calls } = reader(async () => [], { now: () => now });
  expect(
    await read({ checkoutPath: "/work/acme", branches: ["worktree/silver-meadow"] }),
  ).toBeNull();
  now = 1;
  expect(
    await read({ checkoutPath: "/work/acme", branches: ["feat/x", "worktree/silver-meadow"] }),
  ).toBeNull();
  expect(calls.map((call) => call.branch)).toEqual([
    "worktree/silver-meadow",
    "feat/x",
    "worktree/silver-meadow",
  ]);
});

test("a pull request is reused until its TTL passes", async () => {
  let now = 0;
  const { read, calls } = reader(async () => [pullRequest], { now: () => now });
  await read({ checkoutPath: "/work/acme", branches: ["feat/x"] });
  now = 999;
  await read({ checkoutPath: "/work/acme", branches: ["feat/x"] });
  expect(calls).toHaveLength(1);
  now = 1_000;
  await read({ checkoutPath: "/work/acme", branches: ["feat/x"] });
  expect(calls).toHaveLength(2);
});

test("concurrent lookups for the same branch share one gh run", async () => {
  let resolve: (value: unknown) => void = () => {};
  const pending = new Promise<unknown>((done) => {
    resolve = done;
  });
  const { read, calls } = reader(() => pending);

  const first = read({ checkoutPath: "/work/acme", branches: ["feat/x"] });
  const second = read({ checkoutPath: "/work/acme", branches: ["feat/x"] });
  expect(calls).toHaveLength(1);

  resolve([pullRequest]);
  expect(await Promise.all([first, second])).toEqual([pullRequest, pullRequest]);
  expect(calls).toHaveLength(1);
});

test("a missing pull request is remembered longer than a found one", async () => {
  let now = 0;
  const { read, calls } = reader(async () => [], { now: () => now });
  await read({ checkoutPath: "/work/acme", branches: ["feat/x"] });
  now = 9_999;
  expect(await read({ checkoutPath: "/work/acme", branches: ["feat/x"] })).toBeNull();
  expect(calls).toHaveLength(1);
  now = 10_000;
  await read({ checkoutPath: "/work/acme", branches: ["feat/x"] });
  expect(calls).toHaveLength(2);
});

test("refresh bypasses the cache and replaces the remembered value", async () => {
  let now = 0;
  let response: PullRequest[] = [];
  const { read, calls } = reader(async () => response, { now: () => now });

  expect(await read({ checkoutPath: "/work/acme", branches: ["feat/x"] })).toBeNull();
  response = [pullRequest];
  now = 1;
  expect(await read({ checkoutPath: "/work/acme", branches: ["feat/x"], refresh: true })).toEqual(
    pullRequest,
  );
  expect(calls).toHaveLength(2);

  // 引き直した値は、その後の通常の取得でも使う。
  response = [];
  now = 2;
  expect(await read({ checkoutPath: "/work/acme", branches: ["feat/x"] })).toEqual(pullRequest);
  expect(calls).toHaveLength(2);
});

test("the cache separates worktrees and branches", async () => {
  const { read, calls } = reader(async (_checkoutPath, branch) =>
    branch === "feat/x" ? [pullRequest] : [],
  );
  await read({ checkoutPath: "/work/acme", branches: ["feat/x"] });
  await read({ checkoutPath: "/work/acme", branches: ["feat/y"] });
  await read({ checkoutPath: "/work/acme-docs", branches: ["feat/x"] });
  expect(calls).toHaveLength(3);
  expect(await read({ checkoutPath: "/work/acme-docs", branches: ["feat/y"] })).toBeNull();
});
test("a failed lookup is not reported and is cached as a miss", async () => {
  let now = 0;
  const { read, calls } = reader(
    async () => {
      throw new Error("gh is not installed");
    },
    { now: () => now },
  );
  expect(await read({ checkoutPath: "/work/acme", branches: ["feat/x"] })).toBeNull();
  now = 9_999;
  await read({ checkoutPath: "/work/acme", branches: ["feat/x"] });
  expect(calls).toHaveLength(1);
});

test("a failed refresh replaces the remembered value with a miss", async () => {
  let now = 0;
  let fail = false;
  const { read } = reader(
    async () => {
      if (fail) throw new Error("gh is not installed");
      return [pullRequest];
    },
    { now: () => now },
  );
  expect(await read({ checkoutPath: "/work/acme", branches: ["feat/x"] })).toEqual(pullRequest);
  fail = true;
  now = 1;
  expect(
    await read({ checkoutPath: "/work/acme", branches: ["feat/x"], refresh: true }),
  ).toBeNull();
  fail = false;
  now = 2;
  expect(await read({ checkoutPath: "/work/acme", branches: ["feat/x"] })).toBeNull();
});

test("an unexpected gh response is treated as no pull request", async () => {
  const { read } = reader(async () => ({ message: "no pull requests found" }));
  expect(await read({ checkoutPath: "/work/acme", branches: ["feat/x"] })).toBeNull();
});
