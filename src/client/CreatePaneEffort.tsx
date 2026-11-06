import { useEffect, useState } from "preact/hooks";
import { type AgentModel, type ModelAgentKind } from "../shared/agents";
import { readAgentEfforts } from "./api";

export function CreatePaneEffort(props: {
  paneId: string;
  agent: ModelAgentKind;
  model: AgentModel | null;
  effort: string | null;
  disabled: boolean;
  onChange: (effort: string | null) => void;
}) {
  const [efforts, setEfforts] = useState<string[] | null>();
  const provider = props.model?.provider;
  const modelId = props.model?.id;

  useEffect(() => {
    if (provider === undefined || modelId === undefined) return;
    const controller = new AbortController();
    void readAgentEfforts(
      props.paneId,
      props.agent,
      { provider, id: modelId },
      controller.signal,
    ).then((values) => {
      if (!controller.signal.aborted) setEfforts(values);
    });
    return () => controller.abort();
  }, [props.paneId, props.agent, provider, modelId]);

  const note =
    props.model === null
      ? "モデルを選択すると指定できます。"
      : efforts === undefined
        ? "エフォートを読み込み中…"
        : efforts === null
          ? "エフォートを取得できませんでした。CLI のデフォルトで起動します。"
          : efforts.length === 0
            ? "このモデルはエフォート指定に対応していません。"
            : null;

  return (
    <div class="hwc-create-effort">
      <label class="hwc-create-field">
        <span class="hwc-create-label">エフォート</span>
        <select
          class="hwc-create-input"
          value={props.effort ?? ""}
          disabled={props.disabled || props.model === null || !efforts?.length}
          aria-describedby={note === null ? undefined : "hwc-create-effort-note"}
          onChange={(event) => {
            const value = event.currentTarget.value;
            props.onChange(efforts?.includes(value) ? value : null);
          }}
        >
          <option value="">デフォルト（CLI に任せる）</option>
          {(efforts ?? []).map((effort) => (
            <option key={effort} value={effort}>
              {effort}
            </option>
          ))}
        </select>
      </label>
      {note === null ? null : (
        <p class="hwc-create-note" id="hwc-create-effort-note" role="status">
          {note}
        </p>
      )}
    </div>
  );
}
