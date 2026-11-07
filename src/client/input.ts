// ソフトキーボードには Shift が無い。Enter を送信に固定すると、タッチ端末では改行できない。
// 送信はボタンに任せ、Enter は 1 行足すだけにする。
export function enterInsertsNewline(match: (query: string) => boolean): boolean {
  return match("(pointer: coarse)");
}
