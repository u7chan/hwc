import { expect, test } from "bun:test";
import { type AppState, NO_TIMES, type PaneState } from "../server/herdr/state";
import { decideSnapshotApply, type SnapshotApplyInput } from "./snapshot-apply";
import type { SplitNode } from "./split-view";

const pane = (id: string): PaneState => ({
  id,
  title: null,
  label: null,
  agent: "pi",
  agentStatus: "idle",
  focused: false,
  chat: true,
});

const state = (paneIds: string[]): AppState => ({
  focusedWorkspaceId: "w1",
  focusedTabId: "w1:t1",
  focusedPaneId: paneIds[0] ?? null,
  activeOrder: [],
  times: NO_TIMES,
  workspaces: [
    {
      id: "w1",
      label: "hwc",
      agentStatus: "idle",
      focused: true,
      worktree: null,
      path: "/home/example/hwc",
      branch: "main",
      sync: null,
      tabs: [
        {
          id: "w1:t1",
          label: "main",
          agentStatus: "idle",
          focused: true,
          panes: paneIds.map(pane),
        },
      ],
    },
  ],
});

const NO_SPACES: AppState = {
  ...state([]),
  focusedWorkspaceId: null,
  focusedTabId: null,
  focusedPaneId: null,
  workspaces: [],
};

const tabLayout = (paneIds: string[]): SplitNode => ({
  kind: "leaf",
  id: "leaf-1",
  tabs: paneIds,
  active: paneIds[0],
});

const input = (overrides: Partial<SnapshotApplyInput> = {}): SnapshotApplyInput => ({
  next: state(["w1:p1", "w1:p2"]),
  removing: null,
  closing: null,
  leavingTab: false,
  layout: tabLayout(["w1:p1", "w1:p2"]),
  ...overrides,
});

// 何も動いていなければ、届いたスナップショットをそのまま適用する。
test("a snapshot goes straight in when nothing is animating", () => {
  expect(decideSnapshotApply(input())).toEqual({ kind: "apply" });
});

// 一覧の行が消える演出の間は、スナップショットを保留して演出を切り落とさない。
test("a snapshot is held while a removed row is still animating", () => {
  const removing = { target: { workspaceId: "w1" }, phase: "leave" } as const;
  expect(decideSnapshotApply(input({ removing }))).toEqual({ kind: "hold" });
  expect(decideSnapshotApply(input({ removing, leavingTab: true }))).toEqual({ kind: "hold" });
});

// 消えるタブの演出の間も同じく保留する。演出が終わると保留したものが適用される。
test("a snapshot is held while a tab is still leaving", () => {
  expect(decideSnapshotApply(input({ leavingTab: true }))).toEqual({ kind: "hold" });
});

// 削除の応答より先にスペースが消えたスナップショットが届くことがある。先に対象を
// 消して見せ、演出が終わってから適用する。
test("a snapshot that drops the space being removed starts the leave first", () => {
  const removing = { target: { workspaceId: "w1" }, phase: "busy" } as const;
  expect(decideSnapshotApply(input({ removing, next: NO_SPACES }))).toEqual({
    kind: "leave-space",
  });
});

// 削除の対象がまだ残っているスナップショットは、演出を始めずにそのまま適用する。
test("a snapshot that still has the space being removed is applied", () => {
  const removing = { target: { workspaceId: "w1" }, phase: "busy" } as const;
  expect(decideSnapshotApply(input({ removing }))).toEqual({ kind: "apply" });
  expect(
    decideSnapshotApply(input({ removing: { ...removing, phase: "confirm" }, next: NO_SPACES })),
  ).toEqual({ kind: "apply" });
});

// ペインを閉じる応答より先にペインが消えたら、消えるタブを先に見せてから適用する。
// 確認は閉じ、遅れて返る応答は捨てる（ペインが無い以上 close の目的は達している）。
test("a snapshot that drops a closing pane leaves the tab first", () => {
  const closing = {
    target: { paneId: "w1:p2", action: "close", next: "w1:p1" },
    phase: "busy",
  } as const;
  expect(decideSnapshotApply(input({ closing, next: state(["w1:p1"]) }))).toEqual({
    kind: "leave-tab",
    paneId: "w1:p2",
    successor: "w1:p1",
  });
});

// タブとして開いていないペインは演出できない。保留だけ残すと次のスナップショットまで
// 一覧が古いままになるので、演出を諦めてその場で適用する。
test("a closing pane that is not open as a tab is applied at once", () => {
  const closing = {
    target: { paneId: "w1:p2", action: "close", next: "w1:p1" },
    phase: "busy",
  } as const;
  const next = state(["w1:p1"]);
  expect(decideSnapshotApply(input({ closing, next, layout: tabLayout(["w1:p1"]) }))).toEqual({
    kind: "apply-now",
  });
  expect(decideSnapshotApply(input({ closing, next, layout: null }))).toEqual({
    kind: "apply-now",
  });
});

// exit は終了を頼むだけでペインは残る。消えるタブの演出は要らない。
test("an exit keeps the pane, so the snapshot is applied", () => {
  const closing = {
    target: { paneId: "w1:p1", action: "exit", next: null },
    phase: "busy",
  } as const;
  expect(decideSnapshotApply(input({ closing, next: state([]) }))).toEqual({ kind: "apply" });
});

// 閉じる応答を待つ間も、対象のペインがスナップショットに残っていれば適用する。
test("a snapshot that still has the closing pane is applied", () => {
  const closing = {
    target: { paneId: "w1:p2", action: "close", next: "w1:p1" },
    phase: "busy",
  } as const;
  expect(decideSnapshotApply(input({ closing }))).toEqual({ kind: "apply" });
});
