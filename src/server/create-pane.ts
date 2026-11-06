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

type CreatePaneResult =
  | { ok: true; paneId: string }
  | { ok: false; error: "pane_limit" }
  | { ok: false; error: "agent_start_failed" | "pane_rename_failed"; paneId: string };

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
  let error: "agent_start_failed" | "pane_rename_failed" | null = null;

  if (request.agent !== null) {
    try {
      let args: string[] | undefined;
      if (request.model != null) {
        if (!models || !supportsModelSelection(request.agent))
          throw new Error("Model selection is unavailable");
        const directory = await panes.directory({ paneId: created.paneId });
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
        paneId: created.paneId,
        kind: request.agent,
        // 表示名は日本語や空白を許すため、Herdr のエージェント名には使わない。
        name: agentNameForPane(created.paneId),
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
      await panes.rename({ paneId: created.paneId, label: request.name });
    } catch {
      // 両方失敗した場合は、名前よりエージェントの起動失敗を優先して知らせる。
      error ??= "pane_rename_failed";
    }
  }

  return error === null
    ? { ok: true, paneId: created.paneId }
    : { ok: false, error, paneId: created.paneId };
}
