import { useEffect, useState } from "preact/hooks";
import { OUTPUT_POLL_MS, readOutput, type OutputRead } from "./api";
import { startPoll } from "./poll";

// 隠れている間に読み続けても、見る人はいない。復帰したらその場で 1 回取り直す。
export function pollDelay(visibility: DocumentVisibilityState): number | null {
  return visibility === "hidden" ? null : OUTPUT_POLL_MS;
}

// 出力を持たないペインは何もしない。null を渡すと取得も止まる。
// version は、クリアのようにポーリングを待たずに読み直したいときだけ変える。
export function usePaneOutput(
  paneId: string | null,
  version = 0,
): {
  read: OutputRead | null;
  failed: boolean;
} {
  const [latest, setLatest] = useState<OutputRead | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (paneId === null) return;
    const id = paneId;

    const poll = startPoll({
      delay: () => pollDelay(document.visibilityState),
      read: (signal) => readOutput(id, signal),
      apply: (read) => {
        setLatest(read);
        setFailed(false);
      },
      failed: () => setFailed(true),
    });
    return poll.stop;
  }, [paneId, version]);

  // ペインを切り替えた直後に、前のペインの出力を出さない。
  return { read: latest?.paneId === paneId ? latest : null, failed };
}
