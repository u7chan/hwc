import { useState } from "preact/hooks";
import { loadSidebarCollapsed, saveSidebarCollapsed } from "../../layout";
import { storage } from "../../storage";

export type UseSidebarCollapsed = {
  sidebarCollapsed: boolean;
  toggleSidebar: () => void;
};

// 一覧を畳むかは幅と同じく端末ごとの見え方。Herdr 側には持たせず、再読み込みでも保つ。
export function useSidebarCollapsed(): UseSidebarCollapsed {
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => loadSidebarCollapsed(storage()));

  const toggleSidebar = () => {
    const next = !sidebarCollapsed;
    setSidebarCollapsed(next);
    saveSidebarCollapsed(storage(), next);
  };

  return { sidebarCollapsed, toggleSidebar };
}
