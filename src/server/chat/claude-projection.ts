import { createHash } from "node:crypto";
import {
  ATTACHED_FILES_CLOSE,
  ATTACHED_FILES_OPEN,
  stripAttachedFiles,
} from "../../shared/attachments";
import { ANSWER_HEADING, parseAnswerText, type QuestionAnswer } from "../../shared/answer";
import { answersFromToolResult, askMessages } from "./claude-ask";
import { promptCacheExpiry } from "./claude-cache";
import { ASK_USER_QUESTION, questionPending, toolPending, toolSummary } from "./claude-pending";
import {
  activeBranch,
  assistantText,
  blocksOf,
  conversationBranch,
  INTERRUPT_MARKERS,
  isLocalCommandEcho,
  stripPastedContent,
  SYNTHETIC_MODEL,
  userText,
  type TranscriptContent,
  type TranscriptEntry,
} from "./claude-transcript";
import type { ChatCompaction, ChatMessage, ChatPending, ChatSnapshot } from "./contract";
import { limitMessages, pruneOrphanAskAnswers } from "./limit";

type AssistantGroup = { id: string; at: number; text: string; error: string | null };

type PendingTool = { id: string; name: string; input: unknown };

export function snapshotOf(
  sessionId: string,
  entries: readonly TranscriptEntry[],
  clipped: boolean,
): { snapshot: ChatSnapshot; resolved: ReadonlySet<string> } {
  // 待ちと段階は圧縮後の枝だけで判定する。圧縮前の tool_result を今の待ちと取り違えない。
  const branch = activeBranch(entries);
  // 会話は圧縮を跨ぐ。境界は parentUuid を切るので、logicalParentUuid でつなぎ直す。
  const conversation = conversationBranch(entries);
  const resolved = resolvedToolUseIds(branch);
  let model: string | null = null;
  let effort: string | null = null;
  for (const entry of conversation) {
    if (entry.type !== "assistant" || entry.sidechain) continue;
    const entryModel = entry.message?.model ?? null;
    if (entryModel !== null && entryModel !== SYNTHETIC_MODEL) model = entryModel;
    if (entry.effort !== null) effort = entry.effort;
  }

  const projected = projectMessages(conversation);
  const limited = limitMessages(projected.messages);
  const messages = pruneOrphanAskAnswers(limited.messages);
  const pending = projectPending(branch, resolved);
  const cacheExpiresAt = promptCacheExpiry(entries, branch);
  const body: Omit<ChatSnapshot, "etag"> = {
    messages,
    model,
    effort,
    truncated: clipped || limited.truncated,
    // 使用量は transcript に無いので、ここでは null のままにする。mod の live ファイルから
    // snapshot に重ねる（docs/adr/claude-integration.md）。
    context: null,
    compaction: compactionOf(conversation, projected.dividerIndex, projected.messages, messages),
    ...(cacheExpiresAt === null ? {} : { cacheExpiresAt }),
    ...(pending === null ? {} : { pending }),
  };
  return { snapshot: { ...body, etag: etagOf(sessionId, body) }, resolved };
}

export function etagOf(sessionId: string, body: Omit<ChatSnapshot, "etag">): string {
  return createHash("sha256").update(sessionId).update(JSON.stringify(body)).digest("hex");
}

// 未解決の tool_use を拾う。突き合わせのキーは tool_use block の id と tool_result の
// tool_use_id。entry の uuid は、どの entry の tool_use かを辿るためにだけ使う
// （assistant は block ごとに別 entry なので、message.id では tool_use を区別できない）。
function projectPending(
  branch: readonly TranscriptEntry[],
  resolved: ReadonlySet<string>,
): ChatPending | null {
  const tools: PendingTool[] = [];
  for (const entry of branch) {
    if (entry.sidechain || entry.type !== "assistant") continue;
    tools.push(...toolUses(entry.message?.content));
  }

  // 会話の末尾が assistant の tool_use のときだけ。tool_result が書かれたら消える。
  // 行にならない entry（isMeta など）は末尾として見ない。
  const tail = lastConversationEntry(branch);
  if (tail === null || tail.type !== "assistant") return null;
  const tailIds = new Set(toolUses(tail.message?.content).map((tool) => tool.id));
  const unresolved = tools.filter((tool) => !resolved.has(tool.id));
  if (!unresolved.some((tool) => tailIds.has(tool.id))) return null;

  // 承認待ちが複数あるとき、どれが人間待ちか transcript だけでは決められない。
  // AskUserQuestion を優先し、無ければ最後の 1 件を代表にする。
  let question: PendingTool | null = null;
  for (const tool of unresolved) {
    if (tool.name === ASK_USER_QUESTION) question = tool;
  }
  if (question !== null) return questionPending(question.id, question.input);

  const last = unresolved[unresolved.length - 1];
  if (last === undefined) return null;
  return toolPending(last.id, last.name, toolSummary(last.name, last.input));
}

function resolvedToolUseIds(branch: readonly TranscriptEntry[]): Set<string> {
  const resolved = new Set<string>();
  for (const entry of branch) {
    if (entry.sidechain || entry.type !== "user") continue;
    for (const id of toolResultIds(entry.message?.content)) resolved.add(id);
  }
  return resolved;
}

function lastConversationEntry(branch: readonly TranscriptEntry[]): TranscriptEntry | null {
  for (let index = branch.length - 1; index >= 0; index -= 1) {
    const entry = branch[index];
    if (entry === undefined || entry.sidechain || entry.meta || entry.compactSummary) continue;
    if (entry.type === "user" || entry.type === "assistant") return entry;
  }
  return null;
}

function toolResultIds(content: TranscriptContent | undefined): string[] {
  const ids: string[] = [];
  for (const block of blocksOf(content)) {
    if (block.type !== "tool_result" || block.toolUseId === undefined) continue;
    ids.push(block.toolUseId);
  }
  return ids;
}

function toolUses(content: TranscriptContent | undefined): PendingTool[] {
  const tools: PendingTool[] = [];
  for (const block of blocksOf(content)) {
    if (block.type !== "tool_use" || block.id === undefined || block.id === "") continue;
    if (block.name === undefined || block.name === "") continue;
    tools.push({ id: block.id, name: block.name, input: block.input });
  }
  return tools;
}

function projectMessages(branch: readonly TranscriptEntry[]): {
  messages: ChatMessage[];
  // 最後の圧縮の区切りが、messages の何件目の前に来るか。圧縮が無ければ null。
  dividerIndex: number | null;
} {
  // Claude は 1 つの API メッセージを block ごとに複数の entry へ分けて書く。text を
  // ファイル順に連結して 1 行にする。id は最初の entry の uuid で、message.id は使わない
  // （同じ組の複数 entry が同じ id になり、クライアントの key が衝突する）。
  const groups = new Map<string, AssistantGroup>();
  for (const entry of branch) {
    if (entry.sidechain || entry.type !== "assistant") continue;
    const key = groupKey(entry);
    const text = assistantText(entry.message?.content);
    const group = groups.get(key);
    if (group === undefined) {
      groups.set(key, {
        id: entry.uuid ?? key,
        at: entry.at,
        text,
        error: entry.apiError ? entry.error : null,
      });
      continue;
    }
    group.text += text;
    if (entry.apiError && entry.error !== null) group.error = entry.error;
  }

  const asks = askExchanges(branch);
  const messages: ChatMessage[] = [];
  const emitted = new Set<string>();
  let dividerIndex: number | null = null;
  for (const entry of branch) {
    if (entry.sidechain) continue;
    // 区切りは、その行より前の会話が何件あるかで位置を決める。
    if (entry.type === "system" && entry.subtype === "compact_boundary") {
      dividerIndex = messages.length;
    }
    if (entry.type === "user") {
      if (entry.uuid !== null && asks.consumed.has(entry.uuid)) continue;
      const message = projectUser(entry);
      if (message !== null) messages.push(message);
      continue;
    }
    if (entry.type !== "assistant") continue;
    const key = groupKey(entry);
    if (!emitted.has(key)) {
      emitted.add(key);
      const message = projectAssistant(groups.get(key));
      if (message !== null) messages.push(message);
    }
    // tool_use は text と別の entry にある。質問は、それを書いた entry の位置に置く。
    const exchange = entry.uuid === null ? undefined : asks.byEntry.get(entry.uuid);
    if (exchange !== undefined) messages.push(...exchange);
  }
  return { messages, dividerIndex };
}

// 圧縮の区切り。今の文脈を作った最後の 1 本だけを出す（contract の compaction は 1 本）。
// 区切りの位置は messages の件数で返す。
function compactionOf(
  conversation: readonly TranscriptEntry[],
  dividerIndex: number | null,
  rows: readonly ChatMessage[],
  kept: readonly ChatMessage[],
): ChatCompaction | null {
  if (dividerIndex === null) return null;
  let boundary: TranscriptEntry | null = null;
  for (const entry of conversation) {
    if (entry.type === "system" && entry.subtype === "compact_boundary") boundary = entry;
  }
  if (boundary === null) return null;
  return {
    at: boundary.at,
    tokensBefore: boundary.preTokens,
    summary: compactSummaryAfter(conversation, boundary.index),
    index: keptBefore(dividerIndex, rows, kept),
  };
}

function compactSummaryAfter(conversation: readonly TranscriptEntry[], index: number): string {
  for (const entry of conversation) {
    if (entry.index <= index || !entry.compactSummary) continue;
    return compactSummaryText(userText(entry.message?.content));
  }
  return "";
}

// 要約の前には、モデル向けの定型文と内部の注記が付く。画面に出す本文ではないので落とす。
// 文面が変わった版では前置きごと出す（読みにくいより、要約が出ないほうが困る）。
const COMPACT_SUMMARY_PREAMBLE =
  /^This session is being continued from a previous conversation that ran out of context\.\s*The summary below covers the earlier portion of the conversation\.\s*(?:<system-reminder>[\s\S]*?<\/system-reminder>\s*)?/;

function compactSummaryText(raw: string): string {
  return raw.replace(COMPACT_SUMMARY_PREAMBLE, "").trim();
}

// 古い側を切り捨てると区切りも前へずれる。残った行だけを数え直す。
function keptBefore(
  index: number,
  rows: readonly ChatMessage[],
  kept: readonly ChatMessage[],
): number {
  const ids = new Set(kept.map((message) => message.id));
  let count = 0;
  for (let position = 0; position < index && position < rows.length; position += 1) {
    if (ids.has(rows[position]!.id)) count += 1;
  }
  return Math.min(count, kept.length);
}

function projectAssistant(group: AssistantGroup | undefined): ChatMessage | null {
  if (group === undefined) return null;
  // 失敗したターンは本文が無くても行にする。本文が空だと、送ったのに何も返らないまま
  // idle に戻り、送信が届いていないように見える。
  const text =
    group.error === null
      ? group.text
      : [group.error, group.text].filter((part) => part !== "").join("\n");
  if (text.trim() === "") return null;
  return {
    id: group.id,
    role: group.error === null ? "agent" : "error",
    text,
    at: group.at,
  };
}

// 回答済みの AskUserQuestion を、tool_use の entry ごとの Q&A にする。tool_use と tool_result は
// ダイアログを閉じた瞬間に同時に書かれるので、回答が無い質問（却下された、中断された）は
// 合成しない。Web から答えたときの回答は、実際の user 発話として後ろに残っている。Q&A に
// 置き換えるので、その発話は会話の行にしない（docs/adr/claude-integration.md）。
function askExchanges(branch: readonly TranscriptEntry[]): {
  byEntry: ReadonlyMap<string, ChatMessage[]>;
  consumed: ReadonlySet<string>;
} {
  const byEntry = new Map<string, ChatMessage[]>();
  const consumed = new Set<string>();
  for (const [index, entry] of branch.entries()) {
    if (entry.sidechain || entry.type !== "assistant" || entry.uuid === null) continue;
    for (const tool of toolUses(entry.message?.content)) {
      if (tool.name !== ASK_USER_QUESTION) continue;
      const pending = questionPending(tool.id, tool.input);
      if (pending === null || pending.kind !== "question") continue;
      const found = askAnswerAfter(branch, index, tool.id, pending.questions);
      if (found === null) continue;
      const messages = askMessages({
        toolUseId: tool.id,
        questions: pending.questions,
        answers: found.answers,
        questionAt: entry.at,
        answerAt: found.at,
      });
      byEntry.set(entry.uuid, [...(byEntry.get(entry.uuid) ?? []), ...messages]);
      if (found.consumed !== null) consumed.add(found.consumed);
    }
  }
  return { byEntry, consumed };
}

// TUI で答えると、tool_result が答えを持つ。Web から答えると tool_result は却下になり、その後の
// 最初の本物の user 発話（Esc の記録は除く）が `質問への回答:` で始まる回答になる。
function askAnswerAfter(
  branch: readonly TranscriptEntry[],
  from: number,
  toolUseId: string,
  questions: Extract<ChatPending, { kind: "question" }>["questions"],
): { answers: QuestionAnswer[]; at: number; consumed: string | null } | null {
  let rejected = false;
  for (let index = from + 1; index < branch.length; index += 1) {
    const entry = branch[index];
    if (entry === undefined || entry.sidechain) continue;
    if (rejected && entry.type === "assistant") return null;
    if (entry.type !== "user") continue;

    const result = blocksOf(entry.message?.content).find(
      (block) => block.type === "tool_result" && block.toolUseId === toolUseId,
    );
    if (result !== undefined) {
      if (result.isError === true) {
        rejected = true;
        continue;
      }
      if (entry.askAnswers === null) return null;
      const answers = answersFromToolResult(questions, entry.askAnswers);
      return answers === null ? null : { answers, at: entry.at, consumed: null };
    }

    if (!rejected || entry.meta || entry.compactSummary) continue;
    const body = stripPastedContent(userText(entry.message?.content));
    if (body.trim() === "" || INTERRUPT_MARKERS.has(body.trim()) || isLocalCommandEcho(body)) {
      continue;
    }
    if (!body.startsWith(`${ANSWER_HEADING}\n`) || entry.uuid === null) return null;
    const answers = parseAnswerText(questions, body);
    return answers === null ? null : { answers, at: entry.at, consumed: entry.uuid };
  }
  return null;
}

function groupKey(entry: TranscriptEntry): string {
  const id = entry.message?.id;
  return id ?? `uuid\u0000${entry.uuid ?? String(entry.index)}`;
}

function projectUser(entry: TranscriptEntry): ChatMessage | null {
  // isMeta は hwc の画面に出ないシステム寄りの記録。圧縮の要約は行にせず、区切りに添える
  // （compactionOf）。圧縮前の会話は conversationBranch で並べる。
  if (entry.meta || entry.compactSummary) return null;
  const raw = userText(entry.message?.content);
  if (raw === "") return null;
  // Claude Code が付ける貼り付けの包みを先に外す。添付の注記は包みの中にあり、
  // 注記を剥がしてからでは閉じタグが消えて組を取れない。
  const body = stripPastedContent(raw);
  if (isLocalCommandEcho(body)) return null;
  if (INTERRUPT_MARKERS.has(body.trim())) return null;

  const { text, attachments } = projectUserText(body);
  if (text === "" && attachments.length === 0) return null;
  return {
    id: entry.uuid ?? "",
    role: "user",
    text,
    at: entry.at,
    ...(attachments.length === 0
      ? {}
      : { attachments: attachments.map((name) => ({ name, size: null })) }),
  };
}

// 注記の書式が崩れていて名前を取り出せないときは、注記ブロックごと落とす。hwc の保存先は
// 絶対パスなので、本文に残すと画面へパスを出してしまう。
function projectUserText(raw: string): { text: string; attachments: string[] } {
  let text = raw;
  for (;;) {
    const stripped = stripAttachedFiles(text);
    if (stripped.attachments.length > 0 || !stripped.text.includes(ATTACHED_FILES_OPEN)) {
      return stripped;
    }
    const openAt = stripped.text.lastIndexOf(ATTACHED_FILES_OPEN);
    const closeAt = stripped.text.indexOf(
      ATTACHED_FILES_CLOSE,
      openAt + ATTACHED_FILES_OPEN.length,
    );
    const end = closeAt < 0 ? stripped.text.length : closeAt + ATTACHED_FILES_CLOSE.length;
    text = `${stripped.text.slice(0, openAt)}${stripped.text.slice(end)}`
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }
}
