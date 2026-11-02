// インライン解析の契約: 強調の入れ子 / コードスパン / リンク / 自動リンク / エスケープ / 改行。
// 解釈できない記法は削除せず literal (原文) として残すことも固定する。
import { test } from "bun:test";
import assert from "node:assert/strict";
import { parseInline } from "./inline";

const text = (value: string) => ({ kind: "text" as const, text: value });

test("強調は strong / em / del に分かれる", () => {
  assert.deepEqual(parseInline("**太字**"), [{ kind: "strong", children: [text("太字")] }]);
  assert.deepEqual(parseInline("*斜体*"), [{ kind: "em", children: [text("斜体")] }]);
  assert.deepEqual(parseInline("~~取消~~"), [{ kind: "del", children: [text("取消")] }]);
});

test("強調は入れ子になる", () => {
  assert.deepEqual(parseInline("**a *b* c**"), [
    { kind: "strong", children: [text("a "), { kind: "em", children: [text("b")] }, text(" c")] },
  ]);
  assert.deepEqual(parseInline("***x***"), [
    { kind: "strong", children: [{ kind: "em", children: [text("x")] }] },
  ]);
});

test("演算子や snake_case を強調と誤認しない", () => {
  assert.deepEqual(parseInline("2 * 3 * 4"), [text("2 * 3 * 4")]);
  assert.deepEqual(parseInline("snake_case_name と _em_"), [
    text("snake_case_name と "),
    { kind: "em", children: [text("em")] },
  ]);
});

test("閉じの無い強調は原文のまま残す", () => {
  assert.deepEqual(parseInline("**閉じない"), [text("**閉じない")]);
  assert.deepEqual(parseInline("a ~~ b"), [text("a ~~ b")]);
});

test("コードスパンはバックティックの数が合う閉じを取る", () => {
  assert.deepEqual(parseInline("`code`"), [{ kind: "code", text: "code" }]);
  assert.deepEqual(parseInline("``a ` b``"), [{ kind: "code", text: "a ` b" }]);
  assert.deepEqual(parseInline("` 余白 `"), [{ kind: "code", text: "余白" }]);
  assert.deepEqual(parseInline("`閉じない"), [text("`閉じない")]);
});

test("コードスパンの中は他の記法として解釈しない", () => {
  assert.deepEqual(parseInline("`**not bold**`"), [{ kind: "code", text: "**not bold**" }]);
});

test("エスケープした記号は文字として扱う", () => {
  assert.deepEqual(parseInline("\\*not em\\*"), [text("*not em*")]);
  assert.deepEqual(parseInline("\\`code\\`"), [text("`code`")]);
});

test("末尾のバックスラッシュはエスケープせず原文のまま残す", () => {
  // 見出し / 引用 / リスト項目 / 表セルの本文もこの解析を通る
  assert.deepEqual(parseInline("Windows のパスは C:\\"), [text("Windows のパスは C:\\")]);
  assert.deepEqual(parseInline("末尾\\"), [text("末尾\\")]);
  assert.deepEqual(parseInline("a\\b"), [text("a\\b")]);
  // エスケープできる 2 文字は従来どおり記号として扱う
  assert.deepEqual(parseInline("\\\\"), [text("\\")]);
});

test("リンクは URL とタイトルを持つ", () => {
  assert.deepEqual(parseInline('[GitHub](https://github.com/u7chan/monorepo "repo")'), [
    {
      kind: "link",
      href: "https://github.com/u7chan/monorepo",
      title: "repo",
      children: [text("GitHub")],
    },
  ]);
});

test("相対パスのリンクは配信先が無いため原文に落とす", () => {
  assert.deepEqual(parseInline("[相対](/docs/README.md)"), [
    { kind: "literal", text: "[相対](/docs/README.md)" },
  ]);
  assert.deepEqual(parseInline("[ファイル](notes/a.md)"), [
    { kind: "literal", text: "[ファイル](notes/a.md)" },
  ]);
  assert.deepEqual(parseInline("[プロトコル相対](//example.com/a)"), [
    { kind: "literal", text: "[プロトコル相対](//example.com/a)" },
  ]);
});

test("不正な URL のリンクは記法ごと原文に落とす", () => {
  assert.deepEqual(parseInline("[x](javascript:alert(1))"), [
    { kind: "literal", text: "[x](javascript:alert(1))" },
  ]);
  assert.deepEqual(parseInline("[x](data:text/html;base64,PHNjcmlwdD4=)"), [
    { kind: "literal", text: "[x](data:text/html;base64,PHNjcmlwdD4=)" },
  ]);
});

test("自動リンクは山括弧と裸の URL の両方を受ける", () => {
  assert.deepEqual(parseInline("<https://example.com>"), [
    {
      kind: "link",
      href: "https://example.com",
      title: null,
      children: [text("https://example.com")],
    },
  ]);
  assert.deepEqual(parseInline("<mailto:pi@example.com>"), [
    {
      kind: "link",
      href: "mailto:pi@example.com",
      title: null,
      children: [text("pi@example.com")],
    },
  ]);
  assert.deepEqual(parseInline("see https://example.com."), [
    text("see "),
    {
      kind: "link",
      href: "https://example.com",
      title: null,
      children: [text("https://example.com")],
    },
    text("."),
  ]);
  // 語の途中の http はリンクにしない
  assert.deepEqual(parseInline("xhttps://example.com"), [text("xhttps://example.com")]);
});

test("裸の URL は日本語の直後でもリンクにし、日本語の句読点はリンクに含めない", () => {
  // 語の続きとみなすのは ASCII の英数字だけ (`）` の直後でもリンクにする)
  assert.deepEqual(parseInline("参考：気象庁（東京）https://example.com"), [
    text("参考：気象庁（東京）"),
    {
      kind: "link",
      href: "https://example.com",
      title: null,
      children: [text("https://example.com")],
    },
  ]);
  // 末尾の全角句読点は本文に残す
  assert.deepEqual(parseInline("詳しくはhttps://example.com。"), [
    text("詳しくは"),
    {
      kind: "link",
      href: "https://example.com",
      title: null,
      children: [text("https://example.com")],
    },
    text("。"),
  ]);
  // 閉じ括弧もリンクに含めない
  assert.deepEqual(parseInline("「https://example.com」"), [
    text("「"),
    {
      kind: "link",
      href: "https://example.com",
      title: null,
      children: [text("https://example.com")],
    },
    text("」"),
  ]);
  // 直前が ASCII の数字でもリンクにしない
  assert.deepEqual(parseInline("1https://example.com"), [text("1https://example.com")]);
});

test("全角の閉じ括弧は URL に含めない", () => {
  const pairs = [
    ["＜", "＞"],
    ["［", "］"],
    ["｛", "｝"],
    ["《", "》"],
    ["〈", "〉"],
  ];
  for (const [open, close] of pairs) {
    assert.deepEqual(
      parseInline(`${open}https://example.com${close}`),
      [
        text(open),
        {
          kind: "link",
          href: "https://example.com",
          title: null,
          children: [text("https://example.com")],
        },
        text(close),
      ],
      `${open} … ${close} の URL が閉じ括弧を含んでいる`,
    );
  }
});

test("画像記法は表示せず原文のまま残す", () => {
  assert.deepEqual(parseInline("![図](/assets/diagram.png)"), [
    { kind: "literal", text: "![図](/assets/diagram.png)" },
  ]);
  assert.deepEqual(parseInline("![図](https://example.com/x.png)"), [
    { kind: "literal", text: "![図](https://example.com/x.png)" },
  ]);
});

test("生 HTML はタグを解釈せず文字として扱う", () => {
  assert.deepEqual(parseInline("前 <b>太字</b> 後"), [text("前 <b>太字</b> 後")]);
  assert.deepEqual(parseInline("<script>alert(1)</script>"), [text("<script>alert(1)</script>")]);
  assert.deepEqual(parseInline("<id> と <name>"), [text("<id> と <name>")]);
});

test("数式の区切りは文字として扱う", () => {
  assert.deepEqual(parseInline("$x$"), [text("$x$")]);
  assert.deepEqual(parseInline("$$\n\\sum_{i=1}^N\n$$"), [
    text("$$"),
    { kind: "break" },
    text("\\sum_{i=1}^N"),
    { kind: "break" },
    text("$$"),
  ]);
});

test("段落内の改行は break になる", () => {
  assert.deepEqual(parseInline("1 行目\n2 行目"), [
    text("1 行目"),
    { kind: "break" },
    text("2 行目"),
  ]);
});

test("壊れた入力でも例外を投げない", () => {
  const inputs = [
    "",
    "*",
    "**",
    "`",
    "[",
    "![",
    "<",
    "<b",
    "a < b",
    "****",
    "[]()",
    "[a](",
    "<a href=",
    "~~~",
  ];
  for (const input of inputs) {
    assert.doesNotThrow(() => parseInline(input), JSON.stringify(input));
  }
});

test("区切りを大量に含む本文でも実用的な時間で終わる", () => {
  const started = Date.now();
  assert.ok(parseInline("*a ".repeat(20000)).length > 0);
  assert.ok(Date.now() - started < 5000);
});
