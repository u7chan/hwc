import {
  LOCAL_COMMAND_OUTPUT,
  MAIN_THREAD_SOURCE,
  SYNTHETIC_MODEL,
  type TranscriptEntry,
  type TranscriptUsage,
} from "./claude-transcript";

// 1 時間プロンプトキャッシュの寿命。期限は「要求の送信時刻 + これ」で出す。
const PROMPT_CACHE_TTL_MS = 60 * 60 * 1000;

// キャッシュを切るローカルコマンドの結果。取り消し（`Kept model as ...`）は含めない。
const CACHE_INVALIDATING_OUTPUT = /^(?:Set model to |Set effort level to )/;

// 1 時間プロンプトキャッシュの期限（Unix ミリ秒）。statusline や mod には依存せず、
// active branch の完了応答だけから出す（docs/adr/claude-integration.md）。
export function promptCacheExpiry(
  entries: readonly TranscriptEntry[],
  branch: readonly TranscriptEntry[],
): number | null {
  // 要求の行は uuid を持たず枝に入らない。id で引けるようにしておく。
  const requests = new Map<string, { at: number; index: number }>();
  for (const entry of entries) {
    if (entry.type !== "api-request" || entry.querySource !== MAIN_THREAD_SOURCE) continue;
    if (entry.requestId === null) continue;
    requests.set(entry.requestId, { at: entry.at, index: entry.index });
  }

  // 応答は block ごとに複数行へ分かれる。完了した要求ごとに 1 回だけ扱い、usage を持つ行を
  // 優先する（最初の行に無くても、同じ応答の別の行から拾う）。
  const completed = new Map<string, { index: number; usage: TranscriptUsage | null }>();
  for (const entry of branch) {
    if (entry.type !== "assistant" || entry.sidechain || entry.apiError) continue;
    const requestRef = entry.requestRef;
    const entryModel = entry.message?.model ?? null;
    if (requestRef === null || entry.message?.stopReason == null) continue;
    if (entryModel === null || entryModel === SYNTHETIC_MODEL) continue;
    const known = completed.get(requestRef);
    if (known === undefined) {
      completed.set(requestRef, { index: entry.index, usage: entry.message?.usage ?? null });
      continue;
    }
    if (known.usage === null && entry.message?.usage != null) {
      completed.set(requestRef, { index: known.index, usage: entry.message.usage });
    }
  }

  let expiresAt: number | null = null;
  let model: string | null = null;
  let effort: string | null = null;
  // 圧縮やモデル・エフォートの変更より前に送られた要求の応答では、期限を作り直さない。
  let cut = -1;
  const counted = new Set<string>();

  // 確かめられた 1h 以外（5m を含む書き込み、無キャッシュ、不明な使用量）は取り下げる。
  // 費用を過小に見せるより、出さない側へ倒す。
  const withdraw = (index: number): void => {
    if (index > cut) cut = index;
    expiresAt = null;
    model = null;
    effort = null;
  };

  for (const entry of branch) {
    if ((entry.type === "system" && entry.subtype === "compact_boundary") || entry.compactSummary) {
      withdraw(entry.index);
      continue;
    }
    if (entry.type === "user") {
      if (!entry.sidechain && !entry.meta && isCacheInvalidatingCommand(entry)) {
        withdraw(entry.index);
      }
      continue;
    }
    if (entry.type !== "assistant" || entry.sidechain || entry.apiError) continue;
    const requestRef = entry.requestRef;
    if (requestRef === null || counted.has(requestRef)) continue;
    const known = completed.get(requestRef);
    if (known === undefined) continue;
    // 応答の block のうち、最初の行で 1 回だけ処理する。
    if (entry.index !== known.index) continue;
    counted.add(requestRef);

    const request = requests.get(requestRef);
    // 要求の行が読めない完了応答は、送信時刻を確かめられない。それ以前に確かめた期限を
    // 根拠なく残さない。区切りより前の要求なら、期限は既に消えている。
    if (request === undefined) {
      withdraw(entry.index);
      continue;
    }
    if (request.index <= cut) continue;

    const entryModel = entry.message?.model ?? null;
    if (entryModel === null || entryModel === SYNTHETIC_MODEL) continue;
    // 時刻・使用量を検証できない応答は、1h と確かめられたことにしない。
    const usage = known.usage;
    const next: { expiresAt: number; model: string; effort: string | null } | null =
      usage === null || request.at <= 0
        ? null
        : cacheAfterResponse(
            usage,
            request.at,
            { expiresAt, model, effort },
            { model: entryModel, effort: entry.effort },
          );
    if (next === null) {
      withdraw(entry.index);
      continue;
    }
    expiresAt = next.expiresAt;
    model = next.model;
    effort = next.effort;
  }

  return expiresAt;
}

// 直前の期限を引き継ぐか、取り下げるかを決める。
function cacheAfterResponse(
  usage: TranscriptUsage,
  sentAt: number,
  previous: { expiresAt: number | null; model: string | null; effort: string | null },
  response: { model: string; effort: string | null },
): { expiresAt: number; model: string; effort: string | null } | null {
  if (usage.cacheWrite > 0) {
    // 全量が 1h の書き込みだけを新しい期限にする。5m を含む・内訳が総数と合わないなら確かめられない。
    if (usage.cacheWrite1h !== usage.cacheWrite || usage.cacheWrite5m !== 0) return null;
    return {
      expiresAt: sentAt + PROMPT_CACHE_TTL_MS,
      model: response.model,
      effort: response.effort,
    };
  }
  if (usage.cacheRead <= 0) return null;
  // 読み取りだけでは、どのキャッシュに当たったかを区別できない。同じ会話・モデル・エフォートで
  // 追跡中で、送信時点で期限内だったときだけ延長する。未確認・失効済みを 1h 扱いにしない。
  if (
    previous.expiresAt === null ||
    previous.model !== response.model ||
    previous.effort !== response.effort ||
    sentAt >= previous.expiresAt
  ) {
    return null;
  }
  return {
    expiresAt: sentAt + PROMPT_CACHE_TTL_MS,
    model: response.model,
    effort: response.effort,
  };
}

function isCacheInvalidatingCommand(entry: TranscriptEntry): boolean {
  const content = entry.message?.content;
  if (typeof content !== "string") return false;
  const output = LOCAL_COMMAND_OUTPUT.exec(content)?.[1]?.trim() ?? "";
  return CACHE_INVALIDATING_OUTPUT.test(output);
}
