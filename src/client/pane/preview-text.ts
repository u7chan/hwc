import { highlightCode, normalizeLang, type Token } from "./highlight";

// トークン 1 つが DOM ノード 1 つになる。スマホでスクロールが重くならないよう、
// 色付けはこの数で打ち切る。超えたら本文と行番号だけのプレーン表示に戻す（ADR 0092）。
export const PREVIEW_HIGHLIGHT_MAX_TOKENS = 20_000;

export function normalizePreviewText(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}

// 拡張子から言語を決める。拡張子を持たない Dockerfile だけ bash の規則で色を付ける。
export function previewLang(path: string): string | null {
  const name = (path.split("/").pop() ?? "").toLowerCase();
  const dot = name.lastIndexOf(".");
  if (dot > 0) return normalizeLang(name.slice(dot + 1));
  return name === "dockerfile" ? "bash" : null;
}

// ファイルプレビューで Markdown として描くファイル。プレビューで開けるテキストのうち、
// 拡張子が md のものだけを対象にする（`.markdown` は配信の allowlist に無い）。
export function isMarkdownPreviewPath(path: string): boolean {
  const name = (path.split("/").pop() ?? "").toLowerCase();
  const dot = name.lastIndexOf(".");
  return dot > 0 && name.slice(dot + 1) === "md";
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
  const lang = previewLang(path);
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
