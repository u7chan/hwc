// 架空 Herdr の「開発サーバー」。実プロセスとして待ち受け、BFF のポート検出を本物の
// /proc 経由で通す。起動したポートを 1 行だけ出し、SIGINT / SIGTERM で閉じる。
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("ok") });

console.log(`port:${server.port}`);

const shutdown = () => {
  server.stop(true);
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
