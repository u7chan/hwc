import { useState } from "preact/hooks";
import { AGENT_KINDS, AGENT_LABELS, type AgentKind } from "../shared/agents";
import { createPane, type CreatePaneFailure } from "./api";
import { ChoiceCard } from "./ChoiceCard";
import { DialogShell } from "./Dialog";
import { AgentGlyphIcon } from "./icons";

type CreatePaneProps = {
  paneId: string;
  onCreated: (paneId: string) => void;
  onClose: () => void;
};

type Mode = "agent" | "shell";

function failureMessage(error: CreatePaneFailure): string {
  switch (error) {
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

export function CreatePane(props: CreatePaneProps) {
  const [name, setName] = useState("");
  const [mode, setMode] = useState<Mode>("agent");
  const [agent, setAgent] = useState<AgentKind>("pi");
  const [busy, setBusy] = useState(false);
  const [partial, setPartial] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 結果を受け取るまで閉じない。閉じると、作成済みのペインとエラーを見失う。
  const close = () => {
    if (busy) return;
    props.onClose();
  };

  const submit = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    const result = await createPane(props.paneId, {
      name: name.trim() === "" ? null : name.trim(),
      agent: mode === "agent" ? agent : null,
    });
    if (result.ok) {
      props.onCreated(result.paneId);
      props.onClose();
      return;
    }
    setBusy(false);
    if (result.paneId !== null) {
      setPartial(true);
      setError(partialMessage(result.error));
      props.onCreated(result.paneId);
      return;
    }
    setPartial(false);
    setError(failureMessage(result.error));
  };

  return (
    <DialogShell
      role="dialog"
      labelledBy="hwc-create-title"
      describedBy={error === null ? undefined : "hwc-create-error"}
      onClose={close}
    >
      <h2 class="hwc-dialog-title" id="hwc-create-title">
        新しいペイン
      </h2>

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
          disabled={busy || partial}
          onInput={(event) => setName(event.currentTarget.value)}
        />
      </label>

      <div class="hwc-create-modes" role="radiogroup" aria-label="ペインの種類">
        <button
          type="button"
          role="radio"
          class="hwc-create-mode"
          aria-checked={mode === "agent"}
          disabled={busy || partial}
          onClick={() => setMode("agent")}
        >
          エージェント
        </button>
        <button
          type="button"
          role="radio"
          class="hwc-create-mode"
          aria-checked={mode === "shell"}
          disabled={busy || partial}
          onClick={() => setMode("shell")}
        >
          シェル
        </button>
      </div>

      {mode === "agent" ? (
        <div
          class="hwc-choice-grid hwc-agent-grid"
          role="radiogroup"
          aria-label="起動するエージェント"
        >
          {AGENT_KINDS.map((kind) => (
            <ChoiceCard
              key={kind}
              selected={agent === kind}
              disabled={busy || partial}
              onSelect={() => setAgent(kind)}
              label={AGENT_LABELS[kind]}
            >
              <span class="hwc-choice-icon" data-agent={kind}>
                <AgentGlyphIcon agent={kind} size={18} />
              </span>
            </ChoiceCard>
          ))}
        </div>
      ) : (
        <p class="hwc-create-note">エージェントを起動せず、シェルだけを作ります。</p>
      )}

      {error === null ? null : (
        <p class="hwc-dialog-error" id="hwc-create-error" role="alert">
          {error}
        </p>
      )}

      <div class="hwc-dialog-actions hwc-create-actions">
        {partial ? (
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
                  {mode === "agent" ? "起動中…" : "作成中…"}
                </>
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
