import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
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

// Claude の transcript は、架空の CLAUDE_CONFIG_DIR 配下の projects/<cwd のエンコード>/
// <session uuid>.jsonl に置く。プロジェクト名は内部形式なので、好きな名前でよい。
const CLAUDE_PROJECT = "-home-dev-work-acme-dashboard-docs";
// 架空の Claude の transcript の置き場。会話を後から追記する fake が同じ場所を使う。
export function claudeTranscriptPath(root: string, sessionId: string): string {
  return join(root, "claude", "projects", CLAUDE_PROJECT, `${sessionId}.jsonl`);
}

export const CLAUDE_CHAT_SESSION = "3f1c0a52-9d4e-4b8a-8c21-5e7d6f0b1a2c";
export const CLAUDE_PENDING_SESSION = "b7d2e4c1-0a95-4f3e-9c68-2d1b3a4c5e6f";
// 段階の判定に必要な版（docs/adr/claude-integration.md）。実物と同じく、すべての entry が版を持つ。
export const CLAUDE_VERSION = "2.1.328";

type ClaudeEntry = Record<string, unknown>;

// 実機の message.usage のうち、1h キャッシュの判定に使う項目だけ。
export function oneHourCache(tokens: number) {
  return {
    cache_creation_input_tokens: tokens,
    cache_read_input_tokens: 0,
    cache_creation: {
      ephemeral_1h_input_tokens: tokens,
      ephemeral_5m_input_tokens: 0,
    },
  };
}

// 1 つの API メッセージを block ごとに複数の entry へ分けて書く形を、実物に寄せて作る。
// user の文字列は本文、配列は tool_result、attachment / system は parentUuid を辿るためだけに通す。
function claudeEntries(
  build: (add: {
    user: (content: unknown, extra?: ClaudeEntry) => void;
    assistant: (messageId: string, blocks: unknown[], extra?: ClaudeEntry) => void;
    // uuid を持たない api-request の行。parentUuid は直前の entry のまま。
    request: (id: string, at: string) => void;
    other: (entry: ClaudeEntry) => void;
  }) => void,
): ClaudeEntry[] {
  const started = Date.parse("2026-01-01T10:00:00.000Z");
  const entries: ClaudeEntry[] = [];
  let parentUuid: string | null = null;
  let count = 0;

  const next = () => {
    count += 1;
    return {
      uuid: `claude-${count}`,
      parentUuid,
      timestamp: new Date(started + count * 1_000).toISOString(),
      version: CLAUDE_VERSION,
      isSidechain: false,
    };
  };

  const push = (entry: ClaudeEntry) => {
    entries.push(entry);
    parentUuid = typeof entry.uuid === "string" ? entry.uuid : parentUuid;
  };

  build({
    user(content, extra = {}) {
      push({ ...next(), type: "user", message: { role: "user", content }, ...extra });
    },
    assistant(messageId, blocks, extra = {}) {
      push({
        ...next(),
        type: "assistant",
        message: { id: messageId, role: "assistant", model: "claude-sonnet-5-5", content: blocks },
        perTurnEffort: "xhigh",
        ...extra,
      });
    },
    request(id, at) {
      push({
        type: "api-request",
        id,
        querySource: "repl_main_thread",
        timestamp: at,
        version: CLAUDE_VERSION,
      });
    },
    other(entry) {
      push({ ...next(), ...entry });
    },
  });
  return entries;
}

function claudeChatTranscript(): ClaudeEntry[] {
  return claudeEntries(({ user, assistant, request, other }) => {
    // 500 件の上限を超える長い履歴。先頭が truncated になり、末尾だけが Web に出る。
    for (let index = 1; index <= 248; index += 1) {
      user(`確認 ${index} の結果をまとめてください。`);
      assistant(`msg-history-${index}`, [
        { type: "text", text: `確認 ${index} は問題ありませんでした。` },
      ]);
    }

    user("クイックスタートの手順を、今のコマンドに合わせて見直してください。");
    assistant("msg-review-1", [{ type: "thinking", thinking: "手順の差分を確認しています。" }]);
    assistant("msg-review-1", [
      {
        type: "text",
        text: "見直す点は 2 つです。\n\n- セットアップのコマンドが古い\n- スクリーンショットの alt が空",
      },
    ]);
    assistant("msg-review-1", [
      { type: "tool_use", id: "tool-1", name: "Read", input: { file_path: "docs/quickstart.md" } },
    ]);
    // tool_result だけの user はメッセージにしない。
    user([{ type: "tool_result", tool_use_id: "tool-1", content: "# Quickstart" }]);
    other({ type: "attachment", attachment: { type: "environment", content: "internal" } });
    // isMeta の user は会話にしない。
    user("画面に出さない記録", { isMeta: true });
    other({ type: "system", subtype: "turn_duration", durationMs: 1200 });
    // 同じ message.id の text をファイル順に連結する。間の tool_result は行にしない。
    assistant("msg-review-2", [{ type: "text", text: "まず `bun install` を実行してください。" }]);
    assistant("msg-review-2", [
      { type: "tool_use", id: "tool-2", name: "Read", input: { file_path: "README.md" } },
    ]);
    user([{ type: "tool_result", tool_use_id: "tool-2", content: "# acme-dashboard" }]);
    assistant("msg-review-2", [
      { type: "text", text: "\n\nそのあと `bun run dev` で起動します。" },
    ]);
    // TUI のダイアログで答えた質問。tool_result が答えを持ち、hwc は質問と回答に合成する。
    assistant("msg-review-ask", [
      {
        type: "tool_use",
        id: "ask-tool-1",
        name: "AskUserQuestion",
        input: {
          questions: [
            {
              question: "どちらから直しますか？",
              header: "順序",
              multiSelect: false,
              options: [
                { label: "セットアップ", description: "手順の目的を先に出す" },
                { label: "スクリーンショット", description: "alt を足す" },
              ],
            },
          ],
        },
      },
    ]);
    user(
      [
        {
          type: "tool_result",
          tool_use_id: "ask-tool-1",
          content: 'Your questions have been answered: "どちらから直しますか？"="セットアップ".',
        },
      ],
      {
        toolUseResult: {
          questions: [],
          answers: { "どちらから直しますか？": "セットアップ" },
          annotations: {},
        },
      },
    );
    // 実機と同じく、貼り付けた入力は Claude Code が `<pasted_content>` で包んで書く。
    // hwc はこの包みを外し、中の添付の注記を名前のチップにする（docs/adr/claude-integration.md）。
    user(
      [
        "",
        '<pasted_content id="a0e1">',
        "その 2 点でお願いします。",
        "",
        "<attached_files>",
        "- /tmp/hwc-e2e/attachments/w2:p2/quickstart-review.pdf",
        "</attached_files>",
        '</pasted_content id="a0e1">',
        "",
      ].join("\n"),
    );
    // 名前を取り出せない注記は、ブロックごと落として本文だけを残す。
    user(
      [
        "この行は注記の書式が崩れています。",
        "",
        "<attached_files>",
        "- /home/dev/private/.env",
        "</attached_files>",
      ].join("\n"),
    );
    assistant("msg-review-3", [
      { type: "text", text: "2 点を反映しました。手順の差分は次のとおりです。" },
    ]);
    // 1h キャッシュの残り時間を確かめるための、直近の完了応答（[E2E](../e2e.md)）。
    // 要求は 5 分前に送った形にして、開いたときにおよそ 55 分から始まるようにする。
    request("api-quickstart-cache", new Date(Date.now() - 5 * 60_000).toISOString());
    assistant("msg-review-4", [{ type: "text", text: "キャッシュの残り時間を確認しました。" }], {
      requestRef: "api-quickstart-cache",
      timestamp: new Date().toISOString(),
      message: {
        id: "msg-review-4",
        role: "assistant",
        model: "claude-sonnet-5-5",
        content: [{ type: "text", text: "キャッシュの残り時間を確認しました。" }],
        stop_reason: "end_turn",
        usage: oneHourCache(24_000),
      },
    });
  });
}

// blocked のままのペイン。実機の Claude Code は、質問の待ちの間は assistant の tool_use を
// transcript に書かず、閉じたときに tool_result と一緒に書く。待ちは hook の sidecar が教える
// ので、transcript は待ちに入る前の会話で終わらせ、質問は claudePendingSidecar に置く。
function claudePendingTranscript(): ClaudeEntry[] {
  return claudeEntries(({ user, assistant }) => {
    user("docs/quickstart.md の手順を確認してください。");
    assistant("msg-pending-1", [{ type: "text", text: "見出しと直す範囲を選んでください。" }]);
    // 解決済みの tool_use はカードにしない。
    assistant("msg-pending-1", [
      {
        type: "tool_use",
        id: "pending-tool-1",
        name: "Read",
        input: { file_path: "docs/quickstart.md" },
      },
    ]);
    user([{ type: "tool_result", tool_use_id: "pending-tool-1", content: "# Quickstart" }]);
  });
}

// hook が Claude の状態ディレクトリ配下へ書く、応答待ちの 1 件（docs/adr/claude-integration.md）。
function claudePendingSidecar(): Record<string, unknown> {
  return {
    v: 1,
    sessionId: CLAUDE_PENDING_SESSION,
    at: Date.now(),
    toolUseId: "pending-tool-2",
    tool: "AskUserQuestion",
    pending: {
      kind: "question",
      toolUseId: "pending-tool-2",
      tool: "AskUserQuestion",
      questions: [
        {
          question: "見出しはどれにしますか？",
          header: "見出し",
          multiSelect: false,
          options: [
            { label: "クイックスタート", description: "今の見出しを残す" },
            { label: "セットアップ", description: "手順の目的を先に出す" },
          ],
        },
        {
          question: "直す範囲は？",
          header: "範囲",
          multiSelect: true,
          options: [
            { label: "コマンド", description: "bun に揃える" },
            { label: "スクリーンショット", description: "alt を足す" },
          ],
        },
      ],
    },
  };
}

async function writeClaudePendingSidecar(root: string) {
  const directory = join(root, "claude", "pending");
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, `${CLAUDE_PENDING_SESSION}.json`),
    JSON.stringify(claudePendingSidecar()),
  );
}

// mod がターンの終わりに書く、速度とコンテキスト使用量（docs/adr/claude-integration.md）。速度は持たない。
function claudeLive(): Record<string, unknown> {
  return {
    v: 1,
    sessionId: CLAUDE_CHAT_SESSION,
    at: Date.now(),
    tokPerSecond: null,
    context: { tokens: 122_600, window: 1_000_000 },
  };
}

async function writeClaudeLive(root: string) {
  const directory = join(root, "claude", "live");
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, `${CLAUDE_CHAT_SESSION}.json`), JSON.stringify(claudeLive()));
}

async function writeClaudeTranscript(root: string, sessionId: string, entries: ClaudeEntry[]) {
  const path = claudeTranscriptPath(root, sessionId);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, entries.map((entry) => `${JSON.stringify(entry)}\n`).join(""));
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

// モデルを指定せずに pi を起動したときの既定。架空 Herdr の agent.start と、
// 既定モデルを遅延して読む架空 pi の get_state で同じ値を使う。
export const DEFAULT_PI_MODEL = STARTUP_MODELS[0]!;
export const DEFAULT_PI_EFFORT = "high";

// 実在のユーザー名・リポジトリ名・パスを fixture に写さない。E2E のスクリーンショットは
// ここで作ったデータだけを見せる。
// 設定画面に出すグローバルスキル。実ホームを読まないよう HWC_SKILLS_HOME をこのホームへ向け、
// CLI 自身の設定ディレクトリ（PI_CODING_AGENT_DIR / CLAUDE_CONFIG_DIR / CODEX_HOME）にも置く。
export async function writeSkillHome(root: string): Promise<void> {
  const home = join(root, "home");
  // description が null なら frontmatter に書かない（Claude は無くても読み込む）。
  const skill = async (dir: string, name: string, description: string | null = "説明") => {
    await mkdir(dir, { recursive: true });
    const described = description === null ? "" : `description: ${description}\n`;
    await writeFile(join(dir, "SKILL.md"), `---\nname: ${name}\n${described}---\n`);
  };
  // 3 行で畳まれる長さの説明。YAML の折り返し（>-）で書き、複数行の読み取りも通す。
  const longDescription =
    ">-\n  PR またはローカルの差分を読み、正しさと設計の観点から指摘を返す。\n" +
    "  指摘には根拠となる行を添え、直す前に影響範囲を確認する。\n" +
    "  レビュー後は修正案を示し、確認が取れるまで変更を加えない。";
  // manifest.json はバンドルのディレクトリができてから書く。並べて書くと先に走って落ちる。
  await mkdir(join(root, "claude/skills/synced/demo"), { recursive: true });
  await mkdir(join(root, "codex"), { recursive: true });
  await Promise.all([
    skill(join(home, ".agents/skills/review"), "review", longDescription),
    skill(join(home, ".agents/skills/gh"), "gh", "GitHub を操作する。"),
    skill(join(root, "agent/skills/imagegen"), "imagegen", "画像を作る。"),
    skill(join(root, "claude/skills/review"), "review", null),
    // 同期されたスキルは manifest.json を持つバンドルとして置き、設定側で無効にする。
    skill(join(root, "claude/skills/synced/demo/xlsx"), "xlsx", "表計算を扱う。"),
    writeFile(
      join(root, "claude/skills/synced/demo/manifest.json"),
      JSON.stringify({ lastUpdated: 0, skills: [] }),
    ),
    writeFile(
      join(root, "claude/settings.local.json"),
      JSON.stringify({ skillOverrides: { "anthropic-skills:xlsx": "off" } }),
    ),
    writeFile(join(root, "codex/config.toml"), '[[skills.config]]\nname = "gh"\nenabled = false\n'),
  ]);
}

export async function createScenario(root: string): Promise<Scenario> {
  const dashboard = join(root, "work", "acme-dashboard");
  const docs = join(root, "work", "acme-dashboard-docs");
  // 別スペースの同名ペイン（review / shell）を並べるためのワークツリー。w2 とは別に置く。
  const checks = join(root, "work", "acme-dashboard-checks");
  const scratch = join(root, "work", "scratch");
  const plain = join(root, "work", "plain-checkout");
  const sandbox = join(root, "work", "sandbox");
  const agentDir = join(root, "agent");
  const sessionPath = join(agentDir, "sessions", "demo", "session.jsonl");
  const emptySessionPath = join(agentDir, "sessions", "empty", "session.jsonl");

  await Promise.all([
    writeBranch(dashboard, "feat/empty-state"),
    writeBranch(docs, "docs/quickstart"),
    // ローカル名は Herdr の自動生成名のままで、push 先だけ "feat/checks"。PR はローカル名
    // では引けないので、upstream の head 名で引くことをここで確かめる（docs/adr/git-github.md）。
    writeBranch(checks, "worktree/review-checks"),
    writeBranch(plain, "feat/plain"),
    mkdir(scratch, { recursive: true }),
    mkdir(sandbox, { recursive: true }),
    mkdir(join(agentDir, "sessions", "demo"), { recursive: true }),
    mkdir(join(agentDir, "sessions", "empty"), { recursive: true }),
    mkdir(join(root, "bin"), { recursive: true }),
  ]);

  // エージェントが書いた画像のプレビュー。チェックアウトの内側に置いた実在の PNG だけが出る。
  // 裸パスは末尾の一覧、画像記法は本文の位置に出る。隣り合う画像記法は 1 行に並ぶ。
  await mkdir(join(dashboard, "docs", "preview"), { recursive: true });
  await Promise.all(
    ["app-icon.png", "empty-state.png", "empty-state-light.png"].map((name) =>
      copyFile(
        fileURLToPath(new URL("../../src/client/assets/apple-touch-icon.png", import.meta.url)),
        join(dashboard, "docs", "preview", name),
      ),
    ),
  );
  // HTML のプレビュー。css と js を相対参照しているので、配信の根とパス形式も通る。
  await Promise.all(
    ["mock.html", "mock.css", "mock.js"].map((name) =>
      copyFile(
        fileURLToPath(new URL(`./preview/${name}`, import.meta.url)),
        join(dashboard, "docs", "preview", name),
      ),
    ),
  );
  // 本文のリンクから開くテキスト。リンクと原文（literal）の違いを並べて見せる。
  await writeFile(
    join(dashboard, "docs", "notes.md"),
    "# 空状態の設計メモ\n\n見出しと本文の間隔は 24px にそろえる。\n",
  );

  // ファイルツリー。ドットファイルと開けないファイルも名前だけ出ることを確かめる。
  // .git はチェックアウトの外に見える構造ではないので、ツリーには出ない。
  await mkdir(join(dashboard, "src"), { recursive: true });
  await mkdir(join(dashboard, "bin"), { recursive: true });
  await Promise.all([
    // Markdown のツリーからのプレビュー。見出し・リスト・コード・表・画像・相対リンクを
    // 1 ファイルに並べ、レンダリングとソース表示の両方を確かめられるようにする。
    writeFile(
      join(dashboard, "README.md"),
      [
        "# acme-dashboard",
        "",
        "空状態の画面を確認するためのチェックアウトです。",
        "",
        "## 開発",
        "",
        "- `bun install`",
        "- `bun run dev`",
        "- [x] 空状態の余白を 24px に揃える",
        "",
        "```ts",
        "const ready = true;",
        "```",
        "",
        "| 画面 | 状態 |",
        "| --- | --- |",
        "| 一覧 | 空 |",
        "| 詳細 | 読み込み中 |",
        "",
        // 識別子が折り返せず、表の最小幅が約 800px になる。プレビューの本文幅がそれを下回る
        // （ビューポート 1280px で 636px）と横スクロールになる、確認用の表。
        "| JSON path | live（`~/.config/demo/settings.json`） | リポ（`config/settings.json`） | 管理状態 |",
        "| --- | --- | --- | --- |",
        '| `theme` | `"dark"` | `"dark"` | ✅ 管理（一致） |',
        "| `statusLine.refreshInterval` | `1` | `1` | ✅ 管理（一致） |",
        "| `hooks.SessionStart[0]` | `matcher: ^(startup\\|resume\\|clear\\|compact\\|fork)$` → `demo-agent-state.sh session`（timeout 10） | なし | 🟡 外部所有（意図的にリポ外） |",
        '| `permissions.defaultMode` | `"auto"` | なし | ❌ 未管理 |',
        "",
        "![app icon](docs/preview/app-icon.png)",
        "",
        "設計メモは [notes](docs/notes.md) にあります。",
        "",
      ].join("\n"),
    ),
    writeFile(join(dashboard, "package.json"), '{ "name": "acme-dashboard" }\n'),
    writeFile(join(dashboard, ".gitignore"), "node_modules\n"),
    writeFile(join(dashboard, "bun.lock"), "lockfile\n"),
    // 拡張子で決まる YAML と、拡張子の無いスクリプトの shebang。どちらも色が付く。
    writeFile(
      join(dashboard, "docs", "ci.yml"),
      [
        "name: checks",
        "on: push",
        "jobs:",
        "  test:",
        "    runs-on: ubuntu-latest",
        "    steps:",
        "      - run: bun test",
        "      - name: Lint",
        "        run: |",
        "          bun run lint",
        "          bun run fmt:check",
        "        env:",
        "          CI: true",
        "",
      ].join("\n"),
    ),
    writeFile(
      join(dashboard, "bin", "deploy"),
      '#!/usr/bin/env bash\nset -euo pipefail\necho "deploying"\n',
      { mode: 0o700 },
    ),
    writeFile(join(dashboard, "src", "main.ts"), "export const ready = true;\n"),
  ]);

  // .gitignore が無視するフォルダ。ツリーでは出したまま淡色にし、開く道も残す。
  // 上の Promise.all は並行に走るので、親のフォルダはここで作ってから書く。
  await mkdir(join(dashboard, "node_modules", "demo"), { recursive: true });
  await writeFile(
    join(dashboard, "node_modules", "demo", "package.json"),
    '{ "name": "demo", "version": "1.0.0" }\n',
  );

  await writeSkillHome(root);

  // 添付チップは保存済みファイルの実バイト数を出す。会話の注記は basename しか使わないが、
  // 大きさを出すために実ファイルを状態ディレクトリへ置く。
  const attachmentDir = join(root, "attachments", "w1:p1");
  await mkdir(attachmentDir, { recursive: true });
  // Claude の会話に出す添付チップ。名前と大きさだけを出し、パスは本文に残さない。
  const claudeAttachmentDir = join(root, "attachments", "w2:p2");
  await mkdir(claudeAttachmentDir, { recursive: true });

  await Promise.all([
    writeFile(join(claudeAttachmentDir, "quickstart-review.pdf"), Buffer.alloc(12 * 1024)),
    writeClaudeTranscript(root, CLAUDE_CHAT_SESSION, claudeChatTranscript()),
    writeClaudeTranscript(root, CLAUDE_PENDING_SESSION, claudePendingTranscript()),
    writeClaudePendingSidecar(root),
    writeClaudeLive(root),
    writeFile(join(attachmentDir, "empty-state-reference.zip"), Buffer.alloc(2 * 1024 * 1024)),
    writeFile(join(agentDir, "models-store.json"), JSON.stringify(modelStore)),
    writeFile(sessionPath, sessionLines.map((line) => `${line}\n`).join("")),
    writeFile(emptySessionPath, `${JSON.stringify(emptySessionHeader)}\n`),
    writeCodexThread(root, "thread_demo", "beam-small", [
      {
        id: "turn_older",
        startedAt: 1767257900,
        items: [
          {
            type: "userMessage",
            id: "u0",
            content: [{ type: "text", text: "前回のレビューで確認した点です。" }],
          },
          {
            type: "agentMessage",
            id: "a0",
            text: "前回の指摘は反映されています。",
          },
        ],
      },
      {
        id: "turn_compaction",
        startedAt: 1767257950,
        items: [
          {
            type: "contextCompaction",
            id: "c1",
            startedAtMs: 1767257950000,
            completedAtMs: 1767257952000,
          },
        ],
      },
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
      join(root, "bin", "claude"),
      `#!/bin/sh\nexec "${process.execPath}" "${fileURLToPath(new URL("../fake-claude.ts", import.meta.url))}" "$@"\n`,
      { mode: 0o700 },
    ),
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
      join(root, "bin", "opencode"),
      `#!/bin/sh\nexec "${process.execPath}" "${fileURLToPath(new URL("../fake-opencode-cli.ts", import.meta.url))}" "$@"\n`,
      { mode: 0o700 },
    ),
    writeFile(
      join(root, "bin", "gh"),
      `#!/bin/sh\nexec "${process.execPath}" "${fileURLToPath(new URL("../fake-gh.ts", import.meta.url))}" "$@"\n`,
      { mode: 0o700 },
    ),
    writeFile(
      join(root, "bin", "git"),
      `#!/bin/sh\nexec "${process.execPath}" "${fileURLToPath(new URL("../fake-git.ts", import.meta.url))}" "$@"\n`,
      { mode: 0o700 },
    ),
    writeFile(
      join(root, "git-state.json"),
      JSON.stringify({
        [dashboard]: {
          upstream: "origin/feat/empty-state",
          ahead: 1,
          behind: 2,
          hasRemote: true,
          remoteUrl: "https://github.com/example/acme-dashboard.git",
          // .gitignore の `node_modules` に当たる項目。ツリーでは淡色で出る。
          ignored: ["node_modules"],
        },
        [docs]: {
          upstream: "origin/docs/quickstart",
          ahead: 0,
          behind: 1,
          hasRemote: true,
          remoteUrl: "https://github.com/example/acme-dashboard.git",
        },
        [checks]: {
          upstream: "origin/feat/checks",
          ahead: 2,
          behind: 0,
          hasRemote: true,
          remoteUrl: "https://github.com/example/acme-dashboard.git",
        },
        [plain]: {
          upstream: null,
          ahead: 0,
          behind: 0,
          hasRemote: false,
        },
      }),
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
      // 別スペースの同名ペイン。同一スペース内の同名（w1 の review / shell）と並べても、
      // タブの 2 段目とセル見出しのスペース名で区別できることを確かめる。
      {
        workspace_id: "w4",
        label: "acme-dashboard (checks)",
        agent_status: "idle",
        focused: false,
        worktree: {
          repo_name: "acme-dashboard",
          repo_root: dashboard,
          checkout_path: checks,
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
      // Herdr には worktree として登録されていないが、チェックアウトは git 管理下。
      // BFF が git から種別を補い、リポジトリのアイコンになることを確かめる。
      {
        workspace_id: "w5",
        label: "plain-checkout",
        agent_status: "idle",
        focused: false,
        worktree: null,
      },
      // 同じ場所を指す Herdr ネイティブのスペース。片方は誤って開いた重複として、
      // 一覧では 1 つの場所に束ねる。
      {
        workspace_id: "w6",
        label: "sandbox",
        agent_status: "idle",
        focused: false,
        worktree: null,
      },
      {
        workspace_id: "w7",
        label: "sandbox",
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
      // 会話を表示する idle の Claude。`w2:t1` に足すと分割セルになり、読み幅が半分になる。
      {
        tab_id: "w2:t2",
        workspace_id: "w2",
        label: "quickstart",
        agent_status: "idle",
        focused: false,
      },
      {
        tab_id: "w4:t1",
        workspace_id: "w4",
        label: "review",
        agent_status: "idle",
        focused: false,
      },
      {
        tab_id: "w3:t1",
        workspace_id: "w3",
        label: "notes",
        agent_status: "idle",
        focused: false,
      },
      {
        tab_id: "w5:t1",
        workspace_id: "w5",
        label: "main",
        agent_status: "idle",
        focused: false,
      },
      // ラベルの無いエージェントのペイン。端末タイトルはスペース名と同じになり、
      // タブ・セル見出し・一覧が名前ではなくエージェント名で揃うことを確かめる。
      {
        tab_id: "w5:t2",
        workspace_id: "w5",
        label: "worker",
        agent_status: "idle",
        focused: false,
      },
      {
        tab_id: "w6:t1",
        workspace_id: "w6",
        label: "1",
        agent_status: "idle",
        focused: false,
      },
      {
        tab_id: "w7:t1",
        workspace_id: "w7",
        label: "1",
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
      // アクティブ一覧の束と、既読で完了から待機に変わる行を確かめるための done。
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
        // blocked のまま、応答待ち（AskUserQuestion）の transcript を持つ。会話のままカードを
        // 出し、端末出力へはカードの切替で移る。
        agent_status: "blocked",
        focused: false,
        agent_session: {
          agent: "claude",
          source: "herdr:claude",
          kind: "id",
          value: CLAUDE_PENDING_SESSION,
        },
      },
      {
        pane_id: "w2:p2",
        workspace_id: "w2",
        tab_id: "w2:t2",
        cwd: docs,
        label: "quickstart",
        agent_status: "idle",
        focused: false,
        agent_session: {
          agent: "claude",
          source: "herdr:claude",
          kind: "id",
          value: CLAUDE_CHAT_SESSION,
        },
      },
      // 別スペースの review と shell。w1 の review / shell と同じ名前で、スペースが違う。
      {
        pane_id: "w4:p1",
        workspace_id: "w4",
        tab_id: "w4:t1",
        cwd: checks,
        label: "review",
        agent_status: "idle",
        focused: false,
        agent_session: { agent: "codex", source: "herdr:codex", kind: "id", value: "thread_demo" },
      },
      {
        pane_id: "w4:p2",
        workspace_id: "w4",
        tab_id: "w4:t1",
        cwd: checks,
        label: "shell",
        agent_status: "unknown",
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
      {
        pane_id: "w5:p1",
        workspace_id: "w5",
        tab_id: "w5:t1",
        cwd: plain,
        label: "shell",
        agent_status: "unknown",
        focused: false,
        agent_session: null,
      },
      {
        pane_id: "w5:p2",
        workspace_id: "w5",
        tab_id: "w5:t2",
        cwd: plain,
        label: null,
        agent_status: "idle",
        focused: false,
        agent_session: null,
      },
      {
        pane_id: "w6:p1",
        workspace_id: "w6",
        tab_id: "w6:t1",
        cwd: sandbox,
        label: null,
        agent_status: "unknown",
        focused: false,
        agent_session: null,
      },
      {
        pane_id: "w7:p1",
        workspace_id: "w7",
        tab_id: "w7:t1",
        cwd: sandbox,
        label: null,
        agent_status: "unknown",
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
      {
        pane_id: "w2:p2",
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
        pane_id: "w4:p1",
        workspace_id: "w4",
        cwd: checks,
        agent: "codex",
        terminal_title_stripped: "checks",
      },
      {
        pane_id: "w5:p2",
        workspace_id: "w5",
        cwd: plain,
        agent: "pi",
        terminal_title_stripped: "plain-checkout",
      },
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
      // 入力を受け付けるペインには画面がある。空の検出フレームは、再描画中かもしれない
      // ため folder-trust が入力欄を閉じる（docs/adr/pi-integration.md）。
      "w1:p4": "› Ask pi to do anything\n",
      "w1:p5": "$ echo done\ndone\n$",
      "w3:p2": FOLDER_TRUST_SCREEN,
      "w3:p3": FOLDER_TRUST_SCREEN,
      "w3:p4": "› Ask Codex to do anything\n",
      "w3:p5": PI_TRUST_SCREEN,
      "w5:p1": "$ git status\nOn branch feat/plain\nnothing to commit\n$",
      "w5:p2": "› Ask pi to do anything\n",
      "w6:p1": "$ ",
      "w7:p1": "$ ",
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
      content:
        "その方針でお願いします。テストも 1 本足してください。\n\n<attached_files>\n- /tmp/hwc-e2e/attachments/w1:p1/empty-state-reference.zip\n</attached_files>",
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
          text: "空状態の確認に使った画面です。`docs/preview/app-icon.png` に置きました。\n\n![空状態のモック](docs/preview/empty-state.png)\n\n![空状態のモック（ライト）](docs/preview/empty-state-light.png)",
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
  // エージェントが書いた HTML。押すとプレビューのタブが開く。
  {
    type: "message",
    id: "a7-preview",
    parentId: "a6",
    timestamp: "2026-01-01T09:00:12.000Z",
    message: {
      role: "assistant",
      content: [
        {
          type: "text",
          text: "空状態のモックを HTML で作りました。[モック](docs/preview/mock.html) で確認できます。\n\n設計メモは [notes.md](docs/notes.md)、スクショは [app-icon.png](docs/preview/app-icon.png) にあります。\n\n同じパスを裸で書いた docs/notes.md は押せません。",
        },
      ],
      model: "claude-sonnet-4-5",
      provider: "anthropic",
      timestamp: Date.parse("2026-01-01T09:00:12.000Z"),
      usage: {
        input: 4_000,
        output: 2_000,
        cacheRead: 8_000,
        cacheWrite: 0,
        totalTokens: 14_000,
      },
    },
  },
  // 編集の E2E 用に、添付の無い古い user 発言を 1 つ置く。
  {
    type: "message",
    id: "u3",
    parentId: "a7-preview",
    timestamp: "2026-01-01T09:00:13.000Z",
    message: {
      role: "user",
      content: "編集の動作を確認します。",
      timestamp: Date.parse("2026-01-01T09:00:13.000Z"),
    },
  },
  {
    type: "message",
    id: "a8",
    parentId: "u3",
    timestamp: "2026-01-01T09:00:14.000Z",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "わかりました。編集の確認をします。" }],
      model: "claude-sonnet-4-5",
      provider: "anthropic",
      timestamp: Date.parse("2026-01-01T09:00:14.000Z"),
    },
  },
  // hwc の編集 capability。mypi の拡張がセッション開始時に 1 回だけ追記する形を模す。
  {
    type: "custom",
    id: "cap-1",
    parentId: "a8",
    timestamp: "2026-01-01T09:00:15.000Z",
    customType: "hwc-capabilities",
    data: { v: 1, rewind: true },
  },
];

const sessionLines = [sessionHeader, ...sessionEntries].map((line) => JSON.stringify(line));

const outputs: Record<string, string> = {
  "w1:p1": "dev@example ~/work/acme-dashboard  feat/empty-state ❯ pi\n",
  "w1:p2": [
    "dev@example ~/work/acme-dashboard  feat/empty-state ❯ bun run dev",
    "",
    "\u001b[36m  VITE v7.1.0\u001b[0m  ready in 210 ms",
    "",
    "\u001b[38;2;222;224;225m  truecolor #dee0e1\u001b[0m  follows the theme",
    "",
    "  \u001b[32m➜\u001b[0m  \u001b[1mLocal:\u001b[0m   \u001b[34mhttp://localhost:{port}/\u001b[0m",
    "  \u001b[32m➜\u001b[0m  \u001b[1mNetwork:\u001b[0m use --host to expose",
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
  // transcript を消したときに、端末出力へ戻ったことを見分ける画面。
  "w2:p2": [
    "claude · quickstart",
    "",
    "docs/quickstart.md の手順を確認しました。",
    "- セットアップのコマンドが古い",
    "- スクリーンショットの alt が空",
    "",
    "› ",
  ].join("\n"),
  "w4:p1": [
    "codex · review",
    "",
    "- チェックアウトの別スペースでも空状態は同じです",
    "- 余白とテストは feat/empty-state の変更と揃っています",
    "",
  ].join("\n"),
  "w4:p2": ["dev@example ~/work/acme-dashboard-checks  worktree/review-checks ❯", ""].join("\n"),
  "w3:p1": [
    "dev@example ~/work/scratch ❯ ls",
    "notes.md  todo.md",
    "dev@example ~/work/scratch ❯",
    "",
  ].join("\n"),
};
