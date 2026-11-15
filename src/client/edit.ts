import type { ChatSnapshot } from "../server/chat/contract";
import type { PaneState } from "../server/herdr/state";
import { REWIND_ID_PATTERN } from "../shared/rewind";
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

export function isRequestId(value: string): boolean {
  return REWIND_ID_PATTERN.test(value);
}

export type EditEligibility = {
  row: ChatRow;
  rows: readonly ChatRow[];
  snapshot: ChatSnapshot | null;
  pane: PaneState;
  sending: boolean;
  editing: boolean;
};

// 鉛筆を出す条件。最後の行は葉のことがあり、navigateTree が no-op になる。
// 送信控えの行はセッションの entry id を持たないので除く。
export function canEditMessage(args: EditEligibility): boolean {
  if (args.editing || args.sending) return false;
  if (args.snapshot?.canRewind !== true) return false;
  if (args.pane.agent !== "pi" || !args.pane.chat) return false;
  if (args.pane.agentStatus === "working") return false;
  if (args.row.echo !== "none") return false;
  if (args.row.message.role !== "user") return false;
  if (args.row.message.text.trim() === "") return false;
  if ((args.row.message.attachments?.length ?? 0) > 0) return false;
  const sessionRows = args.rows.filter((row) => row.echo === "none");
  return sessionRows[sessionRows.length - 1]?.message.id !== args.row.message.id;
}

export function editFailureNotice(error: string, rewound: boolean): string {
  if (rewound) return "会話は戻りましたが、送信できませんでした。もう一度送信してください";
  if (error === "edit_in_flight") return "いま編集を送信中です";
  if (error === "confirmation_pending") return "確認中は編集できません";
  if (error === "not_editable") return "この発言は編集できません";
  if (error === "text_too_long") return "本文が長すぎます";
  return "編集を開始できませんでした。もう一度お試しください";
}
