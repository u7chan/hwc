import { expect, test } from "bun:test";
import { highlightCode, normalizeLang, type Token, type TokenKind } from "./highlight";

const KINDS: TokenKind[] = ["key", "str", "num", "com", "fn", "type", "op", "plain"];

const SAMPLES: Record<string, string> = {
  ts: 'export function parseMarkdown(input: string): MdBlock[] {\n  // 純関数\n  return scanBlocks(input.split(/\\r?\\n/), "tsx", 1.5);\n}\n',
  c: '#include <stdio.h>\n\n/* 配列を並べ替える */\nvoid sort(int *a, size_t n) {\n  for (size_t i = 0; i < n; i++) printf("%d\\n", a[i]);\n}\n',
  cpp: "#include <vector>\n\nclass Box final {\npublic:\n  explicit Box(std::vector<int> values) : values_(std::move(values)) {}\n\nprivate:\n  std::vector<int> values_;\n};\n",
  java: "import java.util.List;\n\npublic final class Box<T> {\n  private final List<T> values; // 値\n\n  Box(List<T> values) {\n    this.values = values;\n  }\n}\n",
  go: 'package main\n\nimport "fmt"\n\nfunc main() {\n\tvalues := []int{1, 2, 3}\n\tfor i, v := range values {\n\t\tfmt.Println(i, v)\n\t}\n}\n',
  rust: "use std::collections::HashMap;\n\n/// 数を数える\nfn count(values: &[u32]) -> HashMap<u32, usize> {\n    let mut counts = HashMap::new();\n    for value in values {\n        *counts.entry(*value).or_insert(0) += 1;\n    }\n    counts\n}\n",
  json: '{\n  "name": "gui",\n  "count": 12,\n  "ok": true,\n  "none": null\n}\n',
  yaml: '# 設定\nname: acme-dashboard\non: push\njobs:\n  build:\n    runs-on: ubuntu-latest\n    env:\n      CI: true\n      RETRIES: 3\n    script: |\n      echo "$HOME"\n      exit 0\n',
  bash: '# 実行\nbun test -- --test-name-pattern preview\ngit switch -c "feat/x"\necho $HOME > out.txt\n',
  python: 'import os\n\n\ndef main(x: int) -> str:\n    """doc"""\n    return f"{x}"  # 文字列\n',
  css: "/* テーマ */\n.md h1, #id .cls:hover {\n  color: var(--c-ink);\n  width: 12.5rem;\n}\n",
  html: "<!-- コメント -->\n<div class=\"a\" data-x='1'><br>text</div>\n",
  diff: "--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,3 +1,3 @@\n-old\n+new\n context\n",
  md: "# 見出し\n\n**強調**と `code`、[link](https://example.com)\n",
};

const tokensOf = (kind: TokenKind, tokens: Token[] | null) =>
  (tokens ?? []).filter((token) => token.kind === kind);

test("every supported language keeps the input intact", () => {
  for (const [lang, source] of Object.entries(SAMPLES)) {
    const tokens = highlightCode(source, lang, 100_000);
    expect(tokens).not.toBeNull();
    expect(tokens?.map((token) => token.text).join("")).toBe(source);
    expect(tokens?.every((token) => token.text !== "")).toBe(true);
    expect(tokens?.every((token) => KINDS.includes(token.kind))).toBe(true);
  }
});

test("TypeScript separates keywords, functions, strings, comments, numbers and types", () => {
  const tokens = highlightCode(SAMPLES.ts, "ts", 100_000);
  expect(tokensOf("key", tokens).map((token) => token.text)).toEqual([
    "export",
    "function",
    "return",
  ]);
  expect(tokensOf("fn", tokens).map((token) => token.text)).toEqual([
    "parseMarkdown",
    "scanBlocks",
    "split",
  ]);
  expect(tokensOf("str", tokens).some((token) => token.text.includes("tsx"))).toBe(true);
  expect(tokensOf("com", tokens).map((token) => token.text)).toEqual(["// 純関数"]);
  expect(tokensOf("num", tokens).map((token) => token.text)).toEqual(["1.5"]);
  expect(tokensOf("type", tokens).map((token) => token.text)).toEqual(["string", "MdBlock"]);
});

test("C separates the preprocessor, keywords, types, macros and comments", () => {
  const tokens = highlightCode(
    "#include <stdio.h>\n\n/* 配列を並べ替える */\nvoid sort(int *a, size_t n) {\n  FILE *out = NULL;\n}\n",
    "c",
    100_000,
  );
  expect(tokensOf("key", tokens).map((token) => token.text)).toEqual(["#include", "void", "int"]);
  expect(tokensOf("fn", tokens).map((token) => token.text)).toEqual(["sort"]);
  expect(tokensOf("type", tokens).map((token) => token.text)).toEqual(["size_t", "FILE", "NULL"]);
  expect(tokensOf("com", tokens).map((token) => token.text)).toEqual(["/* 配列を並べ替える */"]);
});

test("JSON tells keys from string values and highlights literals", () => {
  const tokens = highlightCode(SAMPLES.json, "json", 100_000);
  expect(tokensOf("key", tokens).map((token) => token.text)).toEqual([
    '"name"',
    '"count"',
    '"ok"',
    "true",
    '"none"',
    "null",
  ]);
  expect(tokensOf("str", tokens).map((token) => token.text)).toEqual(['"gui"']);
});

test("YAML tells keys from values and keeps block scalars whole", () => {
  const tokens = highlightCode(SAMPLES.yaml, "yaml", 100_000);
  expect(tokensOf("key", tokens).map((token) => token.text)).toEqual([
    "name",
    "on",
    "jobs",
    "build",
    "runs-on",
    "env",
    "CI",
    "RETRIES",
    "script",
  ]);
  expect(tokensOf("str", tokens).map((token) => token.text)).toEqual([
    "acme-dashboard",
    "push",
    "ubuntu-latest",
    '|\n      echo "$HOME"\n      exit 0\n',
  ]);
  expect(tokensOf("com", tokens).map((token) => token.text)).toEqual(["# 設定"]);
  expect(tokensOf("type", tokens).map((token) => token.text)).toEqual(["true"]);
  expect(tokensOf("num", tokens).map((token) => token.text)).toEqual(["3"]);
});

test("YAML quoted keys, anchors, tags and flow collections", () => {
  const source =
    'quoted: "a: b"\n"key: with colon": 1\nbase: &base\ntagged: !!str value\nflow: { a: 1, b: [x, y] }\nnulls: ~\n';
  const tokens = highlightCode(source, "yaml", 100_000);
  expect(tokens?.map((token) => token.text).join("")).toBe(source);
  expect(tokensOf("key", tokens).map((token) => token.text)).toEqual([
    "quoted",
    '"key: with colon"',
    "base",
    "tagged",
    "flow",
    "a",
    "b",
    "nulls",
  ]);
  expect(tokensOf("str", tokens).map((token) => token.text)).toEqual(['"a: b"', "value", "x", "y"]);
  expect(tokensOf("type", tokens).map((token) => token.text)).toEqual(["&base", "!!str", "~"]);
  expect(tokensOf("num", tokens).map((token) => token.text)).toEqual(["1", "1"]);
});

test("bash colors the command at the line head and options", () => {
  const tokens = highlightCode(SAMPLES.bash, "bash", 100_000);
  expect(tokensOf("fn", tokens).map((token) => token.text)).toEqual(["bun", "git", "echo"]);
  expect(tokensOf("com", tokens)).toEqual([{ kind: "com", text: "# 実行" }]);
  expect(tokensOf("op", tokens).some((token) => token.text === "--test-name-pattern")).toBe(true);
  expect(tokensOf("type", tokens).some((token) => token.text === "$HOME")).toBe(true);
});

test("HTML separates tags, attributes and attribute values", () => {
  const tokens = highlightCode(SAMPLES.html, "html", 100_000);
  expect(tokensOf("key", tokens).map((token) => token.text)).toEqual(["<div", "<br", "</div"]);
  expect(tokensOf("com", tokens).map((token) => token.text)).toEqual(["<!-- コメント -->"]);
  expect(tokensOf("type", tokens).map((token) => token.text)).toEqual(["class", "data-x"]);
  expect(tokensOf("str", tokens).map((token) => token.text)).toEqual(['"a"', "'1'"]);
});

test("diff colors additions, deletions and hunks line by line", () => {
  const tokens = highlightCode(SAMPLES.diff, "diff", 100_000);
  expect(tokensOf("str", tokens).map((token) => token.text)).toEqual(["+new"]);
  expect(tokensOf("type", tokens).map((token) => token.text)).toEqual(["-old"]);
  expect(tokensOf("key", tokens).map((token) => token.text)).toEqual(["@@ -1,3 +1,3 @@"]);
});

test("single quotes stay contextual for Rust, C, C++ and TypeScript", () => {
  const strings = (source: string, lang: string) =>
    tokensOf("str", highlightCode(source, lang, 100_000)).map((token) => token.text);

  const rust = highlightCode("fn f<'a, 'b>(x: &'a str, y: &'b str) {}\n", "rust", 100_000);
  expect(tokensOf("str", rust)).toEqual([]);
  expect(tokensOf("type", rust).map((token) => token.text)).toEqual(["str", "str"]);

  for (const source of ["'a'", "'\\n'", "'\\''", "'\\\\'", "'\\x41'", "'\\u{1F600}'", "'😀'"]) {
    expect(strings(source, "rust")).toEqual([source]);
  }
  for (const source of ["'a'", "'\\n'", "'\\''", "'\\\\'", "'\\x41'", "'\\101'", "'ab'"]) {
    expect(strings(source, "c")).toEqual([source]);
    expect(strings(source, "cpp")).toEqual([source]);
  }
  for (const source of ["1'000", "1'2'3", "0x1'0000", "0b1'0101", "1.5'000"]) {
    expect(
      tokensOf("num", highlightCode(source, "cpp", 100_000)).map((token) => token.text),
    ).toEqual([source]);
    expect(strings(source, "cpp")).toEqual([]);
  }
  for (const source of ["1e1'0", "1.2e+1'0", "1'000e1'000", "0x1p1'0", "0x1.8p1'0"]) {
    expect(
      tokensOf("num", highlightCode(source, "cpp", 100_000)).map((token) => token.text),
    ).toEqual([source]);
    expect(strings(source, "cpp")).toEqual([]);
  }
  for (const source of ["'\\u{41}'", "'\\u{1F600}'", "'\\u{0000_41}'", "'\\u{10_FFFF}'"]) {
    expect(strings(source, "rust")).toEqual([source]);
  }
  expect(strings("const a = 'ab';", "ts")).toEqual(["'ab'"]);
  expect(strings("String a = 'ab';", "java")).toEqual(["'ab'"]);
});

test("aliases resolve to the same rules", () => {
  const source = "const a: number = 1;\n";
  const base = highlightCode(source, "ts", 100_000);
  for (const alias of ["tsx", "typescript", "js", "jsx", "javascript", "mjs", "cjs"]) {
    expect(highlightCode(source, alias, 100_000)).toEqual(base);
  }
  const cSource = "#include <stdio.h>\nint main(void) { return 0; }\n";
  expect(highlightCode(cSource, "h", 100_000)).toEqual(highlightCode(cSource, "c", 100_000));
  const cppSource = "class Box final {\npublic:\n  int v = 0;\n};\n";
  for (const alias of ["c++", "cc", "cxx", "hh", "hpp", "hxx"]) {
    expect(highlightCode(cppSource, alias, 100_000)).toEqual(
      highlightCode(cppSource, "cpp", 100_000),
    );
  }
  const goSource = "func main() {\n\tfmt.Println(len(os.Args))\n}\n";
  expect(highlightCode(goSource, "golang", 100_000)).toEqual(
    highlightCode(goSource, "go", 100_000),
  );
  const rustSource = "pub fn count(v: &[u32]) -> usize { v.len() }\n";
  expect(highlightCode(rustSource, "rs", 100_000)).toEqual(
    highlightCode(rustSource, "rust", 100_000),
  );
  expect(normalizeLang("sh")).toBe("bash");
  expect(normalizeLang("YML")).toBe("yaml");
  expect(normalizeLang("xml")).toBe("html");
  expect(normalizeLang("patch")).toBe("diff");
  expect(normalizeLang("markdown")).toBe("md");
  expect(normalizeLang("  .TS  ")).toBe("ts");
});

test("unknown languages and the token budget fall back to plain text", () => {
  expect(highlightCode("x = 1", "mermaid", 100_000)).toBeNull();
  expect(highlightCode("x = 1", null, 100_000)).toBeNull();
  expect(highlightCode("x = 1", "{unknown}", 100_000)).toBeNull();
  expect(highlightCode("1;".repeat(10), "ts", 5)).toBeNull();
  expect(highlightCode("1;".repeat(10), "ts", 100)).not.toBeNull();
  expect(highlightCode("+a\n+b\n+c\n", "diff", 2)).toBeNull();
});

test("pathological delimiter runs do not scan to the end of the input", () => {
  // 区切り文字の無い塊。規則の量化子を有限にしていないと、1 文字ごとに末尾まで走査して
  // 二次関数的に遅くなる（256KB の md で 20 秒超）。ここでは打ち切りと上限で止まることを見る。
  const budget = 20_000;
  expect(highlightCode("[".repeat(256 * 1024), "md", budget)).toBeNull();
  expect(highlightCode("9".repeat(256 * 1024), "md", budget)).toBeNull();
  expect(highlightCode("${".repeat(128 * 1024), "bash", budget)).toBeNull();
  expect(highlightCode("<!a ".repeat(64 * 1024), "html", budget)).toBeNull();
  expect(highlightCode("ab.".repeat(85 * 1024), "html", budget)).not.toBeNull();
});

test("Object.prototype names are not languages", () => {
  for (const lang of ["constructor", "__proto__", "toString", "hasOwnProperty", "valueOf"]) {
    expect(highlightCode("const a = 1;", lang, 100_000)).toBeNull();
  }
});

test("empty code stays empty without throwing", () => {
  expect(highlightCode("", "ts", 100_000)).toEqual([]);
  expect(highlightCode("", "diff", 100_000)).toEqual([]);
});

test("every colored token kind has a style rule", async () => {
  const css = await Bun.file("src/client/styles/parts/tree.css").text();
  const colored = KINDS.filter((kind) => kind !== "plain" && kind !== "op");
  expect(colored.filter((kind) => !css.includes(`.hwc-tok-${kind}`))).toEqual([]);
});

test("unterminated constructs do not throw", () => {
  for (const source of ["/*", "`unterminated", '"unterminated', "'''", "\\", "'", "😀"]) {
    expect(() => highlightCode(source, "ts", 100_000)).not.toThrow();
    expect(() => highlightCode(source, "python", 100_000)).not.toThrow();
  }
});
