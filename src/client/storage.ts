// localStorage はブラウザにしかなく、プライベートモードなどでは触った時点で例外になる。
// 取得を try/catch に畳む入口をここに置く。新しく増やすアクセスは、load/save と一緒に
// これを通す（docs/adr/state-storage.md）。
export type StorageLike = {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  removeItem: (key: string) => void;
};

// 保存できない環境では null を返す。保存できなくてもその場の表示は変える。
export function storage(): StorageLike | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}
