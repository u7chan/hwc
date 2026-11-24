import { ChevronLeftIcon } from "../icons";
import { OutputText } from "../OutputText";
import { OUTPUT_LINES } from "../requests/panes";
import { OutputEmpty, OutputSkeleton } from "./empty";

// 会話を持たないペイン（シェル・起動前・閲覧のみ）の表示。ANSI は OutputText が
// SGR だけを span に変えて描く。
export function TerminalOutput(props: {
  // 端末で応答を待っている間だけ出す、会話へ戻る帯。
  waiting: boolean;
  // 最新の行に切り詰めて返しているか。
  truncated: boolean;
  // 取得に失敗したか。次の取得が通るまで、その旨を残す。
  failed: boolean;
  // 取得できた端末出力。まだ届いていなければ null。
  output: string | null;
  // 出力は届いたが、中身が空か。
  empty: boolean;
  // ANSI の色を補正する基準。
  scheme: "light" | "dark";
  onBack: () => void;
}) {
  return (
    <>
      {props.waiting ? (
        // 端末出力を見ている間も、応答待ちであることと戻り先を残す。
        <div class="hwc-pending-bar" role="status">
          <span>端末で応答してください。</span>
          <button
            type="button"
            class="hwc-pending-toggle hwc-pending-toggle-back"
            onClick={props.onBack}
          >
            <ChevronLeftIcon size={16} />
            会話に戻る
          </button>
        </div>
      ) : null}
      {props.truncated ? (
        <p class="hwc-output-notice">最新の {OUTPUT_LINES} 行を表示しています</p>
      ) : null}
      {props.failed ? (
        <p class="hwc-output-notice" role="status">
          出力を取得できません。接続が戻ると自動で更新します。
        </p>
      ) : null}
      {props.output === null ? (
        props.failed ? null : (
          <OutputSkeleton />
        )
      ) : props.empty ? (
        <OutputEmpty />
      ) : (
        <pre class="hwc-output">
          <OutputText text={props.output} scheme={props.scheme} />
        </pre>
      )}
    </>
  );
}
