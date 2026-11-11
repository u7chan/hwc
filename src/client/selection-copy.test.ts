import { expect, test } from "bun:test";
import { fenceFor, inlineCode, listMarker, markdownLink } from "./selection-copy";

test("a plain code block uses three backticks", () => {
  expect(fenceFor("const a = 1;\nconst b = 2;")).toBe("```");
});

test("a code block with its own fence gets a longer fence", () => {
  expect(fenceFor("```\ncode\n```")).toBe("````");
  expect(fenceFor("  ```ts\ncode\n  ```")).toBe("````");
});

test("inline code uses a delimiter longer than any backtick run", () => {
  expect(inlineCode("const a = 1;")).toBe("`const a = 1;`");
  expect(inlineCode("a `b` c")).toBe("``a `b` c``");
});

test("inline code pads a leading or trailing backtick", () => {
  expect(inlineCode("`code`")).toBe("`` `code` ``");
});

test("a link keeps its title and escapes the quote", () => {
  expect(markdownLink("例", "https://example.com/", null)).toBe("[例](https://example.com/)");
  expect(markdownLink("例", "https://example.com/", '題 "名"')).toBe(
    '[例](https://example.com/ "題 \\"名\\"")',
  );
  expect(markdownLink("例", "", null)).toBe("例");
});

test("list markers keep the ordered number and task state", () => {
  expect(listMarker(false, 1, null)).toBe("- ");
  expect(listMarker(true, 3, null)).toBe("3. ");
  expect(listMarker(false, 1, false)).toBe("- [ ] ");
  expect(listMarker(true, 3, true)).toBe("3. [x] ");
});
