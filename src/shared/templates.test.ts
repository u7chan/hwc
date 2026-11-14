import { expect, test } from "bun:test";
import {
  characterCount,
  MAX_TEMPLATES,
  normalizeTemplate,
  parseStoredTemplates,
  parseTemplates,
  type Template,
} from "./templates";

const template = (overrides: Partial<Template> = {}): Template => ({
  id: "t1",
  title: "テストを流す",
  body: "テストを流してください。",
  ...overrides,
});

test("normalizes a title to one line and trims the body", () => {
  expect(
    normalizeTemplate({
      id: "t1",
      title: "  テストを\n 流す  ",
      body: "\n  テストを流してください。\n\n",
    }),
  ).toEqual({ id: "t1", title: "テストを 流す", body: "テストを流してください。" });
});

test("normalizes CRLF in the body", () => {
  expect(normalizeTemplate({ id: "t1", title: "a", body: "1行目\r\n2行目" })?.body).toBe(
    "1行目\n2行目",
  );
});

test("refuses a template without a usable id, title, or body", () => {
  expect(normalizeTemplate(null)).toBeNull();
  expect(normalizeTemplate({ id: "", title: "a", body: "b" })).toBeNull();
  expect(normalizeTemplate({ id: "has space", title: "a", body: "b" })).toBeNull();
  expect(normalizeTemplate({ id: "t1", title: "   ", body: "b" })).toBeNull();
  expect(normalizeTemplate({ id: "t1", title: "a", body: "   " })).toBeNull();
  expect(
    normalizeTemplate({ id: "t1", title: "a", body: "改行\n以外の\u0007制御文字" }),
  ).toBeNull();
});

test("refuses values over the limits", () => {
  expect(normalizeTemplate({ id: "t1", title: "あ".repeat(41), body: "b" })).toBeNull();
  expect(normalizeTemplate({ id: "t1", title: "a", body: "あ".repeat(2001) })).toBeNull();
  expect(normalizeTemplate({ id: "t1", title: "あ".repeat(40), body: "あ".repeat(2000) })).not.toBe(
    null,
  );
});

test("counts code points, not UTF-16 units", () => {
  expect(characterCount("あいう")).toBe(3);
  expect(characterCount("🙂")).toBe(1);
});

test("accepts a list of valid templates", () => {
  expect(parseTemplates([template()])).toEqual([template()]);
  expect(parseTemplates([])).toEqual([]);
});

test("refuses a list with a broken entry or a duplicate id", () => {
  expect(parseTemplates([template(), { ...template(), title: "" }])).toBeNull();
  expect(parseTemplates([template(), template({ title: "別の名前" })])).toBeNull();
  expect(parseTemplates({ templates: [template()] })).toBeNull();
});

test("refuses more templates than the limit", () => {
  const many = Array.from({ length: MAX_TEMPLATES + 1 }, (_, index) =>
    template({ id: `t${index}` }),
  );
  expect(parseTemplates(many)).toBeNull();
});

test("a stored file drops only the broken entries and stops at the limit", () => {
  expect(parseStoredTemplates(null)).toEqual([]);
  expect(parseStoredTemplates("not an array")).toEqual([]);
  expect(
    parseStoredTemplates([template(), { id: "bad id" }, template({ title: "別の名前" }), null]),
  ).toEqual([template()]);

  const many = Array.from({ length: MAX_TEMPLATES + 5 }, (_, index) =>
    template({ id: `t${index}` }),
  );
  expect(parseStoredTemplates(many)).toHaveLength(MAX_TEMPLATES);
});
