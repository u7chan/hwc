import { useState } from "preact/hooks";
import { SIDEBAR_COLLAPSED_STORAGE_KEY, parseSidebarCollapsed } from "../../layout";

export type UseSidebarCollapsed = {
  sidebarCollapsed: boolean;
  toggleSidebar: () => void;
};

// 一覧を畳むかは幅と同じく端末ごとの見え方。Herdr 側には持たせず、再読み込みでも保つ。
export function useSidebarCollapsed(): UseSidebarCollapsed {
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() =>
    parseSidebarCollapsed(
      typeof localStorage === "undefined"
        ? null
        : localStorage.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY),
    ),
  );

  const toggleSidebar = () => {
    const next = !sidebarCollapsed;
    setSidebarCollapsed(next);
    if (typeof localStorage !== "undefined") {
      try {
        localStorage.setItem(SIDEBAR_COLLAPSED_STORAGE_KEY, String(next));
      } catch {
        // 保存だけ諦める。
      }
    }
  };

  return { sidebarCollapsed, toggleSidebar };
}
