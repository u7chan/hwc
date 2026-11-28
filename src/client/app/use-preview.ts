import { useEffect, useState } from "preact/hooks";
import type { ChatFile } from "../../server/chat/contract";
import type { AppState } from "../../server/herdr/state";
import { findPane } from "../select";
import type { PreviewTarget } from "./types";

export type UsePreview = {
  preview: PreviewTarget | null;
  open: (paneId: string, file: ChatFile) => void;
  close: () => void;
};

type PreviewOptions = {
  // ペインが消えたらプレビューも捨てる。スナップショットの正は BFF のまま。
  state: AppState | null;
};

// プレビューの中身だけを持つ。どの葉のタブに出すかは分割ビューの PREVIEW_TAB が持つ。
export function usePreview(options: PreviewOptions): UsePreview {
  const { state } = options;
  const [preview, setPreview] = useState<PreviewTarget | null>(null);

  // 閉じたペインのプレビューは残さない。配信の根が消えて、iframe は 404 になるだけ。
  useEffect(() => {
    if (preview === null || state === null) return;
    if (findPane(state, preview.paneId) === null) setPreview(null);
  }, [state, preview]);

  const open = (paneId: string, file: ChatFile) => setPreview({ paneId, file });

  // タブとヘッダーの × は同じ入口。画面から外すだけで、メッセージのチップは残る。
  const close = () => setPreview(null);

  return { preview, open, close };
}
