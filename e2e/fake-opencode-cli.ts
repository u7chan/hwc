import { copyFile } from "node:fs/promises";
import { dirname, join } from "node:path";

// 実 opencode はユーザーの常駐サービスを起動する。E2E では `service start` だけを受け、
// 架空サービスの接続情報を service.json へ戻す。控えも無ければ起動失敗とする。
const args = process.argv.slice(2);
const target = process.env.HWC_OPENCODE_SERVICE;
if (args.join(" ") !== "service start" || !target) process.exit(2);
try {
  await copyFile(join(dirname(target), "service.fixture.json"), target);
} catch {
  process.exit(1);
}
