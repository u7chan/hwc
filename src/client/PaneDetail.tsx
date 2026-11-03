import type { ComponentChildren } from "preact";
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import type { ChatCompaction, ChatMessage, ChatSnapshot } from "../server/chat/contract";
import type { PaneState } from "../server/herdr/state";
import { MAX_ATTACHMENTS } from "../shared/attachments";
import { OUTPUT_LINES, attachmentUrl, uploadAttachment } from "./api";
import { isLayoutShift, isNearBottom } from "./scroll";
import {
  ATTACHMENT_LIMIT_NOTICE,
  pasteActionFrom,
  SEND_FAILED_NOTICE,
  SHELL_NEWLINE_NOTICE,
  unsupportedImageNotice,
  uploadFailureNotice,
} from "./attachments";
import {
  agentInfo,
  agentInfoLabel,
  compactionLabel,
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

// 添付の配信 URL は新しいタブで開く。ライトボックスを持たないので、拡大はブラウザに任せる。
function MessageAttachments(props: { paneId: string; names: string[] }) {
  return (
    <div class="hwc-msg-attachments">
      {props.names.map((name) => {
        const url = attachmentUrl(props.paneId, name);
        return (
          <a class="hwc-msg-attachment" key={name} href={url} target="_blank" rel="noreferrer">
            <img class="hwc-msg-attachment-image" src={url} alt="添付画像" loading="lazy" />
          </a>
        );
      })}
    </div>
  );
}

function UserMessage(props: {
  paneId: string;
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
              <ArrowDownIcon size={12} />
            </span>
          </button>
        ) : null}
        {props.message.attachments === undefined ? null : (
          <MessageAttachments paneId={props.paneId} names={props.message.attachments} />
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
function Compaction(props: { compaction: ChatCompaction; expandable: boolean }) {
  const label = compactionLabel(props.compaction);
  if (!props.expandable || props.compaction.summary === "") {
    return (
      <p class="hwc-compaction">
        <CompactionRule />
        <span class="hwc-compaction-label">{label}</span>
        <CompactionRule />
      </p>
    );
  }

  return (
    <details class="hwc-compaction">
      <summary class="hwc-compaction-head">
        <CompactionRule />
        <span class="hwc-compaction-label">{label}</span>
        <span class="hwc-compaction-icon">
          <ArrowDownIcon size={12} />
        </span>
        <CompactionRule />
      </summary>
      <div class="hwc-compaction-body">{props.compaction.summary}</div>
    </details>
  );
}

// 会話として読むための並び。ユーザーは右、エージェントは左。
// どのエージェントかは入力欄の側に出しているので、ここでは繰り返さない。
function ChatLog(props: {
  paneId: string;
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
  // 画像だけのメッセージは本文が無い。空文字をコピーさせない。
  const userCopyButton = (message: ChatMessage) =>
    message.text === "" ? null : copyButton(message);

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
            <UserMessage
              paneId={props.paneId}
              message={message}
              copyButton={userCopyButton(message)}
              pending={pending}
            />
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
  onSubmit: (text: string, attachments: string[]) => Promise<boolean>;
};

// 名前はアップロードが終わるまで無い。controller は取り外しと離脱で送信を止めるために持つ。
type AttachedImage = {
  key: string;
  name: string | null;
  controller: AbortController;
};

export function PaneDetail(props: PaneDetailProps) {
  const { pane, context, compact, waitingMs, onSubmit } = props;
  // 下書きはペインごとに残す。書きかけのまま一覧へ戻っても消えない。
  const [draft, setDraft] = useState(() => readDraft(storage(), pane.id));
  const [expandedOpen, setExpandedOpen] = useState(false);
  const [sending, setSending] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [atBottom, setAtBottom] = useState(true);
  // 追従するかは state が正。イベント購読からも読むので、同じ値を ref に写す
  // （chat.ts の statusRef と同じ扱い）。更新は setPinned の 1 経路だけ。
  const pinned = useRef(true);
  // 高さが変わっただけのスクロール（入力欄や添付が伸縮して底が詰まる）は利用者の操作ではない。
  // 直前の content 高・表示領域の高さと比べて、変わっていれば追従の判断を変えない。
  const lastHeight = useRef(0);
  const lastClientHeight = useRef(0);
  const [pending, setPending] = useState<PendingMessage[]>([]);
  // チップは id だけを持つ。表示名と送信文字列は定数から引く。
  const [chip, setChip] = useState<CommandId | null>(null);
  const [attachments, setAttachments] = useState<AttachedImage[]>([]);
  const nextAttachmentKey = useRef(0);

  const setPinned = (next: boolean) => {
    pinned.current = next;
    setAtBottom(next);
  };

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

  // 添付を持っている間は候補を出さない。候補を選ぶと本文が消えるので、貼った画像と
  // 書きかけの指示が別々のメッセージに分かれてしまう。
  const candidates =
    attachments.length === 0 ? commandCandidates(pane, draft, snapshot?.context ?? null) : [];
  const uploading = attachments.some((item) => item.name === null);
  const canSend = uploading
    ? false
    : chip === null
      ? draft.trim() !== "" || attachments.length > 0
      : !replying;
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
  // 描画の後に高さを直すと、改行した 1 フレームだけ箱が低いままになり、
  // スクロールバーが一瞬出る。描画の前に合わせる。
  useLayoutEffect(() => {
    fit(input.current, expanded);
  }, [draft, expanded, compact]);

  // 最新が見えている間だけ追従する。読み返しているときは勝手に動かさない。
  // 失敗の notice はメッセージ領域を縮めるので、出たときも追従し直す。
  useEffect(() => {
    const element = scroller.current;
    if (element && atBottom) element.scrollTop = element.scrollHeight;
  }, [content, replying, atBottom, pendingMessages.length, notice]);

  // 画像の読み込みや入力欄の伸びで高さが後から変わっても、最新を見ている間は底に留める。
  // 画像の load は bubble しないので capture で拾い、領域の伸縮は ResizeObserver で拾う。
  useEffect(() => {
    const element = scroller.current;
    if (!element) return;
    const keep = () => {
      lastHeight.current = element.scrollHeight;
      lastClientHeight.current = element.clientHeight;
      if (!pinned.current) return;
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
  }, []);

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

  // ペインを離れたら、終わっていないアップロードを止める。送り先が消えている。
  const attached = useRef(attachments);
  attached.current = attachments;
  useEffect(
    () => () => {
      for (const item of attached.current) item.controller.abort();
    },
    [],
  );

  const sendText = async () => {
    if (!canSend || sending) return;
    const text = draft;
    const names = attachments
      .map((item) => item.name)
      .filter((name): name is string => name !== null);
    const at = Date.now();
    const from = latestUserAt(snapshot?.messages ?? []);
    const waiting = replying;
    setSending(true);
    // 送信したらキーボードを閉じて出力を見せる。
    input.current?.blur();
    // 前の失敗は消す。送り直したのに前の notice が残っていると、いつの結果か読めない。
    setNotice(null);
    // 送れたときだけ空にする。失敗したら本文も添付も残す。
    if (await onSubmit(text, names)) {
      // 送れたときだけ最新へ戻す。失敗したら読み返していた位置を保つ。
      setPinned(true);
      setDraft("");
      setAttachments([]);
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
    } else {
      setNotice(SEND_FAILED_NOTICE);
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
    setNotice(null);
    if (await onSubmit(text, [])) {
      setPinned(true);
      setChip(null);
      setDraft("");
    } else setNotice(SEND_FAILED_NOTICE);
    setSending(false);
  };

  const submit = () => {
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
          {body.kind === "skeleton" ? (
            <OutputSkeleton />
          ) : body.kind === "chat" ? (
            <>
              {body.snapshot.truncated ? (
                <p class="hwc-output-notice">古い会話は省略されています</p>
              ) : null}
              {body.snapshot.compaction === null ? null : (
                <Compaction compaction={body.snapshot.compaction} expandable={!compact} />
              )}
              <ChatLog
                paneId={pane.id}
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

      {notice === null ? null : (
        <p class="hwc-send-notice" role="status">
          <span class="hwc-send-notice-mark">
            <StatusMark tone="attention" size={12} />
          </span>
          {notice}
        </p>
      )}

      <form
        class="hwc-input"
        data-expanded={expanded}
        data-shell={shell}
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
                // 未対応の形式は保存しない。何が起きたかをその場で伝える。
                if (action.kind === "unsupported") {
                  setNotice(unsupportedImageNotice());
                  return;
                }
                if (action.unsupported) setNotice(unsupportedImageNotice());
                event.preventDefault();
                addImages(action.files);
              }}
              onKeyDown={(event) => {
                const composing = event.isComposing || event.keyCode === 229;
                if (event.key !== "Enter") return;
                if (composing) return;
                // シェルは改行を受け取れない。Shift+Enter で改行を入れさせない。
                if (event.shiftKey) {
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
