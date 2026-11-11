import { useEffect, useState } from "preact/hooks";
import type { ChatFile } from "../server/chat/contract";
import type { PreviewWarning } from "../shared/message-files";
import { probePreviewWarning, previewUrl } from "./api";
import { messageFileDisplayName } from "./chat";
import { CloseIcon, ExternalIcon, ReloadIcon } from "./icons";

const WARNING_TEXT =
  "この HTML はプレビューで配信できないスクリプトを読み込むため、中身が表示されないことがあります";

// 開いた URL と再読み込みの回数ごとに 1 件だけ持つ。遅れて返った結果で別のファイルの
// 案内を出さないよう、今のキーと一致するものだけを描く。
type Probe = { key: string; warning: PreviewWarning };

// プレビューはタブの 1 つとして detail を占有する。会話へ戻るのはタブの切り替え。
// 再読み込みは同じ URL を作り直すだけ。配信は no-store なので常に最新が出る。
export function Preview(props: { paneId: string; file: ChatFile; onClose: () => void }) {
  const [reload, setReload] = useState(0);
  const [probe, setProbe] = useState<Probe | null>(null);
  const url = previewUrl(props.paneId, props.file);
  const key = `${reload}:${url}`;
  const display = messageFileDisplayName(props.file.name, props.file.rootLabel);

  // 開いたときと再読み込みのたびに、同じ URL を HEAD で確かめる。期限切れと失敗は
  // 案内を出さないだけにして、プレビューは今までどおり動かす。
  useEffect(() => {
    let stale = false;
    void probePreviewWarning(props.paneId, props.file, AbortSignal.timeout(3_000)).then(
      (warning) => {
        if (stale || warning === null) return;
        setProbe({ key, warning });
      },
    );
    return () => {
      stale = true;
    };
  }, [key]);

  const warned = probe !== null && probe.key === key;

  return (
    <div class="hwc-preview">
      <div class="hwc-preview-head">
        <span class="hwc-preview-name" title={props.file.name}>
          {display}
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
      {warned ? <p class="hwc-preview-warning">{WARNING_TEXT}</p> : null}
      {/*
        allow-same-origin を付けないのが要。同じオリジンにすると、モックの script が
        親の document に触れて sandbox を外せてしまう（ADR 0051）。
      */}
      <iframe
        class="hwc-preview-frame"
        title={`${display} のプレビュー`}
        src={reload === 0 ? url : `${url}?r=${reload}`}
        sandbox="allow-scripts"
        referrerpolicy="no-referrer"
      />
    </div>
  );
}
