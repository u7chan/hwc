import { useId } from "preact/hooks";
import { DialogShell } from "./Dialog";
import { CloseIcon } from "./icons";

// 会話の中のサムネイルは 180px に抑えている。中身を確かめるためにタブを離れずに
// 済むよう、同じ配信 URL をダイアログで開く。
export function ImageViewer(props: { url: string; name: string; onClose: () => void }) {
  const titleId = useId();
  return (
    <DialogShell
      role="dialog"
      labelledBy={titleId}
      className="hwc-image-dialog"
      layerClassName="hwc-image-viewer"
      onClose={props.onClose}
    >
      <div class="hwc-image-head">
        <span class="hwc-image-name" id={titleId}>
          {props.name}
        </span>
        <button
          type="button"
          class="hwc-image-close"
          aria-label="閉じる"
          data-autofocus
          onClick={props.onClose}
        >
          <CloseIcon size={20} />
        </button>
      </div>
      <img class="hwc-image-full" src={props.url} alt="" />
      <a class="hwc-image-open" href={props.url} target="_blank" rel="noreferrer">
        新しいタブで開く
      </a>
    </DialogShell>
  );
}
