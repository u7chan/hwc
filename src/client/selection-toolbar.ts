import { normaliseQuote } from "./reply";

// 選択ツールバーの位置は .hwc-output-wrap を基準にした px。center は範囲の横の
// 真ん中で、高さは CSS の最小高に合わせる。ツールバー自身の幅は描画後に測って寄せる。
export type SelectionAnchor = {
  text: string;
  center: number;
  top: number;
  frameWidth: number;
};

const TOOLBAR_GAP = 6;
// CSS の最小高 28px + 上下の padding 2px + 枠 1px。
const TOOLBAR_HEIGHT = 34;

// 選択の始まりと終わりが両方スクロール領域の中にあるときだけ、本文と位置を返す。
// 入力欄・ヘッダ・メタ行・領域の外へまたがる選択は対象外。
export function readSelectionAnchor(
  scroller: HTMLElement,
  frame: HTMLElement,
): SelectionAnchor | null {
  const selection = document.getSelection();
  if (selection === null || selection.isCollapsed || selection.rangeCount === 0) return null;
  const range = selection.getRangeAt(0);
  if (!scroller.contains(range.startContainer) || !scroller.contains(range.endContainer)) {
    return null;
  }
  const text = normaliseQuote(selection.toString());
  if (text === "") return null;

  const rect = range.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return null;

  const view = scroller.getBoundingClientRect();
  if (view.height === 0 || rect.bottom <= view.top || rect.top >= view.bottom) return null;

  const box = frame.getBoundingClientRect();
  const above = rect.top - box.top - TOOLBAR_GAP - TOOLBAR_HEIGHT;
  return {
    text,
    center: rect.left + rect.width / 2 - box.left,
    // 範囲の頭が領域の上に隠れているときは、領域の上端へ寄せて本文に重ねる。
    top: above >= 0 ? above : 0,
    frameWidth: box.width,
  };
}
