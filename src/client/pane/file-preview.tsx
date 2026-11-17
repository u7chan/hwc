import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { formatFileSize } from "../../shared/attachments";
import { looksBinary, messageFileLabel } from "../../shared/message-files";
import { previewTextUrl } from "../api";
import { ChevronLeftIcon } from "../icons";
import { Spinner } from "../Spinner";
import { normalizePreviewText, previewLineNumbers, previewTokens } from "./preview-text";

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
    text: normalizePreviewText(new TextDecoder().decode(bytes.subarray(0, PREVIEW_DISPLAY_BYTES))),
    totalBytes: bytes.byteLength,
  };
}

type FilePreviewProps = {
  paneId: string;
  path: string;
  // プレビュー中に新しい返答が届いたか。会話に戻るボタンにバッジを付ける。
  hasNewReply: boolean;
  // 狭いセルでツリーの行が消えるときだけ、この選択でここへフォーカスを移す。
  focusRequest: { focus: boolean };
  // 狭いセルでツリーを重ねている間は、プレビューを入力と読み上げから外す。
  hidden: boolean;
  onClose: () => void;
};

export function FilePreview(props: FilePreviewProps) {
  const [body, setBody] = useState<PreviewBody>({ kind: "loading" });
  const [attempt, setAttempt] = useState(0);
  const backRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const controller = new AbortController();
    setBody({ kind: "loading" });
    void readPreview(props.paneId, props.path, controller.signal).then((next) => {
      if (!controller.signal.aborted) setBody(next);
    });
    return () => controller.abort();
  }, [props.paneId, props.path, attempt]);

  // 狭いセルでは選択時にツリーの行が消える。そのときだけフォーカスをプレビューへ
  // 移し、キーボードと読み上げが document の先頭へ戻らないようにする。同じファイルを
  // 選び直したときも store は通知しないので、選択ごとの要求で動かす。広いセルでは
  // ツリーにフォーカスを残し、続けてファイルを選べるようにする。
  useEffect(() => {
    if (!props.focusRequest.focus || props.hidden) return;
    backRef.current?.focus();
  }, [props.focusRequest, props.hidden]);

  const name = messageFileLabel(props.path);
  // 行番号と色付けは本文が届いたときに 1 回だけ作る。トークン列から VNode まで
  // 作っておき、新しい返答のバッジなど無関係な再描画で作り直さない。
  const code = useMemo(() => {
    if (body.kind !== "text") return null;
    const tokens = previewTokens(body.text, props.path);
    return {
      numbers: previewLineNumbers(body.text),
      content:
        tokens === null
          ? body.text
          : tokens.map((token, index) =>
              // 演算子と句読点は色を分けない。数が多いわりに読みやすさへ寄与せず、
              // span を減らすことがスマホの描画時間に効く。
              token.kind === "plain" || token.kind === "op" ? (
                token.text
              ) : (
                <span key={index} class={`hwc-tok-${token.kind}`}>
                  {token.text}
                </span>
              ),
            ),
    };
  }, [body, props.path]);
  return (
    <section
      class="hwc-file-preview"
      role="region"
      aria-label={`${name} のプレビュー`}
      inert={props.hidden}
    >
      <div class="hwc-file-preview-head">
        <button
          ref={backRef}
          type="button"
          class="hwc-file-preview-back"
          aria-label={props.hasNewReply ? "会話に戻る。新しい応答があります" : "会話に戻る"}
          onClick={props.onClose}
        >
          <ChevronLeftIcon size={16} />
          <span>会話に戻る</span>
          {props.hasNewReply ? <span class="hwc-file-preview-new" aria-hidden="true" /> : null}
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
              <p class="hwc-output-notice hwc-file-preview-notice">
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
            <div class="hwc-file-preview-code">
              <pre class="hwc-file-preview-lines" aria-hidden="true">
                {code?.numbers}
              </pre>
              <pre class="hwc-file-preview-text">{code?.content}</pre>
            </div>
          </>
        )}
      </div>
    </section>
  );
}
