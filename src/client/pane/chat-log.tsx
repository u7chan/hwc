import { Fragment } from "preact";
import type { ChatFile, ChatMessage, ChatSnapshot } from "../../server/chat/contract";
import { chatRows, compactionInsertIndex, echoInsertIndex, type PendingMessage } from "../chat";
import { CopyGlyph } from "../icons";
import { type MessageReveal } from "../reveal";
import { ChatEmpty } from "./empty";
import { AgentMessage, CommandEcho, Compaction, ErrorMessage, UserMessage } from "./message";

// 会話として読むための並び。ユーザーは右、エージェントは左。
// どのエージェントかは入力欄の側に出しているので、ここでは繰り返さない。
export function ChatLog(props: {
  paneId: string;
  snapshot: ChatSnapshot;
  replying: boolean;
  compacting: boolean;
  copiedId: string | null;
  expandable: boolean;
  compactionDurationMs: number | null;
  compactionEcho: { text: string; at: number; completedAt: number | null } | null;
  onCopy: (id: string, text: string) => void;
  onOpenImage: (url: string, name: string) => void;
  onOpenPreview: (file: ChatFile) => void;
  pending: readonly PendingMessage[];
  reveal: MessageReveal | null;
}) {
  const copyButton = (message: ChatMessage) => {
    const copied = props.copiedId === message.id;
    return (
      <button
        type="button"
        class="hwc-msg-copy"
        data-copied={copied}
        aria-label={copied ? "コピーしました" : "このメッセージをコピー"}
        onClick={() => props.onCopy(message.id, message.text)}
      >
        <CopyGlyph copied={copied} size={14} />
      </button>
    );
  };
  // 画像だけのメッセージは本文が無い。空文字をコピーさせない。
  const userCopyButton = (message: ChatMessage) =>
    message.text === "" ? null : copyButton(message);

  // ツール実行だけのターンは会話に残らない。返答待ちの表示だけが動いていることを示す。
  const rows = chatRows(props.snapshot.messages, props.pending);
  const compaction = props.snapshot.compaction;
  // サーバーが返す位置は messages 基準。再取得の境目で欠けても落ちないよう clamp する。
  const compactionAt =
    compaction === null
      ? null
      : Math.min(Math.max(0, compaction.index), props.snapshot.messages.length);
  const compactionRow =
    compaction === null ? null : (
      <li class="hwc-compaction-row">
        <Compaction
          compaction={compaction}
          expandable={props.expandable}
          durationMs={props.compactionDurationMs}
        />
      </li>
    );
  const echo = props.compactionEcho;
  const echoPending = echo !== null && echo.completedAt === null;
  const echoAtLog =
    echo !== null && echo.completedAt !== null && compaction?.at === echo.completedAt;
  const echoVisible = echoPending || echoAtLog;
  const echoRow =
    echoVisible && echo !== null ? <CommandEcho text={echo.text} at={echo.at} /> : null;
  // 実行中はメッセージの末尾（後から送った echo より前）、完了後は compaction の
  // 区切りの直前に置く。
  const echoIndex = echoPending && echo !== null ? echoInsertIndex(rows, echo.at) : null;
  // 圧縮の区切りはメッセージ境界に置く。同じ境界のコマンドの控えは、その手前に残す。
  const compactionIndex = compactionInsertIndex(rows, compactionAt);
  const compactionBlock =
    compactionRow === null ? null : (
      <>
        {echoAtLog ? echoRow : null}
        {compactionRow}
      </>
    );
  if (
    rows.length === 0 &&
    !props.replying &&
    !props.compacting &&
    compaction === null &&
    !echoVisible
  )
    return <ChatEmpty />;
  return (
    <ol class="hwc-chat">
      {rows.map((row, index) => {
        const reveal = props.reveal;
        const revealing = reveal !== null && row.message.id === reveal.id;
        const message = revealing ? { ...row.message, text: reveal.text } : row.message;
        return (
          <Fragment key={row.message.id}>
            {echoIndex === index ? echoRow : null}
            {compactionIndex === index ? compactionBlock : null}
            {row.echo === "command" ? (
              <CommandEcho text={row.message.text} at={row.message.at} />
            ) : (
              <li
                class="hwc-msg"
                data-role={row.message.role}
                data-pending={row.echo === "pending" ? "true" : undefined}
              >
                {row.message.role === "agent" ? (
                  <AgentMessage
                    paneId={props.paneId}
                    message={message}
                    taskScope={`${index + 1}番目のメッセージ`}
                    complete={!revealing}
                    // 途中までしか見えていない本文をコピーさせない。出きってから記号を出す。
                    copyButton={revealing ? null : copyButton(row.message)}
                    onOpenImage={props.onOpenImage}
                    onOpenPreview={props.onOpenPreview}
                  />
                ) : row.message.role === "error" ? (
                  <ErrorMessage message={row.message} copyButton={copyButton(row.message)} />
                ) : (
                  <UserMessage
                    paneId={props.paneId}
                    message={row.message}
                    copyButton={userCopyButton(row.message)}
                    onOpenImage={props.onOpenImage}
                    pending={row.echo === "pending"}
                  />
                )}
              </li>
            )}
          </Fragment>
        );
      })}
      {echoIndex === rows.length ? echoRow : null}
      {compactionIndex === rows.length ? compactionBlock : null}
    </ol>
  );
}
