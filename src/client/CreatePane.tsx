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
  type StartAgentFailure,
  startAgent,
} from "./api";
import { worktreeFailureNotice, worktreePartialNotice } from "./worktree-create";
import { ChoiceCard } from "./ChoiceCard";
import { DialogShell } from "./Dialog";
import { AgentGlyphIcon, AgentIcon, TerminalIcon } from "./icons";
import { CreatePaneModel } from "./CreatePaneModel";
import { CreatePaneEffort } from "./CreatePaneEffort";

type CreatePaneProps = {
  // 分割して作る場合は追加先のペイン。ワークツリーを作る場合はモデル一覧の取得元。
  paneId: string;
  // 値があればワークツリーを作り、その root pane でエージェントを起動する。
  worktreeWorkspaceId: string | null;
  // 既存のシェルペイン（paneId）で起動する。ペインを作らないので名前と種類の切り替えは出さない。
  start: boolean;
  // エージェントの起動を頼んだか。起動が終わるまで入力を閉じる側で使う。
  onCreated: (paneId: string, agent: boolean) => void;
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

// 分割は成功したが、その後の起動かリネームで失敗した場合。ペインは既にある。
function partialMessage(error: CreatePaneFailure): string {
  return error === "agent_start_failed"
    ? "ペインは作成しましたが、エージェントを起動できませんでした。ペインはシェルとして残っています。"
    : "ペインは作成しましたが、設定を完了できませんでした。";
}

function paneFailureView(result: Extract<CreatePaneOutcome, { ok: false }>): FailureView {
  // ペインができているなら、再送ではなく確認に倒す。
  if (result.paneId !== null) return { message: partialMessage(result.error), retry: false };
  return { message: failureMessage(result.error), retry: result.error !== "timeout" };
}

function worktreeFailureView(result: Extract<CreateWorktreeOutcome, { ok: false }>): FailureView {
  // 部分成功ではワークツリーができているので、閉じるだけにする。
  if (result.paneId !== null) return { message: worktreePartialNotice(result.error), retry: false };
  return worktreeFailureNotice(result.error);
}

// 既存のペインで起動する場合、ペインができているかの分岐はない。再試行できるかだけを分ける。
function startFailureView(error: StartAgentFailure): FailureView {
  switch (error) {
    case "timeout":
      return {
        message:
          "起動できたか確認できませんでした。ペインの状態を見てから、必要ならもう一度お試しください。",
        retry: false,
      };
    case "pane_busy":
      return {
        message: "コマンドが動いています。停止してからもう一度お試しください。",
        retry: true,
      };
    case "pane_not_shell":
      return { message: "このペインではすでにエージェントが動いています。", retry: false };
    case "pane_not_found":
      return { message: "ペインが見つかりませんでした。", retry: false };
    case "invalid_request":
      return { message: "入力内容を確認してください。", retry: false };
    case "agent_start_failed":
      return {
        message: "エージェントを起動できませんでした。ペインはシェルのまま残っています。",
        retry: true,
      };
    default:
      return {
        message: "エージェントを起動できませんでした。もう一度お試しください。",
        retry: true,
      };
  }
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

  const submit = async () => {
    if (busy || !open) return;
    setBusy(true);
    setError(null);

    if (start) {
      const result = await startAgent(props.paneId, { agent, model, effort });
      if (result.ok) {
        props.onCreated(props.paneId, true);
        setOpen(false);
        return;
      }
      const view = startFailureView(result.error);
      setBusy(false);
      setSettled(!view.retry);
      setError(view.message);
      return;
    }

    const request: CreatePaneRequest = {
      name: name.trim() === "" ? null : name.trim(),
      agent: mode === "agent" ? agent : null,
      model: mode === "agent" ? model : null,
      effort: mode === "agent" ? effort : null,
    };

    const created = (paneId: string) => {
      props.onCreated(paneId, mode === "agent");
      setOpen(false);
    };

    let paneId: string | null;
    let view: FailureView;
    if (props.worktreeWorkspaceId !== null) {
      const result = await createWorktree(props.worktreeWorkspaceId, request);
      if (result.ok) return created(result.paneId);
      paneId = result.paneId;
      view = worktreeFailureView(result);
    } else {
      const result = await createPane(props.paneId, request);
      if (result.ok) return created(result.paneId);
      paneId = result.paneId;
      view = paneFailureView(result);
    }

    setBusy(false);
    setSettled(paneId !== null || !view.retry);
    setError(view.message);
    // ペインができていれば、理由を見せたまま新しいペインへ移る。部分成功では入力を閉じない。
    // 起動に失敗していればシェル、リネームだけ失敗していればエージェントの起動は済んでいる
    // （両方失敗した場合は起動失敗を優先する）。
    if (paneId !== null) props.onCreated(paneId, false);
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
