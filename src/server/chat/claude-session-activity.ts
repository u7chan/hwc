import { basename } from "node:path";
import {
  DIRECTION_LIMIT,
  flattenLine,
  sliceHead,
  TOOL_NAME_LIMIT,
  TOOLS_LIMIT,
} from "../../shared/activity";
import { asRecord, nonEmptyText } from "../../shared/json";
import {
  activeBranch,
  blocksOf,
  INTERRUPT_MARKERS,
  isLocalCommandEcho,
  MAIN_THREAD_SOURCE,
  type TranscriptEntry,
} from "./claude-transcript";
import type { SessionActivity } from "./contract";

// api-request / tool_use の ID で応答の有無を判定できる版（docs/adr/claude-integration.md）。
const MIN_ACTIVITY_VERSION = [2, 1, 327] as const;

// 帯の 2 行は activitySnippet の 160 文字に収める。対象 60 + 改行 + 方向 90。
const TARGET_LIMIT = 60;

type ToolUse = {
  id: string | null;
  name: string;
  input: unknown;
  version: string | null;
  index: number;
};

type ToolResult = { toolUseId: string | null; index: number };
type RequestRef = { id: string | null; version: string | null; index: number };
type AnswerRef = { requestRef: string | null; apiError: boolean; index: number };

// ターンの起点と、そこから読める段階（docs/adr/claude-integration.md）。段階に使う行は枝で絞らず、ファイル順に
// 起点より後ろを全部見る。並列ツールの tool_use は一時的に親鎖の外へ出るため。
export function sessionActivityOf(
  entries: readonly TranscriptEntry[],
  now: number,
): SessionActivity {
  const branch = activeBranch(entries);
  const start = lastPrompt(branch);
  if (start === undefined || start.uuid === null) return { prompt: null, activity: null };
  const prompt = start.uuid;

  const toolUses: ToolUse[] = [];
  const toolResults: ToolResult[] = [];
  const requests: RequestRef[] = [];
  const answers: AnswerRef[] = [];
  for (const entry of entries) {
    if (entry.index <= start.index || entry.sidechain) continue;
    if (entry.type === "api-request") {
      // サブエージェント（sdk）の要求は本流の段階ではない。
      if (entry.querySource === MAIN_THREAD_SOURCE) {
        requests.push({ id: entry.requestId, version: entry.version, index: entry.index });
      }
      continue;
    }
    if (entry.type === "assistant") {
      answers.push({ requestRef: entry.requestRef, apiError: entry.apiError, index: entry.index });
      for (const block of blocksOf(entry.message?.content)) {
        if (block.type !== "tool_use") continue;
        toolUses.push({
          id: nonEmptyText(block.id),
          name: nonEmptyText(block.name) ?? "",
          input: block.input,
          version: entry.version,
          index: entry.index,
        });
      }
      continue;
    }
    if (entry.type !== "user") continue;
    for (const block of blocksOf(entry.message?.content)) {
      if (block.type !== "tool_result") continue;
      toolResults.push({ toolUseId: nonEmptyText(block.toolUseId), index: entry.index });
    }
  }

  const direction = directionOf(branch, start.index);
  const finished = new Set(
    toolResults.flatMap((result) => (result.toolUseId === null ? [] : [result.toolUseId])),
  );
  const unfinished = toolUses.filter((tool) => tool.id === null || !finished.has(tool.id));

  if (unfinished.length > 0) {
    for (const tool of unfinished) {
      // ID が無い・版が古い・結果側に ID が無い形式では、終わったかを決められない。
      if (tool.id === null) return { prompt, activity: null };
      if (!versionAtLeast(tool.version)) return { prompt, activity: null };
      if (toolResults.some((result) => result.toolUseId === null && result.index > tool.index)) {
        return { prompt, activity: null };
      }
    }
    const representative = unfinished[unfinished.length - 1]!;
    return {
      prompt,
      activity: {
        phase: "tool",
        text: joinLines(toolTarget(representative), direction),
        tool: toolNameOf(representative),
        tools: Math.min(unfinished.length, TOOLS_LIMIT),
        tokPerSecond: null,
        at: now,
      },
    };
  }

  const request = requests[requests.length - 1];
  if (request !== undefined) {
    const answered =
      request.id !== null &&
      answers.some((answer) => answer.requestRef === request.id && answer.index > request.index);
    // 失敗の行は requestRef を持たないが、その要求が終わったことは示す。
    const failed = answers.some((answer) => answer.apiError && answer.index > request.index);
    if (!answered && !failed) {
      // requestRef を持たない assistant は、どの要求の応答か決められない。
      if (
        answers.some(
          (answer) =>
            !answer.apiError && answer.requestRef === null && answer.index > request.index,
        )
      ) {
        return { prompt, activity: null };
      }
      if (request.id === null) return { prompt, activity: null };
      if (!versionAtLeast(request.version)) return { prompt, activity: null };
      return {
        prompt,
        activity: {
          phase: "thinking",
          text: direction,
          tool: null,
          tools: 1,
          tokPerSecond: null,
          at: now,
        },
      };
    }
  }

  return { prompt, activity: null };
}

// ターンの起点は active branch にある最後の prompt。画像だけの発言も起点になる。
function lastPrompt(branch: readonly TranscriptEntry[]): TranscriptEntry | undefined {
  for (let index = branch.length - 1; index >= 0; index -= 1) {
    const entry = branch[index]!;
    if (isPrompt(entry)) return entry;
  }
  return undefined;
}

function isPrompt(entry: TranscriptEntry): boolean {
  if (entry.type !== "user" || entry.sidechain || entry.meta || entry.compactSummary) return false;
  const content = entry.message?.content;
  if (typeof content === "string") {
    const text = content.trim();
    return text !== "" && !isLocalCommandEcho(text) && !INTERRUPT_MARKERS.has(text);
  }
  if (content === null || content === undefined) return false;
  for (const block of content) {
    if (block.type === "image") return true;
    if (block.type !== "text" || block.text === undefined) continue;
    const text = block.text.trim();
    if (text !== "" && !isLocalCommandEcho(text) && !INTERRUPT_MARKERS.has(text)) return true;
  }
  return false;
}

// 方向は、起点より後ろの枝にある最後の assistant の text の先頭 1 行。無ければ thinking の
// 本文の末尾。thinking は要約のことも生の本文のこともあるが、transcript に載った文を使う。
function directionOf(branch: readonly TranscriptEntry[], startIndex: number): string {
  let text = "";
  let thinking = "";
  for (const entry of branch) {
    if (entry.index <= startIndex || entry.sidechain || entry.type !== "assistant") continue;
    if (entry.apiError) continue;
    for (const block of blocksOf(entry.message?.content)) {
      if (block.type === "text" && block.text !== undefined && block.text.trim() !== "") {
        text = block.text;
      } else if (
        block.type === "thinking" &&
        block.thinking !== undefined &&
        block.thinking.trim() !== ""
      ) {
        thinking = block.thinking;
      }
    }
  }
  if (text !== "") return headLine(text, DIRECTION_LIMIT);
  if (thinking !== "") return tailLine(thinking, DIRECTION_LIMIT);
  return "";
}

// ツールの対象。コマンドの本文は会話の内容そのものなので出さない。
function toolTarget(tool: ToolUse): string {
  const input = asRecord(tool.input);
  if (input === null) return "";
  const field = (key: string): string => nonEmptyText(input[key]) ?? "";
  let target = "";
  switch (tool.name.toLowerCase()) {
    case "bash":
    case "task":
      target = field("description");
      break;
    case "read":
    case "edit":
    case "write":
    case "grep":
    case "glob": {
      const path = field("file_path");
      target = path === "" ? "" : basename(path);
      break;
    }
  }
  return sliceHead(flattenLine(target), TARGET_LIMIT);
}

function toolNameOf(tool: ToolUse): string | null {
  return tool.name === "" ? null : sliceHead(tool.name, TOOL_NAME_LIMIT);
}

function joinLines(target: string, direction: string): string {
  if (target === "") return direction;
  if (direction === "") return target;
  return `${target}\n${direction}`;
}

function headLine(raw: string, limit: number): string {
  for (const line of raw.split(/\r?\n/)) {
    const text = flattenLine(line);
    if (text !== "") return sliceHead(text, limit);
  }
  return "";
}

function tailLine(raw: string, limit: number): string {
  return Array.from(flattenLine(raw)).slice(-limit).join("");
}

function versionAtLeast(version: string | null): boolean {
  if (version === null) return false;
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (match === null) return false;
  const parts = [Number(match[1]), Number(match[2]), Number(match[3])];
  for (let index = 0; index < MIN_ACTIVITY_VERSION.length; index += 1) {
    const mine = parts[index]!;
    const minimum = MIN_ACTIVITY_VERSION[index]!;
    if (mine !== minimum) return mine > minimum;
  }
  return true;
}
