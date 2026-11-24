import { useEffect, useState } from "preact/hooks";
import type { ProjectEntry } from "../shared/projects";
import { readProjects } from "./requests/panes";

export type ProjectLoad =
  | { kind: "loading" }
  | { kind: "ready"; projects: ProjectEntry[]; truncated: boolean }
  | { kind: "failed" };

const LOADING: ProjectLoad = { kind: "loading" };

// enabled が false から true に変わるたびに取り直す。BFF が cwd ごとに 30 秒キャッシュするので、
// `@` を打つたびに走査にはならない。取り直す間は前の一覧を残し、候補を一瞬消さない。
// 別のペインの一覧は、cwd が違うので使わない。
export function useProjects(paneId: string, enabled: boolean) {
  const [loaded, setLoaded] = useState<{ paneId: string; load: ProjectLoad } | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!enabled) return;
    let active = true;
    const controller = new AbortController();
    void readProjects(paneId, controller.signal).then((result) => {
      if (!active) return;
      setLoaded({
        paneId,
        load: result === null ? { kind: "failed" } : { kind: "ready", ...result },
      });
    });
    return () => {
      active = false;
      controller.abort();
    };
  }, [paneId, enabled, attempt]);

  const retry = () => {
    setLoaded({ paneId, load: LOADING });
    setAttempt((current) => current + 1);
  };

  return { load: loaded?.paneId === paneId ? loaded.load : LOADING, retry };
}
