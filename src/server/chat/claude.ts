import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { ACTIVITY_RATE_PHASES } from "../../shared/activity";
import { readLive } from "./claude-live";
import { etagOf, snapshotOf } from "./claude-projection";
import { readSidecar, SESSION_ID, SIDECAR_TTL_MS } from "./claude-sidecar";
import { sessionActivityOf } from "./claude-session-activity";
import {
  LOCAL_COMMAND_OUTPUT,
  MAX_TRANSCRIPT_BYTES,
  readTranscript,
  type TranscriptEntry,
} from "./claude-transcript";
import type { ChatSnapshot, SessionActivity, SessionChatClient } from "./contract";
import { ChatUnavailableError } from "./errors";

// poll のたびに projects/* を readdir しない。見つからなかった id は短くだけ覚える。
// 期限は実行中の poll（2 秒）2 回分。5 秒覚えると、2 秒ごとの poll では次の探索が 6 秒後に
// なり、送信で transcript ができてから会話ビューへ切り替わるまでが 5 秒を超えることがある。
const MISSING_TTL_MS = 4_000;

// 追記が止まったセッションを開き直したときに、同じファイルを読み直さない。
const MAX_PROJECTIONS = 8;

// resolved は active branch で tool_result が書かれた tool_use の id。transcript と一緒に
// 読み、sidecar の待ちがもう解決済みかの判定に使う。
type Projection = {
  size: number;
  inode: number;
  snapshot: ChatSnapshot;
  resolved: ReadonlySet<string>;
  entries: TranscriptEntry[];
};

export function createClaudeChatClient(
  options: {
    maxBytes?: number;
    now?: () => number;
    // hook が応答待ちを書く場所。無ければ transcript の末尾の tool_use だけを見る。
    pendingRoot?: string;
    // mod が生成中の速度とコンテキスト使用量を書く場所。無ければどちらも出さない。
    liveRoot?: string;
  } = {},
): SessionChatClient & {
  activity: (sessionId: string) => Promise<SessionActivity>;
  forgetMissing: (sessionId: string) => void;
  localCommandOutputs: (sessionId: string, since: number) => Promise<string[]>;
} {
  const maxBytes = options.maxBytes ?? MAX_TRANSCRIPT_BYTES;
  const now = options.now ?? Date.now;
  const locations = new Map<string, { path: string } | { missingUntil: number }>();
  const projections = new Map<string, Projection>();
  const running = new Map<string, Promise<Projection>>();
  // 検索の途中で送信があると、その結果は送信前のミスになる。覚えずに次の poll へ任せる
  // ための世代。送信のたびに進め、検索を始めた時点の値と比べる。
  let searchEpoch = 0;

  // 見つかった path は、CLAUDE_CONFIG_DIR を含めた組で覚える。unit や E2E が root を
  // 差し替えたときに、別の root の結果を引き継がないため。
  const locate = async (root: string, sessionId: string, key: string): Promise<string> => {
    const cached = locations.get(key);
    if (cached !== undefined) {
      if ("path" in cached) return cached.path;
      if (cached.missingUntil > now()) {
        throw new ChatUnavailableError("claude session was not found");
      }
      locations.delete(key);
    }

    const epoch = searchEpoch;
    const path = await findTranscript(root, sessionId);
    if (path === null) {
      // 検索中に送信があったら、このミスは送信前の結果。覚えずに次の poll で探し直す。
      if (epoch === searchEpoch) locations.set(key, { missingUntil: now() + MISSING_TTL_MS });
      throw new ChatUnavailableError("claude session was not found");
    }
    locations.set(key, { path });
    return path;
  };

  const project = async (path: string, sessionId: string): Promise<Projection> => {
    const known = projections.get(path);
    if (known !== undefined) {
      const info = await stat(path).catch(() => null);
      if (info !== null && info.isFile() && info.size === known.size && info.ino === known.inode) {
        return known;
      }
    }

    const transcript = await readTranscript(path, maxBytes);
    const projection = {
      size: transcript.size,
      inode: transcript.inode,
      ...snapshotOf(sessionId, transcript.entries, transcript.clipped),
      entries: transcript.entries,
    };
    projections.set(path, projection);
    if (projections.size > MAX_PROJECTIONS) {
      const oldest = projections.keys().next().value;
      if (oldest !== undefined) projections.delete(oldest);
    }
    return projection;
  };

  const load = async (sessionId: string): Promise<Projection> => {
    if (!SESSION_ID.test(sessionId)) {
      throw new ChatUnavailableError("claude session id is invalid");
    }
    const root = configRoot();
    const key = locationKey(root, sessionId);
    const path = await locate(root, sessionId, key);
    try {
      return await project(path, sessionId);
    } catch (error) {
      // 消えた transcript は覚えない。次に現れたときに読み直す。
      if (error instanceof ChatUnavailableError) locations.delete(key);
      throw error;
    }
  };

  // 会話と段階は同じ読み取りに相乗りする。ターン中の追記は、行が増えたときだけ読み直す。
  const shared = (sessionId: string): Promise<Projection> => {
    const pending = running.get(sessionId);
    if (pending) return pending;
    const settled = load(sessionId).finally(() => {
      if (running.get(sessionId) === settled) running.delete(sessionId);
    });
    running.set(sessionId, settled);
    return settled;
  };

  // hook の sidecar は transcript の外にあるので、transcript の射影のキャッシュとは別に毎回読む。
  // Esc で閉じた待ちは hook が何も呼ばないので、tool_result が書かれたかで解決を知る。
  const withHookPending = async (
    snapshot: ChatSnapshot,
    resolved: ReadonlySet<string>,
    sessionId: string,
  ): Promise<ChatSnapshot> => {
    if (options.pendingRoot === undefined) return snapshot;
    const sidecar = await readSidecar(options.pendingRoot, sessionId);
    const pending = sidecar?.pending ?? null;
    if (pending === null || sidecar === null) return snapshot;
    if (now() - sidecar.at > SIDECAR_TTL_MS || resolved.has(pending.toolUseId)) return snapshot;
    const { etag: _etag, ...body } = snapshot;
    return { ...body, pending, etag: etagOf(sessionId, { ...body, pending }) };
  };

  // 使用量は mod がターンの終わりに書く。transcript の射影はファイルが増えたときしか
  // 作り直さないので、射影のキャッシュとは別に毎回読んで重ねる。
  const withLiveContext = async (
    snapshot: ChatSnapshot,
    sessionId: string,
  ): Promise<ChatSnapshot> => {
    if (options.liveRoot === undefined) return snapshot;
    const live = await readLive(options.liveRoot, sessionId, now());
    const context = live?.context ?? null;
    if (context === null) return snapshot;
    const { etag: _etag, ...body } = snapshot;
    return { ...body, context, etag: etagOf(sessionId, { ...body, context }) };
  };

  return {
    // 送信で transcript ができるかもしれない。見つからない記憶を捨て、次の poll で
    // 探し直せるようにする（docs/adr/claude-integration.md）。
    forgetMissing(sessionId) {
      searchEpoch += 1;
      const key = locationKey(configRoot(), sessionId);
      const cached = locations.get(key);
      if (cached !== undefined && "missingUntil" in cached) locations.delete(key);
    },
    async snapshot(sessionId) {
      const projection = await shared(sessionId);
      const snapshot = await withHookPending(projection.snapshot, projection.resolved, sessionId);
      return withLiveContext(snapshot, sessionId);
    },
    // `/effort` の結果は、user の行に <local-command-stdout> として残る。会話には出さない
    // 記録なので、射影ではなく entry から読む（docs/adr/claude-integration.md）。
    async localCommandOutputs(sessionId, since) {
      const outputs: string[] = [];
      for (const entry of (await shared(sessionId)).entries) {
        const content = entry.message?.content;
        if (entry.type !== "user" || entry.at < since || typeof content !== "string") continue;
        const output = LOCAL_COMMAND_OUTPUT.exec(content)?.[1];
        if (output !== undefined) outputs.push(output);
      }
      return outputs;
    },
    async activity(sessionId) {
      const at = now();
      const derived = sessionActivityOf((await shared(sessionId)).entries, at);
      const activity = derived.activity;
      if (activity === null || options.liveRoot === undefined) return derived;
      // 速度は生成中の phase だけ。tool の待ちに前の応答の速度を残さない。
      if (!(ACTIVITY_RATE_PHASES as readonly string[]).includes(activity.phase)) return derived;
      const live = await readLive(options.liveRoot, sessionId, at);
      if (live?.tokPerSecond == null) return derived;
      return { ...derived, activity: { ...activity, tokPerSecond: live.tokPerSecond } };
    },
  };
}

// Claude Code は設定ディレクトリ配下の projects/<cwd のエンコード>/<session uuid>.jsonl に
// transcript を書く。プロジェクト名は内部形式なので、id で総当たりする。
async function findTranscript(root: string, sessionId: string): Promise<string | null> {
  const projects = join(root, "projects");
  let directories;
  try {
    directories = await readdir(projects, { withFileTypes: true });
  } catch {
    return null;
  }

  const matches: string[] = [];
  for (const directory of directories) {
    if (!directory.isDirectory()) continue;
    const candidate = join(projects, directory.name, `${sessionId}.jsonl`);
    const info = await stat(candidate).catch(() => null);
    if (info?.isFile() === true) matches.push(candidate);
  }

  // 同じ id が複数のプロジェクトにあると、どれが会話か決められない。推測しない。
  if (matches.length > 1) throw new ChatUnavailableError("claude session is ambiguous");
  return matches[0] ?? null;
}

function locationKey(root: string, sessionId: string): string {
  return `${root}\u0000${sessionId}`;
}

function configRoot(): string {
  const configured = process.env.CLAUDE_CONFIG_DIR;
  if (configured !== undefined && isAbsolute(configured)) return configured;
  return join(homedir(), ".claude");
}
