import { useEffect, useState } from "preact/hooks";
import { formatFileSize } from "../../shared/attachments";
import { looksBinary, messageFileLabel } from "../../shared/message-files";
import { previewTextUrl } from "../api";
import { ChevronLeftIcon } from "../icons";
import { Spinner } from "../Spinner";

// チャット領域に出すプレーン表示の上限。10MB のファイルをそのまま DOM に置くと、
// スマホでスクロールが重くなる。全文は既存の raw リンクから開ける。
const PREVIEW_DISPLAY_BYTES = 256 * 1024;

type PreviewBody =
  | { kind: "loading" }
  | { kind: "text"; text: string; totalBytes: number }
  | { kind: "binary" }
  | { kind: "error"; message: string };

async function readPreview(
  paneId: string,
  path: string,
  signal: AbortSignal,
): Promise<PreviewBody> {
  let response: Response;
  try {
    response = await fetch(previewTextUrl(paneId, { root: 0, name: path }), { signal });
  } catch {
    if (signal.aborted) return { kind: "loading" };
    return { kind: "error", message: "ファイルを読み込めませんでした。" };
  }

  if (response.status === 415) return { kind: "binary" };
  if (response.status === 404) return { kind: "error", message: "ファイルが見つかりません。" };
  if (!response.ok) return { kind: "error", message: "ファイルを読み込めませんでした。" };

  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await response.arrayBuffer());
  } catch {
    if (signal.aborted) return { kind: "loading" };
    return { kind: "error", message: "ファイルを読み込めませんでした。" };
  }

  // 配信側も text/plain の NUL を見て 415 にするが、HTML など型の違う経路が増えても
  // 表示だけは必ず止まるよう、クライアントでも同じ判定をする。
  if (looksBinary(bytes)) return { kind: "binary" };

  return {
    kind: "text",
    text: new TextDecoder().decode(bytes.subarray(0, PREVIEW_DISPLAY_BYTES)),
    totalBytes: bytes.byteLength,
  };
}

type FilePreviewProps = {
  paneId: string;
  path: string;
  // 狭いセルでツリーを重ねている間は、プレビューを入力と読み上げから外す。
  hidden: boolean;
  onClose: () => void;
};

export function FilePreview(props: FilePreviewProps) {
  const [body, setBody] = useState<PreviewBody>({ kind: "loading" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setBody({ kind: "loading" });
    void readPreview(props.paneId, props.path, controller.signal).then((next) => {
      if (!controller.signal.aborted) setBody(next);
    });
    return () => controller.abort();
  }, [props.paneId, props.path, attempt]);

  const name = messageFileLabel(props.path);
  return (
    <div class="hwc-file-preview" inert={props.hidden}>
      <div class="hwc-file-preview-head">
        <button type="button" class="hwc-file-preview-back" onClick={props.onClose}>
          <ChevronLeftIcon size={16} />
          <span>会話に戻る</span>
        </button>
        <span class="hwc-file-preview-name" title={props.path}>
          {name}
        </span>
      </div>
      <div class="hwc-file-preview-body" data-state={body.kind}>
        {body.kind === "loading" ? (
          <div class="hwc-file-preview-center">
            <Spinner size={16} />
            <span role="status">読み込み中</span>
          </div>
        ) : body.kind === "binary" ? (
          <div class="hwc-file-preview-center">
            <span role="status">バイナリファイルのため表示できません</span>
          </div>
        ) : body.kind === "error" ? (
          <div class="hwc-file-preview-center">
            <span role="status">{body.message}</span>
            <button
              type="button"
              class="hwc-file-preview-retry"
              onClick={() => setAttempt((current) => current + 1)}
            >
              再試行
            </button>
          </div>
        ) : (
          <>
            {body.totalBytes > PREVIEW_DISPLAY_BYTES ? (
              <p class="hwc-output-notice">
                大きいファイルのため先頭 256KB を表示しています（全
                {formatFileSize(body.totalBytes)}）。
                <a
                  class="hwc-file-preview-more"
                  href={previewTextUrl(props.paneId, { root: 0, name: props.path })}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  全文を開く
                </a>
              </p>
            ) : null}
            <pre class="hwc-file-preview-text">{body.text}</pre>
          </>
        )}
      </div>
    </div>
  );
}
