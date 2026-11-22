import type { PaneState } from "../server/herdr/state";
import type { AgentModel } from "../shared/agents";
import { claudeModelFamily } from "../shared/model-switch";
import type { EffortCandidates, ModelCandidates } from "./launch-choice";

// 切り替えられるのは、会話を読める Claude のペインが待機しているときだけ。実行中の応答に
// `/model` を重ねない。応答待ち（blocked）は、答えるまでほかの操作を受け付けない。
export function modelSwitchBlockReason(pane: PaneState): string | null {
  if (pane.agent !== "claude" || !pane.chat) return "このペインでは使えません";
  if (pane.agentStatus === "working") return "実行中は使えません";
  if (pane.agentStatus === "blocked") return "応答待ちの間は使えません";
  if (pane.agentStatus !== "idle" && pane.agentStatus !== "done") return "状態を確認できません";
  return null;
}

// 画面に出ている現在のモデルと同じ系統の候補を、最初の選択にする。起動時のエイリアスでも、
// 応答で確定した id（`claude-opus-5-5`）でも同じ候補に当たる。
export function currentCandidate(
  candidates: ModelCandidates,
  current: string | null,
): AgentModel | null {
  if (!Array.isArray(candidates) || current === null) return null;
  const family = claudeModelFamily(current);
  return family === null ? null : (candidates.find((candidate) => candidate.id === family) ?? null);
}

// 選んだモデルは、いまの候補にあるときだけ使う。無ければ現在のモデル。
export function chooseSwitchModel(
  candidates: ModelCandidates,
  chosen: AgentModel | null,
  current: string | null,
): AgentModel | null {
  if (!Array.isArray(candidates)) return null;
  const picked =
    chosen === null ? null : candidates.find((candidate) => candidate.id === chosen.id);
  return picked ?? currentCandidate(candidates, current);
}

// 選んだ effort は、モデルを変えても候補にあるあいだ持ち越す。無ければ現在の effort。
export function chooseSwitchEffort(
  candidates: EffortCandidates,
  chosen: string | null,
  current: string | null,
): string | null {
  if (!Array.isArray(candidates)) return null;
  const pick = (effort: string | null) =>
    effort !== null && candidates.includes(effort) ? effort : null;
  return pick(chosen) ?? pick(current);
}

// モデルを変えるときだけ出す。キャッシュはモデルごとなので、変えた次の 1 ターンは会話全体を
// 読み直す（実機 2.1.330 の確認ダイアログと公式の prompt caching の記述）。effort だけの変更は
// 5.5 系ではキャッシュが残るので出さない。
export const CACHE_WARNING =
  "モデルを変えると、次の応答は会話全体を読み直すため、遅くなり、使用量も増えます。";

// Claude Code は `/model` と `/effort` で選んだ値を、既定としても保存する。端末で起動した
// claude にも及ぶ。hwc から起動するときは起動時に値を指定するので、ここには及ばない。
export const DEFAULT_NOTE =
  "Claude の既定のモデルとエフォートも、この内容に更新されます。端末から起動する claude にも及びます。";

export function switchFailureNotice(status: number): string {
  if (status === 400) return "選んだ内容は使えません。選び直してください。";
  if (status === 409) return "今は切り替えられません。応答が終わってから、もう一度お試しください。";
  return "切り替えを確認できませんでした。端末で確かめてください。";
}
