import { GripIcon } from "./icons";

// 画面上端に近いときは、ガイドを指の上ではなく下に出す。上に出すと画面外へ切れる。
const GHOST_BELOW_Y = 96;

// 固定配置のガイドは、毎回の再描画を避けて CSS 変数だけで動かす。値は viewport 座標。
export function setDragGhostPoint(x: number, y: number) {
  const root = document.documentElement;
  // ガイドは最大 280px。中心を viewport 内へ収め、画面端でも名前とグリップを切らない。
  const margin = Math.min(140, window.innerWidth / 2);
  const clampedX = Math.max(margin, Math.min(window.innerWidth - margin, x));
  root.style.setProperty("--hwc-drag-ghost-x", `${clampedX}px`);
  root.style.setProperty("--hwc-drag-ghost-y", `${y}px`);
  root.dataset.dragGhost = y < GHOST_BELOW_Y ? "below" : "above";
}

export function clearDragGhostPoint() {
  const root = document.documentElement;
  root.style.removeProperty("--hwc-drag-ghost-x");
  root.style.removeProperty("--hwc-drag-ghost-y");
  delete root.dataset.dragGhost;
}

export function DragGhost({ label }: { label: string }) {
  return (
    <div class="hwc-drag-ghost" aria-hidden="true">
      <span class="hwc-drag-ghost-grip">
        <GripIcon size={16} />
      </span>
      <span class="hwc-drag-ghost-name">{label}</span>
    </div>
  );
}
