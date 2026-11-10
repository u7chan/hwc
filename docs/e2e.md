# E2E

E2E のスクリーンショットを PR に貼るため、実 Herdr のワークスペース名・ブランチ・ユーザー名・パス・会話を画面に出さない。開発用の BFF（:30000）は実 Herdr につながっているので、E2E には使わない。

## 起動

```bash
bun run e2e:serve
```

`http://127.0.0.1:31000/` を Playwright CLI で開く。ポートは `PORT` で変えられる。`HOST` は `127.0.0.1` に固定する。

起動ログの `hwc ready: ... (e2e)` と、設定画面の revision `e2e` で、架空環境であることを確認できる。

## 実環境との分離

| 対象                                 | 実環境                                              | E2E                                                                                                                            |
| ------------------------------------ | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Herdr ソケット                       | `~/.config/herdr/herdr.sock`                        | `HERDR_SOCKET_PATH` を一時ディレクトリへ向ける                                                                                 |
| pi セッション                        | 実セッションの JSONL                                | `e2e/fixtures/scenario.ts` が一時ディレクトリへ書く                                                                            |
| pi モデルカタログ                    | 各 agent dir の `models-store.json` / `models.json` | 同 fixture が `<root>/agent/models-store.json` へ書く。上書き設定もこの架空 agent dir だけに置く                               |
| pi モデル・effort・上限              | `pi --offline --list-models` / RPC                  | `<root>/bin/pi` が `e2e/fake-pi.ts` を起動する。E2E の `PATH` の先頭に置き、実 Pi は起動しない                                 |
| GitHub の PR                         | 実リポジトリの remote と `gh` の認証                | `<root>/bin/gh` が `e2e/fake-gh.ts` を起動し、ブランチごとの架空の PR を返す                                                   |
| Codex App Server                     | `codex app-server --stdio`                          | `<root>/bin/codex` が `e2e/fake-codex.ts` を起動する。`CODEX_HOME` も `<root>/codex` に向け、実 Codex は起動しない             |
| OpenCode サービス                    | `~/.local/state/opencode/service.json`              | `HWC_OPENCODE_SERVICE` を一時ディレクトリへ向ける                                                                              |
| ブランチ                             | 実リポジトリの `.git/HEAD`                          | 一時ディレクトリの `.git/HEAD`                                                                                                 |
| git のリモートと差                   | 実リポジトリの remote と認証                        | `<root>/bin/git` が `e2e/fake-git.ts` を起動し、`<root>/git-state.json` の架空の remote URL / upstream / ahead / behind を返す |
| 状態ディレクトリ（添付・ペイン時刻） | `~/.local/state/hwc`                                | `HWC_STATE_DIR` を一時ディレクトリへ向ける                                                                                     |
| ポート                               | 30000                                               | 31000                                                                                                                          |

`e2e/serve.ts` が架空 Herdr を起動してから `src/server.ts` を読み込む。BFF とクライアントは本番コードのままで、ソケット経路・状態同期・チャット読み取りを通る。実 Herdr のソケットには接続しない。

## 架空 Herdr

`e2e/fake-herdr.ts` が Unix ソケットで次のメソッドに応答する。

- `session.snapshot`
- `events.subscribe`
- `pane.read`
- `pane.clear`
- `pane.process_info`
- `pane.layout`
- `pane.get`
- `pane.send_input`
- `pane.send_keys`
- `agent.focus`
- `pane.split`
- `pane.rename`
- `agent.start`
- `agent.prompt`
- `pane.close`
- `worktree.create`
- `worktree.remove`
- `workspace.close`
- `workspace.move_block`

`pane.clear` は架空の端末出力を最後の 1 行だけにして、実 Herdr の画面・スクロールバックのクリアを模す。`pane.close` はスナップショットからペインを消して `pane.closed` を流す。`worktree.remove` は
linked worktree のスペースをスナップショットから取り除き、`workspace.closed` を流す（実際の
チェックアウトのフォルダには触らない）。`worktree.create` は起点スペースの worktree 情報から
架空のチェックアウトパスを決め、リンクされたスペース・タブ・root pane をスナップショットに
足して `workspace.created` / `pane.created` を流す（実際の `git worktree add` はしない）。
`pane.split` は
`target_pane_id` のタブにシェルペインを 1 枚足し、`pane_info` を返して `pane.created` を流す。
`pane.layout` はそのタブのセルを等幅のグリッドとして返す（E2E 用の固定形で、実際の分割方向は
BFF の unit で確かめる）。`pane.rename` はラベルを変えて `pane.updated` を流す。`agent.start` は
架空のエージェントをペインへ付け、`pane.updated` を流す。Codex は架空の thread id と空の会話を
用意し、既存の `review` ペインには架空の user / assistant の会話を入れる。`agent.focus` は
フォーカスを移して `pane.focused` を流す。実 Herdr と同じく seen も進むので、対象が `done` の
ときは `idle` に戻し、そのタブとスペースの集約状態を残りのペインから引き直して `pane.updated`
を流す。hwc の既読はこの遷移で完了から待機に変わる（行そのものは残る）。
`pane.send_keys` は `esc` を受けるとペインの `agent_status` を `idle` に戻し、`pane.updated` を流す。
`workspace.move_block` は `workspaces` を並べ替えて `workspace.reordered` を流す。実 Herdr と同じく、
渡された id の列を 1 ブロックとしてアンカーの前へ置く。
`workspace.close` はスペース・タブ・ペインをスナップショットから取り除き、`workspace.closed` を流す。
実際のチェックアウトのフォルダには触らない。
BFF は実 Herdr と同じようにイベントで状態を取り直す。

`<root>/bin/git` は `e2e/fake-git.ts` を起動する。`remote -v` と `for-each-ref` は
`<root>/git-state.json` の架空の remote URL / upstream / ahead / behind を返し、`fetch` は何も変えない。
`rev-parse` は fixture に登録した cwd をリポジトリとして返す。Herdr が worktree を持たない
`plain-checkout` の git 種別を BFF が補うために使う。
remote URL は GitHub の予約済みでない架空のパス（`example/acme-dashboard`）にする。
`pull --ff-only` は behind を 0 にして状態ファイルを書き換えるので、BFF が状態を取り直すと
見出しの `↓N` が消える。実リポジトリ・実リモート・認証には触れない。

シェルペインの「…」メニューには「出力をクリア」が出る。選ぶと BFF が `pane.clear` を呼び、
架空の端末出力は最後の 1 行（プロンプト）だけになる。hwc はペイン詳細の実行口から直ちに
出力を読み直し、メニューを閉じる。エージェントのペインにはこの項目を出さない。

`web` の `shell` ペイン（`w1:p2`）は、fixture で `bun --watch src/server.ts` が動いている。
架空 Herdr はこれを実プロセス（`e2e/fake-listen.ts`）として待ち受けさせ、`pane.process_info` には
その pid を返す。詳細のタブ名はペイン名ではなくプログラム名とポート（`bun <port>`）になり、
入力欄が空の間は送信ボタンが停止に変わる。停止を押すと架空 Herdr が `C-c` を受けて前景コマンドを消し、次のポーリングでタブ名が
`shell` に戻り、ボタンも送信に戻る。入力に文字を入れると、動いている間でも送信ボタンになる。

このペインの端末出力には ANSI の SGR と裸の URL を含めてある。詳細の出力欄が色付きになり、
URL が下線付きで新しいタブに開くことを目視できる（[ADR 0046](adr/0046-pane-output-ansi-links.md)）。

`scratch` の `folder-trust` と `folder-trust-saved` は、架空の Codex のフォルダ信頼確認を表示する。前者は会話なし、後者は保存済み会話を持つが `idle` のまま確認待ちになる。「信頼して続行」の Enter を受けると確認を消し、前者には空の会話を作って `idle` にする。「ターミナルで操作」では架空 Herdr へのキー送信がなく、確認が残ることを確かめる。表示するパスと注意文は `e2e/fixtures/folder-trust.ts` の架空データだけを使う。

`scratch` の `codex-start` は、会話 ID がまだない起動直後の Codex を表す。通常の入力待ちなら端末出力と入力欄が表示され、最初のメッセージを送れることを確認する。

`scratch` の `pi-trust` は、架空の Pi のプロジェクト信頼確認を表示する。会話を持たず `idle` のまま確認待ちになる。入力欄の代わりに確認ビューが出ること、「信頼して続行」の Enter で確認が消えて端末表示と入力欄に戻ること、「ターミナルで操作」では架空 Herdr へのキー送信がなく、確認が残ることを確かめる。表示するパスと注意文は `e2e/fixtures/folder-trust.ts` の `PI_TRUST_SCREEN` だけを使う。

モデル選択では、`pane.get` が fixture の cwd を返す。Pi の一覧は架空 CLI から、OpenCode の一覧と新規セッションは `e2e/fake-opencode.ts` の loopback サービスから読み書きする。候補の正は `e2e/fixtures/scenario.ts` の `STARTUP_MODELS`。`agent.start` は受け取った引数を架空の端末出力にも残し、モデル指定した OpenCode には架空のセッション参照を付ける。

OpenCode の未起動表示は、架空の `<root>/opencode/service.json` だけを一時退避してダイアログを開き、「OpenCode サービス未起動」と出ることを確認する。モデル欄は無効でもデフォルト起動は選べ、サービスの自動起動は行わない。接続情報を戻してダイアログを開き直すとモデル一覧が復帰することも確かめる。

effort は同 fixture のエージェント別候補を使う。モデルを選択したときだけ候補が読まれ、モデル・エージェント・シェルの切り替えで指定が解除されることを確かめる。`@demo/beam-small` は effort 非対応、長いモデル名は選択肢が異なるモデルを表す。`@demo/start-fails` は起動に失敗するモデルで、`agent.start` が `agent_spawn_failed` を返す。新しいペインやワークツリーの部分成功（シェルを残して理由を出す）を、実 CLI に触れずに確かめるために使う。Pi は架空 RPC の `get_state` / `get_available_thinking_levels`、Codex は `model/list`、OpenCode は `variants` を通す。Pi は実物と同じく、最初のメッセージを送るまで架空セッションを作らない。起動したペインのチャットのモデル・effort 表示は、送信前は BFF が起動時の指定で補い（[ADR 0033](adr/0033-launch-model-before-first-message.md)）、送信後は架空セッションに記録された値になる。取得失敗・遅い応答によるモデル間の取り違えはブラウザのリクエスト差し替えで確かめる。

Codex のモデル一覧と会話は架空 App Server の JSON-RPC を通す。初期化後の `config/read` / `model/list` / `thread/read` / `thread/turns/list` にだけ応答する。モデル指定した新規ペインは、そのモデルを架空の thread に記録する。入力は本番と同じ Herdr の `pane.send_input` 経由で受け、架空の user と assistant の item を追加する。チャット表示、送信後の確定、起動時のモデル引数を、実 Codex や実会話へ触れずに確認する。

`pane.process_info` は、エージェントのペインでは親シェルと別の前景グループ（エージェント自身）を返す。シェルのペインは、fixture の `foreground` にコマンドを持つときだけ別グループになり、それ以外はプロンプトで待っている形を返す。`pane.send_keys` が `C-c` を受けると、そのペインの前景コマンドを消して端末出力に `^C` を追記する。
`agent.prompt` は既知のエージェントへの `/quit` だけを受け付け、ペイン・タブ・スペースを残して
エージェントとセッション参照を外し、`pane.updated` を流す。実 Herdr と同じく、終了したエージェントの
画面は消さずに末尾へシェルのプロンプトを足す。要対応のペインは実 Herdr と同じく
`agent_blocked` で拒否する。最後のエージェントの終了要求、拒否、残ったシェルの削除禁止を確認する。

`pane.send_input` は送信 text を端末出力へ追記し、`agent_session`（`kind: "path"`）を持つペインでは架空セッションの JSONL にも追記する。追記するのは user メッセージ 1 行だけで、それまでの葉を `parentId` にする。確定後の送信カードを画面で確かめるために要る。セッションがまだ無いペインでは、この追記の前にヘッダと `model_change` / `thinking_level_change` を書く。

`frontend` の架空セッションは、最後のターンが失敗した状態（`stopReason: "error"` と `errorMessage`、本文は空）で終わる。同じ失敗をリトライの回数だけ並べてあり、Web では 1 行に畳まれて「3 回」と出る。その行が圧縮後の usage を変えないことも確かめる（[ADR 0039](adr/0039-chat-error-rows.md)）。

その手前の assistant メッセージは、チェックアウト内の `docs/preview/app-icon.png` を裸のパスで、`docs/preview/empty-state.png` と `docs/preview/empty-state-light.png` を画像記法で指す。どれも実在する PNG（`src/client/assets/apple-touch-icon.png`）を fixture がコピーしたもの。連続した画像記法は本文のその位置に 1 行で並び、押すとダイアログで拡大でき、背景・`Esc`・閉じるボタンで閉じる（[ADR 0055](adr/0055-inline-message-images.md) / [ADR 0042](adr/0042-image-preview-dialog.md)）。裸のパスのほうは位置が無いので、今までどおりメッセージの末尾にサムネイルの行が出る（[ADR 0041](adr/0041-agent-message-images.md)）。セッションの葉から `parentId` を遡る読み取りに乗せるため、失敗したターンの鎖もこのメッセージを親にする。

送信前の添付チップも同じように拡大できる。入力欄に画像を貼り付けるかドロップし、アップロードが終わってサムネイルが出てから押すとダイアログが開く。`Esc` で閉じるとサムネイルへフォーカスが戻り、チップは残ったままになる。

入力欄の + からは、同じ経路で画像を選べる。ファイル入力の `accept` は `image/*` で、`dropActionFrom` と `takeImages` を通る。Playwright では画像のメニュー項目を押した後の File chooser に `upload` でファイルを渡す。

`+` の「プロジェクトを選ぶ」は、`<root>/bin/git` の `ls-files` が返すマニフェストから候補を作る。架空 Herdr の `pane.get` は `…/work/acme-dashboard` を cwd として返し、偽 git はその cwd に対して `package.json`、`packages/api/package.json`、`packages/web/pyproject.toml`、`apps/desktop/Cargo.toml` を返す。cwd 自身の `package.json` は候補から外れるので、`desktop`、`api`、`web` の 3 件になる。実ファイルは作らない。

pi のペインでは、あわせてセッションの隣に live の sidecar（`<session>.jsonl.thinking.json`）を書く。まず `waiting` で `working` にし、1.2 秒後に折り返す長さの `thinking` と `tokPerSecond: 42.3` を上書きし、6 秒後に消して `idle` に戻す。実物の pi 拡張はターン中に phase・thinking の末尾・生成速度を上書きし続ける（[ADR 0035](adr/0035-live-pi-activity.md)）。E2E ではこの 2 段階で、段階の行が会話のスクロール領域の外（入力欄の直上）に出て、スクロールしても残ること、生成速度が経過時間の左に出て右端の時間が動かないこと、thinking がまだ無い待機中も帯の高さが変わらず、末尾 2 行だけが出てターン終了で消えることを確かめる。入力欄を 1 行に畳むセルでは thinking と生成速度を出さず、段階と経過時間だけになる。停止ボタン（`esc`）でも sidecar を消す。

`/done`（添付注記なし）はフィクスチャ専用の入力で、実 Herdr には無い。受け取ったペインを `done` にする。実 Herdr の `done` は既読でしか `idle` に戻らず、hwc からは作れないため、一覧の終了時刻と端末間の一致を確かめる入口として置く。

`/compact`（添付注記なし）を受け取ると、実 Herdr の pi 拡張と同じく `agent_status` は `working` にせず、1.2 秒後に架空の compaction をセッションへ追記して `idle` のままにする。hwc 側のローカルな「会話を圧縮しています」と、完了ログの位置・所要時間を E2E で確かめるため、最後の user メッセージを kept の先頭にする。

追記しない条件:

- `agent_session` を持たないペイン（シェルや、会話を読まないペイン）。端末出力にだけ追記する
- text が空、または空白だけの送信
- 添付注記（`<attached_files>`）の無い `/new` と `/compact`（`/compact <指示>` を含む）。会話を残さないか、履歴を置き換える
- 同じく添付注記の無い `/reload`。実 Pi と同じくセッションに何も書かず、`agent_status` も `working` にしない。hwc は控えを履歴に残す（[ADR 0045](adr/0045-pending-echo-turn-grace.md)）

添付を持つペインで `Enter` が送信になるときは、常に本文の送信になる（[ADR 0018](adr/0018-pasted-image-attachments.md)）。タッチ端末では `Enter` が改行になる（[ADR 0037](adr/0037-enter-newline-on-touch.md)）。`/compact` と打っても添付と一緒に送れば本文として扱われるので、注記があるときはコマンドではなく通常本文として追記する。

## 入力の + メニュー

入力欄の下部左端の + から、会話のコマンドを実行し、画像とプロジェクトを追加する（[ADR 0055](adr/0055-composer-add-menu.md)、[ADR 0056](adr/0056-project-picker.md)、[ADR 0057](adr/0057-composer-conversation-commands.md)）。

1. `review` を開き、+ を押す。+ の上に「新しい会話」「会話を圧縮」、区切り、「画像を追加」「プロジェクトを選ぶ」が開き、`Escape` か外側のタップで閉じる。`frontend`（実行中）では 2 つのコマンドが無効になり、補助文に「実行中は使えません」が出る。`new`（空の会話）では「会話が始まると使えます」になる。
2. `review` で「新しい会話」を選ぶと確認ダイアログが開く。「キャンセル」では会話が残り、「始める」では会話が空になる。チップや直接入力の `/new` は確認を挟まない。ペイン見出しの「…」メニューには 2 つのコマンドが出ない。
3. `review` で「会話を圧縮」を選ぶと `/compact` が送られ、履歴に控えと「会話を圧縮しています」が出る。`review` は Codex なので、架空 Herdr は完了の compaction を追記しない。進捗行の「中断」でローカルの表示を畳む。指示付きの圧縮はチップか直接入力で行う。
4. 「画像を追加」を選び、`src/client/assets/apple-touch-icon.png` をアップロードする。入力欄の上に添付チップが出て、書きかけの本文は残る。4 枚添付すると「画像を追加」が無効になり、理由が補助文に出る。
5. 「プロジェクトを選ぶ」を選ぶ。`desktop`、`api`、`web` が名前と相対パスで並ぶ。検索欄に `web` と入れると `web` だけに絞り込まれる。
6. `web` を選ぶとダイアログが閉じ、本文に `./packages/web/` が入り、入力欄にフォーカスが戻る。`Escape` で閉じた場合は + にフォーカスが戻り、本文は変わらない。
7. 会話を持つペインを選び、分割セルで入力欄が 1 行に畳まれる幅にすると + は出ない。2 つのコマンドは `/` と打ったときの候補だけになる。狭い画面でも送信ボタンは右端に残り、モデル名だけが省略される。
8. 空表示と取得失敗は、ブラウザのリクエスト差し替えで確かめる。`frontend` の `/api/panes/w1:p1/projects` を `{"projects":[],"truncated":false}` にすると「このディレクトリ配下に他のプロジェクトはありません。」、502 にすると再試行が出る。

## エージェントの終了

最後のエージェントを終了してもペインとスペースは残る（[ADR 0029](adr/0029-preserve-last-pane.md)）。
終了したエージェントの画面と会話は、シェルに戻った時点で hwc が捨てる（[ADR 0059](adr/0059-clear-exited-agent-screen.md)）。

1. `scratch` の `folder-trust-saved`（Codex、会話あり、待機）だけを残して他の 4 枚を閉じる。
   「…」メニューから 1 枚ずつ閉じてもよいし、`POST /api/panes/:id/close` を直接送ってもよい。
   最後の 1 枚になると、メニューの項目が「エージェントを終了」に変わる。
2. そのまま「エージェントを終了」を押して確認する。ペインとスペースは残り、`agent` が消えて
   入力欄が `$ コマンドを入力` のシェルになる。
3. 2 秒ほど待つと、終了した Codex の画面が消えて、シェルのプロンプトの行だけになる。
   架空 Herdr の `pane.clear` は最後の 1 行（プロンプト）だけを残す。
4. 入力欄のモデル名とコンテキストが消える。会話ビューではなく端末出力が出ている。

## アクティブ一覧

1. `アクティブ` を開く。エージェントのいるペインが、待機中も含めて帯ごとに並ぶ。各帯の先頭は親ペインで、状態が変わっても動かない（王冠はそのスペースにエージェントが 2 枚以上いるときだけ出る）。残りは状態順（要対応 → 完了 → 実行中 → 待機 → 不明）。`acme-dashboard` では `frontend`（親・実行中）が `api`（完了）より上に来る。`scratch` では `notes`（エージェントなし）が出ず、`folder-trust-saved` などの待機が帯に並ぶ。
2. `acme-dashboard` の帯で `api`（完了）を開き、`一覧へ戻る` で戻る。`api` は `待機` になって帯の最後へ移り、帯の件数から完了が消える。親の `frontend` は先頭のまま（[ADR 0050](adr/0050-active-lists-every-agent.md)）。
3. `すべて` に切り替えて、シェルだけのペインと待機のペインがツリーに出ることを確かめる。Herdr に worktree として登録されていない `plain-checkout` も、git 管理下ならシェルではなくリポジトリのアイコンで出る。
4. `acme-dashboard (checks)` の帯は `review`（待機）1 行になり、`acme-dashboard` の帯とは別に並ぶ。`acme-dashboard (docs)` の `writer` と同じく、スペースごとに 1 つの帯になる。

### 経過時間と終了時刻

時刻は BFF が持つ（[ADR 0017](adr/0017-active-agents-view.md)）。一覧の右端は、実行中が経過、完了と待機が終了時刻（時:分）になる。

1. `アクティブ` を開く。`acme-dashboard` の `frontend`（実行中）の右端が、開いた時点から増える経過（`3s`、`1m 4s` など）になる。
2. `frontend` の終了時刻を作る。終了時刻は `working` から `done` へ移ったときにだけ記録し、フィクスチャで `done` を作る入力は `/done` だけ。`frontend` を開いて入力欄に `/done` と入れると、停止ボタンではなく送信ボタンになる（停止は入力が空のときだけで、文字・添付・引用があれば実行中への追加指示の送信になる）。そのまま送って一覧に戻ると、`frontend` が `完了` になり、右端が経過から終了時刻（時:分）に変わる。入力欄を使わない場合は `POST /api/panes/w1:p1/input` に `{"text":"/done","submit":true}` を直接送っても同じになる。
3. 再読み込みしても同じ終了時刻が残る。起点と終了時刻は状態ディレクトリの `pane-times.json` にあり、BFF の再起動でも状態が一致する間は引き継がれる。
4. localStorage を共有しない別のブラウザ（シークレットウィンドウなど）で `アクティブ` を開くと、同じ終了時刻になる。経過は 1 秒の位相で揺れるので、比べるのは固定値の終了時刻にする。
5. `frontend` の行は比べ終わるまで開かない。開いて離れると既読が進んで `待機` に戻り、行の状態が変わる。

## ファビコンと親マーク

ファビコンは、スペースの左端にいる最初のエージェント（親）の完了と、全エージェントの要対応・作業中を見る（[ADR 0054](adr/0054-favicon-parent-status.md)）。タイトルは `HWC` のまま変えない。

1. `アクティブ` を開く。`acme-dashboard` の `frontend` と、`scratch` の `folder-trust` に王冠の親マークが付く。`acme-dashboard (docs)` はエージェントが 1 枚だけなので付かない。
2. `すべて` に切り替え、同じ王冠がツリーのペイン名の横に出ることを確かめる。
3. `frontend` を開く。詳細のペインタブの `frontend` に王冠が出る。同じタブの `shell` には出ない。`checks` タブの `review` にも出ない。
4. `link[rel="icon"]` を調べる。PNG のリンクが消え、SVG の `href` が `data:image/svg+xml,` で始まる。fixture では `writer` と `folder-trust` が `blocked` なので、点は赤になる。
5. `document.title` が `HWC` のままであることを確かめる。

## 一覧の並べ替え

`すべて` の束の並びは Herdr のワークスペース順で、ネイティブ Herdr と同じ（[ADR 0052](adr/0052-workspace-order-drag.md)）。

1. `すべて` を開く。`acme-dashboard`（リポジトリ束）、`scratch`、`sandbox`（重複した 2 スペースの束）が並ぶ。
2. `scratch` の見出しを長押しする（PC は見出しを少しドラッグする）。掴んだ束のカードが破線の青い枠で囲まれ、見出しは読める濃さのまま中身が淡くなり、指の近くに束の名前が出る。落とし先の境界に「ここに移動」の線が出る。破線はカードの角丸に沿う。ラベルは指の反対側に出て、追従するガイドと重なっても手前に残る。
3. `acme-dashboard` の上へ落とす。`scratch` が新しい位置へ動くアニメーションが見え、先頭へ移る。架空 Herdr の並びも変わる。
4. `acme-dashboard` の見出しにフォーカスし、`↓` を押すと 1 つ下がる。`↑` で戻る。
5. 同じ位置へ落としても通信しない。`アクティブ` に切り替えても並びは状態順のまま。
6. 失敗時は `/api/workspaces/move` に 502 を返して確かめる。一覧は Herdr の順のままで、上部に「並べ替えを保存できませんでした。」が出る。
7. 動きを減らす設定（`prefers-reduced-motion: reduce`）では、落とした後のアニメーションが出ないことを確かめる。

## 重複したスペース

Herdr ネイティブの `workspace.create` は同じディレクトリでも新しいスペースを作る。hwc は同じ
パス・同じラベルのスペースを 1 つの場所に束ね、余分なスペースを閉じる入口を出す（[ADR 0060](adr/0060-duplicate-native-spaces.md)）。
fixture の `sandbox` は同じ場所を指す 2 スペースで、どちらもシェルだけ。

1. `すべて` を開く。`sandbox` が 1 行にまとまり、名前の横に `2` の札、副題が `シェルのみ`、右端にシェルの記号が出る。
2. `sandbox` の見出しを開く。代表スペースのシェルペインと、`スペース 2` の見出しが出る。
3. `スペース 2` の見出しの先頭アイコンからメニューを開く。「スペースを閉じる」を選び、確認で「実行中のエージェントも終了するが、チェックアウトのファイルは残る」ことを確かめる。
4. 閉じると `sandbox` の束が 1 スペースに解け、`2` の札と「スペースを閉じる」が消える。残ったスペースは通常の 1 スペースとして見える。
5. 代表スペースを閉じた場合も、残ったスペースが代表になる。最後の 1 つは閉じられない。
6. `アクティブ` にはシェルだけなので `sandbox` は出ない。重複の整理は `すべて` で行う。

## ワークツリー作成

スペース見出しの先頭アイコンから開くメニューで作るワークツリーは、次の手順で確かめる。

1. `acme-dashboard`（リポジトリ本体）の見出しの先頭アイコンを押してメニューを開き、「新しいワークツリー」を選ぶ。
   ダイアログの見出しが「新しいワークツリー」で、ブランチ名と保存先が Herdr 任せである旨が出る。
2. そのまま「作成して起動」を押すと、架空 Herdr にリンクされたスペースが 1 つ増え、hwc が
   その root pane を開く。開いた直後は入力欄の代わりにスピナーと「エージェントを起動しています。」
   が出て、数秒で入力欄に変わる（[ADR 0059](adr/0059-created-pane-starting.md)）。
   入力欄のモデル表示は起動時の指定で補われる（[ADR 0033](adr/0033-launch-model-before-first-message.md)）。
3. linked worktree（`acme-dashboard (docs)`）の見出しのメニューには「新しいワークツリー」が無い。
4. 4 ペインのタブを持つスペースでも、「新しいペイン」だけが無効で「新しいワークツリー」は押せる。
   4 枚のタブは既存のダイアログで 2 枚追加して用意してよい。
5. 部分成功は、モデルに `@demo/start-fails` を選んで作成すると確かめられる。ワークツリーと
   root pane は残り、ダイアログに起動失敗の理由と「閉じる」だけが出る。閉じると新しい root pane
   が表示され、入力欄は待ちを入れずにその場で使える（残ったのはシェルなので、ADR 0059 の待ちは
   入れない）。
6. `worktree_open_failed`（結果不明）はブラウザのリクエスト差し替えで
   `/api/workspaces/:id/create-worktree` に 502 を返して確かめる。再送のボタンは出ず、「閉じる」だけになる。

## 分割ビューとタブ履歴

PC の分割は、開いたペインの履歴（タブ）と 4 スロットのグリッドで持つ（[ADR 0058](adr/0058-split-view-tab-history.md)）。`hwc-split-view` に開いたタブ・current・スロットを保存する。

1. 1600px で `frontend` を開く。タブバーに `frontend` が 1 つ出て、その左端にスロット 1 の青いバーが付く。セルは 1 枚だけなのでセル枠は出ず、詳細の右端に破線の追加帯（40px）が出る。この時点でスロットは 1 つだけで、スロット 2 はまだ無い。
2. `checks` タブの `review` をタブバーから**追加帯へドラッグ**する（スロットが 1 つしかないので、スロットへのドロップでは増えない）。`review` のタブが右端に増え、左端のバーが紫（スロット 2）になる。2 つのセルは 1x2 に並び、`review` のセル枠は紫、`frontend` は青のまま。`frontend` のセルは current の 2px、`review` は 1px の控えめな枠になる。
3. `acme-dashboard (checks)` の `review` を開く（別スペースの同名ペイン）。タブが 2 段になり、2 段目にスペース名が出る。1 スペースだけの間は 2 段目が出ないことを、1 の時点で確かめてある。セル見出しにもスペース名が付き、2 つの `review` を見分けられる。
4. 一覧の現在行（ツリーと `アクティブ` の両方）の枠と名前が、そのペインのスロット色になる。スロット色は PC だけで、390px では出ないことを 11 で確かめる。
5. スロット 2 の `review` をスロット 1 へドロップする（スロットが 2 つできたので、以降はスロット間のドラッグで並べ替える）。2 つが入れ替わり、current のペインは移動先のスロットへ追従する。タブバー内の並びは変わらない。
6. グリッド内のタブの × を押す。確認は出ず、タブが外れてスロットが空き（スロット色の破線 + 右上の ×）になる。ペインは一覧に残り、Herdr 側でも動き続ける。空きスロットの × を押すと、残りが 1 / 2 / 3 / 4 に詰まる。current を外したときは、開いた順の次のタブが選ばれる。実ペインが 1 枚だけの間は、残ったセルの枠は出ない。
7. 再読み込みする。開いたタブ・current・スロットが復元される。架空 Herdr でペインを閉じた場合は、そのペインがタブとスロットから落ちる。
8. 4 枚まで埋めたら追加帯が消える。タブは 5 枚以上積めて、グリッド外のタブを選ぶと current スロットを置き換える。
9. 最後のペインのタブでも × は出る。`acme-dashboard (docs)` の `writer`（スペース唯一のエージェント）で × を押すと、タブから外れるだけでペインとスペースは残り、一覧から開き直せる。`scratch` の `pi-trust` も同じ。単独シェルのスペースは fixture に無いため、`keep` の判定は `src/shared/pane-close.test.ts` で確認する。エージェントを終えるには、ペイン見出しの三点リーダーメニューから「エージェントを終了」を選ぶ。
10. プレビューを開いたままタブを切り替えると、プレビューは隠れてペインのセルに戻る。プレビューを選ぶと detail を占有し、グリッドと追加帯は出ない。
11. 390px（モバイル）では、タブ履歴と 2 段目だけが出て、グリッド・追加帯・4 色・ドラッグは出ない。タブ左端のスロット色バーと、一覧の現在行のスロット色も出ない（PC と同じ `hwc-split-view` のスロットを、色にだけ使わない）。タブの × は常に出て、タップで確認なしにタブから外れる。ペインは一覧に残る。`hwc-split-view` を消してから開くと、Herdr のフォーカス中ペインが 1 枚で開く。

## PR のチップ

PR のチップは、1 枚表示と分割セルのペイン見出し、アクティブ帯のワークツリー見出しに出る。1 枚表示では、狭い画面ではブランチの右、広い画面ではブランチを出さないのでエージェント記号の右に出る。分割セルは自分のスペースの PR を出すので、同じ PR が並ぶこともあれば、別の PR が並ぶこともある（[ADR 0058](adr/0058-split-view-tab-history.md)）。

1. `acme-dashboard` のペインを狭い画面で開く。見出しは `feat/empty-state` と `#481` になる。
2. `#481` をタップすると `https://github.com/example/acme-dashboard/pull/481` が新しいタブで開く。
3. `acme-dashboard (docs)` のペインは `docs/quickstart` だけで、チップは出ない（ペイン見出しに merged は出さない）。
4. 広い画面にすると、見出しはブランチを出さず、`#481` だけを出す（一覧がブランチを持っている）。
5. `acme-dashboard` のペインを 1 つ目のスロットに、`acme-dashboard (checks)` の `review` を 2 つ目のスロットに入れる。1 つ目のセルは `#481`、2 つ目は `#483` になり、それぞれの URL が開く。

## HTML のプレビュー

エージェントが本文で示した HTML は、メッセージの下のチップからプレビューのタブで開く（[ADR 0051](adr/0051-agent-html-preview.md)）。fixture は `docs/preview/` に HTML・CSS・JS を分けて置いている。

1. `frontend` ペインの最後のメッセージにある `mock.html HTML` のチップを押す。タブストリップに `mock.html のプレビュー` が増え、detail を占有する。グリッドと追加帯は出ない。
2. iframe の `一覧` を押すと中身が切り替わる（`docs/preview/mock.js` が動いている）。枠・余白・色は `docs/preview/mock.css` が当たっている。
3. ペインのタブ（`frontend`）を選ぶと会話に戻り、プレビューのタブは残る。もう一度選ぶとプレビューに戻る。対象ペインをタブから外すと、プレビューのタブも消える。
4. ヘッダーの `閉じる` でプレビューのタブが消え、ペインのタブが選ばれた状態に戻る。
5. モバイル幅でも同じ手順で全画面になり、ダイアログは出ない。

`HWC_PREVIEW_ROOTS` はチェックアウトの外の HTML と画像を配信するための設定で、fixture では使わない。追加根の検出と配信は BFF の unit / API テストで確認する。

## ワークツリーの概要

一覧のワークツリー見出しには、ブランチの最新 PR のタイトルを出す。チップは open と merged のとき、ツリーのメニューは state を問わない。

1. `アクティブ` を開く。`acme-dashboard` の帯は 1 行目に `Add an empty state to the dashboard` と `#481`、2 行目に `feat/empty-state` が出る。
2. `#481` のリンク先が `https://github.com/example/acme-dashboard/pull/481` であることを確かめる。
3. `acme-dashboard (docs)` の帯は 1 行目に `Write the quickstart guide`、2 行目に `docs/quickstart` が出る。チップは `#482` で、緑色のマージ記号が番号の手前に付く（merged）。
4. `すべて` に切り替える。`acme-dashboard` の見出しの 2 行目が同じタイトルになる。`…` を開くと `PR #481 を開く` があり、リンク先が同じ URL である。
5. `acme-dashboard (docs)` の見出しは、タイトルの手前にマージの記号だけが出る（番号は帯とメニュー）。
6. PR の無い `scratch` の見出しは、今までどおりペイン数だけを出す。

## スペースのパスをコピー

一覧のスペースメニューと、ペイン詳細の右端メニューに、スペースの作業ディレクトリをコピーする入口がある。

1. `acme-dashboard`（リポジトリ本体）の見出しのメニューを開く。ラベルの下に `…/work/acme-dashboard` が出る。コピーアイコンを押すと絶対パス全文がクリップボードに入り、メニューは開いたままになる。
2. `acme-dashboard (docs)` のメニューは、リポジトリのルートではなく `…/work/acme-dashboard-docs` を出す。
3. `scratch`（git 管理外）のメニューは、先頭ペインの cwd に落ちた `…/work/scratch` を出す。
4. ペイン詳細を開き、右端の「…」を開く。ペイン ID の下に「スペースのパスをコピー」があり、押すとそのペインのスペースのパスが入る。

## 読み幅

広い画面では、本文・ペインの見出し・入力欄・実行中や閲覧のみの行を読み幅の列に中央寄せする（[ADR 0045](adr/0045-wide-chat-measure.md)）。

1. 900px 以上の幅でペインを開く。本文・見出し・入力欄・実行中の段階の行の左端と右端が一致し、中央の 832px に収まる。
2. 追加帯へタブをドロップして 2 枚にすると、各セルは 24px の余白に揃う。
3. 900px 未満では左右 16px のまま変わらない。

## データを変える

`e2e/fixtures/scenario.ts` を編集する。ワークスペース、タブ、ペイン、端末出力、pi セッション、ブランチはすべてここで作る。`acme-dashboard (checks)`（`w4`）は、別スペースの同名ペイン（`review` と `shell`）を並べるために置いている。`w1` の `review` / `shell` と同じ名前で、スペースだけが違う。

実在のユーザー名・ホスト名・リポジトリ名・パスを書かない。スクリーンショットに写る値はすべて架空にする。

### 実行中のモデルカタログを変える

モデル上限の追従は、起動ログの `hwc e2e fixture: <root>` が示す架空カタログだけを書き換えて確かめる。実際の Pi の agent dir は使わない。

1. `bun run e2e:serve` で起動し、設定画面の revision が `e2e` であることを確認する。
2. `frontend` ペインを表示する。初期データには圧縮後の usage があり、コンテキストは `14k/200k (7.0%)` になる。狭い表示では割合だけになる。
3. 起動ログから得た `<root>` を使い、表示中モデルの上限だけを変更する。

   ```bash
   FIXTURE_ROOT='<root>'
   bun -e '
     const file = Bun.file(process.argv[1]);
     const store = await file.json();
     store.anthropic.models.find(model => model.id === "claude-sonnet-4-5").contextWindow = 1_000_000;
     await Bun.write(file, JSON.stringify(store));
   ' "$FIXTURE_ROOT/agent/models-store.json"
   ```

4. ペインを可視状態に保ち、次のポーリングで `14k/1.0M (1.4%)` に変わることを確認する。working は 2 秒 / idle は 5 秒周期なので、待ち時間は最大 5 秒程度に通信・処理時間を加えたものとする。BFF の再起動・会話 JSONL への追記・ブラウザのリロードは行わない。
5. 同じ操作で `contextWindow` を `200_000` に戻し、上限と割合も元に戻ることを確認する。

override の追加・変更・削除や読み取り失敗からの復旧、ETag の安定性は BFF の unit / API テストで確認する。

## 禁止

- 実 Herdr につながった BFF（:30000）の画面をスクリーンショットに撮らない。
- 実 pi セッションを fixture にコピーしない。
- 架空環境の確認なしに、E2E の画像を PR へ貼らない。
