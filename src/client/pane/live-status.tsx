import { useEffect, useRef, useState } from "preact/hooks";
import { formatTokPerSecond } from "../activity";
import { formatElapsed } from "../time";

// ターンが終わったとき、会話へ高さを返すのは即時、中身だけを短く薄く消す。高さを
// アニメーションするとスクロール領域のリフローが毎フレーム走るため、高さは待たない。
// この値で DOM を外す。app.css の closing の transition と同じ長さに揃える。
const LIVE_EXIT_MS = 120;

type LiveView = {
  phase: string | null;
  thought: string;
  elapsedMs: number | null;
  compacting: boolean;
  stopping: boolean;
  // 低いセルでは会話の高さを優先する。thinking の枠を出さず、段階と経過だけにする。
  // 出すときは thinking が無い間も 2 行分を空けたままにする。段階の切り替わりで
  // 高さが変わると、上に載る会話の見える範囲が動くため。
  showThought: boolean;
  // 生成中だけ入る。低いセルでは親が null にする。
  tokPerSecond: number | null;
};

// 実行中の段階と thinking の末尾。会話の外（入力欄の直上）に固定して出し、
// 読み返している間も何が起きているかを見せる。入力欄の上なので、高さが変わっても
// 入力欄の位置は動かない。
export function LiveStatus(props: LiveView & { open: boolean; onCancelCompaction: () => void }) {
  const latest = useRef<LiveView | null>(null);
  const wasOpen = useRef(false);
  const [fading, setFading] = useState(false);

  const view: LiveView = {
    phase: props.phase,
    thought: props.thought,
    elapsedMs: props.elapsedMs,
    compacting: props.compacting,
    stopping: props.stopping,
    showThought: props.showThought,
    tokPerSecond: props.tokPerSecond,
  };
  // 消える間は、閉じる直前の内容をそのまま薄くする。閉じた瞬間に親の値が
  // null へ戻るため、そのまま描くと空の帯が一瞬光って見える。
  if (props.open) latest.current = view;
  const shown = props.open ? view : latest.current;
  // 閉じた最初の描画も closing として置く。effect を待つと 1 フレームだけ消える。
  const closingNow = wasOpen.current && !props.open;
  wasOpen.current = props.open;

  useEffect(() => {
    if (props.open) {
      setFading(false);
      return;
    }
    if (latest.current === null) return;
    setFading(true);
    const timer = window.setTimeout(() => setFading(false), LIVE_EXIT_MS);
    return () => window.clearTimeout(timer);
  }, [props.open]);

  if (shown === null || (!props.open && !closingNow && !fading)) return null;

  const tok = shown.tokPerSecond === null ? null : formatTokPerSecond(shown.tokPerSecond);
  return (
    <div class="hwc-live-slot" data-state={props.open ? "open" : "closing"}>
      {/* pi 以外や sidecar の無いペインでは、中身が経過時間だけになる。状態名を
          支援技術へも渡すため、名前は帯に持たせる。消える間は操作も読み上げも止める。 */}
      <div
        class="hwc-live"
        role="group"
        aria-label={shown.compacting ? "会話を圧縮しています" : "返答を待っています"}
        aria-hidden={!props.open}
      >
        <div class="hwc-live-head">
          <span class="hwc-typing">
            <span />
            <span />
            <span />
          </span>
          {shown.phase === null ? null : <span class="hwc-live-phase">{shown.phase}</span>}
          {shown.compacting ? (
            <span class="hwc-compaction-pending">会話を圧縮しています</span>
          ) : null}
          <span class="hwc-live-tail">
            {shown.compacting ? (
              <button
                type="button"
                class="hwc-compaction-cancel"
                disabled={shown.stopping}
                tabIndex={props.open ? undefined : -1}
                onClick={props.onCancelCompaction}
              >
                {shown.stopping ? "中断中" : "中断"}
              </button>
            ) : null}
            {tok === null ? null : <span class="hwc-live-tok">{tok} tok/s</span>}
            {shown.elapsedMs === null ? null : (
              <span class="hwc-live-elapsed">{formatElapsed(shown.elapsedMs)}</span>
            )}
          </span>
        </div>
        {shown.showThought ? (
          <div class="hwc-live-thought">
            {shown.thought === "" ? null : <p class="hwc-live-thought-text">{shown.thought}</p>}
          </div>
        ) : null}
      </div>
    </div>
  );
}
