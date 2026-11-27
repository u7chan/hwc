import { useRef } from "preact/hooks";
import {
  FILE_TREE_WIDTH_MAX,
  FILE_TREE_WIDTH_MIN,
  FILE_TREE_WIDTH_STEP,
  clampFileTreeWidth,
  fileTreeWidthByDrag,
} from "../file-tree-display";
import type { FileTreeSide } from "../file-tree-side";

type FileTreeResizerProps = {
  side: FileTreeSide;
  width: number;
  // このセルの幅。ドラッグで会話を 420px より狭めると重ね表示へ切り替わり、掴んだ境目が消える。
  cellWidth: number;
  // ドラッグ中。描き直すだけで保存しない。
  onChange: (width: number) => void;
  // 離したとき、キーで動かしたとき。
  onCommit: (width: number) => void;
};

// 並べたツリーと会話の境目。幅は端末ごとの 1 つで、どのセルで動かしても全セルのツリーが揃う。
export function FileTreeResizer(props: FileTreeResizerProps) {
  const { side, width, cellWidth, onChange, onCommit } = props;
  const drag = useRef<{ startX: number; startWidth: number } | null>(null);

  const widthAt = (clientX: number) => {
    const start = drag.current;
    if (!start) return width;
    return clampFileTreeWidth(
      fileTreeWidthByDrag(start.startWidth, clientX - start.startX, side),
      cellWidth,
    );
  };

  const end = (event: PointerEvent & { currentTarget: HTMLElement }) => {
    if (!drag.current) return;
    const next = widthAt(event.clientX);
    drag.current = null;
    event.currentTarget.releasePointerCapture(event.pointerId);
    onCommit(next);
  };

  return (
    <div
      class="hwc-tree-resizer"
      role="separator"
      aria-orientation="vertical"
      aria-label="ファイルツリーの幅"
      aria-valuenow={width}
      aria-valuemin={FILE_TREE_WIDTH_MIN}
      aria-valuemax={clampFileTreeWidth(FILE_TREE_WIDTH_MAX, cellWidth)}
      tabIndex={0}
      onPointerDown={(event) => {
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = { startX: event.clientX, startWidth: width };
      }}
      onPointerMove={(event) => {
        if (drag.current) onChange(widthAt(event.clientX));
      }}
      onPointerUp={end}
      onPointerCancel={end}
      onKeyDown={(event) => {
        if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
        event.preventDefault();
        const dx = event.key === "ArrowRight" ? FILE_TREE_WIDTH_STEP : -FILE_TREE_WIDTH_STEP;
        onCommit(clampFileTreeWidth(fileTreeWidthByDrag(width, dx, side), cellWidth));
      }}
    />
  );
}
