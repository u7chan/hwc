import type { PaneState } from "../server/herdr/state";
import { supportsChat } from "../shared/agents";

// hwc が作ったばかりのペイン。応答を受け取った時刻だけを持ち、起動が終わったかは
// スナップショットから導出する（記録そのものは期限まで残す）。
export type StartingPane = { paneId: string; at: number };

// 出力のポーリングは 2 秒なので、ペインを開いた直後の読み取りは起動前の画面（シェルの
// プロンプトと起動コマンド）のことがある。次の読み取りに 1 秒の余裕を足して起動待ちにする。
export const STARTING_SETTLE_MS = 3_000;

// エージェントが検出されないまま待ち続けない。過ぎたら開ける。起動しなかったペインを、
// hwc から操作できないままにしない。
export const STARTING_LIMIT_MS = 10_000;

export function paneStarting(starting: StartingPane | null, pane: PaneState, now: number): boolean {
  if (starting === null || starting.paneId !== pane.id) return false;
  const elapsed = now - starting.at;
  if (elapsed >= STARTING_LIMIT_MS) return false;
  if (elapsed < STARTING_SETTLE_MS) return true;
  // エージェントが検出されていない端末は、まだ Herdr がエージェントへ渡していない。
  // hwc からの文字はシェルに届くので、検出されるまでは開けない。
  if (pane.agent === null) return true;
  // 会話を読むエージェントは、セッションができるまで pane.chat が false のまま。
  // その間の端末出力は TUI の起動途中で、入力もシェルの形から切り替わる。
  // 会話が読めるまでは、起動待ちの表示を続ける。
  return supportsChat(pane.agent) && !pane.chat;
}
