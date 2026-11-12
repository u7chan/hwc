import { useEffect, useState } from "preact/hooks";
import {
  loadThemePreference,
  resolveTheme,
  saveThemePreference,
  themeScheme,
  type ThemePreference,
} from "../../theme";
import { useMediaQuery } from "../use-media-query";

export type UseThemePreference = {
  theme: ThemePreference;
  scheme: "light" | "dark";
  changeTheme: (next: ThemePreference) => void;
};

// 選んだテーマは端末ごとの見え方。Herdr 側には持たせない。解決した明暗だけを document に
// 出し、ANSI 色の補正には scheme をそのまま渡す。
export function useThemePreference(): UseThemePreference {
  const [theme, setTheme] = useState<ThemePreference>(() =>
    loadThemePreference(typeof localStorage === "undefined" ? null : localStorage),
  );
  // 端末の外観は React の外にある。解決した明暗は、ANSI 色の補正と属性の両方で使う。
  const systemPrefersDark = useMediaQuery("(prefers-color-scheme: dark)");
  const resolvedTheme = resolveTheme(theme, systemPrefersDark);
  const scheme = themeScheme(resolvedTheme);

  // 端末の外観に追従するかは利用者の選択で決まる。解決した結果だけを attribute に出す。
  useEffect(() => {
    document.documentElement.dataset.theme = resolvedTheme;
    document.documentElement.dataset.scheme = scheme;
  }, [resolvedTheme, scheme]);

  const changeTheme = (next: ThemePreference) => {
    setTheme(next);
    if (typeof localStorage !== "undefined") saveThemePreference(localStorage, next);
  };

  return { theme, scheme, changeTheme };
}
