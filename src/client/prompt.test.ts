import { expect, test } from "bun:test";
import { parsePrompt } from "./prompt";

test("the prompt is the last line, split into user, path and mark", () => {
  expect(parsePrompt("u7dev@wsl:~/workspace/hwc$ ")).toEqual({
    user: "u7dev@wsl",
    path: "~/workspace/hwc",
    mark: "$",
  });
});

test("a prompt without user and host keeps the whole text as the path", () => {
  expect(parsePrompt("[main] ~/hwc $ ")).toEqual({ user: null, path: "[main] ~/hwc", mark: "$" });
});

test("trailing blank lines are skipped", () => {
  expect(parsePrompt("❯ git status\nclean\n❯ \n\n")).toEqual({
    user: null,
    path: "",
    mark: "❯",
  });
});

test("a bare mark is a prompt on its own", () => {
  expect(parsePrompt("❯ ")).toEqual({ user: null, path: "", mark: "❯" });
});

test("the last line without a mark is output, not a prompt", () => {
  expect(parsePrompt("u7dev@wsl:~/hwc$ echo hi\nhi")).toBeNull();
  expect(parsePrompt("pi レビュー待ち")).toBeNull();
});

test("a line too long to be a prompt is treated as output", () => {
  expect(parsePrompt(`echo ${"a".repeat(200)}$`)).toBeNull();
});

test("no output means no prompt", () => {
  expect(parsePrompt(null)).toBeNull();
  expect(parsePrompt("")).toBeNull();
});
