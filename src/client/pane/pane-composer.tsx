import type { ChatContext, ChatMessage, ChatUsage } from "../../server/chat/contract";
import type { PaneState } from "../../server/herdr/state";
import { attachmentExtFromName, formatFileSize, MAX_ATTACHMENTS } from "../../shared/attachments";
import type { ProjectEntry } from "../../shared/projects";
import { attachmentUrl } from "../api";
import type { AttachedFile } from "../attachment-store";
import { dropActionFrom } from "../attachments";
import type { AgentInfo, ContextMeterView } from "../chat";
import { type CommandId, commandText } from "../commands";
import { ComposerAdd, type ComposerCommand } from "../ComposerAdd";
import { enterInsertsNewline } from "../input";
import {
  AgentGlyphIcon,
  AgentIcon,
  CloseIcon,
  CollapseIcon,
  ExpandIcon,
  PencilIcon,
  SendIcon,
  StopIcon,
} from "../icons";
import { stepProject } from "../projects";
import { agentGlyph, type PaneContext } from "../select";
import { Spinner } from "../Spinner";
import { type PaneLaunchView } from "../starting";
import { formatClock } from "../time";
import { AgentInfoHint, AgentInfoSkeleton, CommandBadge, ContextMeter } from "./info";
import { LaunchNote } from "./launch-note";
import type { Composer } from "./use-composer";

// PaneDetail が計算した表示値。入力欄の中身と、送る・止めるの判断は PaneDetail が持つ。
export type ComposerView = {
  compact: boolean;
  expanded: boolean;
  shell: boolean;
  inputDisabled: boolean;
  // 起動の待ちで、添付とコマンドを受け付けないか。
  launchBlocked: boolean;
  // 起動の待ち・失敗の行。準備ができていれば null。
  launchNote: PaneLaunchView | null;
  launching: boolean;
  // 編集中の発言。時刻だけをチップに添える。
  editTarget: ChatMessage | null;
  candidates: readonly CommandId[];
  // コマンドを持たない agent では null。
  commands: {
    newSession: ComposerCommand;
    compact: ComposerCommand;
    modelSwitch: ComposerCommand | null;
  } | null;
  mentions: {
    // 語が変わるたびに一覧を作り直す鍵。
    query: string | null;
    suggestions: readonly ProjectEntry[];
    suggested: ProjectEntry | null;
  };
  attachments: readonly AttachedFile[];
  templateCount: number | null;
  templateBlock: string | null;
  info: AgentInfo | null;
  infoLoading: boolean;
  meter: ContextMeterView | null;
  context: ChatContext | null;
  usage: ChatUsage | undefined;
  sendable: boolean;
  stop: boolean;
  busy: boolean;
  sendingAny: boolean;
  stopping: boolean;
  placeholder: string;
};

// 入力欄の外にある操作。押したときの通信と画面の遷移は PaneDetail が持つ。
export type ComposerActions = {
  submit: () => void;
  stopWorking: () => void;
  startAgent: () => void;
  toggleExpanded: () => void;
  retryLaunch: () => void;
  useShell: () => void;
  openImage: (url: string, name: string) => void;
  removeAttachment: (key: string) => void;
};

type PaneComposerProps = {
  // composer のローカル state と、その遷移。値は書き換えず、返る handler から進める。
  composer: Composer;
  // ペインと、その場所。入力欄の ID とラベル、送り先の説明に使う。
  target: { pane: PaneState; context: PaneContext };
  view: ComposerView;
  actions: ComposerActions;
};

// 入力欄まわり。文言・並び・属性は PaneDetail にあったときのまま。
export function PaneComposer(props: PaneComposerProps) {
  const { composer, target, view, actions } = props;
  const { pane, context } = target;
  const { suggestions, suggested } = view.mentions;
  // path は空白を含み得て ID にならないので、並びの位置で付ける。
  const suggestionId = (index: number) => `hwc-mention-${pane.id}-${index}`;

  return (
    <form
      class="hwc-input"
      data-expanded={view.expanded}
      data-shell={view.shell}
      data-drop={composer.dropping}
      onSubmit={(event) => {
        event.preventDefault();
        actions.submit();
      }}
      onDragEnter={composer.drag.enter}
      onDragOver={composer.drag.over}
      onDragLeave={composer.drag.leave}
      onDrop={composer.drag.drop}
    >
      {view.launchNote === null ? null : (
        <LaunchNote
          launch={view.launchNote}
          onRetry={actions.retryLaunch}
          onUseShell={actions.useShell}
        />
      )}
      <label class="hwc-visually-hidden" for={`hwc-input-${pane.id}`}>
        {context.workspaceLabel} / {context.tabLabel} のペインへ送る
      </label>
      <div class="hwc-input-frame">
        {view.compact ? null : (
          <button
            type="button"
            class="hwc-input-toggle"
            aria-expanded={view.expanded}
            aria-controls={`hwc-input-${pane.id}`}
            aria-label={view.expanded ? "入力を折りたたむ" : "入力を広げる"}
            onClick={actions.toggleExpanded}
          >
            {view.expanded ? <CollapseIcon /> : <ExpandIcon />}
          </button>
        )}
        {composer.edit !== null ? (
          <div class="hwc-commands" role="group" aria-label="編集中">
            <span class="hwc-command" data-chip="true" data-edit="true">
              <PencilIcon size={14} />
              <span class="hwc-command-label">編集中</span>
              {view.editTarget === null ? null : (
                <span class="hwc-command-text">{formatClock(view.editTarget.at)}</span>
              )}
              <button
                type="button"
                class="hwc-command-clear"
                aria-label="編集をやめる"
                disabled={composer.edit.sending}
                onClick={composer.cancelEdit}
              >
                <CloseIcon size={14} />
              </button>
            </span>
          </div>
        ) : view.attachments.length > 0 ? (
          <div class="hwc-commands" role="group" aria-label="添付ファイル">
            {view.attachments.map((item) => {
              const name = item.name;
              return (
                <span class="hwc-command hwc-attachment" data-chip="true" key={item.key}>
                  {name === null ? (
                    <span class="hwc-attachment-sending">送信中</span>
                  ) : attachmentExtFromName(name) === null ? (
                    // 画像以外は配信しない。名前だけを見せ、押しても何も開かない。
                    <>
                      <span class="hwc-attachment-name" title={name}>
                        {name}
                      </span>
                      <span class="hwc-attachment-size">{formatFileSize(item.size)}</span>
                    </>
                  ) : (
                    <button
                      type="button"
                      class="hwc-attachment-open"
                      aria-label="添付画像を拡大"
                      aria-haspopup="dialog"
                      onClick={() => actions.openImage(attachmentUrl(pane.id, name), name)}
                    >
                      <img class="hwc-attachment-thumb" src={attachmentUrl(pane.id, name)} alt="" />
                    </button>
                  )}
                  <button
                    type="button"
                    class="hwc-command-clear"
                    aria-label="添付を外す"
                    onClick={() => actions.removeAttachment(item.key)}
                  >
                    <CloseIcon size={14} />
                  </button>
                </span>
              );
            })}
          </div>
        ) : composer.activeChip !== null ? (
          <div class="hwc-commands">
            <span class="hwc-command" data-chip="true">
              <CommandBadge id={composer.activeChip} />
              <button
                type="button"
                class="hwc-command-clear"
                aria-label={`${commandText(composer.activeChip)} を解除`}
                onClick={composer.clearChip}
              >
                <CloseIcon size={14} />
              </button>
            </span>
          </div>
        ) : view.candidates.length === 0 ? null : (
          <div class="hwc-commands" role="group" aria-label="コマンド候補">
            {view.candidates.map((id) => (
              <button type="button" class="hwc-command" key={id} onClick={() => composer.pick(id)}>
                <CommandBadge id={id} />
              </button>
            ))}
          </div>
        )}
        {suggested === null ? null : (
          // 語が変わるたびに作り直し、スクロールを先頭へ戻す。
          <div class="hwc-mentions" key={view.mentions.query}>
            <div class="hwc-mentions-head" aria-hidden="true">
              プロジェクト
            </div>
            <div
              class="hwc-mentions-list"
              id={`hwc-mentions-${pane.id}`}
              role="listbox"
              aria-label="プロジェクト候補"
            >
              {suggestions.map((project, index) => (
                <button
                  type="button"
                  role="option"
                  class="hwc-mention"
                  key={project.path}
                  id={suggestionId(index)}
                  tabIndex={-1}
                  aria-selected={project.path === suggested.path}
                  // 押しても本文のフォーカスを外さない。続けて打てるようにする。
                  onMouseDown={(event) => event.preventDefault()}
                  // mouseenter だと、↑↓ のスクロールで行がポインタの下へ来たときに強調を奪う。
                  onMouseMove={() => composer.setMentionHighlight(project.path)}
                  onClick={() => composer.pickMention(project.path)}
                >
                  <span class="hwc-mention-name">{project.name}</span>
                  <span class="hwc-mention-path">{project.path}</span>
                </button>
              ))}
            </div>
          </div>
        )}
        <span class="hwc-input-line">
          {/* 消えるときに幅が跳ねないよう、シェル以外でも置いたまま折りたたむ。 */}
          <span
            class="hwc-input-prompt"
            aria-hidden="true"
            data-hidden={view.shell ? undefined : "true"}
          >
            $
          </span>
          <textarea
            id={`hwc-input-${pane.id}`}
            ref={composer.field}
            class="hwc-input-field"
            // 2 行ぶんの高さを初期値にすると、1 行のとき文字の下だけ空いて上に寄る。
            // 高さは fit() が入力量に合わせて伸ばす。
            rows={1}
            disabled={composer.edit?.sending === true}
            value={composer.inputText}
            // ツリーの行を掴むと入力欄からフォーカスが外れる。落としたときに使う
            // 選択位置をここで控える。まだ一度もフォーカスしていなければ末尾へ入れる。
            onBlur={composer.onBlur}
            onFocus={(event) => composer.syncCaret(event.currentTarget)}
            onClick={(event) => composer.syncCaret(event.currentTarget)}
            onKeyUp={(event) => composer.syncCaret(event.currentTarget)}
            aria-controls={suggested === null ? undefined : `hwc-mentions-${pane.id}`}
            aria-activedescendant={
              suggested === null ? undefined : suggestionId(suggestions.indexOf(suggested))
            }
            // 簡略時は placeholder を付けない。狭い入力欄で「メッセージを入力」が切れる。
            {...(view.compact ? {} : { placeholder: view.placeholder })}
            onInput={composer.onInput}
            onPaste={composer.onPaste}
            onKeyDown={(event) => {
              const composing = event.isComposing || event.keyCode === 229;
              if (composing) return;
              // 候補が出ている間は、Enter も候補の確定にする。候補はキーボードの
              // ある端末にしか出ないので、タッチ端末の Enter は改行のまま。
              if (composer.mention !== null && suggested !== null) {
                const plain = !(event.shiftKey || event.ctrlKey || event.metaKey || event.altKey);
                if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                  event.preventDefault();
                  const next = stepProject(
                    suggestions,
                    composer.mentionHighlight,
                    event.key === "ArrowDown" ? 1 : -1,
                  );
                  composer.setMentionHighlight(next);
                  // 強調が一覧の外へ出ないよう、描画を待たずに動かす。行は既に DOM にある。
                  const row = suggestions.findIndex((project) => project.path === next);
                  document.getElementById(suggestionId(row))?.scrollIntoView({ block: "nearest" });
                  return;
                }
                if (plain && (event.key === "Tab" || event.key === "Enter")) {
                  event.preventDefault();
                  composer.pickMention(suggested.path);
                  return;
                }
                if (event.key === "Escape") {
                  event.preventDefault();
                  composer.dismissMention();
                  return;
                }
              }
              if (event.key !== "Enter") return;
              // シェルは改行を受け取れない。タッチ端末でも Enter で送る。
              const newline =
                event.shiftKey ||
                (!view.shell && enterInsertsNewline((query) => window.matchMedia(query).matches));
              if (newline) {
                if (view.shell) event.preventDefault();
                return;
              }
              event.preventDefault();
              actions.submit();
            }}
          />
        </span>
        <div class="hwc-input-actions">
          {/* 入口を出すのはシェルだけ。会話を読めないエージェント（supportsChat が false の
              未知のエージェント）は chat が false になるので、chat ではなくペインの種類で分ける。 */}
          {view.compact ? null : view.shell ? (
            <button type="button" class="hwc-agent-start" onClick={actions.startAgent}>
              <AgentIcon size={16} />
              エージェントを起動
            </button>
          ) : pane.chat && !view.launchBlocked && !view.inputDisabled && composer.edit === null ? (
            <ComposerAdd
              full={view.attachments.length >= MAX_ATTACHMENTS}
              commands={view.commands}
              templateCount={view.templateCount}
              templateBlock={view.templateBlock}
              onFiles={(files) => composer.takeFiles(dropActionFrom(files))}
              onProjects={composer.openProjects}
              onTemplates={composer.openTemplates}
            />
          ) : null}
          <span class="hwc-input-tail">
            {view.info === null && !view.infoLoading && view.meter === null ? null : (
              <span class="hwc-input-info">
                <span class="hwc-input-agent" data-agent={agentGlyph(pane.agent)}>
                  <AgentGlyphIcon agent={pane.agent} size={14} />
                </span>
                {view.infoLoading ? (
                  <AgentInfoSkeleton />
                ) : view.info === null ? null : (
                  <AgentInfoHint agent={pane.agent} info={view.info} />
                )}
                {view.meter === null || view.context === null ? null : (
                  <ContextMeter
                    key={pane.id}
                    view={view.meter}
                    context={view.context}
                    usage={view.usage}
                  />
                )}
              </span>
            )}
            <button
              type={view.stop && !view.busy ? "button" : "submit"}
              class="hwc-send"
              data-sending={view.sendingAny}
              data-stopping={view.stopping}
              data-launching={view.launching}
              aria-label={
                view.launching
                  ? "起動中"
                  : view.stopping
                    ? "停止中"
                    : view.sendingAny
                      ? "送信中"
                      : view.stop
                        ? "停止"
                        : composer.edit !== null
                          ? "編集を送信"
                          : "送信"
              }
              aria-busy={view.launching || undefined}
              disabled={view.busy || view.launchBlocked || (!view.stop && !view.sendable)}
              onClick={view.stop && !view.busy ? actions.stopWorking : undefined}
            >
              {view.busy || view.launching ? <Spinner /> : view.stop ? <StopIcon /> : <SendIcon />}
            </button>
          </span>
        </div>
      </div>
    </form>
  );
}
