import { streamSSE } from "hono/streaming";
import type { AppState } from "../herdr/state";
import type { AppContext, PlainContext } from "./context";

export function createStateHandlers(ctx: AppContext) {
  const { store, revision, sseHeartbeatMs, stateMessage, current } = ctx;

  return {
    health: (c: PlainContext) => c.json({ ok: true, service: "hwc", revision }),
    state: async (c: PlainContext) => {
      const state = await current();
      if (!state) return c.json({ error: "herdr_unavailable" }, 502);
      return c.json(stateMessage(state));
    },
    events: (c: PlainContext) =>
      streamSSE(c, async (stream) => {
        const write = (event: string | null, data: string) =>
          stream.writeSSE(event ? { event, data } : { data }).catch(() => {
            // 切断済みのクライアントへの書き込みは失敗する。購読解除は切断の検出側で行う。
          });
        const send = (state: AppState) => write(null, JSON.stringify(stateMessage(state)));

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
  };
}
