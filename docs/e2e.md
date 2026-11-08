# E2E

E2E のスクリーンショットを PR に貼るため、実 Herdr のワークスペース名・ブランチ・ユーザー名・パス・会話を画面に出さない。開発用の BFF（:30000）は実 Herdr につながっているので、E2E には使わない。

## 起動

```bash
bun run e2e:serve
```

`http://127.0.0.1:31000/` を Playwright CLI で開く。ポートは `PORT` で変えられる。`HOST` は `127.0.0.1` に固定する。

起動ログの `hwc ready: ... (e2e)` と、設定画面の revision `e2e` で、架空環境であることを確認できる。

## 実環境との分離

| 対象                    | 実環境                                              | E2E                                                                                                                |
| ----------------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Herdr ソケット          | `~/.config/herdr/herdr.sock`                        | `HERDR_SOCKET_PATH` を一時ディレクトリへ向ける                                                                     |
| pi セッション           | 実セッションの JSONL                                | `e2e/fixtures/scenario.ts` が一時ディレクトリへ書く                                                                |
| pi モデルカタログ       | 各 agent dir の `models-store.json` / `models.json` | 同 fixture が `<root>/agent/models-store.json` へ書く。上書き設定もこの架空 agent dir だけに置く                   |
| pi モデル・effort・上限 | `pi --offline --list-models` / RPC                  | `<root>/bin/pi` が `e2e/fake-pi.ts` を起動する。E2E の `PATH` の先頭に置き、実 Pi は起動しない                     |
| GitHub の PR            | 実リポジトリの remote と `gh` の認証                | `<root>/bin/gh` が `e2e/fake-gh.ts` を起動し、ブランチごとの架空の PR を返す                                       |
| Codex App Server        | `codex app-server --stdio`                          | `<root>/bin/codex` が `e2e/fake-codex.ts` を起動する。`CODEX_HOME` も `<root>/codex` に向け、実 Codex は起動しない |
| OpenCode サービス       | `~/.local/state/opencode/service.json`              | `HWC_OPENCODE_SERVICE` を一時ディレクトリへ向ける                                                                  |
| ブランチ                | 実リポジトリの `.git/HEAD`                          | 一時ディレクトリの `.git/HEAD`                                                                                     |
| git のリモートと差      | 実リポジトリの remote と認証                        | `<root>/bin/git` が `e2e/fake-git.ts` を起動し、`<root>/git-state.json` の架空の upstream / ahead / behind を返す  |
| 添付の保存先            | `~/.local/state/hwc`                                | `HWC_STATE_DIR` を一時ディレクトリへ向ける                                                                         |
| ポート                  | 30000                                               | 31000                                                                                                              |

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
を流す。hwc の既読はこの遷移で行が消える（窓口の `done` は `idle` の行として残る）。
`pane.send_keys` は `esc` を受けるとペインの `agent_status` を `idle` に戻し、`pane.updated` を流す。
BFF は実 Herdr と同じようにイベントで状態を取り直す。

`<root>/bin/git` は `e2e/fake-git.ts` を起動する。`remote` と `for-each-ref` は
`<root>/git-state.json` の架空の upstream / ahead / behind を返し、`fetch` は何も変えない。
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
エージェントとセッション参照を外し、`pane.updated` を流す。要対応のペインは実 Herdr と同じく
`agent_blocked` で拒否する。最後のエージェントの終了要求、拒否、残ったシェルの削除禁止を確認する。

`pane.send_input` は送信 text を端末出力へ追記し、`agent_session`（`kind: "path"`）を持つペインでは架空セッションの JSONL にも追記する。追記するのは user メッセージ 1 行だけで、それまでの葉を `parentId` にする。確定後の送信カードを画面で確かめるために要る。セッションがまだ無いペインでは、この追記の前にヘッダと `model_change` / `thinking_level_change` を書く。

`frontend` の架空セッションは、最後のターンが失敗した状態（`stopReason: "error"` と `errorMessage`、本文は空）で終わる。同じ失敗をリトライの回数だけ並べてあり、Web では 1 行に畳まれて「3 回」と出る。その行が圧縮後の usage を変えないことも確かめる（[ADR 0039](adr/0039-chat-error-rows.md)）。

その手前の assistant メッセージは、チェックアウト内の `docs/preview/app-icon.png` を本文で指す。この画像は実在する PNG（`src/client/assets/apple-touch-icon.png`）を fixture がコピーしたもので、会話にはパスとサムネイルの行が出る（[ADR 0041](adr/0041-agent-message-images.md)）。サムネイルを押すとダイアログで拡大でき、背景・`Esc`・閉じるボタンで閉じる（[ADR 0042](adr/0042-image-preview-dialog.md)）。セッションの葉から `parentId` を遡る読み取りに乗せるため、失敗したターンの鎖もこのメッセージを親にする。

pi のペインでは、あわせてセッションの隣に live の sidecar（`<session>.jsonl.thinking.json`）を書く。まず `waiting` で `working` にし、1.2 秒後に折り返す長さの `thinking` を上書きし、6 秒後に消して `idle` に戻す。実物の pi 拡張はターン中に phase と thinking の末尾を上書きし続ける（[ADR 0035](adr/0035-live-pi-activity.md)）。E2E ではこの 2 段階で、段階の行が会話のスクロール領域の外（入力欄の直上）に出て、スクロールしても残ること、経過時間が右端に固定されること、末尾 2 行だけが出てターン終了で消えることを確かめる。入力欄を 1 行に畳むセルでは thinking を出さず、段階と経過時間だけになる。停止ボタン（`esc`）でも sidecar を消す。

`/compact`（添付注記なし）を受け取ると、実 Herdr の pi 拡張と同じく `agent_status` は `working` にせず、1.2 秒後に架空の compaction をセッションへ追記して `idle` のままにする。hwc 側のローカルな「会話を圧縮しています」と、完了ログの位置・所要時間を E2E で確かめるため、最後の user メッセージを kept の先頭にする。

追記しない条件:

- `agent_session` を持たないペイン（シェルや、会話を読まないペイン）。端末出力にだけ追記する
- text が空、または空白だけの送信
- 添付注記（`<attached_files>`）の無い `/new` と `/compact`（`/compact <指示>` を含む）。会話を残さないか、履歴を置き換える
- 同じく添付注記の無い `/reload`。実 Pi と同じくセッションに何も書かず、`agent_status` も `working` にしない。hwc は控えを履歴に残す（[ADR 0045](adr/0045-pending-echo-turn-grace.md)）

添付を持つペインで `Enter` が送信になるときは、常に本文の送信になる（[ADR 0018](adr/0018-pasted-image-attachments.md)）。タッチ端末では `Enter` が改行になる（[ADR 0037](adr/0037-enter-newline-on-touch.md)）。`/compact` と打っても添付と一緒に送れば本文として扱われるので、注記があるときはコマンドではなく通常本文として追記する。

## ワークツリー作成

スペース見出しの「…」から作るワークツリーは、次の手順で確かめる。

1. `acme-dashboard`（リポジトリ本体）の見出しの「…」を開き、「新しいワークツリー」を選ぶ。
   ダイアログの見出しが「新しいワークツリー」で、ブランチ名と保存先が Herdr 任せである旨が出る。
2. そのまま「作成して起動」を押すと、架空 Herdr にリンクされたスペースが 1 つ増え、hwc が
   その root pane を開く。入力欄のモデル表示は起動時の指定で補われる（ADR 0033）。
3. linked worktree（`acme-dashboard (docs)`）の見出しのメニューには「新しいワークツリー」が無い。
4. 4 ペインのタブを持つスペースでも、「新しいペイン」だけが無効で「新しいワークツリー」は押せる。
   4 枚のタブは既存のダイアログで 2 枚追加して用意してよい。
5. 部分成功は、モデルに `@demo/start-fails` を選んで作成すると確かめられる。ワークツリーと
   root pane は残り、ダイアログに起動失敗の理由と「閉じる」だけが出る。閉じると新しい root pane
   が表示される。
6. `worktree_open_failed`（結果不明）はブラウザのリクエスト差し替えで
   `/api/workspaces/:id/create-worktree` に 502 を返して確かめる。再送のボタンは出ず、「閉じる」だけになる。

## PR のチップ

PR のチップは、1 枚表示の見出しとアクティブ帯のワークツリー見出しに出る。1 枚表示では、狭い画面ではブランチの右、広い画面ではブランチを出さないのでエージェント記号の右に出る。分割セルには出さない。

1. `acme-dashboard` のペインを狭い画面で開く。見出しは `feat/empty-state` と `#481` になる。
2. `#481` をタップすると `https://github.com/example/acme-dashboard/pull/481` が新しいタブで開く。
3. `acme-dashboard (docs)` のペインは `docs/quickstart` だけで、チップは出ない（PR #482 は merged なので出さない）。
4. 広い画面にすると、見出しはブランチを出さず、`#481` だけを出す（一覧がブランチを持っている）。
5. 分割表示にすると、どのセルの見出しにもチップは出ない。

## ワークツリーの概要

一覧のワークツリー見出しには、ブランチの最新 PR のタイトルを出す。チップは open のときだけ、ツリーのメニューは state を問わない。

1. `アクティブ` を開く。`acme-dashboard` の帯の 1 行目に `#481`、2 行目に `Add an empty state to the dashboard` が出る。
2. `#481` のリンク先が `https://github.com/example/acme-dashboard/pull/481` であることを確かめる。
3. `acme-dashboard (docs)` の帯には `Write the quickstart guide` が出て、`#482` は出ない（merged のため）。
4. `すべて` に切り替える。`acme-dashboard` の見出しの 2 行目が同じタイトルになる。`…` を開くと `PR #481 を開く` があり、リンク先が同じ URL である。
5. PR の無い `scratch` の見出しは、今までどおりペイン数だけを出す。

## 読み幅

広い画面では、本文・ペインの見出し・入力欄・実行中や閲覧のみの行を読み幅の列に中央寄せする（[ADR 0045](adr/0045-wide-chat-measure.md)）。

1. 900px 以上の幅でペインを開く。本文・見出し・入力欄・実行中の段階の行の左端と右端が一致し、中央の 832px に収まる。
2. 分割して表示にすると、各セルは 24px の余白に揃う。
3. 900px 未満では左右 16px のまま変わらない。

## データを変える

`e2e/fixtures/scenario.ts` を編集する。ワークスペース、タブ、ペイン、端末出力、pi セッション、ブランチはすべてここで作る。

実在のユーザー名・ホスト名・リポジトリ名・パスを書かない。スクリーンショットに写る値はすべて架空にする。

### 実行中のモデルカタログを変える

モデル上限の追従は、起動ログの `hwc e2e fixture: <root>` が示す架空カタログだけを書き換えて確かめる。実際の Pi の agent dir は使わない。

1. `bun run e2e:serve` で起動し、設定画面の revision が `e2e` であることを確認する。
2. `frontend` ペインを表示する。初期データには圧縮後の usage があり、コンテキストは `12k/200k (6.0%)` になる。狭い表示では割合だけになる。
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

4. ペインを可視状態に保ち、次のポーリングで `12k/1.0M (1.2%)` に変わることを確認する。working は 2 秒 / idle は 5 秒周期なので、待ち時間は最大 5 秒程度に通信・処理時間を加えたものとする。BFF の再起動・会話 JSONL への追記・ブラウザのリロードは行わない。
5. 同じ操作で `contextWindow` を `200_000` に戻し、上限と割合も元に戻ることを確認する。

override の追加・変更・削除や読み取り失敗からの復旧、ETag の安定性は BFF の unit / API テストで確認する。

## 禁止

- 実 Herdr につながった BFF（:30000）の画面をスクリーンショットに撮らない。
- 実 pi セッションを fixture にコピーしない。
- 架空環境の確認なしに、E2E の画像を PR へ貼らない。
