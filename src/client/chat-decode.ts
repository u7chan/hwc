import type {
  ChatAskOption,
  ChatAttachment,
  ChatCompaction,
  ChatContext,
  ChatFile,
  ChatLink,
  ChatMessage,
  ChatPending,
  ChatPendingQuestion,
  ChatSnapshot,
  ChatUsage,
} from "../server/chat/contract";
import { isStoredAttachmentName } from "../shared/attachments";

function isOptionalText(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isOptionalNumber(value: unknown): value is number | null {
  return value === null || typeof value === "number";
}

function toChatContext(value: unknown): ChatContext | null {
  if (typeof value !== "object" || value === null) return null;
  const context = value as Partial<ChatContext>;
  if (!isOptionalNumber(context.tokens) || !isOptionalNumber(context.window)) return null;
  return { tokens: context.tokens, window: context.window };
}

function toChatUsage(value: unknown): ChatUsage | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const usage = value as Partial<ChatUsage>;
  const valid = (n: unknown): n is number | null =>
    n === null || (typeof n === "number" && Number.isFinite(n) && n >= 0);
  if (
    !valid(usage.input) ||
    !valid(usage.output) ||
    !valid(usage.cacheRead) ||
    !valid(usage.cacheWrite) ||
    !valid(usage.reasoning)
  )
    return undefined;
  return {
    input: usage.input,
    output: usage.output,
    cacheRead: usage.cacheRead,
    cacheWrite: usage.cacheWrite,
    reasoning: usage.reasoning,
  };
}

function toChatCompaction(value: unknown): ChatCompaction | null {
  if (typeof value !== "object" || value === null) return null;
  const compaction = value as Partial<ChatCompaction>;
  if (typeof compaction.at !== "number") return null;
  if (!isOptionalNumber(compaction.tokensBefore)) return null;
  if (typeof compaction.summary !== "string") return null;
  if (!isIndex(compaction.index)) return null;
  return {
    at: compaction.at,
    tokensBefore: compaction.tokensBefore,
    summary: compaction.summary,
    index: compaction.index,
  };
}

function isIndex(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function toChatAttachments(value: unknown): ChatAttachment[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const attachments: ChatAttachment[] = [];
  for (const item of value) {
    if (typeof item !== "object" || item === null) continue;
    const attachment = item as Partial<ChatAttachment>;
    // 名前は配信 URL になる。保存名の規則を通らない値は捨て、リンクも画像も作らない。
    if (typeof attachment.name !== "string" || !isStoredAttachmentName(attachment.name)) continue;
    // サイズは表示だけに使う。壊れた値は名前だけを出す。
    const size = attachment.size;
    attachments.push({
      name: attachment.name,
      size:
        typeof size === "number" && Number.isFinite(size) && size >= 0 ? Math.trunc(size) : null,
    });
  }
  return attachments.length === 0 ? undefined : attachments;
}

function toImageRefs(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  // 本文の表記と突き合わせるだけの値。配信 URL には使わないが、壊れた値は描画に使わない。
  const refs = value.filter((item): item is string => typeof item === "string" && item !== "");
  return refs.length === 0 ? undefined : refs;
}

// 根のラベルは表示だけに使う。絶対パスを渡さない契約なので、区切りを含む値は捨てる。
// `/tmp` は固定の表記で、画面にもそのまま出ている。長さは描画側で抑える。
function toRootLabel(value: unknown): string | undefined {
  if (typeof value !== "string" || value === "") return undefined;
  if (value === "/tmp") return value;
  if (value.includes("/") || value.includes("\\")) return undefined;
  return value;
}

// 根の番号は配信 URL の一部になる。負数や小数は捨てる。名前も同じく URL の材料なので、
// 空・絶対パス・根の外を指す値は捨て、リンクも画像も作らない。
function isFileRef<T extends { name?: unknown; version?: unknown; root?: unknown }>(
  ref: T,
): ref is T & { name: string; version: string; root: number } {
  if (typeof ref.name !== "string" || typeof ref.version !== "string") return false;
  if (typeof ref.root !== "number" || !Number.isInteger(ref.root) || ref.root < 0) return false;
  if (ref.name === "" || ref.name.startsWith("/")) return false;
  return !ref.name.split("/").includes("..");
}

function toChatFiles(value: unknown): ChatFile[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const files: ChatFile[] = [];
  for (const item of value) {
    if (typeof item !== "object" || item === null) continue;
    const file = item as Partial<ChatFile>;
    if (!isFileRef(file)) continue;
    // 見せ方を知らないファイルは出さない。画像とプレビューだけを扱う。
    if (file.kind !== "image" && file.kind !== "html") continue;
    const imageRefs = toImageRefs(file.imageRefs);
    const rootLabel = toRootLabel(file.rootLabel);
    files.push({
      name: file.name,
      version: file.version,
      kind: file.kind,
      root: file.root,
      ...(rootLabel === undefined ? {} : { rootLabel }),
      ...(imageRefs === undefined ? {} : { imageRefs }),
    });
  }
  return files.length === 0 ? undefined : files;
}

// 本文の相対パスのリンク。href は本文の表記との照合キーで、そのまま URL にはしない。
function toChatLinks(value: unknown): ChatLink[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const links: ChatLink[] = [];
  for (const item of value) {
    if (typeof item !== "object" || item === null) continue;
    const link = item as Partial<ChatLink>;
    if (typeof link.href !== "string" || link.href === "") continue;
    if (!isFileRef(link)) continue;
    if (link.kind !== "image" && link.kind !== "html" && link.kind !== "text") continue;
    const rootLabel = toRootLabel(link.rootLabel);
    links.push({
      href: link.href,
      name: link.name,
      version: link.version,
      kind: link.kind,
      root: link.root,
      ...(rootLabel === undefined ? {} : { rootLabel }),
    });
  }
  return links.length === 0 ? undefined : links;
}

function toChatMessage(value: unknown): ChatMessage | null {
  if (typeof value !== "object" || value === null) return null;
  const message = value as Partial<ChatMessage>;
  if (typeof message.id !== "string") return null;
  if (message.role !== "user" && message.role !== "agent" && message.role !== "error") {
    return null;
  }
  if (typeof message.text !== "string") return null;
  if (typeof message.at !== "number") return null;
  const attachments = toChatAttachments(message.attachments);
  const files = toChatFiles(message.files);
  const links = toChatLinks(message.links);
  const outsideFile = toOutsideFile(message.outsideFile);
  const count = message.role === "error" ? toRetryCount(message.count) : undefined;
  const synthetic = message.synthetic === true ? true : undefined;
  const askId =
    typeof message.askId === "string" && message.askId !== "" ? message.askId : undefined;
  const askOptions = toAskOptions(message.askOptions);
  const answerKind =
    message.answerKind === "option" || message.answerKind === "text"
      ? message.answerKind
      : undefined;
  return {
    id: message.id,
    role: message.role,
    text: message.text,
    at: message.at,
    ...(count === undefined ? {} : { count }),
    ...(attachments === undefined ? {} : { attachments }),
    ...(files === undefined ? {} : { files }),
    ...(links === undefined ? {} : { links }),
    ...(outsideFile === undefined ? {} : { outsideFile }),
    ...(synthetic === undefined ? {} : { synthetic }),
    ...(askId === undefined ? {} : { askId }),
    ...(askOptions === undefined ? {} : { askOptions }),
    ...(answerKind === undefined ? {} : { answerKind }),
  };
}

// 選択肢は表示だけ。形の壊れた項目は捨て、残りで質問を描く。
function toAskOptions(value: unknown): ChatAskOption[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const options = value.flatMap((item): ChatAskOption[] => {
    if (typeof item !== "object" || item === null) return [];
    const option = item as Partial<ChatAskOption>;
    if (typeof option.label !== "string" || option.label.trim() === "") return [];
    if (typeof option.recommended !== "boolean" || typeof option.selected !== "boolean") {
      return [];
    }
    return [
      {
        label: option.label.trim(),
        recommended: option.recommended,
        selected: option.selected,
      },
    ];
  });
  return options.length === 0 ? undefined : options;
}

// 案内に出すのは名前だけ。区切りを含む値は、サーバーが契約を破ったということなので描かない。
function toOutsideFile(value: unknown): string | undefined {
  if (typeof value !== "string" || value === "") return undefined;
  if (value.includes("/") || value.includes("\\")) return undefined;
  return value;
}

// 1 回だけの失敗は count を持たない。飾りの値が壊れても失敗の行は捨てない。
function toRetryCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 1 ? value : undefined;
}

// 応答待ちは入力の可否を変えるが、飾りでもある。形が読めない値は捨てて pending 無しにし、
// blocked の間は今までどおり端末出力へ倒す（誤検知で操作不能にしない）。
function toChatPending(value: unknown): ChatPending | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const pending = value as Partial<ChatPending>;
  if (typeof pending.toolUseId !== "string" || pending.toolUseId === "") return undefined;
  if (pending.kind === "tool") {
    if (typeof pending.tool !== "string" || pending.tool === "") return undefined;
    const { summary } = pending;
    return {
      kind: "tool",
      toolUseId: pending.toolUseId,
      tool: pending.tool,
      summary: typeof summary === "string" && summary !== "" ? summary : null,
    };
  }
  if (pending.kind !== "question") return undefined;
  // pi の ask_user は 1 問だけで、options が空なら自由入力だけになる。Claude の
  // AskUserQuestion は今までどおり、空の options を捨てる。
  const askUser = pending.tool === "ask_user";
  if (pending.tool !== "AskUserQuestion" && !askUser) return undefined;
  if (!Array.isArray(pending.questions)) return undefined;
  if (askUser && pending.questions.length !== 1) return undefined;
  const questions: ChatPendingQuestion[] = [];
  for (const item of pending.questions) {
    if (typeof item !== "object" || item === null) return undefined;
    const question = item as Partial<ChatPendingQuestion>;
    if (typeof question.question !== "string" || question.question === "") return undefined;
    if (!Array.isArray(question.options)) return undefined;
    if (!askUser && question.options.length === 0) return undefined;
    const options: ChatPendingQuestion["options"] = [];
    for (const option of question.options) {
      if (typeof option !== "object" || option === null) return undefined;
      const { label, description } = option as { label?: unknown; description?: unknown };
      if (typeof label !== "string" || label === "") return undefined;
      options.push({
        label,
        description: typeof description === "string" && description !== "" ? description : null,
      });
    }
    questions.push({
      question: question.question,
      header:
        typeof question.header === "string" && question.header !== "" ? question.header : null,
      multiSelect: question.multiSelect === true,
      options,
    });
  }
  if (questions.length === 0) return undefined;
  if (!askUser) {
    return { kind: "question", toolUseId: pending.toolUseId, tool: "AskUserQuestion", questions };
  }
  const freeText = pending.freeText;
  // 自由入力の可否は入力欄そのものの差になるので、無い・boolean でない値は options から
  // 補わずに形の不一致として捨てる（BFF は boolean を必ず返す）。
  if (typeof freeText !== "boolean") return undefined;
  return { kind: "question", toolUseId: pending.toolUseId, tool: "ask_user", freeText, questions };
}

export function toChatSnapshot(value: unknown): ChatSnapshot | null {
  if (typeof value !== "object" || value === null) return null;
  const snapshot = value as Partial<ChatSnapshot>;
  if (typeof snapshot.etag !== "string") return null;
  if (typeof snapshot.truncated !== "boolean") return null;
  if (!isOptionalText(snapshot.model) || !isOptionalText(snapshot.effort)) return null;
  if (!Array.isArray(snapshot.messages)) return null;
  const messages: ChatMessage[] = [];
  for (const value of snapshot.messages) {
    const message = toChatMessage(value);
    if (message === null) return null;
    messages.push(message);
  }
  const usage = toChatUsage(snapshot.usage);
  const pending = toChatPending(snapshot.pending);
  // 飾りの値が壊れても会話は捨てない。期限を出さないだけにする。
  const cacheExpiresAt =
    typeof snapshot.cacheExpiresAt === "number" && Number.isFinite(snapshot.cacheExpiresAt)
      ? snapshot.cacheExpiresAt
      : undefined;
  return {
    etag: snapshot.etag,
    messages,
    model: snapshot.model,
    effort: snapshot.effort,
    truncated: snapshot.truncated,
    // 飾りの値が壊れても会話は捨てない。数字を出さないだけにする。
    context: toChatContext(snapshot.context),
    ...(usage === undefined ? {} : { usage }),
    compaction: toChatCompaction(snapshot.compaction),
    ...(cacheExpiresAt === undefined ? {} : { cacheExpiresAt }),
    ...(pending === undefined ? {} : { pending }),
    canRewind: snapshot.canRewind === true,
    ...(typeof snapshot.leafId === "string" ? { leafId: snapshot.leafId } : {}),
  };
}
