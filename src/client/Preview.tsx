import { useEffect, useMemo, useState } from "preact/hooks";
import { DialogShell } from "./Dialog";
import { TEXT_PREVIEW_BYTES, formatBytes, type Attachment } from "./files";
import { CloseIcon, PaperclipIcon } from "./icons";

type PreviewProps = {
  attachment: Attachment;
  onClose: () => void;
  onRemove: () => void;
};

function useObjectUrl(blob: Blob | null): string | null {
  const url = useMemo(() => (blob ? URL.createObjectURL(blob) : null), [blob]);
  useEffect(() => {
    if (!url) return;
    return () => URL.revokeObjectURL(url);
  }, [url]);
  return url;
}

// 中身はブラウザに任せる。読めない形式や大きすぎる画像はここで止まる。
function ImagePreview({ attachment, url }: { attachment: Attachment; url: string }) {
  return (
    <div class="hwc-preview-body hwc-preview-image">
      <img src={url} alt={attachment.name} />
    </div>
  );
}

function TextPreview({ attachment }: { attachment: Attachment }) {
  const [text, setText] = useState<string | null>(null);

  useEffect(() => {
    const blob = attachment.blob;
    if (!blob) return;
    let alive = true;
    void blob
      .slice(0, TEXT_PREVIEW_BYTES)
      .text()
      .then((value) => {
        if (alive) setText(value);
      });
    return () => {
      alive = false;
    };
  }, [attachment.blob]);

  return (
    <div class="hwc-preview-body">
      {text === null ? (
        <p class="hwc-preview-loading">読み込み中</p>
      ) : (
        <pre class="hwc-preview-text">{text}</pre>
      )}
      {attachment.size > TEXT_PREVIEW_BYTES ? (
        <p class="hwc-preview-note">先頭 {formatBytes(TEXT_PREVIEW_BYTES)} だけを表示しています</p>
      ) : null}
    </div>
  );
}

export function Preview(props: PreviewProps) {
  const url = useObjectUrl(
    props.attachment.type.startsWith("image/") ? props.attachment.blob : null,
  );
  const isImage = props.attachment.type.startsWith("image/") && url !== null;

  return (
    <DialogShell
      role="dialog"
      labelledBy="hwc-preview-title"
      className="hwc-preview"
      onClose={props.onClose}
    >
      <div class="hwc-preview-head">
        <span class="hwc-preview-mark">
          <PaperclipIcon size={16} />
        </span>
        <span class="hwc-preview-title" id="hwc-preview-title">
          {props.attachment.name}
        </span>
        <span class="hwc-preview-size">{formatBytes(props.attachment.size)}</span>
        <button
          type="button"
          class="hwc-icon-button hwc-preview-close"
          aria-label="閉じる"
          onClick={props.onClose}
        >
          <CloseIcon size={18} />
        </button>
      </div>

      {isImage ? (
        <ImagePreview attachment={props.attachment} url={url} />
      ) : (
        <TextPreview attachment={props.attachment} />
      )}

      <div class="hwc-preview-actions">
        <button type="button" class="hwc-dialog-button hwc-preview-remove" onClick={props.onRemove}>
          外す
        </button>
        <button type="button" class="hwc-dialog-button hwc-preview-done" onClick={props.onClose}>
          閉じる
        </button>
      </div>
    </DialogShell>
  );
}
