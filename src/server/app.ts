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
      }),
    );
}

export type AppType = ReturnType<typeof createApp>;
