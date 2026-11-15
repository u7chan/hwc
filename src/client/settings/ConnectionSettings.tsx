import { ConnectionChip } from "../ConnectionChip";
import type { ConnectionStatus } from "../connection";

type ConnectionSettingsProps = {
  connection: ConnectionStatus;
};

export function ConnectionSettings(props: ConnectionSettingsProps) {
  return (
    <section class="hwc-section">
      <h3 class="hwc-section-title">接続</h3>
      <div class="hwc-setting-group">
        <div class="hwc-setting-row">
          <span class="hwc-setting-label">状態</span>
          <span class="hwc-setting-value" data-status={props.connection}>
            <ConnectionChip status={props.connection} />
          </span>
        </div>
      </div>
      <p class="hwc-section-note">
        Herdr から届いた状態をそのまま表示しています。切断するとブラウザが自動で再接続します。
      </p>
    </section>
  );
}
