import { expect, test } from "bun:test";
import { parsePullRequest, parsePullRequestList, type PullRequest } from "./pull-request";

const pullRequest: PullRequest = {
  number: 123,
  url: "https://github.com/example/acme/pull/123",
  title: "Add an empty state",
  state: "OPEN",
};

test("parsePullRequest accepts a github pull URL that matches its number", () => {
  expect(parsePullRequest(pullRequest)).toEqual(pullRequest);
});

test("parsePullRequest rejects a number or URL that does not match", () => {
  expect(parsePullRequest({ ...pullRequest, number: 124 })).toBeNull();
  expect(
    parsePullRequest({ ...pullRequest, url: "https://github.com/example/acme/pull/0123" }),
  ).toBeNull();
  expect(parsePullRequest({ ...pullRequest, number: 0 })).toBeNull();
  expect(parsePullRequest({ ...pullRequest, number: 1.5 })).toBeNull();
  expect(parsePullRequest({ ...pullRequest, number: "123" })).toBeNull();
  expect(parsePullRequest({ ...pullRequest, url: null })).toBeNull();
});

test("parsePullRequest rejects URLs outside github.com", () => {
  expect(
    parsePullRequest({ ...pullRequest, url: "https://github.example.com/example/acme/pull/123" }),
  ).toBeNull();
  expect(parsePullRequest({ ...pullRequest, url: "javascript:alert(1)" })).toBeNull();
  expect(
    parsePullRequest({ ...pullRequest, url: "https://github.com/example/acme/pull/123/files" }),
  ).toBeNull();
  expect(
    parsePullRequest({ ...pullRequest, url: "https://github.com/example/acme/issues/123" }),
  ).toBeNull();
});

test("parsePullRequest rejects values that are not objects", () => {
  expect(parsePullRequest(null)).toBeNull();
  expect(parsePullRequest("https://github.com/example/acme/pull/123")).toBeNull();
  expect(parsePullRequest([pullRequest])).toBeNull();
});

test("parsePullRequest normalizes the title and accepts every PR state", () => {
  expect(parsePullRequest({ ...pullRequest, title: "  Add\n an  empty   state  " })).toEqual(
    pullRequest,
  );
  expect(parsePullRequest({ ...pullRequest, state: "MERGED" })?.state).toBe("MERGED");
  expect(parsePullRequest({ ...pullRequest, state: "CLOSED" })?.state).toBe("CLOSED");
});

test("parsePullRequest rejects an empty title or an unknown state", () => {
  expect(parsePullRequest({ ...pullRequest, title: "   " })).toBeNull();
  expect(parsePullRequest({ ...pullRequest, title: 123 })).toBeNull();
  expect(parsePullRequest({ ...pullRequest, state: "DRAFT" })).toBeNull();
  expect(parsePullRequest({ ...pullRequest, state: "open" })).toBeNull();
});

test("parsePullRequestList reads the first entry and treats an empty list as no pull request", () => {
  expect(parsePullRequestList([pullRequest])).toEqual(pullRequest);
  expect(parsePullRequestList([])).toBeNull();
  expect(parsePullRequestList(null)).toBeNull();
  expect(parsePullRequestList({})).toBeNull();
  expect(
    parsePullRequestList([{ ...pullRequest, url: "https://example.com/pull/123" }]),
  ).toBeNull();
});
