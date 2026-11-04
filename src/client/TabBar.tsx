import type { ComponentChildren } from "preact";
import { useLayoutEffect, useRef } from "preact/hooks";
import type { PaneState } from "../server/herdr/state";
import { ChevronLeftIcon, EyeIcon, EyeOffIcon, SplitIcon } from "./icons";
import { paneName, statusLabel } from "./select";
import { StatusIcon } from "./StatusLabel";

type TabBarProps = {
  pane: PaneState;
  panes: readonly PaneState[];
  split: boolean;
  hidden: ReadonlySet<string>;
  status: ComponentChildren;
  onSelectPane: (paneId: string) => void;
  onToggleHidden: (paneId: string) => void;
  onBack: () => void;
  onToggleSplit: () => void;
};

// 詳細の上端。ペインの切り替えと、分割表示の切り替えを持つ。
export function TabBar(props: TabBarProps) {
  const tabList = useRef<HTMLDivElement>(null);

  // 選択中のタブが隠れていたら見える位置まで送る。
  useLayoutEffect(() => {
    const list = tabList.current;
    const selected = list?.querySelector<HTMLElement>('[data-selected="true"]');
    if (!list || !selected) return;
    const listRect = list.getBoundingClientRect();
    const rect = selected.getBoundingClientRect();
    const left = rect.left - listRect.left + list.scrollLeft;
    const right = left + rect.width;
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
          const hidden = props.hidden.has(item.id);
          const name = paneName(item);
          // 開いているペインは分割に必ず出るので、隠す操作を持たせない。
          const eye = props.split && !selected;
          return (
            <div class="hwc-tab-item" key={item.id} data-selected={selected} data-hidden={hidden}>
              <button
                type="button"
                role="tab"
                class="hwc-tab"
                aria-selected={selected}
                aria-label={`${name} (${item.id}, ${statusLabel(item.agentStatus)}${hidden ? ", 分割で非表示" : ""})`}
                data-pane-id={item.id}
                data-eye={eye}
                onClick={() => props.onSelectPane(item.id)}
              >
                <span class="hwc-tab-label">{name}</span>
                <StatusIcon status={item.agentStatus} />
              </button>
              {eye ? (
                <button
                  type="button"
                  class="hwc-tab-eye"
                  aria-pressed={!hidden}
                  aria-label={`${name} (${item.id}) を分割に表示`}
                  data-pane-id={item.id}
                  onClick={() => props.onToggleHidden(item.id)}
                >
                  {hidden ? <EyeOffIcon /> : <EyeIcon />}
                </button>
              ) : null}
            </div>
          );
        })}
      </div>
      {props.status}
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
