import {
  agentNameForPane,
  isAgentNotReady,
  isAgentPaneBusy,
  type PaneClient,
  restartAgentName,
  type SplitRequest,
  type StartRequest,
} from "./herdr/panes";
import { planSplit } from "./herdr/split";
import { supportsModelSelection } from "../shared/agents";
import type { AgentModelsClient } from "./agent-models";
import type { PiDefaultsStore } from "./pi-defaults";

// 起動の前後でだけ預かりを置き引きする。表示の解決は既定モデルの口が持つ。
export type DefaultLaunchTracker = Pick<PiDefaultsStore, "remember" | "forget">;

type CreationClient = Pick<PaneClient, "layout" | "split" | "startAgent" | "rename" | "directory">;

// 分割で作ったペインと、Herdr が作った root pane の両方に使う。ペインは既にある前提で、
// エージェントの起動と表示名の付与だけを行う。
export type SetupClient = Pick<PaneClient, "startAgent" | "rename" | "directory">;

// hwc が所有する Claude の設定ファイルを用意し、そのパスを返す。ユーザーの設定は触らない。
export type ClaudeSettingsProvider = () => Promise<string>;

export type PaneSetupFailure = "agent_start_failed" | "pane_rename_failed";

// エージェント名と、シェルの準備待ちを見るか。分割直後か、既存のシェルかで変わる。
export type SetupOptions = { agentName: string; waitForShell: boolean };

type CreatePaneResult =
  | { ok: true; paneId: string }
  | { ok: false; error: "pane_limit" }
  | { ok: false; error: PaneSetupFailure; paneId: string };

export async function createPane(
  panes: CreationClient,
  paneId: string,
  request: SplitRequest,
  models?: AgentModelsClient,
  piDefaults?: DefaultLaunchTracker,
  claudeSettings?: ClaudeSettingsProvider,
): Promise<CreatePaneResult> {
  const layout = await panes.layout({ paneId });
  const plan = planSplit(layout.cells);
  if (plan === null) return { ok: false, error: "pane_limit" };

  const created = await panes.split(plan);
  const error = await setupPane(
    panes,
    created.paneId,
    request,
    models,
    piDefaults,
    undefined,
    claudeSettings,
  );

  return error === null
    ? { ok: true, paneId: created.paneId }
    : { ok: false, error, paneId: created.paneId };
}

// 既存のシェルペインで起動する。ペインは作らないので、分割も名前の付け直しもしない。
export async function startAgentInPane(
  panes: SetupClient,
  paneId: string,
  request: StartRequest,
  models?: AgentModelsClient,
  piDefaults?: DefaultLaunchTracker,
  claudeSettings?: ClaudeSettingsProvider,
): Promise<PaneSetupFailure | null> {
  return setupPane(
    panes,
    paneId,
    { name: null, agent: request.agent, model: request.model, effort: request.effort },
    models,
    piDefaults,
    { agentName: restartAgentName(paneId), waitForShell: request.waitForShell },
    claudeSettings,
  );
}

// 起動に失敗しても、作成済みのペインは表示名を付けて残す。
export async function setupPane(
  panes: SetupClient,
  paneId: string,
  request: SplitRequest,
  models?: AgentModelsClient,
  piDefaults?: DefaultLaunchTracker,
  options: SetupOptions = { agentName: agentNameForPane(paneId), waitForShell: true },
  claudeSettings?: ClaudeSettingsProvider,
): Promise<PaneSetupFailure | null> {
  let error: PaneSetupFailure | null = null;

  if (request.agent !== null) {
    // 既定モデルの預かりは、エージェントが検出されて会話の取得が始まる前に置く。
    // 起動後に置くと、名前の付け直しを待つ間の最初の取得が預かりより先に届く。
    const defaultLaunch = request.agent === "pi" && request.model == null;
    if (defaultLaunch) piDefaults?.remember(paneId);
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
      if (request.agent === "claude" && claudeSettings !== undefined) {
        // 応答待ちを読むための hook。足せなくても起動は続け、カードが出ず端末出力のままになる。
        const settings = await claudeSettings().catch(() => null);
        if (settings !== null) args = ["--settings", settings, ...(args ?? [])];
      }
      await panes.startAgent({
        paneId,
        kind: request.agent,
        // 表示名は日本語や空白を許すため、Herdr のエージェント名には使わない。
        name: options.agentName,
        // 待つのは分割直後だけ。既存のシェルでは待たずに拒否を返す。
        ...(options.waitForShell ? {} : { waitForShell: false }),
        ...(args === undefined ? {} : { args }),
      });
    } catch (failure) {
      // 既存のシェルで前景のコマンドが動いている。呼び出し側が 409 として返せるようにする。
      if (defaultLaunch && !isAgentNotReady(failure)) piDefaults?.forget(paneId);
      if (!options.waitForShell && isAgentPaneBusy(failure)) throw failure;
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
