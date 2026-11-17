import { expect, test } from "bun:test";
import {
  PREVIEW_HIGHLIGHT_MAX_TOKENS,
  normalizePreviewText,
  previewLang,
  previewLineNumbers,
  previewTokens,
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
