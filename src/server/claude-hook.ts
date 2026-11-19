import { isAbsolute } from "node:path";
import { applyHook } from "./chat/claude-sidecar";

// Claude Code の hook として起動され、応答待ちの sidecar を書く（ADR 0098）。hook の失敗は
// Claude の操作を止めない。何も出力せず、どんな入力でも 0 で終わる。stdout に JSON を出すと
// PreToolUse の判定として解釈されるので、何も書かない。
const root = process.argv[2];

try {
  if (root !== undefined && isAbsolute(root)) {
    await applyHook(root, JSON.parse(await Bun.stdin.text()), Date.now());
  }
} catch {
  // 状態ディレクトリへ書けない・入力が壊れている。カードが出ないだけで、端末出力に戻る。
}
