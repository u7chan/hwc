import { readdir, readFile, readlink } from "node:fs/promises";

// 前景プロセスが待ち受けている TCP ポート。Herdr はプロセスの情報しか返さないので、
// /proc のソケットと fd を突き合わせて引く。Linux（WSL2）専用で、読めない環境では空にする。
export async function listeningPorts(pids: readonly number[]): Promise<number[]> {
  if (pids.length === 0) return [];

  const [tcp, tcp6] = await Promise.all([readText("/proc/net/tcp"), readText("/proc/net/tcp6")]);
  const byInode = new Map<string, number>();
  for (const socket of [...parseListenSockets(tcp), ...parseListenSockets(tcp6)]) {
    byInode.set(socket.inode, socket.port);
  }
  if (byInode.size === 0) return [];

  const ports = new Set<number>();
  for (const pid of pids) {
    for (const inode of await socketInodes(pid)) {
      const port = byInode.get(inode);
      if (port !== undefined) ports.add(port);
    }
  }
  return [...ports].sort((left, right) => left - right);
}

export type ListenSocket = { inode: string; port: number };

// /proc/net/tcp の行は `sl local_address rem_address st ... inode`。LISTEN は st=0A。
export function parseListenSockets(text: string): ListenSocket[] {
  const sockets: ListenSocket[] = [];
  for (const line of text.split("\n").slice(1)) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 10) continue;
    if (fields[3] !== "0A") continue;
    const port = Number.parseInt(fields[1]?.split(":")[1] ?? "", 16);
    const inode = fields[9];
    if (!Number.isInteger(port) || port <= 0 || port > 65_535 || inode === undefined) continue;
    sockets.push({ inode, port });
  }
  return sockets;
}

// fd のリンク先は `socket:[123]`。ファイルや pipe は無視する。
export function parseSocketInode(target: string): string | null {
  return /^socket:\[(\d+)\]$/.exec(target)?.[1] ?? null;
}

async function socketInodes(pid: number): Promise<string[]> {
  const directory = `/proc/${pid}/fd`;
  let entries: string[];
  try {
    entries = await readdir(directory);
  } catch {
    return [];
  }

  const inodes: string[] = [];
  for (const entry of entries) {
    try {
      const inode = parseSocketInode(await readlink(`${directory}/${entry}`));
      if (inode !== null) inodes.push(inode);
    } catch {
      // 読んでいる間に閉じられた fd。数に入れない。
    }
  }
  return inodes;
}

async function readText(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return "";
  }
}
