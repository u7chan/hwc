export type ChatRole = "user" | "agent";

export type ChatMessage = {
  id: string;
  role: ChatRole;
  text: string;
  at: number;
};

export function appendMessage(list: readonly ChatMessage[], message: ChatMessage): ChatMessage[] {
  return [...list, message];
}

// プレビュー用の返答。本物のエージェントに繋ぐまでの置き。
export function mockReply(text: string, turn: number): string {
  const opening = text.trim().split("\n")[0]?.slice(0, 40) ?? "";
  const replies = [
    `${opening} について確認しました。まずは現状の出力を読み、変更する範囲を決めます。\n\n1. 一覧の並びはそのままで、返答だけを差し替える\n2. 送信のたびに 1 往復ぶん遅らせて、動きを見せる\n\nこの順で進めます。`,
    `了解しました。対象は ${turn} か所です。\n\n- 入力欄の送信経路\n- 出力のスクロール位置\n\n先に後者から直します。読み返している最中に勝手に動かないようにします。`,
    `ここまでの変更をまとめます。\n\n差分は 2 ファイル、テストはそのまま通っています。次はスマホの実機で、返答の折り返しと余白を見たいです。`,
  ];
  return replies[turn % replies.length];
}
