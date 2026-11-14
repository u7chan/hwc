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

    fetchTemplates(signal).then((templates) => {
      if (templates !== null) apply({ templates: templates.length });
    }, noop);
    fetchNotifications(signal).then((view) => apply({ notifications: view.enabled }), noop);
    fetchRestartSettings(signal).then((view) => apply({ restart: view.command !== null }), noop);

    return () => controller.abort();
  }, [refreshKey]);

  return summary;
}

function noop() {
  // 読めない値は行に出さない。詳細を開けば理由が出る。
}
