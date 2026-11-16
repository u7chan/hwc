import { createHash } from "node:crypto";
import type { Dirent, Stats } from "node:fs";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  attachmentContentTypeFromName,
  MAX_ATTACHMENTS,
  MAX_PREVIEW_FILE_BYTES,
} from "../shared/attachments";
import {
  FILE_TREE_LIMIT,
  type FileTreeEntry,
  type FileTreeFile,
  type FileTreeListing,
} from "../shared/file-tree";
import {
  messageFileKindFromName,
  messageLinkKindFromName,
  previewContentType,
} from "../shared/message-files";
import type { ChatFile, ChatLink, ChatMessage, ChatSnapshot } from "./chat/contract";

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
// 1 つのトークンからパスだけを取り出せるようにする。`[` と `]` は入れない。
// 文字クラスの中で `]` が閉じ位置になり、クラスごと壊れる。
const HARD_SEPARATORS = /[,;:、，；：「」『』（）(){}'"<>]/g;

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
function trimToMessageFileName(token: string): string | null {
  const body = cutLeadingProse(token);
  for (let end = body.length; end > 0; end -= 1) {
    const candidate = body.slice(0, end);
    // 見せられる形式の一覧は 1 か所から引く。本文のリンクから開けるテキストも候補にする。
    if (messageLinkKindFromName(candidate) !== null) return candidate;
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
  return trimToMessageFileName(trimmed);
}

export type MessagePathCandidate = {
  path: string;
  // 画像記法の destination として現れた表記。本文のその位置に描くための照合キーになる。
  imageRefs: string[];
  // 画像以外のリンクの destination として現れた表記。本文のその位置をリンクにするための
  // 照合キーになる。
  linkRefs: string[];
};

// 本文に書かれたファイルパスの候補。実在するかはここでは見ない。
export function messagePathCandidates(text: string): MessagePathCandidate[] {
  const candidates = new Map<string, MessagePathCandidate>();
  const source = withoutFencedCode(text);
  // 描画位置は、本文を解析する側と同じくコードスパンの中を見ない。中身を同じ長さの
  // 空白に置き換えて、候補の抽出と同じ本文を行ごと使えるようにする。
  const imageRefs = new Set<string>();
  const linkRefs = new Set<string>();
  const masked = source.replace(INLINE_CODE, (match) => " ".repeat(match.length));
  for (const match of masked.matchAll(MARKDOWN_LINK)) {
    const destination = match[1];
    if (destination === undefined) continue;
    const image = (match[0] ?? "").startsWith("!");
    const before = masked.charAt((match.index ?? 0) - 1);
    // `\![x](a)` は画像ではなくリンク。`\[x](a)` は記法ごとエスケープされているので、
    // リンクにもしない。
    if (before === "\\" && !image) continue;
    // 本文の表記とそのまま一致するものだけを照合キーにする。
    if (trimToken(destination) !== destination) continue;
    if (image && before !== "\\") imageRefs.add(destination);
    else linkRefs.add(destination);
  }
  const body = source
    .replace(INLINE_CODE, (_match, code: string) => ` ${code} `)
    .replace(MARKDOWN_LINK, (_match, destination: string) => ` ${destination} `)
    .replace(HARD_SEPARATORS, " ");
  for (const token of body.split(/\s+/u)) {
    const path = trimToken(token);
    if (path === null) continue;
    // テキストは、本文のリンクの destination として書かれたときだけ候補にする。裸のパスまで
    // 候補にすると、チップの枠（MAX_CANDIDATES）を食って後ろの画像が消える（ADR 0084）。
    if (messageFileKindFromName(path) === null && !linkRefs.has(path)) continue;
    const current = candidates.get(path);
    if (current !== undefined) {
      // 裸パスと記法の両方に出ても、記法の位置で描けるように印を残す。
      if (imageRefs.has(path) && !current.imageRefs.includes(path)) current.imageRefs.push(path);
      if (linkRefs.has(path) && !current.linkRefs.includes(path)) current.linkRefs.push(path);
      continue;
    }
    if (candidates.size >= MAX_CANDIDATES) break;
    candidates.set(path, {
      path,
      imageRefs: imageRefs.has(path) ? [path] : [],
      linkRefs: linkRefs.has(path) ? [path] : [],
    });
  }
  return [...candidates.values()];
}

type ResolvedFile = { name: string; version: string; path: string; root: number };

// 根の外を指すパスは realpath で落とす。受け入れる形式は呼び出し側が決める。
// root は根の番号で、配信の URL と突き合わせるために結果へ残す。
async function resolveAgainstRoot(
  rootReal: string,
  candidate: string,
  accept: (name: string) => boolean,
  root: number,
): Promise<ResolvedFile | null> {
  try {
    const target = isAbsolute(candidate) ? candidate : resolve(rootReal, candidate);
    // realpath は symlink を解決する。根の外を指すリンクはここで落ちる。
    const real = await realpath(target);
    if (real !== rootReal && !real.startsWith(rootReal + sep)) return null;

    const info = await stat(real);
    if (!info.isFile() || info.size === 0 || info.size > MAX_PREVIEW_FILE_BYTES) return null;
    if (!accept(real)) return null;

    const name = relative(rootReal, real);
    if (name === "" || isAbsolute(name) || name.startsWith("..")) return null;
    return {
      name: name.split(sep).join("/"),
      version: `${Math.trunc(info.mtimeMs)}-${info.size}`,
      path: real,
      root,
    };
  } catch {
    return null;
  }
}

// 画像の配信は既存の /files が受ける。ここでは画像だけを受け入れる。
export async function resolveMessageFile(options: {
  root: string;
  path: string;
}): Promise<ResolvedMessageFile | null> {
  try {
    const file = await resolveAgainstRoot(
      await realpath(options.root),
      options.path,
      (name) => messageFileKindFromName(name) === "image",
      0,
    );
    if (file === null) return null;
    return { ...file, kind: "image" };
  } catch {
    return null;
  }
}

// 根は実在するディレクトリ。無ければ何も返さない（プレビューを出さないだけ）。
export async function collectMessageFiles(text: string, root: string): Promise<MessageFile[]> {
  try {
    return (await collectAgainstRoots(text, [await realpath(root)])).files;
  } catch {
    return [];
  }
}

type CollectedFiles = {
  files: MessageFile[];
  // 本文の相対パスのリンク。実在を確かめられたものだけが入る。
  links: ChatLink[];
  // 根の外に実在したファイル名。最初の 1 件だけ持つ（画面は 1 行しか出さない）。
  outsideFile?: string;
};

// 絶対パスで書かれた候補が、どの根の配下でもない場所に実在するか。相対パスは、本文だけから
// 基準のディレクトリが決まらないので見ない。返すのは名前だけで、絶対パスは外へ出さない。
async function outsideRootFile(
  candidate: string,
  rootsReal: readonly (string | null)[],
): Promise<string | null> {
  if (!isAbsolute(candidate)) return null;
  try {
    const real = await realpath(candidate);
    if (rootsReal.some((root) => root !== null && (real === root || real.startsWith(root + sep))))
      return null;

    const info = await stat(real);
    if (!info.isFile() || info.size === 0 || info.size > MAX_PREVIEW_FILE_BYTES) return null;
    if (messageFileKindFromName(real) === null) return null;
    return basename(real);
  } catch {
    return null;
  }
}

// 根は順に試し、最初に見つかったものを採る。採った根の番号をファイルに持たせるので、
// 配信は同じ実体を引き直せる（同名ファイルが別の根にあっても取り違えない）。
// labels は根の表示用のラベル。チェックアウトの根は既定なので持たない。
async function collectAgainstRoots(
  text: string,
  rootsReal: readonly (string | null)[],
  labels: readonly (string | undefined)[] = [],
): Promise<CollectedFiles> {
  if (text === "" || rootsReal.length === 0) return { files: [], links: [] };
  const candidates = messagePathCandidates(text);
  if (candidates.length === 0) return { files: [], links: [] };

  const files: MessageFile[] = [];
  const byKey = new Map<string, MessageFile>();
  const links: ChatLink[] = [];
  const byHref = new Set<string>();
  let outsideFile: string | undefined;
  for (const candidate of candidates) {
    let resolved: ResolvedFile | null = null;
    for (const [root, rootReal] of rootsReal.entries()) {
      // 実在しない根も番号を詰めずに飛ばす。番号は配信の URL と共有している。
      if (rootReal === null) continue;
      resolved = await resolveAgainstRoot(
        rootReal,
        candidate.path,
        (name) => messageLinkKindFromName(name) !== null,
        root,
      );
      if (resolved !== null) break;
    }
    if (resolved === null) {
      // 配れない理由が「根の外」かどうかは、実在を確かめないと言えない。
      if (outsideFile === undefined)
        outsideFile = (await outsideRootFile(candidate.path, rootsReal)) ?? undefined;
      continue;
    }
    const rootLabel = labels[resolved.root];
    // リンクは本文でリンク記法の destination として書かれた候補だけ。裸のパスを
    // リンクにすると、本文の見た目がそのままで押せる範囲が変わってしまう。
    const linkKind = messageLinkKindFromName(resolved.name);
    if (linkKind !== null) {
      for (const href of candidate.linkRefs) {
        if (byHref.has(href)) continue;
        byHref.add(href);
        links.push({
          href,
          name: resolved.name,
          version: resolved.version,
          kind: linkKind,
          root: resolved.root,
          ...(rootLabel === undefined ? {} : { rootLabel }),
        });
      }
    }
    const kind = messageFileKindFromName(resolved.name);
    if (kind === null) continue;
    const key = `${resolved.root}:${resolved.name}`;
    const existing = byKey.get(key);
    if (existing !== undefined) {
      // 同じ実体を別の表記が指すことがある。描画位置の照合キーを落とさない。
      if (kind === "image" && candidate.imageRefs.length > 0) {
        existing.imageRefs = [...new Set([...(existing.imageRefs ?? []), ...candidate.imageRefs])];
      }
      continue;
    }
    // 枠が埋まっても走査は止めない。根の外の案内は、配るファイルが 4 件揃った後ろの候補にもある。
    if (files.length >= MAX_ATTACHMENTS) continue;
    const file: MessageFile = {
      name: resolved.name,
      version: resolved.version,
      kind,
      root: resolved.root,
      ...(rootLabel === undefined ? {} : { rootLabel }),
      ...(kind === "image" && candidate.imageRefs.length > 0
        ? { imageRefs: candidate.imageRefs }
        : {}),
    };
    byKey.set(key, file);
    files.push(file);
  }
  return outsideFile === undefined ? { files, links } : { files, links, outsideFile };
}

// プレビューで配信するファイル。html と同じディレクトリの css / js / 画像も、
// 同じ根の中なら配信する。どの根かは URL の先頭の番号で決まるので、ここでは 1 つだけ見る。
export type PreviewFile = { name: string; path: string; contentType: string };

export async function resolvePreviewFile(options: {
  root: string;
  path: string;
}): Promise<PreviewFile | null> {
  let rootReal: string;
  try {
    rootReal = await realpath(options.root);
  } catch {
    return null;
  }
  const file = await resolveAgainstRoot(
    rootReal,
    options.path,
    (name) => previewContentType(name) !== null,
    0,
  );
  if (file === null) return null;
  const contentType = previewContentType(file.name);
  if (contentType === null) return null;
  return { name: file.name, path: file.path, contentType };
}

// ツリーは名前順に並べる。localeCompare は環境のロケールで結果が変わるので使わない。
// 大文字小文字を無視し、同じなら元の表記で決める。
function compareNames(a: string, b: string): number {
  const left = a.toLowerCase();
  const right = b.toLowerCase();
  if (left !== right) return left < right ? -1 : 1;
  return a === b ? 0 : a < b ? -1 : 1;
}

function compareDirents(a: Dirent, b: Dirent): number {
  const left = a.isDirectory() ? 0 : 1;
  const right = b.isDirectory() ? 0 : 1;
  return left !== right ? left - right : compareNames(a.name, b.name);
}

function compareEntries(a: FileTreeEntry, b: FileTreeEntry): number {
  const left = a.kind === "dir" ? 0 : 1;
  const right = b.kind === "dir" ? 0 : 1;
  return left !== right ? left - right : compareNames(a.name, b.name);
}

// 開けないファイルも行としては返す。ツリーに穴を空けないため、open を null にして
// 名前だけを持たせる。大きさはツリーには出さない。
function treeFile(name: string, path: string, info: Stats, escaped: boolean): FileTreeFile {
  const size = info.size;
  const open =
    escaped || size === 0 || size > MAX_PREVIEW_FILE_BYTES ? null : messageLinkKindFromName(name);
  return {
    kind: "file",
    name,
    path,
    open,
    version: `${Math.trunc(info.mtimeMs)}-${size}`,
  };
}

function unreadableFile(name: string, path: string): FileTreeFile {
  return { kind: "file", name, path, open: null, version: "" };
}

// 1 エントリを調べる。symlink は実体を確かめ、根の外を指すものは名前だけ残して
// 展開・open をさせない。壊れたリンクも名前だけ残す。
async function listEntry(
  rootReal: string,
  parentReal: string,
  parentPath: string,
  dirent: Dirent,
): Promise<FileTreeEntry> {
  const name = dirent.name;
  const path = parentPath === "" ? name : `${parentPath}/${name}`;
  const target = join(parentReal, name);

  if (dirent.isSymbolicLink()) {
    let real: string;
    try {
      real = await realpath(target);
    } catch {
      return unreadableFile(name, path);
    }
    const escaped = real !== rootReal && !real.startsWith(rootReal + sep);
    let info: Stats;
    try {
      info = await stat(real);
    } catch {
      return unreadableFile(name, path);
    }
    if (info.isDirectory()) return { kind: "dir", name, path, expandable: !escaped };
    return treeFile(name, path, info, escaped);
  }

  if (dirent.isDirectory()) return { kind: "dir", name, path, expandable: true };

  let info: Stats;
  try {
    info = await stat(target);
  } catch {
    return unreadableFile(name, path);
  }
  return treeFile(name, path, info, false);
}

// チェックアウトの 1 ディレクトリを返す。path は根からの相対パスで、空なら根。
// 子は開いたときにだけ取りに来る前提で、ここでは 1 階層しか読まない。
export async function listDirectory(options: {
  root: string;
  path: string;
}): Promise<FileTreeListing | null> {
  if (isAbsolute(options.path)) return null;
  const segments = options.path.split("/");
  // 親参照は受け付けない。realpath の配下判定と二重にしておく。
  if (segments.some((part) => part === "..")) return null;
  const base = segments.filter((part) => part !== "" && part !== ".").join("/");

  try {
    const rootReal = await realpath(options.root);
    const real = await realpath(base === "" ? rootReal : resolve(rootReal, base));
    if (real !== rootReal && !real.startsWith(rootReal + sep)) return null;
    const info = await stat(real);
    if (!info.isDirectory()) return null;

    // `.git` だけは中身がリポジトリの構造ではないので、階層のどこでも出さない。
    const dirents = (await readdir(real, { withFileTypes: true })).filter(
      (item) => item.name !== ".git",
    );
    const total = dirents.length;
    // symlink は dir か file か分からないので file 側に並べる。実体の確認は上限で
    // 切った後だけ行い、巨大なディレクトリでも stat の回数を上限に抑える。
    const selected = [...dirents].sort(compareDirents).slice(0, FILE_TREE_LIMIT);
    const entries = await Promise.all(
      selected.map((item) => listEntry(rootReal, real, base, item)),
    );
    // symlink の解決で dir に変わったものがあるので、dirs first で並べ直す。
    entries.sort(compareEntries);
    return { entries, total, truncated: total > FILE_TREE_LIMIT };
  } catch {
    return null;
  }
}

// エージェントは使い捨てのモックを /tmp に書く。TMPDIR ではなく literal を見る。
// 本文に書かれるのは `/tmp/...` なので、プロセスの環境で変えても一致しない（ADR 0066）。
const DEFAULT_PREVIEW_ROOT = "/tmp";

// チップとプレビューの見出しに出す根のラベル。番号ではなく設定値の文字列から作る。
// 番号で /tmp を決めると、テストが注入した一時ディレクトリにも /tmp が付く。
// realpath で決めると、/tmp が symlink の環境で別名になる（ADR 0067）。
export function previewRootLabel(value: string): string {
  if (resolve(value) === DEFAULT_PREVIEW_ROOT) return DEFAULT_PREVIEW_ROOT;
  const name = basename(value);
  // basename が空か `/` になるのは根が `/` のときだけ。ラベルに使えないので既定の文言にする。
  return name === "" || name === sep ? "追加根" : name;
}

// 追加の根は既定で /tmp。HWC_PREVIEW_ROOTS はその後ろに足す（ADR 0051, 0066）。
// 区切りは POSIX の `:`。Windows は対象外。
export function defaultPreviewRoots(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = env.HWC_PREVIEW_ROOTS;
  const explicit =
    raw === undefined
      ? []
      : raw
          .split(":")
          .map((root) => root.trim())
          .filter((root) => root !== "" && isAbsolute(root));
  // 表記違いの同じ実体を 2 回試さない。根の番号は先に来たものを保つ。
  const roots: string[] = [];
  const seen = new Set<string>();
  for (const root of [DEFAULT_PREVIEW_ROOT, ...explicit]) {
    const key = resolve(root);
    if (seen.has(key)) continue;
    seen.add(key);
    roots.push(root);
  }
  return roots;
}

// 画像を作り直すと本文は変わらない。版を etag に混ぜないと、304 で古い画像の URL が残る。
function withFileVersions(etag: string, messages: readonly ChatMessage[]): string {
  const parts: string[] = [];
  for (const message of messages) {
    // 根の番号も混ぜる。追加根の順が変わると、同じ名前と版でも配信先が変わる。
    for (const file of message.files ?? []) {
      parts.push(`${file.root}:${file.name}@${file.version}`);
    }
    // リンクは本文の表記と結び付いている。同じ名前の別ファイルに変わっても URL が変わる。
    for (const link of message.links ?? []) {
      parts.push(`link:${link.root}:${link.name}:${link.href}@${link.version}`);
    }
    // 根の外のファイルが現れる・消えるのは本文が変わらないまま起きる。
    if (message.outsideFile !== undefined) parts.push(`outside:${message.outsideFile}`);
  }
  if (parts.length === 0) return etag;
  const digest = createHash("sha256").update(parts.join("\n")).digest("hex").slice(0, 12);
  return `${etag}-${digest}`;
}

// 検出する根は、チェックアウトとプレビュー用の追加根。配信と同じ順で試す。
export async function attachMessageFiles(
  snapshot: ChatSnapshot,
  root: string | null,
  extraRoots: readonly string[] = [],
): Promise<ChatSnapshot> {
  const roots = root === null ? extraRoots : [root, ...extraRoots];
  if (roots.length === 0) return snapshot;

  // 実在しない根も空きとして残す。番号が詰まると、配信の URL と別の根を指してしまう。
  const rootsReal: (string | null)[] = [];
  for (const item of roots) {
    try {
      rootsReal.push(await realpath(item));
    } catch {
      rootsReal.push(null);
    }
  }
  if (rootsReal.every((item) => item === null)) return snapshot;

  // 0 番がチェックアウトのときだけラベルを持たない。持たないペインでは /tmp が 0 番になる。
  const labels = roots.map((item, index) =>
    root !== null && index === 0 ? undefined : previewRootLabel(item),
  );

  const messages = await Promise.all(
    snapshot.messages.map(async (message) => {
      // 失敗の行はプロバイダの文言で、エージェントの発話ではない。
      if (message.role !== "agent" || message.text === "") return message;
      const files = await collectAgainstRoots(message.text, rootsReal, labels);
      if (files.files.length === 0 && files.links.length === 0 && files.outsideFile === undefined)
        return message;
      return {
        ...message,
        ...(files.files.length === 0 ? {} : { files: files.files }),
        ...(files.links.length === 0 ? {} : { links: files.links }),
        ...(files.outsideFile === undefined ? {} : { outsideFile: files.outsideFile }),
      };
    }),
  );
  if (messages.every((message, index) => message === snapshot.messages[index])) return snapshot;
  return { ...snapshot, messages, etag: withFileVersions(snapshot.etag, messages) };
}

export async function readMessageFile(file: { path: string }): Promise<ArrayBuffer | null> {
  try {
    const bytes = await readFile(file.path);
    // stat の後で伸びた分も見る。上限を超えたら配信しない。
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_PREVIEW_FILE_BYTES) return null;
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
