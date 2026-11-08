import { expect, test } from "bun:test";
import { createPullRequestReader } from "./pull-request";
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

test("the reader returns the latest pull request of the checkout", async () => {
  const { read, calls } = reader(async () => [pullRequest]);
  expect(await read({ checkoutPath: "/work/acme", branch: "feat/x" })).toEqual(pullRequest);
  expect(calls).toEqual([{ checkoutPath: "/work/acme", branch: "feat/x" }]);
});

test("a pull request is reused until its TTL passes", async () => {
  let now = 0;
  const { read, calls } = reader(async () => [pullRequest], { now: () => now });
  await read({ checkoutPath: "/work/acme", branch: "feat/x" });
  now = 999;
  await read({ checkoutPath: "/work/acme", branch: "feat/x" });
  expect(calls).toHaveLength(1);
  now = 1_000;
  await read({ checkoutPath: "/work/acme", branch: "feat/x" });
  expect(calls).toHaveLength(2);
});

test("a missing pull request is remembered longer than a found one", async () => {
  let now = 0;
  const { read, calls } = reader(async () => [], { now: () => now });
  await read({ checkoutPath: "/work/acme", branch: "feat/x" });
  now = 9_999;
  expect(await read({ checkoutPath: "/work/acme", branch: "feat/x" })).toBeNull();
  expect(calls).toHaveLength(1);
  now = 10_000;
  await read({ checkoutPath: "/work/acme", branch: "feat/x" });
  expect(calls).toHaveLength(2);
});

test("refresh bypasses the cache and replaces the remembered value", async () => {
  let now = 0;
  let response: PullRequest[] = [];
  const { read, calls } = reader(async () => response, { now: () => now });

  expect(await read({ checkoutPath: "/work/acme", branch: "feat/x" })).toBeNull();
  response = [pullRequest];
  now = 1;
  expect(await read({ checkoutPath: "/work/acme", branch: "feat/x", refresh: true })).toEqual(
    pullRequest,
  );
  expect(calls).toHaveLength(2);

  // 引き直した値は、その後の通常の取得でも使う。
  response = [];
  now = 2;
  expect(await read({ checkoutPath: "/work/acme", branch: "feat/x" })).toEqual(pullRequest);
  expect(calls).toHaveLength(2);
});

test("the cache separates worktrees and branches", async () => {
  const { read, calls } = reader(async (_checkoutPath, branch) =>
    branch === "feat/x" ? [pullRequest] : [],
  );
  await read({ checkoutPath: "/work/acme", branch: "feat/x" });
  await read({ checkoutPath: "/work/acme", branch: "feat/y" });
  await read({ checkoutPath: "/work/acme-docs", branch: "feat/x" });
  expect(calls).toHaveLength(3);
  expect(await read({ checkoutPath: "/work/acme-docs", branch: "feat/y" })).toBeNull();
});

test("a failed lookup is not reported and is cached as a miss", async () => {
  let now = 0;
  const { read, calls } = reader(
    async () => {
      throw new Error("gh is not installed");
    },
    { now: () => now },
  );
  expect(await read({ checkoutPath: "/work/acme", branch: "feat/x" })).toBeNull();
  now = 9_999;
  await read({ checkoutPath: "/work/acme", branch: "feat/x" });
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
  expect(await read({ checkoutPath: "/work/acme", branch: "feat/x" })).toEqual(pullRequest);
  fail = true;
  now = 1;
  expect(await read({ checkoutPath: "/work/acme", branch: "feat/x", refresh: true })).toBeNull();
  fail = false;
  now = 2;
  expect(await read({ checkoutPath: "/work/acme", branch: "feat/x" })).toBeNull();
});

test("an unexpected gh response is treated as no pull request", async () => {
  const { read } = reader(async () => ({ message: "no pull requests found" }));
  expect(await read({ checkoutPath: "/work/acme", branch: "feat/x" })).toBeNull();
});
