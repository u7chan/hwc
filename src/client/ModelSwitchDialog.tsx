import { useState } from "preact/hooks";
import type { AgentModel } from "../shared/agents";
import { modelSwitchPlan } from "../shared/model-switch";
import { switchModel } from "./api";
import type { AgentInfo } from "./chat";
import { CreatePaneEffort } from "./CreatePaneEffort";
import { CreatePaneModel } from "./CreatePaneModel";
import { DialogShell } from "./Dialog";
import { useEffortCandidates, useModelCandidates, useModelLabels } from "./launch-candidates";
import {
  CACHE_WARNING,
  chooseSwitchEffort,
  chooseSwitchModel,
  DEFAULT_NOTE,
  switchFailureNotice,
} from "./model-switch";

// 実行中の Claude のモデルと effort を切り替える（docs/adr/claude-integration.md）。選ぶ部品は起動の
// ダイアログと同じで、最初の選択は画面に出ている現在の値。何を送るかは BFF が現在の値との
// 差で決めるので、ここは選んだ組をそのまま渡す。
export function ModelSwitchDialog(props: {
  paneId: string;
  current: AgentInfo | null;
  // 切り替えが済んだ。会話を取り直し、補われた値を画面に出す。
  onSwitched: () => void;
  onClose: () => void;
}) {
  const currentModel = props.current?.model ?? null;
  const currentEffort = props.current?.effort ?? null;
  // 利用者が選んだ値だけを持つ。選択中の値は、候補と現在の値から描画中に導く。
  const [chosenModel, setChosenModel] = useState<AgentModel | null>(null);
  const [chosenEffort, setChosenEffort] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const models = useModelCandidates(props.paneId, "claude");
  const labels = useModelLabels(true);
  const model = chooseSwitchModel(models.read, chosenModel, currentModel);
  const efforts = useEffortCandidates(props.paneId, "claude", model);
  const effort = chooseSwitchEffort(efforts.read, chosenEffort, currentEffort);

  const plan =
    model === null || effort === null
      ? null
      : modelSwitchPlan({ model: currentModel, effort: currentEffort }, { model, effort });
  const changed = plan !== null && (plan.model || plan.effort);

  // 結果を受け取るまで閉じない。閉じると、切り替えたかどうかを見失う。
  const close = () => {
    if (busy || !open) return;
    setOpen(false);
  };

  const submit = async () => {
    if (busy || !open || model === null || effort === null || !changed) return;
    setBusy(true);
    setError(null);
    const result = await switchModel(props.paneId, { model, effort });
    if (result.ok) {
      props.onSwitched();
      setOpen(false);
      return;
    }
    setBusy(false);
    setError(switchFailureNotice(result.status));
  };

  return (
    <DialogShell
      role="dialog"
      className="hwc-create-dialog"
      labelledBy="hwc-switch-title"
      describedBy={error === null ? undefined : "hwc-switch-error"}
      open={open}
      onClose={close}
      onExited={props.onClose}
    >
      <h2 class="hwc-dialog-title" id="hwc-switch-title">
        モデルとエフォートを変更
      </h2>
      <p class="hwc-dialog-text">
        ペイン <span class="hwc-dialog-id">{props.paneId}</span>{" "}
        の会話を保ったまま、次の応答から切り替えます。
      </p>

      <CreatePaneModel
        agent="claude"
        candidates={models.read}
        model={model}
        labels={labels}
        saved={null}
        disabled={busy}
        onChange={setChosenModel}
        onRetry={models.reload}
      />
      <CreatePaneEffort
        model={model}
        candidates={efforts.read}
        effort={effort}
        savedEffort={null}
        disabled={busy}
        onChange={setChosenEffort}
        onRetry={efforts.reload}
      />

      {plan?.model ? (
        <p class="hwc-switch-warning" role="note">
          {CACHE_WARNING}
        </p>
      ) : null}
      <p class="hwc-create-note">{DEFAULT_NOTE}</p>

      {error === null ? null : (
        <p class="hwc-dialog-error" id="hwc-switch-error" role="alert">
          {error}
        </p>
      )}

      <div class="hwc-dialog-actions hwc-create-actions">
        <button
          type="button"
          class="hwc-dialog-button hwc-dialog-cancel"
          disabled={busy}
          onClick={close}
        >
          キャンセル
        </button>
        <button
          type="button"
          class="hwc-dialog-button hwc-dialog-primary"
          disabled={busy || !changed}
          aria-busy={busy}
          onClick={submit}
        >
          {busy ? (
            <>
              <span class="hwc-spinner" aria-hidden="true" />
              切り替え中…
            </>
          ) : (
            "切り替える"
          )}
        </button>
      </div>
    </DialogShell>
  );
}
