import type { ComponentChildren } from "preact";
import { useLayoutEffect, useRef } from "preact/hooks";
import type { PaneProcess } from "../shared/panes";
import { PREVIEW_TAB, type TabSide } from "./split-view";
import { ChevronLeftIcon, CloseIcon, EyeIcon, paneKindIcon } from "./icons";
import { paneTabName } from "./process";
import {
  agentGlyph,
  shortenPaneName,
  shortenSpaceName,
  statusLabel,
  tabLabel,
  tabLabelText,
  type PaneRow,
} from "./select";
import { StatusIcon } from "./StatusLabel";

// タブ列の中身。プレビューはペインではないので、行ではなく種別で持つ。
export type TabItem = { kind: "pane"; row: PaneRow } | { kind: "preview"; name: string };

type TabBarProps = {
  // このセルの識別子。タブの増減では変わらないので、FLIP の照合に使う。
  leafId: string;
  // このセルのタブ。並びが正で、active は currentPaneId。
  tabs: readonly TabItem[];
  // このセルの active。フォーカスの有無とは別に、セルの中で選ばれているタブ。
  currentPaneId: string;
  // current を含むセルか。選択面の強さを変える。
  focused: boolean;
  // このセルのタブに複数スペースが混ざっているときだけ、名前へスペース名を前置きする。
  multiSpace: boolean;
  parentPaneIds: ReadonlySet<string>;
  // シェルで動いているコマンド。タブ名をコマンドに差し替えるためだけに使う。
  processes: ReadonlyMap<string, PaneProcess>;
  // 狭い画面でだけ出す接続の表示。
  status: ComponentChildren;
  // 外すアニメーションを見せているタブ。縮み終わったら onLeaveFinished を呼ぶ。
  leavingPaneId: string | null;
  onSelectPane: (paneId: string) => void;
  onRemoveTab: (paneId: string) => void;
  onLeaveFinished: (paneId: string) => void;
  onSelectPreview: () => void;
  onClosePreview: () => void;
  // 狭い画面だけ。PC では一覧が横にあるので出さない。
  onBack: (() => void) | null;
  // タブからのドラッグ。移動量で開始を判定するので、押した時点で位置だけ渡す。
  onDragStart: (event: PointerEvent, paneId: string) => void;
  // ドラッグ中の差し込み位置。side は対象タブの前か後ろ。
  tabDrop: { pane: string; side: TabSide } | null;
};

// 中クリックはブラウザのタブと同じく、その画面から外す操作にする。
const removeOnAuxClick =
  (remove: () => void) =>
  (event: MouseEvent): void => {
    if (event.button !== 1) return;
    event.preventDefault();
    remove();
  };

// タブ列は横にあふれるとスクロール容器になり、その上の中クリックはブラウザの
// オートスクロールを始める。始まると auxclick が届かず外せないので、mousedown で止める。
const suppressAutoscroll = (event: MouseEvent): void => {
  if (event.button === 1) event.preventDefault();
};

const tabId = (item: TabItem): string => (item.kind === "pane" ? item.row.pane.id : PREVIEW_TAB);

// セルの上端のタブ列。開いたペインの履歴を並べ、タブから外す入口を添える。
export function TabBar(props: TabBarProps) {
  const tabList = useRef<HTMLDivElement>(null);

  // 選択中のタブが隠れていたら見える位置まで送る。プレビューを選んだときも、
  // 並べ替えて選択タブが画面外へ出たときも送る。セルごとの列だが、各列が
  // 自分の選択タブだけを見る。
  const tabOrder = props.tabs.map(tabId).join(" ");
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
  }, [props.currentPaneId, tabOrder]);

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
    // 対象のタブを持っている列は 1 つだけ。他のセルの列は何もせず、アニメーションの
    // 完了か App の保険のタイマーに任せる。
    if (node == null) return;
    if (
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

  const firstPane = props.tabs.find((item) => item.kind === "pane");
  return (
    <div class="hwc-tabbar" data-multi-space={props.multiSpace} data-focused={props.focused}>
      {props.onBack === null ? null : (
        <button
          type="button"
          class="hwc-icon-button hwc-back"
          aria-label="一覧へ戻る"
          onClick={props.onBack}
        >
          <ChevronLeftIcon />
        </button>
      )}
      <div
        class="hwc-tabs"
        role="tablist"
        aria-label="このセルのタブ"
        data-tab-list={props.leafId}
        data-drop-list="true"
        data-drop-leaf={firstPane?.row.pane.id ?? PREVIEW_TAB}
        onMouseDown={suppressAutoscroll}
        ref={tabList}
      >
        {props.tabs.map((item) => {
          const id = tabId(item);
          if (item.kind === "preview") {
            const selected = props.currentPaneId === PREVIEW_TAB;
            const drop = props.tabDrop?.pane === PREVIEW_TAB ? props.tabDrop : null;
            return (
              <div
                class="hwc-tab-item"
                key={id}
                data-tab-pane={id}
                data-selected={selected}
                data-focused={props.focused}
                data-drop-tab={id}
                data-insert={drop?.side ?? undefined}
              >
                <button
                  type="button"
                  role="tab"
                  class="hwc-tab"
                  aria-selected={selected}
                  aria-label={`${item.name} のプレビュー`}
                  title={`${item.name} のプレビュー`}
                  onPointerDown={(event) => props.onDragStart(event, id)}
                  onAuxClick={removeOnAuxClick(props.onClosePreview)}
                  onClick={props.onSelectPreview}
                >
                  <EyeIcon size={14} />
                  <span class="hwc-tab-label">
                    <span class="hwc-tab-name">{item.name}</span>
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
            );
          }
          const row = item.row;
          const selected = id === props.currentPaneId;
          const leaving = id === props.leavingPaneId;
          const parent = props.parentPaneIds.has(id);
          const process = props.processes.get(id) ?? null;
          const space = shortenSpaceName(row.workspace);
          const name = shortenPaneName(paneTabName(row.pane, process), row.workspace);
          const label = tabLabel(space, name, props.multiSpace);
          const shownName = tabLabelText(label);
          // タブにはプログラム名だけを出す。何を動かしているかは、ホバーと読み上げで補う。
          const command = process?.running === true ? process.command : null;
          const detail = command === null ? shownName : `${shownName} (${command})`;
          const spaceInfo = `${row.workspace.label} · ${row.tab.label || row.tab.id}`;
          const description = `${spaceInfo}、${row.pane.id}、${statusLabel(row.pane.agentStatus)}`;
          const drop = props.tabDrop?.pane === id ? props.tabDrop : null;
          return (
            <div
              class="hwc-tab-item"
              key={id}
              data-tab-pane={id}
              data-selected={selected}
              data-focused={props.focused}
              data-drop-tab={id}
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
                data-pane-id={id}
                onPointerDown={(event) => props.onDragStart(event, id)}
                onAuxClick={removeOnAuxClick(() => props.onRemoveTab(id))}
                onClick={() => props.onSelectPane(id)}
              >
                <span class="hwc-tab-icon" data-agent={agentGlyph(row.pane.agent)}>
                  {paneKindIcon(row.pane)}
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
                <StatusIcon status={row.pane.agentStatus} />
              </button>
              <button
                type="button"
                class="hwc-tab-close"
                aria-label={`${label.name} をタブから外す`}
                title="タブから外す"
                onClick={() => props.onRemoveTab(id)}
              >
                <CloseIcon size={12} />
              </button>
            </div>
          );
        })}
      </div>
      {props.status}
    </div>
  );
}
