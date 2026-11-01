import type { ComponentChildren } from "preact";
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";

type TooltipProps = {
  label: string;
  children: ComponentChildren;
};

type Placement = {
  // 目印の左右の端。画面の半分より内側の端に合わせて広げる。
  start: number;
  end: number;
  top: number;
  above: boolean;
};

// 押せない要素の補足を、スクロールの見切れに影響されずに出す。
export function Tooltip(props: TooltipProps) {
  const anchor = useRef<HTMLSpanElement>(null);
  const tip = useRef<HTMLSpanElement>(null);
  const [placement, setPlacement] = useState<Placement | null>(null);
  const [open, setOpen] = useState(false);

  // 幅は描画しないと分からないので、はみ出さない位置をここで決める。
  useLayoutEffect(() => {
    const element = tip.current;
    if (element === null || placement === null) return;
    const width = element.offsetWidth;
    const center = (placement.start + placement.end) / 2;
    // 目印が画面の左半分なら左端を、右半分なら右端をそろえて広げる。
    const preferred = center < window.innerWidth / 2 ? placement.start : placement.end - width;
    element.style.left = `${Math.min(Math.max(preferred, 8), window.innerWidth - width - 8)}px`;
  }, [placement]);

  // スクロールすると目印から離れるので、開いたままにしない。
  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    window.addEventListener("scroll", close, true);
    return () => window.removeEventListener("scroll", close, true);
  }, [open]);

  // 指で出したときは、外を触っても閉じる。
  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => {
      if (anchor.current?.contains(event.target as Node)) return;
      setOpen(false);
    };
    document.addEventListener("pointerdown", close, true);
    return () => document.removeEventListener("pointerdown", close, true);
  }, [open]);

  const show = (current: HTMLElement) => {
    const rect = current.getBoundingClientRect();
    // 上に余白がなければ下へ出す。
    const above = rect.top > 56;
    setPlacement({ start: rect.left, end: rect.right, top: above ? rect.top : rect.bottom, above });
    setOpen(true);
  };

  return (
    <span
      ref={anchor}
      class="hwc-tip-anchor"
      onPointerEnter={(event) => {
        // 指では hover が続かないので、触れたときは pointerdown で出す。
        if (event.pointerType === "touch") return;
        show(event.currentTarget);
      }}
      onPointerLeave={(event) => {
        if (event.pointerType === "touch") return;
        setOpen(false);
      }}
      onPointerDown={(event) => {
        if (event.pointerType === "mouse") return;
        if (open) {
          setOpen(false);
          return;
        }
        show(event.currentTarget);
      }}
    >
      {props.children}
      {placement === null ? null : (
        <span
          ref={tip}
          class="hwc-tip"
          role="tooltip"
          data-side={placement.above ? "above" : "below"}
          data-open={open}
          style={{ top: `${placement.top}px` }}
        >
          {props.label}
        </span>
      )}
    </span>
  );
}
