import { useEffect, useState } from "preact/hooks";
import { AGENT_KINDS, AGENT_LABELS, type AgentKind, type AgentModel } from "../shared/agents";
import type { LaunchDefaults } from "../shared/launch-defaults";
import {
  createPane,
  createSpace,
  createWorktree,
  type CreatePaneFailure,
  type CreatePaneRequest,
  type CreatePaneOutcome,
  readLaunchDefaults,
} from "./api";
import { useEffortCandidates, useModelCandidates, useModelLabels } from "./launch-candidates";
import { canLaunch, chooseEffort, chooseModel, savedEffortFor } from "./launch-choice";
import { spaceFailureNotice } from "./space-create";
import { worktreeFailureNotice } from "./worktree-create";
import { ChoiceCard } from "./ChoiceCard";
import { DialogShell } from "./Dialog";
import { AgentGlyphIcon, AgentIcon, TerminalIcon } from "./icons";
import { CreatePaneModel } from "./CreatePaneModel";
import { CreatePaneEffort } from "./CreatePaneEffort";
import { Segmented } from "./Segmented";
import type { LaunchIntent } from "./starting";

// 何を作るか。split は paneId のタブを分割する。start は既存のシェルペイン（paneId）で
// 起動し、ペインを作らないので名前と種類の切り替えは出さない。worktree と space は新しい
// スペースを作り、その root pane で起動する。space の path は paneId のツリーの根からの
// 相対パス。
export type CreateTarget =
  | { kind: "split" }
  | { kind: "start" }
  | { kind: "worktree"; workspaceId: string }
  | { kind: "space"; path: string };

type CreatePaneProps = {
  // 分割・起動の対象のペイン。ワークツリーとスペースではモデル一覧の取得元。
  paneId: string;
  target: CreateTarget;
  // エージェントの起動を頼む内容。シェルだけを作る場合は null。起動そのものは
  // ダイアログを閉じた後に App が行う。
  onCreated: (paneId: string, launch: LaunchIntent | null) => void;
  onClose: () => void;
};

type Mode = "agent" | "shell";

const TITLES: Record<CreateTarget["kind"], string> = {
  split: "新しいペイン",
  start: "エージェントを起動",
  worktree: "新しいワークツリー",
  space: "新しいスペース",
};

// 失敗の見せ方。再試行できるかどうかで、フォームを残すか「閉じる」だけにするかが変わる。
type FailureView = { message: string; retry: boolean };

function failureMessage(error: CreatePaneFailure): string {
  switch (error) {
    case "timeout":
      return "作成できたか確認できませんでした。タブを確認してから、必要ならもう一度お試しください。";
    case "pane_limit":
      return "このタブは 4 ペインまでです。";
    case "pane_not_found":
      return "ペインが見つかりませんでした。";
    case "invalid_request":
      return "入力内容を確認してください。";
    default:
      return "ペインを作成できませんでした。もう一度お試しください。";
  }
}

function paneFailureView(result: Extract<CreatePaneOutcome, { ok: false }>): FailureView {
  return { message: failureMessage(result.error), retry: result.error !== "timeout" };
}

// ワークツリーとスペースは root pane ができるまで待つ。名前付けだけの失敗でも root pane は
// できているので、paneId があれば起動へ進む。
async function createRootPane(
  paneId: string,
  target: Extract<CreateTarget, { kind: "worktree" | "space" }>,
  name: string | null,
): Promise<{ paneId: string | null; failure: FailureView | null }> {
  if (target.kind === "worktree") {
    const result = await createWorktree(target.workspaceId, { name });
    return {
      paneId: result.paneId,
      failure: result.ok ? null : worktreeFailureNotice(result.error),
    };
  }
  const result = await createSpace(paneId, { path: target.path, name });
  return { paneId: result.paneId, failure: result.ok ? null : spaceFailureNotice(result.error) };
}

export function CreatePane(props: CreatePaneProps) {
  const { target } = props;
  const start = target.kind === "start";
  const [name, setName] = useState("");
  const [mode, setMode] = useState<Mode>("agent");
  const [agent, setAgent] = useState<AgentKind>("pi");
  // 利用者が選んだ値だけを持つ。起動する値は、既定と候補から描画中に導く。
  const [chosenModel, setChosenModel] = useState<AgentModel | null>(null);
  const [chosenEffort, setChosenEffort] = useState<string | null>(null);
  // 開いたときの既定のスナップショット。読めなかったときは既定なしとして開く。
  const [defaults, setDefaults] = useState<LaunchDefaults>({});
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(true);
  // 作成済みか結果不明で、再送できない状態。フィールドを閉じ、「閉じる」だけを出す。
  const [settled, setSettled] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    void readLaunchDefaults(controller.signal).then((read) => {
      if (!controller.signal.aborted && read !== null) setDefaults(read);
    });
    return () => controller.abort();
  }, []);

  const saved = defaults[agent] ?? null;
  const models = useModelCandidates(props.paneId, agent);
  const labels = useModelLabels(agent === "claude");
  const model = chooseModel(models.read, saved, chosenModel);
  const efforts = useEffortCandidates(props.paneId, agent, model);
  const effort = chooseEffort(efforts.read, model, saved, chosenEffort);
  const launchable = mode === "shell" || canLaunch(model, efforts.read, effort);

  // 結果を受け取るまで閉じない。閉じると、作成済みのペインとエラーを見失う。
  const close = () => {
    if (busy || !open) return;
    setOpen(false);
  };

  const intent = (waitForShell: boolean): LaunchIntent | null =>
    mode === "agent" ? { agent, model, effort, waitForShell } : null;

  const submit = async () => {
    if (busy || !open || !launchable) return;

    // 既存のシェルで起動する場合は、待たずに閉じる。起動は App が裏で行う。
    if (start) {
      setBusy(true);
      props.onCreated(props.paneId, intent(false));
      setOpen(false);
      return;
    }

    setBusy(true);
    setError(null);

    const request: CreatePaneRequest = {
      name: name.trim() === "" ? null : name.trim(),
      // エージェントの起動は作成の応答を待たない。ここでは名前付きのシェルを作る。
      agent: null,
      model: null,
      effort: null,
    };

    if (target.kind === "worktree" || target.kind === "space") {
      // 起動は分割と同じく、ペインがスナップショットに現れてから App が頼む。
      const result = await createRootPane(props.paneId, target, request.name);
      if (result.paneId !== null) {
        props.onCreated(result.paneId, intent(true));
        setOpen(false);
        return;
      }
      if (result.failure === null) return;
      setBusy(false);
      setSettled(!result.failure.retry);
      setError(result.failure.message);
      return;
    }

    const result = await createPane(props.paneId, request);
    // 名前の付け直しだけ失敗しても、ペインはできている。起動は止めない。
    const paneId = result.paneId;
    if (paneId !== null) {
      props.onCreated(paneId, intent(true));
      setOpen(false);
      return;
    }
    if (result.ok) return;
    setBusy(false);
    const view = paneFailureView(result);
    setSettled(!view.retry);
    setError(view.message);
  };

  return (
    <DialogShell
      role="dialog"
      className="hwc-create-dialog"
      labelledBy="hwc-create-title"
      describedBy={error === null ? undefined : "hwc-create-error"}
      open={open}
      onClose={close}
      onExited={props.onClose}
    >
      <h2 class="hwc-dialog-title" id="hwc-create-title">
        {TITLES[target.kind]}
      </h2>

      {target.kind === "start" ? (
        <p class="hwc-dialog-text">
          シェルペイン <span class="hwc-dialog-id">{props.paneId}</span>{" "}
          の上で、作業ディレクトリと履歴を保ったまま起動します。
        </p>
      ) : target.kind === "worktree" ? (
        <p class="hwc-dialog-text">ブランチ名と保存先は Herdr が自動で決めます。</p>
      ) : target.kind === "space" ? (
        <p class="hwc-dialog-text">
          <span class="hwc-dialog-id">{target.path}</span>{" "}
          を作業ディレクトリにしたスペースを作ります。
        </p>
      ) : null}

      {start ? null : (
        <label class="hwc-create-field">
          <span class="hwc-create-label">ペイン名（任意）</span>
          <input
            class="hwc-create-input"
            type="text"
            maxLength={80}
            value={name}
            placeholder="例: 実装"
            autocomplete="off"
            spellcheck={false}
            disabled={busy || settled}
            onInput={(event) => setName(event.currentTarget.value)}
          />
        </label>
      )}

      {start ? null : (
        <Segmented
          label="ペインの種類"
          value={mode}
          disabled={busy || settled}
          options={[
            { id: "agent", label: "エージェント", icon: <AgentIcon size={16} /> },
            { id: "shell", label: "シェル", icon: <TerminalIcon size={16} /> },
          ]}
          onChange={(next) => {
            setMode(next);
            // シェルの側に選ぶモデルとエフォートは無い。残すと、種類を戻したときに
            // 選んでいない値で起動してしまう。
            if (next === "shell") {
              setChosenModel(null);
              setChosenEffort(null);
            }
          }}
        />
      )}

      {mode === "agent" ? (
        <>
          <div
            class="hwc-choice-grid hwc-agent-grid"
            role="radiogroup"
            aria-label="起動するエージェント"
          >
            {AGENT_KINDS.map((kind) => (
              <ChoiceCard
                key={kind}
                selected={agent === kind}
                disabled={busy || settled}
                onSelect={() => {
                  if (kind === agent) return;
                  setAgent(kind);
                  setChosenModel(null);
                  setChosenEffort(null);
                }}
                label={AGENT_LABELS[kind]}
              >
                <span class="hwc-choice-icon" data-agent={kind}>
                  <AgentGlyphIcon agent={kind} size={18} />
                </span>
              </ChoiceCard>
            ))}
          </div>
          <CreatePaneModel
            agent={agent}
            candidates={models.read}
            model={model}
            labels={labels}
            saved={saved}
            disabled={busy || settled}
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
            disabled={busy || settled}
            onChange={setChosenEffort}
            onRetry={efforts.reload}
          />
        </>
      ) : (
        <p class="hwc-create-note">エージェントを起動せず、シェルだけを作ります。</p>
      )}

      {error === null ? null : (
        <p class="hwc-dialog-error" id="hwc-create-error" role="alert">
          {error}
        </p>
      )}

      <div class="hwc-dialog-actions hwc-create-actions">
        {settled ? (
          <button type="button" class="hwc-dialog-button hwc-dialog-primary" onClick={close}>
            閉じる
          </button>
        ) : (
          <>
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
              disabled={busy || !launchable}
              aria-busy={busy}
              onClick={submit}
            >
              {busy ? (
                <>
                  <span class="hwc-spinner" aria-hidden="true" />
                  {start
                    ? "起動中…"
                    : target.kind === "split" && mode === "agent"
                      ? "起動中…"
                      : "作成中…"}
                </>
              ) : start ? (
                "起動"
              ) : mode === "agent" ? (
                "作成して起動"
              ) : (
                "作成"
              )}
            </button>
          </>
        )}
      </div>
    </DialogShell>
  );
}
