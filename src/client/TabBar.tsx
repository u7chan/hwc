import type { ComponentChildren } from "preact";
import { useLayoutEffect, useRef } from "preact/hooks";
import type { PaneProcess } from "../shared/panes";
import type { TabSide } from "./split-view";
import { ChevronLeftIcon, CloseIcon, EyeIcon, paneKindIcon } from "./icons";
import { paneTabName } from "./process";
import {
  activeRowName,
  agentGlyph,
  shortenSpaceName,
  statusLabel,
  tabDisplayName,
  tabLabel,
  tabLabelText,
  type PaneRow,
} from "./select";
import { StatusIcon } from "./StatusLabel";

type TabBarProps = {
  // タブバーの表示順。
  tabs: readonly PaneRow[];
  // 固定ゾーンの並び。タブの左端のバーをスロット色にするためにだけ使う。
  slots: readonly (string | null)[];
  currentPaneId: string | null;
  // 複数スペースのペインが開いているとき、タブの名前へスペース名を前置きする。
  multiSpace: boolean;
  parentPaneIds: ReadonlySet<string>;
  // シェルで動いているコマンド。タブ名をコマンドに差し替えるためだけに使う。
  processes: ReadonlyMap<string, PaneProcess>;
  // 開いているプレビュー。ペインではないので、選択と表示だけを別に持つ。
  preview: { name: string; selected: boolean } | null;
  status: ComponentChildren;
  // 外すアニメーションを見せているタブ。縮み終わったら onLeaveFinished を呼ぶ。
  leavingPaneId: string | null;
  onSelectPane: (paneId: string) => void;
  onRemoveTab: (paneId: string) => void;
  onLeaveFinished: (paneId: string) => void;
  onSelectPreview: () => void;
  onClosePreview: () => void;
  onBack: () => void;
  // タブからのドラッグ。移動量で開始を判定するので、押した時点で位置だけ渡す。
  onDragStart: (event: PointerEvent, paneId: string) => void;
  // 1 枚表示のとき、すべてのタブを並べ替えの落とし先にする。
  canReorder: boolean;
  // ドラッグ中の落とし先がタブのとき、そのペインと差し込み位置。side が null なら
  // 分割の入れ替えなので、枠を出す。
  tabDrop: { pane: string; side: TabSide | null } | null;
};

// 中クリックはブラウザのタブと同じく、その画面から外す操作にする。
const removeOnAuxClick =
  (remove: () => void) =>
  (event: MouseEvent): void => {
    if (event.button !== 1) return;
    event.preventDefault();
    remove();
  };

// 詳細の上端。開いたペインの履歴を並べ、タブから外す入口を添える。
export function TabBar(props: TabBarProps) {
  const tabList = useRef<HTMLDivElement>(null);

  // 選択中のタブが隠れていたら見える位置まで送る。プレビューを選んだときも、
  // 並べ替えて選択タブが画面外へ出たときも送る。並べ替えられるのは
  // PC の 1 枚表示だけなので、それ以外ではタブ順を依存に加えない。モバイルで
  // 未選択のタブを外しただけでスクロール位置を失わないため。
  const previewing = props.preview?.selected === true;
  const tabOrder = props.canReorder ? props.tabs.map((item) => item.pane.id).join(" ") : "";
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
  }, [props.currentPaneId, previewing, tabOrder]);

  // 外すタブは幅を詰めながら淡く消す。state への反映は App が完了後に 1 回だけ行う。
  const leaveFinished = useRef(props.onLeaveFinished);
  leaveFinished.current = props.onLeaveFinished;
  const leavingPaneId = props.leavingPaneId;
  useLayoutEffect(() => {
    if (leavingPaneId === null) return;
    const node = tabList.current?.querySelector<HTMLElement>('[data-leaving="true"]');
    let active = true;
    const finish = () => {
      if (!active) return;
      active = false;
      leaveFinished.current(leavingPaneId);
    };
    if (
      node == null ||
      typeof node.animate !== "function" ||
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ) {
      finish();
      return;
    }

    // タブの間隔も一緒に詰める。幅だけを 0 にすると、消えたあとに残る間隔のぶん
    // 隣のタブが飛ぶ。
    const list = tabList.current;
    const gap = list === null ? 0 : parseFloat(getComputedStyle(list).columnGap) || 0;
    node.style.overflow = "hidden";
    const animation = node.animate(
      [
        { width: `${node.offsetWidth}px`, marginLeft: "0px", opacity: 1 },
        { width: "0px", marginLeft: `${-gap}px`, opacity: 0 },
      ],
      { duration: 180, easing: "cubic-bezier(0.4, 0, 0.2, 1)", fill: "forwards" },
    );
    void animation.finished.then(finish, finish);
    return () => {
      active = false;
    };
  }, [leavingPaneId]);

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
      <div
        class="hwc-tabs"
        role="tablist"
        aria-label="開いているペイン"
        data-tab-list="true"
        ref={tabList}
      >
        {props.tabs.map((item) => {
          const selected = !previewing && item.pane.id === props.currentPaneId;
          const leaving = item.pane.id === props.leavingPaneId;
          const parent = props.parentPaneIds.has(item.pane.id);
          const process = props.processes.get(item.pane.id) ?? null;
          const space = shortenSpaceName(item.workspace);
          const name = tabDisplayName(
            activeRowName(item.workspace.label, paneTabName(item.pane, process)),
            item.workspace,
          );
          const label = tabLabel(space, name, props.multiSpace);
          const shownName = tabLabelText(label);
          // タブにはプログラム名だけを出す。何を動かしているかは、ホバーと読み上げで補う。
          const command = process?.running === true ? process.command : null;
          const detail = command === null ? shownName : `${shownName} (${command})`;
          const spaceInfo = `${item.workspace.label} · ${item.tab.label || item.tab.id}`;
          const description = `${spaceInfo}、${item.pane.id}、${statusLabel(item.pane.agentStatus)}`;
          const slot = props.slots.indexOf(item.pane.id);
          // 分割では固定ゾーンのタブ、1 枚表示ではすべてのタブが落とし先になる。
          // プレビュー中はグリッドが見えないので、レイアウトを
          // 変える落とし先にしない。
          const droppable = !previewing && (slot >= 0 || props.canReorder);
          const drop = droppable && props.tabDrop?.pane === item.pane.id ? props.tabDrop : null;
          return (
            <div
              class="hwc-tab-item"
              key={item.pane.id}
              data-tab-pane={item.pane.id}
              data-selected={selected}
              data-slot={slot >= 0 ? slot + 1 : undefined}
              data-drop-tab={droppable ? item.pane.id : undefined}
              data-drop-target={drop !== null && drop.side === null ? "true" : undefined}
              data-insert={drop?.side ?? undefined}
              data-leaving={leaving ? "true" : undefined}
              inert={leaving}
            >
              <button
                type="button"
                role="tab"
                class="hwc-tab"
                aria-selected={selected}
                aria-label={`${parent ? "親ペイン、" : ""}${detail} (${description})`}
                title={`${detail} (${description})`}
                data-pane-id={item.pane.id}
                onPointerDown={(event) => props.onDragStart(event, item.pane.id)}
                onAuxClick={removeOnAuxClick(() => props.onRemoveTab(item.pane.id))}
                onClick={() => props.onSelectPane(item.pane.id)}
              >
                <span class="hwc-tab-icon" data-agent={agentGlyph(item.pane.agent)}>
                  {paneKindIcon(item.pane)}
                </span>
                <span class="hwc-tab-label">
                  {label.space === null ? null : (
                    <>
                      <span class="hwc-tab-space">{label.space}</span>
                      <span class="hwc-tab-sep" aria-hidden="true">
                        ›
                      </span>
                    </>
                  )}
                  <span class="hwc-tab-name">{label.name}</span>
                </span>
                <StatusIcon status={item.pane.agentStatus} />
              </button>
              <button
                type="button"
                class="hwc-tab-close"
                aria-label={`${label.name} をタブから外す`}
                title="タブから外す"
                onClick={() => props.onRemoveTab(item.pane.id)}
              >
                <CloseIcon size={12} />
              </button>
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
              onAuxClick={removeOnAuxClick(props.onClosePreview)}
            >
              <EyeIcon size={14} />
              <span class="hwc-tab-label">
                <span class="hwc-tab-name">{props.preview.name}</span>
              </span>
            </button>
            <button
              type="button"
              class="hwc-tab-close"
              aria-label="プレビューを閉じる"
              title="プレビューを閉じる"
              onClick={props.onClosePreview}
            >
              <CloseIcon size={12} />
            </button>
          </div>
        )}
      </div>
      {props.status}
    </div>
  );
}
