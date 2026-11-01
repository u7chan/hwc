import type { AgentStatus } from "../server/herdr/state";
import { StatusMark } from "./icons";
import { AttentionMark, WorkingMark } from "./Spinner";
import { statusLabel, statusTone } from "./select";

// 動きを減らす設定では止める。要対応だけは静止した記号で示す。
const reducedMotion = () =>
  typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

export function StatusLabel({ status }: { status: AgentStatus }) {
  const tone = statusTone(status);
  const animated = !reducedMotion();
  return (
    <span class={`hwc-status hwc-status--${tone}`} role="img" aria-label={statusLabel(status)}>
      {animated && tone === "active" ? (
        <WorkingMark size={18} />
      ) : animated && tone === "attention" ? (
        <AttentionMark size={18} />
      ) : (
        <StatusMark tone={tone} size={18} />
      )}
      <span class="hwc-status-text">{statusLabel(status)}</span>
    </span>
  );
}
