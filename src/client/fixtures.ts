import type { AppState } from "../server/herdr/state";

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
      worktree: { repoName: "hwc", isLinkedWorktree: true },
      tabs: [
        {
          id: "w80:t1",
          label: "main",
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
          label: "verify",
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
      ],
    },
    {
      id: "w92",
      label: "hwc-verify",
      agentStatus: "blocked",
      focused: false,
      worktree: null,
      tabs: [
        {
          id: "w92:t1",
          label: "main",
          agentStatus: "blocked",
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

  "w92:p1": `❯ echo HWC_API_OK
HWC_API_OK

❯ echo NO_SUBMIT_CHECKecho SUBMIT_CHECK
NO_SUBMIT_CHECKecho SUBMIT_CHECK

❯ `,
};

export function previewOutput(paneId: string): string {
  return previewOutputs[paneId] ?? "";
}
