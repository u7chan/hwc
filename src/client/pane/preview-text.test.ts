import { expect, test } from "bun:test";
import { normalizePreviewText, previewLineNumbers } from "./preview-text";

test("numbers logical lines without counting the final newline", () => {
  expect(previewLineNumbers("")).toBe("");
  expect(previewLineNumbers("one")).toBe("1");
  expect(previewLineNumbers("one\n")).toBe("1");
  expect(previewLineNumbers("one\ntwo")).toBe("1\n2");
  expect(previewLineNumbers("one\ntwo\n")).toBe("1\n2");
  expect(previewLineNumbers("one\n\n")).toBe("1\n2");
  expect(previewLineNumbers("\n")).toBe("1");
  expect(previewLineNumbers("\n\n")).toBe("1\n2");
});

test("normalizes CRLF and CR to LF", () => {
  expect(normalizePreviewText("a\r\nb\rc")).toBe("a\nb\nc");
});
