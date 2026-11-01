import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import type { PaneState } from "../server/herdr/state";
import {
  ATTACHMENT_LIMIT,
  addAttachments,
  attachmentKind,
  formatBytes,
  removeAttachment,
  type Attachment,
} from "./files";
import {
  AgentGlyphIcon,
  ArrowDownIcon,
  ChevronLeftIcon,
  CloseIcon,
  CollapseIcon,
  CopyGlyph,
  ExpandIcon,
  ExternalLinkIcon,
  EyeIcon,
  PaperclipIcon,
  TerminalIcon,
  SendIcon,
} from "./icons";
import { agentGlyph, statusLabel } from "./select";
import type { ChatMessage } from "./chat";
import { useCopy } from "./copy";
import { readDraft, storage, writeDraft } from "./drafts";
import { Preview } from "./Preview";
import { Spinner } from "./Spinner";
import { formatClock } from "./time";
import { StatusIcon } from "./StatusLabel";

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

// 会話として読むための並び。ユーザーは右、エージェントは左。
function ChatLog(props: {
  messages: readonly ChatMessage[];
  replying: boolean;
  agent: string | null;
  copiedId: string | null;
  onCopy: (id: string, text: string) => void;
}) {
  // 記号は本文の幅を削らないよう、時刻の行に置く。
  const avatar = (
    <span class="hwc-msg-avatar" data-agent={agentGlyph(props.agent)}>
      <AgentGlyphIcon agent={props.agent} size={16} />
    </span>
  );

  const copyButton = (message: ChatMessage) => (
    <button
      type="button"
      class="hwc-msg-copy"
      data-copied={props.copiedId === message.id}
      aria-label={props.copiedId === message.id ? "コピーしました" : "このメッセージをコピー"}
      onClick={() => props.onCopy(message.id, message.text)}
    >
      <CopyGlyph copied={props.copiedId === message.id} size={14} />
    </button>
  );

  return (
    <ol class="hwc-chat">
      {props.messages.map((message) =>
        message.role === "agent" ? (
          <li class="hwc-msg" data-role="agent" key={message.id}>
            <pre class="hwc-msg-text">{message.text}</pre>
            <div class="hwc-msg-meta">
              {avatar}
              <span class="hwc-msg-time">{formatClock(message.at)}</span>
              {copyButton(message)}
            </div>
          </li>
        ) : (
          <li class="hwc-msg" data-role="user" key={message.id}>
            <p class="hwc-msg-text">{message.text}</p>
            <div class="hwc-msg-meta">
              <span class="hwc-msg-time">{formatClock(message.at)}</span>
              {copyButton(message)}
            </div>
          </li>
        ),
      )}
      {props.replying ? (
        <li class="hwc-msg" data-role="agent" aria-label="返答を待っています">
          <div class="hwc-msg-meta">
            {avatar}
            <span class="hwc-typing">
              <span />
              <span />
              <span />
            </span>
          </div>
        </li>
      ) : null}
    </ol>
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

type PaneDetailProps = {
  pane: PaneState;
  messages: readonly ChatMessage[] | null;
  replying: boolean;
  context: { workspaceLabel: string; tabLabel: string };
  panes: readonly PaneState[];
  output: string | null;
  onSelectPane: (paneId: string) => void;
  onBack: () => void;
  onSubmit: (text: string) => void | Promise<void>;
  onDropPane: (paneId: string, targetPaneId: string, after: boolean) => void;
  feedback: string | null;
};

export function PaneDetail(props: PaneDetailProps) {
  const {
    pane,
    messages,
    replying,
    context,
    panes,
    output,
    onSelectPane,
    onBack,
    onSubmit,
    onDropPane,
    feedback,
  } = props;
  // 下書きはペインごとに残す。書きかけのまま一覧へ戻っても消えない。
  const [draft, setDraft] = useState(() => readDraft(storage(), pane.id));
  const [expanded, setExpanded] = useState(false);
  const [sending, setSending] = useState(false);
  const [atBottom, setAtBottom] = useState(true);

  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [dropping, setDropping] = useState(false);
  const [rejected, setRejected] = useState(0);
  const [previewing, setPreviewing] = useState<string | null>(null);
  // 消える途中の添付は、animation が終わるまで一覧に残す。
  const [leaving, setLeaving] = useState<readonly string[]>([]);
  const chipPositions = useRef<Map<string, { x: number; y: number }>>(new Map());
  const chipOrder = useRef("");
  const picker = useRef<HTMLInputElement>(null);

  const previewed = attachments.find((file) => file.id === previewing) ?? null;

  // 消えたものだけを動かし、残りは前の位置から滑らせる（FLIP）。
  useLayoutEffect(() => {
    const chips = [...document.querySelectorAll<HTMLElement>(".hwc-attachment")];
    const next = new Map<string, { x: number; y: number }>();
    const animate = !window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    const nextOrder = chips.map((chip) => chip.dataset.attachmentId ?? "").join(",");
    const reordered = nextOrder !== chipOrder.current;
    chipOrder.current = nextOrder;

    // 添付の一覧は縦にスクロールする。スクロール量を足して、並びの変化だけを見る。
    const list = document.querySelector<HTMLElement>(".hwc-attachments");
    const scrolledX = list?.scrollLeft ?? 0;
    const scrolledY = list?.scrollTop ?? 0;

    for (const chip of chips) {
      const id = chip.dataset.attachmentId;
      if (!id) continue;
      const raw = chip.getBoundingClientRect();
      const rect = { left: raw.left + scrolledX, top: raw.top + scrolledY };
      next.set(id, { x: rect.left, y: rect.top });
      const before = chipPositions.current.get(id);
      if (!animate || !reordered || !before) continue;
      const dx = before.x - rect.left;
      const dy = before.y - rect.top;
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue;

      chip.style.transition = "none";
      chip.style.transform = `translate(${dx}px, ${dy}px)`;
      void chip.offsetHeight;
      chip.style.transition = "transform 180ms ease";
      chip.style.transform = "";
    }

    chipPositions.current = next;
  });

  const dropAttachment = (id: string) => {
    if (leaving.includes(id)) return;
    setRejected(0);
    // 動きを止めている環境では待たずに消す。
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setAttachments((current) => removeAttachment(current, id));
      return;
    }
    setLeaving((current) => [...current, id]);
    setTimeout(() => {
      setAttachments((current) => removeAttachment(current, id));
      setLeaving((current) => current.filter((item) => item !== id));
    }, 170);
  };

  const takeFiles = (files: readonly File[]) => {
    setAttachments((current) => {
      const next = addAttachments(
        current,
        files.map((file) => ({
          name: file.name,
          size: file.size,
          lastModified: file.lastModified,
          type: file.type,
          blob: file,
        })),
      );
      setRejected(next.rejected);
      return next.attachments;
    });
  };

  // PDF は中で描画するとブラウザ差が出るので、別のタブに任せる。
  const openInTab = (attachment: Attachment) => {
    if (!attachment.blob) return;
    const url = URL.createObjectURL(attachment.blob);
    window.open(url, "_blank", "noopener");
    // 開いたタブが読み込むまで URL は生かしておく。
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  };
  // タブの並びも PC だけで動かす。触れる画面ではドラッグが発火しない。
  const [draggedTab, setDraggedTab] = useState<string | null>(null);
  const [tabDrop, setTabDrop] = useState<{ paneId: string; after: boolean } | null>(null);
  const tabPositions = useRef<Map<string, number>>(new Map());

  const tabList = useRef<HTMLDivElement>(null);
  const tabOrder = useRef("");

  // 並びが変わったタブだけ、前の位置から滑らせる（FLIP）。
  useLayoutEffect(() => {
    const chips = [...document.querySelectorAll<HTMLElement>(".hwc-tab[data-pane-id]")];
    const next = new Map<string, number>();
    const animate =
      typeof window !== "undefined" &&
      !window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    // 並びが変わったときだけ動かす。位置は毎回測り直して、次の比較に使う。
    const nextOrder = chips.map((chip) => chip.dataset.paneId ?? "").join(",");
    const reordered = nextOrder !== tabOrder.current;
    tabOrder.current = nextOrder;

    // タブバーは横にスクロールする。画面座標のままだと、送っただけで動いたと誤認する。
    const scrolled = tabList.current?.scrollLeft ?? 0;

    for (const chip of chips) {
      const id = chip.dataset.paneId;
      if (!id) continue;
      const left = chip.getBoundingClientRect().left + scrolled;
      next.set(id, left);
      const before = tabPositions.current.get(id);
      if (!animate || !reordered || before === undefined || Math.abs(before - left) < 1) continue;

      chip.style.transition = "none";
      chip.style.transform = `translateX(${before - left}px)`;
      void chip.offsetWidth;
      chip.style.transition = "transform 220ms cubic-bezier(0.2, 0.9, 0.3, 1)";
      chip.style.transform = "";
    }

    tabPositions.current = next;
    return () => {
      for (const chip of chips) chip.style.transition = "";
    };
  });
  const input = useRef<HTMLTextAreaElement>(null);
  const scroller = useRef<HTMLDivElement>(null);

  const canSend = draft.trim() !== "";

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

  // 打つたびに書くと重いので、手が止まってから残す。
  useEffect(() => {
    const text = draft;
    const timer = setTimeout(() => writeDraft(storage(), pane.id, text), 250);
    return () => clearTimeout(timer);
  }, [draft, pane.id]);

  // 送信で空にしたときも、高さを初期状態へ戻す。
  useEffect(() => {
    fit(input.current, expanded);
  }, [draft, expanded]);

  // 選択中のタブが隠れていたら見える位置まで送る。
  useEffect(() => {
    const list = tabList.current;
    const selected = list?.querySelector<HTMLElement>('[aria-selected="true"]');
    if (!list || !selected) return;
    const left = selected.offsetLeft;
    const right = left + selected.offsetWidth;
    if (left < list.scrollLeft) list.scrollLeft = left - 8;
    else if (right > list.scrollLeft + list.clientWidth) {
      list.scrollLeft = right - list.clientWidth + 8;
    }
  }, [pane.id]);

  // 最新が見えている間だけ追従する。読み返しているときは勝手に動かさない。
  useEffect(() => {
    const element = scroller.current;
    if (element && atBottom) element.scrollTop = element.scrollHeight;
  }, [output, messages, replying, atBottom]);

  const jumpToLatest = () => {
    setAtBottom(true);
    const element = scroller.current;
    element?.scrollTo({ top: element.scrollHeight, behavior: "smooth" });
  };

  const send = () => {
    if (!canSend || sending) return;
    setSending(true);
    // 送信したらキーボードを閉じて出力を見せる。
    input.current?.blur();
    Promise.resolve(onSubmit(draft))
      .then(() => {
        // 送れたときだけ空にする。失敗したら書き直せるよう残す。
        setDraft("");
        setAttachments([]);
        setRejected(0);
      })
      .catch(() => undefined)
      .finally(() => setSending(false));
  };

  return (
    <div class="hwc-detail-inner">
      <div class="hwc-tabbar">
        <button
          type="button"
          class="hwc-icon-button hwc-back"
          aria-label="一覧へ戻る"
          onClick={onBack}
        >
          <ChevronLeftIcon />
        </button>
        <div class="hwc-tabs" role="tablist" aria-label="ペイン" ref={tabList}>
          {panes.map((item) => {
            const selected = item.id === pane.id;
            return (
              <button
                type="button"
                role="tab"
                class="hwc-tab"
                key={item.id}
                aria-selected={selected}
                aria-label={`${item.title ?? item.agent ?? item.id} (${item.id}, ${statusLabel(item.agentStatus)})`}
                data-pane-id={item.id}
                data-dragging={draggedTab === item.id}
                data-drop={
                  tabDrop?.paneId === item.id ? (tabDrop.after ? "after" : "before") : undefined
                }
                draggable
                onClick={() => onSelectPane(item.id)}
                onDragStart={(event) => {
                  event.dataTransfer?.setData("text/plain", item.id);
                  if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
                  setDraggedTab(item.id);
                }}
                onDragEnd={() => {
                  setDraggedTab(null);
                  setTabDrop(null);
                }}
                onDragOver={(event) => {
                  if (draggedTab === null || draggedTab === item.id) return;
                  event.preventDefault();
                  if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
                  const rect = event.currentTarget.getBoundingClientRect();
                  setTabDrop({
                    paneId: item.id,
                    after: event.clientX > rect.left + rect.width / 2,
                  });
                }}
                onDragLeave={() =>
                  setTabDrop((current) => (current?.paneId === item.id ? null : current))
                }
                onDrop={(event) => {
                  event.preventDefault();
                  const moved = event.dataTransfer?.getData("text/plain") ?? draggedTab;
                  const after = event.currentTarget.dataset.drop === "after";
                  setDraggedTab(null);
                  setTabDrop(null);
                  if (moved && moved !== item.id) onDropPane(moved, item.id, after);
                }}
              >
                <span class="hwc-tab-label">{item.title ?? item.agent ?? item.id}</span>
                <StatusIcon status={item.agentStatus} />
              </button>
            );
          })}
        </div>
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
          data-empty={messages === null && output !== null && output.trim() === ""}
          ref={scroller}
          onScroll={(event) => {
            const element = event.currentTarget;
            setAtBottom(element.scrollHeight - element.scrollTop - element.clientHeight <= 8);
          }}
        >
          {messages !== null ? (
            <ChatLog
              messages={messages}
              replying={replying}
              agent={pane.agent}
              copiedId={copiedId}
              onCopy={copy}
            />
          ) : output === null ? (
            <OutputSkeleton />
          ) : output.trim() === "" ? (
            <OutputEmpty />
          ) : (
            <pre class="hwc-output">{output}</pre>
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

      <form
        class="hwc-input"
        data-expanded={expanded}
        data-dropping={dropping}
        onSubmit={(event) => {
          event.preventDefault();
          send();
        }}
        onDragOver={(event) => {
          if (!event.dataTransfer?.types.includes("Files")) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = "copy";
          setDropping(true);
        }}
        onDragLeave={(event) => {
          const next = event.relatedTarget;
          if (next instanceof Node && event.currentTarget.contains(next)) return;
          setDropping(false);
        }}
        onDrop={(event) => {
          const transfer = event.dataTransfer;
          if (!transfer?.types.includes("Files")) return;
          event.preventDefault();
          setDropping(false);
          takeFiles([...transfer.files]);
        }}
      >
        <label class="hwc-visually-hidden" for="hwc-input-field">
          {context.workspaceLabel} / {context.tabLabel} のペインへ送る
        </label>
        {attachments.length > 0 ? (
          <ul class="hwc-attachments" aria-label="添付">
            {attachments.map((file) => {
              const kind = attachmentKind(file);
              const body = (
                <>
                  {kind === "image" || kind === "text" ? (
                    <EyeIcon />
                  ) : kind === "pdf" ? (
                    <ExternalLinkIcon />
                  ) : (
                    <PaperclipIcon />
                  )}
                  <span class="hwc-attachment-name">{file.name}</span>
                  <span class="hwc-attachment-size">{formatBytes(file.size)}</span>
                </>
              );
              return (
                <li
                  class="hwc-attachment"
                  key={file.id}
                  data-kind={kind}
                  data-attachment-id={file.id}
                  data-leaving={leaving.includes(file.id)}
                >
                  {kind === "image" || kind === "text" ? (
                    <button
                      type="button"
                      class="hwc-attachment-open"
                      title={file.name}
                      aria-label={`${file.name} をプレビュー`}
                      onClick={() => setPreviewing(file.id)}
                    >
                      {body}
                    </button>
                  ) : kind === "pdf" ? (
                    <button
                      type="button"
                      class="hwc-attachment-open"
                      title={file.name}
                      aria-label={`${file.name} を新しいタブで開く`}
                      onClick={() => openInTab(file)}
                    >
                      {body}
                    </button>
                  ) : (
                    <span class="hwc-attachment-static" title={file.name}>
                      {body}
                    </span>
                  )}
                  <button
                    type="button"
                    class="hwc-attachment-remove"
                    aria-label={`${file.name} を外す`}
                    onClick={() => dropAttachment(file.id)}
                  >
                    <CloseIcon size={14} />
                  </button>
                </li>
              );
            })}
          </ul>
        ) : null}
        {rejected > 0 ? (
          <div class="hwc-attachments-warning" role="status">
            <span class="hwc-attachments-warning-text">
              添付は {ATTACHMENT_LIMIT} 件までです（{rejected} 件は追加できませんでした）
            </span>
            <button
              type="button"
              class="hwc-attachments-warning-close"
              aria-label="警告を閉じる"
              onClick={() => setRejected(0)}
            >
              <CloseIcon size={14} />
            </button>
          </div>
        ) : null}
        {attachments.length > 0 ? (
          <p class="hwc-attachments-note">添付はまだ送信されません</p>
        ) : null}
        <div class="hwc-drop-hint" aria-hidden={!dropping}>
          <PaperclipIcon size={18} />
          ドロップして添付
        </div>
        <div class="hwc-input-frame">
          <button
            type="button"
            class="hwc-input-toggle"
            aria-expanded={expanded}
            aria-label={expanded ? "入力を折りたたむ" : "入力を広げる"}
            onClick={() => setExpanded((current) => !current)}
          >
            {expanded ? <CollapseIcon /> : <ExpandIcon />}
          </button>
          <textarea
            id="hwc-input-field"
            ref={input}
            class="hwc-input-field"
            rows={2}
            value={draft}
            placeholder="メッセージを入力"
            onInput={(event) => setDraft(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && !event.isComposing) {
                event.preventDefault();
                send();
              }
            }}
          />
          <div class="hwc-input-actions">
            <button
              type="button"
              class="hwc-attach"
              aria-label="ファイルを添付"
              title="ファイルを添付"
              onClick={() => picker.current?.click()}
            >
              <PaperclipIcon size={18} />
            </button>
            <input
              ref={picker}
              class="hwc-visually-hidden"
              type="file"
              multiple
              tabIndex={-1}
              aria-hidden="true"
              onChange={(event) => {
                const target = event.currentTarget;
                if (target.files) takeFiles([...target.files]);
                // 同じファイルをもう一度選んでも拾えるように戻す。
                target.value = "";
              }}
            />
            <span class="hwc-feedback" aria-live="polite">
              {feedback}
            </span>
            <button
              type="submit"
              class="hwc-send"
              data-sending={sending}
              aria-label={sending ? "送信中" : "送信"}
              disabled={!canSend || sending}
            >
              {sending ? <Spinner /> : <SendIcon />}
            </button>
          </div>
        </div>
      </form>
      {previewed ? (
        <Preview
          attachment={previewed}
          onClose={() => setPreviewing(null)}
          onRemove={() => {
            dropAttachment(previewed.id);
            setPreviewing(null);
          }}
        />
      ) : null}
    </div>
  );
}
