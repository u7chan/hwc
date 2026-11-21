# git と GitHub は BFF が git / gh の CLI で読み、ワークツリーの作成と削除は Herdr に任せる

- Status: Accepted

## Context

一覧と見出しに、ブランチ・上流との差・PR を出したい。PR のタイトルは、ランダムな名前のワークツリーが何のタスクだったかを思い出す手がかりにもなる。スマホからは、マージの後に main を取り込む操作や、ワークツリーを作る・片付ける操作もしたい。

状態は Herdr のイベントごとに取り直している（[Herdr 連携](herdr-socket.md)）。`gh` はネットワークと認証に依存し、遅い・失敗する・未認証のことがある。

ワークツリーとスペースの対応は Herdr が持つ。ワークツリーの削除はチェックアウトごと消す操作で、取り消せない。

## Decision

### 読み取り

- BFF がチェックアウトで `git` と `gh` の CLI を実行して読む。GitHub の API トークンや git のライブラリは持たない。読む場所はブランチと同じ `checkoutPaths` の解決を共有し、見出しのブランチと PR を食い違わせない
- ブランチと上流との差（`git for-each-ref` の `upstream:track`）は状態に載せ、短い TTL でキャッシュする
- PR は状態のスナップショットに載せない。見えているスペースが求めたときだけ `gh pr list --head <branch>` で引く。状態の取り直しを `gh` の待ちに巻き込まないため。`(checkoutPath, ブランチ名)` ごとにキャッシュし、同時の問い合わせは共有する。取得できなくても 200 で `null` を返す
- `--head` には push 先のブランチ名を先、ローカル名を後ろにした候補を渡す。Herdr の自動生成名（`worktree/<呼び名>`）はそのまま push されないことがある
- `gh` が返した URL は `https://github.com/<owner>/<repo>/pull/<n>` の形で番号と一致するものだけをリンクにする

### 書き込み

- BFF が直接実行する git の書き込みは、スペースのメニューから利用者が選んだ `git fetch` と `git pull --ff-only` だけにする。マージや rebase はしない。自動フェッチもしない
- git は `GIT_TERMINAL_PROMPT=0` で起動し、認証プロンプトで固まらせない。時間の上限を置く
- ワークツリーの作成と削除は Herdr の `worktree.create` / `worktree.remove` に任せ、BFF は `git worktree` を直接実行しない
- 作成は本体（linked でない）スペースからだけ受け、`{ workspace_id, focus: true }` だけを送る。ブランチ名・保存先・base は Herdr の自動生成と設定に任せる
- 削除は Herdr が管理する linked worktree（`managed: true` かつ linked）だけを対象にし、`force: true` で呼ぶ。未コミットの変更と未追跡のファイルも消えるので、そのことを確認で伝え、確認を省かない
- スペースを閉じるときは `close_group` なしの `workspace.close` を使い、チェックアウトのフォルダは残す。グループを巻き込む閉じ方はしない

## Consequences

- `gh` が未認証・オフラインのときは PR が出ない。失敗と PR 無しは区別しない
- fork 運用で upstream にだけ PR がある場合、`gh pr list --head` はチェックアウトの remote を見るため PR を見つけられない
- 上流との差は、Herdr のイベントによる取り直しと操作後の取り直しでしか更新されない。リモートの変化はフェッチするまで出ない
- hwc から削除したワークツリーの未コミットの変更は戻らない。LAN 内の誰でもこの操作を行える（[LAN 公開](lan-access.md)）

## Alternatives

- **GitHub の API を直接呼ぶ**: 速度と制御は得られるが、トークンの保管が要り、`gh` の認証と二重になる
- **状態に PR を載せる**: 一覧全体が `gh` の待ちになる
- **LLM で会話を要約してタスク名にする**: プロバイダーと API キー、会話の外部送信、コスト、失敗時の扱いを別に設計することになる。PR タイトルで足りないと分かってからでよい
- **Herdr の `workspace.rename` で名前を変える**: TUI とランダム名で対応付けている使い方から外れる
- **`force` なしで削除する**: 未コミットの変更があると Herdr が `dirty_worktree_requires_force` で拒否し、スマホから片付けられない
- **BFF が `git worktree` を直接実行する**: Herdr が持つスペースとの対応とずれる
