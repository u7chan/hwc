import { Fragment, type ComponentChildren, type Ref } from "preact";
import { useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from "preact/hooks";
import type {
  ChatCompaction,
  ChatContext,
  ChatFile,
  ChatMessage,
  ChatSnapshot,
  ChatUsage,
} from "../server/chat/contract";
import type { PaneState } from "../server/herdr/state";
import { MAX_ATTACHMENTS } from "../shared/attachments";
import { activityLabel, activitySnippet, usePaneActivity } from "./activity";
import { OUTPUT_LINES, attachmentUrl, chatFileUrl, uploadAttachment } from "./api";
import { isLayoutShift, isNearBottom } from "./scroll";
import {
  ATTACHMENT_LIMIT_NOTICE,
  type AttachmentAction,
  dropActionFrom,
  pasteActionFrom,
  SEND_FAILED_NOTICE,
  SHELL_NEWLINE_NOTICE,
  STOP_FAILED_NOTICE,
  unsupportedImageNotice,
  uploadFailureNotice,
} from "./attachments";
import {
  agentInfo,
  type AgentInfo,
  compactionLabel,
  contextDetails,
  contextMeter,
  type ContextMeterView,
  echoInsertIndex,
  isPendingConfirmed,
  latestUserAt,
  newSessionPending,
  newSessionReset,
  newSessionSnapshot,
  type NewSessionReset,
  paneBody,
  type PendingMessage,
  usePaneChat,
} from "./chat";
import { enterInsertsNewline } from "./input";
import {
  chipOnInput,
  type CommandId,
  commandAvailable,
  commandBlockReason,
  commandCandidates,
  commandLabel,
  commandSendText,
  commandText,
  compactAlreadyDone,
  COMPACTED_NOTICE,
  isCompactCommand,
  isCommandPane,
  isNewSessionCommand,
  type PaneCommandHandle,
} from "./commands";
import { useCopy } from "./copy";
import { readDraft, readReply, storage, writeDraft, writeReply } from "./drafts";
import { useHint } from "./hint";
import {
  AgentGlyphIcon,
  ArrowDownIcon,
  CloseIcon,
  CollapseIcon,
  CopyGlyph,
  ExpandIcon,
  MoreIcon,
  PaneIcon,
  SendIcon,
  StatusMark,
  StopIcon,
  TerminalIcon,
} from "./icons";
import { Markdown } from "./Markdown";
import { MENU_ID } from "./Menu";
import { usePaneOutput } from "./output";
import { usePullRequest } from "./pull-request";
import { confirmationView, type ConfirmationAttempt } from "./confirmation";
import { PaneConfirmation } from "./PaneConfirmation";
import { canSend, canStop, composeReply, normaliseQuote, splitQuote } from "./reply";
import { agentGlyph, isShellPane, paneName, type PaneContext } from "./select";
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
const NEW_SESSION_TIMEOUT_MS = 60_000;

// 選択した本文の上に出す返信ボタン。位置は .hwc-output-wrap を基準にした px。
type QuoteAnchor = { text: string; left: number; top: number; above: boolean };

const QUOTE_SCOPE = "data-quote-scope";
const QUOTE_BUTTON_GAP = 8;
const QUOTE_BUTTON_HEIGHT = 32;
const QUOTE_BUTTON_HALF_WIDTH = 32;

// スマホは選択メニューを差し替えられない。返信の入り口はポインタを持つ画面だけに出す。
// 端末の性質は途中で変わらないので、最初の判定を使い回す。
let touchOnly: boolean | null = null;
function touchFirst(): boolean {
  touchOnly ??=
    window.matchMedia("(hover: none)").matches || window.matchMedia("(pointer: coarse)").matches;
  return touchOnly;
}

function quoteScopeOf(node: Node | null, root: Element): Element | null {
  if (node === null) return null;
  const element = node instanceof Element ? node : node.parentElement;
  const scope = element?.closest(`[${QUOTE_SCOPE}]`) ?? null;
  return scope !== null && root.contains(scope) ? scope : null;
}

// 選択が 1 つの本文の中にあるときだけ、その本文と位置を返す。
// 入力欄・ヘッダ・メタ行・複数メッセージにまたがる選択は対象外。
function readQuoteAnchor(scroller: HTMLElement, frame: HTMLElement): QuoteAnchor | null {
  const selection = document.getSelection();
  if (selection === null || selection.isCollapsed || selection.rangeCount === 0) return null;
  const text = normaliseQuote(selection.toString());
  if (text === "") return null;
  const range = selection.getRangeAt(0);
  const scope = quoteScopeOf(range.startContainer, scroller);
  if (scope === null || scope !== quoteScopeOf(range.endContainer, scroller)) return null;
  const rect = range.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return null;

  const box = frame.getBoundingClientRect();
  const below = rect.bottom - box.top + QUOTE_BUTTON_GAP;
  // 下端に寄っているときは選択の上に出す。入力欄に重ねない。
  const above = below + QUOTE_BUTTON_HEIGHT > box.height;
  const left = Math.min(
    Math.max(rect.left + rect.width / 2 - box.left, QUOTE_BUTTON_HALF_WIDTH),
    Math.max(box.width - QUOTE_BUTTON_HALF_WIDTH, QUOTE_BUTTON_HALF_WIDTH),
  );
  return {
    text,
    left,
    top: above ? rect.top - box.top - QUOTE_BUTTON_GAP : below,
    above,
  };
}

// サムネイルは会話の高さに合わせて小さく出す。押したら同じ配信 URL を拡大する。
function MessageAttachments(props: {
  paneId: string;
  names: string[];
  onOpen: (url: string, name: string) => void;
}) {
  return (
    <div class="hwc-msg-attachments">
      {props.names.map((name) => {
        const url = attachmentUrl(props.paneId, name);
        return (
          <button
            type="button"
            class="hwc-msg-attachment"
            key={name}
            aria-label="添付画像を拡大"
            aria-haspopup="dialog"
            onClick={() => props.onOpen(url, name)}
          >
            <img class="hwc-msg-attachment-image" src={url} alt="" loading="lazy" />
          </button>
        );
      })}
    </div>
  );
}

// エージェントが本文で示した画像。ユーザーの添付と同じ見た目で、押すと拡大する。
function MessageFiles(props: {
  paneId: string;
  files: ChatFile[];
  onOpen: (url: string, name: string) => void;
}) {
  return (
    <div class="hwc-msg-attachments">
      {props.files.map((file) => {
        const url = chatFileUrl(props.paneId, file);
        const label = file.name.slice(file.name.lastIndexOf("/") + 1);
        return (
          <button
            type="button"
            class="hwc-msg-attachment"
            key={`${file.name}@${file.version}`}
            aria-label={`${label} を拡大`}
            aria-haspopup="dialog"
            onClick={() => props.onOpen(url, label)}
          >
            <img class="hwc-msg-attachment-image" src={url} alt="" loading="lazy" />
          </button>
        );
      })}
    </div>
  );
}

function UserMessage(props: {
  paneId: string;
  message: ChatMessage;
  copyButton: ComponentChildren;
  onOpenImage: (url: string, name: string) => void;
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
  // 送信後の引用は、先頭の blockquote だけをカードにする（ADR 0022）。
  const { quote, body } = splitQuote(props.message.text);

  return (
    <>
      <div class="hwc-msg-bubble">
        {props.message.text === "" ? null : (
          <div
            class="hwc-msg-body"
            id={textId}
            ref={content}
            data-quote-scope="true"
            style={{ maxHeight: `${expanded ? contentHeight : clampHeight}px` }}
          >
            {quote === null ? null : <span class="hwc-msg-quote">{quote}</span>}
            {body}
            {overflowing && !expanded ? (
              <span class="hwc-msg-more" aria-hidden="true">
                …
              </span>
            ) : null}
          </div>
        )}
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
        {props.message.attachments === undefined ? null : (
          <MessageAttachments
            paneId={props.paneId}
            names={props.message.attachments}
            onOpen={props.onOpenImage}
          />
        )}
      </div>
      <div class="hwc-msg-meta">
        {props.copyButton}
        <span class="hwc-msg-time">{props.pending ? "送信中" : formatClock(props.message.at)}</span>
      </div>
    </>
  );
}

// 圧縮の境目。吹き出しではなく、履歴が切り替わる区切りとして置く。
function CompactionRule() {
  return <span class="hwc-compaction-rule" aria-hidden="true" />;
}

// 要約は開かないと読めない。畳んだ 1 行だけでも、ここより前が圧縮されたことが分かる。
// 所要時間は開始を観測できたときだけ添える。リロード後は tokens とホバー時刻だけになる。
function Compaction(props: {
  compaction: ChatCompaction;
  expandable: boolean;
  durationMs: number | null;
}) {
  const label = compactionLabel(props.compaction);
  const shown = props.durationMs === null ? label : `${formatElapsed(props.durationMs)} · ${label}`;
  const title = `${formatClock(props.compaction.at)} に圧縮`;
  if (!props.expandable || props.compaction.summary === "") {
    return (
      <p class="hwc-compaction">
        <CompactionRule />
        <span class="hwc-compaction-label" title={title}>
          {shown}
        </span>
        <CompactionRule />
      </p>
    );
  }

  return (
    <details class="hwc-compaction">
      <summary class="hwc-compaction-head">
        <CompactionRule />
        <span class="hwc-compaction-label" title={title}>
          {shown}
        </span>
        <span class="hwc-compaction-icon">
          <ArrowDownIcon size={12} />
        </span>
        <CompactionRule />
      </summary>
      <div class="hwc-compaction-body">{props.compaction.summary}</div>
    </details>
  );
}

// ローカルで送った /compact の控え。セッションには残らないので、リロードや
// ペイン切り替えで消える。完了した compaction の直前、実行中は後から送ったメッセージの前に置く。
function CommandEcho(props: { text: string; at: number }) {
  return (
    <li class="hwc-msg" data-role="command">
      <div class="hwc-command-echo">{props.text}</div>
      <div class="hwc-msg-meta">
        <span class="hwc-msg-time">{formatClock(props.at)}</span>
      </div>
    </li>
  );
}

// 失敗したターン。吹き出しにはせず、応答が返らなかった記録として置く。
// 本文はプロバイダが返した生の文言なので、Markdown として解釈せずそのまま出す。
function ErrorMessage(props: { message: ChatMessage; copyButton: ComponentChildren }) {
  const count = props.message.count ?? 1;
  return (
    <>
      <div class="hwc-error">
        <span class="hwc-error-head">
          <StatusMark tone="attention" size={12} />
          応答に失敗しました
          {count > 1 ? <span class="hwc-error-count">{count} 回</span> : null}
        </span>
        <p class="hwc-error-text">{props.message.text}</p>
      </div>
      <div class="hwc-msg-meta">
        <span class="hwc-msg-time">{formatClock(props.message.at)}</span>
        {props.copyButton}
      </div>
    </>
  );
}

// 会話として読むための並び。ユーザーは右、エージェントは左。
// どのエージェントかは入力欄の側に出しているので、ここでは繰り返さない。
function ChatLog(props: {
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
  // 画像だけのメッセージは本文が無い。空文字をコピーさせない。
  const userCopyButton = (message: ChatMessage) =>
    message.text === "" ? null : copyButton(message);

  // ツール実行だけのターンは会話に残らない。返答待ちの表示だけが動いていることを示す。
  const rows = [
    ...props.snapshot.messages.map((message) => ({ message, pending: false })),
    ...props.pending.map((message) => ({ message, pending: true })),
  ];
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
  const echoGap =
    echoPending && echo !== null
      ? echoInsertIndex(
          props.snapshot.messages.length,
          props.pending.map((message) => message.at),
          echo.at,
        )
      : null;
  // 実行中は未確定メッセージを含む末尾（後から送ったものより前）、完了後は compaction の
  // 区切りの直前に置く。
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
      {compactionBlock !== null && compactionAt === 0 ? compactionBlock : null}
      {rows.map(({ message, pending }, index) => (
        <Fragment key={message.id}>
          {echoGap === index ? echoRow : null}
          <li class="hwc-msg" data-role={message.role} data-pending={pending ? "true" : undefined}>
            {message.role === "agent" ? (
              <>
                <Markdown text={message.text} taskScope={`${index + 1}番目のメッセージ`} />
                {message.files === undefined ? null : (
                  <MessageFiles
                    paneId={props.paneId}
                    files={message.files}
                    onOpen={props.onOpenImage}
                  />
                )}
                <div class="hwc-msg-meta">
                  <span class="hwc-msg-time">{formatClock(message.at)}</span>
                  {copyButton(message)}
                </div>
              </>
            ) : message.role === "error" ? (
              <ErrorMessage message={message} copyButton={copyButton(message)} />
            ) : (
              <UserMessage
                paneId={props.paneId}
                message={message}
                copyButton={userCopyButton(message)}
                onOpenImage={props.onOpenImage}
                pending={pending}
              />
            )}
          </li>
          {compactionBlock !== null && compactionAt === index + 1 ? compactionBlock : null}
        </Fragment>
      ))}
      {echoGap === rows.length ? echoRow : null}
    </ol>
  );
}

// 実行中の段階と thinking の末尾。会話の外（入力欄の直上）に固定して出し、
// 読み返している間も何が起きているかを見せる。入力欄の上なので、高さが変わっても
// 入力欄の位置は動かない。
function LiveStatus(props: {
  phase: string | null;
  thought: string;
  elapsedMs: number | null;
  compacting: boolean;
  stopping: boolean;
  // 低いセルでは会話の高さを優先する。thinking を出さず、段階と経過だけにする。
  showThought: boolean;
  onCancelCompaction: () => void;
}) {
  return (
    // pi 以外や sidecar の無いペインでは、中身が経過時間だけになる。状態名を
    // 支援技術へも渡すため、名前は帯に持たせる。
    <div
      class="hwc-live"
      role="group"
      aria-label={props.compacting ? "会話を圧縮しています" : "返答を待っています"}
    >
      <div class="hwc-live-head">
        <span class="hwc-typing">
          <span />
          <span />
          <span />
        </span>
        {props.phase === null ? null : <span class="hwc-live-phase">{props.phase}</span>}
        {props.compacting ? <span class="hwc-compaction-pending">会話を圧縮しています</span> : null}
        <span class="hwc-live-tail">
          {props.compacting ? (
            <button
              type="button"
              class="hwc-compaction-cancel"
              disabled={props.stopping}
              onClick={props.onCancelCompaction}
            >
              {props.stopping ? "中断中" : "中断"}
            </button>
          ) : null}
          {props.elapsedMs === null ? null : (
            <span class="hwc-live-elapsed">{formatElapsed(props.elapsedMs)}</span>
          )}
        </span>
      </div>
      {props.showThought && props.thought !== "" ? (
        <div class="hwc-live-thought">
          <p class="hwc-live-thought-text">{props.thought}</p>
        </div>
      ) : null}
    </div>
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

function ContextMeter(props: { view: ContextMeterView; context: ChatContext; usage?: ChatUsage }) {
  const { view, context, usage } = props;
  const hint = useHint();
  return (
    <span class="hwc-hint-wrap" ref={hint.root} {...hint.wrapperProps}>
      <button
        type="button"
        class="hwc-context"
        data-tone={view.tone}
        aria-label={`コンテキスト使用量 ${view.wide}`}
        aria-describedby={hint.open === null ? undefined : hint.panelId}
        aria-expanded={hint.open !== null}
        {...hint.triggerProps}
      >
        <span class="hwc-context-text" aria-hidden="true">
          <span class="hwc-context-wide">{view.wide}</span>
          <span class="hwc-context-narrow">{view.narrow}</span>
        </span>
        {view.percent === null ? null : (
          <span class="hwc-context-bar" aria-hidden="true">
            <span class="hwc-context-bar-fill" style={{ width: `${view.fill}%` }} />
          </span>
        )}
      </button>
      <span
        id={hint.panelId}
        ref={hint.panel}
        role="tooltip"
        class="hwc-hint-panel"
        data-open={hint.open !== null}
        tabIndex={hint.panelTabIndex}
      >
        <span class="hwc-hint-title">直近のコンテキスト使用量</span>
        {contextDetails(context, usage).map(([label, value]) => (
          <span class="hwc-hint-row" key={label}>
            <span>{label}</span>
            <span>{value}</span>
          </span>
        ))}
        <span class="hwc-hint-note">
          設定枠はモデル仕様上の最大値とは限りません。自動圧縮は枠に達する前に行われることがあります。
        </span>
      </span>
    </span>
  );
}

// モデル名は狭い画面で省略される。全体を読む口と、名前を持ち出す口を同じパネルに置く。
function AgentInfoHint(props: { info: AgentInfo }) {
  const model = props.info.model;
  const effort = props.info.effort;
  const hint = useHint();
  const { copiedId, copy } = useCopy();
  const copied = copiedId === "model";
  return (
    <span class="hwc-hint-wrap hwc-agent-hint" ref={hint.root} {...hint.wrapperProps}>
      <button
        type="button"
        class="hwc-agent-info"
        aria-expanded={hint.open !== null}
        aria-controls={hint.panelId}
        {...hint.triggerProps}
      >
        {model === null ? null : <span class="hwc-input-model">{model}</span>}
        {effort === null ? null : <span class="hwc-input-effort">{effort}</span>}
      </button>
      <span
        id={hint.panelId}
        ref={hint.panel}
        role="group"
        aria-label="モデルとエフォート"
        class="hwc-hint-panel"
        data-open={hint.open !== null}
        tabIndex={hint.panelTabIndex}
      >
        {model === null ? null : (
          <span class="hwc-model-row">
            <span class="hwc-model-name">{model}</span>
            <button
              type="button"
              class="hwc-model-copy"
              data-copied={copied}
              aria-label={copied ? "コピーしました" : "モデル名をコピー"}
              onClick={() => copy("model", model)}
            >
              <CopyGlyph copied={copied} size={14} />
            </button>
          </span>
        )}
        {effort === null ? null : (
          <span class="hwc-hint-row">
            <span>エフォート</span>
            <span>{effort}</span>
          </span>
        )}
      </span>
    </span>
  );
}

type PaneDetailProps = {
  pane: PaneState;
  context: PaneContext;
  compact: boolean;
  // 分割セルが並ぶときだけ、セルの名前を出す。チップと同じ文字列の繰り返しを避ける。
  labeled: boolean;
  // 一覧が隠れる狭い画面でだけ渡す。広い画面では一覧がブランチを持っている。
  branch: string | null;
  waitingMs: number | null;
  sending: boolean;
  dismissedConfirmation: string | null;
  confirmationAttempts: ReadonlyMap<string, ConfirmationAttempt>;
  onConfirmFolderTrust: (id: string) => void;
  onDismissConfirmation: (id: string) => void;
  // メニューはセルの外（App 直下）に 1 つだけ出す。セルは container-type を持ち、
  // 中の fixed はセル基準になる。実行口は一覧から同じペインを操作するときにも使う。
  menuOpen: boolean;
  commandRef: Ref<PaneCommandHandle>;
  onOpenMenu: (paneId: string, trigger: HTMLElement) => void;
  onSubmit: (text: string, attachments: string[]) => Promise<boolean>;
  onStop: () => Promise<boolean>;
  // ダイアログは App 直下に 1 つだけ出す。セルの中に置くと containment の内側に閉じる。
  onOpenImage: (url: string, name: string) => void;
};

// 名前はアップロードが終わるまで無い。controller は取り外しと離脱で送信を止めるために持つ。
type AttachedImage = {
  key: string;
  name: string | null;
  controller: AbortController;
};

export function PaneDetail(props: PaneDetailProps) {
  const {
    pane,
    context,
    compact,
    labeled,
    branch,
    waitingMs,
    sending,
    dismissedConfirmation,
    confirmationAttempts,
    onConfirmFolderTrust,
    onDismissConfirmation,
    menuOpen,
    onOpenMenu,
    onSubmit,
    onStop,
    onOpenImage,
  } = props;
  // 下書きはペインごとに残す。書きかけのまま一覧へ戻っても消えない。
  const [draft, setDraft] = useState(() => readDraft(storage(), pane.id));
  const [expandedOpen, setExpandedOpen] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [atBottom, setAtBottom] = useState(true);
  // クリア後にポーリングを待たず、出力を取り直すための契機。
  const [outputVersion, setOutputVersion] = useState(0);
  // 追従するかは state が正。イベント購読からも読むので、同じ値を ref に写す
  // （chat.ts の statusRef と同じ扱い）。更新は setPinned の 1 経路だけ。
  const pinned = useRef(true);
  // 高さが変わっただけのスクロール（入力欄や添付が伸縮して底が詰まる）は利用者の操作ではない。
  // 直前の content 高・表示領域の高さと比べて、変わっていれば追従の判断を変えない。
  const lastHeight = useRef(0);
  const lastClientHeight = useRef(0);
  const [pending, setPending] = useState<PendingMessage[]>([]);
  const [sessionReset, setSessionReset] = useState<NewSessionReset | null>(null);
  // チップは id だけを持つ。表示名と送信文字列は定数から引く。
  const [chip, setChip] = useState<CommandId | null>(null);
  const [attachments, setAttachments] = useState<AttachedImage[]>([]);
  const nextAttachmentKey = useRef(0);
  // ファイルをドラッグしている間だけ composer を光らせる。dragenter / dragleave は
  // 子要素をまたぐたびに入れ替わるので、深さを数えて枠から出たときだけ消す。
  const [dropping, setDropping] = useState(false);
  const dragDepth = useRef(0);
  // 引用は trim 済みの生テキスト。`>` は送信のときに付ける（ADR 0022）。
  // 返信 UI を持たない端末では、残っていても使わない。見えない引用を付けて送らないため。
  const [reply, setReply] = useState<string | null>(() => {
    if (touchFirst()) return null;
    const stored = readReply(storage(), pane.id);
    return stored === "" ? null : stored;
  });
  const [quoteAnchor, setQuoteAnchor] = useState<QuoteAnchor | null>(null);

  const setPinned = (next: boolean) => {
    pinned.current = next;
    setAtBottom(next);
  };

  // 簡略中は expanded を効かせない。状態は書き換えないので、通常の高さに戻れば再び効く。
  const expanded = expandedOpen && !compact;

  // 要対応の間は端末を見たいので、会話の取得も止める。戻ったらその場で取り直す。
  const blocked = pane.agentStatus === "blocked";
  const {
    snapshot: serverSnapshot,
    failed: chatFailed,
    refresh: refreshChat,
  } = usePaneChat(pane.id, pane.chat && !blocked, pane.agentStatus);
  // 実行中の段階は pi 拡張の sidecar からだけ取る（ADR 0035）。
  const activity = usePaneActivity(
    pane.id,
    pane.agent === "pi" && pane.chat && !blocked,
    pane.agentStatus,
  );
  // ブランチを出している見出しでだけ引く。広い画面と分割セルは branch が null で来る。
  const pullRequest = usePullRequest(context.workspaceId, branch);
  const resetting = sessionReset !== null && newSessionPending(sessionReset, serverSnapshot);
  const snapshot = resetting ? newSessionSnapshot(serverSnapshot) : serverSnapshot;
  const normalBody = paneBody({
    chat: pane.chat || resetting,
    blocked,
    failed: chatFailed && !resetting,
    snapshot,
  });
  const pendingMessages = pending.filter(
    (item) =>
      (!resetting || sessionReset === null || item.at >= sessionReset.at) &&
      !isPendingConfirmed(item, snapshot?.messages ?? []),
  );

  useEffect(() => {
    if (sessionReset === null) return;
    // TUI コマンドの成否は返らないため、反映されなければサーバーの表示へ戻す。
    const timer = window.setTimeout(
      () => setSessionReset(null),
      Math.max(0, sessionReset.at + NEW_SESSION_TIMEOUT_MS - Date.now()),
    );
    return () => window.clearTimeout(timer);
  }, [sessionReset]);

  const { read, failed } = usePaneOutput(
    pane.agent === "codex" || normalBody.kind === "output" ? pane.id : null,
    outputVersion,
  );
  const interaction = read?.interaction ?? null;
  const view = confirmationView({ pane, interaction, dismissedId: dismissedConfirmation, failed });
  const readOnly = view !== "normal";
  const body = readOnly ? { kind: "output" as const } : normalBody;
  const confirmation =
    view === "confirm" && interaction?.kind === "folder-trust" ? interaction : null;
  const output = read?.text ?? null;
  const outputEmpty = output !== null && output.trim() === "";
  const replying = pane.agentStatus === "working";
  // /compact の開始を観測できたときだけ、完了までの所要時間をログに添える。
  // リロードやペイン切り替えでは失う（永続化は別スコープ）。
  const [compactionRun, setCompactionRun] = useState<{
    startedAt: number;
    baselineAt: number | null;
  } | null>(null);
  const [compactionNow, setCompactionNow] = useState(() => Date.now());
  const compactionSawWorking = useRef(false);
  const [compactionDuration, setCompactionDuration] = useState<{
    at: number;
    ms: number;
  } | null>(null);
  const [compactionEcho, setCompactionEcho] = useState<{
    text: string;
    at: number;
    completedAt: number | null;
  } | null>(null);
  const markCompaction = (baselineAt: number | null, text: string) => {
    const startedAt = Date.now();
    compactionSawWorking.current = false;
    setCompactionNow(startedAt);
    setCompactionEcho({ text, at: startedAt, completedAt: null });
    setCompactionRun({ startedAt, baselineAt });
  };
  useEffect(() => {
    if (compactionRun === null) return;
    setCompactionNow(Date.now());
    const timer = window.setInterval(() => setCompactionNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [compactionRun]);
  useEffect(() => {
    if (compactionRun === null) return;
    const at = snapshot?.compaction?.at ?? null;
    // 新しい compaction が届いたら、開始からの差を所要時間として残す。
    if (at !== null && at !== compactionRun.baselineAt) {
      const ms = at - compactionRun.startedAt;
      if (ms > 0 && ms < 24 * 60 * 60 * 1000) setCompactionDuration({ at, ms });
      setCompactionEcho((echo) => (echo === null ? null : { ...echo, completedAt: at }));
      setCompactionRun(null);
      return;
    }
    // 手動の /compact は Herdr の agent_status を working にしない。working を観測
    // できた場合だけ idle 復帰を失敗とみなし、それ以外は完了か上限まで待つ。
    if (replying) {
      compactionSawWorking.current = true;
      return;
    }
    if (compactionSawWorking.current) {
      const timer = window.setTimeout(() => {
        setCompactionRun((run) => (run === compactionRun ? null : run));
      }, 3000);
      return () => window.clearTimeout(timer);
    }
    const timer = window.setTimeout(
      () => {
        setCompactionRun((run) => (run === compactionRun ? null : run));
      },
      10 * 60 * 1000,
    );
    return () => window.clearTimeout(timer);
  }, [compactionRun, replying, snapshot?.compaction?.at]);
  const compactionElapsedMs =
    compactionRun === null ? null : Math.max(0, compactionNow - compactionRun.startedAt);
  const compacting = !resetting && compactionRun !== null;
  const visibleCompactionEcho = resetting ? null : compactionEcho;
  const chatEmpty =
    body.kind === "chat" &&
    body.snapshot.messages.length === 0 &&
    body.snapshot.compaction === null &&
    pendingMessages.length === 0 &&
    !compacting &&
    visibleCompactionEcho === null &&
    !replying;
  const empty = body.kind === "chat" ? chatEmpty : body.kind === "output" && outputEmpty;
  const info = agentInfo(snapshot);
  // モデルと effort が無くても、コンテキストの材料があれば行を出す。
  const meter = contextMeter(snapshot?.context ?? null);
  const content = body.kind === "chat" ? body.snapshot.messages : output;

  const input = useRef<HTMLTextAreaElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLDivElement>(null);
  // 返信ボタンを出している間は自動追従を止める。購読を張り直さずに読むため ref に写す。
  const quoting = useRef(false);
  quoting.current = quoteAnchor !== null;

  // 添付を持っている間は候補を出さない。候補を選ぶと本文が消えるので、貼った画像と
  // 書きかけの指示が別々のメッセージに分かれてしまう。引用中も同じ理由で出さない。
  // 空の会話（新規セッション）と圧縮済みは commandAvailable が候補から外す。
  const compactDone = snapshot !== null && compactAlreadyDone(snapshot);
  const candidates =
    attachments.length === 0 && reply === null && compactionRun === null
      ? commandCandidates(pane, draft, snapshot)
      : [];
  const uploading = attachments.some((item) => item.name === null);
  const sendable = canSend({
    uploading,
    chip,
    replying,
    draft,
    attachments: attachments.length,
    reply,
  });
  // 停止は入力が空のときだけ出す。文字・添付・引用があれば、送信は実行中への追加指示になる。
  const stop = canStop({
    replying,
    agent: pane.agent,
    draft,
    attachments: attachments.length,
    reply,
    chip,
  });
  const busy = sending || stopping;
  const shell = isShellPane(pane);
  const placeholder =
    chip === "compact" ? "圧縮の指示（任意）" : shell ? "コマンドを入力" : "メッセージを入力";

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

  // 引用も同じ debounce で残す。再読み込みやペイン切替で戻せるようにする。
  useEffect(() => {
    if (touchFirst()) return;
    const text = reply ?? "";
    const timer = setTimeout(() => writeReply(storage(), pane.id, text), 250);
    return () => clearTimeout(timer);
  }, [reply, pane.id]);

  // 選択が 1 つの本文の中で終わったときだけ返信ボタンを出す。位置は選択の下（入らなければ上）。
  // 選択変更・スクロール・リサイズでは隠す。ペインの切替は PaneDetail の作り直しで消える。
  useEffect(() => {
    const scrollerElement = scroller.current;
    const frameElement = frame.current;
    if (scrollerElement === null || frameElement === null) return;
    if (touchFirst()) return;

    const refresh = () => setQuoteAnchor(readQuoteAnchor(scrollerElement, frameElement));
    const clear = () => setQuoteAnchor(null);
    document.addEventListener("selectionchange", refresh);
    scrollerElement.addEventListener("scroll", clear);
    window.addEventListener("resize", clear);
    return () => {
      document.removeEventListener("selectionchange", refresh);
      scrollerElement.removeEventListener("scroll", clear);
      window.removeEventListener("resize", clear);
    };
  }, [pane.id]);

  // 送信で空にしたときも、高さを初期状態へ戻す。分割枚数が変わって簡略が切り替わったときも、
  // 前の inline height を残さない。
  // 描画の後に高さを直すと、改行した 1 フレームだけ箱が低いままになり、
  // スクロールバーが一瞬出る。描画の前に合わせる。
  useLayoutEffect(() => {
    fit(input.current, expanded);
  }, [draft, expanded, compact, readOnly]);

  useLayoutEffect(() => {
    if (confirmation !== null && scroller.current) scroller.current.scrollTop = 0;
  }, [confirmation?.id]);

  // 最新が見えている間だけ追従する。読み返しているときは勝手に動かさない。
  // 失敗の notice はメッセージ領域を縮めるので、出たときも追従し直す。
  // 圧縮の吹き出しと進捗行は chat の末尾にローカルで足すため、content が変わらない
  // 間も追従できるよう compactionRun / compactionEcho も依存に入れる。
  useEffect(() => {
    if (confirmation !== null) return;
    const element = scroller.current;
    if (element && atBottom && !quoting.current) element.scrollTop = element.scrollHeight;
  }, [
    content,
    replying,
    atBottom,
    pendingMessages.length,
    notice,
    compactionRun,
    compactionEcho,
    confirmation?.id,
  ]);

  // 画像の読み込みや入力欄の伸びで高さが後から変わっても、最新を見ている間は底に留める。
  // 画像の load は bubble しないので capture で拾い、領域の伸縮は ResizeObserver で拾う。
  useLayoutEffect(() => {
    const element = scroller.current;
    if (!element) return;
    const keep = () => {
      lastHeight.current = element.scrollHeight;
      lastClientHeight.current = element.clientHeight;
      if (confirmation !== null || !pinned.current || quoting.current) return;
      element.scrollTop = element.scrollHeight;
    };
    // 初回は今の高さを基準にする。0 のまま残すと、最初のスクロールを伸縮と誤認する。
    lastHeight.current = element.scrollHeight;
    lastClientHeight.current = element.clientHeight;
    element.addEventListener("load", keep, true);
    const observer = new ResizeObserver(keep);
    observer.observe(element);
    return () => {
      element.removeEventListener("load", keep, true);
      observer.disconnect();
    };
  }, [confirmation?.id]);

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
    setPinned(true);
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

  // 選択を引用として固定し、返信を始める。compact のチップは外すが、指示の下書きは残す
  // （返信本文として送り、/compact には戻さない。ADR 0016 / 0022）。
  const startReply = (text: string) => {
    // 送信中に引用を変えると、成功時のクリアで新しい引用まで消える。送っている間は受け付けない。
    if (sending || text === "") return;
    setQuoteAnchor(null);
    setReply(text);
    setChip(null);
    // 選択の折りたたみは pointerdown で止めているが、押された後にブラウザが流す分は捨てる。
    document.getSelection()?.removeAllRanges();
    const field = input.current;
    if (field === null) return;
    field.focus();
    field.setSelectionRange(field.value.length, field.value.length);
  };

  const clearReply = () => {
    setReply(null);
    input.current?.focus();
  };

  // 外した添付は送らない。進行中のアップロードも止める。保存先のファイルは消さない。
  const removeAttachment = (key: string) => {
    attachments.find((item) => item.key === key)?.controller.abort();
    setAttachments((items) => items.filter((item) => item.key !== key));
  };

  const uploadImage = async (file: File) => {
    const controller = new AbortController();
    const key = `attachment-${nextAttachmentKey.current}`;
    nextAttachmentKey.current += 1;
    setAttachments((items) => [...items, { key, name: null, controller }]);

    const result = await uploadAttachment(pane.id, file, controller.signal);
    if (result.ok) {
      setAttachments((items) =>
        items.map((item) => (item.key === key ? { ...item, name: result.name } : item)),
      );
      return;
    }
    // 外された添付は一覧から既に消えている。その失敗は知らせない。
    if (controller.signal.aborted) return;
    setAttachments((items) => items.filter((item) => item.key !== key));
    setNotice(uploadFailureNotice(result.status));
  };

  // 貼った画像を見たらコマンドではなく本文を書く。書きかけの draft は捨てない。
  const addImages = (files: File[]) => {
    const room = MAX_ATTACHMENTS - attachments.length;
    if (room <= 0) {
      setNotice(ATTACHMENT_LIMIT_NOTICE);
      return;
    }
    if (files.length > room) setNotice(ATTACHMENT_LIMIT_NOTICE);
    setChip(null);
    for (const file of files.slice(0, room)) void uploadImage(file);
  };

  // ファイルのドラッグだけを扱う。テキストやページ内の要素のドラッグは既定動作のまま。
  const fileTransfer = (transfer: DataTransfer | null): DataTransfer | null => {
    if (transfer === null || !transfer.types.includes("Files")) return null;
    return transfer;
  };

  // 貼り付けとドロップで同じ受け付け方をする。未対応の形式は保存せず、その場で伝える。
  // アップロードする画像が無ければ既定動作を止めない（ADR 0018）。
  // 何もアップロードしないときは false を返し、呼び出し側に preventDefault させない。
  const takeImages = (action: AttachmentAction): boolean => {
    if (action.kind === "upload") {
      if (action.unsupported) setNotice(unsupportedImageNotice());
      addImages(action.files);
      return true;
    }
    if (action.kind === "unsupported") setNotice(unsupportedImageNotice());
    return false;
  };

  // ペインを離れたら、終わっていないアップロードを止める。送り先が消えている。
  const attached = useRef(attachments);
  attached.current = attachments;
  useEffect(
    () => () => {
      for (const item of attached.current) item.controller.abort();
    },
    [],
  );

  const startsNewSession = (text: string, names: readonly string[]) =>
    (pane.chat || serverSnapshot !== null) &&
    names.length === 0 &&
    isCommandPane(pane) &&
    isNewSessionCommand(text);

  const submitInput = async (text: string, names: string[]): Promise<boolean> => {
    const newSession = startsNewSession(text, names);
    if (newSession) setSessionReset(newSessionReset(serverSnapshot, Date.now()));
    const sent = await onSubmit(text, names);
    if (newSession) {
      if (sent) {
        setPending([]);
        setCompactionRun(null);
        setCompactionEcho(null);
        setCompactionDuration(null);
      } else setSessionReset(null);
      refreshChat();
    }
    return sent;
  };

  const sendText = async () => {
    if (readOnly || !sendable || sending) return;
    const names = attachments
      .map((item) => item.name)
      .filter((name): name is string => name !== null);
    const text = reply === null ? draft : composeReply(reply, draft);
    // 添付があると BFF が注記を後ろに付けるので、pi では /compact でもコマンドにならない。
    const compactCommand = attachments.length === 0 && isCompactCommand(text);
    const newCommand = startsNewSession(text, names);
    if (compactCommand && compactDone) {
      setNotice(COMPACTED_NOTICE);
      return;
    }
    const baselineAt = snapshot?.compaction?.at ?? null;
    const at = Date.now();
    const from = latestUserAt(snapshot?.messages ?? []);
    const waiting = replying;
    // 送信したらキーボードを閉じて出力を見せる。
    input.current?.blur();
    // 前の失敗は消す。送り直したのに前の notice が残っていると、いつの結果か読めない。
    setNotice(null);
    // 送れたときだけ空にする。失敗したら本文も添付も残す。
    if (await submitInput(text, names)) {
      // 送れたときだけ最新へ戻す。失敗したら読み返していた位置を保つ。
      setPinned(true);
      // 250ms の debounce を待たずに消す。先にペインを切り替えると古い値が戻る。
      writeDraft(storage(), pane.id, "");
      writeReply(storage(), pane.id, "");
      setDraft("");
      setReply(null);
      setAttachments([]);
      // /compact は user メッセージを残さない。送信カードを積むと最大 60 秒残るので、
      // 代わりに圧縮中の行を出す。
      if (compactCommand) {
        markCompaction(baselineAt, text);
      } else if (!newCommand) {
        setPending((items) => [
          ...items,
          {
            id: `pending-${at}-${items.length}`,
            role: "user",
            text,
            at,
            from,
            waiting,
            ...(names.length === 0 ? {} : { attachments: names }),
          },
        ]);
      }
    } else {
      setNotice(SEND_FAILED_NOTICE);
    }
  };

  const stopWorking = async () => {
    if (stopping || !stop) return;
    setStopping(true);
    setNotice(null);
    if (!(await onStop())) setNotice(STOP_FAILED_NOTICE);
    setStopping(false);
  };

  // 手動 compaction は Herdr の working にならないため、失敗しても agent_status から
  // 判別できない。10 分の上限だけに頼らず、進捗行から Esc を送ってローカルの開始記録を
  // 畳めるようにする。
  const cancelCompaction = async () => {
    if (stopping) return;
    setStopping(true);
    setNotice(null);
    if (await onStop()) {
      setCompactionRun(null);
      setCompactionEcho(null);
    } else setNotice(STOP_FAILED_NOTICE);
    setStopping(false);
  };

  // /new は user 発話を残さないので、送信中バブルを積むと最大 60 秒残る。
  // compact は draft を指示として後ろに付ける。送れたときだけ両方空にする。
  const sendCommand = async (id: CommandId) => {
    if (readOnly || sending || replying || compactionRun !== null) return;
    if (id === "compact" && compactDone) {
      setNotice(COMPACTED_NOTICE);
      return;
    }
    const text = commandSendText(id, draft);
    const baselineAt = snapshot?.compaction?.at ?? null;
    input.current?.blur();
    setNotice(null);
    if (await submitInput(text, [])) {
      setPinned(true);
      setChip(null);
      setDraft("");
      if (id === "compact") markCompaction(baselineAt, text);
    } else setNotice(SEND_FAILED_NOTICE);
  };

  // メニューからはコマンド文字列だけを送る。書きかけの draft・添付・引用は次の
  // メッセージのために残す（チップのように draft を指示には使わない）。
  // メニューを開いた後に状態が変わっても最新値で判定できるよう、送信直前の値は
  // ref から読む。onSubmit も App の再描画で更新されるので、同じく ref を経由する。
  const commandState = useRef({
    pane,
    readOnly,
    sending,
    replying,
    compacting: compactionRun !== null,
    snapshot,
  });
  commandState.current = {
    pane,
    readOnly,
    sending,
    replying,
    compacting: compactionRun !== null,
    snapshot,
  };
  const submitLatest = useRef(submitInput);
  submitLatest.current = submitInput;
  const sendMenuCommand = async (id: CommandId) => {
    const state = commandState.current;
    if (state.readOnly || state.sending || state.replying || state.compacting) return;
    const baselineAt = state.snapshot?.compaction?.at ?? null;
    const text = commandText(id);
    input.current?.blur();
    setNotice(null);
    if (await submitLatest.current(text, [])) {
      setPinned(true);
      setChip(null);
      if (id === "compact") markCompaction(baselineAt, text);
    } else setNotice(SEND_FAILED_NOTICE);
  };

  // 一覧の入口も、最新の送信中・圧縮中の状態で判定する。
  // 開いた後に状態が変わっても ref から最新値を読む。
  const menuCommands: PaneCommandHandle = {
    available: (id, currentPane) => {
      const state = commandState.current;
      return (
        !state.readOnly &&
        !state.sending &&
        !state.replying &&
        !state.compacting &&
        commandAvailable(id, currentPane, state.snapshot)
      );
    },
    busy: () => {
      const state = commandState.current;
      return state.readOnly || state.sending || state.replying || state.compacting;
    },
    blockReason: () => commandBlockReason(commandState.current.snapshot),
    run: (id) => {
      const state = commandState.current;
      if (
        !state.readOnly &&
        !state.sending &&
        !state.replying &&
        !state.compacting &&
        commandAvailable(id, state.pane, state.snapshot)
      ) {
        void sendMenuCommand(id);
      }
    },
    refreshOutput: () => {
      setPinned(true);
      setOutputVersion((version) => version + 1);
    },
  };
  useImperativeHandle(props.commandRef, () => menuCommands);

  const submit = () => {
    if (readOnly) return;
    // 添付を持ったまま /compact と打っても、候補にもチップにも流さず本文として送る。
    if (attachments.length === 0) {
      if (chip !== null) {
        void sendCommand(chip);
        return;
      }
      const first = candidates[0];
      if (first !== undefined) {
        pick(first);
        return;
      }
    }
    void sendText();
  };

  // 圧縮中は hwc のローカル表示が正。拡張の段階と重ねない。
  const livePhase = compacting || activity === null ? null : activityLabel(activity);
  const liveThought = compacting || activity === null ? "" : activitySnippet(activity.text);

  return (
    <>
      <div class="hwc-pane-head" data-bare={!labeled}>
        <span class="hwc-pane-head-icon" data-agent={agentGlyph(pane.agent)}>
          {pane.agent ? <AgentGlyphIcon agent={pane.agent} size={14} /> : <PaneIcon size={14} />}
        </span>
        {labeled ? (
          <span class="hwc-pane-head-name">{paneName(pane)}</span>
        ) : branch === null ? null : (
          <span class="hwc-pane-head-branch" title={branch}>
            {branch}
          </span>
        )}
        {pullRequest === null ? null : (
          <a
            class="hwc-pane-head-pr"
            href={pullRequest.url}
            target="_blank"
            rel="noreferrer"
            aria-label={`PR #${pullRequest.number} を GitHub で開く`}
          >
            #{pullRequest.number}
          </a>
        )}
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
        {/* ID の外に置く。中に入れると、hover できる端末で ID と一緒に隠れる。 */}
        <button
          type="button"
          class="hwc-pane-more"
          aria-label={`${pane.id} のメニュー`}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          aria-controls={MENU_ID}
          onClick={(event) => onOpenMenu(pane.id, event.currentTarget)}
        >
          <MoreIcon />
        </button>
      </div>
      <div class="hwc-output-wrap" ref={frame}>
        <div
          class="hwc-output-scroll"
          data-empty={empty}
          ref={scroller}
          onScroll={(event) => {
            if (confirmation !== null) return;
            const element = event.currentTarget;
            const now = {
              scrollTop: element.scrollTop,
              clientHeight: element.clientHeight,
              scrollHeight: element.scrollHeight,
            };
            const last = {
              scrollTop: now.scrollTop,
              clientHeight: lastClientHeight.current,
              scrollHeight: lastHeight.current,
            };
            lastHeight.current = now.scrollHeight;
            lastClientHeight.current = now.clientHeight;
            // 高さが変わっただけなら、底を詰めた副作用。読み返しの意思とはみなさない。
            // 縮んだ結果ブラウザが底へ寄せた場合に備え、追従の判断は今の位置で取り直す。
            if (isLayoutShift(now, last)) {
              if (pinned.current) element.scrollTop = element.scrollHeight;
              if (isNearBottom(now)) setPinned(true);
              return;
            }
            setPinned(isNearBottom(now));
          }}
        >
          {confirmation !== null ? (
            <PaneConfirmation
              key={confirmation.id}
              confirmation={confirmation}
              attempt={confirmationAttempts.get(confirmation.id) ?? null}
              onConfirm={() => onConfirmFolderTrust(confirmation.id)}
              onDismiss={() => onDismissConfirmation(confirmation.id)}
            />
          ) : body.kind === "skeleton" ? (
            <OutputSkeleton />
          ) : body.kind === "chat" ? (
            <>
              {body.snapshot.truncated ? (
                <p class="hwc-output-notice">古い会話は省略されています</p>
              ) : null}
              <ChatLog
                paneId={pane.id}
                snapshot={body.snapshot}
                replying={replying}
                compacting={compacting}
                copiedId={copiedId}
                expandable={!compact}
                compactionEcho={visibleCompactionEcho}
                compactionDurationMs={
                  compactionDuration !== null &&
                  compactionDuration.at === body.snapshot.compaction?.at
                    ? compactionDuration.ms
                    : null
                }
                onCopy={copy}
                onOpenImage={onOpenImage}
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
        {confirmation !== null ? null : (
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
        )}
        {readOnly || quoteAnchor === null ? null : (
          <button
            type="button"
            class="hwc-quote-action"
            aria-label="選択した箇所に返信"
            data-above={quoteAnchor.above}
            style={{ left: `${quoteAnchor.left}px`, top: `${quoteAnchor.top}px` }}
            // 押下で選択が折りたたまれると、ボタン自身が消えて click が届かない。
            onPointerDown={(event) => {
              event.preventDefault();
              startReply(quoteAnchor.text);
            }}
            onMouseDown={(event) => event.preventDefault()}
            // キーボードで選んだ選択でも押せるようにする。
            onClick={() => startReply(quoteAnchor.text)}
          >
            返信
          </button>
        )}
      </div>

      {body.kind === "chat" && (replying || compacting) ? (
        <LiveStatus
          phase={livePhase}
          thought={liveThought}
          elapsedMs={compacting ? compactionElapsedMs : waitingMs}
          compacting={compacting}
          stopping={stopping}
          showThought={!compact}
          onCancelCompaction={() => void cancelCompaction()}
        />
      ) : null}

      {notice === null ? null : (
        <p class="hwc-send-notice" role="status">
          <span class="hwc-send-notice-mark">
            <StatusMark tone="attention" size={12} />
          </span>
          {notice}
        </p>
      )}

      {readOnly ? (
        view === "terminal" ? (
          <p class="hwc-terminal-note" role="status">
            この画面は閲覧のみです。操作は Herdr のターミナルで行ってください。
          </p>
        ) : null
      ) : (
        <form
          class="hwc-input"
          data-expanded={expanded}
          data-shell={shell}
          data-drop={dropping}
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
          onDragEnter={(event) => {
            if (!pane.chat || fileTransfer(event.dataTransfer) === null) return;
            dragDepth.current += 1;
            setDropping(true);
          }}
          onDragOver={(event) => {
            const transfer = fileTransfer(event.dataTransfer);
            if (transfer === null) return;
            // 添付を受け付けないペインでもファイルを開かせない。ただし落とせる場所では
            // ないので、copy のカーソルは出さない。
            event.preventDefault();
            transfer.dropEffect = pane.chat ? "copy" : "none";
          }}
          onDragLeave={() => {
            if (dragDepth.current === 0) return;
            dragDepth.current -= 1;
            if (dragDepth.current === 0) setDropping(false);
          }}
          onDrop={(event) => {
            const transfer = fileTransfer(event.dataTransfer);
            if (transfer === null) return;
            // 画像以外のファイルもアップロードせず、ブラウザに開かせもしない。
            event.preventDefault();
            dragDepth.current = 0;
            setDropping(false);
            if (!pane.chat) return;
            takeImages(dropActionFrom(transfer.files));
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
            {reply === null ? null : (
              <div class="hwc-reply" role="group" aria-label="引用">
                <span class="hwc-reply-text" title={reply}>
                  {reply}
                </span>
                <button
                  type="button"
                  class="hwc-reply-clear"
                  aria-label="引用を外す"
                  onClick={clearReply}
                >
                  <CloseIcon size={14} />
                </button>
              </div>
            )}
            {attachments.length > 0 ? (
              <div class="hwc-commands" role="group" aria-label="添付画像">
                {attachments.map((item) => (
                  <span class="hwc-command hwc-attachment" data-chip="true" key={item.key}>
                    {item.name === null ? (
                      <span class="hwc-attachment-sending">送信中</span>
                    ) : (
                      <img
                        class="hwc-attachment-thumb"
                        src={attachmentUrl(pane.id, item.name)}
                        alt=""
                      />
                    )}
                    <button
                      type="button"
                      class="hwc-command-clear"
                      aria-label="添付を外す"
                      onClick={() => removeAttachment(item.key)}
                    >
                      <CloseIcon size={14} />
                    </button>
                  </span>
                ))}
              </div>
            ) : chip !== null ? (
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
            <span class="hwc-input-line">
              {shell ? (
                // 端末への入力であることを 1 文字で示す。文字なので大きさと色は行に従う。
                <span class="hwc-input-prompt" aria-hidden="true">
                  $
                </span>
              ) : null}
              <textarea
                id={`hwc-input-${pane.id}`}
                ref={input}
                class="hwc-input-field"
                // 2 行ぶんの高さを初期値にすると、1 行のとき文字の下だけ空いて上に寄る。
                // 高さは fit() が入力量に合わせて伸ばす。
                rows={1}
                value={draft}
                // 簡略時は placeholder を付けない。狭い入力欄で「メッセージを入力」が切れる。
                {...(compact ? {} : { placeholder })}
                onInput={(event) => {
                  setDraft(event.currentTarget.value);
                  setChip(chipOnInput(chip));
                }}
                onPaste={(event) => {
                  // シェルは改行を受け取れない。末尾の改行だけなら落として差し込み、
                  // 途中に改行が残るなら入力を変えずに断る。
                  if (shell) {
                    const raw = event.clipboardData?.getData("text/plain") ?? "";
                    if (!/[\r\n]/.test(raw)) return;
                    const text = raw.replace(/[\r\n]+$/, "");
                    event.preventDefault();
                    if (/[\r\n]/.test(text)) {
                      setNotice(SHELL_NEWLINE_NOTICE);
                      return;
                    }
                    const field = event.currentTarget;
                    field.setRangeText(text, field.selectionStart, field.selectionEnd, "end");
                    setDraft(field.value);
                    fit(field, expanded);
                    return;
                  }
                  // 添付を受け付けるのは会話を持つペインだけ。
                  if (!pane.chat) return;
                  const action = pasteActionFrom(event.clipboardData?.items);
                  // テキストだけの貼り付けは入力欄の既定動作のままにする。
                  if (action.kind === "default") return;
                  if (takeImages(action)) event.preventDefault();
                }}
                onKeyDown={(event) => {
                  const composing = event.isComposing || event.keyCode === 229;
                  if (event.key !== "Enter") return;
                  if (composing) return;
                  // シェルは改行を受け取れない。タッチ端末でも Enter で送る。
                  const newline =
                    event.shiftKey ||
                    (!shell && enterInsertsNewline((query) => window.matchMedia(query).matches));
                  if (newline) {
                    if (shell) event.preventDefault();
                    return;
                  }
                  event.preventDefault();
                  submit();
                }}
              />
            </span>
            <div class="hwc-input-actions">
              <span class="hwc-input-tail">
                {info === null && meter === null ? null : (
                  <span class="hwc-input-info">
                    <span class="hwc-input-agent" data-agent={agentGlyph(pane.agent)}>
                      <AgentGlyphIcon agent={pane.agent} size={14} />
                    </span>
                    {info === null ? null : <AgentInfoHint info={info} />}
                    {meter === null || snapshot?.context == null ? null : (
                      <ContextMeter
                        key={pane.id}
                        view={meter}
                        context={snapshot.context}
                        usage={snapshot.usage}
                      />
                    )}
                  </span>
                )}
                <button
                  type={stop && !busy ? "button" : "submit"}
                  class="hwc-send"
                  data-sending={sending}
                  data-stopping={stopping}
                  aria-label={stopping ? "停止中" : sending ? "送信中" : stop ? "停止" : "送信"}
                  disabled={busy || (!stop && !sendable)}
                  onClick={stop && !busy ? stopWorking : undefined}
                >
                  {busy ? <Spinner /> : stop ? <StopIcon /> : <SendIcon />}
                </button>
              </span>
            </div>
          </div>
        </form>
      )}
    </>
  );
}
