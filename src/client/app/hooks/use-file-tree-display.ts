import { useState } from "preact/hooks";
import {
  loadFileTreeIcons,
  loadFileTreeSize,
  loadFileTreeWidth,
  saveFileTreeIcons,
  saveFileTreeSize,
  saveFileTreeWidth,
  type FileTreeIcons,
  type FileTreeSize,
  type FileTreeWidth,
} from "../../file-tree-display";
import { storage } from "../../storage";

export type UseFileTreeDisplay = {
  size: FileTreeSize;
  width: FileTreeWidth;
  icons: FileTreeIcons;
  changeSize: (next: FileTreeSize) => void;
  changeWidth: (next: FileTreeWidth) => void;
  changeIcons: (next: FileTreeIcons) => void;
};

// ツリーの文字の大きさ・幅・印は端末ごとの好み。保持するのは段階の id だけで、px や rem は描画で引く。
export function useFileTreeDisplay(): UseFileTreeDisplay {
  const [size, setSize] = useState<FileTreeSize>(() => loadFileTreeSize(storage()));
  const [width, setWidth] = useState<FileTreeWidth>(() => loadFileTreeWidth(storage()));
  const [icons, setIcons] = useState<FileTreeIcons>(() => loadFileTreeIcons(storage()));

  const changeSize = (next: FileTreeSize) => {
    setSize(next);
    saveFileTreeSize(storage(), next);
  };

  const changeWidth = (next: FileTreeWidth) => {
    setWidth(next);
    saveFileTreeWidth(storage(), next);
  };

  const changeIcons = (next: FileTreeIcons) => {
    setIcons(next);
    saveFileTreeIcons(storage(), next);
  };

  return { size, width, icons, changeSize, changeWidth, changeIcons };
}
