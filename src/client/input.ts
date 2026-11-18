// ソフトキーボードには Shift が無い。Enter を送信に固定すると、タッチ端末では改行できない。
// 送信はボタンに任せ、Enter は 1 行足すだけにする。
export function enterInsertsNewline(match: (query: string) => boolean): boolean {
  return match("(pointer: coarse)");
}

export type Insertion = {
  text: string;
  caret: number;
};

// 選択範囲を置き換え、前後の語とくっつかないよう必要なら空白を足す。キャレットは
// 入れた文字列の直後（後ろに足した空白の手前）に置く。範囲の検証は呼び出し側で行う。
export function insertAtSelection(
  draft: string,
  start: number,
  end: number,
  inserted: string,
): Insertion {
  const before = draft.slice(0, start);
  const after = draft.slice(end);
  const lead = before !== "" && !/\s$/.test(before) ? " " : "";
  const trail = after !== "" && !/^\s/.test(after) ? " " : "";
  return {
    text: `${before}${lead}${inserted}${trail}${after}`,
    caret: before.length + lead.length + inserted.length,
  };
}
