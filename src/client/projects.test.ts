import { expect, test } from "bun:test";
import {
  filterProjects,
  highlightedProject,
  insertProjectPath,
  projectInsertion,
  projectMention,
  stepProject,
} from "./projects";

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

test("an @ at the start of the draft opens a mention", () => {
  expect(projectMention("@", 1)).toEqual({ start: 0, end: 1, query: "" });
  expect(projectMention("@web", 4)).toEqual({ start: 0, end: 4, query: "web" });
});

test("an @ after whitespace or a newline opens a mention", () => {
  expect(projectMention("直して @we", 7)).toEqual({ start: 4, end: 7, query: "we" });
  expect(projectMention("直して\n@we", 7)).toEqual({ start: 4, end: 7, query: "we" });
});

test("an @ inside a word is not a mention", () => {
  // メールアドレスや、npm のスコープ付きパッケージの途中。
  expect(projectMention("a@example.com", 13)).toBeNull();
  expect(projectMention("foo@", 4)).toBeNull();
});

test("the mention ends at the caret and keeps the text after it", () => {
  expect(projectMention("@web 直して", 4)).toEqual({ start: 0, end: 4, query: "web" });
  expect(projectMention("@web 直して", 2)).toEqual({ start: 0, end: 2, query: "w" });
});

test("no mention is open once the caret leaves the word", () => {
  expect(projectMention("@web ", 5)).toBeNull();
  expect(projectMention("@web 直して", 6)).toBeNull();
  expect(projectMention("", 0)).toBeNull();
});

test("a caret past the end of the draft is clamped", () => {
  // 下書きが切り替わった直後に、古いキャレット位置が残っていても落ちない。
  expect(projectMention("@w", 10)).toEqual({ start: 0, end: 2, query: "w" });
});

test("picking a mention replaces the @ word with the project path", () => {
  const mention = projectMention("直して @we を", 7);
  expect(mention).not.toBeNull();
  expect(insertProjectPath("直して @we を", mention!.start, mention!.end, "apps/web")).toEqual({
    text: "直して ./apps/web/ を",
    caret: "直して ./apps/web/".length,
  });
});

test("picking at the end of the draft adds no trailing space", () => {
  expect(insertProjectPath("@we", 0, 3, "apps/web")).toEqual({
    text: "./apps/web/",
    caret: "./apps/web/".length,
  });
});

test("the first candidate is highlighted until one is chosen", () => {
  expect(highlightedProject(projects, null)?.path).toBe("packages/api");
  expect(highlightedProject(projects, "tools/ui")?.path).toBe("tools/ui");
  expect(highlightedProject([], null)).toBeNull();
});

test("a highlight that was filtered out falls back to the first candidate", () => {
  expect(highlightedProject(projects, "gone/away")?.path).toBe("packages/api");
});

test("stepping wraps around both ends of the candidates", () => {
  const paths = projects.map((project) => project.path);
  expect(stepProject(projects, null, 1)).toBe(paths[1]!);
  expect(stepProject(projects, paths[4]!, 1)).toBe(paths[0]!);
  expect(stepProject(projects, null, -1)).toBe(paths[4]!);
  expect(stepProject([], null, 1)).toBeNull();
});
