import { useEffect, useRef, useState } from "preact/hooks";
import { dropAnchor, type UnitRect } from "./order";

// タッチは長押しで掴む。マウスは少し動かした時点で掴む。どちらも見出しの開閉と同じ
// ボタンの上なので、短いタップは今までどおり開閉に残す。
const LONG_PRESS_MS = 380;
const MOUSE_THRESHOLD = 5;
const TOUCH_THRESHOLD = 10;
const AUTO_SCROLL_EDGE = 56;
const AUTO_SCROLL_STEP = 12;
// 画面上端に近いときは、ガイドを指の上ではなく下に出す。上に出すと画面外へ切れる。
const GHOST_BELOW_Y = 96;

export type OrderDrag = {
  key: string;
  label: string;
  // undefined は「掴んだが、まだ落とし先を決めていない」。null は末尾。
  anchor: string | null | undefined;
};

export type OrderDrop = {
  key: string;
  beforeKey: string | null;
  // ドロップ直前の各ブロックの縦位置。落とした後の入れ替えを見せるアニメーションに使う。
  offsets: ReadonlyMap<string, number>;
};

type Pending = {
  element: HTMLElement;
  key: string;
  label: string;
  pointerId: number;
  pointerType: string;
  startX: number;
  startY: number;
  lastX: number;
  lastY: number;
  active: boolean;
  anchor: string | null | undefined;
  timer: ReturnType<typeof setTimeout> | null;
  frame: number | null;
  scroll: HTMLElement | null;
  blockingScroll: boolean;
};

function clearTimer(pending: Pending) {
  if (pending.timer === null) return;
  clearTimeout(pending.timer);
  pending.timer = null;
}

// 固定配置のガイドは、毎回の再描画を避けて CSS 変数だけで動かす。値は viewport 座標。
// 「ここに移動」のラベルは、掴んでいる指の反対側へ置いて重ならないようにする。
function setGhostPoint(x: number, y: number, scroll: HTMLElement | null) {
  const root = document.documentElement;
  // ガイドは最大 280px。中心を viewport 内へ収め、画面端でも名前とグリップを切らない。
  const margin = Math.min(140, window.innerWidth / 2);
  const clampedX = Math.max(margin, Math.min(window.innerWidth - margin, x));
  root.style.setProperty("--hwc-order-ghost-x", `${clampedX}px`);
  root.style.setProperty("--hwc-order-ghost-y", `${y}px`);
  root.dataset.orderGhost = y < GHOST_BELOW_Y ? "below" : "above";
  if (scroll !== null) {
    const rect = scroll.getBoundingClientRect();
    root.dataset.orderGuide = x < rect.left + rect.width / 2 ? "right" : "left";
  }
}

function clearGhostPoint() {
  const root = document.documentElement;
  root.style.removeProperty("--hwc-order-ghost-x");
  root.style.removeProperty("--hwc-order-ghost-y");
  delete root.dataset.orderGhost;
  delete root.dataset.orderGuide;
}

// 見出しの offsetTop はスクロール位置に依存しない。落とした後に、この位置から
// 新しい位置までの差分を transform で見せる。
function collectOffsets(scroll: HTMLElement | null): Map<string, number> {
  const offsets = new Map<string, number>();
  if (scroll === null) return offsets;
  for (const node of scroll.querySelectorAll<HTMLElement>("[data-order-key]")) {
    const key = node.dataset.orderKey;
    if (key !== undefined) offsets.set(key, node.offsetTop);
  }
  return offsets;
}

export function useOrderDrag(options: {
  units: readonly { key: string }[];
  onDrop: (drop: OrderDrop) => void;
}) {
  const [drag, setDrag] = useState<OrderDrag | null>(null);
  const pending = useRef<Pending | null>(null);
  const suppressClick = useRef(false);

  // ドラッグ中だけ刺す。常設の非 passive な touchmove は、すべてのスクロールで
  // ブラウザに listener の完了を待たせる。passive: false は preventDefault に必要。
  const stopScroll = useRef((event: TouchEvent) => {
    if (pending.current?.active === true) event.preventDefault();
  }).current;

  useEffect(() => {
    return () => {
      const current = pending.current;
      if (current?.blockingScroll === true) {
        document.removeEventListener("touchmove", stopScroll);
      }
      if (current?.timer != null) clearTimeout(current.timer);
      if (current?.frame != null) cancelAnimationFrame(current.frame);
      pending.current = null;
      clearGhostPoint();
    };
  }, [stopScroll]);

  function updateTarget() {
    const current = pending.current;
    if (current === null || !current.active || current.scroll === null) return;

    const rects: UnitRect[] = [];
    for (const node of current.scroll.querySelectorAll<HTMLElement>("[data-order-key]")) {
      const key = node.dataset.orderKey;
      if (key === undefined || key === current.key) continue;
      const rect = node.getBoundingClientRect();
      rects.push({ key, top: rect.top, bottom: rect.bottom });
    }

    const anchor = dropAnchor(rects, current.lastY);
    if (anchor === current.anchor) return;
    current.anchor = anchor;
    setDrag({ key: current.key, label: current.label, anchor });
  }

  function tick() {
    const current = pending.current;
    if (current === null || !current.active) return;

    const scroll = current.scroll;
    if (scroll !== null) {
      const rect = scroll.getBoundingClientRect();
      const direction =
        current.lastY < rect.top + AUTO_SCROLL_EDGE
          ? -1
          : current.lastY > rect.bottom - AUTO_SCROLL_EDGE
            ? 1
            : 0;
      if (direction !== 0) {
        const max = Math.max(0, scroll.scrollHeight - scroll.clientHeight);
        const next = Math.max(0, Math.min(max, scroll.scrollTop + direction * AUTO_SCROLL_STEP));
        if (next !== scroll.scrollTop) {
          scroll.scrollTop = next;
          updateTarget();
        }
      }
    }

    current.frame = requestAnimationFrame(tick);
  }

  function activate() {
    const current = pending.current;
    if (current === null || current.active) return;
    clearTimer(current);
    current.active = true;
    current.anchor = undefined;
    // 掴んだ後のクリックで開閉しない。次の pointerdown で戻す。
    suppressClick.current = true;
    if (!current.blockingScroll) {
      current.blockingScroll = true;
      document.addEventListener("touchmove", stopScroll, { passive: false });
    }
    setGhostPoint(current.lastX, current.lastY, current.scroll);
    setDrag({ key: current.key, label: current.label, anchor: undefined });
    current.frame = requestAnimationFrame(tick);
  }

  function reset(release: boolean) {
    const current = pending.current;
    if (current === null) return;
    clearTimer(current);
    if (current.frame !== null) cancelAnimationFrame(current.frame);
    if (current.blockingScroll) {
      current.blockingScroll = false;
      document.removeEventListener("touchmove", stopScroll);
    }
    pending.current = null;
    clearGhostPoint();
    setDrag(null);
    if (release && current.element.hasPointerCapture(current.pointerId)) {
      current.element.releasePointerCapture(current.pointerId);
    }
  }

  function begin(key: string, label: string) {
    return (event: PointerEvent) => {
      if (event.button !== 0 || options.units.length < 2) return;
      if (pending.current !== null) return;

      const element = event.currentTarget as HTMLElement | null;
      if (element === null) return;
      try {
        element.setPointerCapture(event.pointerId);
      } catch {
        return;
      }

      suppressClick.current = false;
      pending.current = {
        element,
        key,
        label,
        pointerId: event.pointerId,
        pointerType: event.pointerType,
        startX: event.clientX,
        startY: event.clientY,
        lastX: event.clientX,
        lastY: event.clientY,
        active: false,
        anchor: undefined,
        timer: null,
        frame: null,
        scroll: element.closest<HTMLElement>(".hwc-list-scroll"),
        blockingScroll: false,
      };

      // マウスは動きで掴む。タッチは長押しが来るまで待ち、動いたらスクロールに譲る。
      if (event.pointerType !== "mouse") {
        const pointerId = event.pointerId;
        pending.current.timer = setTimeout(() => {
          if (pending.current?.pointerId === pointerId) activate();
        }, LONG_PRESS_MS);
      }
    };
  }

  function move(event: PointerEvent) {
    const current = pending.current;
    if (current === null || current.pointerId !== event.pointerId) return;
    current.lastX = event.clientX;
    current.lastY = event.clientY;

    if (!current.active) {
      const distance = Math.hypot(event.clientX - current.startX, event.clientY - current.startY);
      const threshold = current.pointerType === "mouse" ? MOUSE_THRESHOLD : TOUCH_THRESHOLD;
      if (distance <= threshold) return;
      if (current.pointerType !== "mouse") {
        reset(true);
        return;
      }
      activate();
    } else {
      event.preventDefault();
      setGhostPoint(current.lastX, current.lastY, current.scroll);
    }

    updateTarget();
  }

  function up(event: PointerEvent) {
    const current = pending.current;
    if (current === null || current.pointerId !== event.pointerId) return;

    const drop =
      current.active && current.anchor !== undefined
        ? {
            key: current.key,
            beforeKey: current.anchor,
            offsets: collectOffsets(current.scroll),
          }
        : null;
    reset(false);
    if (drop !== null) options.onDrop(drop);
  }

  function cancel(event: PointerEvent) {
    const current = pending.current;
    if (current === null || current.pointerId !== event.pointerId) return;
    reset(true);
  }

  function lostCapture(event: PointerEvent) {
    const current = pending.current;
    if (current === null || current.pointerId !== event.pointerId) return;
    reset(false);
  }

  return {
    drag,
    begin,
    move,
    up,
    cancel,
    lostCapture,
    clickCapture: (event: MouseEvent) => {
      if (!suppressClick.current) return;
      suppressClick.current = false;
      event.preventDefault();
      event.stopPropagation();
    },
    contextMenu: (event: MouseEvent) => {
      if (pending.current?.active === true) event.preventDefault();
    },
  };
}
