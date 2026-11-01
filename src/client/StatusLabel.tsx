import type { AgentStatus } from "../server/herdr/state";
import { StatusMark } from "./icons";
import { statusLabel, statusTone } from "./select";

export function StatusLabel({ status }: { status: AgentStatus }) {
  const tone = statusTone(status);
  return (
    <span class={`hwc-status hwc-status--${tone}`}>
      <StatusMark tone={tone} />
      <span>{statusLabel(status)}</span>
    </span>
  );
}
