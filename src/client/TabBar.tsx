import type { ComponentChildren } from "preact";
import { useLayoutEffect, useRef } from "preact/hooks";
import type { PaneCloseAction } from "../shared/pane-close";
import type { PaneProcess } from "../shared/panes";
import { ChevronLeftIcon, CloseIcon, EyeIcon } from "./icons";
import { ParentMark } from "./ParentMark";
import { paneTabName } from "./process";
import { statusLabel, type PaneRow } from "./select";
import { StatusIcon } from "./StatusLabel";

type TabBarProps = {
  // 開いたペインの履歴。全スペースを跨ぎ、左から開いた順。
  openTabs: readonly PaneRow[];
  // 4 スロットの並び。タブの左端のバーをスロット色にするためにだけ使う。
  slots: readonly (string | null)[];
  currentPaneId: string | null;
  // 複数スペースのペインが開いているときだけ、2 段目にスペース名を出す。
  multiSpace: boolean;
  parentPaneIds: ReadonlySet<string>;
  closeActionOf: (paneId: string) => PaneCloseAction | "keep" | null;
  // シェルで動いているコマンド。タブ名をコマンドに差し替えるためだけに使う。
  processes: ReadonlyMap<string, PaneProcess>;
  // 開いているプレビュー。ペインではないので、選択と表示だけを別に持つ。
  preview: { name: string; selected: boolean } | null;
  status: ComponentChildren;
  onSelectPane: (paneId: string) => void;
  onClosePane: (paneId: string) => void;
  onSelectPreview: () => void;
  onBack: () => void;
  // タブからのドラッグ。移動量で開始を判定するので、押した時点で位置だけ渡す。
  onDragStart: (event: PointerEvent, paneId: string) => void;
};

// 詳細の上端。開いたペインの履歴を並べ、閉じる入口を添える。
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
  }, [props.currentPaneId, previewing]);

  return (
    <div class="hwc-tabbar" data-multi-space={props.multiSpace}>
      <button
        type="button"
        class="hwc-icon-button hwc-back"
        aria-label="一覧へ戻る"
        onClick={props.onBack}
      >
        <ChevronLeftIcon />
      </button>
      <div class="hwc-tabs" role="tablist" aria-label="開いているペイン" ref={tabList}>
        {props.openTabs.map((item) => {
          const selected = !previewing && item.pane.id === props.currentPaneId;
          const parent = props.parentPaneIds.has(item.pane.id);
          const process = props.processes.get(item.pane.id) ?? null;
          const name = paneTabName(item.pane, process);
          // タブにはプログラム名だけを出す。何を動かしているかは、ホバーと読み上げで補う。
          const command = process?.running === true ? process.command : null;
          const detail = command === null ? name : `${name} (${command})`;
          const action = props.closeActionOf(item.pane.id);
          // keep はスペース最後のシェル。閉じる入口を出さず、理由を title に添える。
          const closable = action === "close" || action === "exit";
          const space = `${item.workspace.label} · ${item.tab.label || item.tab.id}`;
          const description = `${space}、${item.pane.id}、${statusLabel(item.pane.agentStatus)}`;
          const note = action === "keep" ? "、最後のペインのため閉じられません" : "";
          const slot = props.slots.indexOf(item.pane.id);
          return (
            <div
              class="hwc-tab-item"
              key={item.pane.id}
              data-selected={selected}
              data-slot={slot >= 0 ? slot + 1 : undefined}
            >
              <button
                type="button"
                role="tab"
                class="hwc-tab"
                aria-selected={selected}
                aria-label={`${parent ? "親ペイン、" : ""}${detail} (${description}${note})`}
                title={`${detail} (${description}${note})`}
                data-pane-id={item.pane.id}
                onPointerDown={(event) => props.onDragStart(event, item.pane.id)}
                onAuxClick={(event) => {
                  if (event.button !== 1 || !closable) return;
                  event.preventDefault();
                  props.onClosePane(item.pane.id);
                }}
                onClick={() => props.onSelectPane(item.pane.id)}
              >
                {parent ? <ParentMark /> : null}
                <span class="hwc-tab-lines">
                  <span class="hwc-tab-label">{name}</span>
                  {props.multiSpace ? (
                    <span class="hwc-tab-space" title={space}>
                      {item.workspace.label}
                    </span>
                  ) : null}
                </span>
                <StatusIcon status={item.pane.agentStatus} />
              </button>
              {!closable ? null : (
                <button
                  type="button"
                  class="hwc-tab-close"
                  aria-label={
                    action === "exit" ? `${name} のエージェントを終了` : `${name} のペインを閉じる`
                  }
                  title={action === "exit" ? "エージェントを終了" : "ペインを閉じる"}
                  onClick={() => props.onClosePane(item.pane.id)}
                >
                  <CloseIcon size={12} />
                </button>
              )}
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
    </div>
  );
}
