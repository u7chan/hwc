import { type Context, Hono } from "hono";
import { streamSSE } from "hono/streaming";
import {
  attachmentContentType,
  attachmentExtOf,
  composeInputText,
  isAttachmentName,
  MAX_ATTACHMENT_BYTES,
} from "../shared/attachments";
import {
  attachmentExists,
  attachmentFilePath,
  defaultAttachmentsRoot,
  readAttachment,
  saveAttachment,
} from "./attachments";
import type { ChatClient } from "./chat/pi";
import {
  exceedsTextLimit,
  isInvalidRequest,
  isPaneNotFound,
  type PaneClient,
  parseInputBody,
  parseOutputQuery,
  TEXT_TOO_LONG,
  TEXT_WITH_ATTACHMENTS_TOO_LONG,
} from "./herdr/panes";
import type { AppState, PaneState, StateStore, TabState } from "./herdr/state";
import { planSplit } from "./herdr/split";
import { MAX_PANES_PER_TAB } from "../shared/panes";

// Bun.serve は 10 秒間何も書かれない chunked 応答を打ち切る。状態が変わらない間も接続を
// 保つため、これより短い間隔でハートビートを送る。
export const SSE_HEARTBEAT_MS = 5_000;

export function createApp(options: {
  store: StateStore;
  panes: PaneClient;
  chat: ChatClient;
  revision?: string;
  sseHeartbeatMs?: number;
  // 保存先はテストが実ホームへ書かないよう、外から差し替えられるようにする。
  attachmentsRoot?: string;
}) {
  const {
    store,
    panes,
    chat,
    revision = "dev",
    sseHeartbeatMs = SSE_HEARTBEAT_MS,
    attachmentsRoot = defaultAttachmentsRoot(),
  } = options;

  const current = async (): Promise<AppState | null> =>
    store.get() ??
    store.refresh().catch(() => {
      // 取得に失敗した時点で状態は無い。呼び出し側がエラーを返す。
      return null;
    });

  const paneFailure = (c: Context, error: unknown) => {
    if (isPaneNotFound(error)) return c.json({ error: "pane_not_found" }, 404);
    if (isInvalidRequest(error)) return c.json({ error: "invalid_request" }, 400);
    return c.json({ error: "herdr_unavailable" }, 502);
  };

  const findPaneTab = (state: AppState, paneId: string): TabState | null => {
    for (const workspace of state.workspaces) {
      for (const tab of workspace.tabs) {
        if (tab.panes.some((pane) => pane.id === paneId)) return tab;
      }
    }
    return null;
  };

  const findPane = (state: AppState, paneId: string): PaneState | null =>
    findPaneTab(state, paneId)?.panes.find((pane) => pane.id === paneId) ?? null;

  // If-None-Match は弱比較。W/ と引用符を落として比べ、複数値と * も受ける。
  const matchesEtag = (header: string | undefined, etag: string): boolean => {
    if (header === undefined) return false;
    return header.split(",").some((value) => {
      const trimmed = value.trim();
      if (trimmed === "*") return true;
      const unquoted = (trimmed.startsWith("W/") ? trimmed.slice(2) : trimmed).replace(
        /^"|"$/g,
        "",
      );
      return unquoted === etag;
    });
  };

  // 状態を変える POST は simple request で叩かれないよう application/json に限る。
  // CORS を返さないので、cross-origin は preflight で止まる。
  const isJsonRequest = (c: Context): boolean =>
    (c.req.header("content-type") ?? "").split(";")[0]?.trim().toLowerCase() === "application/json";

  // 画像は 1 枚の生バイトで受ける。保存名はサーバが決め、上書きしない。
  const uploadAttachment = async (c: Context) => {
    // 415 は body を読む前に返す。text/plain のような simple request は preflight を
    // 通らないので、Content-Type の allowlist だけで守る。
    const ext = attachmentExtOf(c.req.header("content-type"));
    if (ext === null) return c.json({ error: "unsupported_media_type" }, 415);

    const state = await current();
    if (!state) return c.json({ error: "herdr_unavailable" }, 502);

    const paneId = c.req.param("id") ?? "";
    const pane = findPane(state, paneId);
    if (!pane) return c.json({ error: "pane_not_found" }, 404);
    if (!pane.chat) return c.json({ error: "no_chat" }, 404);

    // 宣言された長さで先に落とし、読み終えた実バイト数でも見る。
    const declared = Number(c.req.header("content-length"));
    if (Number.isFinite(declared) && declared > MAX_ATTACHMENT_BYTES) {
      return c.json({ error: "attachment_too_large" }, 413);
    }
    const bytes = new Uint8Array(await c.req.arrayBuffer());
    if (bytes.byteLength > MAX_ATTACHMENT_BYTES) {
      return c.json({ error: "attachment_too_large" }, 413);
    }
    if (bytes.byteLength === 0) return c.json({ error: "invalid_request" }, 400);

    const name = await saveAttachment({ root: attachmentsRoot, paneId, ext, bytes });
    if (name === null) return c.json({ error: "invalid_request" }, 400);
    return c.json({ name });
  };

  // 保存した画像を返す。名前は固定書式だけを通してからパスへ連結する。
  const serveAttachment = async (c: Context) => {
    const state = await current();
    if (!state) return c.json({ error: "herdr_unavailable" }, 502);

    const paneId = c.req.param("id") ?? "";
    const pane = findPane(state, paneId);
    if (!pane) return c.json({ error: "pane_not_found" }, 404);
    if (!pane.chat) return c.json({ error: "no_chat" }, 404);

    const name = c.req.param("name") ?? "";
    if (!isAttachmentName(name)) return c.json({ error: "invalid_request" }, 400);
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

  return new Hono()
    .get("/api/health", (c) => c.json({ ok: true, service: "hwc", revision }))
    .get("/api/state", async (c) => {
      const state = await current();
      if (!state) return c.json({ error: "herdr_unavailable" }, 502);
      return c.json(state);
    })
    .get("/api/events", (c) =>
      streamSSE(c, async (stream) => {
        const write = (event: string | null, data: string) =>
          stream.writeSSE(event ? { event, data } : { data }).catch(() => {
            // 切断済みのクライアントへの書き込みは失敗する。購読解除は切断の検出側で行う。
          });
        const send = (state: AppState) => write(null, JSON.stringify(state));

        // 初期状態の送信中に届いた更新を取りこぼさないよう、購読を先に張って溜めておく。
        let ready = false;
        let buffered: AppState | null = null;
        const unsubscribe = store.onChange((state) => {
          if (ready) send(state);
          else buffered = state;
        });

        // 初期取得の間に届いた更新があればそれが最新なので、初回状態として使う。
        const initial = (await current()) ?? buffered;

        // 状態が無くてもストリームは開いたままにする。ここで 502 を返すと EventSource は
        // 接続失敗として扱い、以後再接続しない（Herdr 復帰後も画面が止まる）。
        if (initial) await send(initial);
        else await write("unavailable", "");
        ready = true;
        if (buffered && buffered !== initial) await send(buffered);

        // ハンドラが返るとストリームが閉じるので、切断されるまで待つ。
        await new Promise<void>((resolve) => {
          // 状態の変化が無い間も書き続ける。無名イベントのコメント行は EventSource が
          // 読み飛ばすので、状態を受ける onmessage は反応しない。
          const heartbeat = setInterval(() => {
            void stream.write(": ping\n\n");
          }, sseHeartbeatMs);

          const detach = () => {
            clearInterval(heartbeat);
            unsubscribe();
            resolve();
          };
          if (stream.aborted) {
            detach();
            return;
          }
          stream.onAbort(detach);
        });
      }),
    )
    .get("/api/panes/:id/chat", async (c) => {
      const state = await current();
      if (!state) return c.json({ error: "herdr_unavailable" }, 502);

      const paneId = c.req.param("id");
      const pane = findPane(state, paneId);
      if (!pane) return c.json({ error: "pane_not_found" }, 404);

      // path はクライアントから受け取らず、BFF がペイン id から引く。
      const path = store.sessionPath(paneId);
      if (!pane.chat || path === null) return c.json({ error: "no_chat" }, 404);

      try {
        const snapshot = await chat.snapshot(path);
        // context.window はプロセス内で 1 回だけ解決したカタログから引く（pi.ts）。起動後に
        // モデルカタログを再読込しないので window はプロセス内で定数になり、session の
        // generation だけを ETag にしても整合する。
        c.header("ETag", `"${snapshot.etag}"`);
        if (matchesEtag(c.req.header("if-none-match"), snapshot.etag)) {
          return c.body(null, 304);
        }
        return c.json(snapshot);
      } catch {
        return c.json({ error: "chat_unavailable" }, 502);
      }
    })
    .post("/api/panes/:id/attachments", uploadAttachment)
    .get("/api/panes/:id/attachments/:name", serveAttachment)
    .get("/api/panes/:id/output", async (c) => {
      const query = parseOutputQuery(new URL(c.req.url).searchParams);
      if (!query.ok) return c.json({ error: query.error }, query.status);

      try {
        const output = await panes.read({ paneId: c.req.param("id"), ...query.value });
        return c.json(output);
      } catch (error) {
        return paneFailure(c, error);
      }
    })
    .post("/api/panes/:id/input", async (c) => {
      // ペインへ入力を流す唯一のエンドポイントなので、simple request で叩かれないよう
      // application/json に限る。CORS を返さないので、cross-origin は preflight で止まる。
      if (!isJsonRequest(c)) {
        return c.json({ error: "content-type must be application/json" }, 415);
      }

      // body は JSON として読み切ってから text のバイト数で上限を見る。Content-Type の検証で
      // browser の cross-origin は preflight に落ちるが、LAN の非 browser client はここまで
      // 到達し得る。その場合の巨大 body は Bun の body 読み込みに任せる。
      const body = await c.req.json().catch(() => null);
      const input = parseInputBody(body);
      if (!input.ok) return c.json({ error: input.error }, input.status);

      const paneId = c.req.param("id");
      const paths: string[] = [];
      // 添付が無いときは Herdr の pane_not_found に任せる。ペインの実在を状態から引くと、
      // 従来の経路に余分な往復が増える。
      if (input.value.attachments.length > 0) {
        const state = await current();
        if (!state) return c.json({ error: "herdr_unavailable" }, 502);

        const pane = findPane(state, paneId);
        if (!pane) return c.json({ error: "pane_not_found" }, 404);
        if (!pane.chat) return c.json({ error: "no_chat" }, 404);

        // 書式は parseInputBody が見ている。ここではこのペインの保存先の実在を確かめる。
        for (const name of input.value.attachments) {
          const path = attachmentFilePath(attachmentsRoot, paneId, name);
          if (path === null || !(await attachmentExists(attachmentsRoot, paneId, name))) {
            return c.json({ error: "invalid_request" }, 400);
          }
          paths.push(path);
        }
      }

      // 上限は注記を組み立てた後の本文で測る。パスの分だけ書ける量が減る。
      const text = composeInputText(input.value.text, paths);
      if (exceedsTextLimit(text)) {
        return c.json(
          { error: paths.length === 0 ? TEXT_TOO_LONG : TEXT_WITH_ATTACHMENTS_TOO_LONG },
          413,
        );
      }

      try {
        await panes.send({ paneId, text, submit: input.value.submit });
        return c.json({ ok: true });
      } catch (error) {
        return paneFailure(c, error);
      }
    })
    .post("/api/panes/:id/stop", async (c) => {
      // 実行中のターンを止める操作なので、form POST で叩ける状態にしない。
      if (!isJsonRequest(c)) {
        return c.json({ error: "content-type must be application/json" }, 415);
      }

      const state = await current();
      if (!state) return c.json({ error: "herdr_unavailable" }, 502);

      const paneId = c.req.param("id");
      const pane = findPane(state, paneId);
      if (!pane) return c.json({ error: "pane_not_found" }, 404);

      // 止まっているペインに Esc を送ると、入力欄やダイアログを閉じてしまう。
      // 画面が古いだけの再クリックは成功として扱い、状態の反映はイベントに任せる。
      if (pane.agentStatus !== "working") return c.json({ ok: true });

      try {
        await panes.stop({ paneId });
        return c.json({ ok: true });
      } catch (error) {
        return paneFailure(c, error);
      }
    })
    .post("/api/panes/:id/focus", async (c) => {
      // TUI のフォーカスを動かす操作なので、form POST で叩ける状態にしない。
      // body は読まない（ペイン id は path にあり、追加の指定は無い）。
      if (!isJsonRequest(c)) {
        return c.json({ error: "content-type must be application/json" }, 415);
      }

      const state = await current();
      if (!state) return c.json({ error: "herdr_unavailable" }, 502);

      const paneId = c.req.param("id");
      if (!findPane(state, paneId)) return c.json({ error: "pane_not_found" }, 404);

      try {
        await panes.focus({ paneId });
        // 状態の取り直しは Herdr のイベント（pane.focused / pane.agent_status_changed）に任せる。
        // ここで refresh を待つと、成功した focus が再取得の失敗で 502 になる。
        return c.json({ ok: true });
      } catch (error) {
        return paneFailure(c, error);
      }
    })
    .post("/api/panes/:id/close", async (c) => {
      // ペインとエージェントを終わらせる操作なので、form POST で叩ける状態にしない。
      // body は読まない（ペイン id は path にあり、追加の指定は無い）。
      if (!isJsonRequest(c)) {
        return c.json({ error: "content-type must be application/json" }, 415);
      }

      const state = await current();
      if (!state) return c.json({ error: "herdr_unavailable" }, 502);

      const paneId = c.req.param("id");
      if (!findPane(state, paneId)) return c.json({ error: "pane_not_found" }, 404);

      try {
        await panes.close({ paneId });
        // focus と同じく、状態の取り直しは Herdr のイベント（pane.closed）に任せる。
        return c.json({ ok: true });
      } catch (error) {
        return paneFailure(c, error);
      }
    })
    .post("/api/panes/:id/split", async (c) => {
      // ペインを増やす操作なので、form POST で叩ける状態にしない。
      // body は読まない（追加の指定は無く、対象は path とレイアウトから決める）。
      if (!isJsonRequest(c)) {
        return c.json({ error: "content-type must be application/json" }, 415);
      }

      const state = await current();
      if (!state) return c.json({ error: "herdr_unavailable" }, 502);

      const paneId = c.req.param("id");
      const tab = findPaneTab(state, paneId);
      if (tab === null) return c.json({ error: "pane_not_found" }, 404);
      // 画面が古い・同時に押された場合の取りこぼしを、Herdr を呼ぶ前に止める。
      if (tab.panes.length >= MAX_PANES_PER_TAB) return c.json({ error: "pane_limit" }, 409);

      try {
        const layout = await panes.layout({ paneId });
        const plan = planSplit(layout.cells);
        if (plan === null) return c.json({ error: "pane_limit" }, 409);

        const created = await panes.split({
          paneId: plan.paneId,
          direction: plan.direction,
          ratio: plan.ratio,
        });
        // focus / close と同じく、状態の取り直しは Herdr のイベント（pane.created）に任せる。
        return c.json({ paneId: created.paneId });
      } catch (error) {
        return paneFailure(c, error);
      }
    });
}

export type AppType = ReturnType<typeof createApp>;
