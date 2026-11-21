import { LIVE_UPDATE_OPTIONS, type LiveUpdateInterval } from "../live-update";
import { Segmented } from "../Segmented";

type LiveUpdateSettingsProps = {
  value: LiveUpdateInterval;
  onChange: (interval: LiveUpdateInterval) => void;
};

export function LiveUpdateSettings(props: LiveUpdateSettingsProps) {
  return (
    <section>
      <Segmented
        label="状態の取り直し間隔"
        options={LIVE_UPDATE_OPTIONS}
        value={props.value}
        onChange={props.onChange}
      />
      <p class="hwc-section-note">
        画面を見ている間だけ、この間隔で状態を読み直します。隠れている間は止まり、可視に戻ると 1
        回読み直します。短くすると、シェルの
        <code>cd</code> やブランチの切り替えが早く反映されます。オフにすると、Herdr
        のイベントが起きるまで反映されません。
      </p>
      <p class="hwc-section-note">この端末だけの設定です。</p>
    </section>
  );
}
