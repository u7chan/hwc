import { useEffect, useState } from "preact/hooks";
import { fetchRevision } from "../../api";

// どの版を見ているかを画面で確かめられるようにする。取れなくても表示だけ諦める。
export function useRevision(): string | null {
  const [revision, setRevision] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    fetchRevision(controller.signal)
      .then((revision) => {
        if (revision !== null) setRevision(revision);
      })
      .catch(() => {
        // 取れないときはラベルを出さない。
      });
    return () => controller.abort();
  }, []);

  return revision;
}
