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
  let model: string | null = null;
  let provider: string | null = null;
  let effort: string | null = null;
  // usage は entry 単位で拾う。本文の無い assistant を project が捨てるため、message 側に
  // 持たせると tool-only の最後の応答を取りこぼす。
  let tokens: number | null = null;
  let usage: ChatUsage | null = null;
  const messages: ChatMessage[] = [];
  // compaction エントリより前にある、表示対象のメッセージ数。区切りを置く位置になる。
  let beforeCompaction = 0;

  const branch = activeBranch(reader);
  // toolCallId は provider が再利用することがある。branch 順に呼び出しと result を対応づけ、
  // 回答済みの呼び出しだけを質問と回答のペアにする。未回答は pending カードが受け持つ。
  const askCallKeys = new Map<SessionAskQuestion, string>();
  const askResultKeys = new Map<SessionAskResult, string>();
  const askIdsByKey = new Map<string, string>();
  const askResultsByKey = new Map<string, SessionAskResult>();
  const answeredAskKeys = new Set<string>();
  const waitingAskCalls = new Map<string, SessionAskQuestion[]>();
  let askCallSeq = 0;
  for (const entry of branch) {
    // 呼び出しと result は同じ assistant の tool batch 内でだけ対応づける。中断で result が
    // 書かれなかった call を、次の user / assistant をまたいで後の result に使わない。
    const startsAskBatch =
      entry.askQuestions.length > 0 ||
      entry.messages.some((message) => message.role === "user" || message.role === "agent");
    if (startsAskBatch) waitingAskCalls.clear();
    for (const ask of entry.askQuestions) {
      // entry id と通し番号を含め、同じ toolCallId が再登場しても合成 ID を一意にする。
      const key = `${entry.id}:${ask.toolCallId}:${askCallSeq++}`;
      askCallKeys.set(ask, key);
      const queue = waitingAskCalls.get(ask.toolCallId) ?? [];
      queue.push(ask);
      waitingAskCalls.set(ask.toolCallId, queue);
    }
    for (const result of entry.askResults) {
      const call = waitingAskCalls.get(result.toolCallId)?.shift();
      if (call === undefined) continue;
      const key = askCallKeys.get(call);
      if (key === undefined) continue;
      askResultKeys.set(result, key);
      askResultsByKey.set(key, result);
      if (result.askId !== null) askIdsByKey.set(key, result.askId);
      if (result.status === "answered" && result.answer !== null) answeredAskKeys.add(key);
    }
  }
  const emittedAskKeys = new Set<string>();
  const compacted = compactionWindow(branch);
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
        const key = askCallKeys.get(ask);
        if (key === undefined || !answeredAskKeys.has(key)) continue;
        const askId = askIdsByKey.get(key);
        const result = askResultsByKey.get(key);
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
        const key = askResultKeys.get(result);
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
    // path 順で新しい方を採る。model_change が assistant より後なら切り替え後の値になる。
    if (entry.model !== null) {
      model = entry.model;
      provider = entry.provider;
    }
    if (entry.effort !== null) effort = entry.effort;
    if (entry.invalidatesUsage) {
      tokens = null;
      usage = null;
    }
    if (entry.usageTokens !== null) {
      tokens = entry.usageTokens;
      usage = entry.usage;
    }
  }

  // window は表示中のモデルで引く。usage を採った assistant のモデルで引くと、切り替え直後に
  // 新しい model 名と古いモデルの window が混ざる。
  const windowTokens = await windowFor(reader.path, provider, model);
  // ask ファイルは毎回読む。セッションの追記が無くても、pending の出現・差し替え・削除で
  // etag を変えないと、クライアントが 304 でカードの変化を取りこぼす。
  const ask = await readAsk(reader.path);
  const limited = limitMessages(messages);
  const keptMessages = pruneOrphanAskAnswers(limited.messages);
  // limitMessages は古い側から落とす。落ちた分だけ区切りの位置も手前へずらす。
  const dropped = messages.length - keptMessages.length;
  const compactionIndex =
    compacted === null ? 0 : Math.max(0, Math.min(keptMessages.length, beforeCompaction - dropped));
  return {
    etag: `${reader.etagPrefix}-${reader.generation}-${windowTokens ?? "unknown"}-${ask === null ? "ask-none" : `ask-${ask.id}`}`,
    messages: keptMessages,
    model,
    effort,
    truncated: limited.truncated,
    context: foldContext(tokens, windowTokens),
    ...(usage === null ? {} : { usage }),
    compaction: compacted === null ? null : { ...compacted.compaction, index: compactionIndex },
    canRewind: reader.canRewind,
    ...(ask === null ? {} : { pending: askPending(ask) }),
    // 追記型なので、最後に読んだエントリが葉。表示に無い entry でも葉になりうる。
    ...(reader.leafId === null ? {} : { leafId: reader.leafId }),
  };
}

// 最新の compaction だけを見る。その材料が揃い、firstKeptEntryId が branch にあれば
// その位置を返す。古い compaction へは遡らない。最新が使えないなら窓を張らず全体を返す。
// 要約だけ出して古い会話を並べるより、表示と実体が一致する側を選ぶ。
function compactionWindow(
  branch: readonly SessionEntry[],
): { start: number; entryIndex: number; compaction: Omit<ChatCompaction, "index"> } | null {
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
