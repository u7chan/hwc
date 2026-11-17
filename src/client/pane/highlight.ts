// 言語別のシンタックスハイライト。外部ライブラリを足さないため、言語ごとの順序つきルールで
// トークン列に分解するだけにして、HTML 文字列は一切組み立てない。移植元は u7agent の
// client/src/lib/markdown/highlight.ts（ADR 0092）。

export type TokenKind = "key" | "str" | "num" | "com" | "fn" | "type" | "op" | "plain";

export type Token = { kind: TokenKind; text: string };

type Rule = { kind: TokenKind; re: RegExp };

// classify に渡す文脈。行頭判定 (コマンド名) と直後の `(` 判定 (関数呼び出し) に使う
type WordContext = { linePrefix: string; rest: string };

type LangSpec = {
  rules: Rule[];
  // 識別子 1 語の種別。null は素のテキスト
  classify?: (word: string, context: WordContext) => TokenKind | null;
};

const WORD = /[A-Za-z_$][A-Za-z0-9_$]*/y;

const TS_KEYWORDS = new Set([
  "abstract",
  "as",
  "async",
  "await",
  "break",
  "case",
  "catch",
  "class",
  "const",
  "continue",
  "declare",
  "default",
  "delete",
  "do",
  "else",
  "enum",
  "export",
  "extends",
  "false",
  "finally",
  "for",
  "from",
  "function",
  "get",
  "if",
  "implements",
  "import",
  "in",
  "instanceof",
  "interface",
  "let",
  "namespace",
  "new",
  "null",
  "of",
  "private",
  "protected",
  "public",
  "readonly",
  "return",
  "satisfies",
  "set",
  "static",
  "super",
  "switch",
  "this",
  "throw",
  "true",
  "try",
  "type",
  "typeof",
  "undefined",
  "var",
  "while",
  "yield",
]);

const TS_TYPES = new Set([
  "any",
  "bigint",
  "boolean",
  "never",
  "number",
  "object",
  "string",
  "symbol",
  "unknown",
  "void",
]);

// コメントと引用符。C 系の言語で同じ規則を使う
const COMMENT_STRING_RULES: Rule[] = [
  { kind: "com", re: /\/\/[^\n]*/y },
  { kind: "com", re: /\/\*[\s\S]{0,4000}?\*\//y },
  { kind: "str", re: /`(?:\\[\s\S]|[^\\`]){0,4000}`/y },
  { kind: "str", re: /"(?:\\[\s\S]|[^\\"\n]){0,4000}"/y },
];

// 演算子。C 系の言語で同じ規則を使う
const OPERATOR_RULES: Rule[] = [
  { kind: "op", re: /[+\-*/%=<>!&|^~?]+/y },
  { kind: "op", re: /[{}[\]();,.:]+/y },
];

// 数値。`'` は桁区切りとして扱わない (TS の BigInt だけ `n` を許す)
const NUMBER: Rule = {
  kind: "num",
  re: /0[xX][0-9a-fA-F_]+|0[bB][01_]+|\d[\d_]*(?:\.[\d_]+)?(?:[eE][+-]?\d+)?n?/y,
};

// C / C++ の数値。桁区切り (`1'000'000`) を 1 つの数値として飲む。数値と `'` は同じ位置では始まらないため、
// この規則があるかぎり区切りの `'` が引用符の規則へ渡らない (小数部・指数部 `e` / 16 進浮動小数点の `p` も同じ)。
const NUMBER_SEPARATED: Rule = {
  kind: "num",
  re: /0[xX][0-9a-fA-F_']+(?:\.[0-9a-fA-F_']+)?(?:[pP][+-]?[\d_']+)?|0[bB][01_']+|\d[\d_']*(?:\.[\d_']+)?(?:[eE][+-]?[\d_']+)?/y,
};

// 単一引用符の文字列。JS / TS / Java / Go は長さを制限しない (`'a'` も `'abc'` も文字列)
const STR_SINGLE: Rule = { kind: "str", re: /'(?:\\[\s\S]|[^\\'\n]){0,4000}'/y };

// Rust の文字リテラル。中身は 1 文字かエスケープ 1 つだけなので、ライフタイム (`'a`) が閉じ引用符を
// 共有しない (`u` は絵文字のようなサロゲートペアを 1 文字として数えるために要る)。`\u{…}` の `_` は
// 桁数に数えない (文法は `(HEX_DIGIT '_'*){1..=6}`)。
const STR_CHAR: Rule = {
  kind: "str",
  re: /'(?:\\x[0-9a-fA-F]{2}|\\u\{(?:[0-9a-fA-F]_*){1,6}\}|\\[\s\S]|[^\\'\n])'/uy,
};

const C_LIKE_RULES: Rule[] = [...COMMENT_STRING_RULES, STR_SINGLE, NUMBER, ...OPERATOR_RULES];

const TS_SPEC: LangSpec = {
  rules: C_LIKE_RULES,
  classify: (word, context) => {
    if (TS_KEYWORDS.has(word)) return "key";
    if (TS_TYPES.has(word)) return "type";
    if (/^\s*\(/.test(context.rest)) return "fn";
    return /^[A-Z]/.test(word) ? "type" : null;
  },
};

const C_KEYWORDS = new Set([
  "alignas",
  "alignof",
  "auto",
  "break",
  "case",
  "char",
  "const",
  "continue",
  "default",
  "do",
  "double",
  "else",
  "enum",
  "extern",
  "float",
  "for",
  "goto",
  "if",
  "inline",
  "int",
  "long",
  "register",
  "restrict",
  "return",
  "short",
  "signed",
  "sizeof",
  "static",
  "static_assert",
  "struct",
  "switch",
  "thread_local",
  "typedef",
  "union",
  "unsigned",
  "void",
  "volatile",
  "while",
  "_Alignas",
  "_Alignof",
  "_Atomic",
  "_Bool",
  "_Complex",
  "_Generic",
  "_Noreturn",
  "_Static_assert",
  "_Thread_local",
]);

// C のプリプロセッサ。`#` は地の文に出ないため、行頭に限らず命令名で拾う
const C_PREPROCESSOR: Rule = {
  kind: "key",
  re: /#\s*(?:ifdef|ifndef|include|define|elif|else|endif|undef|pragma|error|warning|line|if)\b/y,
};

// C / C++ の規則。文字定数は JS と同じ長さ無制限で、数値だけ桁区切りを飲む
const C_CPP_RULES: Rule[] = [
  C_PREPROCESSOR,
  ...COMMENT_STRING_RULES,
  STR_SINGLE,
  NUMBER_SEPARATED,
  ...OPERATOR_RULES,
];

// C / C++ の塗り分け。型名 (`size_t` / `uint32_t`) やマクロ (`NULL` / `EOF`) はキーワード表に無く、
// 名前だけでは型と値の区別が付かないため、字面の規則で型として寄せる。
function cFamilySpec(keywords: Set<string>): LangSpec {
  return {
    rules: C_CPP_RULES,
    classify: (word, context) => {
      if (keywords.has(word)) return "key";
      if (/^\s*\(/.test(context.rest)) return "fn";
      return word.endsWith("_t") || /^[A-Z][A-Z0-9_]*$/.test(word) ? "type" : null;
    },
  };
}

const C_SPEC: LangSpec = cFamilySpec(C_KEYWORDS);

const CPP_KEYWORDS = new Set([
  ...C_KEYWORDS,
  "and",
  "asm",
  "bitand",
  "bitor",
  "bool",
  "catch",
  "char16_t",
  "char32_t",
  "char8_t",
  "class",
  "co_await",
  "co_return",
  "co_yield",
  "compl",
  "concept",
  "const_cast",
  "consteval",
  "constexpr",
  "constinit",
  "decltype",
  "delete",
  "dynamic_cast",
  "explicit",
  "export",
  "false",
  "final",
  "friend",
  "import",
  "module",
  "mutable",
  "namespace",
  "new",
  "noexcept",
  "not",
  "not_eq",
  "nullptr",
  "operator",
  "or",
  "override",
  "private",
  "protected",
  "public",
  "reinterpret_cast",
  "requires",
  "static_cast",
  "template",
  "this",
  "throw",
  "true",
  "try",
  "typeid",
  "typename",
  "using",
  "virtual",
  "xor",
  "xor_eq",
]);

const CPP_SPEC: LangSpec = cFamilySpec(CPP_KEYWORDS);

const JSON_SPEC: LangSpec = {
  rules: [
    { kind: "key", re: /"(?:\\[\s\S]|[^\\"]){0,4000}"(?=\s*:)/y },
    { kind: "str", re: /"(?:\\[\s\S]|[^\\"]){0,4000}"/y },
    { kind: "num", re: /-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/y },
    { kind: "op", re: /[{}[\],:]/y },
  ],
  classify: (word) => (word === "true" || word === "false" || word === "null" ? "key" : null),
};

const PY_KEYWORDS = new Set([
  "and",
  "as",
  "assert",
  "async",
  "await",
  "break",
  "class",
  "continue",
  "def",
  "del",
  "elif",
  "else",
  "except",
  "False",
  "finally",
  "for",
  "from",
  "global",
  "if",
  "import",
  "in",
  "is",
  "lambda",
  "None",
  "nonlocal",
  "not",
  "or",
  "pass",
  "raise",
  "return",
  "self",
  "True",
  "try",
  "while",
  "with",
  "yield",
]);

const PYTHON_SPEC: LangSpec = {
  rules: [
    { kind: "com", re: /#[^\n]*/y },
    { kind: "str", re: /"""[\s\S]{0,4000}?"""|'''[\s\S]{0,4000}?'''/y },
    { kind: "str", re: /"(?:\\[\s\S]|[^\\"\n]){0,4000}"|'(?:\\[\s\S]|[^\\'\n]){0,4000}'/y },
    { kind: "fn", re: /@[A-Za-z_][\w.]*/y },
    { kind: "num", re: /\d[\d_]*(?:\.[\d_]+)?(?:[eE][+-]?\d+)?/y },
    { kind: "op", re: /[+\-*/%=<>!&|^~]+/y },
    { kind: "op", re: /[{}[\]();,.:]+/y },
  ],
  classify: (word, context) => {
    if (PY_KEYWORDS.has(word)) return "key";
    if (/^\s*\(/.test(context.rest)) return "fn";
    return /^[A-Z]/.test(word) ? "type" : null;
  },
};

const JAVA_KEYWORDS = new Set([
  "abstract",
  "assert",
  "boolean",
  "break",
  "byte",
  "case",
  "catch",
  "char",
  "class",
  "const",
  "continue",
  "default",
  "do",
  "double",
  "else",
  "enum",
  "extends",
  "false",
  "final",
  "finally",
  "float",
  "for",
  "goto",
  "if",
  "implements",
  "import",
  "instanceof",
  "int",
  "interface",
  "long",
  "native",
  "new",
  "null",
  "package",
  "private",
  "protected",
  "public",
  "record",
  "return",
  "sealed",
  "short",
  "static",
  "strictfp",
  "super",
  "switch",
  "synchronized",
  "this",
  "throw",
  "throws",
  "transient",
  "true",
  "try",
  "var",
  "void",
  "volatile",
  "while",
  "yield",
]);

const JAVA_SPEC: LangSpec = {
  rules: C_LIKE_RULES,
  classify: (word, context) => {
    if (JAVA_KEYWORDS.has(word)) return "key";
    if (/^\s*\(/.test(context.rest)) return "fn";
    // String / List のようなクラス名
    return /^[A-Z]/.test(word) ? "type" : null;
  },
};

const GO_KEYWORDS = new Set([
  "break",
  "case",
  "chan",
  "const",
  "continue",
  "default",
  "defer",
  "else",
  "fallthrough",
  "false",
  "for",
  "func",
  "go",
  "goto",
  "if",
  "import",
  "interface",
  "iota",
  "map",
  "nil",
  "package",
  "range",
  "return",
  "select",
  "struct",
  "switch",
  "true",
  "type",
  "var",
]);

// 組み込みの型。Go は型名も小文字なので、キーワードと同じ字面の規則では分けられない
const GO_TYPES = new Set([
  "any",
  "bool",
  "byte",
  "comparable",
  "complex128",
  "complex64",
  "error",
  "float32",
  "float64",
  "int",
  "int16",
  "int32",
  "int64",
  "int8",
  "rune",
  "string",
  "uint",
  "uint16",
  "uint32",
  "uint64",
  "uint8",
  "uintptr",
]);

// 組み込みの関数。`len(x)` は直後の `(` でも拾えるが、値として渡す形も同じ色にする
const GO_BUILTINS = new Set([
  "append",
  "cap",
  "clear",
  "close",
  "complex",
  "copy",
  "delete",
  "imag",
  "len",
  "make",
  "max",
  "min",
  "new",
  "panic",
  "print",
  "println",
  "real",
  "recover",
]);

const GO_SPEC: LangSpec = {
  rules: C_LIKE_RULES,
  classify: (word, context) => {
    if (GO_KEYWORDS.has(word)) return "key";
    if (GO_TYPES.has(word)) return "type";
    if (GO_BUILTINS.has(word)) return "fn";
    return /^\s*\(/.test(context.rest) ? "fn" : null;
  },
};

const RUST_KEYWORDS = new Set([
  "as",
  "async",
  "await",
  "break",
  "const",
  "continue",
  "crate",
  "dyn",
  "else",
  "enum",
  "extern",
  "false",
  "fn",
  "for",
  "if",
  "impl",
  "in",
  "let",
  "loop",
  "match",
  "mod",
  "move",
  "mut",
  "pub",
  "ref",
  "return",
  "self",
  "static",
  "struct",
  "super",
  "trait",
  "true",
  "type",
  "unsafe",
  "use",
  "where",
  "while",
]);

// 組み込みの型。`Self` / `Vec` / `Option` のような型は大文字の規則で拾う
const RUST_TYPES = new Set([
  "bool",
  "char",
  "f32",
  "f64",
  "i128",
  "i16",
  "i32",
  "i64",
  "i8",
  "isize",
  "str",
  "u128",
  "u16",
  "u32",
  "u64",
  "u8",
  "usize",
]);

// Rust の規則。単一引用符は 1 文字のリテラルだけに使う (ライフタイムと区別する)
const RUST_RULES: Rule[] = [...COMMENT_STRING_RULES, STR_CHAR, NUMBER, ...OPERATOR_RULES];

const RUST_SPEC: LangSpec = {
  rules: RUST_RULES,
  classify: (word, context) => {
    if (RUST_KEYWORDS.has(word)) return "key";
    if (RUST_TYPES.has(word)) return "type";
    if (/^\s*\(/.test(context.rest)) return "fn";
    return /^[A-Z]/.test(word) ? "type" : null;
  },
};

const BASH_SPEC: LangSpec = {
  rules: [
    { kind: "com", re: /#[^\n]*/y },
    { kind: "str", re: /"(?:\\[\s\S]|[^\\"]){0,4000}"/y },
    { kind: "str", re: /'[^']{0,400}'/y },
    { kind: "type", re: /\$(?:\{[^}]{0,200}\}|[A-Za-z_][A-Za-z0-9_]*|[0-9@*#?$!-])/y },
    { kind: "num", re: /\d[\d_]*(?:\.\d+)?/y },
    { kind: "op", re: /--?[A-Za-z][A-Za-z0-9-]*/y },
    { kind: "op", re: /[|&;<>()=]+/y },
  ],
  // 行頭の語をコマンド名として扱う
  classify: (_word, context) => (context.linePrefix.trim() === "" ? "fn" : null),
};

const CSS_SPEC: LangSpec = {
  rules: [
    { kind: "com", re: /\/\*[\s\S]{0,4000}?\*\//y },
    { kind: "str", re: /"(?:\\[\s\S]|[^\\"\n]){0,4000}"|'(?:\\[\s\S]|[^\\'\n]){0,4000}'/y },
    { kind: "key", re: /@[A-Za-z-]+/y },
    { kind: "num", re: /#[0-9a-fA-F]{3,8}/y },
    { kind: "num", re: /-?\d[\d.]*(?:[a-z%]+)?/y },
    { kind: "fn", re: /[A-Za-z-]+(?=\s*:)/y },
    { kind: "type", re: /[.#][A-Za-z_][\w-]*|::?[A-Za-z-]+/y },
    { kind: "op", re: /[{}();:,>+~*]+/y },
    { kind: "type", re: /[A-Za-z-]+/y },
  ],
};

const HTML_SPEC: LangSpec = {
  rules: [
    { kind: "com", re: /<!--[\s\S]{0,4000}?-->/y },
    { kind: "com", re: /<!\[CDATA\[[\s\S]{0,4000}?\]\]>|<![A-Za-z][^>]{0,400}>/y },
    { kind: "key", re: /<\/?[A-Za-z][A-Za-z0-9-]*/y },
    { kind: "op", re: /\/?>/y },
    { kind: "type", re: /[A-Za-z_:][A-Za-z0-9_:.-]{0,32}(?=\s*=)/y },
    { kind: "str", re: /"[^"]{0,400}"|'[^']{0,400}'/y },
    { kind: "op", re: /=/y },
  ],
};

const MD_SPEC: LangSpec = {
  rules: [
    { kind: "com", re: /```[^\n]*/y },
    { kind: "str", re: /`[^`\n]{0,400}`/y },
    { kind: "key", re: /#{1,6}(?=\s)/y },
    { kind: "type", re: /\[[^\]\n]{0,400}\]\([^)\n]{0,2000}\)/y },
    { kind: "op", re: /\*\*|__|~~|\*|_|\d{1,9}\. /y },
  ],
};

const SPECS: Record<string, LangSpec> = {
  ts: TS_SPEC,
  c: C_SPEC,
  cpp: CPP_SPEC,
  java: JAVA_SPEC,
  go: GO_SPEC,
  rust: RUST_SPEC,
  json: JSON_SPEC,
  python: PYTHON_SPEC,
  bash: BASH_SPEC,
  css: CSS_SPEC,
  html: HTML_SPEC,
  md: MD_SPEC,
};

const ALIASES: Record<string, string> = {
  ts: "ts",
  tsx: "ts",
  typescript: "ts",
  js: "ts",
  jsx: "ts",
  javascript: "ts",
  mjs: "ts",
  cjs: "ts",
  json: "json",
  jsonc: "json",
  c: "c",
  h: "c",
  cpp: "cpp",
  "c++": "cpp",
  cc: "cpp",
  cxx: "cpp",
  hh: "cpp",
  hpp: "cpp",
  hxx: "cpp",
  java: "java",
  go: "go",
  golang: "go",
  rs: "rust",
  rust: "rust",
  sh: "bash",
  shell: "bash",
  bash: "bash",
  zsh: "bash",
  console: "bash",
  py: "python",
  python: "python",
  css: "css",
  html: "html",
  xml: "html",
  diff: "diff",
  patch: "diff",
  md: "md",
  markdown: "md",
};

// 本文を言語の規則でトークン列へ分解する。未知の言語と上限超過は null。
export function highlightCode(
  text: string,
  lang: string | null,
  maxTokens: number,
): Token[] | null {
  const name = normalizeLang(lang);
  if (name === null) return null;
  return name === "diff" ? highlightDiff(text, maxTokens) : tokenize(text, SPECS[name], maxTokens);
}

// 言語名や拡張子の表記ゆれ（`TS` / `.ts` / `tsx`）を同じキーへ寄せる。未知の言語は null。
export function normalizeLang(lang: string | null): string | null {
  if (lang === null) return null;
  const name = lang
    .trim()
    .toLowerCase()
    .replace(/^\{|\}$/g, "")
    .replace(/^\./, "");
  // info 文字列や拡張子は外部由来なので、own プロパティだけを見る (constructor / __proto__ を言語名として拾わない)
  return Object.hasOwn(ALIASES, name) ? ALIASES[name] : null;
}

// 区切り文字が無い入力では、失敗した規則が行末・文末まで走査して二次関数的に遅くなる。
// 規則側の量化子は有限にしてあるが、将来の追加に備えて連続する素の 1 文字と 1 文字語でも打ち切る。
const PLAIN_RUN_LIMIT = 5_000;

function tokenize(text: string, spec: LangSpec, maxTokens: number): Token[] | null {
  const tokens: Token[] = [];
  const push = (kind: TokenKind, value: string): boolean => {
    if (value === "") return true;
    const last = tokens[tokens.length - 1];
    // 連続する素のテキストは 1 トークンにまとめて DOM を増やさない
    if (last !== undefined && last.kind === kind) last.text += value;
    else tokens.push({ kind, text: value });
    return tokens.length <= maxTokens;
  };

  let at = 0;
  let plainRun = 0;
  while (at < text.length) {
    let matched = false;
    for (const rule of spec.rules) {
      rule.re.lastIndex = at;
      const match = rule.re.exec(text);
      if (match !== null && match[0].length > 0) {
        if (!push(rule.kind, match[0])) return null;
        at += match[0].length;
        plainRun = 0;
        matched = true;
        break;
      }
    }
    if (matched) continue;
    WORD.lastIndex = at;
    const word = WORD.exec(text);
    if (word !== null) {
      const lineStart = text.lastIndexOf("\n", at - 1) + 1;
      const kind = spec.classify?.(word[0], {
        linePrefix: text.slice(lineStart, at),
        rest: text.slice(at + word[0].length),
      });
      if (!push(kind ?? "plain", word[0])) return null;
      at += word[0].length;
      // 1 文字の語が続く入力も、区切りの無い塊と同じく走査を繰り返す。
      plainRun = word[0].length === 1 ? plainRun + 1 : 0;
      if (plainRun > PLAIN_RUN_LIMIT) return null;
      continue;
    }
    if (!push("plain", text[at])) return null;
    at += 1;
    plainRun += 1;
    if (plainRun > PLAIN_RUN_LIMIT) return null;
  }
  return tokens;
}

function highlightDiff(text: string, maxTokens: number): Token[] | null {
  const tokens: Token[] = [];
  const lines = text.split("\n");
  for (const [index, line] of lines.entries()) {
    if (tokens.length > maxTokens) return null;
    if (index > 0) tokens.push({ kind: "plain", text: "\n" });
    if (line === "") continue;
    if (line.startsWith("@@")) tokens.push({ kind: "key", text: line });
    else if (/^(\+\+\+|---|diff |index |new file|deleted file|similarity|rename )/.test(line)) {
      tokens.push({ kind: "com", text: line });
    } else if (line.startsWith("+")) tokens.push({ kind: "str", text: line });
    else if (line.startsWith("-")) tokens.push({ kind: "type", text: line });
    else tokens.push({ kind: "plain", text: line });
  }
  return tokens.length > maxTokens ? null : tokens;
}
