import { useLayoutEffect, useRef } from "preact/hooks";
import type { PaneState } from "../server/herdr/state";
import { ChevronLeftIcon, SplitIcon } from "./icons";
import { statusLabel } from "./select";
import { StatusIcon } from "./StatusLabel";

type TabBarProps = {
  pane: PaneState;
  panes: readonly PaneState[];
  split: boolean;
  onSelectPane: (paneId: string) => void;
  onBack: () => void;
  onToggleSplit: () => void;
};

// 詳細の上端。ペインの切り替えと、分割表示の切り替えを持つ。
export function TabBar(props: TabBarProps) {
  const tabList = useRef<HTMLDivElement>(null);

  // 選択中のタブが隠れていたら見える位置まで送る。
  useLayoutEffect(() => {
    const list = tabList.current;
    const selected = list?.querySelector<HTMLElement>('[aria-selected="true"]');
    if (!list || !selected) return;
    const left = selected.offsetLeft;
    const right = left + selected.offsetWidth;
    if (left < list.scrollLeft) list.scrollLeft = left - 8;
    else if (right > list.scrollLeft + list.clientWidth) {
      list.scrollLeft = right - list.clientWidth + 8;
    }
  }, [props.pane.id]);

  return (
    <div class="hwc-tabbar">
      <button
        type="button"
        class="hwc-icon-button hwc-back"
        aria-label="一覧へ戻る"
        onClick={props.onBack}
      >
        <ChevronLeftIcon />
      </button>
      <div class="hwc-tabs" role="tablist" aria-label="ペイン" ref={tabList}>
        {props.panes.map((item) => {
          const selected = item.id === props.pane.id;
          return (
            <button
              type="button"
              role="tab"
              class="hwc-tab"
              key={item.id}
              aria-selected={selected}
              aria-label={`${item.title ?? item.agent ?? item.id} (${item.id}, ${statusLabel(item.agentStatus)})`}
              data-pane-id={item.id}
              onClick={() => props.onSelectPane(item.id)}
            >
              <span class="hwc-tab-label">{item.title ?? item.agent ?? item.id}</span>
              <StatusIcon status={item.agentStatus} />
            </button>
          );
        })}
      </div>
      <button
        type="button"
        class="hwc-split-toggle"
        aria-pressed={props.split}
        aria-label={props.split ? "分割をやめる" : "分割して表示"}
        disabled={props.panes.length < 2}
        onClick={props.onToggleSplit}
      >
        <SplitIcon />
      </button>
    </div>
  );
}
