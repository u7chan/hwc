export type ChatMessage = {
  id: string;
  role: "user" | "agent";
  text: string;
  at: number;
  // ペイン配下のファイル名だけを持つ。絶対パスはクライアントへ渡さない。
  attachments?: string[];
};

export type ChatContext = {
  tokens: number | null;
  window: number | null;
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
  compaction: ChatCompaction | null;
};

// BFF がペイン id から解決した会話の読み取り口。セッション id や path はクライアントへ渡さない。
export type SessionChatClient = {
  snapshot: (sessionId: string) => Promise<ChatSnapshot>;
};
