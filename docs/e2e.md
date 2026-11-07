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
| Codex App Server        | `codex app-server --stdio`                          | `<root>/bin/codex` が `e2e/fake-codex.ts` を起動する。`CODEX_HOME` も `<root>/codex` に向け、実 Codex は起動しない |
| OpenCode サービス       | `~/.local/state/opencode/service.json`              | `HWC_OPENCODE_SERVICE` を一時ディレクトリへ向ける                                                                  |
| ブランチ                | 実リポジトリの `.git/HEAD`                          | 一時ディレクトリの `.git/HEAD`                                                                                     |
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
フォーカスを移して `pane.focused` を流す。
`pane.send_keys` は `esc` を受けるとペインの `agent_status` を `idle` に戻し、`pane.updated` を流す。
BFF は実 Herdr と同じようにイベントで状態を取り直す。

シェルペインの「…」メニューには「出力をクリア」が出る。選ぶと BFF が `pane.clear` を呼び、
架空の端末出力は最後の 1 行（プロンプト）だけになる。hwc はペイン詳細の実行口から直ちに
出力を読み直し、メニューを閉じる。エージェントのペインにはこの項目を出さない。

`scratch` の `folder-trust` と `folder-trust-saved` は、架空の Codex のフォルダ信頼確認を表示する。前者は会話なし、後者は保存済み会話を持つが `idle` のまま確認待ちになる。「信頼して続行」の Enter を受けると確認を消し、前者には空の会話を作って `idle` にする。「ターミナルで操作」では架空 Herdr へのキー送信がなく、確認が残ることを確かめる。表示するパスと注意文は `e2e/fixtures/folder-trust.ts` の架空データだけを使う。

`scratch` の `codex-start` は、会話 ID がまだない起動直後の Codex を表す。通常の入力待ちなら端末出力と入力欄が表示され、最初のメッセージを送れることを確認する。

モデル選択では、`pane.get` が fixture の cwd を返す。Pi の一覧は架空 CLI から、OpenCode の一覧と新規セッションは `e2e/fake-opencode.ts` の loopback サービスから読み書きする。候補の正は `e2e/fixtures/scenario.ts` の `STARTUP_MODELS`。`agent.start` は受け取った引数を架空の端末出力にも残し、モデル指定した OpenCode には架空のセッション参照を付ける。

OpenCode の未起動表示は、架空の `<root>/opencode/service.json` だけを一時退避してダイアログを開き、「OpenCode サービス未起動」と出ることを確認する。モデル欄は無効でもデフォルト起動は選べ、サービスの自動起動は行わない。接続情報を戻してダイアログを開き直すとモデル一覧が復帰することも確かめる。

effort は同 fixture のエージェント別候補を使う。モデルを選択したときだけ候補が読まれ、モデル・エージェント・シェルの切り替えで指定が解除されることを確かめる。`@demo/beam-small` は effort 非対応、長いモデル名は選択肢が異なるモデルを表す。`@demo/start-fails` は起動に失敗するモデルで、`agent.start` が `agent_spawn_failed` を返す。新しいペインやワークツリーの部分成功（シェルを残して理由を出す）を、実 CLI に触れずに確かめるために使う。Pi は架空 RPC の `get_state` / `get_available_thinking_levels`、Codex は `model/list`、OpenCode は `variants` を通す。Pi は実物と同じく、最初のメッセージを送るまで架空セッションを作らない。起動したペインのチャットのモデル・effort 表示は、送信前は BFF が起動時の指定で補い（[ADR 0033](adr/0033-launch-model-before-first-message.md)）、送信後は架空セッションに記録された値になる。取得失敗・遅い応答によるモデル間の取り違えはブラウザのリクエスト差し替えで確かめる。

Codex のモデル一覧と会話は架空 App Server の JSON-RPC を通す。初期化後の `config/read` / `model/list` / `thread/read` / `thread/turns/list` にだけ応答する。モデル指定した新規ペインは、そのモデルを架空の thread に記録する。入力は本番と同じ Herdr の `pane.send_input` 経由で受け、架空の user と assistant の item を追加する。チャット表示、送信後の確定、起動時のモデル引数を、実 Codex や実会話へ触れずに確認する。

`pane.process_info` は親シェルと別のフォアグラウンドジョブの架空 PID を返す。
`agent.prompt` は既知のエージェントへの `/quit` だけを受け付け、ペイン・タブ・スペースを残して
エージェントとセッション参照を外し、`pane.updated` を流す。要対応のペインは実 Herdr と同じく
`agent_blocked` で拒否する。最後のエージェントの終了要求、拒否、残ったシェルの削除禁止を確認する。

`pane.send_input` は送信 text を端末出力へ追記し、`agent_session`（`kind: "path"`）を持つペインでは架空セッションの JSONL にも追記する。追記するのは user メッセージ 1 行だけで、それまでの葉を `parentId` にする。確定後の送信カードを画面で確かめるために要る。セッションがまだ無いペインでは、この追記の前にヘッダと `model_change` / `thinking_level_change` を書く。

`frontend` の架空セッションは、最後のターンが失敗した状態（`stopReason: "error"` と `errorMessage`、本文は空）で終わる。同じ失敗をリトライの回数だけ並べてあり、Web では 1 行に畳まれて「3 回」と出る。その行が圧縮後の usage を変えないことも確かめる（[ADR 0038](adr/0038-chat-error-rows.md)）。

pi のペインでは、あわせてセッションの隣に live の sidecar（`<session>.jsonl.thinking.json`）を書く。まず `waiting` で `working` にし、1.2 秒後に折り返す長さの `thinking` を上書きし、6 秒後に消して `idle` に戻す。実物の pi 拡張はターン中に phase と thinking の末尾を上書きし続ける（[ADR 0035](adr/0035-live-pi-activity.md)）。E2E ではこの 2 段階で、返答待ちの行が phase の切り替わりで高さも位置も変えないこと（thinking 用の 2 行分を先に確保している）と、末尾 2 行だけが出てターン終了で消えることを確かめる。停止ボタン（`esc`）でも sidecar を消す。

`/compact`（添付注記なし）を受け取ると、実 Herdr の pi 拡張と同じく `agent_status` は `working` にせず、1.2 秒後に架空の compaction をセッションへ追記して `idle` のままにする。hwc 側のローカルな「会話を圧縮しています」と、完了ログの位置・所要時間を E2E で確かめるため、最後の user メッセージを kept の先頭にする。

追記しない条件:

- `agent_session` を持たないペイン（シェルや、会話を読まないペイン）。端末出力にだけ追記する
- text が空、または空白だけの送信
- 添付注記（`<attached_files>`）の無い `/new` と `/compact`（`/compact <指示>` を含む）。会話を残さないか、履歴を置き換える

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
