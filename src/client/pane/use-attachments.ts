import { useEffect, useState } from "preact/hooks";
import { type AttachedFile, attachmentStore } from "../attachment-store";

// ペインごとの添付を購読する。ペインが変わったら、その時点の一覧へ差し替える。
export function useAttachments(paneId: string): readonly AttachedFile[] {
  const [items, setItems] = useState(() => attachmentStore.items(paneId));
  useEffect(() => {
    const update = () => setItems(attachmentStore.items(paneId));
    // 購読の前に完了した分を取りこぼさないよう、購読してから読み直す。
    const unsubscribe = attachmentStore.subscribe(paneId, update);
    update();
    return unsubscribe;
  }, [paneId]);
  return items;
}
