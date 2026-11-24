import { useEffect, useState } from "preact/hooks";
import type { ChatFile } from "../../server/chat/contract";
import type { AppState } from "../../server/herdr/state";
import { findPane } from "../select";
import type { PreviewTarget } from "./types";

export type UsePreview = {
  preview: PreviewTarget | null;
  // 対象のペインがどこかの葉のタブにあるか。プレビューは tabs に入れないので、
  // タブに出すかはこれで決める。
  previewInTab: boolean;
  // タブから選ばれていて、本文にも出ているか。
  previewing: boolean;
  open: (paneId: string, file: ChatFile) => void;
  show: () => void;
  hide: () => void;
  close: () => void;
};

type PreviewOptions = {
  // ペインが消えたらプレビューも捨てる。スナップショットの正は BFF のまま。
  state: AppState | null;
  openTabs: readonly string[];
};

// プレビューは一時タブのまま。どの葉の tabs にも入れず、対象のペインがどこかの葉に
// ある間だけ、その葉のタブ列の末尾に出せる。ペインのタブを選んだら閉じずに隠す。
// 閉じるのはプレビュー自身の操作。
export function usePreview(options: PreviewOptions): UsePreview {
  const { state, openTabs } = options;
  const [preview, setPreview] = useState<PreviewTarget | null>(null);

  const previewInTab = preview !== null && openTabs.includes(preview.paneId);
  const previewing = preview?.shown === true && previewInTab;

  // 閉じたペインのプレビューは残さない。配信の根が消えて、iframe は 404 になるだけ。
  useEffect(() => {
    if (preview === null || state === null) return;
    if (findPane(state, preview.paneId) === null) setPreview(null);
  }, [state, preview]);

  const open = (paneId: string, file: ChatFile) => setPreview({ paneId, file, shown: true });

  const show = () =>
    setPreview((current) => (current === null ? null : { ...current, shown: true }));

  const hide = () =>
    setPreview((current) =>
      current === null || !current.shown ? current : { ...current, shown: false },
    );

  // プレビューのタブとヘッダーの × は同じ入口。どちらも画面から外すだけで、
  // チップはメッセージに残る。
  const close = () => setPreview(null);

  return { preview, previewInTab, previewing, open, show, hide, close };
}
