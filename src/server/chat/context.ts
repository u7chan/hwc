import type { ChatContext } from "./contract";

// 出す材料が無いときだけ context を null にする。{ tokens: null, window: null } は
// 契約の型では表せるが、BFF はこの形を作らない。
export function foldContext(tokens: number | null, window: number | null): ChatContext | null {
  if (tokens === null && window === null) return null;
  return { tokens, window };
}
