import type { PaneState } from "../server/herdr/state";

// ソフトキーボードには Shift が無い。Enter を送信に固定すると、タッチ端末では改行できない。
// 送信はボタンに任せ、Enter は 1 行足すだけにする。
export function enterInsertsNewline(match: (query: string) => boolean): boolean {
  return match("(pointer: coarse)");
}

// `@` の候補は ↑↓ / Tab / Enter で選ぶ前提で、主ポインタが粗い端末には出さない。
// 指でタップすると本文がフォーカスを失い、ソフトキーボードが閉じてしまう。
export function projectMentionAllowed(match: (query: string) => boolean): boolean {
  return !match("(pointer: coarse)");
}

// 入力欄を閉じるか。Claude は質問・承認の待ちで、pi は質問の待ちで blocked になり、
// その間の TUI はダイアログが入力を受け取る。hwc の本文がダイアログへ流れないよう、
// 入力欄ごと閉じる。readOnly（folder trust）と違い、本文は端末出力のままにする
// （Issue #335、docs/adr/pi-integration.md）。
export function composerDisabled(pane: PaneState, readOnly: boolean): boolean {
  return (
    readOnly || ((pane.agent === "claude" || pane.agent === "pi") && pane.agentStatus === "blocked")
  );
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
