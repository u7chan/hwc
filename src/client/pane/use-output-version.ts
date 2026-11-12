import { useState } from "preact/hooks";

export type UseOutputVersion = {
  outputVersion: number;
  // クリア後にポーリングを待たず、出力を取り直すための契機。
  requestOutputRefresh: () => void;
};

// 出力の購読は version を effect の依存に取るので、こちらが先に確定している必要がある。
// 追従の判断は useOutputFollow が持ち、読み直しの要求だけをここに置く。
export function useOutputVersion(): UseOutputVersion {
  const [outputVersion, setOutputVersion] = useState(0);
  const requestOutputRefresh = () => setOutputVersion((version) => version + 1);
  return { outputVersion, requestOutputRefresh };
}
