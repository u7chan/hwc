import { useState } from "preact/hooks";
import type { PaneState } from "../server/herdr/state";
import type { paneCloseAction } from "../shared/pane-close";
import { SEND_FAILED_NOTICE } from "./attachments";
import { usePaneChat } from "./chat";
import {
  COMMAND_BLOCK_NOTES,
  commandAvailable,
  commandBlockReason,
  commandLabel,
  commandText,
  isCommandPane,
  type CommandId,
  type PaneCommandHandle,
} from "./commands";
import { useCopy } from "./copy";
import { CloseIcon, CollapseIcon, CopyGlyph, EraserIcon, NewSessionIcon, PlusIcon } from "./icons";
import { isShellPane } from "./select";

const CLEAR_FAILED_NOTICE = "出力をクリアできませんでした。もう一度お試しください。";

type PaneMenuProps = {
  pane: PaneState;
  full: boolean;
  closeAction: ReturnType<typeof paneCloseAction>;
  commands: PaneCommandHandle | null;
  sending: boolean;
  onCreate: () => void;
  onClearOutput: () => Promise<boolean>;
  onClosePane: () => void;
  onDismiss: () => void;
  onSubmit: (text: string) => Promise<boolean>;
};

export function PaneMenu(props: PaneMenuProps) {
  const { pane, commands, sending } = props;
  const [failed, setFailed] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [clearFailed, setClearFailed] = useState(false);
  const { copiedId, copy } = useCopy();
  const copied = copiedId === pane.id;
  // 表示中の詳細が持つ実行状態を優先する。詳細が無いペインだけ、ここで会話を読む。
  const readsChat = commands === null && pane.chat && pane.agentStatus !== "blocked";
  const { snapshot, failed: chatFailed } = usePaneChat(pane.id, readsChat, pane.agentStatus);
  const checking = readsChat && snapshot === null && !chatFailed;
  const unavailable = readsChat && chatFailed;
  const busy = sending || pane.agentStatus === "working" || (commands?.busy() ?? false);
  const available = (id: CommandId) =>
    !busy &&
    !checking &&
    !unavailable &&
    (commands?.available(id, pane) ?? commandAvailable(id, pane, snapshot));
  const block = commands === null ? commandBlockReason(snapshot) : commands.blockReason();
  const note = checking
    ? "会話を確認しています…"
    : unavailable
      ? "会話を確認できません。接続を確認してください。"
      : !busy && block !== null
        ? COMMAND_BLOCK_NOTES[block]
        : null;

  const clearOutput = async () => {
    if (clearing) return;
    setClearing(true);
    setClearFailed(false);
    const cleared = await props.onClearOutput();
    setClearing(false);
    if (cleared) props.onDismiss();
    else setClearFailed(true);
  };

  const run = async (id: CommandId) => {
    if (!available(id)) return;
    if (commands !== null) {
      props.onDismiss();
      commands.run(id);
      return;
    }
    setFailed(false);
    if (await props.onSubmit(commandText(id))) props.onDismiss();
    else setFailed(true);
  };

  return (
    <>
      <div class="hwc-menu-head hwc-menu-pane-head">
        <span>{pane.id}</span>
        <button
          type="button"
          role="menuitem"
          class="hwc-menu-copy"
          aria-label={copied ? "コピーしました" : "ペイン ID をコピー"}
          onClick={() => copy(pane.id, pane.id)}
        >
          <CopyGlyph copied={copied} />
        </button>
      </div>
      {isShellPane(pane) ? (
        <>
          <button
            type="button"
            role="menuitem"
            class="hwc-menu-item"
            disabled={clearing}
            onClick={() => void clearOutput()}
          >
            <EraserIcon size={14} />
            {clearing ? "クリアしています…" : "出力をクリア"}
          </button>
          {clearFailed ? (
            <p class="hwc-menu-note" role="alert">
              {CLEAR_FAILED_NOTICE}
            </p>
          ) : null}
        </>
      ) : null}
      {isCommandPane(pane) ? (
        <>
          <button
            type="button"
            role="menuitem"
            class="hwc-menu-item"
            disabled={!available("new")}
            onClick={() => void run("new")}
          >
            <NewSessionIcon size={14} />
            {commandLabel("new")}
          </button>
          <button
            type="button"
            role="menuitem"
            class="hwc-menu-item"
            disabled={!available("compact")}
            onClick={() => void run("compact")}
          >
            <CollapseIcon size={14} />
            {commandLabel("compact")}
          </button>
          {note === null ? null : <p class="hwc-menu-note">{note}</p>}
        </>
      ) : null}
      {sending ? (
        <p class="hwc-menu-note" role="status">
          送信中…
        </p>
      ) : null}
      {failed ? (
        <p class="hwc-menu-note" role="alert">
          {SEND_FAILED_NOTICE}
        </p>
      ) : null}
      <button
        type="button"
        role="menuitem"
        class="hwc-menu-item"
        disabled={props.full}
        onClick={props.onCreate}
      >
        <PlusIcon size={14} />
        新しいペイン
      </button>
      {props.full ? <p class="hwc-menu-note">このタブは 4 ペインまで</p> : null}
      <hr class="hwc-menu-separator" />
      <button
        type="button"
        role="menuitem"
        class="hwc-menu-item hwc-menu-item--danger"
        disabled={props.closeAction === null || props.closeAction === "keep"}
        onClick={props.onClosePane}
      >
        <CloseIcon size={14} />
        {props.closeAction === "exit" ? "エージェントを終了" : "ペインを閉じる"}
      </button>
      {props.closeAction === "exit" ? (
        <p class="hwc-menu-note">最後のペインとスペースは残します</p>
      ) : props.closeAction === "keep" ? (
        <p class="hwc-menu-note">スペースを残すため、最後のペインは閉じられません</p>
      ) : null}
    </>
  );
}
