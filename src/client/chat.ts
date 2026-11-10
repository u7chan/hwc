import { useEffect, useRef, useState } from "preact/hooks";
import type {
  ChatCompaction,
  ChatContext,
  ChatFile,
  ChatMessage,
  ChatSnapshot,
  ChatUsage,
} from "../server/chat/contract";
import type { AgentStatus } from "../server/herdr/state";
import { messageFileLabel } from "../shared/message-files";
import { CHAT_POLL_ACTIVE_MS, CHAT_POLL_IDLE_MS, chatFileUrl, readChat } from "./api";
import { MARKDOWN_MAX_LENGTH, markdownImageHrefs } from "./markdown/parse";

// 返答が届いている間は短く、動いていない間は長く。隠れている間に読んでも見る人はいない。
export function chatPollDelay(
  status: AgentStatus,
  visibility: DocumentVisibilityState,
): number | null {
  if (visibility === "hidden") return null;
  return status === "working" ? CHAT_POLL_ACTIVE_MS : CHAT_POLL_IDLE_MS;
}

export type PollChange = "load" | "ignore";

// 状態が変わったら、予約を待たずに 1 回読む。間隔を張り直すだけでは、待っている最中の変化に
// 追いつけない（idle の 5 秒待機中にターンが始まると、最初の取得が最大 5 秒遅れる）。
export function pollOnStatusChange(props: {
  last: AgentStatus;
  next: AgentStatus;
  visible: boolean;
}): PollChange {
  // 隠れている間は読まない。復帰したときの 1 回で追いつく。
  if (!props.visible) return "ignore";
  // マウント直後とペイン切替直後は、最初の取得と同じ状態でここへ来る。読み直す理由が無い。
  if (props.next === props.last) return "ignore";
  return "load";
}

// 打ち切りは失敗ではない。端末出力へも切り替えない。
export function isAbortError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  return "name" in error && (error as { name: unknown }).name === "AbortError";
}

export type PaneBody =
  | { kind: "chat"; snapshot: ChatSnapshot }
  | { kind: "skeleton" }
  | { kind: "output" };

// 会話を持たないペイン、会話を読めない間、要対応で端末を見たい間は端末出力を出す。
export function paneBody(props: {
  chat: boolean;
  blocked: boolean;
  failed: boolean;
  snapshot: ChatSnapshot | null;
}): PaneBody {
  if (!props.chat || props.blocked || props.failed) return { kind: "output" };
  if (props.snapshot === null) return { kind: "skeleton" };
  return { kind: "chat", snapshot: props.snapshot };
}

export type MessageImageSource = { url: string; label: string };

// 本文の画像記法と一致した画像は、その位置に描く。裸のパスだけで拾った画像と、
// 解析しても image ノードにならなかった画像（フェンスの中・解析上限の外）は、
// 本文に位置が無いのでメッセージ末尾の一覧に残す。
export function splitInlineImages(
  paneId: string,
  text: string,
  files: readonly ChatFile[] | undefined,
): { images: Map<string, MessageImageSource>; rest: ChatFile[] } {
  const images = new Map<string, MessageImageSource>();
  const rest: ChatFile[] = [];
  const hasRefs = (files ?? []).some(
    (file) => file.kind === "image" && file.imageRefs !== undefined,
  );
  const drawn =
    hasRefs && text.length <= MARKDOWN_MAX_LENGTH ? markdownImageHrefs(text) : undefined;
  for (const file of files ?? []) {
    const refs =
      file.kind === "image" && file.imageRefs !== undefined && drawn !== undefined
        ? file.imageRefs.filter((ref) => drawn.has(ref))
        : [];
    if (refs.length === 0) {
      rest.push(file);
      continue;
    }
    const source = { url: chatFileUrl(paneId, file), label: messageFileLabel(file.name) };
    for (const ref of refs) images.set(ref, source);
  }
  return { images, rest };
}

export type PendingMessage = ChatMessage & {
  from: number;
  waiting: boolean;
  // 送信したときに会話にあったメッセージ数。確定後も送信位置へ戻すために持つ。
  after: number;
  // 猶予内にターンが始まらなかった送信。TUI のコマンドとしてローカルの履歴に残す。
  command: boolean;
};

export type NewSessionReset = {
  at: number;
  etag: string | null;
  messageIds: ReadonlySet<string>;
  compactionAt: number | null;
};

export function newSessionReset(snapshot: ChatSnapshot | null, at: number): NewSessionReset {
  return {
    at,
    etag: snapshot?.etag ?? null,
    messageIds: new Set(snapshot?.messages.map((message) => message.id)),
    compactionAt: snapshot?.compaction?.at ?? null,
  };
}

export function newSessionPending(reset: NewSessionReset, snapshot: ChatSnapshot | null): boolean {
  if (snapshot === null || snapshot.etag === reset.etag) return true;
  // モデル設定などでも etag は変わる。古い発話や圧縮が残る間は新規会話とみなさない。
  if (snapshot.messages.some((message) => reset.messageIds.has(message.id))) return true;
  if (reset.compactionAt !== null && snapshot.compaction?.at === reset.compactionAt) return true;
  // 読み込み前に /new を送った場合、最初に届く古い会話を新規会話として出さない。
  if (reset.etag === null) {
    return (
      snapshot.messages.some((message) => message.at < reset.at) ||
      (snapshot.compaction !== null && snapshot.compaction.at < reset.at)
    );
  }
  return false;
}

// 表示だけを先に空にし、取得したスナップショットと条件付き取得の etag は書き換えない。
export function newSessionSnapshot(snapshot: ChatSnapshot | null): ChatSnapshot {
  return {
    etag: snapshot?.etag ?? "",
    messages: [],
    model: snapshot?.model ?? null,
    effort: snapshot?.effort ?? null,
    truncated: false,
    context: null,
    compaction: null,
  };
}

export function latestUserAt(messages: ChatMessage[]): number {
  return messages.reduce(
    (latest, message) => (message.role === "user" ? Math.max(latest, message.at) : latest),
    0,
  );
}

// 本文は pi 側で trim やテンプレート展開されることがあるため、送信時点の最後の user 発話より後に
// 新しい user 発話が現れたかで対応付ける。
export function isPendingConfirmed(pending: PendingMessage, messages: ChatMessage[]): boolean {
  if (pending.command) {
    // コマンドの本文は展開されない。位置だけで判定すると、次の通常のメッセージでも
    // コマンドの控えが消える。同じ文言の user 発話が現れたときだけ置き換える。
    return messages.some(
      (message) =>
        message.role === "user" &&
        message.at > pending.from &&
        message.text.trim() === pending.text.trim(),
    );
  }
  return messages.some((message) => message.role === "user" && message.at > pending.from);
}

// TUI のコマンド（/reload、!bash など）は user 発話を残さず、agent_status も working に
// ならない。待っても isPendingConfirmed では確定しないので、動き出さなかった送信は
// コマンドの控えに切り替える。working を観測できた echo はターンの確認まで残す。
export const PENDING_TURN_GRACE_MS = 3_000;

export function idleEchoExpired(pending: PendingMessage, now: number): boolean {
  return !pending.waiting && pending.at + PENDING_TURN_GRACE_MS <= now;
}

export type ChatRow = {
  message: ChatMessage;
  // none はセッションのメッセージ。pending は送信中の echo、command はコマンドの控え。
  echo: "none" | "pending" | "command";
  // この行までに並ぶセッションのメッセージ数。圧縮の区切りの位置を決める。
  seen: number;
};

// コマンドの控えは、送信したときに会話へあったメッセージ数を目印に差し込む。単純に末尾へ
// 足すと、次の発話が届いたときにコマンドがその後ろへ回る。
export function chatRows(
  messages: readonly ChatMessage[],
  echoes: readonly PendingMessage[],
): readonly ChatRow[] {
  const commands = new Map<number, PendingMessage[]>();
  const pending: PendingMessage[] = [];
  for (const echo of echoes) {
    if (!echo.command) {
      pending.push(echo);
      continue;
    }
    const anchor = Math.min(Math.max(0, echo.after), messages.length);
    const group = commands.get(anchor);
    if (group === undefined) commands.set(anchor, [echo]);
    else group.push(echo);
  }

  const rows: ChatRow[] = [];
  for (let index = 0; index <= messages.length; index += 1) {
    for (const echo of commands.get(index) ?? []) {
      rows.push({ message: echo, echo: "command", seen: index });
    }
    if (index === messages.length) break;
    rows.push({ message: messages[index]!, echo: "none", seen: index + 1 });
  }
  // 送信中の echo は、まだ届いていないメッセージより後ろに置く。
  for (const echo of pending) {
    rows.push({ message: echo, echo: "pending", seen: messages.length });
  }
  return rows;
}

// 圧縮の区切りはメッセージ境界に置く。同じ境界のコマンド控えは、圧縮より前に送ったものとして
// その手前に残す。末尾の送信中 echo より前を既定にする。
export function compactionInsertIndex(
  rows: readonly ChatRow[],
  compactionAt: number | null,
): number | null {
  if (compactionAt === null) return null;
  const next = rows.findIndex((row) => row.echo === "none" && row.seen > compactionAt);
  if (next !== -1) return next;
  const tail = rows.findIndex((row) => row.echo === "pending");
  return tail === -1 ? rows.length : tail;
}

// 実行中の圧縮の控えは、メッセージの末尾（後から送ったローカル echo より前）に置く。
export function echoInsertIndex(rows: readonly ChatRow[], echoAt: number): number {
  const messageEnd = rows.reduce((end, row, index) => (row.echo === "none" ? index + 1 : end), 0);
  const later = rows.findIndex((row) => row.echo !== "none" && row.message.at > echoAt);
  return later === -1 ? rows.length : Math.max(messageEnd, later);
}

export type AgentInfo = { model: string | null; effort: string | null };

// どちらも無ければ札を出さない。片方だけ分かるならそれだけ出す。
export function agentInfo(snapshot: ChatSnapshot | null): AgentInfo | null {
  if (snapshot === null) return null;
  if (snapshot.model === null && snapshot.effort === null) return null;
  return { model: snapshot.model, effort: snapshot.effort };
}

// pi の footer と同じ丸め。桁が上がる境目で単位を切り替える。
export function formatTokens(count: number): string {
  if (count < 1_000) return count.toString();
  if (count < 10_000) return `${(count / 1_000).toFixed(1)}k`;
  if (count < 1_000_000) return `${Math.round(count / 1_000)}k`;
  if (count < 10_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  return `${Math.round(count / 1_000_000)}M`;
}

// 圧縮前の大きさは数として読ませる。ここだけ 3 桁区切りのままにする。
export function compactionLabel(compaction: ChatCompaction): string {
  if (compaction.tokensBefore === null) return "圧縮";
  return `${compaction.tokensBefore.toLocaleString("en-US")} tokens から圧縮`;
}

export function contextPercent(context: ChatContext): number | null {
  const { tokens, window } = context;
  if (tokens === null || window === null || window <= 0) return null;
  return (tokens / window) * 100;
}

// pi は 90% 超を危険色にするが、hwc に危険な状態の文字色は無い。バーの長さでも差が出るので
// 段は 1 つに留める。段を増やすなら design のトークンを見直す。
export function contextTone(percent: number): "secondary" | "attention" {
  return percent > 70 ? "attention" : "secondary";
}

// 100% を超えても数値はそのまま出す。塗りだけをトラックの中に収める。
export function contextFill(percent: number): number {
  return Math.min(100, Math.max(0, percent));
}

// 材料がある分だけ出す。狭いときは「percent → tokens → ? → なし」の順に短くする。
export function contextText(context: ChatContext, narrow: boolean): string | null {
  const { tokens, window } = context;
  const percent = contextPercent(context);

  if (narrow) {
    if (percent !== null) return `${percent.toFixed(1)}%`;
    if (tokens !== null) return formatTokens(tokens);
    if (window !== null) return "?";
    return null;
  }

  if (tokens !== null && window !== null && percent !== null) {
    return `${formatTokens(tokens)}/${formatTokens(window)} (${percent.toFixed(1)}%)`;
  }
  if (tokens !== null) return `${formatTokens(tokens)}/?`;
  if (window !== null) return `?/${formatTokens(window)}`;
  return null;
}

export type ContextMeterView = {
  wide: string;
  narrow: string;
  percent: number | null;
  fill: number;
  tone: "secondary" | "attention";
};

// 両方が不明なら何も出さない。片方だけ分かるなら分かる方を出す。
export function contextMeter(context: ChatContext | null): ContextMeterView | null {
  if (context === null) return null;
  const wide = contextText(context, false);
  const narrow = contextText(context, true);
  if (wide === null || narrow === null) return null;
  const percent = contextPercent(context);
  return {
    wide,
    narrow,
    percent,
    fill: percent === null ? 0 : contextFill(percent),
    tone: percent === null ? "secondary" : contextTone(percent),
  };
}

export function contextDetails(
  context: ChatContext,
  usage: ChatUsage | undefined,
): [string, string][] {
  const value = (n: number | null) => (n === null ? "不明" : n.toLocaleString("en-US"));
  const rows: [string, string][] = [
    ["使用量", value(context.tokens)],
    ["設定枠", value(context.window)],
  ];
  if (usage !== undefined) {
    rows.push(
      ["入力", value(usage.input)],
      ["出力", value(usage.output)],
      ["キャッシュ読取", value(usage.cacheRead)],
      ["キャッシュ書込", value(usage.cacheWrite)],
    );
    if (usage.reasoning !== null) rows.push(["推論", value(usage.reasoning)]);
  }
  return rows;
}

type ChatEntry = { paneId: string; snapshot: ChatSnapshot };

export function usePaneChat(
  paneId: string,
  enabled: boolean,
  status: AgentStatus,
): { snapshot: ChatSnapshot | null; failed: boolean; refresh: () => void } {
  const [latest, setLatest] = useState<ChatEntry | null>(null);
  // 失敗したペインを覚える。切り替えた直後に前のペインの失敗を出さない。
  const [failedPane, setFailedPane] = useState<string | null>(null);

  // 間隔や nudge の判断だけを描画のたびに更新する。effect の依存に入れると、状態が変わる
  // たびに張り直して etag を失い、同じ本文を取り直すことになる。
  const statusRef = useRef(status);
  statusRef.current = status;
  // 直近の予約が前提にした状態。状態変化を拾うためだけに持つ。
  const lastStatus = useRef(status);
  // effect の外から「今すぐ 1 回読む」を呼ぶための口。effect の寿命と一致させる。
  const nudge = useRef<(() => void) | null>(null);
  const reload = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (!enabled) return;
    const id = paneId;

    let active = true;
    let timer: number | undefined;
    let controller: AbortController | null = null;
    // 経過は effect の中で持ち回る。304 のときは本文を捨てて、この値を保つ。
    let etag: string | null = null;

    function stop() {
      if (timer !== undefined) window.clearTimeout(timer);
      timer = undefined;
    }

    function schedule() {
      stop();
      const delay = chatPollDelay(statusRef.current, document.visibilityState);
      lastStatus.current = statusRef.current;
      if (delay !== null) timer = window.setTimeout(() => void load(), delay);
    }

    async function load() {
      stop();
      controller?.abort();
      const current = new AbortController();
      controller = current;
      try {
        const read = await readChat(id, etag, current.signal);
        if (!active || current.signal.aborted) return;
        if (read.kind === "snapshot") {
          etag = read.snapshot.etag;
          setLatest({ paneId: id, snapshot: read.snapshot });
        }
        setFailedPane(read.kind === "unavailable" ? id : null);
      } catch (error) {
        // 隠れたことで打ち切った場合も、読み直しに置き換えられた場合も失敗ではない。
        if (!active || isAbortError(error)) return;
        setFailedPane(id);
      } finally {
        // 追い越された要求が、後から始まった要求の持ち物を消さないようにする。
        if (controller === current) controller = null;
      }
      if (active) schedule();
    }

    // 状態が変わったら、予約済みのタイマーを捨ててその場で読む。取得中の要求は打ち切る。
    function onStatusChange() {
      const change = pollOnStatusChange({
        last: lastStatus.current,
        next: statusRef.current,
        visible: document.visibilityState !== "hidden",
      });
      if (change === "load") void load();
    }

    function onVisibility() {
      if (document.visibilityState === "hidden") {
        stop();
        controller?.abort();
        return;
      }
      void load();
    }

    nudge.current = onStatusChange;
    reload.current = () => {
      if (document.visibilityState !== "hidden") void load();
    };
    lastStatus.current = statusRef.current;
    document.addEventListener("visibilitychange", onVisibility);
    // 開いた直後に隠れている場合も読まない。見えるようになったときの 1 回で追いつく。
    if (document.visibilityState !== "hidden") void load();

    return () => {
      active = false;
      nudge.current = null;
      reload.current = null;
      stop();
      controller?.abort();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [paneId, enabled]);

  useEffect(() => {
    nudge.current?.();
  }, [status]);

  // ペインを切り替えた直後に、前のペインの会話を出さない。
  return {
    snapshot: latest?.paneId === paneId ? latest.snapshot : null,
    failed: failedPane === paneId,
    refresh: () => reload.current?.(),
  };
}
