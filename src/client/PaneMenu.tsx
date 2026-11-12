import { useState } from "preact/hooks";
import type { PaneState } from "../server/herdr/state";
import type { paneCloseAction } from "../shared/pane-close";
import { useCopy } from "./copy";
import { CloseIcon, CopyGlyph, EraserIcon, PlusIcon } from "./icons";
import { isShellPane } from "./select";

const CLEAR_FAILED_NOTICE = "出力をクリアできませんでした。もう一度お試しください。";

type PaneMenuProps = {
  pane: PaneState;
  workspacePath: string | null;
  full: boolean;
  closeAction: ReturnType<typeof paneCloseAction>;
  onCreate: () => void;
  onClearOutput: () => Promise<boolean>;
  onClosePane: () => void;
  onDismiss: () => void;
};

// 会話コマンドは入力欄の + から実行する（ADR 0057 composer-conversation-commands）。
// ここはペインとタブの操作だけに残す。
export function PaneMenu(props: PaneMenuProps) {
  const { pane, workspacePath } = props;
  const [clearing, setClearing] = useState(false);
  const [clearFailed, setClearFailed] = useState(false);
  const { copiedId, copy } = useCopy();
  const copied = copiedId === pane.id;
  const copiedPath = copiedId === "workspace-path";

  const clearOutput = async () => {
    if (clearing) return;
    setClearing(true);
    setClearFailed(false);
    const cleared = await props.onClearOutput();
    setClearing(false);
    if (cleared) props.onDismiss();
    else setClearFailed(true);
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
      {workspacePath === null ? null : (
        <button
          type="button"
          role="menuitem"
          class="hwc-menu-item"
          aria-label={copiedPath ? "コピーしました" : "スペースのパスをコピー"}
          onClick={() => copy("workspace-path", workspacePath)}
        >
          <CopyGlyph copied={copiedPath} size={14} />
          スペースのパスをコピー
        </button>
      )}
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
