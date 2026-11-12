import { useEffect } from "preact/hooks";
import type { AppState } from "../../../server/herdr/state";
import { applyFavicon, faviconStatus } from "../../favicon";

// タブのアイコンは、開いているペインではなく全スペースの親を見る。別タブにいても終わった
// 親や質問に気付けるようにする。タイトルは変えない。
export function useFavicon(state: AppState | null): void {
  const favicon = state === null ? null : faviconStatus(state);
  useEffect(() => applyFavicon(favicon), [favicon]);
}
