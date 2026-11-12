// 8px は指で止めたときの誤差。ちょうど底ぴったりでないと追従しないと、少し触っただけで止まる。
export const BOTTOM_THRESHOLD = 8;

export type ScrollBox = { scrollTop: number; clientHeight: number; scrollHeight: number };

export function isNearBottom(box: ScrollBox, threshold = BOTTOM_THRESHOLD): boolean {
  return box.scrollHeight - box.scrollTop - box.clientHeight <= threshold;
}

// 内容高か表示領域の高さが変わったスクロールは、入力欄や添付の伸縮で底が詰まっただけ。
// 利用者が読み返すために動かしたのかを区別しないと、画像を貼った瞬間に追従が止まる。
export function isLayoutShift(box: ScrollBox, last: ScrollBox): boolean {
  return box.scrollHeight !== last.scrollHeight || box.clientHeight !== last.clientHeight;
}

// 縦に伸びたときのスクロールが、高さの変化ではなく利用者の読み返しによるものか。
// 伸びる前の底から離れていれば、利用者が動かしたとみなす。表示領域が変わった伸びは
// 入力欄や添付の伸縮で、利用者の操作とは限らないため対象外にする。
export function isUserScrollDuringGrowth(box: ScrollBox, last: ScrollBox): boolean {
  return (
    box.scrollHeight > last.scrollHeight &&
    box.clientHeight === last.clientHeight &&
    !isNearBottom(last)
  );
}
