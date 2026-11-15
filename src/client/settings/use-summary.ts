import { useEffect, useState } from "preact/hooks";
import { fetchNotifications, fetchRestartSettings, fetchTemplates } from "../api";

export type SettingsSummary = {
  templates: number | null;
  notifications: boolean | null;
  restart: boolean | null;
};

const LOADING: SettingsSummary = { templates: null, notifications: null, restart: null };

// 一覧の行に出す現在値だけを読む。保存は各画面が持つので、ここでは値を写さない。
// 詳細で保存したら refreshKey を進め、写しではなく BFF から引き直す。
export function useSettingsSummary(refreshKey: number): SettingsSummary {
  const [summary, setSummary] = useState<SettingsSummary>(LOADING);

  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    const apply = (patch: Partial<SettingsSummary>) => {
      if (!signal.aborted) setSummary((current) => ({ ...current, ...patch }));
    };

    // 読めなかった値は消す。古い値を残すと、詳細で変えたあとに食い違ったままになる。
    fetchTemplates(signal).then(
      (templates) => apply({ templates: templates === null ? null : templates.length }),
      () => apply({ templates: null }),
    );
    fetchNotifications(signal).then(
      (view) => apply({ notifications: view.enabled }),
      () => apply({ notifications: null }),
    );
    fetchRestartSettings(signal).then(
      (view) => apply({ restart: view.command !== null }),
      () => apply({ restart: null }),
    );

    return () => controller.abort();
  }, [refreshKey]);

  return summary;
}
