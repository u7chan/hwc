import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { AppState, StateStore } from "./herdr/state";

export function createApp(options: { store: StateStore }) {
  const { store } = options;

  const current = async (): Promise<AppState | null> =>
    store.get() ??
    store.refresh().catch(() => {
      // 取得に失敗した時点で状態は無い。呼び出し側がエラーを返す。
      return null;
    });

  return new Hono()
    .get("/api/health", (c) => c.json({ ok: true, service: "hwc" }))
    .get("/api/state", async (c) => {
      const state = await current();
      if (!state) return c.json({ error: "herdr_unavailable" }, 502);
      return c.json(state);
    })
    .get("/api/events", async (c) => {
      const initial = await current();
      // 状態が無いまま SSE を開くと、client から「取得中」と区別できない。再接続は EventSource に任せる。
      if (!initial) return c.json({ error: "herdr_unavailable" }, 502);

      return streamSSE(c, async (stream) => {
        const send = (state: AppState) =>
          stream.writeSSE({ data: JSON.stringify(state) }).catch(() => {
            // 切断済みのクライアントへの書き込みは失敗する。購読解除は切断の検出側で行う。
          });

        // 初期状態の送信中に届いた更新を取りこぼさないよう、購読を先に張って溜めておく。
        let ready = false;
        let buffered: AppState | null = null;
        const unsubscribe = store.onChange((state) => {
          if (ready) send(state);
          else buffered = state;
        });

        await send(initial);
        ready = true;
        if (buffered && buffered !== initial) await send(buffered);

        // ハンドラが返るとストリームが閉じるので、切断されるまで待つ。
        await new Promise<void>((resolve) => {
          const detach = () => {
            unsubscribe();
            resolve();
          };
          if (stream.aborted) {
            detach();
            return;
          }
          stream.onAbort(detach);
        });
      });
    });
}

export type AppType = ReturnType<typeof createApp>;
