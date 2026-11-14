import { useId, useState } from "preact/hooks";
import type { ChatContext, ChatUsage } from "../../server/chat/contract";
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

// モデル名は狭い画面で省略される。全体を読む口と、名前を持ち出す口を同じパネルに置く。
export function AgentInfoHint(props: { info: AgentInfo }) {
  const model = props.info.model;
  const effort = props.info.effort;
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
        {model === null ? null : <span class="hwc-input-model">{model}</span>}
        {effort === null ? null : <span class="hwc-input-effort">{effort}</span>}
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
