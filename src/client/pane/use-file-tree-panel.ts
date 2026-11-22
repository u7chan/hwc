import type { RefObject } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import type { FileTreeView } from "../file-tree-store";
import { fileTreeStore } from "../file-tree-store";
import { isFileTreeShortcut, isInOverlay, isTextEntry } from "../file-tree-key";
import { TREE_SIDE_MIN_WIDTH } from "../layout";
import type { TreeFocusRequest } from "./file-tree";
import { useFileTree } from "./use-file-tree";

// ツリーを閉じるアニメーションの長さ。CSS の transition と揃える。
const TREE_CLOSE_MS = 120;
// CSS の transition は次のフレームから始まる。閉じ終える前に unmount しないよう、
// 1 フレーム分だけ待つ。
const TREE_CLOSE_SETTLE_MS = 20;

const prefersReducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

type FileTreePanelOptions = {
  paneId: string;
  // 文書全体のキーを受けるセルか。listener を持つのは対象のセル 1 つだけにする。
  current: boolean;
  // セルの実際の幅。広ければ会話と並べ、狭ければ重ねる。
  frameWidth: number | null;
};

type FileTreePanel = {
  // 一覧そのもの。store の正を購読した結果を渡す。
  view: FileTreeView;
  // 閉じたあとに焦点を戻す入口。ツリーの開閉は見出しのボタンから入る。
  buttonRef: RefObject<HTMLButtonElement | null>;
  open: boolean;
  // 並べるセルでは会話の左右に置き、狭いセルでは会話の上に重ねる。
  sideBySide: boolean;
  overlay: boolean;
  // 開閉のアニメーションの状態。データ属性と inert の出し分けに使う。
  shown: boolean;
  closing: boolean;
  // キーで開いたか。ツリーの行へ焦点を移すかの判断に使う。
  focusRequest: TreeFocusRequest;
  close: () => void;
  // focus はキーで開いたときだけ true。ポインタで開いたときに焦点を飛ばさない。
  toggle: (focus: boolean) => void;
};

// ファイルツリーの開閉。開閉の動きは store ではなくここが持ち、store の close は
// アニメーションの後にだけ呼ぶ。表示側は返り値のとおりに描く。
export function useFileTreePanel(options: FileTreePanelOptions): FileTreePanel {
  const { paneId, current, frameWidth } = options;
  // ツリーの状態は store に持つ。プレビューでこのセルが外れても開閉を保つ。
  const fileTree = useFileTree(paneId);
  const buttonRef = useRef<HTMLButtonElement>(null);

  const open = fileTree.open;
  const sideBySide = open && frameWidth !== null && frameWidth >= TREE_SIDE_MIN_WIDTH;
  const overlay = open && !sideBySide;

  // 開閉の動きは開いた瞬間だけ。ペインを切り替えて戻ったときは store が開いたままでも
  // 再生しないよう、初期値を store の開閉に合わせる。
  const [shown, setShown] = useState(fileTree.open);
  const [closing, setClosing] = useState(false);
  // キーで開いたときだけ、ツリーの行へ焦点を移す。token は開くたびに増え、
  // focus はその開閉がキー由来かを示す。
  const [focusRequest, setFocusRequest] = useState<TreeFocusRequest>({ token: 0, focus: false });
  const closeTimer = useRef<number | null>(null);

  const cancelClose = () => {
    if (closeTimer.current === null) return;
    window.clearTimeout(closeTimer.current);
    closeTimer.current = null;
  };

  // 面を 1 フレーム隠した状態で描いてから表示へ移し、CSS の transition を走らせる。
  useEffect(() => {
    if (!open || shown || closing) return;
    const frame = requestAnimationFrame(() => setShown(true));
    return () => cancelAnimationFrame(frame);
  }, [open, shown, closing]);

  const openTree = (focus: boolean) => {
    cancelClose();
    setClosing(false);
    // token は開くたびに増やし、focus とは別に持つ。番号を戻すと、閉じる途中の
    // 開き直しで前の番号が再利用され、ツリーが処理済みと誤認して焦点を移さない。
    setFocusRequest((request) => ({ token: request.token + 1, focus }));
    // 動きを減らす設定では待たずに出す。CSS も transition を持たない。
    if (prefersReducedMotion()) setShown(true);
    fileTreeStore.open(paneId);
  };

  // store の close はアニメーションの後。閉じている間は一覧を残したまま inert にし、
  // 消えていく行を押せないようにする。
  const closeTree = () => {
    if (!open) return;
    // 閉じると行のボタンも消え、メニューは位置合わせも焦点の復帰もできない。
    fileTreeStore.clearRowMenu(paneId);
    cancelClose();
    if (prefersReducedMotion()) {
      fileTreeStore.close(paneId);
      setClosing(false);
      setShown(false);
      return;
    }
    setClosing(true);
    setShown(false);
    closeTimer.current = window.setTimeout(() => {
      closeTimer.current = null;
      fileTreeStore.close(paneId);
      setClosing(false);
      setShown(false);
    }, TREE_CLOSE_MS + TREE_CLOSE_SETTLE_MS);
  };

  // 閉じる途中でセルが外れたら、保留した close を済ませて開いたままにしない。行メニューも
  // 同じ理由で捨てる（store に残すと、戻ったときに切断済みのボタンで描こうとする）。
  useEffect(
    () => () => {
      fileTreeStore.clearRowMenu(paneId);
      if (closeTimer.current === null) return;
      window.clearTimeout(closeTimer.current);
      closeTimer.current = null;
      fileTreeStore.close(paneId);
    },
    [paneId],
  );

  // 見出しのボタンとキーは同じ経路を通す。store を直接叩くと開閉の動きとずれる。
  const toggleTree = (focus: boolean) => {
    if (open && !closing) {
      // ツリーの中に焦点があるまま閉じると body に落ちる。行き場を見出しの入口へ返す。
      const active = document.activeElement;
      if (focus && active instanceof Element && active.closest(".hwc-tree-view") !== null) {
        buttonRef.current?.focus();
      }
      closeTree();
      return;
    }
    openTree(focus);
  };

  // キーは文書全体で拾う。listener を持つのは対象のセル 1 つだけにする。
  const toggleTreeRef = useRef(toggleTree);
  toggleTreeRef.current = toggleTree;
  useEffect(() => {
    if (!current) return;
    const onKey = (event: KeyboardEvent) => {
      if (!isFileTreeShortcut(event)) return;
      const focused = document.activeElement instanceof Element ? document.activeElement : null;
      // 入力欄の中では文字を、開いている面の中ではその面のキーを優先する。
      if (isTextEntry(focused) || isInOverlay(focused)) return;
      // 焦点が body にあるときは、最後にクリックしたセル（= current）を開閉する。
      // 他のセルや一覧に焦点があるときは、その画面の操作を横取りしない。
      if (focused !== null && focused !== document.body) {
        const cell = focused.closest("[data-drop-pane]");
        // 分割セルは印で見分ける。1 枚表示はセルの印が無く、詳細の中に PaneDetail が
        // 1 つしか出ないので、詳細の中かどうかだけを見る。
        const inside =
          cell !== null
            ? cell.getAttribute("data-drop-pane") === paneId
            : focused.closest(".hwc-detail-body") !== null;
        if (!inside) return;
      }
      event.preventDefault();
      toggleTreeRef.current(true);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [current, paneId]);

  return {
    view: fileTree,
    buttonRef,
    open,
    sideBySide,
    overlay,
    shown,
    closing,
    focusRequest,
    close: closeTree,
    toggle: toggleTree,
  };
}
