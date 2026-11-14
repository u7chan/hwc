import { expect, test } from "bun:test";
import type { Template } from "../shared/templates";
import { filterTemplates, insertTemplate, newTemplateId, templatePreview } from "./templates";

const templates: Template[] = [
  { id: "t1", title: "続けて", body: "続けてください。" },
  { id: "t2", title: "テストを流して直す", body: "テストを流して、失敗したものを直してください。" },
  { id: "t3", title: "レビュー指摘に対応", body: "レビューの指摘に対応してください。" },
];

test("an empty query keeps the server order", () => {
  expect(filterTemplates(templates, "").map((template) => template.id)).toEqual(["t1", "t2", "t3"]);
});

test("the query is trimmed and case-insensitive", () => {
  expect(filterTemplates(templates, "  テスト ").map((template) => template.id)).toEqual(["t2"]);
});

test("no match returns an empty list", () => {
  expect(filterTemplates(templates, "デプロイ")).toEqual([]);
});

test("the preview uses the first non-empty line", () => {
  expect(templatePreview("\n\n1 行目\n2 行目\n")).toBe("1 行目");
  expect(templatePreview("  前後の空白  \n次の行")).toBe("前後の空白");
  expect(templatePreview("\n \n")).toBe("");
});

test("inserting into an empty draft uses the body as-is", () => {
  expect(insertTemplate("", 0, 0, "本文")).toEqual({ text: "本文", caret: 2 });
});

test("appending after a paragraph separates it with one blank line", () => {
  expect(insertTemplate("書きかけ", 4, 4, "本文")).toEqual({
    text: "書きかけ\n\n本文",
    caret: 4 + 2 + 2,
  });
});

test("one newline is enough to make a blank line", () => {
  expect(insertTemplate("書きかけ\n", 5, 5, "本文").text).toBe("書きかけ\n\n本文");
});

test("an existing blank line is not doubled", () => {
  expect(insertTemplate("書きかけ\n\n", 6, 6, "本文").text).toBe("書きかけ\n\n本文");
  expect(insertTemplate("前\n\n", 3, 3, "本文").text).toBe("前\n\n本文");
});

test("inserting in the middle keeps the text on both sides apart", () => {
  expect(insertTemplate("前後", 1, 1, "本文").text).toBe("前\n\n本文\n\n後");
});

test("a selection is replaced and the caret goes to the end of the body", () => {
  expect(insertTemplate("前を消す後", 1, 4, "本文")).toEqual({
    text: "前\n\n本文\n\n後",
    caret: 1 + 2 + 2,
  });
});

test("a new id is unique and within the server's alphabet", () => {
  const ids = new Set(Array.from({ length: 20 }, () => newTemplateId()));
  expect(ids.size).toBe(20);
  for (const id of ids) expect(id).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
});
