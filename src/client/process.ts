import { useEffect, useState } from "preact/hooks";
import type { PaneState } from "../server/herdr/state";
import type { PaneProcess } from "../shared/panes";
import { readPaneProcess } from "./api";
import { paneName } from "./select";

// Herdr は前景プロセスの変化をイベントで流さない。見えているタブのシェルだけを短い間隔で
// 読み、隠れている間は止める。開始・終了が数秒遅れて見えることは許容し、ソケットを埋めない。
export const PROCESS_POLL_MS = 3_000;

const NO_PROCESSES: ReadonlyMap<string, PaneProcess> = new Map();

export function processPollAllowed(visibility: DocumentVisibilityState): boolean {
  return visibility !== "hidden";
}

// タブの見出しは、シェルでコマンドが動いている間だけコマンドにする。止まれば元の名前に
// 戻るので、手で付けた名前は失われない。エージェントのペインはエージェント名のまま。
// 待ち受けポートが分かれば「bun 30000」のように添える。Web のサーバーかどうかは、
// ポートが出ているかで見分ける。
export function paneTabName(pane: PaneState, process: PaneProcess | null): string {
  const name = paneName(pane);
  if (pane.agent !== null || process === null || !process.running) return name;
  if (process.command === null) return name;
  const program = commandName(process.command);
  const port = process.ports[0];
  return port === undefined ? program : `${program} ${port}`;
}

// タブに出すのはプログラム名だけ。コマンド行全体はタブ 1 つで画面幅を埋め、隣のペインを
// 画面外へ追いやる。引数は title と aria-label で読める。
export function commandName(command: string): string {
  const first = command.trim().split(/\s+/)[0] ?? "";
  return first.split("/").pop() || command;
}

type Entry = readonly [paneId: string, process: PaneProcess | null];

function sameProcess(left: PaneProcess, right: PaneProcess): boolean {
  return (
    left.running === right.running &&
    left.command === right.command &&
    left.ports.length === right.ports.length &&
    left.ports.every((port, index) => port === right.ports[index])
  );
}

// 取れなかったペインは前回の値を残す。毎回同じ Map を作り直すと、変化が無いのに
// 詳細全体が再描画されるので、変わったときだけ差し替える。ポートはコマンドの起動後に
// 現れることがあるので、比較に含める。ポーリング対象から外れた ID は落とす。残すと
// 履歴のシェルのタブ名が、止んだコマンドのまま固定される。
export function mergeProcesses(
  previous: ReadonlyMap<string, PaneProcess>,
  results: readonly Entry[],
  keep: readonly string[],
): ReadonlyMap<string, PaneProcess> {
  const targets = new Set(keep);
  let next: Map<string, PaneProcess> | null = null;
  for (const paneId of previous.keys()) {
    if (targets.has(paneId)) continue;
    next = new Map(previous);
    break;
  }
  if (next !== null) {
    for (const paneId of next.keys()) {
      if (!targets.has(paneId)) next.delete(paneId);
    }
  }
  for (const [paneId, process] of results) {
    if (process === null) continue;
    const before = previous.get(paneId);
    if (before !== undefined && sameProcess(before, process)) continue;
    next ??= new Map(previous);
    next.set(paneId, process);
  }
  return next ?? previous;
}

export function usePaneProcesses(paneIds: readonly string[]): ReadonlyMap<string, PaneProcess> {
  const key = paneIds.join(" ");
  const [entries, setEntries] = useState(NO_PROCESSES);

  useEffect(() => {
    const ids = key === "" ? [] : key.split(" ");
    if (ids.length === 0) {
      setEntries(NO_PROCESSES);
      return;
    }

    const controller = new AbortController();
    let stopped = false;
    let inFlight = false;

    const load = async () => {
      if (stopped || inFlight || !processPollAllowed(document.visibilityState)) return;
      inFlight = true;
      try {
        const results = await Promise.all(
          ids.map(async (paneId): Promise<Entry> => {
            try {
              return [paneId, await readPaneProcess(paneId, controller.signal)] as const;
            } catch {
              return [paneId, null] as const;
            }
          }),
        );
        if (!stopped) setEntries((previous) => mergeProcesses(previous, results, ids));
      } finally {
        inFlight = false;
      }
    };

    void load();
    const timer = window.setInterval(() => void load(), PROCESS_POLL_MS);
    const onVisibility = () => void load();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stopped = true;
      controller.abort();
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [key]);

  return entries;
}
