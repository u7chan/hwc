const NO_TIMES: ReadonlyMap<string, number> = new Map();

// 時刻は BFF が持つ。端末は受け取った時刻を並べるだけで、サーバーの時計に合わせた「今」で刻む。
export function toTimes(record: Record<string, number> | undefined): ReadonlyMap<string, number> {
  return record === undefined ? NO_TIMES : new Map(Object.entries(record));
}
