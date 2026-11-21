import { useState } from "preact/hooks";
import { loadFileTreeSide, saveFileTreeSide, type FileTreeSide } from "../../file-tree-side";

export type UseFileTreeSide = {
  side: FileTreeSide;
  change: (next: FileTreeSide) => void;
};

// ツリーを並べる側は端末ごとの好み。テーマと同じく、読み書きは localStorage に閉じる（docs/adr/state-storage.md）。
export function useFileTreeSide(): UseFileTreeSide {
  const [side, setSide] = useState<FileTreeSide>(() =>
    loadFileTreeSide(typeof localStorage === "undefined" ? null : localStorage),
  );

  const change = (next: FileTreeSide) => {
    setSide(next);
    if (typeof localStorage !== "undefined") saveFileTreeSide(localStorage, next);
  };

  return { side, change };
}
