import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { CopyGlyph } from "./icons";
import { useCopy } from "./copy";
import type { SelectionAnchor } from "./selection-toolbar";

export type SelectionToolbarState = { anchor: SelectionAnchor; open: boolean };

const EXIT_MS = 150;
const EDGE_MARGIN = 8;

// 選択した本文のそばに出すメニュー。開閉は CSS の短い遷移に合わせ、閉じたあとも
// EXIT_MS の間は残してアニメーションを見せる。位置は枠の幅を測ってから左右へ寄せる。
export function SelectionToolbar(props: {
  state: SelectionToolbarState | null;
  canQuote: boolean;
  onQuote: () => void;
  onCopy: () => string;
  onExited: () => void;
}) {
  const anchor = props.state?.anchor ?? null;
  const open = props.state?.open ?? false;
  const toolbar = useRef<HTMLDivElement>(null);
  const [entered, setEntered] = useState(false);
  const [left, setLeft] = useState<number | null>(null);
  const { copiedId, copy } = useCopy();
  const copied = copiedId === "selection";
  const onExited = useRef(props.onExited);
  onExited.current = props.onExited;

  useEffect(() => {
    if (!open) {
      setEntered(false);
      return;
    }
    const frame = requestAnimationFrame(() => setEntered(true));
    return () => cancelAnimationFrame(frame);
  }, [open]);

  useEffect(() => {
    if (open || props.state === null) return;
    const timer = window.setTimeout(() => onExited.current(), EXIT_MS);
    return () => window.clearTimeout(timer);
  }, [open, props.state === null]);

  useLayoutEffect(() => {
    const element = toolbar.current;
    if (element === null || anchor === null) return;
    const width = element.offsetWidth;
    const half = width / 2;
    const clamped =
      anchor.frameWidth <= width + EDGE_MARGIN * 2
        ? anchor.frameWidth / 2
        : Math.min(
            Math.max(anchor.center, half + EDGE_MARGIN),
            anchor.frameWidth - half - EDGE_MARGIN,
          );
    setLeft(clamped);
  }, [anchor?.center, anchor?.frameWidth, anchor?.text, entered]);

  if (props.state === null || anchor === null) return null;

  const copySelection = () => {
    const text = props.onCopy();
    if (text !== "") copy("selection", text);
  };

  return (
    <div
      ref={toolbar}
      class="hwc-selection-toolbar"
      data-open={open && entered}
      data-selection-toolbar="true"
      role="group"
      aria-label="選択した箇所の操作"
      style={{ left: `${left ?? anchor.center}px`, top: `${anchor.top}px` }}
    >
      {props.canQuote ? (
        <button
          type="button"
          class="hwc-selection-button"
          aria-label="選択した箇所に返信"
          onPointerDown={(event) => event.preventDefault()}
          onMouseDown={(event) => event.preventDefault()}
          onClick={props.onQuote}
        >
          返信
        </button>
      ) : null}
      <button
        type="button"
        class="hwc-selection-button"
        aria-label={copied ? "コピーしました" : "選択した箇所をコピー"}
        onPointerDown={(event) => event.preventDefault()}
        onMouseDown={(event) => event.preventDefault()}
        // フォーカスを入力欄に残したまま HTTP の execCommand 経路へ落ちると、
        // 一時 textarea の後始末で選択が消える。押したボタンへ先に移しておく。
        onClick={(event) => {
          event.currentTarget.focus();
          copySelection();
        }}
      >
        <CopyGlyph copied={copied} size={14} />
        <span>コピー</span>
      </button>
    </div>
  );
}
