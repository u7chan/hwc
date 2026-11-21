import { useEffect, useState } from "preact/hooks";
import {
  type AgentModel,
  type ModelAgentKind,
  type ModelLabels,
  modelLabel,
} from "../../shared/agents";
import type { LaunchDefaults } from "../../shared/launch-defaults";
import { readLaunchDefaults, saveLaunchDefault } from "../api";
import { CreatePaneEffort } from "../CreatePaneEffort";
import { CreatePaneModel } from "../CreatePaneModel";
import { useEffortCandidates, useModelCandidates } from "../launch-candidates";
import { canLaunch, chooseEffort, chooseModel, sameModel, savedEffortFor } from "../launch-choice";

type LoadState = "loading" | "ready" | "failed";

// 新しいペインの既定のモデルと effort。BFF が正で、保存・解除の応答で丸ごと置き換える。
// 作成ダイアログには既定を変える操作を置かない（docs/adr/agent-launch.md）。
export function AgentSettings(props: {
  agent: ModelAgentKind;
  labels: ModelLabels | null;
  onSaved: () => void;
}) {
  const [defaults, setDefaults] = useState<LaunchDefaults>({});
  const [load, setLoad] = useState<LoadState>("loading");
  const [reloadKey, setReloadKey] = useState(0);
  const [chosenModel, setChosenModel] = useState<AgentModel | null>(null);
  const [chosenEffort, setChosenEffort] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setLoad("loading");
    void readLaunchDefaults(controller.signal).then((read) => {
      if (controller.signal.aborted) return;
      // 読めないまま「未設定」と出すと、保存済みの既定が無いものと取り違える。
      if (read === null) {
        setLoad("failed");
        return;
      }
      setDefaults(read);
      setLoad("ready");
    });
    return () => controller.abort();
  }, [reloadKey]);

  // 設定画面にはペインが無いので、候補は BFF がホームディレクトリで読む。
  const saved = defaults[props.agent] ?? null;
  const models = useModelCandidates(null, props.agent);
  const model = chooseModel(models.read, saved, chosenModel);
  const efforts = useEffortCandidates(null, props.agent, model);
  const effort = chooseEffort(efforts.read, model, saved, chosenEffort);
  const unchanged =
    saved !== null && model !== null && sameModel(model, saved.model) && effort === saved.effort;

  const save = async (value: { model: AgentModel; effort: string | null } | null) => {
    if (busy) return;
    setBusy(true);
    const result = await saveLaunchDefault(props.agent, value);
    setBusy(false);
    if (!result.ok) {
      setMessage("既定を保存できませんでした。");
      return;
    }
    setDefaults(result.defaults);
    setChosenModel(null);
    setChosenEffort(null);
    setMessage(null);
    props.onSaved();
  };

  if (load !== "ready") {
    return (
      <section>
        {load === "loading" ? (
          <p class="hwc-section-note">既定を読み込んでいます。</p>
        ) : (
          <div class="hwc-setting-failure">
            <p class="hwc-section-note" role="alert">
              既定を読み込めませんでした。
            </p>
            <button
              type="button"
              class="hwc-setting-button"
              onClick={() => setReloadKey((key) => key + 1)}
            >
              再試行
            </button>
          </div>
        )}
      </section>
    );
  }

  return (
    <section>
      <div class="hwc-setting-group">
        <div class="hwc-setting-row">
          <span class="hwc-setting-label">現在の既定</span>
          <span class="hwc-setting-value hwc-setting-model">
            {saved === null ? (
              "未設定"
            ) : (
              <>
                <span class="hwc-setting-model-name">
                  {modelLabel(props.agent, saved.model, props.labels)}
                </span>
                {saved.effort === null ? null : (
                  <span class="hwc-effort-badge">{saved.effort}</span>
                )}
              </>
            )}
          </span>
        </div>
      </div>

      <form
        class="hwc-setting-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (model !== null && canLaunch(model, efforts.read, effort))
            void save({ model, effort });
        }}
      >
        <CreatePaneModel
          agent={props.agent}
          candidates={models.read}
          model={model}
          labels={props.labels}
          saved={saved}
          disabled={busy}
          onChange={(selected) => {
            setChosenModel(selected);
            setChosenEffort(null);
          }}
          onRetry={models.reload}
        />
        <CreatePaneEffort
          model={model}
          candidates={efforts.read}
          effort={effort}
          savedEffort={savedEffortFor(model, saved)}
          disabled={busy}
          onChange={setChosenEffort}
          onRetry={efforts.reload}
        />
        <div class="hwc-setting-actions">
          <button
            type="submit"
            class="hwc-setting-button hwc-setting-primary"
            disabled={busy || unchanged || !canLaunch(model, efforts.read, effort)}
          >
            保存
          </button>
          <button
            type="button"
            class="hwc-setting-button"
            disabled={busy || saved === null}
            onClick={() => void save(null)}
          >
            解除
          </button>
        </div>
      </form>

      <p class="hwc-section-note">
        新しいペインを作るときに、最初から選ばれるモデルとエフォートです。未設定のときは、毎回選びます。候補はホームディレクトリで読むので、ペインのフォルダで候補が変わる場合は、既定が選ばれないことがあります。
      </p>

      {message === null ? null : (
        <p class="hwc-setting-result" data-ok={false} role="alert">
          {message}
        </p>
      )}
    </section>
  );
}
