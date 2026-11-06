# ADR 0034: ワークツリーのチェックアウトはスペースのメニューから削除する

- Status: Accepted
- Date: 2026-11-06

## Context

[ADR 0029](0029-preserve-last-pane.md) で、最後のペインは閉じずにエージェントの終了だけを要求し、スペースを残すことにした。その結果、不要になったワークツリー（スペース）を片付ける手段が Herdr の TUI にしか無く、hwc からは「エージェントを終了」までしかできない。ワークツリーはタスクごとに作って捨てるものなので、終わった作業の置き場所を消すためだけに TUI へ戻る必要がある。

Herdr には `workspace.close` と `worktree.remove` がある。`workspace.close` はスペースを閉じるだけでチェックアウトのフォルダは残る。`worktree.remove` は `git worktree remove` を実行してフォルダを消し、ブランチは消さない。TUI の「Delete worktree checkout...」は後者で、確認ではフォルダが消えること・ブランチが残ること・スペースが閉じること・未コミットと未追跡のファイルが失われることを伝えている。

## Decision

- スペース見出しのメニューに「ワークツリーを削除」を置き、`worktree.remove` を呼ぶ。対象は Herdr の linked worktree（`worktree.isLinkedWorktree === true`）だけとし、リポジトリの本体（linked でない）には出さない
- `force: true` を送る。TUI と同じく、未コミット・未追跡のファイルも消える前提で確認を 1 回だけ出す。force を送らないと dirty なチェックアウトを Herdr が `dirty_worktree_requires_force` で拒否し、GUI から片付けられなくなる
- `workspace.close` は使わない。閉じるだけではフォルダが残り、「ワークツリーを削除」の目的を満たさない
- 確認ダイアログで、チェックアウトのパス・ブランチが残ること・スペースと実行中のエージェントが終わること・未コミットのファイルが失われることを伝える。取り消せないので確認は省かない
- 入口は一覧のスペース見出しの「…」だけに置く。ペインのメニューには出さない
- `POST /api/workspaces/:id/remove-worktree` を足す。`application/json` 以外は 415、状態が無ければ 502、BFF の状態に無ければ 404、linked worktree でなければ 409 `not_linked_worktree`、Herdr の失敗は 502
- Herdr の `workspace_not_found` / `worktree_not_found` は 404 とし、クライアントは成功として扱う。チェックアウトが既に無いという目的の状態には達している
- 削除後に状態を取り直さない。スペースが消えるのは Herdr のイベント（`workspace.closed`）に任せる
- 選択は動かさない。表示中のペインが消えた場合は、既存の規則（一覧に戻る）に従う
- 最後のペインの保護（[ADR 0029](0029-preserve-last-pane.md)）は変えない。ペインの close / exit はスペースを残し、スペースを片付けるのはこの操作だけにする

## Consequences

- ADR 0029 の「スペース自体を片付ける操作は Herdr で行う」は、linked worktree についてこの ADR が置き換える。リポジトリ本体のスペースを閉じる操作は持たないままにする
- 未コミットの変更は確認を挟んでも失われる。元に戻す手段は持たない（ブランチは残るので、コミット済みの作業は戻せる）
- 削除中は他の操作を受け付けない。git が遅い場合はクライアント側の期限で失敗を表示するが、Herdr 側では削除が進んでいることがある
- 削除するとスペースが閉じるので、そのスペースの会話・下書き・未読は一覧から消える

## Alternatives

- **`workspace.close` を使う**: チェックアウトが残り、目的を満たさない
- **force を送らず、dirty のときだけ再確認する**: 確認が 2 段になり、TUI の 1 回の確認と揃わない。dirty かどうかは git の状態で、hwc からは安く判定できない
- **ペインのメニューにも置く**: ペインの操作とスペースの操作が混ざる。入口はスペース見出しに 1 つにする
- **本体（linked でない）にも出す**: `worktree.remove` は linked 専用。本体を閉じる意味は別に決める必要がある
