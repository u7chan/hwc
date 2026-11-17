import { useEffect, useState } from "preact/hooks";
import { fileTreeStore, type FileTreeView } from "../file-tree-store";

// ペインごとのツリーを購読する。ペインを切り替えると PaneDetail は作り直されるので、
// 開き直したときに取得できていないディレクトリを ensure で取り直す。
export function useFileTree(paneId: string): FileTreeView {
  const [view, setView] = useState(() => fileTreeStore.view(paneId));

  useEffect(() => {
    const update = () => setView(fileTreeStore.view(paneId));
    // 購読の前に完了した分を取りこぼさないよう、購読してから読み直す。
    const unsubscribe = fileTreeStore.subscribe(paneId, update);
    update();
    fileTreeStore.ensure(paneId);
    return unsubscribe;
  }, [paneId]);

  return view;
}

// ツリーとは別に、選択中のファイルを購読する。同じ通知を使うが、一覧の取得状態が
// 変わってもプレビューのパスは変わらない。
export function useFilePreview(paneId: string): string | null {
  const [path, setPath] = useState(() => fileTreeStore.preview(paneId));

  useEffect(() => {
    const update = () => setPath(fileTreeStore.preview(paneId));
    const unsubscribe = fileTreeStore.subscribe(paneId, update);
    update();
    return unsubscribe;
  }, [paneId]);

  return path;
}
