import { useState } from "preact/hooks";
import {
  AGENT_KINDS,
  AGENT_LABELS,
  type AgentKind,
  type AgentModel,
  modelKey,
  supportsModelSelection,
} from "../shared/agents";
import {
  createPane,
  createWorktree,
  type CreatePaneFailure,
  type CreatePaneRequest,
  type CreatePaneOutcome,
  type CreateWorktreeOutcome,
} from "./api";
import { worktreeFailureNotice, worktreePartialNotice } from "./worktree-create";
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
  // 部分成功ではワークツリーができているので、閉じるだけにする。
  if (result.paneId !== null) return { message: worktreePartialNotice(result.error), retry: false };
  return worktreeFailureNotice(result.error);
}

export function CreatePane(props: CreatePaneProps) {
  const worktree = props.worktreeWorkspaceId !== null;
  const start = props.start;
  const [name, setName] = useState("");
  const [mode, setMode] = useState<Mode>("agent");
  const [agent, setAgent] = useState<AgentKind>("pi");
  const [model, setModel] = useState<AgentModel | null>(null);
  const [effort, setEffort] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(true);
  // 作成済みか結果不明で、再送できない状態。フィールドを閉じ、「閉じる」だけを出す。
  const [settled, setSettled] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 結果を受け取るまで閉じない。閉じると、作成済みのペインとエラーを見失う。
  const close = () => {
    if (busy || !open) return;
    setOpen(false);
  };

  const intent = (waitForShell: boolean, started: boolean): LaunchIntent | null =>
    mode === "agent" ? { agent, model, effort, waitForShell, started } : null;

  const submit = async () => {
    if (busy || !open) return;

    // 既存のシェルで起動する場合は、待たずに閉じる。起動は App が裏で行う。
    if (start) {
      setBusy(true);
      props.onCreated(props.paneId, intent(false, false));
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
      // ワークツリーは root pane ができるまで待つ。起動はサーバーが済ませるので、
      // 起動の指定は started として渡す。
      const result = await createWorktree(props.worktreeWorkspaceId, {
        ...request,
        agent: mode === "agent" ? agent : null,
        model: mode === "agent" ? model : null,
        effort: mode === "agent" ? effort : null,
      });
      if (result.ok) {
        props.onCreated(result.paneId, intent(false, true));
        setOpen(false);
        return;
      }
      setBusy(false);
      const view = worktreeFailureView(result);
      setSettled(result.paneId !== null || !view.retry);
      setError(view.message);
      if (result.paneId !== null) props.onCreated(result.paneId, null);
      return;
    }

    const result = await createPane(props.paneId, request);
    // 名前の付け直しだけ失敗しても、ペインはできている。起動は止めない。
    const paneId = result.paneId;
    if (paneId !== null) {
      props.onCreated(paneId, intent(true, false));
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
              setModel(null);
              setEffort(null);
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
                  setModel(null);
                  setEffort(null);
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
            key={`${props.paneId}/${agent}`}
            paneId={props.paneId}
            agent={agent}
            model={model}
            disabled={busy || settled}
            onChange={(selected) => {
              setModel(selected);
              setEffort(null);
            }}
          />
          {supportsModelSelection(agent) ? (
            <CreatePaneEffort
              key={`${props.paneId}/${agent}/${model === null ? "" : modelKey(model)}`}
              paneId={props.paneId}
              agent={agent}
              model={model}
              effort={effort}
              disabled={busy || settled}
              onChange={setEffort}
            />
          ) : null}
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
              disabled={busy}
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
