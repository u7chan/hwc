import { useEffect, useRef, useState } from "preact/hooks";

// http では navigator.clipboard が無い（安全なコンテキストのみ）。LAN の IP で
// 開くと使えないので、選択と execCommand で代用する。
function legacyCopy(text: string): boolean {
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.top = "0";
  area.style.left = "0";
  area.style.opacity = "0";
  area.style.pointerEvents = "none";
  document.body.appendChild(area);

  const selection = document.getSelection();
  const previous = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null;

  area.select();
  area.setSelectionRange(0, text.length);
  let copied = false;
  try {
    copied = document.execCommand("copy");
  } catch {
    copied = false;
  }

  area.remove();
  if (previous && selection) {
    selection.removeAllRanges();
    selection.addRange(previous);
  }
  return copied;
}

export function copyText(text: string): Promise<boolean> {
  const clipboard = navigator.clipboard;
  if (window.isSecureContext && clipboard) {
    return clipboard.writeText(text).then(
      () => true,
      () => legacyCopy(text),
    );
  }
  return Promise.resolve(legacyCopy(text));
}

// コピーの知らせは 1 か所で扱う。押した操作の結果なので、その場で時間を計る。
export function useCopy(duration = 1500) {
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => () => clearTimeout(timer.current), []);

  const copy = (id: string, text: string) => {
    void copyText(text).then((copied) => {
      if (!copied) {
        setCopiedId(null);
        return;
      }
      setCopiedId(id);
      clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setCopiedId(null), duration);
    });
  };

  return { copiedId, copy };
}
