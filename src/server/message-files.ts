import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import {
  attachmentContentTypeFromName,
  attachmentExtFromName,
  MAX_ATTACHMENTS,
  MAX_ATTACHMENT_BYTES,
} from "../shared/attachments";
import type { ChatFile, ChatMessage, ChatSnapshot } from "./chat/contract";

// 1 通の本文から試す候補の上限。実在確認は候補ごとに fs を叩くので、本文が長くても止まるようにする。
const MAX_CANDIDATES = 20;

// パスの前後から落とす記号。Markdown の `![alt](path)` や `` `path` ``、行末の句読点を
// 1 つのトークンとして拾えるようにする。
const LEADING_NOISE = /^[^\p{L}\p{N}_./~@-]+/u;
const TRAILING_NOISE = /[^\p{L}\p{N}_./~@-]+$/u;
const SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;
const UNSAFE_TOKEN = /["'<>[\]{}()\s]/;

// リンクと画像は alt と title を落として destination だけを本文へ戻す。
const MARKDOWN_LINK = /!?\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/g;
// インラインコードは前後に空白が無い日本語の文にも埋まるので、中身を独立したトークンにする。
const INLINE_CODE = /`([^`\n]+)`/g;
// パスに現れない区切りで割る。全角コロンなどの直後にパスが続く日本語の文でも、
// 1 つのトークンからパスだけを取り出せるようにする。
const HARD_SEPARATORS = /[,;:、，；：「」『』（）()[]{}'"<>]/g;

export type MessageFile = ChatFile;
type ResolvedMessageFile = MessageFile & { path: string };

// フェンスの中はコード例やログで、出力ファイルの案内ではない。中のパスを拾わない。
export function withoutFencedCode(text: string): string {
  const kept: string[] = [];
  let fence: { char: string; length: number } | null = null;
  for (const line of text.split("\n")) {
    const match = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fence === null) {
      if (match === null) {
        kept.push(line);
      } else {
        const marker = match[1] ?? "";
        fence = { char: marker.charAt(0), length: marker.length };
        kept.push("");
      }
      continue;
    }
    // 閉じるフェンスは、開いたのと同じ文字で同じ長さ以上。
    if (match !== null) {
      const marker = match[1] ?? "";
      if (marker.charAt(0) === fence.char && marker.length >= fence.length) fence = null;
    }
    kept.push("");
  }
  return kept.join("\n");
}

// 日本語の文に空白なしでパスが続くと、先頭の助詞が名前の一部になる。先頭に区切りが
// 無く、残りがパスらしい（`/` を含む）ときだけ落とす。日本語のファイル名はそのまま残す。
function cutLeadingProse(token: string): string {
  const first = token.search(/[A-Za-z0-9_.~]/);
  if (first <= 0) return token;
  if (/[/\\]/.test(token.slice(0, first))) return token;
  const rest = token.slice(first);
  return rest.includes("/") ? rest : token;
}

// 末尾に付いた英語の句点や日本語の助詞を落とす。`png.bak` のように英数字が続く
// 場合は別の名前なので落とさない。
function trimToImageName(token: string): string | null {
  const body = cutLeadingProse(token);
  for (let end = body.length; end > 0; end -= 1) {
    const candidate = body.slice(0, end);
    // 形式の一覧は添付と同じ 1 か所から引く。
    if (attachmentExtFromName(candidate) !== null) return candidate;
    if (/[A-Za-z0-9/\\]/.test(body.charAt(end - 1))) return null;
  }
  return null;
}

function trimToken(token: string): string | null {
  const trimmed = token.replace(LEADING_NOISE, "").replace(TRAILING_NOISE, "");
  if (trimmed.length === 0 || trimmed.length > 512) return null;
  // スキーム付きの URL は区切りで割ったあと `//host/...` になる。
  if (SCHEME.test(trimmed) || trimmed.startsWith("//")) return null;
  if (UNSAFE_TOKEN.test(trimmed)) return null;
  return trimToImageName(trimmed);
}

// 本文に書かれた画像パスの候補。実在するかはここでは見ない。
export function imagePathCandidates(text: string): string[] {
  const candidates: string[] = [];
  const seen = new Set<string>();
  const body = withoutFencedCode(text)
    .replace(INLINE_CODE, (_match, code: string) => ` ${code} `)
    .replace(MARKDOWN_LINK, (_match, destination: string) => ` ${destination} `)
    .replace(HARD_SEPARATORS, " ");
  for (const token of body.split(/\s+/u)) {
    const candidate = trimToken(token);
    if (candidate === null || seen.has(candidate)) continue;
    seen.add(candidate);
    candidates.push(candidate);
    if (candidates.length >= MAX_CANDIDATES) break;
  }
  return candidates;
}

async function resolveAgainstRoot(
  rootReal: string,
  candidate: string,
): Promise<ResolvedMessageFile | null> {
  try {
    const target = isAbsolute(candidate) ? candidate : resolve(rootReal, candidate);
    // realpath は symlink を解決する。根の外を指すリンクはここで落ちる。
    const real = await realpath(target);
    if (real !== rootReal && !real.startsWith(rootReal + sep)) return null;

    const info = await stat(real);
    if (!info.isFile() || info.size === 0 || info.size > MAX_ATTACHMENT_BYTES) return null;
    if (attachmentExtFromName(real) === null) return null;

    const name = relative(rootReal, real);
    if (name === "" || isAbsolute(name) || name.startsWith("..")) return null;
    return {
      name: name.split(sep).join("/"),
      version: `${Math.trunc(info.mtimeMs)}-${info.size}`,
      path: real,
    };
  } catch {
    return null;
  }
}

export async function resolveMessageFile(options: {
  root: string;
  path: string;
}): Promise<ResolvedMessageFile | null> {
  try {
    return await resolveAgainstRoot(await realpath(options.root), options.path);
  } catch {
    return null;
  }
}

// 根は実在するディレクトリ。無ければ何も返さない（プレビューを出さないだけ）。
export async function collectMessageFiles(text: string, root: string): Promise<MessageFile[]> {
  try {
    return await collectAgainstRoot(text, await realpath(root));
  } catch {
    return [];
  }
}

async function collectAgainstRoot(text: string, rootReal: string): Promise<MessageFile[]> {
  if (text === "") return [];
  const candidates = imagePathCandidates(text);
  if (candidates.length === 0) return [];

  const files: MessageFile[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (files.length >= MAX_ATTACHMENTS) break;
    const resolved = await resolveAgainstRoot(rootReal, candidate);
    if (resolved === null || seen.has(resolved.name)) continue;
    seen.add(resolved.name);
    files.push({ name: resolved.name, version: resolved.version });
  }
  return files;
}

// 画像を作り直すと本文は変わらない。版を etag に混ぜないと、304 で古い画像の URL が残る。
function withFileVersions(etag: string, messages: readonly ChatMessage[]): string {
  const parts: string[] = [];
  for (const message of messages) {
    for (const file of message.files ?? []) parts.push(`${file.name}@${file.version}`);
  }
  if (parts.length === 0) return etag;
  const digest = createHash("sha256").update(parts.join("\n")).digest("hex").slice(0, 12);
  return `${etag}-${digest}`;
}

export async function attachMessageFiles(
  snapshot: ChatSnapshot,
  root: string | null,
): Promise<ChatSnapshot> {
  if (root === null) return snapshot;

  let rootReal: string;
  try {
    rootReal = await realpath(root);
  } catch {
    return snapshot;
  }

  const messages = await Promise.all(
    snapshot.messages.map(async (message) => {
      // 失敗の行はプロバイダの文言で、エージェントの発話ではない。
      if (message.role !== "agent" || message.text === "") return message;
      const files = await collectAgainstRoot(message.text, rootReal);
      return files.length === 0 ? message : { ...message, files };
    }),
  );
  if (messages.every((message, index) => message === snapshot.messages[index])) return snapshot;
  return { ...snapshot, messages, etag: withFileVersions(snapshot.etag, messages) };
}

export async function readMessageFile(file: ResolvedMessageFile): Promise<ArrayBuffer | null> {
  try {
    const bytes = await readFile(file.path);
    // stat の後で伸びた分も見る。上限を超えたら配信しない。
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_ATTACHMENT_BYTES) return null;
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    return copy.buffer;
  } catch {
    return null;
  }
}

export function messageFileContentType(name: string): string | null {
  return attachmentContentTypeFromName(name);
}
