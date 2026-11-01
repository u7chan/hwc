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
    .get("/api/events", (c) =>
      streamSSE(c, async (stream) => {
        const send = (state: AppState) =>
          stream.writeSSE({ data: JSON.stringify(state) }).catch(() => {
            // 切断済みのクライアントへの書き込みは失敗する。購読解除は onAbort が行う。
          });

        // 初期状態の送信中に届いた更新を取りこぼさないよう、購読を先に張って溜めておく。
        let ready = false;
        let buffered: AppState | null = null;
        const unsubscribe = store.onChange((state) => {
          if (ready) send(state);
          else buffered = state;
        });

        const initial = await current();
        if (initial) await send(initial);
        ready = true;
        if (buffered && buffered !== initial) await send(buffered);

        // ハンドラが返るとストリームが閉じるので、切断されるまで待つ。
        await new Promise<void>((resolve) => {
          if (stream.aborted) {
            resolve();
            return;
          }
          stream.onAbort(() => {
            unsubscribe();
            resolve();
          });
        });
      }),
    );
}

export type AppType = ReturnType<typeof createApp>;
