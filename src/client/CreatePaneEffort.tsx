import type { AgentModel } from "../shared/agents";
import { CreatePaneSelect } from "./CreatePaneSelect";
import type { EffortCandidates } from "./launch-choice";

function effortNote(model: AgentModel | null, candidates: EffortCandidates): string | null {
  if (model === null) return "モデルを選択すると指定できます。";
  if (candidates === null) return "エフォートを取得できませんでした。";
  if (candidates?.length === 0) return "このモデルはエフォート指定に対応していません。";
  return null;
}

// 「デフォルト（CLI に任せる）」は出さない。effort に対応するモデルでは必ず選ぶ（docs/adr/agent-launch.md）。
export function CreatePaneEffort(props: {
  model: AgentModel | null;
  candidates: EffortCandidates;
  effort: string | null;
  // 選択中のモデルが既定のモデルのときの、既定の effort。選択肢に「（既定）」を添える。
  savedEffort: string | null;
  disabled: boolean;
  onChange: (effort: string) => void;
  onRetry: () => void;
}) {
  const efforts = Array.isArray(props.candidates) ? props.candidates : [];

  return (
    <div class="hwc-create-effort">
      <CreatePaneSelect
        label="エフォート"
        noteId="hwc-create-effort-note"
        note={effortNote(props.model, props.candidates)}
        loading={props.model !== null && props.candidates === undefined}
        value={props.effort ?? ""}
        disabled={props.disabled || efforts.length === 0}
        onRetry={props.candidates === null && !props.disabled ? props.onRetry : undefined}
        onChange={(value) => {
          if (efforts.includes(value)) props.onChange(value);
        }}
      >
        {/* 未選択の間だけ出す。選んでも何も変わらない。disabled にすると、モデルが未選択で
            ほかに選択肢が無いときに空欄で描かれる。 */}
        {props.effort === null ? (
          <option value="">{props.candidates?.length === 0 ? "なし" : "エフォートを選択"}</option>
        ) : null}
        {efforts.map((effort) => (
          <option key={effort} value={effort}>
            {effort === props.savedEffort ? `${effort}（既定）` : effort}
          </option>
        ))}
      </CreatePaneSelect>
    </div>
  );
}
