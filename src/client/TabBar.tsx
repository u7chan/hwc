import { useLayoutEffect, useRef, useState } from "preact/hooks";
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
  onDropPane: (paneId: string, targetPaneId: string, after: boolean) => void;
  onToggleSplit: () => void;
};

// 詳細の上端。ペインの切り替えと、分割表示の切り替えを持つ。
export function TabBar(props: TabBarProps) {
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
              data-dragging={draggedTab === item.id}
              data-drop={
                tabDrop?.paneId === item.id ? (tabDrop.after ? "after" : "before") : undefined
              }
              draggable
              onClick={() => props.onSelectPane(item.id)}
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
                if (moved && moved !== item.id) props.onDropPane(moved, item.id, after);
              }}
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
