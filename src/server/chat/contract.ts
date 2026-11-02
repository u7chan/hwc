export type ChatMessage = {
  id: string;
  role: "user" | "agent";
  text: string;
  at: number;
};

export type ChatSnapshot = {
  etag: string;
  messages: ChatMessage[];
  model: string | null;
  effort: string | null;
  truncated: boolean;
};
