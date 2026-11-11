import { Fragment, createPortal, type ComponentChildren, type Ref } from "preact";
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
import { gitStatusLabel, type GitSync } from "../shared/git";
import { MAX_ATTACHMENTS } from "../shared/attachments";
import { messageFileLabel } from "../shared/message-files";
import { activityLabel, activitySnippet, formatTokPerSecond, usePaneActivity } from "./activity";
import { OUTPUT_LINES, attachmentUrl, chatFileUrl, uploadAttachment } from "./api";
import { attachmentStore, type AttachedImage } from "./attachment-store";
import { OutputText } from "./OutputText";
import { isLayoutShift, isNearBottom } from "./scroll";
import {
  ATTACHMENT_LIMIT_NOTICE,
  type AttachmentAction,
  dropActionFrom,
  pasteActionFrom,
  SEND_FAILED_NOTICE,
  SHELL_BUSY_NOTICE,
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
  chatRows,
  compactionInsertIndex,
  echoInsertIndex,
  idleEchoExpired,
  isPendingConfirmed,
  latestUserAt,
  newSessionPending,
  newSessionReset,
  newSessionSnapshot,
  type NewSessionReset,
  paneBody,
  type PendingMessage,
  PENDING_TURN_GRACE_MS,
  splitInlineImages,
  usePaneChat,
} from "./chat";
import { enterInsertsNewline } from "./input";
import {
  chipOnInput,
  type CommandId,
  commandAvailable,
  commandBlockReasonFor,
  commandCandidates,
  commandLabel,
  commandSendText,
  commandText,
  COMMAND_BLOCK_NOTES,
  compactAlreadyDone,
  COMPACTED_NOTICE,
  isCompactCommand,
  isCommandPane,
  isNewSessionCommand,
  type PaneOutputHandle,
} from "./commands";
import { ComposerAdd } from "./ComposerAdd";
import { useCopy } from "./copy";
import { readDraft, storage, writeDraft } from "./drafts";
import { useHint } from "./hint";
import { insertProjectPath } from "./projects";
import { NewSessionConfirm } from "./NewSessionConfirm";
import { ProjectDialog } from "./ProjectDialog";
import {
  AgentGlyphIcon,
  AgentIcon,
  ArrowDownIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  CloseIcon,
  CollapseIcon,
  CopyGlyph,
  ExpandIcon,
  EyeIcon,
  MoreIcon,
  PaneIcon,
  SendIcon,
  StatusMark,
  StopIcon,
  TerminalIcon,
} from "./icons";
import { GitCount } from "./GitCount";
import { Markdown } from "./Markdown";
import { MENU_ID } from "./Menu";
import { usePaneOutput } from "./output";
import { usePullRequest } from "./pull-request";
import { confirmationView, type ConfirmationAttempt } from "./confirmation";
import { PaneConfirmation } from "./PaneConfirmation";
import { appendQuote, canSend, canStop } from "./reply";
import {
  agentGlyph,
  isShellPane,
  paneName,
  pullRequestLabel,
  shortenPaneName,
  type PaneContext,
} from "./select";
import { SelectionToolbar, type SelectionToolbarState } from "./SelectionToolbar";
import { readSelectionAnchor } from "./selection-toolbar";
import { selectionCopyText } from "./selection-copy";
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

// スマホは選択メニューを差し替えられない。選択ツールバーはポインタを持つ画面だけに出す。
// 端末の性質は途中で変わらないので、最初の判定を使い回す。
let touchOnly: boolean | null = null;
function touchFirst(): boolean {
  touchOnly ??=
    window.matchMedia("(hover: none)").matches || window.matchMedia("(pointer: coarse)").matches;
  return touchOnly;
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

// エージェントが本文で示したファイル。画像はユーザーの添付と同じ見た目で拡大し、
// HTML はプレビューのタブで開く（ADR 0051）。
function MessageFiles(props: {
  paneId: string;
  files: ChatFile[];
  onOpen: (url: string, name: string) => void;
  onPreview: (file: ChatFile) => void;
}) {
  const images = props.files.filter((file) => file.kind === "image");
  const pages = props.files.filter((file) => file.kind === "html");
  return (
    <>
      {images.length === 0 ? null : (
        <div class="hwc-msg-attachments">
          {images.map((file) => {
            const url = chatFileUrl(props.paneId, file);
            const label = messageFileLabel(file.name);
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
      )}
      {pages.length === 0 ? null : (
        <div class="hwc-msg-pages">
          {pages.map((file) => (
            <button
              type="button"
              class="hwc-msg-page"
              key={`${file.name}@${file.version}`}
              title={file.name}
              onClick={() => props.onPreview(file)}
            >
              <EyeIcon size={16} />
              <span class="hwc-msg-page-name">{messageFileLabel(file.name)}</span>
              <span class="hwc-msg-page-kind">HTML</span>
            </button>
          ))}
        </div>
      )}
    </>
  );
}

// 画像記法の位置に描いた画像は、末尾の一覧から外す。裸パスだけの画像と HTML は
// 本文に位置が無いので、今までどおりメッセージの後ろに並べる。
function AgentMessage(props: {
  paneId: string;
  message: ChatMessage;
  taskScope: string;
  copyButton: ComponentChildren;
  onOpenImage: (url: string, name: string) => void;
  onOpenPreview: (file: ChatFile) => void;
}) {
  const { images, rest } = splitInlineImages(props.paneId, props.message.text, props.message.files);
  return (
    <>
      <Markdown
        text={props.message.text}
        taskScope={props.taskScope}
        images={images}
        onOpenImage={props.onOpenImage}
      />
      {rest.length === 0 ? null : (
        <MessageFiles
          paneId={props.paneId}
          files={rest}
          onOpen={props.onOpenImage}
          onPreview={props.onOpenPreview}
        />
      )}
      <div class="hwc-msg-meta">
        <span class="hwc-msg-time">{formatClock(props.message.at)}</span>
        {props.copyButton}
      </div>
    </>
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

  return (
    <>
      <div class="hwc-msg-bubble">
        {props.message.text === "" ? null : (
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
              <ChevronRightIcon size={16} />
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
          <ChevronRightIcon size={16} />
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
  onOpenPreview: (file: ChatFile) => void;
  pending: readonly PendingMessage[];
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
      {rows.map((row, index) => (
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
                  message={row.message}
                  taskScope={`${index + 1}番目のメッセージ`}
                  copyButton={copyButton(row.message)}
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
      ))}
      {echoIndex === rows.length ? echoRow : null}
      {compactionIndex === rows.length ? compactionBlock : null}
    </ol>
  );
}

// ターンが終わったとき、会話へ高さを返すのは即時、中身だけを短く薄く消す。高さを
// アニメーションするとスクロール領域のリフローが毎フレーム走るため、高さは待たない。
// この値で DOM を外す。app.css の closing の transition と同じ長さに揃える。
const LIVE_EXIT_MS = 120;

type LiveView = {
  phase: string | null;
  thought: string;
  elapsedMs: number | null;
  compacting: boolean;
  stopping: boolean;
  // 低いセルでは会話の高さを優先する。thinking の枠を出さず、段階と経過だけにする。
  // 出すときは thinking が無い間も 2 行分を空けたままにする。段階の切り替わりで
  // 高さが変わると、上に載る会話の見える範囲が動くため。
  showThought: boolean;
  // 生成中だけ入る。低いセルでは親が null にする。
  tokPerSecond: number | null;
};

// 実行中の段階と thinking の末尾。会話の外（入力欄の直上）に固定して出し、
// 読み返している間も何が起きているかを見せる。入力欄の上なので、高さが変わっても
// 入力欄の位置は動かない。
function LiveStatus(props: LiveView & { open: boolean; onCancelCompaction: () => void }) {
  const latest = useRef<LiveView | null>(null);
  const wasOpen = useRef(false);
  const [fading, setFading] = useState(false);

  const view: LiveView = {
    phase: props.phase,
    thought: props.thought,
    elapsedMs: props.elapsedMs,
    compacting: props.compacting,
    stopping: props.stopping,
    showThought: props.showThought,
    tokPerSecond: props.tokPerSecond,
  };
  // 消える間は、閉じる直前の内容をそのまま薄くする。閉じた瞬間に親の値が
  // null へ戻るため、そのまま描くと空の帯が一瞬光って見える。
  if (props.open) latest.current = view;
  const shown = props.open ? view : latest.current;
  // 閉じた最初の描画も closing として置く。effect を待つと 1 フレームだけ消える。
  const closingNow = wasOpen.current && !props.open;
  wasOpen.current = props.open;

  useEffect(() => {
    if (props.open) {
      setFading(false);
      return;
    }
    if (latest.current === null) return;
    setFading(true);
    const timer = window.setTimeout(() => setFading(false), LIVE_EXIT_MS);
    return () => window.clearTimeout(timer);
  }, [props.open]);

  if (shown === null || (!props.open && !closingNow && !fading)) return null;

  const tok = shown.tokPerSecond === null ? null : formatTokPerSecond(shown.tokPerSecond);
  return (
    <div class="hwc-live-slot" data-state={props.open ? "open" : "closing"}>
      {/* pi 以外や sidecar の無いペインでは、中身が経過時間だけになる。状態名を
          支援技術へも渡すため、名前は帯に持たせる。消える間は操作も読み上げも止める。 */}
      <div
        class="hwc-live"
        role="group"
        aria-label={shown.compacting ? "会話を圧縮しています" : "返答を待っています"}
        aria-hidden={!props.open}
      >
        <div class="hwc-live-head">
          <span class="hwc-typing">
            <span />
            <span />
            <span />
          </span>
          {shown.phase === null ? null : <span class="hwc-live-phase">{shown.phase}</span>}
          {shown.compacting ? (
            <span class="hwc-compaction-pending">会話を圧縮しています</span>
          ) : null}
          <span class="hwc-live-tail">
            {shown.compacting ? (
              <button
                type="button"
                class="hwc-compaction-cancel"
                disabled={shown.stopping}
                tabIndex={props.open ? undefined : -1}
                onClick={props.onCancelCompaction}
              >
                {shown.stopping ? "中断中" : "中断"}
              </button>
            ) : null}
            {tok === null ? null : <span class="hwc-live-tok">{tok} tok/s</span>}
            {shown.elapsedMs === null ? null : (
              <span class="hwc-live-elapsed">{formatElapsed(shown.elapsedMs)}</span>
            )}
          </span>
        </div>
        {shown.showThought ? (
          <div class="hwc-live-thought">
            {shown.thought === "" ? null : <p class="hwc-live-thought-text">{shown.thought}</p>}
          </div>
        ) : null}
      </div>
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
  // 端末出力の ANSI 色を補正する基準。テーマの解決結果を App から受け取る。
  scheme: "light" | "dark";
  // 分割セルが並ぶときだけ、セルの名前を出す。チップと同じ文字列の繰り返しを避ける。
  labeled: boolean;
  // 複数スペースのペインが並ぶときだけ、見出しにスペース名を添える（ADR 0019）。
  showSpace: boolean;
  // スペースのブランチ。分割セルでも PR のチップを引くために渡す。
  // 文字として出すかは showBranch と labeled が決める。
  branch: string | null;
  // 一覧が隠れる狭い画面でだけ、ブランチを名前に代えて出す。
  showBranch: boolean;
  // 1 枚表示のときだけ渡す。分割セルは同じ上流の差が並ぶので出さない。
  sync: GitSync | null;
  workspaceMenuOpen: boolean;
  waitingMs: number | null;
  // シェルの前景プロセスが動いているか。停止ボタンの出し分けにだけ使う。
  running: boolean;
  sending: boolean;
  // 作ったばかりで、まだエージェントが端末を引き継いでいない。入力欄を閉じる。
  starting: boolean;
  dismissedConfirmation: string | null;
  confirmationAttempts: ReadonlyMap<string, ConfirmationAttempt>;
  onConfirmFolderTrust: (id: string) => void;
  onDismissConfirmation: (id: string) => void;
  // メニューはセルの外（App 直下）に 1 つだけ出す。クリア後の読み直しだけ、
  // この詳細の実行口を一覧から使う。
  menuOpen: boolean;
  outputRef: Ref<PaneOutputHandle>;
  onOpenMenu: (paneId: string, trigger: HTMLElement) => void;
  onOpenWorkspaceMenu: (workspaceId: string, trigger: HTMLElement) => void;
  onSubmit: (text: string, attachments: string[]) => Promise<boolean>;
  onStop: () => Promise<boolean>;
  // シェルのペインでエージェントを起動する。ダイアログは App 直下に 1 つだけ出す。
  onStartAgent: () => void;
  // ダイアログは App 直下に 1 つだけ出す。セルの中に置くと containment の内側に閉じる。
  onOpenImage: (url: string, name: string) => void;
  // HTML のプレビューは、タブの 1 つとして会話の外に出す。
  onOpenPreview: (file: ChatFile) => void;
};

// ペインごとの添付を購読する。ペインが変わったら、その時点の一覧へ差し替える。
function useAttachments(paneId: string): readonly AttachedImage[] {
  const [items, setItems] = useState(() => attachmentStore.items(paneId));
  useEffect(() => {
    const update = () => setItems(attachmentStore.items(paneId));
    // 購読の前に完了した分を取りこぼさないよう、購読してから読み直す。
    const unsubscribe = attachmentStore.subscribe(paneId, update);
    update();
    return unsubscribe;
  }, [paneId]);
  return items;
}

export function PaneDetail(props: PaneDetailProps) {
  const {
    pane,
    context,
    compact,
    scheme,
    labeled,
    showSpace,
    branch,
    showBranch,
    sync,
    workspaceMenuOpen,
    waitingMs,
    running,
    sending,
    starting,
    dismissedConfirmation,
    confirmationAttempts,
    onConfirmFolderTrust,
    onDismissConfirmation,
    menuOpen,
    onOpenMenu,
    onOpenWorkspaceMenu,
    onSubmit,
    onStop,
    onOpenImage,
    onOpenPreview,
  } = props;
  const repoUrl = sync?.repoUrl ?? null;
  const shownPaneName = shortenPaneName(
    paneName(pane),
    context.workspaceLabel,
    context.workspaceName,
  );
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
  // メニューからの /new だけ、送る前に確認する。
  const [confirmNew, setConfirmNew] = useState(false);
  const attachments = useAttachments(pane.id);
  // プロジェクトのダイアログは閉じるアニメーションの間も残す。caret は選んだ直後に
  // 入力欄へ戻す位置で、閉じただけ（キャンセル）のときは null のまま。
  const [projectDialog, setProjectDialog] = useState<{
    open: boolean;
    caret: number | null;
  } | null>(null);
  // ファイルをドラッグしている間だけ composer を光らせる。dragenter / dragleave は
  // 子要素をまたぐたびに入れ替わるので、深さを数えて枠から出たときだけ消す。
  const [dropping, setDropping] = useState(false);
  const dragDepth = useRef(0);
  // 選択ツールバーは閉じたあとも短い遷移の間だけ state に残す。dismissed は Esc や
  // 外側の押下で閉じたあと、選択が変わるまで出し直さないための印。
  const [selectionToolbar, setSelectionToolbar] = useState<SelectionToolbarState | null>(null);
  const dismissed = useRef(false);

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
  } = usePaneChat(pane.id, pane.chat, pane.chat && !blocked, pane.agentStatus);
  // 実行中の段階は pi 拡張の sidecar からだけ取る（ADR 0035）。
  const activity = usePaneActivity(
    pane.id,
    pane.agent === "pi" && pane.chat && !blocked,
    pane.agentStatus,
  );
  // 分割セルも含め、見出しごとに引く。同じスペースのセルは同じ PR になる。
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
  // 引用を足した直後、再描画後の入力欄へカーソルを移す位置。
  const pendingCaret = useRef<number | null>(null);
  // 選択ツールバーを出している間は自動追従を止める。購読を張り直さずに読むため ref に写す。
  const quoting = useRef(false);
  quoting.current = selectionToolbar !== null;

  // 添付を持っている間は候補を出さない。候補を選ぶと本文が消えるので、貼った画像と
  // 書きかけの指示が別々のメッセージに分かれてしまう。引用は下書きの一部なので、
  // 本文の先頭が `/` でなければ候補は出ない。空の会話と圧縮済みは commandAvailable が見る。
  const compactDone = snapshot !== null && compactAlreadyDone(snapshot);
  const candidates =
    attachments.length === 0 && compactionRun === null
      ? commandCandidates(pane, draft, snapshot)
      : [];
  const uploading = attachments.some((item) => item.name === null);
  const sendable = canSend({
    uploading,
    chip,
    replying,
    draft,
    attachments: attachments.length,
  });
  // 停止は入力が空のときだけ出す。文字・添付・引用があれば、送信は実行中への追加指示になる。
  const stop = canStop({
    replying,
    agent: pane.agent,
    running,
    draft,
    attachments: attachments.length,
    chip,
  });
  const busy = sending || stopping;
  const shell = isShellPane(pane);
  const placeholder =
    chip === "compact" ? "圧縮の指示（任意）" : shell ? "コマンドを入力" : "メッセージを入力";

  const { copiedId, copy } = useCopy();
  const copied = copiedId === "pane";
  const copyId = () => copy("pane", pane.id);

  // 前景でコマンドが動いていると Herdr は起動を受け付けない。先に止めてもらう。
  const startAgent = () => {
    if (running) {
      setNotice(SHELL_BUSY_NOTICE);
      return;
    }
    props.onStartAgent();
  };

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

  // 選択ツールバーは、選択の始まりと終わりがスクロール領域の中にあるときだけ出す。
  // マウスのドラッグ中は selectionchange が動くたびに発火するので評価せず、ボタンを
  // 離した pointerup で確定した選択を見る。キーボードの選択変更はそのまま拾う。
  // スクロール・リサイズでは位置を追い、選択が領域の外へ出たら閉じる。
  useEffect(() => {
    const scrollerElement = scroller.current;
    const frameElement = frame.current;
    if (scrollerElement === null || frameElement === null) return;
    if (touchFirst()) {
      setSelectionToolbar(null);
      return;
    }

    dismissed.current = false;
    setSelectionToolbar(null);
    let dragging = false;
    let frameRequest = 0;

    const close = () => {
      setSelectionToolbar((current) => (current === null ? null : { ...current, open: false }));
    };
    const refresh = () => {
      if (dragging || dismissed.current) return;
      const anchor = readSelectionAnchor(scrollerElement, frameElement);
      if (anchor === null) close();
      else setSelectionToolbar({ anchor, open: true });
    };
    const scheduleRefresh = () => {
      if (frameRequest !== 0) return;
      frameRequest = requestAnimationFrame(() => {
        frameRequest = 0;
        refresh();
      });
    };
    const onSelectionChange = () => {
      dismissed.current = false;
      refresh();
    };
    const onPointerDown = (event: PointerEvent) => {
      if (event.pointerType !== "mouse" || event.button !== 0) return;
      const target = event.target;
      if (target instanceof Element && target.closest("[data-selection-toolbar]") !== null) {
        return;
      }
      dragging = true;
      dismissed.current = true;
      close();
    };
    const stopDragging = () => {
      if (!dragging) return;
      dragging = false;
      refresh();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      dismissed.current = true;
      close();
    };

    document.addEventListener("selectionchange", onSelectionChange);
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("pointerup", stopDragging);
    document.addEventListener("pointercancel", stopDragging);
    document.addEventListener("keydown", onKeyDown);
    // 窓の外で離すと pointerup が来ない。次のキーボード選択までドラッグ中のままにしない。
    window.addEventListener("blur", stopDragging);
    scrollerElement.addEventListener("scroll", scheduleRefresh);
    window.addEventListener("resize", scheduleRefresh);
    return () => {
      if (frameRequest !== 0) cancelAnimationFrame(frameRequest);
      document.removeEventListener("selectionchange", onSelectionChange);
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("pointerup", stopDragging);
      document.removeEventListener("pointercancel", stopDragging);
      document.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("blur", stopDragging);
      scrollerElement.removeEventListener("scroll", scheduleRefresh);
      window.removeEventListener("resize", scheduleRefresh);
    };
  }, [pane.id]);

  // 送信で空にしたときも、高さを初期状態へ戻す。分割枚数が変わって簡略が切り替わったときも、
  // 前の inline height を残さない。
  // 描画の後に高さを直すと、改行した 1 フレームだけ箱が低いままになり、
  // スクロールバーが一瞬出る。描画の前に合わせる。
  useLayoutEffect(() => {
    fit(input.current, expanded);
  }, [draft, expanded, compact, readOnly]);

  // 引用を足したあと、再描画された入力欄の末尾（引用の後の空行）へカーソルを移す。
  useLayoutEffect(() => {
    const caret = pendingCaret.current;
    if (caret === null) return;
    pendingCaret.current = null;
    const field = input.current;
    if (field === null) return;
    field.focus();
    field.setSelectionRange(caret, caret);
    fit(field, expanded);
  }, [draft, expanded]);

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

  // 送信したのにエージェントが動き出さない echo は、TUI がコマンドとして処理したか、
  // 入力を受け取らなかったものとして、ローカルのコマンド控えに切り替える。コマンドは
  // user 発話を残さないため、セッションを待っても確定しない。
  useEffect(() => {
    const idle = pending.filter((item) => !item.waiting && !item.command);
    if (idle.length === 0 || replying) return;
    const oldest = Math.min(...idle.map((item) => item.at));
    const delay = Math.max(0, oldest + PENDING_TURN_GRACE_MS - Date.now());
    const timer = setTimeout(() => {
      const now = Date.now();
      setPending((items) => {
        let changed = false;
        const next = items.map((item) => {
          if (item.command || !idleEchoExpired(item, now)) return item;
          changed = true;
          return { ...item, command: true };
        });
        return changed ? next : items;
      });
    }, delay);
    return () => clearTimeout(timer);
  }, [pending, replying]);

  useEffect(() => {
    const idle = pending.filter((item) => !item.waiting && !item.command);
    if (idle.length === 0) return;
    const oldest = Math.min(...idle.map((item) => item.at));
    const delay = Math.max(0, oldest + PENDING_TIMEOUT_MS - Date.now());
    const timer = setTimeout(() => {
      const now = Date.now();
      setPending((items) =>
        items.filter((item) => item.command || item.waiting || item.at + PENDING_TIMEOUT_MS > now),
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

  // 選択を引用として下書きの末尾へ足す。compact のチップは外すが、指示の下書きは残す
  // （引用に続く本文として送り、/compact には戻さない。ADR 0016 / 0062）。
  const quoteSelection = () => {
    // 送信中に足すと、成功時のクリアで新しい引用まで消える。送っている間は受け付けない。
    if (sending) return;
    const text = selectionToolbar?.anchor.text ?? "";
    if (text === "") return;
    const next = appendQuote(draft, text);
    setDraft(next.text);
    setChip(null);
    pendingCaret.current = next.caret;
    dismissed.current = true;
    document.getSelection()?.removeAllRanges();
    setSelectionToolbar((current) => (current === null ? null : { ...current, open: false }));
  };

  const openProjects = () => setProjectDialog({ open: true, caret: null });

  const closeProjects = () =>
    setProjectDialog((current) => (current === null ? null : { ...current, open: false }));

  // 選んだプロジェクトは本文のカーソル位置へ入れる。チップは文字を打ったときと同じ規則で、
  // new は解除し、compact の指示は残す。
  const pickProject = (path: string) => {
    const field = input.current;
    const start = field?.selectionStart ?? draft.length;
    const end = field?.selectionEnd ?? start;
    const next = insertProjectPath(draft, start, end, path);
    setDraft(next.text);
    setChip(chipOnInput(chip));
    setProjectDialog({ open: false, caret: next.caret });
  };

  // キャンセル時は DialogShell が開く前の要素（+ ボタン）へ戻す。選んだときだけ、
  // 閉じるアニメーションの後に本文へフォーカスを移す。
  const projectsExited = () => {
    const caret = projectDialog?.caret ?? null;
    setProjectDialog(null);
    if (caret === null) return;
    const field = input.current;
    if (field === null) return;
    field.focus();
    field.setSelectionRange(caret, caret);
    fit(field, expanded);
  };

  // 外した添付は送らない。進行中のアップロードも止める。保存先のファイルは消さない。
  const removeAttachment = (key: string) => attachmentStore.remove(pane.id, key);

  // ペインを切り替えても止めない。送り先が消えたときだけ App が中断する。
  const uploadImage = async (file: File) => {
    const { key, controller } = attachmentStore.begin(pane.id);

    const result = await uploadAttachment(pane.id, file, controller.signal);
    if (result.ok) {
      attachmentStore.settle(pane.id, key, result.name);
      return;
    }
    // 外された添付は一覧から既に消えている。その失敗は知らせない。
    if (controller.signal.aborted) return;
    attachmentStore.remove(pane.id, key);
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
    const text = draft;
    // 添付があると BFF が注記を後ろに付けるので、pi では /compact でもコマンドにならない。
    const compactCommand = attachments.length === 0 && isCompactCommand(text);
    const newCommand = startsNewSession(text, names);
    if (compactCommand && compactDone) {
      setNotice(COMPACTED_NOTICE);
      return;
    }
    const baselineAt = snapshot?.compaction?.at ?? null;
    const from = latestUserAt(snapshot?.messages ?? []);
    const waiting = replying;
    const after = snapshot?.messages.length ?? 0;
    // 送信したらキーボードを閉じて出力を見せる。
    input.current?.blur();
    // 前の失敗は消す。送り直したのに前の notice が残っていると、いつの結果か読めない。
    setNotice(null);
    // 送れたときだけ空にする。失敗したら本文も添付も残す。
    if (await submitInput(text, names)) {
      // 猶予は送信が通った時点から測る。POST が遅いときに、届く前の echo を畳まない。
      const at = Date.now();
      // 送れたときだけ最新へ戻す。失敗したら読み返していた位置を保つ。
      setPinned(true);
      // 250ms の debounce を待たずに消す。先にペインを切り替えると古い値が戻る。
      writeDraft(storage(), pane.id, "");
      setDraft("");
      attachmentStore.clear(pane.id);
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
            after,
            command: false,
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

  // メニューからはコマンド文字列だけを送る。書きかけの draft・添付は次の
  // メッセージのために残す（チップのように draft を指示には使わない）。
  const menuCommandAvailable = (id: CommandId): boolean =>
    !readOnly && !sending && compactionRun === null && commandAvailable(id, pane, snapshot);

  const runMenuCommand = async (id: CommandId) => {
    if (!menuCommandAvailable(id)) return;
    const text = commandText(id);
    const baselineAt = snapshot?.compaction?.at ?? null;
    input.current?.blur();
    setNotice(null);
    if (await submitInput(text, [])) {
      setPinned(true);
      setChip(null);
      if (id === "compact") markCompaction(baselineAt, text);
    } else setNotice(SEND_FAILED_NOTICE);
  };

  const menuCommandHint = (id: CommandId): string => {
    if (sending) return "送信中は使えません";
    if (compactionRun !== null) return "圧縮中は使えません";
    if (pane.agentStatus === "working") return "実行中は使えません";
    const reason = commandBlockReasonFor(id, snapshot);
    if (reason !== null) return COMMAND_BLOCK_NOTES[reason];
    return id === "new" ? "このペインで会話を始め直す" : "履歴を要約して縮める";
  };

  const composerCommands = isCommandPane(pane)
    ? {
        newSession: {
          label: commandLabel("new"),
          available: menuCommandAvailable("new"),
          hint: menuCommandHint("new"),
          run: () => {
            if (menuCommandAvailable("new")) setConfirmNew(true);
          },
        },
        compact: {
          label: commandLabel("compact"),
          available: menuCommandAvailable("compact"),
          hint: menuCommandHint("compact"),
          run: () => void runMenuCommand("compact"),
        },
      }
    : null;

  useImperativeHandle(props.outputRef, () => ({
    refreshOutput: () => {
      setPinned(true);
      setOutputVersion((version) => version + 1);
    },
  }));

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
  // 低いセルは ADR 0035 のとおり段階と経過時間だけにする。速度は通常セルでだけ出す。
  const liveTokPerSecond =
    compacting || compact || activity === null ? null : activity.tokPerSecond;

  return (
    <>
      <div class="hwc-pane-head" data-bare={!labeled}>
        <span class="hwc-pane-head-icon" data-agent={agentGlyph(pane.agent)}>
          {pane.agent ? <AgentGlyphIcon agent={pane.agent} size={14} /> : <PaneIcon size={14} />}
        </span>
        {labeled ? (
          <span class="hwc-pane-head-name">{shownPaneName}</span>
        ) : showBranch ? (
          branch === null ? null : (
            <button
              type="button"
              class="hwc-pane-head-branch-menu"
              aria-label={`${branch} のスペースメニュー${sync === null ? "" : `、${gitStatusLabel(sync)}`}`}
              aria-haspopup="menu"
              aria-expanded={workspaceMenuOpen}
              aria-controls={MENU_ID}
              data-open={workspaceMenuOpen}
              onClick={(event) => onOpenWorkspaceMenu(context.workspaceId, event.currentTarget)}
            >
              <span class="hwc-pane-head-branch" title={branch}>
                {branch}
              </span>
              <GitCount sync={sync} />
              <span class="hwc-chevron-down">
                <ChevronDownIcon size={12} />
              </span>
            </button>
          )
        ) : context.repoName === null ? null : repoUrl === null ? (
          <span class="hwc-pane-head-repo" title={context.repoName}>
            {context.repoName}
          </span>
        ) : (
          <a
            class="hwc-pane-head-repo"
            href={repoUrl}
            target="_blank"
            rel="noreferrer"
            aria-label={`${context.repoName} を GitHub で開く`}
            title={context.repoName}
          >
            {context.repoName}
          </a>
        )}
        {labeled && showSpace && shownPaneName !== context.workspaceName ? (
          <span
            class="hwc-pane-head-space"
            title={`${context.workspaceLabel} / ${context.tabLabel}`}
          >
            {context.workspaceName}
          </span>
        ) : null}
        {labeled || showBranch ? null : <GitCount sync={sync} />}
        {pullRequest === null || pullRequest.state !== "OPEN" ? null : (
          <a
            class="hwc-pane-head-pr"
            href={pullRequest.url}
            target="_blank"
            rel="noreferrer"
            aria-label={pullRequestLabel(pullRequest)}
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
                onOpenPreview={onOpenPreview}
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
                <pre class="hwc-output">
                  <OutputText text={output} scheme={scheme} />
                </pre>
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
        <SelectionToolbar
          state={selectionToolbar}
          canQuote={!readOnly && !starting && pane.chat}
          onQuote={quoteSelection}
          onCopy={() => {
            const selection = document.getSelection();
            const element = scroller.current;
            if (selection === null || selection.rangeCount === 0 || element === null) return "";
            return selectionCopyText(element, selection.getRangeAt(0));
          }}
          onExited={() => setSelectionToolbar(null)}
        />
      </div>

      {body.kind === "chat" ? (
        <LiveStatus
          open={replying || compacting}
          phase={livePhase}
          thought={liveThought}
          elapsedMs={compacting ? compactionElapsedMs : waitingMs}
          compacting={compacting}
          stopping={stopping}
          showThought={!compact && activity !== null}
          tokPerSecond={liveTokPerSecond}
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
      ) : starting ? (
        // 起動が終わるまで入力欄を出さない。相手がまだシェルだと、書いた文字が
        // そのまま端末へ届く。Spinner はこの行に 1 つだけ置く。
        <p class="hwc-starting" role="status">
          <span class="hwc-starting-mark">
            <Spinner size={14} />
          </span>
          エージェントを起動しています。準備ができるまでメッセージは送れません。
        </p>
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
            {attachments.length > 0 ? (
              <div class="hwc-commands" role="group" aria-label="添付画像">
                {attachments.map((item) => {
                  const name = item.name;
                  return (
                    <span class="hwc-command hwc-attachment" data-chip="true" key={item.key}>
                      {name === null ? (
                        <span class="hwc-attachment-sending">送信中</span>
                      ) : (
                        <button
                          type="button"
                          class="hwc-attachment-open"
                          aria-label="添付画像を拡大"
                          aria-haspopup="dialog"
                          onClick={() => onOpenImage(attachmentUrl(pane.id, name), name)}
                        >
                          <img
                            class="hwc-attachment-thumb"
                            src={attachmentUrl(pane.id, name)}
                            alt=""
                          />
                        </button>
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
                  );
                })}
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
              {compact ? null : pane.chat ? (
                <ComposerAdd
                  full={attachments.length >= MAX_ATTACHMENTS}
                  commands={composerCommands}
                  onFiles={(files) => takeImages(dropActionFrom(files))}
                  onProjects={openProjects}
                />
              ) : (
                // シェルのペインは、会話ペインの + と同じ位置にエージェントの入口を置く。
                <button type="button" class="hwc-agent-start" onClick={startAgent}>
                  <AgentIcon size={16} />
                  エージェントを起動
                </button>
              )}
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
      {projectDialog === null ? null : (
        <ProjectDialog
          paneId={pane.id}
          open={projectDialog.open}
          onClose={closeProjects}
          onExited={projectsExited}
          onPick={pickProject}
        />
      )}
      {confirmNew
        ? createPortal(
            <NewSessionConfirm
              paneId={pane.id}
              available={menuCommandAvailable("new")}
              onConfirm={() => {
                setConfirmNew(false);
                void runMenuCommand("new");
              }}
              onCancel={() => setConfirmNew(false)}
            />,
            document.querySelector(".hwc-app") ?? document.body,
          )
        : null}
    </>
  );
}
