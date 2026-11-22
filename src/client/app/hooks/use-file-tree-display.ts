import { useState } from "preact/hooks";
import {
  loadFileTreeSize,
  loadFileTreeWidth,
  saveFileTreeSize,
  saveFileTreeWidth,
  type FileTreeSize,
  type FileTreeWidth,
} from "../../file-tree-display";
import { storage } from "../../storage";

export type UseFileTreeDisplay = {
  size: FileTreeSize;
  width: FileTreeWidth;
  changeSize: (next: FileTreeSize) => void;
  changeWidth: (next: FileTreeWidth) => void;
};

// ツリーの文字の大きさと幅は端末ごとの好み。保持するのは段階の id だけで、px や rem は描画で引く。
export function useFileTreeDisplay(): UseFileTreeDisplay {
  const [size, setSize] = useState<FileTreeSize>(() => loadFileTreeSize(storage()));
  const [width, setWidth] = useState<FileTreeWidth>(() => loadFileTreeWidth(storage()));

  const changeSize = (next: FileTreeSize) => {
    setSize(next);
    saveFileTreeSize(storage(), next);
  };

  const changeWidth = (next: FileTreeWidth) => {
    setWidth(next);
    saveFileTreeWidth(storage(), next);
  };

  return { size, width, changeSize, changeWidth };
}
