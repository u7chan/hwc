import { foldContext } from "./context";
import type { ChatCompaction, ChatMessage, ChatPending, ChatSnapshot, ChatUsage } from "./contract";
import { limitMessages, pruneOrphanAskAnswers } from "./limit";
import { type AskPending, readAsk } from "./pi-ask";
import type { SessionAskQuestion, SessionAskResult, SessionEntry } from "./pi-entry";
import { activeBranch, type ChatReader } from "./pi-reader";
import type { WindowResolver } from "./pi-window";

export async function snapshotOf(
  reader: ChatReader,
  windowFor: WindowResolver,
): Promise<ChatSnapshot> {
  const branch = activeBranch(reader);
  const pairing = pairAsks(branch);
  const history = foldMessages(branch, pairing);
  const latest = latestValues(branch);

  // window は表示中のモデルで引く。usage を採った assistant のモデルで引くと、切り替え直後に
  // 新しい model 名と古いモデルの window が混ざる。
  const windowTokens = await windowFor(reader.path, latest.provider, latest.model);
  // ask ファイルは毎回読む。セッションの追記が無くても、pending の出現・差し替え・削除で
  // etag を変えないと、クライアントが 304 でカードの変化を取りこぼす。
  const ask = await readAsk(reader.path);
  const limited = limitMessages(history.messages);
  const keptMessages = pruneOrphanAskAnswers(limited.messages);
  // limitMessages は古い側から落とす。落ちた分だけ区切りの位置も手前へずらす。
  const dropped = history.messages.length - keptMessages.length;
  const compactionIndex =
    history.compaction === null
      ? 0
      : Math.max(0, Math.min(keptMessages.length, history.beforeCompaction - dropped));
  return {
    etag: `${reader.etagPrefix}-${reader.generation}-${windowTokens ?? "unknown"}-${ask === null ? "ask-none" : `ask-${ask.id}`}`,
    messages: keptMessages,
    model: latest.model,
    effort: latest.effort,
    truncated: limited.truncated,
    context: foldContext(latest.tokens, windowTokens),
    ...(latest.usage === null ? {} : { usage: latest.usage }),
    compaction:
      history.compaction === null ? null : { ...history.compaction, index: compactionIndex },
    canRewind: reader.canRewind,
    ...(ask === null ? {} : { pending: askPending(ask) }),
    // 追記型なので、最後に読んだエントリが葉。表示に無い entry でも葉になりうる。
    ...(reader.leafId === null ? {} : { leafId: reader.leafId }),
  };
}

// ask_user の呼び出しと result の対応。合成 id の材料を key ごとに持ち、本文の畳み込みは
// この索引だけを引く。
export type AskPairing = {
  questionKeys: Map<SessionAskQuestion, string>;
  resultKeys: Map<SessionAskResult, string>;
  results: Map<string, SessionAskResult>;
  askIds: Map<string, string>;
  answered: Set<string>;
};

export function pairAsks(branch: readonly SessionEntry[]): AskPairing {
  const pairing: AskPairing = {
    questionKeys: new Map(),
    resultKeys: new Map(),
    results: new Map(),
    askIds: new Map(),
    answered: new Set(),
  };
  // toolCallId は provider が再利用することがある。branch 順に呼び出しと result を対応づけ、
  // 回答済みの呼び出しだけを質問と回答のペアにする。未回答は pending カードが受け持つ。
  const waiting = new Map<string, SessionAskQuestion[]>();
  let seq = 0;
  for (const entry of branch) {
    // 呼び出しと result は同じ assistant の tool batch 内でだけ対応づける。中断で result が
    // 書かれなかった call を、次の user / assistant をまたいで後の result に使わない。
    const startsAskBatch =
      entry.askQuestions.length > 0 ||
      entry.messages.some((message) => message.role === "user" || message.role === "agent");
    if (startsAskBatch) waiting.clear();
    for (const ask of entry.askQuestions) {
      // entry id と通し番号を含め、同じ toolCallId が再登場しても合成 ID を一意にする。
      const key = `${entry.id}:${ask.toolCallId}:${seq++}`;
      pairing.questionKeys.set(ask, key);
      const queue = waiting.get(ask.toolCallId) ?? [];
      queue.push(ask);
      waiting.set(ask.toolCallId, queue);
    }
    for (const result of entry.askResults) {
      const call = waiting.get(result.toolCallId)?.shift();
      if (call === undefined) continue;
      const key = pairing.questionKeys.get(call);
      if (key === undefined) continue;
      pairing.resultKeys.set(result, key);
      pairing.results.set(key, result);
      if (result.askId !== null) pairing.askIds.set(key, result.askId);
      if (result.status === "answered" && result.answer !== null) pairing.answered.add(key);
    }
  }
  return pairing;
}

export type FoldedHistory = {
  messages: ChatMessage[];
  // compaction エントリより前にある、表示対象のメッセージ数。区切りを置く位置になる。
  beforeCompaction: number;
  // 表示する区切り。index は limitMessages で落とした後で決まるので、ここでは持たない。
  compaction: Omit<ChatCompaction, "index"> | null;
};

export function foldMessages(branch: readonly SessionEntry[], pairing: AskPairing): FoldedHistory {
  const messages: ChatMessage[] = [];
  const compacted = compactionWindow(branch);
  const emittedAskKeys = new Set<string>();
  let beforeCompaction = 0;
  // pi は自動リトライの試行ごとに同じ失敗を書く。同一文言の error が続く間は 1 行に畳み、
  // 試行回数だけを count に残す。行が減るので区切りの位置は畳んだあとの行数で数える。
  let retry: ChatMessage | null = null;

  for (let index = 0; index < branch.length; index += 1) {
    const entry = branch[index];
    if (!entry) continue;
    // 畳んだ行は区切りの手前に残る。またぐと、圧縮後の失敗が圧縮前の行の回数に入る。
    if (entry.compactionEntry) retry = null;
    const before = messages.length;
    // 圧縮より前の会話はモデルの文脈にもう無い。返さない。
    if (index >= (compacted?.start ?? 0)) {
      for (const message of entry.messages) {
        if (message.role === "error" && retry !== null && retry.text === message.text) {
          retry.count = (retry.count ?? 1) + 1;
          continue;
        }
        // 最初の失敗の id を残す。試行が増えても行の id を変えない。
        retry = message.role === "error" ? { ...message } : null;
        messages.push(retry ?? message);
      }
      let addedAsk = false;
      for (const ask of entry.askQuestions) {
        const key = pairing.questionKeys.get(ask);
        if (key === undefined || !pairing.answered.has(key)) continue;
        const askId = pairing.askIds.get(key);
        const result = pairing.results.get(key);
        const selected = result?.kind === "option" ? result.answer : null;
        const askOptions = ask.options?.map((label) => ({
          label,
          recommended: label === ask.recommended,
          selected: label === selected,
        }));
        messages.push({
          id: `ask:${key}:question`,
          role: "agent",
          text: ask.question,
          at: ask.at,
          synthetic: true,
          ...(askId === undefined ? {} : { askId }),
          ...(askOptions === undefined ? {} : { askOptions }),
        });
        emittedAskKeys.add(key);
        addedAsk = true;
      }
      for (const result of entry.askResults) {
        const key = pairing.resultKeys.get(result);
        if (key === undefined || result.answer === null || !emittedAskKeys.has(key)) continue;
        messages.push({
          id: `ask:${key}:answer`,
          role: "user",
          text: result.answer,
          at: result.at,
          synthetic: true,
          ...(result.askId == null ? {} : { askId: result.askId }),
          ...(result.kind === null ? {} : { answerKind: result.kind }),
        });
        addedAsk = true;
      }
      // Q&A は error の連続を切る会話の行でもある。
      if (addedAsk) retry = null;
    }
    if (compacted !== null && index < compacted.entryIndex) {
      beforeCompaction += messages.length - before;
    }
  }

  return { messages, beforeCompaction, compaction: compacted?.compaction ?? null };
}

export type LatestValues = {
  model: string | null;
  provider: string | null;
  effort: string | null;
  tokens: number | null;
  usage: ChatUsage | null;
};

// 表示に出す最新の model と effort、いまのコンテキスト量になる usage を、本文とは別に拾う。
// 本文の畳み込みと同じ走査に混ぜると、usage を直すときに畳んだ行の状態まで読むことになる。
// どれも枝の最後に現れた 1 つで決まるので、末尾から揃うまで戻る（3 回目の全走査を作らない）。
export function latestValues(branch: readonly SessionEntry[]): LatestValues {
  const latest: LatestValues = {
    model: null,
    provider: null,
    effort: null,
    tokens: null,
    usage: null,
  };
  let foundModel = false;
  let foundEffort = false;
  let foundUsage = false;
  for (let index = branch.length - 1; index >= 0; index -= 1) {
    const entry = branch[index];
    if (!entry) continue;
    // usage は entry 単位で拾う。本文の無い assistant を project が捨てるため、message 側に
    // 持たせると tool-only の最後の応答を取りこぼす。
    if (!foundUsage) {
      if (entry.usageTokens !== null) {
        latest.tokens = entry.usageTokens;
        latest.usage = entry.usage;
        foundUsage = true;
      } else if (entry.invalidatesUsage) {
        // これより前の usage は現在のコンテキスト量でない。null のまま確定する。
        foundUsage = true;
      }
    }
    // path 順で新しい方を採る。model_change が assistant より後なら切り替え後の値になる。
    if (!foundModel && entry.model !== null) {
      latest.model = entry.model;
      latest.provider = entry.provider;
      foundModel = true;
    }
    if (!foundEffort && entry.effort !== null) {
      latest.effort = entry.effort;
      foundEffort = true;
    }
    if (foundModel && foundEffort && foundUsage) break;
  }
  return latest;
}

// 最新の compaction だけを見る。その材料が揃い、firstKeptEntryId が branch にあれば
// その位置を返す。古い compaction へは遡らない。最新が使えないなら窓を張らず全体を返す。
// 要約だけ出して古い会話を並べるより、表示と実体が一致する側を選ぶ。
function compactionWindow(branch: readonly SessionEntry[]): {
  start: number;
  entryIndex: number;
  compaction: Omit<ChatCompaction, "index">;
} | null {
  let newestIndex = -1;
  for (let index = branch.length - 1; index >= 0; index -= 1) {
    if (!branch[index]?.compactionEntry) continue;
    newestIndex = index;
    break;
  }

  const newest = newestIndex < 0 ? null : branch[newestIndex];
  const found = newest?.compaction ?? null;
  if (found === null) return null;
  const start = branch.findIndex((entry) => entry.id === found.firstKeptEntryId);
  if (start < 0) return null;
  return {
    start,
    entryIndex: newestIndex,
    compaction: { at: found.at, tokensBefore: found.tokensBefore, summary: found.summary },
  };
}

// モデルが書いた質問として、Claude の AskUserQuestion と同じカードの形に載せる。
// ask_user は 1 問だけなので、header と複数選択は持たない。
function askPending(ask: AskPending): ChatPending {
  const options = ask.options ?? [];
  // 推奨は先頭に置く。並び順は表示の都合で、回答の照合には使わない。
  const ordered =
    ask.recommended === null
      ? options
      : [ask.recommended, ...options.filter((label) => label !== ask.recommended)];
  return {
    kind: "question",
    toolUseId: ask.id,
    tool: "ask_user",
    freeText: ask.freeText,
    questions: [
      {
        question: ask.question,
        header: null,
        multiSelect: false,
        options: ordered.map((label) => ({
          label,
          description: label === ask.recommended ? "推奨💡" : null,
        })),
      },
    ],
  };
}
