import type { ConnectionStatus } from "../connection";
import { HwcMark } from "../icons";

export function ListPlaceholder(props: { connection: ConnectionStatus }) {
  const { connection } = props;
  return (
    <div class="hwc-empty">
      <div class="hwc-empty-mark">
        <HwcMark size={32} />
      </div>
      <h2 class="hwc-empty-title">
        {connection === "unavailable" ? "Herdr に接続できません" : "接続中"}
      </h2>
      <p class="hwc-empty-text">
        {connection === "unavailable"
          ? "Herdr が起動しているか確かめてください。"
          : "ペインの一覧を受け取っています。"}
      </p>
    </div>
  );
}

export function Placeholder(props: { connection: ConnectionStatus }) {
  const { connection } = props;
  return (
    <div class="hwc-empty hwc-empty--detail">
      <div class="hwc-empty-mark hwc-empty-mark--app">
        <HwcMark size={40} />
      </div>
      <h2 class="hwc-empty-title">
        {connection === "unavailable" ? "Herdr に接続できません" : "接続中"}
      </h2>
      <p class="hwc-empty-text">
        {connection === "unavailable"
          ? "Herdr が起動しているか確かめてください。接続が戻ると自動で表示されます。"
          : "Herdr の状態を受け取っています。"}
      </p>
    </div>
  );
}

// 文字とマークのインクに合わせた実測の viewBox。高さは .hwc-foot-logo が決める。
// マークの比率は favicon（favicon.ts / favicon.svg）と HwcMark に揃える。
// 辺・隙間・角丸・4 象限目の不透明度を直すときは 4 か所そろえる。
export function FooterBrand() {
  return (
    <svg class="hwc-foot-logo" viewBox="0 24 329.4 77" role="img" aria-label="HWC">
      <g fill="currentColor">
        <rect x="0" y="24" width="33.8" height="33.8" rx="10.6" />
        <rect x="42.2" y="24" width="33.8" height="33.8" rx="10.6" />
        <rect x="0" y="66.2" width="33.8" height="33.8" rx="10.6" />
        <rect x="42.2" y="66.2" width="33.8" height="33.8" rx="10.6" opacity="0.45" />
      </g>
      <text
        x="97"
        y="100"
        font-size="100"
        font-weight="600"
        letter-spacing="2.5"
        fill="currentColor"
      >
        HWC
      </text>
    </svg>
  );
}
