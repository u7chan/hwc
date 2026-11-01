import { useEffect, useRef, useState } from "preact/hooks";
import type { PaneState } from "../server/herdr/state";
import {
  ArrowDownIcon,
  ChevronLeftIcon,
  CloseSmallIcon,
  CollapseIcon,
  ExpandIcon,
  SendIcon,
} from "./icons";
import { statusTone } from "./select";
import { StatusLabel } from "./StatusLabel";

type PaneDetailProps = {
  pane: PaneState;
  context: { workspaceLabel: string; tabLabel: string };
  panes: readonly PaneState[];
  output: string;
  onSelectPane: (paneId: string) => void;
  onClosePane: (paneId: string) => void;
  onBack: () => void;
  onSubmit: (text: string) => void;
  feedback: string | null;
};

export function PaneDetail(props: PaneDetailProps) {
  const { pane, context, panes, output, onSelectPane, onClosePane, onBack, onSubmit, feedback } =
    props;
  const [draft, setDraft] = useState("");
  const [expanded, setExpanded] = useState(false);
  const [atBottom, setAtBottom] = useState(true);
  const input = useRef<HTMLTextAreaElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const tabList = useRef<HTMLDivElement>(null);

  const canSend = draft.trim() !== "";

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
    if (!canSend) return;
    onSubmit(draft);
    // 送信したらキーボードを閉じて出力を見せる。
    input.current?.blur();
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
              <span class="hwc-tab" key={item.id} data-selected={selected}>
                <button
                  type="button"
                  role="tab"
                  class="hwc-tab-main"
                  aria-selected={selected}
                  aria-label={`${item.title ?? item.agent ?? item.id} (${item.id})`}
                  onClick={() => onSelectPane(item.id)}
                >
                  <span class={`hwc-dot hwc-dot--${statusTone(item.agentStatus)}`} />
                  <span class="hwc-tab-label">{item.title ?? item.agent ?? item.id}</span>
                </button>
                {selected && (
                  <button
                    type="button"
                    class="hwc-tab-close"
                    aria-label={`${item.title ?? item.agent ?? item.id} を閉じる`}
                    onClick={() => onClosePane(item.id)}
                  >
                    <CloseSmallIcon />
                  </button>
                )}
              </span>
            );
          })}
        </div>
        <StatusLabel status={pane.agentStatus} />
      </div>

      <div class="hwc-output-wrap">
        <div
          class="hwc-output-scroll"
          ref={scroller}
          onScroll={(event) => {
            const element = event.currentTarget;
            setAtBottom(element.scrollHeight - element.scrollTop - element.clientHeight <= 8);
          }}
        >
          <pre class="hwc-output">{output}</pre>
        </div>
        {!atBottom && (
          <button type="button" class="hwc-jump" aria-label="最新へ" onClick={jumpToLatest}>
            <ArrowDownIcon />
          </button>
        )}
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
            <button type="submit" class="hwc-send" aria-label="送信" disabled={!canSend}>
              <SendIcon />
            </button>
          </div>
        </div>
      </form>
    </div>
  );
}
