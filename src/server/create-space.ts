import type { SpaceCreated } from "./herdr/contract";
import type { PaneClient } from "./herdr/panes";
import type { WorkspaceClient } from "./herdr/workspaces";

export type CreatedSpaceResult =
  | { ok: true; workspaceId: string; paneId: string }
  | { ok: false; error: "pane_rename_failed"; workspaceId: string; paneId: string };

// 作ったスペースの root ペインに名前を付ける。エージェントの起動は、ペインが
// スナップショットに現れてからクライアントが行う（ADR 0084）。
export async function nameRootPane(
  panes: Pick<PaneClient, "rename">,
  created: SpaceCreated,
  name: string | null,
): Promise<CreatedSpaceResult> {
  if (name === null) return { ok: true, ...created };
  try {
    await panes.rename({ paneId: created.paneId, label: name });
  } catch {
    // 名前は表示だけで、ペインと起動は続けられる。クライアントは理由を見せずに起動する。
    return { ok: false, error: "pane_rename_failed", ...created };
  }
  return { ok: true, ...created };
}

// ツリーで選んだディレクトリを作業ディレクトリにしたスペースを作る（ADR 0106）。
export async function createSpace(
  workspaces: Pick<WorkspaceClient, "create">,
  panes: Pick<PaneClient, "rename">,
  request: { cwd: string; label: string; name: string | null },
): Promise<CreatedSpaceResult> {
  const created = await workspaces.create({ cwd: request.cwd, label: request.label });
  return nameRootPane(panes, created, request.name);
}
