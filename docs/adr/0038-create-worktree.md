# ADR 0038: スペースのメニューから Herdr ワークツリーを作り、その最初のペインでエージェントを起動する

- Status: Accepted
- Date: 2026-11-07

## Context

[ADR 0034](0034-remove-worktree.md) で linked worktree を片付ける手段はできたが、新しく作るには Herdr TUI に戻る必要がある。ワークツリーはタスクごとに作って捨てるものなので、開始と終了の両方を hwc から行いたい。

Herdr の TUI の Space メニューにはワークツリー作成があり、`worktree.create` で linked worktree を 1 つ作れる。ただし作成後は空のシェルペインなので、hwc から作るだけでは [ADR 0026](0026-new-pane.md) / [ADR 0027](0027-new-pane-agent.md) の「作りながらエージェントを起動する」から遠い。とはいえ、分割とは違い、作成後のペインは Herdr が root pane として 1 枚用意する。

[ADR 0026](0026-new-pane.md) は「ペインの並べ替え・移動、タブ・ワークスペースの作成、5 枚以上、最小幅を保証するガードは持たない」と決めている。ここに例外を置くか、TUI に残すかを決める必要がある。

## Decision

- 一般のスペース作成・タブ作成は持たないままにする。例外は `worktree.create` に限り、hwc からは「リポジトリ本体のスペース」からだけ作る。linked worktree の中から別の linked worktree は作らない
- 入口はスペース見出しの「…」に「新しいワークツリー」を足す。`worktree.isLinkedWorktree !== true` のときだけ出す。ペインのメニューとタブバーには置かない（2026-11-10 追記: スペース見出しのメニューの入口は [ADR 0072](0072-github-remote-link.md) で先頭アイコンに変わった）
- Herdr の `worktree.create` に `{ workspace_id, focus: true }` だけを送る。`branch` / `path` / `base` は送らず、ブランチ名・保存先・base は Herdr の自動生成と設定に任せる。クライアントの期限は作成 60 秒・エージェント起動 30 秒・モデル検証を含めて、モデル指定なしは 120 秒、指定ありは 180 秒
- 作成後の root pane を最初のペインとして、[ADR 0027](0027-new-pane-agent.md) のダイアログの入力をそのまま使う。分割はせず、`agent.start` と `pane.rename` だけを行う。ダイアログの見出しは「新しいワークツリー」、説明でブランチ名と保存先が Herdr 任せであることを伝える
- 4 枚上限（ADR 0026）は判定しない。上限はタブ単位で、ワークツリー作成は新しいタブを Herdr が作るため、分割 API の上限判定を再利用すると 4 枚のタブから作れなくなる
- モデル一覧は起点スペースの先頭ペインの cwd で読む。実際の起動時は `agent.start` の前に、新しい root pane の cwd でモデルと effort を再検証する（[ADR 0030](0030-new-pane-model.md)）。選択が無効なら別モデルへ置き換えず、root pane をシェルとして残す
- 起動直後のモデル表示は [ADR 0033](0033-launch-model-before-first-message.md) に従う。起動に成功した場合とリネームだけ失敗した場合に、モデル指定を預かる
- `POST /api/workspaces/:id/create-worktree` を足す。`application/json` 以外は 415、body は分割 API と同じ `{ name?, agent?, model?, effort? }` を `parseSplitBody` で検証する。BFF の状態が無ければ 502、起点が状態に無ければ 404 `workspace_not_found`、worktree 情報が無ければ 409 `not_git_worktree`、linked worktree なら 409 `linked_worktree_source`。成功は `{ workspaceId, paneId }`
- Herdr の失敗は、作成できたか・再試行できるかで分ける
  - `worktree_create_failed` → 502 `worktree_create_failed`（作成前に失敗。再試行できる）
  - `worktree_open_failed` → 502 `worktree_open_failed`（チェックアウトはできていることがある。再送しない）
  - `worktree_operation_in_progress` → 409（待って再試行できる）
  - `linked_worktree_source` / `not_git_worktree` → 409、`workspace_not_found` → 404（起点を変える。再試行しない）
  - `invalid_params` / `invalid_request` → 400
  - ソケット期限切れ・切断・不正 JSON・応答 parser 失敗 → 502 `herdr_unavailable`（作成結果が不明。再送しない）
  - `agent_start_failed` / `pane_rename_failed` → 502 の部分成功。`{ error, workspaceId, paneId }` を返し、ワークツリーと root シェルは残す。`agent_not_ready` は成功として扱う
- 応答でスナップショットを取り直さない。状態は `workspace.created` / `tab.created` / `pane.created` に任せる。成功・部分成功の後は、返ってきた `paneId` がスナップショットに現れてから開く
- ダイアログは、作成できたかを確認できない失敗（期限切れ・通信断・`worktree_open_failed`・`herdr_unavailable`）と部分成功では、フォームを閉じて理由と「閉じる」だけを出す。`worktree_create_failed` と `worktree_operation_in_progress` はフォームを残して再試行できる
- `src/server.ts` の `IDLE_TIMEOUT_SECONDS` を 200 秒へ上げる。作成とエージェント起動を 1 リクエストで行うため、120 秒ではクライアント期限 180 秒を覆えない
- 分割で使う「ペインにエージェントを起動し、表示名を付ける」処理を共通化し、root pane にも同じ処理を使う。Codex の `--no-daemon`、エージェント名 `hwc-<paneId>`、失敗時の順序（起動失敗をリネーム失敗より優先する）は変えない

## Consequences

- ADR 0026 の「タブ・ワークスペースの作成は持たない」は、`worktree.create` に伴うスペースだけこの ADR が置き換える。一般のスペース作成・タブ作成は持たないままにする
- ブランチ名は Herdr の自動生成なので、作成前にダイアログへ出せない。作成後の新しいスペース名で確認する
- モデル一覧は起点スペースの cwd で読む。新しいワークツリーの設定や cwd が違えば、選んだモデルが起動時に無効になり得る。その場合はエージェント起動失敗として root pane をシェルで残す
- `worktree_open_failed` では、チェックアウトは残っても hwc からはスペースが無い。TUI で開き直す必要がある
- 作成とエージェント起動を 1 リクエストで行うため、クライアントの期限は最長 180 秒になる。通常はもっと短い
- ダイアログの「ペイン名」は新しいスペースの root pane のラベルになる。ワークツリー自体の名前は変えられない
