import { expect, test } from "bun:test";
import {
  PREVIEW_HIGHLIGHT_MAX_TOKENS,
  isMarkdownPreviewPath,
  normalizePreviewText,
  previewLang,
  previewLineNumbers,
  previewTokens,
  resolvePreviewReference,
} from "./preview-text";

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

test("treats md files as markdown, and only md", () => {
  expect(isMarkdownPreviewPath("README.md")).toBe(true);
  expect(isMarkdownPreviewPath("docs/guide.MD")).toBe(true);
  expect(isMarkdownPreviewPath("docs/notes.markdown")).toBe(false);
  expect(isMarkdownPreviewPath("src/a.md.ts")).toBe(false);
  expect(isMarkdownPreviewPath("README")).toBe(false);
  expect(isMarkdownPreviewPath("Makefile")).toBe(false);
});

test("resolves markdown references against the file directory", () => {
  expect(resolvePreviewReference("image.png", "docs/notes.md")).toBe("docs/image.png");
  expect(resolvePreviewReference("./image.png", "docs/notes.md")).toBe("docs/image.png");
  expect(resolvePreviewReference("../src/a.ts", "docs/notes.md")).toBe("src/a.ts");
  expect(resolvePreviewReference("/src/a.ts", "docs/notes.md")).toBe("src/a.ts");
  expect(resolvePreviewReference("image.png?x=1#top", "notes.md")).toBe("image.png");
  expect(resolvePreviewReference("a%20b.png", "notes.md")).toBe("a b.png");
});

test("leaves external, empty, and escaping references alone", () => {
  expect(resolvePreviewReference("https://example.com/a.png", "notes.md")).toBeNull();
  expect(resolvePreviewReference("mailto:dev@example.com", "notes.md")).toBeNull();
  expect(resolvePreviewReference("//example.com/a.png", "notes.md")).toBeNull();
  expect(resolvePreviewReference("#top", "notes.md")).toBeNull();
  expect(resolvePreviewReference("", "notes.md")).toBeNull();
  expect(resolvePreviewReference("../a.ts", "docs/notes.md")).toBe("a.ts");
  expect(resolvePreviewReference("../../a.ts", "docs/notes.md")).toBeNull();
  expect(resolvePreviewReference("docs/%2E%2E/%2E%2E/a.ts", "notes.md")).toBeNull();
  expect(resolvePreviewReference("a%2Fb.png", "notes.md")).toBeNull();
  expect(resolvePreviewReference("../", "notes.md")).toBeNull();
});

test("detects languages from the extension", () => {
  const cases: [string, string | null][] = [
    ["a.ts", "ts"],
    ["a.tsx", "ts"],
    ["a.js", "ts"],
    ["A.TSX", "ts"],
    ["a.c", "c"],
    ["a.h", "c"],
    ["a.cpp", "cpp"],
    ["a.hpp", "cpp"],
    ["a.java", "java"],
    ["a.go", "go"],
    ["a.rs", "rust"],
    ["dir.v2/a.json", "json"],
    ["dir/a.jsonc", "json"],
    ["a.py", "python"],
    ["a.sh", "bash"],
    ["a.css", "css"],
    ["a.html", "html"],
    ["a.md", "md"],
    ["a.diff", "diff"],
    ["Dockerfile", "bash"],
    ["dockerfile", "bash"],
    ["a.yaml", null],
    ["a.toml", null],
    ["README", null],
    [".gitignore", null],
    ["Dockerfile.dev", null],
    ["a.", null],
    [".ts", null],
    ["a.constructor", null],
    ["a.__proto__", null],
  ];
  for (const [path, lang] of cases) expect(previewLang(path)).toBe(lang);
});

test("highlights a known file without changing the text", () => {
  const source = "const a: number = 1;\n";
  const tokens = previewTokens(source, "src/a.ts");
  expect(tokens).not.toBeNull();
  expect(tokens?.map((token) => token.text).join("")).toBe(source);
  expect(tokens?.some((token) => token.kind === "key")).toBe(true);
});

test("falls back to plain text for unknown files and the token budget", () => {
  expect(previewTokens("x = 1", "README")).toBeNull();
  expect(previewTokens("x = 1", "a.yaml")).toBeNull();
  expect(previewTokens("1;".repeat(PREVIEW_HIGHLIGHT_MAX_TOKENS), "a.ts")).toBeNull();
  expect(previewTokens("1;".repeat(10), "a.ts")).not.toBeNull();
});
