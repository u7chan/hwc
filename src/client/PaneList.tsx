import { useLayoutEffect, useRef } from "preact/hooks";
import { ActivePaneList, NoPanes, spaceId } from "./list/active";
import { ScopeBar } from "./list/scope";
import { TreePaneList } from "./list/tree";
import type { PaneListProps } from "./list/types";
import { activeGroups, type ActiveGroup, type ListScope } from "./scope";
import { countPanes } from "./select";

// 一覧の上端は行の途中で止めない。位置を決め直したときに行が半分だけ見えると、
// 見出しのアイコンや案内線が切れて、壊れて見える。指で動かしている間は触らない。
// アクティブの行は対象にしない。帯が上端に貼り付いて行を覆うので、切れて見えない。
const LIST_ROWS = ".hwc-group-row, .hwc-tabrow, .hwc-pane";

function snapListTop(node: HTMLDivElement) {
  const top = node.getBoundingClientRect().top;
  for (const row of node.querySelectorAll<HTMLElement>(LIST_ROWS)) {
    // 閉じた束の中の行は高さ 0 の箱に切り取られて見えない。位置だけが残る。
    if (row.closest('[data-open="false"]') !== null) continue;
    const rect = row.getBoundingClientRect();
    if (rect.top < top && rect.bottom > top) {
      node.scrollTop += rect.top - top;
      return;
    }
  }
}

export function PaneList(props: PaneListProps) {
  // スコープごとの位置を控える。中身が総入れ替えになるので、ブラウザに任せると
  // 先頭や途中の位置へ飛ぶ。
  const scroll = useRef<HTMLDivElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const positions = useRef(new Map<ListScope, number>());

  const changeScope = (next: ListScope) => {
    if (scroll.current) positions.current.set(props.scope, scroll.current.scrollTop);
    props.onScope(next);
  };

  useLayoutEffect(() => {
    const node = scroll.current;
    if (node === null) return;
    node.scrollTop = positions.current.get(props.scope) ?? 0;
    snapListTop(node);
  }, [props.scope]);

  // 削除が確定した行は、高さを詰めながら淡く消す。行が途中で切り落とされないよう、
  // スナップショットの適用はアニメーションの完了を待ってから行う（App）。
  const removalFinished = useRef(props.onRemovalFinished);
  removalFinished.current = props.onRemovalFinished;
  const removalPhase = props.removal?.phase ?? null;
  const removalId = props.removal?.workspaceId ?? null;
  useLayoutEffect(() => {
    if (removalPhase !== "leave") return;
    const node = document.querySelector<HTMLElement>('[data-removal="leave"]');
    const finish = () => removalFinished.current();
    if (
      node === null ||
      typeof node.animate !== "function" ||
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ) {
      finish();
      return;
    }

    const style = getComputedStyle(node);
    node.style.overflow = "hidden";
    const animation = node.animate(
      [
        {
          height: `${node.offsetHeight}px`,
          marginTop: style.marginTop,
          marginBottom: style.marginBottom,
          opacity: 1,
        },
        { height: "0px", marginTop: "0px", marginBottom: "0px", opacity: 0 },
      ],
      { duration: 220, easing: "cubic-bezier(0.4, 0, 0.2, 1)", fill: "forwards" },
    );
    let active = true;
    const settle = () => {
      if (active) finish();
    };
    void animation.finished.then(settle, settle);
    return () => {
      active = false;
    };
  }, [removalId, removalPhase]);

  // 帯から移ったときは、そのスペースの見出しまで送る。スコープの復元より後に置き、
  // 復元した位置を上書きする。同じ要求で二度動かないよう、token で 1 回だけ処理する。
  const revealed = useRef<number | null>(null);
  useLayoutEffect(() => {
    const request = props.reveal;
    if (request === null || props.scope !== "all") return;
    if (revealed.current === request.token) return;
    revealed.current = request.token;

    const node = scroll.current;
    const bodyNode = body.current;
    const target = document.getElementById(spaceId(request.workspaceId));
    if (node === null || bodyNode === null || target === null) return;
    const padding = Number.parseFloat(getComputedStyle(bodyNode).paddingTop) || 0;
    const top =
      target.getBoundingClientRect().top - node.getBoundingClientRect().top + node.scrollTop;
    node.scrollTop = Math.max(0, top - padding);
    // 一覧の終わりが近いと、見出しを上端まで送れず上の行が切れる。切れた行の頭まで戻す。
    snapListTop(node);
    // キーボードでも続けられるよう、移動先の見出しへフォーカスを送る。次の Tab がメニュー。
    target.querySelector<HTMLElement>(".hwc-group")?.focus({ preventScroll: true });
  }, [props.scope, props.reveal]);

  if (countPanes(props.state) === 0) return <NoPanes />;

  // 件数は一覧に出ている帯（スペース）の数。行を数え直さず、同じ束をそのまま使う。
  const groups = activeGroups(props.state);

  // 帯からの移動は、いまの active の位置を控えてからスコープを切り替える。
  const revealWorkspace = (workspaceId: string) => {
    changeScope("all");
    props.onRevealWorkspace(workspaceId);
  };

  // セグメントと一覧のスクロール枠は分岐の外に置く。スコープを切り替えても同じ要素を
  // 使い続けるので、つまみが滑り、スクロール枠も作り直されない。
  return (
    <>
      <ScopeBar scope={props.scope} count={groups.length} onScope={changeScope} />
      <div class="hwc-list-scroll" ref={scroll}>
        <div class="hwc-list-body" ref={body}>
          {renderList({ ...props, onRevealWorkspace: revealWorkspace }, groups)}
        </div>
      </div>
    </>
  );
}

// 並べ方の分岐はここ 1 か所。active の行はツリーと前提が違う。
function renderList(props: PaneListProps, groups: readonly ActiveGroup[]) {
  switch (props.scope) {
    case "active":
      return <ActivePaneList {...props} groups={groups} />;
    case "all":
      return <TreePaneList {...props} />;
  }
}
