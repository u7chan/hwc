import { TerminalIcon } from "../icons";

// 出力がまだ無いときは、空の枠だけ置いても意味がないので案内を出す。
export function OutputEmpty() {
  return (
    <div class="hwc-output-empty">
      <span class="hwc-output-empty-mark">
        <TerminalIcon size={22} />
      </span>
      <p class="hwc-output-empty-title">まだ出力はありません</p>
      <p class="hwc-output-empty-text">エージェントが動くと、その様子がここに流れます。</p>
    </div>
  );
}

export function ChatEmpty() {
  return (
    <div class="hwc-output-empty">
      <span class="hwc-output-empty-mark">
        <TerminalIcon size={22} />
      </span>
      <p class="hwc-output-empty-title">まだ会話はありません</p>
      <p class="hwc-output-empty-text">メッセージを送ると、やり取りがここに並びます。</p>
    </div>
  );
}

// 中身が届くまでの置き。行数を多めにして、下から伸びるように見せる。
export function OutputSkeleton() {
  return (
    <div class="hwc-skeleton" aria-hidden="true">
      {[92, 78, 86, 64, 88, 72, 40].map((width, index) => (
        <span class="hwc-skeleton-line" key={index} style={{ width: `${width}%` }} />
      ))}
    </div>
  );
}
