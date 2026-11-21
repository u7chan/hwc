import { highlightCode, normalizeLang, type Token } from "./highlight";

// トークン 1 つが DOM ノード 1 つになる。スマホでスクロールが重くならないよう、
// 色付けはこの数で打ち切る。超えたら本文と行番号だけのプレーン表示に戻す（docs/adr/client-rendering.md）。
export const PREVIEW_HIGHLIGHT_MAX_TOKENS = 20_000;

export function normalizePreviewText(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}

function previewName(path: string): string {
  return (path.split("/").pop() ?? "").toLowerCase();
}

// 拡張子。先頭のドットは拡張子の区切りではない。
function previewExtension(path: string): string {
  const name = previewName(path);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1) : "";
}

// 拡張子から言語を決める。拡張子の無い Dockerfile だけ bash の規則で色を付ける。
// それ以外の拡張子の無いファイルは、先頭行の shebang を見る（previewTokens）。
export function previewLang(path: string): string | null {
  const ext = previewExtension(path);
  if (ext !== "") return normalizeLang(ext);
  return previewName(path) === "dockerfile" ? "bash" : null;
}

// 実行可能スクリプトの先頭行（`#!/usr/bin/env bash`）から言語を決める。shebang は
// 1 行目だけを見る近似で、`env` の後ろは最初の非オプション語を解釈子とみなし、
// 引数の意味までは解釈しない。拡張子の無いファイルにだけ使う。
const SHEBANG_LANGS: Record<string, string> = {
  bash: "bash",
  sh: "bash",
  zsh: "bash",
  dash: "bash",
  ksh: "bash",
  python: "python",
  node: "ts",
  nodejs: "ts",
  bun: "ts",
  deno: "ts",
};

// 解釈子のパスや引数まで読まないよう、先頭行の先頭だけを見る。
const SHEBANG_HEAD_LIMIT = 256;

export function previewShebangLang(text: string): string | null {
  const head = text.slice(0, SHEBANG_HEAD_LIMIT);
  const start = head.startsWith("\uFEFF") ? 1 : 0;
  if (!head.startsWith("#!", start)) return null;
  const end = head.indexOf("\n", start);
  const line = head.slice(start + 2, end === -1 ? undefined : end).trim();
  const words = line.split(/\s+/).filter((word) => word !== "");
  if (words.length === 0) return null;

  let interpreter = words[0];
  if (interpreter.slice(interpreter.lastIndexOf("/") + 1) === "env") {
    // `env -S bash -e` や `env FOO=1 python3` の形から、実行する側の名前を選ぶ。
    interpreter =
      words
        .slice(1)
        .find((word) => !word.startsWith("-") && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) ?? "";
  }
  const name = interpreter.slice(interpreter.lastIndexOf("/") + 1).replace(/[0-9.]+$/, "");
  return Object.hasOwn(SHEBANG_LANGS, name) ? SHEBANG_LANGS[name] : null;
}

// ファイルプレビューで Markdown として描くファイル。プレビューで開けるテキストのうち、
// 拡張子が md のものだけを対象にする（`.markdown` は配信の allowlist に無い）。
export function isMarkdownPreviewPath(path: string): boolean {
  return previewExtension(path) === "md";
}

const SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;

// Markdown の相対参照を、表示中のファイルのディレクトリ基準で根からの相対パスへ直す。
// 外部 URL・プロトコル相対・フラグメントだけ・根の外へ出る `..` は null にし、
// 呼び出し側は参照を原文のまま残す。実在と配信可否は BFF が確かめる。
export function resolvePreviewReference(href: string, fromPath: string): string | null {
  const raw = href.trim();
  if (raw === "" || raw.startsWith("#") || raw.startsWith("//")) return null;
  if (SCHEME.test(raw)) return null;
  // `?` / `#` 以降はファイル名ではない。配信するのはパスだけ。
  const end = raw.search(/[?#]/);
  const path = end === -1 ? raw : raw.slice(0, end);
  if (path === "") return null;

  // 先頭の `/` はチェックアウトの根からの絶対パスとして扱う。
  const segments = path.startsWith("/")
    ? []
    : fromPath
        .split("/")
        .slice(0, -1)
        .filter((segment) => segment !== "" && segment !== ".");
  for (const segment of path.split("/")) {
    if (segment === "" || segment === ".") continue;
    const decoded = decodeReferenceSegment(segment);
    if (decoded === null) return null;
    if (decoded === "..") {
      if (segments.length === 0) return null;
      segments.pop();
      continue;
    }
    if (decoded === ".") continue;
    segments.push(decoded);
  }
  return segments.length === 0 ? null : segments.join("/");
}

// `%2F` でパスの区切りを紛れ込ませない。不正な `%` は、ブラウザの通常のリンクと同じく
// そのままの文字として扱う（`100%.md` のような名前を落とさない）。
function decodeReferenceSegment(segment: string): string | null {
  let value = segment;
  try {
    value = decodeURIComponent(segment);
  } catch {
    // 不正な % はブラウザの通常のリンクと同じく、そのままの文字として扱う。
  }
  return value.includes("/") || value.includes("\\") ? null : value;
}

// 色付けするときだけトークン列を作る。判定できないファイルと上限超過は null で、
// 呼び出し側は本文をそのまま出す。
export function previewTokens(text: string, path: string): Token[] | null {
  const lang =
    previewLang(path) ?? (previewExtension(path) === "" ? previewShebangLang(text) : null);
  if (lang === null) return null;
  return highlightCode(text, lang, PREVIEW_HIGHLIGHT_MAX_TOKENS);
}

// 末尾の改行は最後の行を終えるだけなので、行番号を増やさない。
export function previewLineNumbers(text: string): string {
  if (text === "") return "";
  let count = 1;
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) !== 10) continue;
    if (index === text.length - 1) continue;
    count += 1;
  }
  const numbers: string[] = [];
  for (let number = 1; number <= count; number += 1) numbers.push(String(number));
  return numbers.join("\n");
}
