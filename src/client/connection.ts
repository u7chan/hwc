export type ConnectionStatus = "connecting" | "live" | "reconnecting" | "unavailable";

export type ConnectionSignal = "snapshot" | "unavailable" | "error";

export const INITIAL_CONNECTION: ConnectionStatus = "connecting";

// EventSource は接続を自動で張り直す。こちらは届いた合図だけで表示を切り替える。
export function connectionAfter(signal: ConnectionSignal): ConnectionStatus {
  switch (signal) {
    case "snapshot":
      return "live";
    case "unavailable":
      return "unavailable";
    case "error":
      return "reconnecting";
  }
}

export function connectionLabel(status: ConnectionStatus): string {
  switch (status) {
    case "live":
      return "接続済み";
    case "reconnecting":
      return "再接続中";
    case "unavailable":
      return "Herdr 未接続";
    default:
      return "接続中";
  }
}
