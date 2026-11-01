import { useEffect, useRef, useState } from "preact/hooks";

// コピーの知らせは 1 か所で扱う。押した操作の結果なので、その場で時間を計る。
export function useCopy(duration = 1500) {
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => () => clearTimeout(timer.current), []);

  const copy = (id: string, text: string) => {
    void navigator.clipboard
      ?.writeText(text)
      .then(() => {
        setCopiedId(id);
        clearTimeout(timer.current);
        timer.current = window.setTimeout(() => setCopiedId(null), duration);
      })
      .catch(() => setCopiedId(null));
  };

  return { copiedId, copy };
}
