// 文字列を HTML として解釈する経路の禁止は型で保証できないため、限定的なソース検査を残す。
import { test } from "bun:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const PARSER_DIR = fileURLToPath(new URL(".", import.meta.url));
const COMPONENT_PATH = fileURLToPath(new URL("../Markdown.tsx", import.meta.url));

/** DOM 文字列の生成・HTML のパース・DOM の直接操作 */
const FORBIDDEN = [
  "innerHTML",
  "dangerouslySetInnerHTML",
  "DOMParser",
  "document.",
  "window.",
  "eval(",
  "new Function",
];

function stripComments(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
}

function source(path: string): { path: string; code: string } {
  return { path, code: stripComments(readFileSync(path, "utf8")) };
}

const parserFiles = readdirSync(PARSER_DIR, { withFileTypes: true })
  .filter(
    (entry) => entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts"),
  )
  .map((entry) => source(join(PARSER_DIR, entry.name)));
const componentFile = source(COMPONENT_PATH);
const allFiles = [...parserFiles, componentFile];

test("走査対象のソースが空にならない", () => {
  assert.ok(parserFiles.length > 0);
  assert.ok(componentFile.code.length > 0);
});

test("DOM 文字列の生成と HTML のパースを使っていない", () => {
  for (const file of allFiles) {
    for (const token of FORBIDDEN) {
      assert.ok(!file.code.includes(token), `${file.path} に ${token} がある`);
    }
  }
});

test("パーサは相対 import だけで完結する (Node のテストで検証できる)", () => {
  for (const file of parserFiles) {
    const imports = [...file.code.matchAll(/from\s+"([^"]+)"/g)].map((match) => match[1]);
    for (const specifier of imports) {
      assert.ok(specifier.startsWith("./"), `${file.path} が ${specifier} を import している`);
    }
  }
});
