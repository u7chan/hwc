import type { ComponentChildren } from "preact";
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import type { ChatMessage, ChatSnapshot } from "../server/chat/contract";
import type { PaneState } from "../server/herdr/state";
import { OUTPUT_LINES } from "./api";
import {
  agentInfo,
  agentInfoLabel,
  contextMeter,
  type ContextMeterView,
  isPendingConfirmed,
  latestUserAt,
  paneBody,
  type PendingMessage,
  usePaneChat,
} from "./chat";
import {
  chipOnInput,
  type CommandId,
  commandCandidates,
  commandLabel,
  commandSendText,
  commandText,
} from "./commands";
import { useCopy } from "./copy";
import { readDraft, storage, writeDraft } from "./drafts";
import {
  AgentGlyphIcon,
  ArrowDownIcon,
  CloseIcon,
  CollapseIcon,
  CopyGlyph,
  ExpandIcon,
  PaneIcon,
  SendIcon,
  StatusMark,
  TerminalIcon,
} from "./icons";
import { Markdown } from "./Markdown";
import { usePaneOutput } from "./output";
import { agentGlyph, isShellPane, paneName, paneSubLabel } from "./select";
import { Spinner } from "./Spinner";
import { formatClock, formatElapsed } from "./time";

// 出力がまだ無いときは、空の枠だけ置いても意味がないので案内を出す。
function OutputEmpty() {
  return (
    <div class="hwc-output-empty">
      <span class="hwc-output-empty-mark">
        <TerminalIcon size={22} />
      </span>
      <p class="hwc-output-empty-title">まだ出力はありません</p>
      <p class="hwc-output-empty-text">エージェントが動くと、その様子がここに流れます。</p>
    </div>
  );
}

function ChatEmpty() {
  return (
    <div class="hwc-output-empty">
      <span class="hwc-output-empty-mark">
        <TerminalIcon size={22} />
      </span>
      <p class="hwc-output-empty-title">まだ会話はありません</p>
      <p class="hwc-output-empty-text">メッセージを送ると、やり取りがここに並びます。</p>
    </div>
  );
}

// 中身が届くまでの置き。行数を多めにして、下から伸びるように見せる。
function OutputSkeleton() {
  return (
    <div class="hwc-skeleton" aria-hidden="true">
      {[92, 78, 86, 64, 88, 72, 40].map((width, index) => (
        <span class="hwc-skeleton-line" key={index} style={{ width: `${width}%` }} />
      ))}
    </div>
  );
}

const USER_MESSAGE_CLAMP_LINES = 5;
const USER_MESSAGE_CLAMP_FALLBACK = 128;
const PENDING_TIMEOUT_MS = 60_000;

function UserMessage(props: {
  message: ChatMessage;
  copyButton: ComponentChildren;
  pending?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const [contentHeight, setContentHeight] = useState(0);
  const [lineHeight, setLineHeight] = useState(0);
  const content = useRef<HTMLDivElement>(null);
  const textId = `hwc-msg-text-${props.message.id}`;

  useLayoutEffect(() => {
    const element = content.current;
    if (!element) return;
    const measure = () => {
      setContentHeight(element.scrollHeight);
      setLineHeight(Number.parseFloat(getComputedStyle(element).lineHeight) || 0);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [props.message.text]);

  const clampHeight =
    lineHeight > 0 ? lineHeight * USER_MESSAGE_CLAMP_LINES : USER_MESSAGE_CLAMP_FALLBACK;
  const overflowing = contentHeight > clampHeight + 1;

  return (
    <>
      <div class="hwc-msg-bubble">
        <div
          class="hwc-msg-body"
          id={textId}
          ref={content}
          style={{ maxHeight: `${expanded ? contentHeight : clampHeight}px` }}
        >
          {props.message.text}
          {overflowing && !expanded ? (
            <span class="hwc-msg-more" aria-hidden="true">
              …
            </span>
          ) : null}
        </div>
        {overflowing ? (
          <button
            type="button"
            class="hwc-msg-expand"
            aria-expanded={expanded}
            aria-controls={textId}
            onClick={() => setExpanded((value) => !value)}
          >
            <span>{expanded ? "閉じる" : "もっとみる"}</span>
            <span class="hwc-msg-expand-icon">
              <ArrowDownIcon size={12} />
            </span>
          </button>
        ) : null}
      </div>
      <div class="hwc-msg-meta">
        {props.copyButton}
        <span class="hwc-msg-time">{props.pending ? "送信中" : formatClock(props.message.at)}</span>
      </div>
    </>
  );
}

// 会話として読むための並び。ユーザーは右、エージェントは左。
// どのエージェントかは入力欄の側に出しているので、ここでは繰り返さない。
function ChatLog(props: {
  snapshot: ChatSnapshot;
  replying: boolean;
  waitingMs: number | null;
  copiedId: string | null;
  onCopy: (id: string, text: string) => void;
  pending: ChatMessage[];
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

  // ツール実行だけのターンは会話に残らない。返答待ちの表示だけが動いていることを示す。
  const rows = [
    ...props.snapshot.messages.map((message) => ({ message, pending: false })),
    ...props.pending.map((message) => ({ message, pending: true })),
  ];
  if (rows.length === 0 && !props.replying) return <ChatEmpty />;

  return (
    <ol class="hwc-chat">
      {rows.map(({ message, pending }) => (
        <li class="hwc-msg" data-role={message.role} key={message.id}>
          {message.role === "agent" ? (
            <>
              <Markdown text={message.text} />
              <div class="hwc-msg-meta">
                <span class="hwc-msg-time">{formatClock(message.at)}</span>
                {copyButton(message)}
              </div>
            </>
          ) : (
            <UserMessage message={message} copyButton={copyButton(message)} pending={pending} />
          )}
        </li>
      ))}
      {props.replying ? (
        <li class="hwc-msg" data-role="agent" aria-label="返答を待っています">
          <div class="hwc-msg-meta">
            <span class="hwc-typing">
              <span />
              <span />
              <span />
            </span>
            {props.waitingMs === null ? null : (
              <span class="hwc-msg-elapsed">{formatElapsed(props.waitingMs)}</span>
            )}
          </div>
        </li>
      ) : null}
    </ol>
  );
}

// 送る文字列は短いので、記号だけを出さず、何が起きるかを並べる。
function CommandBadge(props: { id: CommandId }) {
  return (
    <>
      <span class="hwc-command-text">{commandText(props.id)}</span>
      <span class="hwc-command-label">{commandLabel(props.id)}</span>
    </>
  );
}

// 数値は可視テキストと sr-only の全文で伝え、バーは装飾に留める。
function ContextMeter(props: { view: ContextMeterView }) {
  const { view } = props;
  return (
    <span class="hwc-context" data-tone={view.tone}>
      <span class="hwc-context-text" aria-hidden="true">
        <span class="hwc-context-wide">{view.wide}</span>
        <span class="hwc-context-narrow">{view.narrow}</span>
      </span>
      <span class="hwc-visually-hidden">{view.wide}</span>
      {view.percent === null ? null : (
        <span class="hwc-context-bar" aria-hidden="true">
          <span class="hwc-context-bar-fill" style={{ width: `${view.fill}%` }} />
        </span>
      )}
    </span>
  );
}

type PaneDetailProps = {
  pane: PaneState;
  context: { workspaceLabel: string; tabLabel: string };
  compact: boolean;
  waitingMs: number | null;
  onSubmit: (text: string) => Promise<boolean>;
};

export function PaneDetail(props: PaneDetailProps) {
  const { pane, context, compact, waitingMs, onSubmit } = props;
  // 下書きはペインごとに残す。書きかけのまま一覧へ戻っても消えない。
  const [draft, setDraft] = useState(() => readDraft(storage(), pane.id));
  const [expandedOpen, setExpandedOpen] = useState(false);
  const [sending, setSending] = useState(false);
  const [sendFailed, setSendFailed] = useState(false);
  const [atBottom, setAtBottom] = useState(true);
  const [pending, setPending] = useState<PendingMessage[]>([]);
  // チップは id だけを持つ。表示名と送信文字列は定数から引く。
  const [chip, setChip] = useState<CommandId | null>(null);

  // 簡略中は expanded を効かせない。状態は書き換えないので、通常の高さに戻れば再び効く。
  const expanded = expandedOpen && !compact;

  // 要対応の間は端末を見たいので、会話の取得も止める。戻ったらその場で取り直す。
  const blocked = pane.agentStatus === "blocked";
  const { snapshot, failed: chatFailed } = usePaneChat(
    pane.id,
    pane.chat && !blocked,
    pane.agentStatus,
  );
  const body = paneBody({ chat: pane.chat, blocked, failed: chatFailed, snapshot });
  const pendingMessages = pending.filter(
    (item) => !isPendingConfirmed(item, snapshot?.messages ?? []),
  );

  const { read, failed } = usePaneOutput(body.kind === "output" ? pane.id : null);
  const output = read?.text ?? null;
  const outputEmpty = output !== null && output.trim() === "";
  const replying = pane.agentStatus === "working";
  const chatEmpty =
    body.kind === "chat" &&
    body.snapshot.messages.length === 0 &&
    pendingMessages.length === 0 &&
    !replying;
  const empty = body.kind === "chat" ? chatEmpty : body.kind === "output" && outputEmpty;
  const info = agentInfo(snapshot);
  // モデルと effort が無くても、コンテキストの材料があれば行を出す。
  const meter = contextMeter(snapshot?.context ?? null);
  const content = body.kind === "chat" ? body.snapshot.messages : output;

  const input = useRef<HTMLTextAreaElement>(null);
  const scroller = useRef<HTMLDivElement>(null);

  const candidates = commandCandidates(pane, draft, snapshot?.context ?? null);
  const canSend = chip === null ? draft.trim() !== "" : !replying;
  const shell = isShellPane(pane);
  const placeholder =
    chip === "compact" ? "コンパクトの指示（任意）" : shell ? "コマンドを入力" : "メッセージを入力";
  const subLabel = paneSubLabel(pane);

  const { copiedId, copy } = useCopy();
  const copied = copiedId === "pane";
  const copyId = () => copy("pane", pane.id);

  // 入力量に合わせて高さを伸ばす。広げている間は CSS の高さに任せる。
  const fit = (field: HTMLTextAreaElement | null, open: boolean) => {
    if (!field) return;
    field.style.height = "";
    if (open) return;
    field.style.height = "auto";
    field.style.height = `${field.scrollHeight}px`;
  };

  // 打つたびに書くと重いので、手が止まってから残す。compact チップ中の draft は
  // 指示であり、復元するとチップが無いぶん本文として送られてしまうので保存しない。
  useEffect(() => {
    if (chip === "compact") return;
    const text = draft;
    const timer = setTimeout(() => writeDraft(storage(), pane.id, text), 250);
    return () => clearTimeout(timer);
  }, [draft, pane.id, chip]);

  // 送信で空にしたときも、高さを初期状態へ戻す。分割枚数が変わって簡略が切り替わったときも、
  // 前の inline height を残さない。
  useEffect(() => {
    fit(input.current, expanded);
  }, [draft, expanded, compact]);

  // 最新が見えている間だけ追従する。読み返しているときは勝手に動かさない。
  // 失敗の notice はメッセージ領域を縮めるので、出たときも追従し直す。
  useEffect(() => {
    const element = scroller.current;
    if (element && atBottom) element.scrollTop = element.scrollHeight;
  }, [content, replying, atBottom, pendingMessages.length, sendFailed]);

  useEffect(() => {
    if (pending.length === 0) return;
    const messages = snapshot?.messages ?? [];
    setPending((items) => {
      const next = items.filter((item) => !isPendingConfirmed(item, messages));
      return next.length === items.length ? items : next;
    });
  }, [snapshot, pending.length]);

  useEffect(() => {
    if (replying) return;
    setPending((items) => {
      const next = items.filter((item) => !item.waiting);
      return next.length === items.length ? items : next;
    });
  }, [replying, pending.length]);

  useEffect(() => {
    const idle = pending.filter((item) => !item.waiting);
    if (idle.length === 0) return;
    const oldest = Math.min(...idle.map((item) => item.at));
    const delay = Math.max(0, oldest + PENDING_TIMEOUT_MS - Date.now());
    const timer = setTimeout(() => {
      const now = Date.now();
      setPending((items) =>
        items.filter((item) => item.waiting || item.at + PENDING_TIMEOUT_MS > now),
      );
    }, delay);
    return () => clearTimeout(timer);
  }, [pending]);

  const jumpToLatest = () => {
    setAtBottom(true);
    const element = scroller.current;
    element?.scrollTo({ top: element.scrollHeight, behavior: "smooth" });
  };

  // 候補を選ぶとチップになり、入力欄の /... は消える。送信はもう一度 Enter。
  const pick = (id: CommandId) => {
    setChip(id);
    setDraft("");
    // タップでキーボードが閉じないよう、入力欄へ焦点を戻す。
    input.current?.focus();
  };

  const clearChip = () => {
    setChip(null);
    setDraft("");
    input.current?.focus();
  };

  const sendText = async () => {
    if (!canSend || sending) return;
    const text = draft;
    const at = Date.now();
    const from = latestUserAt(snapshot?.messages ?? []);
    const waiting = replying;
    setSending(true);
    // 送信したらキーボードを閉じて出力を見せる。
    input.current?.blur();
    // 前の失敗は消す。送り直したのに前の notice が残っていると、いつの結果か読めない。
    setSendFailed(false);
    // 送れたときだけ空にする。失敗したら書き直せるよう残す。
    if (await onSubmit(text)) {
      setDraft("");
      setPending((items) => [
        ...items,
        { id: `pending-${at}-${items.length}`, role: "user", text, at, from, waiting },
      ]);
    } else {
      setSendFailed(true);
    }
    setSending(false);
  };

  // /new は user 発話を残さないので、送信中バブルを積むと最大 60 秒残る。
  // compact は draft を指示として後ろに付ける。送れたときだけ両方空にする。
  const sendCommand = async (id: CommandId) => {
    if (sending || replying) return;
    const text = commandSendText(id, draft);
    setSending(true);
    input.current?.blur();
    setSendFailed(false);
    if (await onSubmit(text)) {
      setChip(null);
      setDraft("");
    } else setSendFailed(true);
    setSending(false);
  };

  const submit = () => {
    if (chip !== null) {
      void sendCommand(chip);
      return;
    }
    const first = candidates[0];
    if (first !== undefined) {
      pick(first);
      return;
    }
    void sendText();
  };

  return (
    <>
      <div class="hwc-pane-head">
        <span class="hwc-pane-head-icon" data-agent={agentGlyph(pane.agent)}>
          {pane.agent ? <AgentGlyphIcon agent={pane.agent} size={14} /> : <PaneIcon size={14} />}
        </span>
        <span class="hwc-pane-head-main">
          <span class="hwc-pane-head-name">{paneName(pane)}</span>
          {subLabel === null ? null : <span class="hwc-pane-head-sub">{subLabel}</span>}
        </span>
        <span class="hwc-pane-id" data-copied={copied}>
          <span class="hwc-pane-id-text">{pane.id}</span>
          <button
            type="button"
            class="hwc-pane-id-copy"
            aria-label={copied ? "コピーしました" : "ペイン ID をコピー"}
            onClick={copyId}
          >
            <CopyGlyph copied={copied} />
          </button>
        </span>
      </div>
      <div class="hwc-output-wrap">
        <div
          class="hwc-output-scroll"
          data-empty={empty}
          ref={scroller}
          onScroll={(event) => {
            const element = event.currentTarget;
            setAtBottom(element.scrollHeight - element.scrollTop - element.clientHeight <= 8);
          }}
        >
          {body.kind === "skeleton" ? (
            <OutputSkeleton />
          ) : body.kind === "chat" ? (
            <>
              {body.snapshot.truncated ? (
                <p class="hwc-output-notice">古い会話は省略されています</p>
              ) : null}
              <ChatLog
                snapshot={body.snapshot}
                replying={replying}
                waitingMs={waitingMs}
                copiedId={copiedId}
                onCopy={copy}
                pending={pendingMessages}
              />
            </>
          ) : (
            <>
              {read?.truncated ? (
                <p class="hwc-output-notice">最新の {OUTPUT_LINES} 行を表示しています</p>
              ) : null}
              {failed ? (
                <p class="hwc-output-notice" role="status">
                  出力を取得できません。接続が戻ると自動で更新します。
                </p>
              ) : null}
              {output === null ? (
                failed ? null : (
                  <OutputSkeleton />
                )
              ) : outputEmpty ? (
                <OutputEmpty />
              ) : (
                <pre class="hwc-output">{output}</pre>
              )}
            </>
          )}
        </div>
        <button
          type="button"
          class="hwc-jump"
          data-visible={!atBottom}
          aria-label="最新へ"
          aria-hidden={atBottom}
          tabIndex={atBottom ? -1 : 0}
          onClick={jumpToLatest}
        >
          <ArrowDownIcon />
        </button>
      </div>

      {sendFailed ? (
        <p class="hwc-send-notice" role="status">
          <span class="hwc-send-notice-mark">
            <StatusMark tone="attention" size={12} />
          </span>
          送信できませんでした
        </p>
      ) : null}

      <form
        class="hwc-input"
        data-expanded={expanded}
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <label class="hwc-visually-hidden" for={`hwc-input-${pane.id}`}>
          {context.workspaceLabel} / {context.tabLabel} のペインへ送る
        </label>
        <div class="hwc-input-frame">
          {compact ? null : (
            <button
              type="button"
              class="hwc-input-toggle"
              aria-expanded={expanded}
              aria-label={expanded ? "入力を折りたたむ" : "入力を広げる"}
              onClick={() => setExpandedOpen((current) => !current)}
            >
              {expanded ? <CollapseIcon /> : <ExpandIcon />}
            </button>
          )}
          {chip !== null ? (
            <div class="hwc-commands">
              <span class="hwc-command" data-chip="true">
                <CommandBadge id={chip} />
                <button
                  type="button"
                  class="hwc-command-clear"
                  aria-label={`${commandText(chip)} を解除`}
                  onClick={clearChip}
                >
                  <CloseIcon size={14} />
                </button>
              </span>
            </div>
          ) : candidates.length === 0 ? null : (
            <div class="hwc-commands" role="group" aria-label="コマンド候補">
              {candidates.map((id) => (
                <button type="button" class="hwc-command" key={id} onClick={() => pick(id)}>
                  <CommandBadge id={id} />
                </button>
              ))}
            </div>
          )}
          <textarea
            id={`hwc-input-${pane.id}`}
            ref={input}
            class="hwc-input-field"
            rows={compact ? 1 : 2}
            value={draft}
            // 簡略時は placeholder を付けない。狭い入力欄で「メッセージを入力」が切れる。
            {...(compact ? {} : { placeholder })}
            onInput={(event) => {
              setDraft(event.currentTarget.value);
              setChip(chipOnInput(chip));
            }}
            onKeyDown={(event) => {
              const composing = event.isComposing || event.keyCode === 229;
              if (event.key === "Enter" && !event.shiftKey && !composing) {
                event.preventDefault();
                submit();
              }
            }}
          />
          <div class="hwc-input-actions">
            <span class="hwc-input-tail">
              {info === null && meter === null ? null : (
                <span
                  class="hwc-input-info"
                  title={info === null ? undefined : agentInfoLabel(info)}
                >
                  <span class="hwc-input-agent" data-agent={agentGlyph(pane.agent)}>
                    <AgentGlyphIcon agent={pane.agent} size={14} />
                  </span>
                  {info?.model == null ? null : <span class="hwc-input-model">{info.model}</span>}
                  {info?.effort == null ? null : (
                    <span class="hwc-input-effort">{info.effort}</span>
                  )}
                  {meter === null ? null : <ContextMeter view={meter} />}
                </span>
              )}
              <button
                type="submit"
                class="hwc-send"
                data-sending={sending}
                aria-label={sending ? "送信中" : "送信"}
                disabled={!canSend || sending}
              >
                {sending ? <Spinner /> : <SendIcon />}
              </button>
            </span>
          </div>
        </div>
      </form>
    </>
  );
}
