import { useState } from "preact/hooks";
import { loadCodeFontSize, saveCodeFontSize, type CodeFontSize } from "../../code-font-size";
import { storage } from "../../storage";

// 保持するのは段階の id だけで、rem は描画で引く。
export function useCodeFontSize(): { size: CodeFontSize; change: (next: CodeFontSize) => void } {
  const [size, setSize] = useState<CodeFontSize>(() => loadCodeFontSize(storage()));

  const change = (next: CodeFontSize) => {
    setSize(next);
    saveCodeFontSize(storage(), next);
  };

  return { size, change };
}
