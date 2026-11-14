import { StatusMark } from "../icons";
import { launchFailureMessage, type PaneLaunchView } from "../starting";

type LaunchNoteProps = {
  launch: PaneLaunchView;
  compact: boolean;
  onRetry: () => void;
  onUseShell: () => void;
};

// 起動待ちと起動失敗の行。入力欄は出したまま、送信だけを閉じている理由を示す。
export function LaunchNote(props: LaunchNoteProps) {
  const launching = props.launch.phase === "launching";
  const text = launching
    ? "エージェントを起動しています。準備ができるまで送信できません。"
    : props.launch.phase === "unknown"
      ? "起動を確認できませんでした。ペインの状態を見てから、もう一度お試しください。"
      : launchFailureMessage(props.launch.error);

  // compact は入力欄の高さを削りすぎないよう、起動中の説明を出さない。状態は送信ボタンの
  // スピナーと、読み上げ用の文で伝える。失敗は理由と選択肢が要るので出したままにする。
  if (launching && props.compact) {
    return (
      <span class="hwc-visually-hidden" role="status">
        {text}
      </span>
    );
  }

  return (
    <div
      class="hwc-launch-note"
      data-phase={props.launch.phase}
      data-tone={launching ? undefined : "attention"}
      role={launching ? "status" : "alert"}
    >
      {launching ? null : (
        <span class="hwc-launch-mark" aria-hidden="true">
          <StatusMark tone="attention" size={12} />
        </span>
      )}
      <span class="hwc-launch-text">{text}</span>
      {launching ? null : (
        <span class="hwc-launch-actions">
          <button type="button" class="hwc-launch-action" onClick={props.onRetry}>
            再試行
          </button>
          <button type="button" class="hwc-launch-action" onClick={props.onUseShell}>
            シェルとして使う
          </button>
        </span>
      )}
    </div>
  );
}
