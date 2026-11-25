import { useLayoutEffect, useRef, useState } from "preact/hooks";
import { ChevronLeftIcon } from "./icons";
import { ActivePaneList, NoPanes, spaceId } from "./list/active";
import type { ListFeedback } from "./list/types";
import { moveToTopPlan, orderUnits, unitIndex } from "./order";
import { ScopeBar } from "./list/scope";
import { TreePaneList } from "./list/tree";
import type { PaneListProps } from "./list/types";
import { activeGroups, type ActiveGroup, type ListScope } from "./scope";
import { revealScrollDelta } from "./scroll";
import { countPanes, groupWorkspaces } from "./select";

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

  // 一覧の知らせは両方のスコープで 1 か所に出す。並べ替えの失敗も先頭移動の失敗も
  // 同じ面に落とす。ツリーはドラッグから、ここはメニューから書く。
  const [notice, setNotice] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const feedback: ListFeedback = { onNotice: setNotice, onAnnounce: setAnnouncement };

  // メニューの「先頭へ移動」で、状態が新しい順序で描かれる前の位置を控える。
  const pendingMove = useRef<{
    order: string;
    workspaceId: string;
    offsets: ReadonlyMap<string, number>;
  } | null>(null);
  const handledMove = useRef(0);
  const orderKey = props.state.workspaces.map((workspace) => workspace.id).join("\n");

  const readOffsets = (): ReadonlyMap<string, number> => {
    const offsets = new Map<string, number>();
    for (const node of scroll.current?.querySelectorAll<HTMLElement>("[data-order-key]") ?? []) {
      const key = node.dataset.orderKey;
      if (key !== undefined) offsets.set(key, node.offsetTop);
    }
    return offsets;
  };

  // 送る単位はドラッグと同じリポジトリ束。メニューはワークスペースを指すが、
  // 1 つだけ動かすと「すべて」の束が割れる。
  useLayoutEffect(() => {
    const request = props.moveToTop;
    if (request === null || handledMove.current === request.token) return;
    handledMove.current = request.token;
    const plan = moveToTopPlan(
      orderUnits(groupWorkspaces(props.state.workspaces), props.state.workspaces),
      request.workspaceId,
    );
    if (plan === null) {
      props.onMoveToTopHandled();
      return;
    }
    const label =
      props.state.workspaces.find((workspace) => workspace.id === request.workspaceId)?.label ?? "";
    pendingMove.current = {
      order: orderKey,
      workspaceId: request.workspaceId,
      offsets: readOffsets(),
    };
    // 要求は 1 回で使い切る。一覧が作り直されたときに、古い要求で動かさない。
    props.onMoveToTopHandled();
    setNotice(null);
    void props.onMoveWorkspaces(plan.ids, plan.beforeWorkspaceId).then(
      (ok) => {
        if (ok) setAnnouncement(`${label} を先頭に移動しました`);
        else {
          pendingMove.current = null;
          setNotice("並べ替えを保存できませんでした。");
        }
      },
      () => {
        pendingMove.current = null;
        setNotice("並べ替えを保存できませんでした。");
      },
    );
  }, [props.moveToTop]);

  // 先頭へ動いた束を、動く前の位置から新しい位置へ滑らせる。行と同じく、
  // 位置は offsetTop なのでスクロール位置に影響されない。
  useLayoutEffect(() => {
    const pending = pendingMove.current;
    if (pending === null || pending.order === orderKey) return;

    const units = orderUnits(groupWorkspaces(props.state.workspaces), props.state.workspaces);
    const index = unitIndex(units, pending.workspaceId);
    // 移動した束が消えたら、もう動かせない。保留を捨てる。
    if (index === null) {
      pendingMove.current = null;
      return;
    }
    // まだ先頭でないなら、作成・削除など別の変化で順序が変わっただけ。ここで保留を
    // 消すと、同じ移動の結果が届いたときに FLIP が出ない。位置を控え直して待つ。
    if (index > 0) {
      pendingMove.current = { ...pending, order: orderKey, offsets: readOffsets() };
      return;
    }
    pendingMove.current = null;
    const node = scroll.current;
    const bodyNode = body.current;
    if (node === null || bodyNode === null) return;

    const sections = Array.from(node.querySelectorAll<HTMLElement>("[data-order-key]"));
    const first = sections[0];
    // メニューを押した帯があれば、そのカードを浮かせる。ツリーでは動いたブロックが先頭。
    const liftedNode =
      sections.find((section) => section.dataset.orderKey === pending.workspaceId) ?? first;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    // 先頭へ移った束は、スクロールしていると画面の外に残る。先頭に寄せて結果を見せる。
    if (first !== undefined && first.offsetTop < node.scrollTop) {
      const padding = Number.parseFloat(getComputedStyle(bodyNode).paddingTop) || 0;
      node.scrollTo({
        top: Math.max(0, first.offsetTop - padding),
        behavior: reduced ? "auto" : "smooth",
      });
    }
    if (reduced) return;

    for (const section of sections) {
      const key = section.dataset.orderKey;
      const before = key === undefined ? undefined : pending.offsets.get(key);
      if (before === undefined) continue;
      const delta = before - section.offsetTop;
      if (Math.abs(delta) < 1 || typeof section.animate !== "function") continue;

      const lifted = section === liftedNode;
      section.style.position = "relative";
      section.style.zIndex = lifted ? "2" : "1";
      if (lifted) section.dataset.reorderLifted = "true";
      const cleanup = () => {
        section.style.position = "";
        section.style.zIndex = "";
        delete section.dataset.reorderLifted;
      };
      const animation = section.animate(
        [{ transform: `translateY(${delta}px)` }, { transform: "none" }],
        { duration: 220, easing: "cubic-bezier(0.2, 0, 0, 1)" },
      );
      animation.onfinish = cleanup;
      animation.oncancel = cleanup;
    }
  });

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

  // 作ったばかりのペインは、一覧の見える位置へ一度だけ送る。すでに見えている行は
  // 動かさない。行がまだ描かれていない（起動中のエージェントをアクティブで待つ間）
  // ときは、次のスナップショットで探し直す。
  const scrolled = useRef<number | null>(null);
  useLayoutEffect(() => {
    const request = props.scrollTo;
    const node = scroll.current;
    if (request === null || node === null) return;
    if (scrolled.current === request.token) return;
    // 別のスコープへ移ったら捨てる。作ったときのスコープの位置だけを動かす。
    if (props.scope !== request.scope) {
      scrolled.current = request.token;
      return;
    }
    const row = node.querySelector<HTMLElement>(`[data-pane-id="${request.paneId}"]`);
    if (row === null) return;
    scrolled.current = request.token;
    // 畳んだ束の中の行は切り取られて見えない。開くまで送り先が決まらないので、何もしない。
    if (row.closest('[data-open="false"]') !== null) return;
    // アクティブの帯は上端に貼り付いて行を覆う。上へ送るときは帯の高さを空ける。
    const inset =
      props.scope === "active"
        ? (node.querySelector<HTMLElement>(".hwc-active-band")?.offsetHeight ?? 0)
        : 0;
    const delta = revealScrollDelta(
      row.getBoundingClientRect(),
      node.getBoundingClientRect(),
      inset,
    );
    if (delta !== 0) node.scrollTop += delta;
  }, [props.scrollTo, props.state, props.scope]);

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
      <div class="hwc-list-head">
        {props.onCollapse === null ? null : (
          <button
            type="button"
            class="hwc-sidebar-toggle"
            aria-label="一覧を閉じる"
            aria-controls="hwc-sidebar"
            aria-expanded="true"
            onClick={props.onCollapse}
          >
            <ChevronLeftIcon size={20} />
          </button>
        )}
        <ScopeBar scope={props.scope} count={groups.length} onScope={changeScope} />
      </div>
      <div class="hwc-list-scroll" ref={scroll}>
        <div class="hwc-list-body" ref={body}>
          {notice === null ? null : (
            <p class="hwc-list-notice" role="alert">
              {notice}
            </p>
          )}
          <p class="hwc-visually-hidden" role="status">
            {announcement}
          </p>
          {renderList({ ...props, onRevealWorkspace: revealWorkspace }, groups, feedback)}
        </div>
      </div>
    </>
  );
}

// 並べ方の分岐はここ 1 か所。active の行はツリーと前提が違う。
function renderList(props: PaneListProps, groups: readonly ActiveGroup[], feedback: ListFeedback) {
  switch (props.scope) {
    case "active":
      return <ActivePaneList {...props} groups={groups} />;
    case "all":
      return <TreePaneList {...props} {...feedback} />;
  }
}
