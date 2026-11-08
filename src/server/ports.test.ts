import { expect, test } from "bun:test";
import { listeningPorts, parseListenSockets, parseSocketInode } from "./ports";

// /proc/net/tcp の形。1 行目はヘッダで、列は sl / local / rem / st / ... / inode。
const header =
  "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode";

test("only listening sockets are kept", () => {
  const text = [
    header,
    "   0: 00000000:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 104402777 1",
    "   1: 0100007F:7530 0100007F:EDBD 01 00000000:00000000 00:00000000 00000000  1000        0 286773214 1",
  ].join("\n");

  expect(parseListenSockets(text)).toEqual([{ inode: "104402777", port: 8080 }]);
});

test("tcp6 entries are read the same way", () => {
  const text = [
    header,
    "   0: 00000000000000000000000000000000:0BB8 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 42 1",
  ].join("\n");

  expect(parseListenSockets(text)).toEqual([{ inode: "42", port: 3000 }]);
});

test("broken lines and out-of-range ports are skipped", () => {
  const text = [
    header,
    "",
    "   0: 00000000 00000000:0000 0A",
    "   1: 00000000:0000 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 7 1",
  ].join("\n");

  expect(parseListenSockets(text)).toEqual([]);
  expect(parseListenSockets("")).toEqual([]);
});

test("fd links only count sockets", () => {
  expect(parseSocketInode("socket:[104402777]")).toBe("104402777");
  expect(parseSocketInode("/home/dev/notes.txt")).toBeNull();
  expect(parseSocketInode("pipe:[123]")).toBeNull();
  expect(parseSocketInode("anon_inode:[eventfd]")).toBeNull();
});

// 実プロセスの fd と /proc/net/tcp を突き合わせる。待ち受けないプロセスは空になる。
test("a listening process reports its port", async () => {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("ok") });
  try {
    expect(await listeningPorts([process.pid])).toContain(server.port ?? -1);
  } finally {
    server.stop(true);
  }
});

test("a missing process has no ports", async () => {
  expect(await listeningPorts([2_000_000_000])).toEqual([]);
  expect(await listeningPorts([])).toEqual([]);
});
