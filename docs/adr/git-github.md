# git と GitHub の情報は BFF が git / gh の CLI で読み、書き込みは fetch と fast-forward の pull に限る

- Status: Accepted

## Context

一覧と見出しに、ブランチ・上流との差・PR を出したい。PR のタイトルは、ランダムな名前のワークツリーが何のタスクだったかを思い出す手がかりにもなる。スマホからは、マージの後に main を取り込む操作もしたい。

状態は Herdr のイベントごとに取り直している（[Herdr 連携](herdr-socket.md)）。`gh` はネットワークと認証に依存し、遅い・失敗する・未認証のことがある。

## Decision

- BFF がチェックアウトで `git` と `gh` の CLI を実行して読む。GitHub の API トークンや git のライブラリは持たない。読む場所はブランチと同じ `checkoutPaths` の解決を共有し、見出しのブランチと PR を食い違わせない
- ブランチと上流との差（`git for-each-ref` の `upstream:track`）は状態に載せ、短い TTL でキャッシュする
- PR は状態のスナップショットに載せない。見えているスペースが求めたときだけ `gh pr list --head <branch>` で引く。状態の取り直しを `gh` の待ちに巻き込まないため。`(checkoutPath, ブランチ名)` ごとにキャッシュし、同時の問い合わせは共有する。取得できなくても 200 で `null` を返す
- `--head` には push 先のブランチ名を先、ローカル名を後ろにした候補を渡す。Herdr の自動生成名（`worktree/<呼び名>`）はそのまま push されないことがある
- `gh` が返した URL は `https://github.com/<owner>/<repo>/pull/<n>` の形で番号と一致するものだけをリンクにする
- 書き込みは、スペースのメニューから利用者が選んだ `git fetch` と `git pull --ff-only` だけにする。マージや rebase はしない。自動フェッチもしない
- git は `GIT_TERMINAL_PROMPT=0` で起動し、認証プロンプトで固まらせない。時間の上限を置く

## Consequences

- `gh` が未認証・オフラインのときは PR が出ない。失敗と PR 無しは区別しない
- fork 運用で upstream にだけ PR がある場合、`gh pr list --head` はチェックアウトの remote を見るため PR を見つけられない
- 上流との差は、Herdr のイベントによる取り直しと操作後の取り直しでしか更新されない。リモートの変化はフェッチするまで出ない

## Alternatives

- **GitHub の API を直接呼ぶ**: 速度と制御は得られるが、トークンの保管が要り、`gh` の認証と二重になる
- **状態に PR を載せる**: 一覧全体が `gh` の待ちになる
- **LLM で会話を要約してタスク名にする**: プロバイダーと API キー、会話の外部送信、コスト、失敗時の扱いを別に設計することになる。PR タイトルで足りないと分かってからでよい
- **Herdr の `workspace.rename` で名前を変える**: TUI とランダム名で対応付けている使い方から外れる
