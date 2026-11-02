// ブロック解析の契約: 見出し / 段落 / リスト / 引用 / 表 / コードフェンス / 未終端 / CRLF / 空行。
// 解析は例外を投げず、解釈できない行は段落 (原文) として残すことも固定する。
import { test } from "bun:test";
import assert from "node:assert/strict";
import { MARKDOWN_MAX_LENGTH, parseMarkdown } from "./parse";

test("見出しはレベルと本文を持つ", () => {
  assert.deepEqual(parseMarkdown("## 実装方針\n###### 小見出し"), [
    { kind: "heading", level: 2, source: "実装方針" },
    { kind: "heading", level: 6, source: "小見出し" },
  ]);
});

test("# の後に空白が無い行は見出しにしない", () => {
  assert.deepEqual(parseMarkdown("#hashtag"), [{ kind: "paragraph", source: "#hashtag" }]);
});

test("段落は空行で分かれ、段落内の改行はそのまま残る", () => {
  assert.deepEqual(parseMarkdown("1 行目\n2 行目\n\n次の段落"), [
    { kind: "paragraph", source: "1 行目\n2 行目" },
    { kind: "paragraph", source: "次の段落" },
  ]);
});

test("CRLF と CR も行区切りとして扱う", () => {
  assert.deepEqual(parseMarkdown("# 見出し\r\n本文\r\n"), [
    { kind: "heading", level: 1, source: "見出し" },
    { kind: "paragraph", source: "本文" },
  ]);
});

test("空文字と空行だけの入力は空のブロック列になる", () => {
  assert.deepEqual(parseMarkdown(""), []);
  assert.deepEqual(parseMarkdown("\n\n   \n"), []);
});

test("箇条書き / 番号付きリストは開始番号と項目を持つ", () => {
  assert.deepEqual(parseMarkdown("- a\n- b"), [
    {
      kind: "list",
      ordered: false,
      start: 1,
      items: [{ source: "a" }, { source: "b" }],
    },
  ]);
  assert.deepEqual(parseMarkdown("3. c\n4. d"), [
    {
      kind: "list",
      ordered: true,
      start: 3,
      items: [{ source: "c" }, { source: "d" }],
    },
  ]);
});

test("入れ子のリストは項目の本文に入り、描画側が再帰的に解析する", () => {
  assert.deepEqual(parseMarkdown("- 親\n  - 子\n    - 孫\n- 次"), [
    {
      kind: "list",
      ordered: false,
      start: 1,
      items: [{ source: "親\n- 子\n  - 孫" }, { source: "次" }],
    },
  ]);
});

test("タスクリストの記号は項目の本文として残る", () => {
  assert.deepEqual(parseMarkdown("- [x] 済み\n- [ ] 未了"), [
    {
      kind: "list",
      ordered: false,
      start: 1,
      items: [{ source: "[x] 済み" }, { source: "[ ] 未了" }],
    },
  ]);
});

test("項目内の空行とコードフェンスは項目の中に残る", () => {
  assert.deepEqual(parseMarkdown("- 前\n\n  ```ts\n  const a = 1;\n  ```"), [
    {
      kind: "list",
      ordered: false,
      start: 1,
      items: [{ source: "前\n\n```ts\nconst a = 1;\n```" }],
    },
  ]);
});

test("項目の間の空行は 1 つのリストとして扱う", () => {
  const blocks = parseMarkdown("- a\n\n- b");
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].kind, "list");
});

test("インデントの無い行はリストの外に出る", () => {
  assert.deepEqual(parseMarkdown("- a\n続きの段落"), [
    { kind: "list", ordered: false, start: 1, items: [{ source: "a" }] },
    { kind: "paragraph", source: "続きの段落" },
  ]);
});

test("引用は > を外した本文を持つ", () => {
  assert.deepEqual(parseMarkdown("> 1 行目\n> 2 行目\n\n外"), [
    { kind: "quote", source: "1 行目\n2 行目" },
    { kind: "paragraph", source: "外" },
  ]);
});

test("表は整列指定つきのセルに分解する", () => {
  assert.deepEqual(
    parseMarkdown(
      "| 記法 | 対応 | 備考 |\n| --- | :---: | ---: |\n| 数式 | ✓ | `\\frac` |\n| 図 | ✓ | flowchart |",
    ),
    [
      {
        kind: "table",
        align: ["left", "center", "right"],
        header: ["記法", "対応", "備考"],
        rows: [
          ["数式", "✓", "`\\frac`"],
          ["図", "✓", "flowchart"],
        ],
      },
    ],
  );
});

test("区切り行の列数が合わない表は段落として残す", () => {
  assert.deepEqual(parseMarkdown("| a | b |\n| --- |"), [
    { kind: "paragraph", source: "| a | b |\n| --- |" },
  ]);
});

test("エスケープしたパイプはセルの文字として扱う", () => {
  const blocks = parseMarkdown("| a | b |\n| --- | --- |\n| x \\| y | z |");
  assert.deepEqual(blocks[0].kind === "table" ? blocks[0].rows[0] : [], ["x | y", "z"]);
});

test("水平線は hr になる", () => {
  assert.deepEqual(parseMarkdown("---\n\n***\n\n___"), [
    { kind: "hr" },
    { kind: "hr" },
    { kind: "hr" },
  ]);
});

test("コードフェンスは言語と中身を取り出し、中は解釈しない", () => {
  assert.deepEqual(parseMarkdown('```ts title="a"\n# 見出しではない\n**強調でもない**\n```'), [
    { kind: "code", lang: "ts", text: "# 見出しではない\n**強調でもない**", closed: true },
  ]);
});

test("言語なしのフェンスは lang=null になる", () => {
  assert.deepEqual(parseMarkdown("```\nx\n```"), [
    { kind: "code", lang: null, text: "x", closed: true },
  ]);
});

test("未終端フェンスは closed=false で残りを本文にする", () => {
  assert.deepEqual(parseMarkdown("```ts\nconst a = 1;\n"), [
    { kind: "code", lang: "ts", text: "const a = 1;\n", closed: false },
  ]);
});

test("本文の上限は 200KB で描画側と共有する", () => {
  assert.equal(MARKDOWN_MAX_LENGTH, 200 * 1024);
});

test("壊れた入力でも例外を投げない", () => {
  const inputs = [
    "",
    "```",
    "|",
    ">",
    "- ",
    "[",
    "<b",
    "\u0000",
    "\n".repeat(10),
    "> > > x",
    "- - - -",
    "|a|\n|-|",
    "######",
    "***",
  ];
  for (const input of inputs) {
    assert.doesNotThrow(() => parseMarkdown(input), JSON.stringify(input));
  }
});
