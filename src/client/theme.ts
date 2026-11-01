export type ThemeId =
  | "light"
  | "dark"
  | "catppuccin-latte"
  | "catppuccin-frappe"
  | "catppuccin-macchiato"
  | "catppuccin-mocha"
  | "nord"
  | "tokyo-night"
  | "kanagawa"
  | "gruvbox"
  | "everforest"
  | "dracula"
  | "rose-pine-dawn"
  | "one-light"
  | "solarized-light"
  | "solarized-dark";

export type ThemePreference = "system" | ThemeId;

export type ThemeMeta = {
  id: ThemeId;
  label: string;
  scheme: "light" | "dark";
  swatch: { bg: string; surface: string; accent: string };
};

export const THEMES: readonly ThemeMeta[] = [
  {
    id: "light",
    label: "ライト",
    scheme: "light",
    swatch: { bg: "#f4f5f7", surface: "#ffffff", accent: "#255cd6" },
  },
  {
    id: "dark",
    label: "ダーク",
    scheme: "dark",
    swatch: { bg: "#101215", surface: "#1b1e23", accent: "#94baff" },
  },
  {
    id: "catppuccin-latte",
    label: "Catppuccin Latte",
    scheme: "light",
    swatch: { bg: "#e6e9ef", surface: "#eff1f5", accent: "#1e66f5" },
  },
  {
    id: "catppuccin-mocha",
    label: "Catppuccin Mocha",
    scheme: "dark",
    swatch: { bg: "#11111b", surface: "#1e1e2e", accent: "#89b4fa" },
  },
  {
    id: "catppuccin-frappe",
    label: "Catppuccin Frappé",
    scheme: "dark",
    swatch: { bg: "#292c3c", surface: "#303446", accent: "#8caaee" },
  },
  {
    id: "catppuccin-macchiato",
    label: "Catppuccin Macchiato",
    scheme: "dark",
    swatch: { bg: "#1e2030", surface: "#24273a", accent: "#8aadf4" },
  },
  {
    id: "nord",
    label: "Nord",
    scheme: "dark",
    swatch: { bg: "#2e3440", surface: "#3b4252", accent: "#88c0d0" },
  },
  {
    id: "tokyo-night",
    label: "Tokyo Night",
    scheme: "dark",
    swatch: { bg: "#1a1b26", surface: "#1f2335", accent: "#7aa2f7" },
  },
  {
    id: "kanagawa",
    label: "Kanagawa",
    scheme: "dark",
    swatch: { bg: "#1f1f28", surface: "#2a2a37", accent: "#7e9cd8" },
  },
  {
    id: "gruvbox",
    label: "Gruvbox",
    scheme: "dark",
    swatch: { bg: "#282828", surface: "#32302f", accent: "#83a598" },
  },
  {
    id: "everforest",
    label: "Everforest",
    scheme: "dark",
    swatch: { bg: "#2d353b", surface: "#343f44", accent: "#a7c080" },
  },
  {
    id: "dracula",
    label: "Dracula",
    scheme: "dark",
    swatch: { bg: "#21222c", surface: "#282a36", accent: "#bd93f9" },
  },
  {
    id: "rose-pine-dawn",
    label: "Rosé Pine Dawn",
    scheme: "light",
    swatch: { bg: "#faf4ed", surface: "#fffaf3", accent: "#907aa9" },
  },
  {
    id: "one-light",
    label: "One Light",
    scheme: "light",
    swatch: { bg: "#fafafa", surface: "#ffffff", accent: "#4078f2" },
  },
  {
    id: "solarized-light",
    label: "Solarized Light",
    scheme: "light",
    swatch: { bg: "#eee8d5", surface: "#fdf6e3", accent: "#268bd2" },
  },
  {
    id: "solarized-dark",
    label: "Solarized Dark",
    scheme: "dark",
    swatch: { bg: "#002b36", surface: "#073642", accent: "#268bd2" },
  },
];

const THEME_IDS = new Set<string>(THEMES.map((theme) => theme.id));

export const THEME_STORAGE_KEY = "hwc-theme";

export function parseThemePreference(value: string | null): ThemePreference {
  if (value === "system") return "system";
  return value && THEME_IDS.has(value) ? (value as ThemeId) : "system";
}

// システムは OS の外観に合わせる。具体的な名前が選ばれていればそれを使う。
export function resolveTheme(preference: ThemePreference, systemPrefersDark: boolean): ThemeId {
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
