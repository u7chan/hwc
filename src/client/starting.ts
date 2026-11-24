import type { PaneState } from "../server/herdr/state";
import type { AgentKind, AgentModel } from "../shared/agents";
import { supportsChat } from "../shared/agents";
import type { StartAgentFailure } from "./requests/panes";
import { INVALID_REQUEST_NOTICE, PANE_NOT_FOUND_NOTICE } from "./failure-text";

// hwc が起動を頼んだペイン。ダイアログで選んだ内容だけを持ち、起動したかどうかの正は
// スナップショット（pane.agent / pane.chat）に置く。at は要求が終わった時刻で、
// waiting の間は使わない。
export type PaneLaunch = {
  paneId: string;
  at: number;
  agent: AgentKind;
  model: AgentModel | null;
  effort: string | null;
  // waiting: 新しいペインがスナップショットに現れるのを待っている。started / failed: 応答済み。
  request: "waiting" | "started" | "failed";
  // 分割直後のペインは、シェルが起動を受け付けるまで agent.start が busy を返す。
  waitForShell: boolean;
  error: StartAgentFailure | null;
};

export type LaunchPhase = "launching" | "ready" | "failed" | "unknown";

// ダイアログが作った起動の指定。要求そのものは App が、ペインがスナップショットに
// 現れてから出す。
export type LaunchIntent = {
  agent: AgentKind;
  model: AgentModel | null;
  effort: string | null;
  waitForShell: boolean;
};

export type PaneLaunchView = {
  phase: LaunchPhase;
  agent: AgentKind;
  model: AgentModel | null;
  effort: string | null;
  error: StartAgentFailure | null;
};

// 出力のポーリングは 2 秒なので、起動応答の直後は起動前の画面（シェルのプロンプトと
// 起動コマンド）のことがある。次の読み取りに 1 秒の余裕を足して起動待ちにする。
export const STARTING_SETTLE_MS = 3_000;

// 起動応答の後、エージェントも会話も現れないまま待ち続けない。過ぎたら「確認できない」へ移し、
// 再試行するかシェルとして使うかを選ばせる。
export const STARTING_LIMIT_MS = 10_000;

export function launchPhase(
  launch: PaneLaunch | null,
  pane: PaneState,
  now: number,
): LaunchPhase | null {
  if (launch === null || launch.paneId !== pane.id) return null;
  if (launch.request === "waiting") return "launching";
  const elapsed = now - launch.at;
  // 起動要求の結果よりスナップショットを優先する。timeout の後に実は起動していた、
  // 別の経路で起動済みだった、を拾う。
  const ready = pane.agent !== null && (!supportsChat(pane.agent) || pane.chat);
  if (ready) {
    // 応答の時点でエージェントは検出済みでも、hwc が読んでいる画面は起動前のことがある。
    // 本文と入力の形が入れ替わるまで待つ。
    if (launch.request === "started" && elapsed < STARTING_SETTLE_MS) return "launching";
    return "ready";
  }
  // 起動していないことが分かっている。エージェントが検出されている場合だけ、
  // 会話が読めるまでの猶予を置く。
  if (launch.request === "failed") {
    if (pane.agent === null) return "failed";
    return elapsed < STARTING_LIMIT_MS ? "launching" : "unknown";
  }
  // エージェントが検出されない端末は、まだ Herdr がエージェントへ渡していない。
  // hwc からの文字はシェルに届くので、検出されるまでは開かない。
  return elapsed < STARTING_LIMIT_MS ? "launching" : "unknown";
}

// 起動できなかった理由。ペインの起動待ちの行に出す。
export function launchFailureMessage(error: StartAgentFailure | null): string {
  switch (error) {
    case "pane_busy":
      return "コマンドが動いています。停止してからもう一度お試しください。";
    case "pane_not_shell":
      return "このペインではすでにエージェントが動いています。";
    case "pane_not_found":
      return PANE_NOT_FOUND_NOTICE;
    case "invalid_request":
      return INVALID_REQUEST_NOTICE;
    case "timeout":
      return "起動できたか確認できませんでした。ペインの状態を見てから、必要ならもう一度お試しください。";
    case "agent_start_failed":
      return "エージェントを起動できませんでした。ペインはシェルのまま残っています。";
    default:
      return "エージェントを起動できませんでした。もう一度お試しください。";
  }
}
