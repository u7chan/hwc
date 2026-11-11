import { expect, test } from "bun:test";
import { appendQuote, canSend, canStop, normaliseQuote, quoteLines, splitQuote } from "./reply";

test("a one line selection keeps the line as it is", () => {
  expect(normaliseQuote("余白が残ります")).toBe("余白が残ります");
});

test("a multi line selection keeps its lines", () => {
  expect(normaliseQuote("1 行目\n2 行目")).toBe("1 行目\n2 行目");
});

test("a blank line in the middle stays", () => {
  expect(normaliseQuote("前\n\n後")).toBe("前\n\n後");
});

test("windows line breaks become unix line breaks", () => {
  expect(normaliseQuote("前\r\n後")).toBe("前\n後");
});

test("blank lines around the selection are dropped", () => {
  expect(normaliseQuote("\n\n前\n後\n\n")).toBe("前\n後");
});

test("a whitespace only selection is empty", () => {
  expect(normaliseQuote("  \n\t\n")).toBe("");
});

test("whitespace at the edges of the selection is dropped", () => {
  expect(normaliseQuote("  前 ")).toBe("前");
  expect(normaliseQuote("前 \n後 ")).toBe("前 \n後");
});

test("every line is prefixed and blank lines become a bare marker", () => {
  expect(quoteLines("前\n\n後")).toBe("> 前\n>\n> 後");
});

test("whitespace only lines become a bare marker", () => {
  expect(quoteLines("前\n   \n後")).toBe("> 前\n>\n> 後");
});

test("a quote is appended after the draft with one blank line", () => {
  expect(appendQuote("本文", "引用")).toEqual({ text: "本文\n\n> 引用\n\n", caret: 10 });
  expect(appendQuote("本文\n", "引用").text).toBe("本文\n\n> 引用\n\n");
  expect(appendQuote("本文\n\n", "引用").text).toBe("本文\n\n> 引用\n\n");
});

test("a quote alone leaves a blank line for the follow-up", () => {
  expect(appendQuote("", "引用")).toEqual({ text: "> 引用\n\n", caret: 6 });
  expect(appendQuote("  \n ", "引用").text).toBe("> 引用\n\n");
});

test("an empty quote leaves the draft as it is", () => {
  expect(appendQuote("本文", "  \n\t")).toEqual({ text: "本文", caret: 2 });
});

test("a comment between quotes keeps both quotes", () => {
  const first = appendQuote("", "引用1");
  const second = appendQuote(`${first.text}コメント`, "引用2");
  expect(second.text).toBe("> 引用1\n\nコメント\n\n> 引用2\n\n");
  expect(second.caret).toBe(second.text.length);
});

test("a quote followed by a blank line splits into a quote and a body", () => {
  expect(splitQuote("> 引用\n\n本文")).toEqual({ quote: "引用", body: "本文" });
});

test("a quote alone splits into a quote without a body", () => {
  expect(splitQuote("> 引用")).toEqual({ quote: "引用", body: "" });
});

test("a quote without the blank line still splits", () => {
  expect(splitQuote("> 引用\n本文")).toEqual({ quote: "引用", body: "本文" });
});

test("blank markers and marker spacing both split", () => {
  expect(splitQuote("> 前\n>\n> 後\n\n本文")).toEqual({ quote: "前\n\n後", body: "本文" });
});

test("a marker inside the body is left alone", () => {
  expect(splitQuote("本文\n> 引用")).toEqual({ quote: null, body: "本文\n> 引用" });
  expect(splitQuote("> 引用\n\n本文\n> 残り")).toEqual({ quote: "引用", body: "本文\n> 残り" });
});

test("a body that does not start with a marker is not a quote", () => {
  expect(splitQuote("本文だけ")).toEqual({ quote: null, body: "本文だけ" });
});

test("a marker only message stays a body", () => {
  expect(splitQuote(">\n> ")).toEqual({ quote: null, body: ">\n> " });
});

const idle = {
  uploading: false,
  chip: null,
  replying: false,
  draft: "",
  attachments: 0,
};

test("a quoted draft can be sent", () => {
  expect(canSend({ ...idle, draft: "> 引用" })).toBe(true);
});

test("a draft alone can be sent", () => {
  expect(canSend({ ...idle, draft: "本文" })).toBe(true);
  expect(canSend({ ...idle, draft: "  " })).toBe(false);
});

test("an attachment alone can be sent", () => {
  expect(canSend({ ...idle, attachments: 1 })).toBe(true);
});

test("nothing typed yet cannot be sent", () => {
  expect(canSend(idle)).toBe(false);
});

test("an upload in flight blocks the send", () => {
  expect(canSend({ ...idle, draft: "本文", uploading: true })).toBe(false);
  expect(canSend({ ...idle, attachments: 1, uploading: true })).toBe(false);
});

test("a chip can be sent unless the agent is working", () => {
  expect(canSend({ ...idle, chip: "compact" })).toBe(true);
  expect(canSend({ ...idle, chip: "compact", replying: true })).toBe(false);
  expect(canSend({ ...idle, chip: "new", replying: true })).toBe(false);
});

const stoppable = {
  replying: true,
  agent: "pi",
  running: false,
  draft: "",
  attachments: 0,
  chip: null,
};

test("a working agent with an empty composer can be stopped", () => {
  expect(canStop(stoppable)).toBe(true);
  expect(canStop({ ...stoppable, replying: false })).toBe(false);
});

test("only known agents can be stopped", () => {
  for (const agent of ["pi", "claude", "codex", "opencode"]) {
    expect(canStop({ ...stoppable, agent })).toBe(true);
  }
  for (const agent of [null, "custom", "shell"]) {
    expect(canStop({ ...stoppable, agent })).toBe(false);
  }
});

// シェルの停止は前景プロセスがあるときだけ。プロンプトへの C-c は入力行を消すだけ。
test("a shell with a foreground process can be stopped", () => {
  const shell = { ...stoppable, replying: false, agent: null, running: true };
  expect(canStop(shell)).toBe(true);
  expect(canStop({ ...shell, running: false })).toBe(false);
  expect(canStop({ ...shell, draft: "続き" })).toBe(false);
});

test("an idle agent is not stopped by the shell rule", () => {
  expect(canStop({ ...stoppable, replying: false, agent: "pi", running: true })).toBe(false);
});

test("content in the composer keeps the send action", () => {
  expect(canStop({ ...stoppable, draft: "続き" })).toBe(false);
  expect(canStop({ ...stoppable, draft: "  " })).toBe(true);
  expect(canStop({ ...stoppable, attachments: 1 })).toBe(false);
  expect(canStop({ ...stoppable, draft: "> 引用" })).toBe(false);
  expect(canStop({ ...stoppable, chip: "compact" })).toBe(false);
});
