import { type AgentKind, type AgentModel, claudeModelName, modelKey } from "../shared/agents";
import type { LaunchDefault } from "../shared/launch-defaults";
import { CreatePaneSelect } from "./CreatePaneSelect";
import { type ModelCandidates, sameModel } from "./launch-choice";

function modelNote(candidates: ModelCandidates): string | null {
  if (candidates === "opencode_not_running")
    return "OpenCode サービスを起動できませんでした。再取得すると起動し直します。";
  if (candidates === null) return "モデルを取得できませんでした。";
  if (candidates?.length === 0) return "選択できるモデルがありません。";
  return null;
}

// 「デフォルトモデル」（CLI に任せる）は出さない。候補を読めなければ選べず、起動もできない
// （ADR 0104）。
export function CreatePaneModel(props: {
  agent: AgentKind;
  candidates: ModelCandidates;
  model: AgentModel | null;
  saved: LaunchDefault | null;
  disabled: boolean;
  onChange: (model: AgentModel) => void;
  onRetry: () => void;
}) {
  const models = Array.isArray(props.candidates) ? props.candidates : [];
  const note = modelNote(props.candidates);
  // Claude の候補はエイリアスだけで、provider は常に `claude`。選択肢でも自分を二重に名乗らない。
  const label = (model: AgentModel) =>
    props.agent === "claude" ? claudeModelName(model.id) : modelKey(model);

  return (
    <div class="hwc-create-model">
      <CreatePaneSelect
        label="モデル"
        noteId="hwc-create-model-note"
        note={note}
        loading={props.candidates === undefined}
        value={props.model === null ? "" : modelKey(props.model)}
        disabled={props.disabled || models.length === 0}
        onRetry={note === null || props.disabled ? undefined : props.onRetry}
        onChange={(value) => {
          const selected = models.find((model) => modelKey(model) === value);
          if (selected !== undefined) props.onChange(selected);
        }}
      >
        {/* 未選択の間だけ出す。選んでも何も変わらない。disabled にすると、ほかに選択肢が
            無いときに空欄で描かれる。 */}
        {props.model === null ? <option value="">モデルを選択</option> : null}
        {models.map((model) => (
          <option key={modelKey(model)} value={modelKey(model)}>
            {props.saved !== null && sameModel(model, props.saved.model)
              ? `${label(model)}（既定）`
              : label(model)}
          </option>
        ))}
      </CreatePaneSelect>
    </div>
  );
}
