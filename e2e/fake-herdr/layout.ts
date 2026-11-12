import type { HerdrPane } from "../../src/server/herdr/contract";
import type { FakeContext } from "./context";

// 実 Herdr の分割結果そのものではなく、E2E でセルの形を返すための固定のグリッド。
// 方向や比率の正しさは BFF の unit で確かめ、ここでは画面の流れだけを通す。
const paneArea = { width: 240, height: 48 };

export function createLayout(ctx: FakeContext) {
  const { snapshot, outputs, revisions, findPane } = ctx;

  const layout = (paneId: string) => {
    const pane = findPane(paneId);
    if (pane === null) return null;
    const panes = (snapshot.panes ?? []).filter((item) => item.tab_id === pane.tab_id);
    return {
      type: "pane_layout",
      layout: {
        workspace_id: pane.workspace_id,
        tab_id: pane.tab_id,
        zoomed: false,
        area: { x: 0, y: 0, ...paneArea },
        focused_pane_id: snapshot.focused_pane_id ?? pane.pane_id,
        panes: panes.map((item, index) => ({
          pane_id: item.pane_id,
          focused: item.pane_id === snapshot.focused_pane_id,
          rect: {
            x: Math.floor((paneArea.width * index) / panes.length),
            y: 0,
            width:
              Math.floor((paneArea.width * (index + 1)) / panes.length) -
              Math.floor((paneArea.width * index) / panes.length),
            height: paneArea.height,
          },
        })),
        splits: [],
      },
    };
  };

  const splitPane = (paneId: string): HerdrPane | null => {
    const target = findPane(paneId);
    if (target === null) return null;
    const next =
      Math.max(
        0,
        ...(snapshot.panes ?? [])
          .filter((pane) => pane.workspace_id === target.workspace_id)
          .map((pane) => Number(pane.pane_id.split(":").at(-1)?.replace("p", "") ?? 0)),
      ) + 1;
    const created: HerdrPane = {
      pane_id: `${target.workspace_id}:p${next}`,
      workspace_id: target.workspace_id,
      tab_id: target.tab_id,
      cwd: target.cwd ?? null,
      label: null,
      agent_status: "unknown",
      focused: false,
      agent_session: null,
    };
    snapshot.panes = [...(snapshot.panes ?? []), created];
    outputs.set(created.pane_id, "");
    revisions.set(created.pane_id, 0);
    return created;
  };

  return { layout, splitPane };
}

export type Layout = ReturnType<typeof createLayout>;
