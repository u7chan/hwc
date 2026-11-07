// pi 拡張（pi-lab / mypi）がセッションの隣へ書く「実行中の段階」。会話の正は JSONL のままで、
// これは一時的な activity に限る。契約は <session>.jsonl.thinking.json の 1 行 JSON で、
// 追記せず上書きする（ADR 0035）。
export const LIVE_PHASES = [
  "waiting",
  "thinking",
  "writing",
  "tool-call",
  "tool",
  "compacting",
  "waiting-user",
] as const;

export type LivePhase = (typeof LIVE_PHASES)[number];

export type PaneActivity = {
  phase: LivePhase;
  // thinking のときだけ、現在のブロックの末尾。それ以外は空。
  text: string;
  // tool のときだけ、最後に開始した実行中ツール。
  tool: string | null;
  tools: number;
  at: number;
};

export const ACTIVITY_TEXT_LIMIT = 1_200;
// ツールの実行待ちでは更新が止まる。短い期限を付けると長いビルド中に表示が消えるため、
// 残骸を弾くだけの緩い上限にする。
export const ACTIVITY_MAX_AGE_MS = 30 * 60 * 1_000;

const TOOL_NAME_LIMIT = 64;
const TOOLS_LIMIT = 99;

export function isLivePhase(value: unknown): value is LivePhase {
  return typeof value === "string" && (LIVE_PHASES as readonly string[]).includes(value);
}

// 上書き中の末尾を残す。コードポイントで切らないと絵文字が U+FFFD になる。
export function activityTextTail(text: string, limit = ACTIVITY_TEXT_LIMIT): string {
  if (limit <= 0) return "";
  const characters = Array.from(text);
  if (characters.length <= limit) return text;
  return characters.slice(-limit).join("");
}

// 書き手と読み手で同じ整形を使う。phase と合わないフィールドは捨て、壊れた値は丸ごと捨てる。
function normalizeActivity(value: unknown, now: number): PaneActivity | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (!isLivePhase(record.phase)) return null;
  if (typeof record.at !== "number" || !Number.isFinite(record.at)) return null;
  if (Math.abs(now - record.at) > ACTIVITY_MAX_AGE_MS) return null;
  const text =
    record.phase === "thinking" && typeof record.text === "string"
      ? activityTextTail(record.text)
      : "";
  const tool =
    record.phase === "tool" && typeof record.tool === "string" && record.tool !== ""
      ? record.tool.slice(0, TOOL_NAME_LIMIT)
      : null;
  const tools =
    record.phase === "tool" && typeof record.tools === "number" && Number.isFinite(record.tools)
      ? Math.min(Math.max(Math.trunc(record.tools), 1), TOOLS_LIMIT)
      : 1;
  return { phase: record.phase, text, tool, tools, at: record.at };
}

// sidecar の本文。拡張の形式（v）まで確かめる。
export function parseActivityFile(value: unknown, now: number): PaneActivity | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.v !== 1) return null;
  return normalizeActivity(record, now);
}

// BFF が返す形。会話のスナップショットと同じく、受けた値をそのまま描画には使わない。
export function parsePaneActivity(value: unknown, now = Date.now()): PaneActivity | null {
  return normalizeActivity(value, now);
}
