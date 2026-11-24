// 入力欄の高さを測り直す条件。測り直すたびに入力欄へ入れた高さを捨て、走っている開閉の
// アニメーションも止めるので、何も変わっていない描画では測らない。
export type HeightInput = {
  // 入力欄の本文。入力欄が描かれていない間は、最後に読めた本文を引き継ぐ。
  text: string | null;
  // 簡略表示か。折り返したときに読み幅いっぱいへ広げるかが変わる。
  compact: boolean;
  // 広げているか。広げている間は CSS の高さに任せる。
  expanded: boolean;
  // 入力欄を閉じているか。開き直した描画で測り直す。
  disabled: boolean;
};

export type HeightFlags = Omit<HeightInput, "text">;

// 描画の後の入力欄から、測り直すかを決める値を組み立てる。入力欄が描かれていない
// 間は本文を読めない。最後に読めた本文を引き継がないと、閉じている間に条件が動いた
// ことを開き直した描画で見分けられない。
export function heightInputAt(
  text: string | null,
  previous: HeightInput | null,
  flags: HeightFlags,
): HeightInput {
  return { text: text ?? previous?.text ?? null, ...flags };
}

// 最初の描画と、本文・簡略の切り替え・開閉・入力可否が変わった描画で測る。
export function needsFit(previous: HeightInput | null, current: HeightInput): boolean {
  return (
    previous === null ||
    previous.text !== current.text ||
    previous.compact !== current.compact ||
    previous.expanded !== current.expanded ||
    previous.disabled !== current.disabled
  );
}
