import {
  agentNameForPane,
  isAgentNotReady,
  type PaneClient,
  type SplitRequest,
} from "./herdr/panes";
import { planSplit } from "./herdr/split";
import { supportsModelSelection } from "../shared/agents";
import type { AgentModelsClient } from "./agent-models";

type CreationClient = Pick<PaneClient, "layout" | "split" | "startAgent" | "rename" | "directory">;

// 分割で作ったペインと、Herdr が作った root pane の両方に使う。ペインは既にある前提で、
// エージェントの起動と表示名の付与だけを行う。
export type SetupClient = Pick<PaneClient, "startAgent" | "rename" | "directory">;

export type PaneSetupFailure = "agent_start_failed" | "pane_rename_failed";

type CreatePaneResult =
  | { ok: true; paneId: string }
  | { ok: false; error: "pane_limit" }
  | { ok: false; error: PaneSetupFailure; paneId: string };

export async function createPane(
  panes: CreationClient,
  paneId: string,
  request: SplitRequest,
  models?: AgentModelsClient,
): Promise<CreatePaneResult> {
  const layout = await panes.layout({ paneId });
  const plan = planSplit(layout.cells);
  if (plan === null) return { ok: false, error: "pane_limit" };

  const created = await panes.split(plan);
  const error = await setupPane(panes, created.paneId, request, models);

  return error === null
    ? { ok: true, paneId: created.paneId }
    : { ok: false, error, paneId: created.paneId };
}

// 起動に失敗しても、作成済みのペインは表示名を付けて残す。
export async function setupPane(
  panes: SetupClient,
  paneId: string,
  request: SplitRequest,
  models?: AgentModelsClient,
): Promise<PaneSetupFailure | null> {
  let error: PaneSetupFailure | null = null;

  if (request.agent !== null) {
    try {
      let args: string[] | undefined;
      if (request.model != null) {
        if (!models || !supportsModelSelection(request.agent))
          throw new Error("Model selection is unavailable");
        const directory = await panes.directory({ paneId });
        args = await models.startArgs(
          request.agent,
          request.model,
          directory,
          request.effort ?? null,
        );
      }
      if (request.agent === "codex") {
        // 共有デーモンのフックは別ペインの環境を引き継ぎ、会話 ID を誤ったペインに報告する。
        args = ["--no-daemon", ...(args ?? [])];
      }
      await panes.startAgent({
        paneId,
        kind: request.agent,
        // 表示名は日本語や空白を許すため、Herdr のエージェント名には使わない。
        name: agentNameForPane(paneId),
        ...(args === undefined ? {} : { args }),
      });
    } catch (failure) {
      // 初回の trust / login 待ちでもエージェント自体は起動している。
      if (!isAgentNotReady(failure)) error = "agent_start_failed";
    }
  }

  // 起動に失敗しても作成済みのペインは残し、指定された表示名を付ける。
  if (request.name !== null) {
    try {
      await panes.rename({ paneId, label: request.name });
    } catch {
      // 両方失敗した場合は、名前よりエージェントの起動失敗を優先して知らせる。
      error ??= "pane_rename_failed";
    }
  }

  return error;
}
