import { streamSSE } from "hono/streaming";
import { parseActiveOrderBody } from "../active-order";
import type { AppState } from "../herdr/state";
import type { AppContext, PlainContext } from "./context";

export function createStateHandlers(ctx: AppContext) {
  const { store, revision, sseHeartbeatMs, current, resolveState, activeOrder } = ctx;

  // 「今」は状態ではなく送信時に決める。状態に持たせると、キャッシュされた状態に古い時刻が
  // 残り、状態が動かない間は経過が止まって見える。クライアントはこの now で時計を合わせる。
  const stateMessage = (state: AppState) => ({ state, now: Date.now() });

  return {
    health: (c: PlainContext) => c.json({ ok: true, service: "hwc", revision }),
    state: async (c: PlainContext) => {
      const resolved = await resolveState(c);
      if (!resolved.ok) return resolved.response;
      return c.json(stateMessage(resolved.state));
    },
    // Herdr がイベントを出さない cwd とブランチを追うための契機。状態は応答ではなく
    // SSE で配るので、ここでは取り直したことだけを返す（docs/adr/herdr-socket.md）。
    refresh: async (c: PlainContext) => {
      try {
        await store.refresh();
      } catch {
        return c.json({ error: "herdr_unavailable" }, 502);
      }
      return c.json({ ok: true });
    },
    // アクティブ一覧の並びは Herdr の状態ではなく hwc の見え方。保存したら手元の状態を
    // 配り直し、全端末を同じ順にする（docs/adr/state-storage.md）。
    setActiveOrder: async (c: PlainContext) => {
      const body = await c.req.json().catch(() => null);
      const parsed = parseActiveOrderBody(body);
      if (!parsed.ok) return c.json({ error: parsed.error }, 400);
      try {
        activeOrder.save(parsed.value);
      } catch {
        // 保存できなければ並びは変えない。画面には古い順が残る。
        return c.json({ error: "settings_unavailable" }, 500);
      }
      store.republish();
      return c.json({ ok: true });
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
