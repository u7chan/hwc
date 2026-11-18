import { expect, test } from "bun:test";
import { fileReference, insertFileReference } from "./file-reference";

test("a file reference is absolute under the workspace", () => {
  expect(fileReference("/work/repo", "src/client/App.tsx", false)).toBe(
    "/work/repo/src/client/App.tsx",
  );
});

test("a directory reference keeps a trailing slash", () => {
  expect(fileReference("/work/repo", "src/client", true)).toBe("/work/repo/src/client/");
});

test("an unknown workspace keeps the tree-relative path", () => {
  expect(fileReference(null, "src/client/App.tsx", false)).toBe("src/client/App.tsx");
});

test("inserting into an empty draft puts the caret after the reference", () => {
  expect(insertFileReference("", 0, 0, "/work/repo/src/a.ts")).toEqual({
    text: "/work/repo/src/a.ts",
    caret: 19,
  });
});

test("a reference added after text is separated by a space", () => {
  expect(insertFileReference("直して ", 4, 4, "/work/repo/src/a.ts")).toEqual({
    text: "直して /work/repo/src/a.ts",
    caret: 23,
  });
});

test("a reference inserted inside a word is separated on both sides", () => {
  expect(insertFileReference("前後", 1, 1, "/work/repo/src/a.ts")).toEqual({
    text: "前 /work/repo/src/a.ts 後",
    caret: 21,
  });
});

test("the selection is replaced by the reference", () => {
  expect(insertFileReference("対象: ここ", 4, 6, "/work/repo/src/a.ts")).toEqual({
    text: "対象: /work/repo/src/a.ts",
    caret: 23,
  });
});

test("a stale selection is clamped to the draft", () => {
  expect(insertFileReference("abc", 10, 12, "/p")).toEqual({ text: "abc /p", caret: 6 });
  expect(insertFileReference("abc", -1, -1, "/p")).toEqual({ text: "/p abc", caret: 2 });
});

test("repeated drops build a space-separated list", () => {
  const first = insertFileReference("見て: ", 4, 4, "/work/repo/a.ts");
  const second = insertFileReference(first.text, first.caret, first.caret, "/work/repo/b.ts");
  expect(second.text).toBe("見て: /work/repo/a.ts /work/repo/b.ts");
});
