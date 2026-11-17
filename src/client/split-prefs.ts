// 委譲で現れたペインをどう見せるかは端末ごとの好み。Herdr の状態ではないので
// localStorage に置き、BFF には送らない（ADR 0092）。

export type SplitMotion = "off" | "slow" | "normal" | "fast";

export type SplitPrefs = {
  autoSplit: boolean;
  motion: SplitMotion;
};

export const SPLIT_PREFS_STORAGE_KEY = "hwc-split-prefs";

export const DEFAULT_SPLIT_PREFS: SplitPrefs = { autoSplit: true, motion: "normal" };

// 分割線が動く時間。なしは 0 にして、セルをその場で入れ替える。
export const SPLIT_MOTIONS: readonly { id: SplitMotion; label: string; duration: number }[] = [
  { id: "off", label: "なし", duration: 0 },
  { id: "slow", label: "ゆっくり", duration: 560 },
  { id: "normal", label: "標準", duration: 280 },
  { id: "fast", label: "速い", duration: 160 },
];

export function splitMotionDuration(motion: SplitMotion): number {
  return SPLIT_MOTIONS.find((item) => item.id === motion)?.duration ?? 280;
}

function isMotion(value: unknown): value is SplitMotion {
  return SPLIT_MOTIONS.some((item) => item.id === value);
}

// 壊れた値は既定へ倒す。片方だけ読める値は、読めた方を残す。
export function parseSplitPrefs(value: string | null): SplitPrefs {
  if (value === null) return DEFAULT_SPLIT_PREFS;
  try {
    const raw: unknown = JSON.parse(value);
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return DEFAULT_SPLIT_PREFS;
    const record = raw as Record<string, unknown>;
    return {
      autoSplit: typeof record.autoSplit === "boolean" ? record.autoSplit : true,
      motion: isMotion(record.motion) ? record.motion : "normal",
    };
  } catch {
    return DEFAULT_SPLIT_PREFS;
  }
}

export function serializeSplitPrefs(prefs: SplitPrefs): string {
  return JSON.stringify({ autoSplit: prefs.autoSplit, motion: prefs.motion });
}

type StorageLike = { getItem: (key: string) => string | null };

export function loadSplitPrefs(storage: StorageLike | null): SplitPrefs {
  if (!storage) return DEFAULT_SPLIT_PREFS;
  try {
    return parseSplitPrefs(storage.getItem(SPLIT_PREFS_STORAGE_KEY));
  } catch {
    // 保存領域が使えない環境では既定に戻す。
    return DEFAULT_SPLIT_PREFS;
  }
}

export function saveSplitPrefs(
  storage: Pick<StorageLike, "getItem"> & { setItem: (key: string, value: string) => void },
  prefs: SplitPrefs,
): void {
  try {
    storage.setItem(SPLIT_PREFS_STORAGE_KEY, serializeSplitPrefs(prefs));
  } catch {
    // 保存だけ諦める。
  }
}
