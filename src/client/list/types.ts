import type { AppState } from "../../server/herdr/state";
import type { PullRequest } from "../../shared/pull-request";
import type { ListScope } from "../scope";

export type PaneListProps = {
  state: AppState;
  selectedPaneId: string | null;
  parentPaneIds: ReadonlySet<string>;
  scope: ListScope;
  onScope: (scope: ListScope) => void;
  expanded: ReadonlySet<string>;
  onSelect: (paneId: string) => void;
  onOpen: (paneId: string) => void;
  // 一覧の行からのドラッグ。押した時点の位置だけを渡し、移動量で開始を判定する。
  onDragStart: (event: PointerEvent, paneId: string) => void;
  // 帯から「すべて」のその場所へ移る。スコープの切り替えは PaneList が先に行う。
  onRevealWorkspace: (workspaceId: string) => void;
  reveal: { workspaceId: string; token: number } | null;
  // 作ったばかりのペインを一覧で見せる。作ったときのスコープの中でだけ働かせ、
  // 別のスコープの保存位置は動かさない。
  scrollTo: { paneId: string; scope: ListScope; token: number } | null;
  onToggle: (groupId: string) => void;
  openPaneMenuId: string | null;
  openWorkspaceMenuId: string | null;
  onPaneMenu: (paneId: string, trigger: HTMLElement) => void;
  onWorkspaceMenu: (workspaceId: string, trigger: HTMLElement) => void;
  // 削除の対象。leave になったら一覧から行を消すアニメーションを見せ、終わったら
  // onRemovalFinished を呼ぶ。スナップショットは App がその間だけ保留している。
  removal: {
    workspaceId: string;
    phase: "confirm" | "busy" | "failed" | "leave";
  } | null;
  onRemovalFinished: () => void;
  // 一覧の束を Herdr のワークスペース順で動かす。成功したら true。
  onMoveWorkspaces: (
    workspaceIds: readonly string[],
    beforeWorkspaceId: string | null,
  ) => Promise<boolean>;
  // メニューの「先頭へ移動」。token が変わるたびに 1 回だけ処理する。
  moveToTop: { workspaceId: string; token: number } | null;
  onMoveToTopHandled: () => void;
  // アクティブ一覧の帯の並び。ドラッグで決めた順を BFF に預け、全端末で揃える。
  onReorderActive: (workspaceIds: readonly string[]) => Promise<boolean>;
  workingSince: ReadonlyMap<string, number>;
  finishedAt: ReadonlyMap<string, number>;
  pullRequests: ReadonlyMap<string, PullRequest | null>;
  now: number;
  // 一覧を畳むボタン。畳めない狭い画面では null。
  onCollapse: (() => void) | null;
};

export type ListFeedback = {
  onNotice: (text: string | null) => void;
  onAnnounce: (text: string) => void;
};

export type TreePaneListProps = Omit<PaneListProps, "scope" | "onScope" | "onOpen" | "onCollapse"> &
  ListFeedback;
