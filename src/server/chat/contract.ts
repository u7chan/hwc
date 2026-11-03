export type ChatMessage = {
  id: string;
  role: "user" | "agent";
  text: string;
  at: number;
};

export type ChatContext = {
  tokens: number | null;
  window: number | null;
};

export type ChatSnapshot = {
  etag: string;
  messages: ChatMessage[];
  model: string | null;
  effort: string | null;
  truncated: boolean;
  context: ChatContext | null;
};
