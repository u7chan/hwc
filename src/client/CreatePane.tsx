import { useEffect, useState } from "preact/hooks";
import { AGENT_KINDS, AGENT_LABELS, type AgentKind, type AgentModel } from "../shared/agents";
import type { LaunchDefaults } from "../shared/launch-defaults";
import {
  createPane,
  createWorktree,
  type CreatePaneFailure,
  type CreatePaneRequest,
  type CreatePaneOutcome,
  type CreateWorktreeOutcome,
  readLaunchDefaults,
} from "./api";
import { useEffortCandidates, useModelCandidates } from "./launch-candidates";
import { canLaunch, chooseEffort, chooseModel, savedEffortFor } from "./launch-choice";
import { worktreeFailureNotice } from "./worktree-create";
import { ChoiceCard } from "./ChoiceCard";
import { DialogShell } from "./Dialog";
import { AgentGlyphIcon, AgentIcon, TerminalIcon } from "./icons";
import { CreatePaneModel } from "./CreatePaneModel";
import { CreatePaneEffort } from "./CreatePaneEffort";
import type { LaunchIntent } from "./starting";

type CreatePaneProps = {
  // 分割して作る場合は追加先のペイン。ワークツリーを作る場合はモデル一覧の取得元。
  paneId: string;
  // 値があればワークツリーを作り、その root pane でエージェントを起動する。
  worktreeWorkspaceId: string | null;
  // 既存のシェルペイン（paneId）で起動する。ペインを作らないので名前と種類の切り替えは出さない。
  start: boolean;
  // エージェントの起動を頼む内容。シェルだけを作る場合は null。起動そのものは
  // ダイアログを閉じた後に App が行う。
  onCreated: (paneId: string, launch: LaunchIntent | null) => void;
  onClose: () => void;
};

type Mode = "agent" | "shell";

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

function worktreeFailureView(result: Extract<CreateWorktreeOutcome, { ok: false }>): FailureView {
  // ペインができている場合は起動へ進むので、ここへは来ない。
  return worktreeFailureNotice(result.error);
}

export function CreatePane(props: CreatePaneProps) {
  const worktree = props.worktreeWorkspaceId !== null;
  const start = props.start;
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

    if (props.worktreeWorkspaceId !== null) {
      // ワークツリーは root pane ができるまで待つ。起動は分割と同じく、ペインが
      // スナップショットに現れてから App が頼む。
      const result = await createWorktree(props.worktreeWorkspaceId, { name: request.name });
      // 名前の付け直しだけ失敗しても、ワークツリーと root pane はできている。
      const paneId = result.paneId;
      if (paneId !== null) {
        props.onCreated(paneId, intent(true));
        setOpen(false);
        return;
      }
      if (result.ok) return;
      setBusy(false);
      const view = worktreeFailureView(result);
      setSettled(!view.retry);
      setError(view.message);
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
        {start ? "エージェントを起動" : worktree ? "新しいワークツリー" : "新しいペイン"}
      </h2>

      {start ? (
        <p class="hwc-dialog-text">
          シェルペイン <span class="hwc-dialog-id">{props.paneId}</span>{" "}
          の上で、作業ディレクトリと履歴を保ったまま起動します。
        </p>
      ) : worktree ? (
        <p class="hwc-dialog-text">ブランチ名と保存先は Herdr が自動で決めます。</p>
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
        <div class="hwc-create-modes" role="radiogroup" aria-label="ペインの種類">
          <button
            type="button"
            role="radio"
            class="hwc-create-mode"
            aria-checked={mode === "agent"}
            disabled={busy || settled}
            onClick={() => setMode("agent")}
          >
            <AgentIcon size={16} />
            エージェント
          </button>
          <button
            type="button"
            role="radio"
            class="hwc-create-mode"
            aria-checked={mode === "shell"}
            disabled={busy || settled}
            onClick={() => {
              setMode("shell");
              setChosenModel(null);
              setChosenEffort(null);
            }}
          >
            <TerminalIcon size={16} />
            シェル
          </button>
        </div>
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
            candidates={models.read}
            model={model}
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
                    : worktree
                      ? "作成中…"
                      : mode === "agent"
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
