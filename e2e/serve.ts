import { startFakeHerdr } from "./fake-herdr";

const fake = await startFakeHerdr();

// 実 Herdr・実 pi セッション・実ホームへ行かないよう、BFF の継ぎ目をすべて架空側へ向ける。
process.env.HERDR_SOCKET_PATH = fake.socketPath;
process.env.HWC_STATE_DIR = fake.root;
process.env.HWC_REVISION = "e2e";
process.env.HWC_NO_OPEN = "1";
process.env.HOST = "127.0.0.1";
process.env.PORT ??= "31000";

let closing = false;
const shutdown = async () => {
  if (closing) return;
  closing = true;
  await fake.close().catch(() => {});
  process.exit(0);
};
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());

console.log(`hwc e2e fixture: ${fake.root}`);
console.log(`hwc e2e socket: ${fake.socketPath}`);

await import("../src/server.ts");
