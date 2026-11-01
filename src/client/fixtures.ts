import type { AppState } from "../server/herdr/state";
import type { ChatMessage } from "./chat";

// 配線前のプレビュー用。API の形（AppState）に合わせてあるので、実データに差し替えるだけで動く。
export const previewState: AppState = {
  focusedWorkspaceId: "w80",
  focusedTabId: "w80:t1",
  focusedPaneId: "w80:p2",
  workspaces: [
    {
      id: "w80",
      label: "hwc",
      agentStatus: "working",
      focused: true,
      // hwc の本体チェックアウト。
      worktree: {
        repoName: "hwc",
        repoRoot: "/home/dev/workspaces/hwc",
        checkoutPath: "/home/dev/workspaces/hwc",
        isLinkedWorktree: false,
      },
      tabs: [
        {
          id: "w80:t1",
          label: "clear-harbor-afa2",
          agentStatus: "working",
          focused: true,
          panes: [
            {
              id: "w80:p2",
              title: "π - hwc",
              agent: "pi",
              agentStatus: "working",
              focused: true,
            },
            { id: "w80:p9", title: "π - hwc", agent: "pi", agentStatus: "idle", focused: false },
            { id: "w80:p3", title: "bash", agent: null, agentStatus: "unknown", focused: false },
          ],
        },
        {
          id: "w80:t2",
          label: "silver-meadow-cb6f",
          agentStatus: "idle",
          focused: false,
          panes: [
            { id: "w80:p4", title: "bash", agent: null, agentStatus: "idle", focused: false },
            {
              id: "w80:p5",
              title: "claude",
              agent: "claude",
              agentStatus: "working",
              focused: false,
            },
            { id: "w80:p6", title: "codex", agent: "codex", agentStatus: "idle", focused: false },
            {
              id: "w80:p7",
              title: "opencode",
              agent: "opencode",
              agentStatus: "idle",
              focused: false,
            },
          ],
        },
        {
          // 分割表示が 4 枚で足りなくなる並び。5 枚目はタブで選んだときに入れ替わる。
          id: "w80:t3",
          label: "cobalt-fern-5b08",
          agentStatus: "working",
          focused: false,
          panes: [
            {
              id: "w80:p10",
              title: "π - hwc",
              agent: "pi",
              agentStatus: "working",
              focused: false,
            },
            { id: "w80:p11", title: "π - hwc", agent: "pi", agentStatus: "idle", focused: false },
            { id: "w80:p12", title: "bash", agent: null, agentStatus: "idle", focused: false },
            {
              id: "w80:p13",
              title: "claude",
              agent: "claude",
              agentStatus: "idle",
              focused: false,
            },
            {
              id: "w80:p14",
              title: "codex",
              agent: "codex",
              agentStatus: "working",
              focused: false,
            },
          ],
        },
      ],
    },
    {
      id: "w81",
      label: "hwc-ui",
      agentStatus: "working",
      focused: false,
      // hwc の linked worktree。ラベルはチェックアウト先のフォルダ名になる。
      worktree: {
        repoName: "hwc",
        repoRoot: "/home/dev/workspaces/hwc",
        checkoutPath: "/home/dev/worktrees/hwc-ui",
        isLinkedWorktree: true,
      },
      tabs: [
        {
          id: "w81:t1",
          label: "quiet-pine-19a2",
          agentStatus: "working",
          focused: false,
          panes: [
            {
              id: "w81:p1",
              title: "π - hwc-ui",
              agent: "pi",
              agentStatus: "working",
              focused: false,
            },
            { id: "w81:p2", title: "bash", agent: null, agentStatus: "idle", focused: false },
          ],
        },
      ],
    },
    {
      id: "w82",
      label: "hwc-sse",
      agentStatus: "blocked",
      focused: false,
      worktree: {
        repoName: "hwc",
        repoRoot: "/home/dev/workspaces/hwc",
        checkoutPath: "/home/dev/worktrees/hwc-sse",
        isLinkedWorktree: true,
      },
      tabs: [
        {
          id: "w82:t1",
          label: "brave-otter-77f1",
          agentStatus: "blocked",
          focused: false,
          panes: [
            {
              id: "w82:p1",
              title: "claude",
              agent: "claude",
              agentStatus: "blocked",
              focused: false,
            },
            { id: "w82:p2", title: "bash", agent: null, agentStatus: "idle", focused: false },
          ],
        },
      ],
    },
    {
      id: "w92",
      label: "scratch",
      agentStatus: "idle",
      focused: false,
      // git 管理外。ワークツリーの情報は付かない。
      worktree: null,
      tabs: [
        {
          id: "w92:t1",
          label: "plain-shell-0c3d",
          agentStatus: "idle",
          focused: false,
          panes: [
            {
              id: "w92:p1",
              title: "bash",
              agent: null,
              agentStatus: "blocked",
              focused: false,
            },
          ],
        },
      ],
    },
  ],
};

const previewOutputs: Record<string, string> = {
  "w80:p2": `π レビュー待ちの指摘を反映しました。

> bun test
 88 pass
 0 fail
190 expect() calls
Ran 88 tests across 6 files. [570.00ms]

> bun run typecheck && bun run lint
$ tsc --noEmit
$ oxlint
No config found, using defaults.

  ╭──────────────────────────────────────╮
  │ feat(server): sync state over SSE    │
  │ eb6f4cf  436b98e                     │
  ╰──────────────────────────────────────╯

次は #14 の UI です。`,

  "w80:p9": `レビュー結果: PR #25（head 2463303、4 巡目）
判定: must 0 / should 0 / nit 1。LGTM 相当。

## 解消
- nit 1（Content-Type 完全一致のテスト）: 解消
- nit 2（text 上限の位置）: 解消
- nit 3（input の invalid_params 400）: 解消

## nit（残り・任意）
コメントの「ここに来るのは自前の client だけ」は LAN の
非ブラウザ client も含む。`,

  "w80:p3": `u7dev@wsl:~/workspace/hwc$ git log --oneline -3
a3350e0 feat(server): add pane output and input endpoints
eb6f4cf feat(server): sync herdr state and stream it over SSE
436b98e feat(herdr): add socket client for requests and subscriptions
u7dev@wsl:~/workspace/hwc$ `,

  "w80:p4": `[tick] 11:16:08
[tick] 11:16:11
[tick] 11:16:14
[tick] 11:16:17
[tick] 11:16:20
[tick] 11:16:23
[tick] 11:16:26
[tick] 11:16:29
[tick] 11:16:32
[tick] 11:16:35
[tick] 11:16:38
[tick] 11:16:41
[tick] 11:16:44
[tick] 11:16:47
[tick] 11:16:50
[tick] 11:16:53
[tick] 11:16:56
[tick] 11:16:59
`,

  "w80:p12": `u7dev@wsl:~/workspace/hwc$ git status --short
 M src/client/App.tsx
 M src/client/PaneDetail.tsx
?? src/client/TabBar.tsx
u7dev@wsl:~/workspace/hwc$ `,

  "w92:p1": `❯ echo HWC_API_OK
HWC_API_OK

❯ echo NO_SUBMIT_CHECKecho SUBMIT_CHECK
NO_SUBMIT_CHECKecho SUBMIT_CHECK

❯ `,
};

// どのモデルをどの effort で走らせているか。Herdr の snapshot には無いので、
// 配線するときはエージェントの設定から取る。いまはプレビュー用の値。
export type AgentInfo = { model: string; effort: string };

export const previewAgentInfo: Record<string, AgentInfo> = {
  "w80:p2": { model: "claude-opus-4-6", effort: "high" },
  "w80:p9": { model: "claude-opus-4-6", effort: "high" },
  "w80:p5": { model: "claude-sonnet-4-5", effort: "medium" },
  "w80:p6": { model: "gpt-5-codex", effort: "low" },
  "w80:p7": { model: "qwen3-coder", effort: "medium" },
  "w80:p10": { model: "claude-opus-4-6", effort: "high" },
  "w80:p11": { model: "claude-opus-4-6", effort: "high" },
  "w80:p13": { model: "claude-sonnet-4-5", effort: "medium" },
  "w80:p14": { model: "gpt-5-codex", effort: "low" },
  "w81:p1": { model: "claude-opus-4-6", effort: "high" },
};

export function previewChat(paneId: string): ChatMessage[] | null {
  return previewChats[paneId] ?? null;
}

export function previewOutput(paneId: string): string {
  return previewOutputs[paneId] ?? "";
}

// 会話の見え方を確かめるためのプレビュー。返答は本物のエージェントではない。
export const previewChats: Record<string, ChatMessage[]> = {
  "w80:p2": [
    {
      id: "c1",
      role: "user",
      text: "一覧の並びを、ワークツリーごとにまとめたい。まずは構造を見せて。",
      at: new Date(2026, 10, 1, 9, 12).getTime(),
    },
    {
      id: "c2",
      role: "agent",
      text: `いまの構造はこうなっています。

hwc                     3 ワークツリー
  clear-harbor-afa2     3 ペイン
  silver-meadow-cb6f    4 ペイン
  hwc-ui                hwc · 2 ペイン
  hwc-sse               hwc · 2 ペイン

本体のチェックアウトを親にして、linked worktree を子に置くと、同じリポジトリの
作業が 1 か所にまとまります。`,
      at: new Date(2026, 10, 1, 9, 12, 40).getTime(),
    },
    {
      id: "c3",
      role: "user",
      text: "いいね。親がペインを持っている場合も崩れない？",
      at: new Date(2026, 10, 1, 9, 14).getTime(),
    },
    {
      id: "c4",
      role: "agent",
      text: `崩れません。親の行の下に、そのままタブとペインが並びます。

  親 hwc
    └ タブ / ペイン（1 枚持ちでも同じ形）
    └ 子 hwc-ui
        └ タブ / ペイン

束ねるのは worktree が 2 つ以上あるときだけにして、単独なら今までどおり
1 ブロックのままにします。`,
      at: new Date(2026, 10, 1, 9, 15, 10).getTime(),
    },
  ],
  "w80:p5": [
    {
      id: "d1",
      role: "user",
      text: "この関数、テストが通らないんだけど見てくれる？",
      at: new Date(2026, 10, 1, 10, 2).getTime(),
    },
    {
      id: "d2",
      role: "agent",
      text: `見ました。原因は 2 つあります。

1. 空の配列を渡したときに 0 除算になる
2. 期待値が古い（合計を返すよう変えたのに、平均のまま）

1 は先に直します。2 はテスト側の更新で足ります。`,
      at: new Date(2026, 10, 1, 10, 3, 20).getTime(),
    },
  ],
  "w80:p10": [
    {
      id: "e1",
      role: "user",
      text: "分割表示の並び、4 枚まででいい？",
      at: new Date(2026, 10, 1, 11, 20).getTime(),
    },
    {
      id: "e2",
      role: "agent",
      text: `4 枚までで足ります。2x2 を上限にして、それ以上はタブで切り替える形にします。

- 2 枚: 左右
- 3 枚: 左に 1 枚、右に 2 枚を上下
- 4 枚: 2x2

区切りは 1px の線で、セルの隙間から見せます。`,
      at: new Date(2026, 10, 1, 11, 21).getTime(),
    },
    {
      id: "e3",
      role: "user",
      text: "3 枚のときの並べ方は、左がメインで右が上下ね。",
      at: new Date(2026, 10, 1, 11, 22, 10).getTime(),
    },
    {
      id: "e4",
      role: "agent",
      text: `その形にしました。左のセルは行を 2 つぶん使い、右は上下に分けます。

セルごとに入力欄を持つので、どのペインにもそのまま送れます。`,
      at: new Date(2026, 10, 1, 11, 23).getTime(),
    },
    {
      id: "e5",
      role: "user",
      text: "5 枚目以降はどうなる？",
      at: new Date(2026, 10, 1, 11, 25).getTime(),
    },
    {
      id: "e6",
      role: "agent",
      text: `枠は 4 つです。5 枚目以降はタブで選んだときに、最後の枠と入れ替えて表示します。

選んだペインが必ず見えるので、一覧から開いたのに何も出ない、ということは起きません。`,
      at: new Date(2026, 10, 1, 11, 26).getTime(),
    },
    {
      id: "e7",
      role: "user",
      text: "5 枚あるタブのテストデータも足して。会話はスクロールするくらいで。",
      at: new Date(2026, 10, 1, 11, 30).getTime(),
    },
    {
      id: "e8",
      role: "agent",
      text: `足しました。cobalt-fern-5b08 のタブに 5 枚あります。

- π 2 枚（片方は会話つき）
- bash 1 枚
- claude 1 枚
- codex 1 枚

分割したときの見え方を確かめる用です。`,
      at: new Date(2026, 10, 1, 11, 31).getTime(),
    },
    {
      id: "e9",
      role: "user",
      text: "会話のスクロール量は足りてる？",
      at: new Date(2026, 10, 1, 11, 33).getTime(),
    },
    {
      id: "e10",
      role: "agent",
      text: `半分の高さでも 1 画面ぶんは超えるようにしてあります。

スクロールの位置はセルごとに持ちます。片方を読み返している間に、もう片方が最新へ飛ぶことはありません。

追従するのは「最新が見えている間」だけです。上に戻っているときは止まります。`,
      at: new Date(2026, 10, 1, 11, 34).getTime(),
    },
    {
      id: "e11",
      role: "user",
      text: "タブの見分けはどうする？色を変える？",
      at: new Date(2026, 10, 1, 11, 36).getTime(),
    },
    {
      id: "e12",
      role: "agent",
      text: `色は増やさず、エージェントの記号を添えるのがよさそうです。

一覧と同じ記号なので、どこでも同じ形で読めます。状態は右側の輪で分かります。`,
      at: new Date(2026, 10, 1, 11, 37).getTime(),
    },
  ],
  "w80:p11": [
    {
      id: "f1",
      role: "user",
      text: "こっちは別の作業。返答の待ち時間を測りたい。",
      at: new Date(2026, 10, 1, 11, 24).getTime(),
    },
    {
      id: "f2",
      role: "agent",
      text: `測ります。送信から返答までの時間を、返答の行に小さく添えます。

1 分を超えたら秒は落として、目安として読みやすくします。`,
      at: new Date(2026, 10, 1, 11, 24, 40).getTime(),
    },
    {
      id: "f3",
      role: "user",
      text: "待っている間の表示は？",
      at: new Date(2026, 10, 1, 11, 26).getTime(),
    },
    {
      id: "f4",
      role: "agent",
      text: `3 点が順に灯る表示にしてあります。返答が来たら消えます。

止めたいときは、送信ボタンが停止に変わるのでそこで止められます。`,
      at: new Date(2026, 10, 1, 11, 27).getTime(),
    },
    {
      id: "f5",
      role: "user",
      text: "止めたときは返答は来ない？",
      at: new Date(2026, 10, 1, 11, 29).getTime(),
    },
    {
      id: "f6",
      role: "agent",
      text: `来ません。待ちを捨てて、入力欄に「停止しました」とだけ残します。

会話には何も積まないので、履歴が食い違うことはありません。`,
      at: new Date(2026, 10, 1, 11, 30).getTime(),
    },
  ],
  "w80:p13": [
    {
      id: "g1",
      role: "user",
      text: "PR の差分を見て。判定だけほしい。",
      at: new Date(2026, 10, 1, 11, 18).getTime(),
    },
    {
      id: "g2",
      role: "agent",
      text: `判定: must 0 / should 1 / nit 2。

should は、分割したときに選択中のセルが分からない点です。タブの選択とセルの対応を、何かしら見える形にした方がよさそうです。`,
      at: new Date(2026, 10, 1, 11, 20).getTime(),
    },
    {
      id: "g3",
      role: "user",
      text: "nit は？",
      at: new Date(2026, 10, 1, 11, 21).getTime(),
    },
    {
      id: "g4",
      role: "agent",
      text: `1. 4 枚のとき、上段のタブとセルの順が読み取りにくい
2. 5 枚以上のタブで、選んだペインが枠外のときに何が起きるか説明がほしい

どちらも表示の話なので、動きは変えずに直せます。`,
      at: new Date(2026, 10, 1, 11, 22).getTime(),
    },
  ],
};
