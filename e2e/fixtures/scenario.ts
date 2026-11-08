import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { HerdrSnapshot } from "../../src/server/herdr/contract";
import { FOLDER_TRUST_SCREEN, PI_TRUST_SCREEN } from "./folder-trust";

export type Scenario = {
  snapshot: HerdrSnapshot;
  outputs: Record<string, string>;
  // ペインで動いている前景コマンド。指定の無いシェルはプロンプトで待っている。
  // listen が true のコマンドは、架空 Herdr が実プロセスとして待ち受けさせる。
  foreground: Record<string, { cmdline: string; listen: boolean }>;
};

export type CodexFixture = {
  thread: { id: string; model: string; reasoningEffort: string };
  turns: { id: string; startedAt: number; items: Record<string, unknown>[] }[];
};

export async function writeCodexThread(
  root: string,
  id: string,
  model: string,
  turns: CodexFixture["turns"] = [],
  reasoningEffort = "high",
) {
  const directory = join(root, "codex", "threads");
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, `${id}.json`),
    JSON.stringify({
      thread: { id, model, reasoningEffort },
      turns,
    } satisfies CodexFixture),
  );
}

// 起動に失敗する架空モデル。新しいペインやワークツリーの部分成功を、実 CLI に触れずに確かめる。
export const START_FAILS_MODEL_ID = "@demo/start-fails";

export const STARTUP_MODELS = [
  {
    provider: "example",
    id: "beam-small",
    efforts: {
      pi: ["low", "high"],
      codex: ["low", "medium", "high"],
      opencode: ["eco", "deep-review"],
    },
  },
  {
    provider: "example",
    id: "beam-long-name-for-mobile-layout",
    efforts: {
      pi: ["minimal", "low", "medium", "high", "xhigh", "max"],
      codex: ["high", "xhigh"],
      opencode: ["fast", "じっくり review"],
    },
  },
  { provider: "example", id: "@demo/beam-small", efforts: { pi: [], codex: [], opencode: [] } },
  {
    provider: "example",
    id: START_FAILS_MODEL_ID,
    efforts: { pi: [], codex: [], opencode: [] },
  },
];

// 実在のユーザー名・リポジトリ名・パスを fixture に写さない。E2E のスクリーンショットは
// ここで作ったデータだけを見せる。
export async function createScenario(root: string): Promise<Scenario> {
  const dashboard = join(root, "work", "acme-dashboard");
  const docs = join(root, "work", "acme-dashboard-docs");
  const scratch = join(root, "work", "scratch");
  const agentDir = join(root, "agent");
  const sessionPath = join(agentDir, "sessions", "demo", "session.jsonl");
  const emptySessionPath = join(agentDir, "sessions", "empty", "session.jsonl");

  await Promise.all([
    writeBranch(dashboard, "feat/empty-state"),
    writeBranch(docs, "docs/quickstart"),
    mkdir(scratch, { recursive: true }),
    mkdir(join(agentDir, "sessions", "demo"), { recursive: true }),
    mkdir(join(agentDir, "sessions", "empty"), { recursive: true }),
    mkdir(join(root, "bin"), { recursive: true }),
  ]);

  // エージェントが書いた画像のプレビュー。チェックアウトの内側に置いた実在の PNG だけが出る。
  await mkdir(join(dashboard, "docs", "preview"), { recursive: true });
  await copyFile(
    fileURLToPath(new URL("../../src/client/assets/apple-touch-icon.png", import.meta.url)),
    join(dashboard, "docs", "preview", "app-icon.png"),
  );

  await Promise.all([
    writeFile(join(agentDir, "models-store.json"), JSON.stringify(modelStore)),
    writeFile(sessionPath, sessionLines.map((line) => `${line}\n`).join("")),
    writeFile(emptySessionPath, `${JSON.stringify(emptySessionHeader)}\n`),
    writeCodexThread(root, "thread_demo", "beam-small", [
      {
        id: "turn_demo",
        startedAt: 1767258000,
        items: [
          {
            type: "userMessage",
            id: "u1",
            content: [{ type: "text", text: "空状態の変更をレビューしてください。" }],
          },
          {
            type: "agentMessage",
            id: "a1",
            text: "## レビュー結果\n\n- 空状態の分岐と余白は揃っています。\n- 追加の修正はありません。",
          },
        ],
      },
    ]),
    writeFile(
      join(root, "bin", "codex"),
      `#!/bin/sh\nexec "${process.execPath}" "${fileURLToPath(new URL("../fake-codex.ts", import.meta.url))}" "$@"\n`,
      { mode: 0o700 },
    ),
    writeFile(
      join(root, "bin", "pi"),
      `#!/bin/sh\nexec "${process.execPath}" "${fileURLToPath(new URL("../fake-pi.ts", import.meta.url))}" "$@"\n`,
      { mode: 0o700 },
    ),
    writeFile(
      join(root, "bin", "gh"),
      `#!/bin/sh\nexec "${process.execPath}" "${fileURLToPath(new URL("../fake-gh.ts", import.meta.url))}" "$@"\n`,
      { mode: 0o700 },
    ),
  ]);

  const snapshot: HerdrSnapshot = {
    focused_workspace_id: "w1",
    focused_tab_id: "w1:t1",
    focused_pane_id: "w1:p1",
    workspaces: [
      {
        workspace_id: "w1",
        label: "acme-dashboard",
        agent_status: "working",
        focused: true,
        worktree: {
          repo_name: "acme-dashboard",
          repo_root: dashboard,
          checkout_path: dashboard,
          is_linked_worktree: false,
        },
      },
      {
        workspace_id: "w2",
        label: "acme-dashboard (docs)",
        agent_status: "blocked",
        focused: false,
        worktree: {
          repo_name: "acme-dashboard",
          repo_root: dashboard,
          checkout_path: docs,
          is_linked_worktree: true,
        },
      },
      {
        workspace_id: "w3",
        label: "scratch",
        agent_status: "idle",
        focused: false,
        worktree: null,
      },
    ],
    tabs: [
      {
        tab_id: "w1:t1",
        workspace_id: "w1",
        label: "web",
        agent_status: "working",
        focused: true,
      },
      {
        tab_id: "w1:t2",
        workspace_id: "w1",
        label: "checks",
        agent_status: "idle",
        focused: false,
      },
      {
        tab_id: "w2:t1",
        workspace_id: "w2",
        label: "docs",
        agent_status: "blocked",
        focused: false,
      },
      {
        tab_id: "w3:t1",
        workspace_id: "w3",
        label: "notes",
        agent_status: "idle",
        focused: false,
      },
    ],
    panes: [
      {
        pane_id: "w1:p1",
        workspace_id: "w1",
        tab_id: "w1:t1",
        cwd: dashboard,
        label: "frontend",
        agent_status: "working",
        focused: true,
        agent_session: {
          agent: "pi",
          source: "integration",
          kind: "path",
          value: sessionPath,
        },
      },
      {
        pane_id: "w1:p2",
        workspace_id: "w1",
        tab_id: "w1:t1",
        cwd: dashboard,
        label: "shell",
        agent_status: "unknown",
        focused: false,
        agent_session: null,
      },
      {
        pane_id: "w1:p3",
        workspace_id: "w1",
        tab_id: "w1:t2",
        cwd: dashboard,
        label: "review",
        agent_status: "idle",
        focused: false,
        agent_session: { agent: "codex", source: "herdr:codex", kind: "id", value: "thread_demo" },
      },
      {
        pane_id: "w1:p4",
        workspace_id: "w1",
        tab_id: "w1:t2",
        cwd: dashboard,
        label: "new",
        agent_status: "idle",
        focused: false,
        agent_session: {
          agent: "pi",
          source: "integration",
          kind: "path",
          value: emptySessionPath,
        },
      },
      // アクティブ一覧の束と、開いても消えない完了行を確かめるための done。
      // ラベルは帯のワークスペース名で始まり、行では残り（api）だけが出る。
      {
        pane_id: "w1:p5",
        workspace_id: "w1",
        tab_id: "w1:t2",
        cwd: dashboard,
        label: "acme-dashboard-api",
        agent_status: "done",
        focused: false,
        agent_session: null,
      },
      {
        pane_id: "w2:p1",
        workspace_id: "w2",
        tab_id: "w2:t1",
        cwd: docs,
        label: "writer",
        agent_status: "blocked",
        focused: false,
        agent_session: null,
      },
      {
        pane_id: "w3:p1",
        workspace_id: "w3",
        tab_id: "w3:t1",
        cwd: scratch,
        label: "notes",
        agent_status: "unknown",
        focused: false,
        agent_session: null,
      },
      {
        pane_id: "w3:p2",
        workspace_id: "w3",
        tab_id: "w3:t1",
        cwd: scratch,
        label: "folder-trust",
        agent_status: "blocked",
        focused: false,
        agent_session: null,
      },
      {
        pane_id: "w3:p3",
        workspace_id: "w3",
        tab_id: "w3:t1",
        cwd: scratch,
        label: "folder-trust-saved",
        agent_status: "idle",
        focused: false,
        agent_session: { agent: "codex", source: "herdr:codex", kind: "id", value: "thread_demo" },
      },
      {
        pane_id: "w3:p4",
        workspace_id: "w3",
        tab_id: "w3:t1",
        cwd: scratch,
        label: "codex-start",
        agent_status: "idle",
        focused: false,
        agent_session: null,
      },
      {
        pane_id: "w3:p5",
        workspace_id: "w3",
        tab_id: "w3:t1",
        cwd: scratch,
        label: "pi-trust",
        // 実 Herdr は pi の信頼確認を blocked として検出しない。会話が無いペインでも
        // 画面から確認を見つけられることを、この状態で確かめる。
        agent_status: "idle",
        focused: false,
        agent_session: null,
      },
    ],
    agents: [
      {
        pane_id: "w1:p1",
        workspace_id: "w1",
        cwd: dashboard,
        agent: "pi",
        terminal_title_stripped: "acme-dashboard",
      },
      {
        pane_id: "w1:p3",
        workspace_id: "w1",
        cwd: dashboard,
        agent: "codex",
        terminal_title_stripped: "acme-dashboard",
      },
      {
        pane_id: "w1:p4",
        workspace_id: "w1",
        cwd: dashboard,
        agent: "pi",
        terminal_title_stripped: "acme-dashboard",
      },
      {
        pane_id: "w1:p5",
        workspace_id: "w1",
        cwd: dashboard,
        agent: "pi",
        terminal_title_stripped: "acme-dashboard",
      },
      {
        pane_id: "w2:p1",
        workspace_id: "w2",
        cwd: docs,
        agent: "claude",
        terminal_title_stripped: "docs",
      },
      ...["w3:p2", "w3:p3", "w3:p4"].map((pane_id) => ({
        pane_id,
        workspace_id: "w3",
        cwd: scratch,
        agent: "codex",
        terminal_title_stripped: "scratch",
      })),
      {
        pane_id: "w3:p5",
        workspace_id: "w3",
        cwd: scratch,
        agent: "pi",
        terminal_title_stripped: "scratch",
      },
    ],
  };

  return {
    snapshot,
    foreground: {
      // シェルで開発サーバーが動いているペイン。タブ名がコマンドとポートに変わり、
      // 停止ボタンが出る。
      "w1:p2": { cmdline: "bun --watch src/server.ts", listen: true },
    },
    outputs: {
      ...outputs,
      "w1:p5": "$ echo done\ndone\n$",
      "w3:p2": FOLDER_TRUST_SCREEN,
      "w3:p3": FOLDER_TRUST_SCREEN,
      "w3:p4": "› Ask Codex to do anything\n",
      "w3:p5": PI_TRUST_SCREEN,
    },
  };
}

async function writeBranch(directory: string, branch: string): Promise<void> {
  await mkdir(join(directory, ".git"), { recursive: true });
  await writeFile(join(directory, ".git", "HEAD"), `ref: refs/heads/${branch}\n`);
}

const modelStore = {
  anthropic: {
    models: [{ id: "claude-sonnet-4-5", contextWindow: 200_000 }],
  },
};

const sessionHeader = {
  type: "session",
  version: 3,
  id: "e2e-demo",
  timestamp: "2026-01-01T09:00:00.000Z",
  cwd: "/home/dev/work/acme-dashboard",
};

const emptySessionHeader = {
  ...sessionHeader,
  id: "e2e-empty",
  timestamp: "2026-01-02T09:00:00.000Z",
};

const sessionEntries = [
  {
    type: "message",
    id: "u1",
    parentId: null,
    timestamp: "2026-01-01T09:00:01.000Z",
    message: {
      role: "user",
      content: "ダッシュボードが空のときに、余白だけ残って案内が出ません。原因を見て直したいです。",
      timestamp: Date.parse("2026-01-01T09:00:01.000Z"),
    },
  },
  {
    type: "message",
    id: "a1",
    parentId: "u1",
    timestamp: "2026-01-01T09:00:02.000Z",
    message: {
      role: "assistant",
      content: [
        {
          type: "text",
          text: "空状態の分岐が `items.length === 0` ではなく `items === null` になっていました。`EmptyState` を出し、余白はカードと同じ 24px に揃えるのがよさそうです。",
        },
      ],
      model: "claude-sonnet-4-5",
      provider: "anthropic",
      timestamp: Date.parse("2026-01-01T09:00:02.000Z"),
      usage: {
        input: 38_000,
        output: 4_000,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 42_000,
      },
    },
  },
  {
    type: "message",
    id: "u2",
    parentId: "a1",
    timestamp: "2026-01-01T09:00:03.000Z",
    message: {
      role: "user",
      content: "その方針でお願いします。テストも 1 本足してください。",
      timestamp: Date.parse("2026-01-01T09:00:03.000Z"),
    },
  },
  {
    type: "message",
    id: "a2",
    parentId: "u2",
    timestamp: "2026-01-01T09:00:04.000Z",
    message: {
      role: "assistant",
      content: [
        {
          type: "text",
          text: "`EmptyState` を追加し、空配列のときに案内を出すようにしました。`empty-state.test.ts` に表示のテストを 1 本足しています。",
        },
      ],
      model: "claude-sonnet-4-5",
      provider: "anthropic",
      timestamp: Date.parse("2026-01-01T09:00:04.000Z"),
      usage: {
        input: 42_000,
        output: 6_000,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 48_000,
      },
    },
  },
  {
    type: "thinking_level_change",
    id: "t1",
    parentId: "a2",
    timestamp: "2026-01-01T09:00:05.000Z",
    thinkingLevel: "high",
  },
  {
    type: "compaction",
    id: "c1",
    parentId: "t1",
    timestamp: "2026-01-01T09:00:06.000Z",
    summary: "以前の会話では、空状態の分岐とテスト追加の方針を確認しました。",
    firstKeptEntryId: "u2",
    tokensBefore: 48_000,
  },
  {
    type: "message",
    id: "a3",
    parentId: "c1",
    timestamp: "2026-01-01T09:00:07.000Z",
    message: {
      role: "assistant",
      content: [
        { type: "text", text: "空状態の表示とテストを再確認しました。追加の修正はありません。" },
      ],
      model: "claude-sonnet-4-5",
      provider: "anthropic",
      timestamp: Date.parse("2026-01-01T09:00:07.000Z"),
      usage: {
        input: 4_000,
        output: 1_000,
        cacheRead: 7_000,
        cacheWrite: 0,
        totalTokens: 12_000,
      },
    },
  },
  {
    type: "message",
    id: "a3-preview",
    parentId: "a3",
    timestamp: "2026-01-01T09:00:08.000Z",
    message: {
      role: "assistant",
      content: [
        {
          type: "text",
          text: "空状態の確認に使った画面です。`docs/preview/app-icon.png` に置きました。",
        },
      ],
      model: "claude-sonnet-4-5",
      provider: "anthropic",
      timestamp: Date.parse("2026-01-01T09:00:08.000Z"),
      usage: {
        input: 4_000,
        output: 1_000,
        cacheRead: 7_000,
        cacheWrite: 0,
        totalTokens: 12_000,
      },
    },
  },
  // 失敗したターン。本文が空なので、拾わないと送信が届いていないように見える。
  // pi は自動リトライの試行ごとに書くので、同じ失敗を 3 回続けて置く（1 行に畳まれる）。
  ...[1, 2, 3].map((attempt) => {
    // 文字列連結で秒を作ると 3 回目が 09:00:010 になる。時刻を数値で進める。
    const at = Date.parse("2026-01-01T09:00:08.000Z") + attempt * 1_000;
    return {
      type: "message",
      id: `a${3 + attempt}`,
      // 画像のメッセージを本流に挟む。parentId の鎖から外れた枝は会話に出ない。
      parentId: attempt === 1 ? "a3-preview" : `a${2 + attempt}`,
      timestamp: new Date(at).toISOString(),
      message: {
        role: "assistant",
        content: [],
        model: "claude-sonnet-4-5",
        provider: "anthropic",
        stopReason: "error",
        errorMessage:
          '429: {"type":"server_error","message":"Upstream request failed: the model is at capacity; retry shortly (after 30 s)"}',
        timestamp: at,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
      },
    };
  }),
];

const sessionLines = [sessionHeader, ...sessionEntries].map((line) => JSON.stringify(line));

const outputs: Record<string, string> = {
  "w1:p1": "dev@example ~/work/acme-dashboard  feat/empty-state ❯ pi\n",
  "w1:p2": [
    "dev@example ~/work/acme-dashboard  feat/empty-state ❯ bun run dev",
    "",
    "  VITE v7.1.0  ready in 210 ms",
    "",
    "  ➜  Local:   http://localhost:{port}/",
    "  ➜  Network: use --host to expose",
    "",
  ].join("\n"),
  "w1:p3": [
    "codex · review",
    "",
    "- EmptyState の分岐は items.length === 0 で揃っています",
    "- 空のときの余白は 24px で、他のカードと一致",
    "- 追加のテストは 1 本で足ります",
    "",
  ].join("\n"),
  "w2:p1": [
    "claude · docs",
    "",
    "docs/quickstart.md の手順が古いままです。",
    "- セットアップのコマンドを bun に更新",
    "- スクリーンショットの alt を追加",
    "",
    "続けてよいか確認してください。",
    "",
  ].join("\n"),
  "w3:p1": [
    "dev@example ~/work/scratch ❯ ls",
    "notes.md  todo.md",
    "dev@example ~/work/scratch ❯",
    "",
  ].join("\n"),
};
