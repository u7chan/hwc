import { useEffect, useRef, useState } from "preact/hooks";
import type { PaneState } from "../server/herdr/state";
import {
  ArrowDownIcon,
  ChevronLeftIcon,
  CollapseIcon,
  CopyGlyph,
  ExpandIcon,
  TerminalIcon,
  SendIcon,
} from "./icons";
import { statusLabel } from "./select";
import { Spinner } from "./Spinner";
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
  context: { workspaceLabel: string; tabLabel: string };
  panes: readonly PaneState[];
  output: string | null;
  onSelectPane: (paneId: string) => void;
  onBack: () => void;
  onSubmit: (text: string) => void | Promise<void>;
  onDropPane: (paneId: string, targetPaneId: string) => void;
  feedback: string | null;
};

export function PaneDetail(props: PaneDetailProps) {
  const { pane, context, panes, output, onSelectPane, onBack, onSubmit, onDropPane, feedback } =
    props;
  const [draft, setDraft] = useState("");
  const [expanded, setExpanded] = useState(false);
  const [sending, setSending] = useState(false);
  const [atBottom, setAtBottom] = useState(true);
  const [copied, setCopied] = useState(false);
  const [dropTab, setDropTab] = useState<string | null>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const tabList = useRef<HTMLDivElement>(null);

  const canSend = draft.trim() !== "";

  const copyId = () => {
    void navigator.clipboard
      ?.writeText(pane.id)
      .then(() => setCopied(true))
      .catch(() => setCopied(false));
  };

  // コピーの知らせは数秒で戻す。
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);

  // 入力量に合わせて高さを伸ばす。広げている間は CSS の高さに任せる。
  const fit = (field: HTMLTextAreaElement | null, open: boolean) => {
    if (!field) return;
    field.style.height = "";
    if (open) return;
    field.style.height = "auto";
    field.style.height = `${field.scrollHeight}px`;
  };

  useEffect(() => {
    fit(input.current, expanded);
  }, [expanded]);

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
  }, [output, atBottom]);

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
    Promise.resolve(onSubmit(draft)).finally(() => setSending(false));
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
                onClick={() => onSelectPane(item.id)}
                data-drop={dropTab === item.id}
                onDragOver={(event) => {
                  if (!event.dataTransfer?.types.includes("text/plain")) return;
                  event.preventDefault();
                  event.dataTransfer.dropEffect = "move";
                  setDropTab(item.id);
                }}
                onDragLeave={() => setDropTab((current) => (current === item.id ? null : current))}
                onDrop={(event) => {
                  event.preventDefault();
                  setDropTab(null);
                  const dragged = event.dataTransfer?.getData("text/plain");
                  // タブ自身を落としても何も起きない。
                  if (dragged && dragged !== item.id) onDropPane(dragged, item.id);
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
          data-empty={output !== null && output.trim() === ""}
          ref={scroller}
          onScroll={(event) => {
            const element = event.currentTarget;
            setAtBottom(element.scrollHeight - element.scrollTop - element.clientHeight <= 8);
          }}
        >
          {output === null ? (
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
        onSubmit={(event) => {
          event.preventDefault();
          send();
        }}
      >
        <button
          type="button"
          class="hwc-input-toggle"
          aria-expanded={expanded}
          aria-label={expanded ? "入力を折りたたむ" : "入力を広げる"}
          onClick={() => setExpanded((current) => !current)}
        >
          {expanded ? <CollapseIcon /> : <ExpandIcon />}
        </button>
        <label class="hwc-visually-hidden" for="hwc-input-field">
          {context.workspaceLabel} / {context.tabLabel} のペインへ送る
        </label>
        <div class="hwc-input-frame">
          <textarea
            id="hwc-input-field"
            ref={input}
            class="hwc-input-field"
            rows={2}
            value={draft}
            placeholder="メッセージを入力"
            onInput={(event) => {
              setDraft(event.currentTarget.value);
              fit(event.currentTarget, expanded);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && !event.isComposing) {
                event.preventDefault();
                send();
              }
            }}
          />
          <div class="hwc-input-actions">
            <span class="hwc-feedback" aria-live="polite">
              {feedback}
            </span>
            <span class="hwc-input-hint">Enter は改行・⌘/Ctrl + Enter で送信</span>
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
    </div>
  );
}
