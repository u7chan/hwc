export type ThemePreference = "system" | "light" | "dark";
export type ResolvedTheme = "light" | "dark";

export const THEME_STORAGE_KEY = "hwc-theme";

export function parseThemePreference(value: string | null): ThemePreference {
  return value === "light" || value === "dark" ? value : "system";
}

export function resolveTheme(
  preference: ThemePreference,
  systemPrefersDark: boolean,
): ResolvedTheme {
  if (preference !== "system") return preference;
  return systemPrefersDark ? "dark" : "light";
}

type StorageLike = { getItem: (key: string) => string | null };

export function loadThemePreference(storage: StorageLike | null): ThemePreference {
  if (!storage) return "system";
  try {
    return parseThemePreference(storage.getItem(THEME_STORAGE_KEY));
  } catch {
    // 保存領域が使えない環境では既定に戻す。
    return "system";
  }
}

export function saveThemePreference(
  storage: Pick<StorageLike, "getItem"> & { setItem: (key: string, value: string) => void },
  preference: ThemePreference,
): void {
  try {
    storage.setItem(THEME_STORAGE_KEY, preference);
  } catch {
    // 保存できなくてもその場の表示は変える。
  }
}
