import { type Context, Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { ChatClient } from "./chat/pi";
import {
  isInvalidRequest,
  isPaneNotFound,
  type PaneClient,
  parseInputBody,
  parseOutputQuery,
} from "./herdr/panes";
import type { AppState, PaneState, StateStore } from "./herdr/state";

// Bun.serve は 10 秒間何も書かれない chunked 応答を打ち切る。状態が変わらない間も接続を
// 保つため、これより短い間隔でハートビートを送る。
export const SSE_HEARTBEAT_MS = 5_000;

export function createApp(options: {
  store: StateStore;
  panes: PaneClient;
  chat: ChatClient;
  revision?: string;
  sseHeartbeatMs?: number;
}) {
  const { store, panes, chat, revision = "dev", sseHeartbeatMs = SSE_HEARTBEAT_MS } = options;

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

  const findPane = (state: AppState, paneId: string): PaneState | null => {
    for (const workspace of state.workspaces) {
      for (const tab of workspace.tabs) {
        for (const pane of tab.panes) {
          if (pane.id === paneId) return pane;
        }
      }
    }
    return null;
  };

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

      try {
        await panes.send({ paneId: c.req.param("id"), ...input.value });
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
    });
}

export type AppType = ReturnType<typeof createApp>;
