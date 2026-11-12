import { useEffect, useRef, useState } from "preact/hooks";

export type CompactionRun = { startedAt: number; baselineAt: number | null };
export type CompactionDuration = { at: number; ms: number };
export type CompactionEcho = { text: string; at: number; completedAt: number | null };

export type UseCompactionEcho = {
  compactionRun: CompactionRun | null;
  compactionEcho: CompactionEcho | null;
  compactionDuration: CompactionDuration | null;
  compactionElapsedMs: number | null;
  // /compact を送った時点。開始を観測できたときだけ所要時間をログに添える。
  markCompaction: (baselineAt: number | null, text: string) => void;
  // 進捗行の「中断」で畳む。
  clearCompaction: () => void;
  // /new が通ったとき。所要時間も含めて捨てる。
  resetCompaction: () => void;
};

// /compact の開始から完了までの表示。リロードやペイン切り替えでは失う（永続化は別スコープ）。
export function useCompactionEcho(options: {
  compactionAt: number | null;
  replying: boolean;
}): UseCompactionEcho {
  const { compactionAt, replying } = options;
  const [compactionRun, setCompactionRun] = useState<CompactionRun | null>(null);
  const [compactionNow, setCompactionNow] = useState(() => Date.now());
  const compactionSawWorking = useRef(false);
  const [compactionDuration, setCompactionDuration] = useState<CompactionDuration | null>(null);
  const [compactionEcho, setCompactionEcho] = useState<CompactionEcho | null>(null);

  const markCompaction = (baselineAt: number | null, text: string) => {
    const startedAt = Date.now();
    compactionSawWorking.current = false;
    setCompactionNow(startedAt);
    setCompactionEcho({ text, at: startedAt, completedAt: null });
    setCompactionRun({ startedAt, baselineAt });
  };

  useEffect(() => {
    if (compactionRun === null) return;
    setCompactionNow(Date.now());
    const timer = window.setInterval(() => setCompactionNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [compactionRun]);

  useEffect(() => {
    if (compactionRun === null) return;
    // 新しい compaction が届いたら、開始からの差を所要時間として残す。
    if (compactionAt !== null && compactionAt !== compactionRun.baselineAt) {
      const ms = compactionAt - compactionRun.startedAt;
      if (ms > 0 && ms < 24 * 60 * 60 * 1000) setCompactionDuration({ at: compactionAt, ms });
      setCompactionEcho((echo) => (echo === null ? null : { ...echo, completedAt: compactionAt }));
      setCompactionRun(null);
      return;
    }
    // 手動の /compact は Herdr の agent_status を working にしない。working を観測
    // できた場合だけ idle 復帰を失敗とみなし、それ以外は完了か上限まで待つ。
    if (replying) {
      compactionSawWorking.current = true;
      return;
    }
    if (compactionSawWorking.current) {
      const timer = window.setTimeout(() => {
        setCompactionRun((run) => (run === compactionRun ? null : run));
      }, 3000);
      return () => window.clearTimeout(timer);
    }
    const timer = window.setTimeout(
      () => {
        setCompactionRun((run) => (run === compactionRun ? null : run));
      },
      10 * 60 * 1000,
    );
    return () => window.clearTimeout(timer);
  }, [compactionRun, replying, compactionAt]);

  const compactionElapsedMs =
    compactionRun === null ? null : Math.max(0, compactionNow - compactionRun.startedAt);

  const clearCompaction = () => {
    setCompactionRun(null);
    setCompactionEcho(null);
  };

  const resetCompaction = () => {
    setCompactionRun(null);
    setCompactionEcho(null);
    setCompactionDuration(null);
  };

  return {
    compactionRun,
    compactionEcho,
    compactionDuration,
    compactionElapsedMs,
    markCompaction,
    clearCompaction,
    resetCompaction,
  };
}
