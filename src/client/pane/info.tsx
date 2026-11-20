import { useId, useState } from "preact/hooks";
import type { ChatContext, ChatUsage } from "../../server/chat/contract";
import { claudeModelName, isClaudeAlias } from "../../shared/agents";
import { type AgentInfo, type ContextMeterView, contextDetails } from "../chat";
import { type CommandId, commandLabel, commandText } from "../commands";
import { useCopy } from "../copy";
import { useHint } from "../hint";
import { CopyGlyph, InfoIcon } from "../icons";

// 送る文字列は短いので、記号だけを出さず、何が起きるかを並べる。
export function CommandBadge(props: { id: CommandId }) {
  return (
    <>
      <span class="hwc-command-text">{commandText(props.id)}</span>
      <span class="hwc-command-label">{commandLabel(props.id)}</span>
    </>
  );
}

export function ContextMeter(props: {
  view: ContextMeterView;
  context: ChatContext;
  usage?: ChatUsage;
}) {
  const { view, context, usage } = props;
  const hint = useHint();
  const noteId = useId();
  // 開いた状態はパネルを閉じても保つ。閉じるたびに既定へ戻すには開閉を監視する必要があり、
  // 閉じるアニメーションの途中でパネルの高さが変わるため採らない。
  const [noteOpen, setNoteOpen] = useState(false);
  return (
    <span class="hwc-hint-wrap" ref={hint.root} {...hint.wrapperProps}>
      <button
        type="button"
        class="hwc-context"
        data-tone={view.tone}
        aria-label={`コンテキスト使用量 ${view.wide}`}
        aria-describedby={hint.open === null ? undefined : hint.panelId}
        aria-expanded={hint.open !== null}
        {...hint.triggerProps}
      >
        <span class="hwc-context-text" aria-hidden="true">
          <span class="hwc-context-wide">{view.wide}</span>
          <span class="hwc-context-narrow">{view.narrow}</span>
        </span>
        {view.percent === null ? null : (
          <span class="hwc-context-bar" aria-hidden="true">
            <span class="hwc-context-bar-fill" style={{ width: `${view.fill}%` }} />
          </span>
        )}
      </button>
      <span
        id={hint.panelId}
        ref={hint.panel}
        role="group"
        aria-label="コンテキスト使用量"
        class="hwc-hint-panel"
        data-open={hint.open !== null}
        tabIndex={hint.panelTabIndex}
      >
        <span class="hwc-hint-title-row">
          <span class="hwc-hint-title">直近のコンテキスト使用量</span>
          <button
            type="button"
            class="hwc-hint-icon-button hwc-hint-note-toggle"
            data-open={noteOpen}
            aria-label="設定枠の補足"
            aria-expanded={noteOpen}
            aria-controls={noteId}
            onClick={() => setNoteOpen((open) => !open)}
          >
            <InfoIcon size={16} />
          </button>
        </span>
        <span id={noteId} class="hwc-hint-note" hidden={!noteOpen}>
          設定枠はモデル仕様上の最大値とは限りません。自動圧縮は枠に達する前に行われることがあります。
        </span>
        {contextDetails(context, usage).map(([label, value]) => (
          <span class="hwc-hint-row" key={label}>
            <span>{label}</span>
            <span>{value}</span>
          </span>
        ))}
      </span>
    </span>
  );
}

// チップは Claude だけ表示名にする。パネルは省略されない全体と、持ち出す識別子を出す。
// エイリアスは起動時に頼んだ値で、実際のモデルは最初の応答で分かる。
export function AgentInfoHint(props: { agent: string | null; info: AgentInfo }) {
  const model = props.info.model;
  const effort = props.info.effort;
  const claude = props.agent === "claude" && model !== null;
  const provisional = claude && isClaudeAlias(model);
  const hint = useHint();
  const { copiedId, copy } = useCopy();
  const copied = copiedId === "model";
  return (
    <span class="hwc-hint-wrap hwc-agent-hint" ref={hint.root} {...hint.wrapperProps}>
      <button
        type="button"
        class="hwc-agent-info"
        aria-expanded={hint.open !== null}
        aria-controls={hint.panelId}
        {...hint.triggerProps}
      >
        {model === null ? null : (
          <span class="hwc-input-model">{claude ? claudeModelName(model) : model}</span>
        )}
        {effort === null ? null : <span class="hwc-effort-badge hwc-input-effort">{effort}</span>}
      </button>
      <span
        id={hint.panelId}
        ref={hint.panel}
        role="group"
        aria-label="モデルとエフォート"
        class="hwc-hint-panel"
        data-open={hint.open !== null}
        tabIndex={hint.panelTabIndex}
      >
        {model === null ? null : (
          <span class="hwc-model-row">
            {provisional ? (
              <span class="hwc-model-provisional" aria-hidden="true">
                <InfoIcon size={14} />
              </span>
            ) : null}
            <span class="hwc-model-name">{model}</span>
            <button
              type="button"
              class="hwc-hint-icon-button hwc-model-copy"
              data-copied={copied}
              aria-label={copied ? "コピーしました" : "モデル名をコピー"}
              onClick={() => copy("model", model)}
            >
              <CopyGlyph copied={copied} size={14} />
            </button>
          </span>
        )}
        {provisional ? (
          <span class="hwc-hint-note">起動時の指定。最初の応答で実際のモデルに確定します</span>
        ) : null}
        {effort === null ? null : (
          <span class="hwc-hint-row">
            <span>エフォート</span>
            <span>{effort}</span>
          </span>
        )}
      </span>
    </span>
  );
}

// 今は値を出せないが、読み込めば出る場所を示す。幅はモデル名と effort の札に合わせ、
// 値が届いたときに右の使用量と送信を大きく押し出さない。
export function AgentInfoSkeleton() {
  return (
    <span class="hwc-agent-hint hwc-agent-hint-pending" aria-hidden="true">
      <span class="hwc-info-skeleton hwc-info-skeleton-model" />
      <span class="hwc-info-skeleton hwc-info-skeleton-effort" />
    </span>
  );
}
