import { useEffect, useState } from "preact/hooks";
import type { Template } from "../../shared/templates";
import { fetchTemplates } from "../requests/settings";

// 入力欄の + メニューが「定型文を引用」を出せるかを決めるためだけに読む。
// 読めなければ null のままにし、押せる側へ倒す（ダイアログが読み直して失敗を出す）。
export function useTemplates(enabled: boolean): Template[] | null {
  const [templates, setTemplates] = useState<Template[] | null>(null);

  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    void fetchTemplates(controller.signal).then((list) => {
      if (!controller.signal.aborted) setTemplates(list);
    });
    return () => controller.abort();
  }, [enabled]);

  return templates;
}
