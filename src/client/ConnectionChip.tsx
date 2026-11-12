import { connectionLabel, type ConnectionStatus } from "./connection";

export function ConnectionChip(props: { status: ConnectionStatus }) {
  return (
    <span class="hwc-conn" data-status={props.status}>
      <span class="hwc-conn-dot" />
      {connectionLabel(props.status)}
    </span>
  );
}
