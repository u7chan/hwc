import type { MessageFileKind } from "../../shared/message-files";

export type ChatFile = {
  // 配信の根（ワークスペースのチェックアウト、またはプレビュー用の追加根）からの
  // 相対パス。絶対パスは渡さない。
  name: string;
  // 中身の版（mtime とサイズ）。URL のキャッシュ破棄に使う。
  version: string;
  // 見せ方。image はサムネイル、html はプレビュー。
  kind: MessageFileKind;
  // 配信の根の番号。0 はチェックアウト、1 は /tmp、2 以上は HWC_PREVIEW_ROOTS の順。
  root: number;
  // 根の表示用のラベル（例: `/tmp`、追加根の basename）。パスではない。
  // チェックアウトは既定なので持たない。
  rootLabel?: string;
  // 本文の画像記法の destination として一致した表記。この位置に描くための照合キーで、
  // 配信 URL には使わない。裸のパスだけで拾った画像は持たない。
  imageRefs?: string[];
};

// ユーザーが送った添付 1 件。name は保存名で、絶対パスは渡さない。
// size は保存済みファイルのバイト数で、チップの表示にだけ使う。会話を読む側はファイルの
// 実在を知らないので null を置き、BFF が状態ディレクトリを見て埋める。
export type ChatAttachment = { name: string; size: number | null };

export type ChatMessage = {
  id: string;
  // error はターンが失敗した記録。本文はプロバイダや CLI が返した失敗の文言で、
  // エージェントの発話ではない。
  role: "user" | "agent" | "error";
  text: string;
  at: number;
  // 同一文言の失敗が連続したときの試行回数。1 のときは持たない。
  count?: number;
  // ペイン配下のファイル名だけを持つ。絶対パスはクライアントへ渡さない。
  attachments?: ChatAttachment[];
  // エージェントの本文が指していたファイル。ユーザーの添付とは別の一覧。
  files?: ChatFile[];
  // 本文が指していたが、配信の根（チェックアウトと追加根）の外にあったファイル名。
  // プレビューできないことを 1 行で伝えるためだけに持つ。絶対パスは渡さない。
  outsideFile?: string;
};

export type ChatContext = {
  tokens: number | null;
  window: number | null;
};

export type ChatUsage = {
  input: number | null;
  output: number | null;
  cacheRead: number | null;
  cacheWrite: number | null;
  reasoning: number | null;
};

export type ChatCompaction = {
  at: number;
  tokensBefore: number | null;
  summary: string;
  // messages のうち、この区切りより前にある件数。クライアントはこの位置に 1 行を挿む。
  // opencode は compaction 以降の会話しか返さないため常に 0 になる。
  index: number;
};

export type ChatSnapshot = {
  etag: string;
  messages: ChatMessage[];
  model: string | null;
  effort: string | null;
  truncated: boolean;
  context: ChatContext | null;
  usage?: ChatUsage;
  compaction: ChatCompaction | null;
};

// BFF がペイン id から解決した会話の読み取り口。セッション id や path はクライアントへ渡さない。
export type SessionChatClient = {
  snapshot: (sessionId: string) => Promise<ChatSnapshot>;
};
