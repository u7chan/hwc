import { expect, test } from "bun:test";
import { parseProjectList } from "./projects";

test("accepts a complete project list", () => {
  expect(
    parseProjectList({
      projects: [
        { name: "api", path: "packages/api" },
        { name: "web", path: "apps/web" },
      ],
      truncated: false,
    }),
  ).toEqual({
    projects: [
      { name: "api", path: "packages/api" },
      { name: "web", path: "apps/web" },
    ],
    truncated: false,
  });
});

test("rejects a list with a path that can escape the working directory", () => {
  expect(
    parseProjectList({
      projects: [{ name: "outside", path: "../outside" }],
      truncated: false,
    }),
  ).toBeNull();
});

test("rejects the working directory itself", () => {
  expect(
    parseProjectList({
      projects: [{ name: "root", path: "." }],
      truncated: false,
    }),
  ).toBeNull();
});

test("rejects an entry with an absolute path", () => {
  expect(
    parseProjectList({
      projects: [{ name: "outside", path: "/tmp/outside" }],
      truncated: false,
    }),
  ).toBeNull();
});

test("rejects a partial entry instead of dropping it", () => {
  expect(
    parseProjectList({
      projects: [{ name: "api" }],
      truncated: false,
    }),
  ).toBeNull();
});

test("rejects a malformed envelope", () => {
  expect(parseProjectList(null)).toBeNull();
  expect(parseProjectList({ projects: [] })).toBeNull();
  expect(parseProjectList({ projects: [], truncated: "no" })).toBeNull();
});
