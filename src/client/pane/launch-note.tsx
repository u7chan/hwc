import { StatusMark } from "../icons";
import { launchFailureMessage, type PaneLaunchView } from "../starting";

type LaunchNoteProps = {
  launch: PaneLaunchView;
  onRetry: () => void;
  onUseShell: () => void;
};

// 起動失敗の行。起動待ちは送信ボタンのスピナーと読み上げ用の文で伝える。
export function LaunchNote(props: LaunchNoteProps) {
  const launching = props.launch.phase === "launching";
  const text = launching
    ? "エージェントを起動しています。準備ができるまで送信できません。"
    : props.launch.phase === "unknown"
      ? "起動を確認できませんでした。ペインの状態を見てから、もう一度お試しください。"
      : launchFailureMessage(props.launch.error);

  // 起動待ちの文言を画面に出すと入力欄が縦に伸び、起動が終わるたびに高さが変わる。
  // 失敗は理由と選択肢が要るので、行として出したままにする。
  if (launching) {
    return (
      <span class="hwc-visually-hidden" role="status">
        {text}
      </span>
    );
  }

  return (
    <div class="hwc-launch-note" role="alert">
      <span class="hwc-launch-mark" aria-hidden="true">
        <StatusMark tone="attention" size={12} />
      </span>
      <span class="hwc-launch-text">{text}</span>
      <span class="hwc-launch-actions">
        <button type="button" class="hwc-launch-action" onClick={props.onRetry}>
          再試行
        </button>
        <button type="button" class="hwc-launch-action" onClick={props.onUseShell}>
          シェルとして使う
        </button>
      </span>
    </div>
  );
}
