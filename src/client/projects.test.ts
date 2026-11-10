import { expect, test } from "bun:test";
import { filterProjects, insertProjectPath, projectInsertion } from "./projects";

const projects = [
  { name: "api", path: "packages/api" },
  { name: "web", path: "apps/web" },
  { name: "web-tools", path: "tools/web-tools" },
  { name: "core", path: "packages/web/core" },
  { name: "ui", path: "tools/ui" },
];

test("an empty query keeps the server order", () => {
  expect(filterProjects(projects, "").map((project) => project.path)).toEqual([
    "packages/api",
    "apps/web",
    "tools/web-tools",
    "packages/web/core",
    "tools/ui",
  ]);
});

test("an exact directory name comes first", () => {
  expect(filterProjects(projects, "web")[0]?.path).toBe("apps/web");
});

test("a name prefix comes before a name substring", () => {
  expect(filterProjects(projects, "web").map((project) => project.name)).toEqual([
    "web",
    "web-tools",
    "core",
  ]);
});

test("a path match is ranked after every name match", () => {
  expect(filterProjects(projects, "tools").map((project) => project.path)).toEqual([
    "tools/web-tools",
    "tools/ui",
  ]);
});

test("the query is trimmed and case-insensitive", () => {
  expect(filterProjects(projects, "  API ").map((project) => project.name)).toEqual(["api"]);
});

test("no match returns an empty list", () => {
  expect(filterProjects(projects, "missing")).toEqual([]);
});

test("the visible list is capped", () => {
  const many = Array.from({ length: 60 }, (_, index) => ({
    name: `p${index}`,
    path: `p${index}`,
  }));
  expect(filterProjects(many, "", 50)).toHaveLength(50);
});

test("insertion uses a relative directory with a trailing slash", () => {
  expect(projectInsertion("packages/api")).toBe("./packages/api/");
});

test("insertion at the start leaves no leading space", () => {
  expect(insertProjectPath("直してください", 0, 0, "packages/api")).toEqual({
    text: "./packages/api/ 直してください",
    caret: "./packages/api/".length,
  });
});

test("insertion between words adds spaces around the path", () => {
  expect(insertProjectPath("直して ください", 3, 3, "packages/api")).toEqual({
    text: "直して ./packages/api/ ください",
    caret: "直して ./packages/api/".length,
  });
});

test("insertion replaces the selected text", () => {
  expect(insertProjectPath("直して", 0, 3, "packages/api")).toEqual({
    text: "./packages/api/",
    caret: "./packages/api/".length,
  });
});

test("insertion after whitespace does not duplicate the space", () => {
  expect(insertProjectPath("直して ", 4, 4, "packages/api")).toEqual({
    text: "直して ./packages/api/",
    caret: "直して ./packages/api/".length,
  });
});
