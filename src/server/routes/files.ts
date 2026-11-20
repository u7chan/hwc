import { findPane } from "../herdr/state";
import {
  listDirectory,
  messageFileContentType,
  readMessageFile,
  resolveMessageFile,
  resolvePreviewFile,
} from "../message-files";
import { isHtmlName, isTextName, looksBinary, previewWarning } from "../../shared/message-files";
import type { AppContext, IdContext, PreviewContext } from "./context";

const PREVIEW_CSP = "sandbox allow-scripts";

// HTML はアプリと同じオリジンで配信する。モックの script から BFF を触れないよう、
// sandbox で文書のオリジンを不透明にする。iframe の属性だけに頼らず、直接開いた
// ときにも効くよう応答にも付ける（ADR 0051）。
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
  const { store, current, rootsFor, uploadAttachment, serveAttachment } = ctx;

  return {
    uploadAttachment,
    serveAttachment,
    files: async (c: IdContext) => {
      const state = await current();
      if (!state) return c.json({ error: "herdr_unavailable" }, 502);

      const paneId = c.req.param("id");
      const pane = findPane(state, paneId);
      if (!pane) return c.json({ error: "pane_not_found" }, 404);

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
    // ときにだけ取りに来る。絶対パスは返さない（ADR 0041）。
    tree: async (c: IdContext) => {
      const state = await current();
      if (!state) return c.json({ error: "herdr_unavailable" }, 502);

      const paneId = c.req.param("id");
      const pane = findPane(state, paneId);
      if (!pane) return c.json({ error: "pane_not_found" }, 404);

      // 根はワークスペースのチェックアウト。プレビューの追加根（/tmp など）は出さない。
      const root = store.workspaceRoot(paneId);
      if (root === null) return c.json({ error: "no_checkout" }, 404);

      const listing = await listDirectory({ root, path: c.req.query("path") ?? "" });
      if (listing === null) return c.json({ error: "not_found" }, 404);

      c.header("cache-control", "no-store");
      return c.json(listing);
    },
    preview: async (c: PreviewContext) => {
      const state = await current();
      if (!state) return c.json({ error: "herdr_unavailable" }, 502);

      const paneId = c.req.param("id");
      const pane = findPane(state, paneId);
      if (!pane) return c.json({ error: "pane_not_found" }, 404);

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
      // アセットにも同じ URL を使うので、raw が付いたときだけ text/plain に固定する（ADR 0109）。
      const raw = c.req.query("raw") === "1" && (isTextName(file.name) || isHtmlName(file.name));
      const contentType = raw ? "text/plain; charset=utf-8" : file.contentType;
      // 拡張子の無いファイルは、開くまでテキストかバイナリか分からない。文字として配る
      // 経路だけ、先頭に NUL が無いことを確かめる（ADR 0109）。
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
