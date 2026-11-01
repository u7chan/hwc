import type { AgentStatus } from "../server/herdr/state";
import { AttentionMark, StatusMark } from "./icons";
import { SpinnerDots } from "./Spinner";
import { statusLabel, statusTone } from "./select";

// 動きを減らす設定では止める。要対応だけは静止した記号で示す。
const reducedMotion = () =>
  typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

export function StatusLabel({ status }: { status: AgentStatus }) {
  const tone = statusTone(status);
  const animated = !reducedMotion();
  return (
    <span class={`hwc-status hwc-status--${tone}`}>
      {animated && tone === "active" ? (
        <SpinnerDots />
      ) : animated && tone === "attention" ? (
        <AttentionMark />
      ) : (
        <StatusMark tone={tone} />
      )}
      <span>{statusLabel(status)}</span>
    </span>
  );
}
