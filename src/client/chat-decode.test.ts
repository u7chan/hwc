import { expect, test } from "bun:test";
import { toChatSnapshot } from "./chat-decode";

const chatBody = {
  etag: "abc",
  messages: [{ id: "m1", role: "agent" as const, text: "hi", at: 1_000 }],
  model: "pi-large",
  effort: null,
  truncated: false,
  context: null,
  compaction: null,
  canRewind: true,
};

test("a chat body is accepted as the contract describes it", () => {
  expect(toChatSnapshot(chatBody)).toEqual(chatBody);
  expect(toChatSnapshot({ ...chatBody, messages: [] })).toEqual({ ...chatBody, messages: [] });
  expect(toChatSnapshot({ ...chatBody, model: null })).toEqual({ ...chatBody, model: null });
});

test("a synthetic ask_user answer keeps its flag", () => {
  const message = {
    id: "ask:call_ask:answer",
    role: "user" as const,
    text: "青",
    at: 1,
    synthetic: true as const,
    askId: "ask-1",
    askOptions: [
      { label: "赤", recommended: true, selected: false },
      { label: "青", recommended: false, selected: true },
    ],
    answerKind: "option" as const,
  };
  expect(toChatSnapshot({ ...chatBody, messages: [message] })?.messages).toEqual([message]);
});

test("malformed ask options are dropped without dropping the question", () => {
  const message = {
    id: "ask:call_ask:question",
    role: "agent" as const,
    text: "Q",
    at: 1,
    synthetic: true as const,
    askOptions: [
      { label: "   ", recommended: true, selected: false },
      { label: "A", recommended: "yes", selected: false },
      { label: "B", recommended: true, selected: "no" },
      { label: " C ", recommended: true, selected: false },
    ],
  };
  const kept = toChatSnapshot({ ...chatBody, messages: [message] })?.messages[0];
  expect(kept).toEqual({
    ...message,
    askOptions: [{ label: "C", recommended: true, selected: false }],
  });
});

test("a pending prompt is kept as the contract describes it", () => {
  const question = {
    kind: "question" as const,
    toolUseId: "t1",
    tool: "AskUserQuestion" as const,
    questions: [
      {
        question: "好きな色は？",
        header: "色",
        multiSelect: true,
        options: [
          { label: "赤", description: "暖かい色" },
          { label: "青", description: null },
        ],
      },
    ],
  };
  expect(toChatSnapshot({ ...chatBody, pending: question })?.pending).toEqual(question);

  const tool = {
    kind: "tool" as const,
    toolUseId: "t2",
    tool: "Bash",
    summary: "touch /tmp/demo",
  };
  expect(toChatSnapshot({ ...chatBody, pending: tool })?.pending).toEqual(tool);
  // 要約の無い承認待ちも、ツール名だけで出す。
  expect(toChatSnapshot({ ...chatBody, pending: { ...tool, summary: "" } })?.pending).toEqual({
    ...tool,
    summary: null,
  });
});

test("a pi ask_user prompt is kept with the freeText the BFF sends", () => {
  const ask = {
    kind: "question" as const,
    toolUseId: "11111111-1111-4111-8111-111111111111",
    tool: "ask_user" as const,
    freeText: true,
    questions: [{ question: "どうしますか？", header: null, multiSelect: false, options: [] }],
  };
  expect(toChatSnapshot({ ...chatBody, pending: ask })?.pending).toEqual(ask);

  const withOptions = {
    ...ask,
    questions: [
      {
        question: "どれにしますか？",
        header: null,
        multiSelect: false,
        options: [
          { label: "赤", description: null },
          { label: "青", description: null },
        ],
      },
    ],
  };
  expect(toChatSnapshot({ ...chatBody, pending: withOptions })?.pending).toEqual(withOptions);

  // 選択肢があっても自由入力を出さない指定は、そのまま反映する。
  const optionsOnly = { ...withOptions, freeText: false };
  expect(toChatSnapshot({ ...chatBody, pending: optionsOnly })?.pending).toEqual(optionsOnly);

  // freeText は BFF が必ず boolean で返す。無い・boolean でない応答は形の不一致として捨てる。
  const { freeText: _ignored, ...withoutFreeText } = ask;
  expect(toChatSnapshot({ ...chatBody, pending: withoutFreeText })).toEqual(chatBody);
  expect(toChatSnapshot({ ...chatBody, pending: { ...ask, freeText: "true" } })).toEqual(chatBody);

  // ask_user は 1 問だけ。複数ある形は壊れた値として捨てる。
  const two = { ...ask, questions: [ask.questions[0], ask.questions[0]] };
  expect(toChatSnapshot({ ...chatBody, pending: two })).toEqual(chatBody);
});

test("a pending prompt that breaks the contract costs the card, not the conversation", () => {
  const questions = [
    { question: "好きな色は？", header: "色", multiSelect: false, options: [{ label: "赤" }] },
  ];
  const broken: unknown[] = [
    null,
    {},
    { kind: "question", toolUseId: "t1", tool: "AskUserQuestion", questions: [] },
    { kind: "question", toolUseId: "t1", tool: "AskUserQuestion", questions: "色" },
    { kind: "question", toolUseId: "", tool: "AskUserQuestion", questions },
    { kind: "question", toolUseId: "t1", tool: "Bash", questions },
    {
      kind: "question",
      toolUseId: "t1",
      tool: "AskUserQuestion",
      questions: [{ question: "", options: [{ label: "赤" }] }],
    },
    {
      kind: "question",
      toolUseId: "t1",
      tool: "AskUserQuestion",
      questions: [{ question: "色は？", options: [] }],
    },
    {
      kind: "question",
      toolUseId: "t1",
      tool: "AskUserQuestion",
      questions: [{ question: "色は？", options: [{ label: "" }] }],
    },
    { kind: "tool", toolUseId: "t2", tool: "" },
  ];
  for (const pending of broken) {
    expect(toChatSnapshot({ ...chatBody, pending })).toEqual(chatBody);
  }
});

test("canRewind is kept only when it is true", () => {
  expect(toChatSnapshot(chatBody)?.canRewind).toBe(true);
  expect(toChatSnapshot({ ...chatBody, canRewind: false })?.canRewind).toBe(false);
  expect(toChatSnapshot({ ...chatBody, canRewind: "yes" })?.canRewind).toBe(false);
});

test("leafId is kept only when it is an id", () => {
  expect(toChatSnapshot({ ...chatBody, leafId: "a1" })?.leafId).toBe("a1");
  expect(toChatSnapshot(chatBody)?.leafId).toBeUndefined();
  expect(toChatSnapshot({ ...chatBody, leafId: 3 })?.leafId).toBeUndefined();
});

test("a failed turn is read as an error row", () => {
  const message = { id: "e1", role: "error" as const, text: "429: busy", at: 1_000 };
  expect(toChatSnapshot({ ...chatBody, messages: [message] })).toEqual({
    ...chatBody,
    messages: [message],
  });
});

test("a retry count is kept only when it is a real count", () => {
  const error = { id: "e1", role: "error" as const, text: "429: busy", at: 1_000 };
  expect(toChatSnapshot({ ...chatBody, messages: [{ ...error, count: 4 }] })?.messages).toEqual([
    { ...error, count: 4 },
  ]);
  // 1 回だけの失敗は count を持たない。壊れた値は回数を出さないだけで、行は残す。
  for (const count of [1, 0, -2, 1.5, "4", null]) {
    expect(toChatSnapshot({ ...chatBody, messages: [{ ...error, count }] })?.messages).toEqual([
      error,
    ]);
  }
});

test("a context that breaks the contract costs the numbers, not the conversation", () => {
  const wide = { tokens: 122_600, window: 1_000_000 };

  expect(toChatSnapshot({ ...chatBody, context: wide })).toEqual({ ...chatBody, context: wide });
  // 片方だけ分かる状態も契約のうち。
  expect(toChatSnapshot({ ...chatBody, context: { tokens: null, window: 1_000_000 } })).toEqual({
    ...chatBody,
    context: { tokens: null, window: 1_000_000 },
  });
  expect(toChatSnapshot({ ...chatBody, context: { tokens: 122_600, window: null } })).toEqual({
    ...chatBody,
    context: { tokens: 122_600, window: null },
  });
  // 形が違う context は数字を出さないだけにする。会話は捨てない。
  for (const context of [
    undefined,
    {},
    { tokens: "122600", window: 1_000_000 },
    { tokens: 122_600 },
    { tokens: 122_600, window: "1000000" },
    [122_600, 1_000_000],
    122_600,
  ]) {
    expect(toChatSnapshot({ ...chatBody, context })).toEqual({ ...chatBody, context: null });
  }
});

test("usage parts survive validation without sacrificing the conversation when malformed", () => {
  const usage = { input: 81_000, output: 900, cacheRead: 0, cacheWrite: null, reasoning: null };
  expect(toChatSnapshot({ ...chatBody, usage })).toEqual({ ...chatBody, usage });
  for (const broken of [
    { ...usage, input: -1 },
    { ...usage, output: "900" },
    { ...usage, cacheRead: NaN },
    {},
  ]) {
    expect(toChatSnapshot({ ...chatBody, usage: broken })).toEqual(chatBody);
  }
});

test("a compaction that breaks the contract costs the summary, not the conversation", () => {
  const compaction = { at: 1_700_000_000_000, tokensBefore: 212_959, summary: "so far", index: 0 };

  expect(toChatSnapshot({ ...chatBody, compaction })).toEqual({ ...chatBody, compaction });
  // 形が違う compaction は要約を出さないだけにする。会話は捨てない。
  for (const broken of [
    undefined,
    {},
    { at: 1, summary: "so far" },
    { at: 1, tokensBefore: "212959", summary: "so far" },
    { at: 1, tokensBefore: null },
    { at: 1, tokensBefore: null, summary: "so far" },
    { at: 1, tokensBefore: null, summary: "so far", index: -1 },
    { at: 1, tokensBefore: null, summary: "so far", index: 1.5 },
    "so far",
  ]) {
    expect(toChatSnapshot({ ...chatBody, compaction: broken })).toEqual({
      ...chatBody,
      compaction: null,
    });
  }
});

test("a chat body that breaks the contract is dropped", () => {
  expect(toChatSnapshot(null)).toBeNull();
  expect(toChatSnapshot({ ...chatBody, etag: undefined })).toBeNull();
  expect(toChatSnapshot({ ...chatBody, truncated: "no" })).toBeNull();
  // null と文字列以外は「無い」と区別できないので受けない。
  expect(toChatSnapshot({ ...chatBody, effort: undefined })).toBeNull();
  expect(toChatSnapshot({ ...chatBody, messages: null })).toBeNull();
  expect(
    toChatSnapshot({ ...chatBody, messages: [{ ...chatBody.messages[0], role: "system" }] }),
  ).toBeNull();
  expect(
    toChatSnapshot({ ...chatBody, messages: [{ ...chatBody.messages[0], at: "1" }] }),
  ).toBeNull();
});

test("a message keeps its attachments as saved names and sizes, images or not", () => {
  const message = {
    id: "m1",
    role: "user" as const,
    text: "",
    at: 1_000,
    attachments: [
      { name: "pasted-20261103-120000.png", size: 2048 },
      { name: "report.zip", size: 3_013_590 },
      { name: "My Report.xlsx", size: null },
    ],
  };
  expect(toChatSnapshot({ ...chatBody, messages: [message] })?.messages).toEqual([message]);

  // サイズは表示だけに使う。壊れた値は名前だけを出す。
  expect(
    toChatSnapshot({
      ...chatBody,
      messages: [{ ...message, attachments: [{ name: "report.zip", size: "big" }] }],
    })?.messages,
  ).toEqual([
    {
      id: "m1",
      role: "user",
      text: "",
      at: 1_000,
      attachments: [{ name: "report.zip", size: null }],
    },
  ]);

  // 負数・小数・非数は表示に使わない。名前だけを残す。
  expect(
    toChatSnapshot({
      ...chatBody,
      messages: [
        {
          ...message,
          attachments: [
            { name: "report.zip", size: -1 },
            { name: "report-1.zip", size: 1.9 },
            { name: "report-2.zip", size: Number.NaN },
          ],
        },
      ],
    })?.messages,
  ).toEqual([
    {
      id: "m1",
      role: "user",
      text: "",
      at: 1_000,
      attachments: [
        { name: "report.zip", size: null },
        { name: "report-1.zip", size: 1 },
        { name: "report-2.zip", size: null },
      ],
    },
  ]);

  // 保存名の規則を通らない名前は配信 URL にしない。名前が全部落ちたら添付なしとして扱う。
  expect(
    toChatSnapshot({
      ...chatBody,
      messages: [{ ...message, attachments: [{ name: "../x.png", size: 1 }] }],
    })?.messages,
  ).toEqual([{ id: "m1", role: "user", text: "", at: 1_000 }]);
  expect(
    toChatSnapshot({
      ...chatBody,
      messages: [{ ...message, attachments: [{ name: ".env", size: 1 }] }],
    })?.messages,
  ).toEqual([{ id: "m1", role: "user", text: "", at: 1_000 }]);
  expect(
    toChatSnapshot({ ...chatBody, messages: [{ ...message, attachments: [] }] })?.messages,
  ).toEqual([{ id: "m1", role: "user", text: "", at: 1_000 }]);
});

test("a file keeps the root label only as a display string", () => {
  const snapshotWithLabel = (rootLabel: unknown) =>
    toChatSnapshot({
      ...chatBody,
      messages: [
        {
          id: "m1",
          role: "agent" as const,
          text: "`docs/mock.html`",
          at: 1_000,
          files: [{ name: "docs/mock.html", version: "1-2", kind: "html", root: 1, rootLabel }],
        },
      ],
    })?.messages[0]?.files?.[0];

  // チェックアウト以外の根は、固定の表記か設定値の basename だけを持つ。
  expect(snapshotWithLabel("/tmp")?.rootLabel).toBe("/tmp");
  expect(snapshotWithLabel("mock")?.rootLabel).toBe("mock");
  // 長い basename は描画側で抑える。黙って捨てない。
  const long = "a".repeat(120);
  expect(snapshotWithLabel(long)?.rootLabel).toBe(long);

  // 絶対パスを渡さない契約なので、区切りを含む値は捨てる。
  for (const broken of ["/srv/mock", "a/b", "a\\b", "", 3, null]) {
    expect(snapshotWithLabel(broken)?.rootLabel).toBeUndefined();
  }
});

test("an image keeps only the inline refs the client can draw", () => {
  const message = {
    id: "m1",
    role: "agent" as const,
    text: "![モック](docs/mock.png)",
    at: 1_000,
    files: [
      {
        name: "docs/mock.png",
        version: "1-2",
        kind: "image" as const,
        root: 0,
        imageRefs: ["docs/mock.png", "docs/other.png", 3, "", null],
      },
    ],
  };
  expect(toChatSnapshot({ ...chatBody, messages: [message] })?.messages).toEqual([
    {
      ...message,
      files: [
        {
          name: "docs/mock.png",
          version: "1-2",
          kind: "image",
          root: 0,
          imageRefs: ["docs/mock.png", "docs/other.png"],
        },
      ],
    },
  ]);

  // 使える表記が 1 つも無ければ持たない。末尾の一覧に戻る。
  expect(
    toChatSnapshot({
      ...chatBody,
      messages: [{ ...message, files: [{ ...message.files[0], imageRefs: [""] }] }],
    })?.messages[0]?.files,
  ).toEqual([{ name: "docs/mock.png", version: "1-2", kind: "image", root: 0 }]);
});

test("an agent message keeps the files the server found", () => {
  const message = {
    id: "m1",
    role: "agent" as const,
    text: "`docs/mock.png` に置きました。",
    at: 1_000,
    files: [
      {
        name: "docs/mock.png",
        version: "1767225600000-12",
        kind: "image" as const,
        root: 0,
        imageRefs: ["docs/mock.png"],
      },
      {
        name: "docs/preview/index.html",
        version: "1767225600000-20",
        kind: "html" as const,
        root: 0,
      },
    ],
  };
  expect(toChatSnapshot({ ...chatBody, messages: [message] })?.messages).toEqual([message]);

  // 配信 URL になる。根の外を指す名前や壊れた版・根の番号、知らない見せ方は捨てる。
  const broken = {
    ...message,
    files: [
      { name: "/etc/passwd.png", version: "1-2", kind: "image", root: 0 },
      { name: "../secret.png", version: "1-2", kind: "image", root: 0 },
      { name: "", version: "1-2", kind: "image", root: 0 },
      { name: "docs/ok.png", version: 3, kind: "image", root: 0 },
      { name: "docs/neg.png", version: "1-2", kind: "image", root: -1 },
      { name: "docs/frac.png", version: "1-2", kind: "image", root: 1.5 },
      { name: "docs/none.png", version: "1-2", kind: "image" },
      { name: "docs/note.md", version: "1-2", kind: "markdown", root: 0 },
      { name: "docs/note.md", version: "1-2" },
    ],
  };
  expect(toChatSnapshot({ ...chatBody, messages: [broken] })?.messages).toEqual([
    { id: "m1", role: "agent", text: message.text, at: 1_000 },
  ]);
  expect(toChatSnapshot({ ...chatBody, messages: [{ ...message, files: [] }] })?.messages).toEqual([
    { id: "m1", role: "agent", text: message.text, at: 1_000 },
  ]);
});

test("a link keeps only the refs the client can open", () => {
  const link = {
    href: "docs/note.md",
    name: "docs/note.md",
    version: "1-2",
    kind: "text" as const,
    root: 0,
  };
  const linksOf = (links: unknown[]) =>
    toChatSnapshot({
      ...chatBody,
      messages: [{ id: "m1", role: "agent" as const, text: "`docs/note.md`", at: 1_000, links }],
    })?.messages[0]?.links;

  // 本文との照合は描画側（messageLinks）で、ここは形の検査だけ。通った項目は href・根・
  // 版・ラベルをそのまま保つ。
  expect(linksOf([link])).toEqual([link]);
  expect(linksOf([{ ...link, root: 1, rootLabel: "mock" }])).toEqual([
    { ...link, root: 1, rootLabel: "mock" },
  ]);

  // 配信 URL の材料になる。根の外を指す名前や壊れた版・根の番号、知らない見せ方は捨てる。
  for (const broken of [
    { ...link, name: "/etc/passwd.md" },
    { ...link, name: "../secret.md" },
    { ...link, name: "" },
    { ...link, version: 3 },
    { ...link, version: undefined },
    { ...link, root: -1 },
    { ...link, root: 1.5 },
    { ...link, root: "0" },
    { ...link, kind: "markdown" },
    { ...link, href: "" },
  ]) {
    expect(linksOf([broken])).toBeUndefined();
  }
  expect(linksOf([])).toBeUndefined();
});

test("an agent message keeps the name of a file outside the roots", () => {
  const message = {
    id: "m1",
    role: "agent" as const,
    text: "モックは `/tmp/demo/mock.html` に置きました。",
    at: 1_000,
    outsideFile: "mock.html",
  };
  expect(toChatSnapshot({ ...chatBody, messages: [message] })?.messages).toEqual([message]);

  // 名前だけを描く。パスや空文字は、契約違反として捨てる。
  for (const outsideFile of ["/tmp/demo/mock.html", "docs/mock.html", "", 3, null]) {
    expect(
      toChatSnapshot({ ...chatBody, messages: [{ ...message, outsideFile }] })?.messages[0],
    ).toEqual({ id: "m1", role: "agent", text: message.text, at: 1_000 });
  }
});

test("a cache expiry is kept only when it is a finite absolute time", () => {
  expect(toChatSnapshot({ ...chatBody, cacheExpiresAt: 12_345 })).toMatchObject({
    cacheExpiresAt: 12_345,
  });
  // 飾りの値が壊れても会話は捨てず、期限だけを出さない。
  for (const value of [null, "soon", Number.NaN, Number.POSITIVE_INFINITY]) {
    const snapshot = toChatSnapshot({ ...chatBody, cacheExpiresAt: value });
    expect(snapshot?.messages).toHaveLength(1);
    expect(snapshot?.cacheExpiresAt).toBeUndefined();
  }
});
