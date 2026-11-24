import {
  attachmentContentType,
  attachmentKindOfName,
  decodeAttachmentName,
  FILENAME_HEADER,
  isImageAttachmentName,
  maxAttachmentBytes,
  sanitizeAttachmentName,
} from "../../shared/attachments";
import { readAttachment, saveAttachment } from "../attachments";
import {
  listDirectory,
  messageFileContentType,
  readMessageFile,
  resolveMessageFile,
  resolvePreviewFile,
} from "../message-files";
import { isHtmlName, isTextName, looksBinary, previewWarning } from "../../shared/message-files";
import type { AppContext, IdContext, IdNameContext, PreviewContext } from "./context";

const PREVIEW_CSP = "sandbox allow-scripts";

// HTML はアプリと同じオリジンで配信する。モックの script から BFF を触れないよう、
// sandbox で文書のオリジンを不透明にする。iframe の属性だけに頼らず、直接開いた
// ときにも効くよう応答にも付ける（docs/adr/file-serving.md）。
function previewHeaders(contentType: string): Record<string, string> {
  return {
    "content-type": contentType,
    "x-content-type-options": "nosniff",
    // 書き直した HTML をそのまま見たい。版を URL に入れないのでキャッシュさせない。
    "cache-control": "no-store",
    // 不透明なオリジンからの ES modules と fetch は CORS になる。このルートだけ開ける。
    "access-control-allow-origin": "*",
    "content-security-policy": PREVIEW_CSP,
  };
}

// 書き出し直しや削除でファイルが消えても、iframe に生の JSON を出さない。
const PREVIEW_MISSING = `<!doctype html><meta charset="utf-8"><title>ファイルが見つかりません</title>
<body style="margin:0;display:grid;place-items:center;min-height:100vh;font:14px/1.6 system-ui;color:#5b6068;background:#fff">
<p>ファイルが見つかりません。書き出し直してから再読み込みしてください。</p>`;

function previewNotFound(c: PreviewContext, requested: string): Response {
  if (!isHtmlName(requested)) return c.json({ error: "not_found" }, 404);
  return new Response(PREVIEW_MISSING, {
    status: 404,
    headers: previewHeaders("text/html; charset=utf-8"),
  });
}

export function createFilesHandlers(ctx: AppContext) {
  const { store, previewRoots, attachmentsRoot, resolvePane } = ctx;

  // 根の番号は /files と /preview で共通。片方だけ順を変えると、チップと配信が
  // 別の実体を指す。番号は 0 がチェックアウト、1 以上が追加根（無い場合は 0 から）。
  const rootsFor = (workspaceRoot: string | null): string[] =>
    workspaceRoot === null ? previewRoots : [workspaceRoot, ...previewRoots];

  // 画像は 1 枚の生バイトで受ける。保存名はサーバが決め、上書きしない。
  const uploadAttachment = async (c: IdContext) => {
    // 種別と上限は元のファイル名の拡張子で決まる。body を読む前に名前を検査する。
    // ヘッダは ASCII しか運べないので、クライアントは percent-encode して送る。
    const decoded = decodeAttachmentName(c.req.header(FILENAME_HEADER));
    const name = decoded === null ? "" : sanitizeAttachmentName(decoded);
    if (name === "") return c.json({ error: "invalid_request" }, 400);
    const limit = maxAttachmentBytes(attachmentKindOfName(name));

    const resolved = await resolvePane(c);
    if (!resolved.ok) return resolved.response;
    const { paneId, pane } = resolved;
    if (!pane.chat) return c.json({ error: "no_chat" }, 404);

    // 宣言された長さで先に落とし、読み終えた実バイト数でも見る。
    const declared = Number(c.req.header("content-length"));
    if (Number.isFinite(declared) && declared > limit) {
      return c.json({ error: "attachment_too_large" }, 413);
    }
    const bytes = new Uint8Array(await c.req.arrayBuffer());
    if (bytes.byteLength > limit) {
      return c.json({ error: "attachment_too_large" }, 413);
    }
    if (bytes.byteLength === 0) return c.json({ error: "invalid_request" }, 400);

    const saved = await saveAttachment({ root: attachmentsRoot, paneId, name, bytes });
    if (saved === null) return c.json({ error: "invalid_request" }, 400);
    return c.json({ name: saved });
  };

  // 保存した画像を返す。配信するのは画像 3 形式だけで、名前の検証とは別に絞る。
  const serveAttachment = async (c: IdNameContext) => {
    const resolved = await resolvePane(c);
    if (!resolved.ok) return resolved.response;
    const { paneId, pane } = resolved;
    if (!pane.chat) return c.json({ error: "no_chat" }, 404);

    const name = c.req.param("name") ?? "";
    if (!isImageAttachmentName(name)) return c.json({ error: "invalid_request" }, 400);
    const bytes = await readAttachment({ root: attachmentsRoot, paneId, name });
    if (bytes === null) return c.json({ error: "not_found" }, 404);

    // 保存した名前から決めた型で返し、中身を見て解釈させない。内容は変わらないので
    // 長く持たせる。認証が無い LAN 公開なので private にする。
    return new Response(bytes, {
      headers: {
        "content-type": attachmentContentType(name) ?? "application/octet-stream",
        "x-content-type-options": "nosniff",
        "cache-control": "private, max-age=31536000, immutable",
      },
    });
  };

  return {
    uploadAttachment,
    serveAttachment,
    files: async (c: IdContext) => {
      const resolved = await resolvePane(c);
      if (!resolved.ok) return resolved.response;
      const { paneId } = resolved;

      const roots = rootsFor(store.workspaceRoot(paneId));
      const rootIndex = Number(c.req.query("root") ?? "0");
      if (!Number.isInteger(rootIndex) || rootIndex < 0) {
        return c.json({ error: "not_found" }, 404);
      }
      const root = roots[rootIndex];
      if (root === undefined) return c.json({ error: "not_found" }, 404);

      const file = await resolveMessageFile({ root, path: c.req.query("path") ?? "" });
      if (file === null) return c.json({ error: "not_found" }, 404);
      const bytes = await readMessageFile(file);
      if (bytes === null) return c.json({ error: "not_found" }, 404);

      return new Response(bytes, {
        headers: {
          "content-type": messageFileContentType(file.name) ?? "application/octet-stream",
          "x-content-type-options": "nosniff",
          // 同じ名前で作り直されるので、名前だけでは長期に持たせられない。版が URL に
          // 入っているので、その URL の中では内容が変わらない。
          "cache-control": "private, max-age=31536000, immutable",
        },
      });
    },
    // チェックアウトの 1 ディレクトリを、根からの相対パスで返す。ツリーは子を開いた
    // ときにだけ取りに来る。絶対パスは返さない（docs/adr/file-serving.md）。
    tree: async (c: IdContext) => {
      const resolved = await resolvePane(c);
      if (!resolved.ok) return resolved.response;
      const { paneId } = resolved;

      // 根はワークスペースのチェックアウト。プレビューの追加根（/tmp など）は出さない。
      const root = store.workspaceRoot(paneId);
      if (root === null) return c.json({ error: "no_checkout" }, 404);

      const listing = await listDirectory({ root, path: c.req.query("path") ?? "" });
      if (listing === null) return c.json({ error: "not_found" }, 404);

      c.header("cache-control", "no-store");
      return c.json(listing);
    },
    preview: async (c: PreviewContext) => {
      const resolved = await resolvePane(c);
      if (!resolved.ok) return resolved.response;
      const { paneId } = resolved;

      const requested = c.req.param("path") ?? "";
      const rootIndex = Number(c.req.param("root"));
      if (!Number.isInteger(rootIndex) || rootIndex < 0) return previewNotFound(c, requested);

      const roots = rootsFor(store.workspaceRoot(paneId));
      const root = roots[rootIndex];
      if (root === undefined) return previewNotFound(c, requested);

      const file = await resolvePreviewFile({ root, path: requested });
      const bytes = file === null ? null : await readMessageFile(file);
      if (file === null || bytes === null) return previewNotFound(c, requested);

      // 本文のリンクから開くテキストと、ツリーのプレーン表示は raw を付ける。HTML の
      // アセットにも同じ URL を使うので、raw が付いたときだけ text/plain に固定する（docs/adr/file-serving.md）。
      const raw = c.req.query("raw") === "1" && (isTextName(file.name) || isHtmlName(file.name));
      const contentType = raw ? "text/plain; charset=utf-8" : file.contentType;
      // 拡張子の無いファイルは、開くまでテキストかバイナリか分からない。文字として配る
      // 経路だけ、先頭に NUL が無いことを確かめる（docs/adr/file-serving.md）。
      if (contentType === "text/plain; charset=utf-8" && looksBinary(new Uint8Array(bytes))) {
        return new Response("バイナリファイルのため表示できません。", {
          status: 415,
          headers: previewHeaders(contentType),
        });
      }
      const headers = previewHeaders(contentType);
      // 配信で読んだバイト列をそのまま見る。HTML を書き換えずに、白紙の理由だけを知らせる。
      if (isHtmlName(file.name)) {
        const warning = previewWarning(new TextDecoder().decode(bytes));
        if (warning !== null) headers["x-hwc-preview-warning"] = warning;
      }
      return new Response(bytes, { headers });
    },
  };
}
