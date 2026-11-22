import { isAbsolute } from "node:path";
import { applyHook } from "./chat/claude-sidecar";
import { applySwitchHook } from "./chat/claude-switch";

// Claude Code の hook として起動され、応答待ちの sidecar を書き、モデルの切り替えを許可・記録する
// （docs/adr/claude-integration.md）。hook の失敗は Claude の操作を止めない。どんな入力でも 0 で
// 終わる。stdout に JSON を出すと hook の判定として解釈されるので、許可を返す PreModelSwitch
// 以外では何も書かない。
const [root, switches] = process.argv.slice(2);

try {
  if (root !== undefined && isAbsolute(root)) {
    const input: unknown = JSON.parse(await Bun.stdin.text());
    await applyHook(root, input, Date.now());
    if (switches !== undefined && isAbsolute(switches)) {
      const output = await applySwitchHook(switches, input, Date.now());
      if (output !== null) process.stdout.write(output);
    }
  }
} catch {
  // 状態ディレクトリへ書けない・入力が壊れている。カードが出ないだけで、端末出力に戻る。
  // 切り替えは許可されず、CLI の確認ダイアログが開く。
}
