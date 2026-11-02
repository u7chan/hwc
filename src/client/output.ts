import { useEffect, useState } from "preact/hooks";
import { OUTPUT_POLL_MS, readOutput, type OutputRead } from "./api";

// 隠れている間に読み続けても、見る人はいない。復帰したらその場で 1 回取り直す。
export function pollDelay(visibility: DocumentVisibilityState): number | null {
  return visibility === "hidden" ? null : OUTPUT_POLL_MS;
}

// 出力を持たないペインは何もしない。null を渡すと取得も止まる。
export function usePaneOutput(paneId: string | null): {
  read: OutputRead | null;
  failed: boolean;
} {
  const [latest, setLatest] = useState<OutputRead | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (paneId === null) return;
    const id = paneId;

    let active = true;
    let timer: number | undefined;
    let controller: AbortController | null = null;

    function stop() {
      if (timer !== undefined) window.clearTimeout(timer);
      timer = undefined;
    }

    function schedule() {
      stop();
      const delay = pollDelay(document.visibilityState);
      if (delay !== null) timer = window.setTimeout(() => void load(), delay);
    }

    async function load() {
      stop();
      const current = new AbortController();
      controller = current;
      try {
        const read = await readOutput(id, current.signal);
        if (!active) return;
        setLatest(read);
        setFailed(false);
      } catch {
        // 隠れたことで打ち切った場合は失敗ではない。
        if (!active || current.signal.aborted) return;
        setFailed(true);
      }
      if (active) schedule();
    }

    function onVisibility() {
      if (document.visibilityState === "hidden") {
        stop();
        controller?.abort();
        return;
      }
      void load();
    }

    document.addEventListener("visibilitychange", onVisibility);
    void load();

    return () => {
      active = false;
      stop();
      controller?.abort();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [paneId]);

  // ペインを切り替えた直後に、前のペインの出力を出さない。
  return { read: latest?.paneId === paneId ? latest : null, failed };
}
