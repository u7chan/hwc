import { useEffect, useState } from "preact/hooks";
import {
  type AgentKind,
  type AgentModel,
  modelKey,
  supportsModelSelection,
} from "../shared/agents";
import { type AgentModelsRead, readAgentModels } from "./api";

export function CreatePaneModel(props: {
  paneId: string;
  agent: AgentKind;
  model: AgentModel | null;
  disabled: boolean;
  onChange: (model: AgentModel | null) => void;
}) {
  const [result, setResult] = useState<AgentModelsRead>();
  const models = Array.isArray(result) ? result : null;
  const supported = supportsModelSelection(props.agent);

  useEffect(() => {
    if (!supportsModelSelection(props.agent)) return;
    const controller = new AbortController();
    void readAgentModels(props.paneId, props.agent, controller.signal).then((value) => {
      if (!controller.signal.aborted) setResult(value);
    });
    return () => controller.abort();
  }, [props.paneId, props.agent]);

  const note = !supported
    ? null
    : result === undefined
      ? "モデルを読み込み中…"
      : result === "opencode_not_running"
        ? "OpenCode サービス未起動。デフォルトモデルで起動します。"
        : result === null
          ? "モデルを取得できませんでした。デフォルトモデルで起動します。"
          : result.length === 0
            ? "選択できるモデルがありません。デフォルトモデルで起動します。"
            : null;

  return (
    <div class="hwc-create-model">
      <label class="hwc-create-field">
        <span class="hwc-create-label">モデル</span>
        <select
          class="hwc-create-input"
          value={props.model === null ? "" : modelKey(props.model)}
          disabled={props.disabled || !supported || !models?.length}
          aria-describedby={note === null ? undefined : "hwc-create-model-note"}
          onChange={(event) => {
            const selected = models?.find((model) => modelKey(model) === event.currentTarget.value);
            props.onChange(selected ?? null);
          }}
        >
          <option value="">デフォルトモデル</option>
          {(models ?? []).map((model) => (
            <option key={modelKey(model)} value={modelKey(model)}>
              {modelKey(model)}
            </option>
          ))}
        </select>
      </label>
      {note === null ? null : (
        <p class="hwc-create-note" id="hwc-create-model-note" role="status">
          {note}
        </p>
      )}
    </div>
  );
}
