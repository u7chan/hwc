import { useState } from "preact/hooks";
import type { ChatFile } from "../server/chat/contract";
import { messageFileLabel } from "../shared/message-files";
import { previewUrl } from "./api";
import { CloseIcon, ExternalIcon, ReloadIcon } from "./icons";

// プレビューはタブの 1 つとして detail を占有する。会話へ戻るのはタブの切り替え。
// 再読み込みは同じ URL を作り直すだけ。配信は no-store なので常に最新が出る。
export function Preview(props: { paneId: string; file: ChatFile; onClose: () => void }) {
  const [reload, setReload] = useState(0);
  const url = previewUrl(props.paneId, props.file);
  const name = messageFileLabel(props.file.name);

  return (
    <div class="hwc-preview">
      <div class="hwc-preview-head">
        <span class="hwc-preview-name" title={props.file.name}>
          {name}
        </span>
        <button
          type="button"
          class="hwc-icon-button"
          aria-label="再読み込み"
          onClick={() => setReload((count) => count + 1)}
        >
          <ReloadIcon size={18} />
        </button>
        <a
          class="hwc-icon-button"
          href={url}
          target="_blank"
          rel="noreferrer"
          aria-label="新しいタブで開く"
        >
          <ExternalIcon size={18} />
        </a>
        <button
          type="button"
          class="hwc-icon-button"
          aria-label="プレビューを閉じる"
          onClick={props.onClose}
        >
          <CloseIcon size={18} />
        </button>
      </div>
      {/*
        allow-same-origin を付けないのが要。同じオリジンにすると、モックの script が
        親の document に触れて sandbox を外せてしまう（ADR 0051）。
      */}
      <iframe
        class="hwc-preview-frame"
        title={`${name} のプレビュー`}
        src={reload === 0 ? url : `${url}?r=${reload}`}
        sandbox="allow-scripts"
        referrerpolicy="no-referrer"
      />
    </div>
  );
}
