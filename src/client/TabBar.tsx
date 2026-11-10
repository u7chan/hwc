import type { ComponentChildren } from "preact";
import { useLayoutEffect, useRef } from "preact/hooks";
import type { PaneState } from "../server/herdr/state";
import type { PaneProcess } from "../shared/panes";
import { ChevronLeftIcon, EyeIcon, EyeOffIcon, SplitIcon } from "./icons";
import { ParentMark } from "./ParentMark";
import { paneTabName } from "./process";
import { statusLabel } from "./select";
import { StatusIcon } from "./StatusLabel";

type TabBarProps = {
  pane: PaneState;
  panes: readonly PaneState[];
  parentPaneIds: ReadonlySet<string>;
  // シェルで動いているコマンド。タブ名をコマンドに差し替えるためだけに使う。
  processes: ReadonlyMap<string, PaneProcess>;
  // 開いているプレビュー。ペインではないので、選択と表示だけを別に持つ。
  preview: { name: string; selected: boolean } | null;
  split: boolean;
  hidden: ReadonlySet<string>;
  status: ComponentChildren;
  onSelectPane: (paneId: string) => void;
  onToggleHidden: (paneId: string) => void;
  onSelectPreview: () => void;
  onBack: () => void;
  onToggleSplit: () => void;
};

// 詳細の上端。ペインの切り替えと、分割表示の切り替えを持つ。
export function TabBar(props: TabBarProps) {
  const tabList = useRef<HTMLDivElement>(null);

  // 選択中のタブが隠れていたら見える位置まで送る。プレビューを選んだときも送る。
  const previewing = props.preview?.selected === true;
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
  }, [props.pane.id, previewing]);

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
          const selected = !previewing && item.id === props.pane.id;
          const hidden = props.hidden.has(item.id);
          const parent = props.parentPaneIds.has(item.id);
          const process = props.processes.get(item.id) ?? null;
          const name = paneTabName(item, process);
          // タブにはプログラム名だけを出す。何を動かしているかは、ホバーと読み上げで補う。
          const command = process?.running === true ? process.command : null;
          const detail = command === null ? name : `${name} (${command})`;
          // 開いているペインは分割に必ず出るので、隠す操作を持たせない。プレビュー中は
          // 分割が見えていないので、目玉も出さない。
          const eye = props.split && !selected && !previewing;
          return (
            <div class="hwc-tab-item" key={item.id} data-selected={selected} data-hidden={hidden}>
              <button
                type="button"
                role="tab"
                class="hwc-tab"
                aria-selected={selected}
                aria-label={`${parent ? "親ペイン、" : ""}${detail} (${item.id}, ${statusLabel(item.agentStatus)}${hidden ? ", 分割で非表示" : ""})`}
                title={detail}
                data-pane-id={item.id}
                data-eye={eye}
                onClick={() => props.onSelectPane(item.id)}
              >
                {parent ? <ParentMark /> : null}
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
        {props.preview === null ? null : (
          <div class="hwc-tab-item" data-selected={props.preview.selected}>
            <button
              type="button"
              role="tab"
              class="hwc-tab"
              aria-selected={props.preview.selected}
              aria-label={`${props.preview.name} のプレビュー`}
              title={`${props.preview.name} のプレビュー`}
              onClick={props.onSelectPreview}
            >
              <EyeIcon size={14} />
              <span class="hwc-tab-label">{props.preview.name}</span>
            </button>
          </div>
        )}
      </div>
      {props.status}
      <button
        type="button"
        class="hwc-split-toggle"
        aria-pressed={props.split}
        aria-label={props.split ? "分割をやめる" : "分割して表示"}
        disabled={props.panes.length < 2 || previewing}
        onClick={props.onToggleSplit}
      >
        <SplitIcon />
      </button>
    </div>
  );
}
