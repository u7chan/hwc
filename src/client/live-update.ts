// Herdr がイベントを出さない cwd とブランチを、画面を見ている間だけ取り直す間隔。
// 見え方と電池の好みなので、テーマやペイン分割と同じく端末ごとに localStorage へ置き、
// BFF には送らない（docs/adr/state-storage.md）。

export type LiveUpdateInterval = "off" | "1s" | "3s" | "5s" | "10s";

export const LIVE_UPDATE_STORAGE_KEY = "hwc-live-update";

export const LIVE_UPDATE_OPTIONS: readonly {
  id: LiveUpdateInterval;
  label: string;
  ms: number;
}[] = [
  { id: "off", label: "オフ", ms: 0 },
  { id: "1s", label: "1 秒", ms: 1_000 },
  { id: "3s", label: "3 秒", ms: 3_000 },
  { id: "5s", label: "5 秒", ms: 5_000 },
  { id: "10s", label: "10 秒", ms: 10_000 },
];

export const DEFAULT_LIVE_UPDATE: LiveUpdateInterval = "3s";

export function liveUpdateMs(interval: LiveUpdateInterval): number {
  return LIVE_UPDATE_OPTIONS.find((option) => option.id === interval)?.ms ?? 0;
}

export function liveUpdateLabel(interval: LiveUpdateInterval): string {
  return LIVE_UPDATE_OPTIONS.find((option) => option.id === interval)?.label ?? "オフ";
}

function isLiveUpdateInterval(value: unknown): value is LiveUpdateInterval {
  return LIVE_UPDATE_OPTIONS.some((option) => option.id === value);
}

// 壊れた値・知らない値は既定へ倒す。オフだけは明示的な選択なので残す。
export function parseLiveUpdate(value: string | null): LiveUpdateInterval {
  return isLiveUpdateInterval(value) ? value : DEFAULT_LIVE_UPDATE;
}

// 非表示の間は取り直さない。可視に戻った時点で 1 回呼ぶ（前景プロセスの読み取りと同じ判定）。
export function liveUpdateAllowed(visibility: DocumentVisibilityState): boolean {
  return visibility !== "hidden";
}

type StorageLike = { getItem: (key: string) => string | null };

export function loadLiveUpdate(storage: StorageLike | null): LiveUpdateInterval {
  if (!storage) return DEFAULT_LIVE_UPDATE;
  try {
    return parseLiveUpdate(storage.getItem(LIVE_UPDATE_STORAGE_KEY));
  } catch {
    // 保存領域が使えない環境では既定に戻す。
    return DEFAULT_LIVE_UPDATE;
  }
}

export function saveLiveUpdate(
  storage: Pick<StorageLike, "getItem"> & { setItem: (key: string, value: string) => void },
  interval: LiveUpdateInterval,
): void {
  try {
    storage.setItem(LIVE_UPDATE_STORAGE_KEY, interval);
  } catch {
    // 保存だけ諦める。
  }
}
