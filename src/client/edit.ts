import type { ChatSnapshot } from "../server/chat/contract";
import type { PaneState } from "../server/herdr/state";
import type { ChatRow } from "./chat";

export type EditSession = {
  messageId: string;
  requestId: string;
  text: string;
  sending: boolean;
};

// crypto.randomUUID は secure context に限られる。hwc は LAN の HTTP で開くので、
// templates と同じく時刻と乱数から作る。
export function newRequestId(now = Date.now(), random = Math.random()): string {
  return `r-${now.toString(36)}-${random.toString(36).slice(2, 10)}`;
}

export type EditEligibility = {
  row: ChatRow;
  snapshot: ChatSnapshot | null;
  pane: PaneState;
  sending: boolean;
  editing: boolean;
};

// 鉛筆を出す条件。葉は navigateTree が no-op になるので除く。葉は表示上の末尾ではなく、
// セッションに最後に追記されたエントリで判定する。応答を止めると本文なしの assistant が
// 葉として残り、送った発言は末尾に見えるが戻せるため。送信控えの行はセッションの
// entry id を持たない。
export function canEditMessage(args: EditEligibility): boolean {
  if (args.editing || args.sending) return false;
  const { snapshot, pane, row } = args;
  if (snapshot === null || snapshot.canRewind !== true) return false;
  if (pane.agent !== "pi" || !pane.chat) return false;
  // 質問の待ちの間は、TUI のダイアログが入力を受け取る。
  if (pane.agentStatus === "working" || pane.agentStatus === "blocked") return false;
  if (row.echo !== "none") return false;
  if (row.message.role !== "user") return false;
  if (row.message.text.trim() === "") return false;
  if ((row.message.attachments?.length ?? 0) > 0) return false;
  return snapshot.leafId !== row.message.id;
}

export function editFailureNotice(error: string, rewound: boolean): string {
  if (rewound) return "会話は戻りましたが、送信できませんでした。もう一度送信してください";
  if (error === "edit_in_flight") return "いま編集を送信中です";
  if (error === "confirmation_pending") return "確認中は編集できません";
  if (error === "not_editable") return "この発言は編集できません";
  if (error === "text_too_long") return "本文が長すぎます";
  return "編集を開始できませんでした。もう一度お試しください";
}
