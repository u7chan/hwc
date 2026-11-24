// 外部から来た JSON の値を、呼び出し側が読める形に絞る。null と配列だけを弾き、
// プロトタイプを持たない object も通す。判定を厳しくすると、これまで読めていた値が
// 読めなくなるので、ここでは行わない。
export function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

export function nonEmptyText(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}
