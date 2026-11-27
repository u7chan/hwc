import { useState } from "preact/hooks";
import {
  clampFileTreeWidth,
  loadFileTreeIcons,
  loadFileTreeSize,
  loadFileTreeWidth,
  saveFileTreeIcons,
  saveFileTreeSize,
  saveFileTreeWidth,
  type FileTreeIcons,
  type FileTreeSize,
} from "../../file-tree-display";
import { storage } from "../../storage";

export type UseFileTreeDisplay = {
  size: FileTreeSize;
  // 並べたツリーの幅（px）。ドラッグ中の値もここに入る。
  width: number;
  icons: FileTreeIcons;
  changeSize: (next: FileTreeSize) => void;
  // ドラッグ中に描き直すだけ。保存はしない。
  changeWidth: (next: number) => void;
  // 離したときとキー操作のときに、描き直しと保存を一度に行う。
  saveWidth: (next: number) => void;
  changeIcons: (next: FileTreeIcons) => void;
};

// ツリーの文字の大きさ・幅・印は端末ごとの好み。大きさと印は段階の id、幅は px だけを保持し、
// CSS の値は描画で引く。
export function useFileTreeDisplay(): UseFileTreeDisplay {
  const [size, setSize] = useState<FileTreeSize>(() => loadFileTreeSize(storage()));
  const [width, setWidth] = useState<number>(() => loadFileTreeWidth(storage()));
  const [icons, setIcons] = useState<FileTreeIcons>(() => loadFileTreeIcons(storage()));

  const changeSize = (next: FileTreeSize) => {
    setSize(next);
    saveFileTreeSize(storage(), next);
  };

  const changeWidth = (next: number) => {
    setWidth(clampFileTreeWidth(next));
  };

  const saveWidth = (next: number) => {
    const clamped = clampFileTreeWidth(next);
    setWidth(clamped);
    saveFileTreeWidth(storage(), clamped);
  };

  const changeIcons = (next: FileTreeIcons) => {
    setIcons(next);
    saveFileTreeIcons(storage(), next);
  };

  return { size, width, icons, changeSize, changeWidth, saveWidth, changeIcons };
}
