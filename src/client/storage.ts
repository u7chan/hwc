// localStorage はブラウザにしかなく、プライベートモードなどでは触った時点で例外になる。
// 触る入口をここ 1 か所に畳み、呼び出し元は load/save に null を渡せばよい形にする
// （docs/adr/state-storage.md）。
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
