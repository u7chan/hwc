import { useEffect, useState } from "preact/hooks";
import { type AgentModel, type ModelAgentKind } from "../shared/agents";
import { readAgentEfforts } from "./api";
import { CreatePaneSelect } from "./CreatePaneSelect";

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
      : efforts === null
        ? "エフォートを取得できませんでした。CLI のデフォルトで起動します。"
        : efforts?.length === 0
          ? "このモデルはエフォート指定に対応していません。"
          : null;

  return (
    <div class="hwc-create-effort">
      <CreatePaneSelect
        label="エフォート"
        noteId="hwc-create-effort-note"
        note={note}
        loading={props.model !== null && efforts === undefined}
        value={props.effort ?? ""}
        disabled={props.disabled || props.model === null || !efforts?.length}
        onChange={(value) => props.onChange(efforts?.includes(value) ? value : null)}
      >
        <option value="">デフォルト（CLI に任せる）</option>
        {(efforts ?? []).map((effort) => (
          <option key={effort} value={effort}>
            {effort}
          </option>
        ))}
      </CreatePaneSelect>
    </div>
  );
}
