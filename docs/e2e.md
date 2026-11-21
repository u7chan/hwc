# E2E

E2E のスクリーンショットを PR に貼るため、実 Herdr のワークスペース名・ブランチ・ユーザー名・パス・会話を画面に出さない。開発用の BFF（:30000）は実 Herdr につながっているので、E2E には使わない。

## 起動

```bash
bun run e2e:serve
```

`http://127.0.0.1:31000/` を Playwright CLI で開く。ポートは `PORT` で変えられる。`HOST` は `127.0.0.1` に固定する。

起動ログの `hwc ready: ... (e2e)` と、設定画面の revision `e2e` で、架空環境であることを確認できる。

## 実環境との分離

| 対象                                                               | 実環境                                              | E2E                                                                                                                                                                                                           |
| ------------------------------------------------------------------ | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Herdr ソケット                                                     | `~/.config/herdr/herdr.sock`                        | `HERDR_SOCKET_PATH` を一時ディレクトリへ向ける                                                                                                                                                                |
| pi セッション                                                      | 実セッションの JSONL                                | `e2e/fixtures/scenario.ts` が一時ディレクトリへ書く                                                                                                                                                           |
| pi モデルカタログ                                                  | 各 agent dir の `models-store.json` / `models.json` | 同 fixture が `<root>/agent/models-store.json` へ書く。上書き設定もこの架空 agent dir だけに置く                                                                                                              |
| pi モデル・effort・上限                                            | `pi --offline --list-models` / RPC                  | `<root>/bin/pi` が `e2e/fake-pi.ts` を起動する。E2E の `PATH` の先頭に置き、実 Pi は起動しない                                                                                                                |
| GitHub の PR                                                       | 実リポジトリの remote と `gh` の認証                | `<root>/bin/gh` が `e2e/fake-gh.ts` を起動し、ブランチごとの架空の PR を返す                                                                                                                                  |
| Codex App Server                                                   | `codex app-server --stdio`                          | `<root>/bin/codex` が `e2e/fake-codex.ts` を起動する。`CODEX_HOME` も `<root>/codex` に向け、実 Codex は起動しない                                                                                            |
| OpenCode サービス                                                  | `~/.local/state/opencode/service.json`              | `HWC_OPENCODE_SERVICE` を一時ディレクトリへ向ける。`<root>/bin/opencode` が `e2e/fake-opencode-cli.ts` を起動し、`service start` だけを受けて架空サービスの接続情報を戻す。実 OpenCode のサービスは起動しない |
| Claude の transcript                                               | `~/.claude/projects/<project>/<session uuid>.jsonl` | `CLAUDE_CONFIG_DIR` を `<root>/claude` へ向け、fixture が架空の transcript と添付を書く                                                                                                                       |
| Claude のモデルラベル                                              | `claude --print` の `list_models`                   | `<root>/bin/claude` が `e2e/fake-claude.ts` を起動し、架空の alias 解決だけを返す。実 CLI は起動しない                                                                                                        |
| ブランチ                                                           | 実リポジトリの `.git/HEAD`                          | 一時ディレクトリの `.git/HEAD`                                                                                                                                                                                |
| git のリモートと差                                                 | 実リポジトリの remote と認証                        | `<root>/bin/git` が `e2e/fake-git.ts` を起動し、`<root>/git-state.json` の架空の remote URL / upstream / ahead / behind を返す                                                                                |
| 状態ディレクトリ（添付・ペイン時刻・通知設定・新しいペインの既定） | `~/.local/state/hwc`                                | `HWC_STATE_DIR` を一時ディレクトリへ向ける                                                                                                                                                                    |
| Discord Webhook（通知のテスト・自動送信）                          | 実 Discord のチャンネル                             | `HWC_E2E_DISCORD_WEBHOOK_SINK` を一時ファイルへ向け、POST せず送信内容を追記する                                                                                                                              |
| ポート                                                             | 30000                                               | 31000                                                                                                                                                                                                         |

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
- `workspace.create`
- `workspace.close`
- `workspace.move_block`

`pane.clear` は架空の端末出力を最後の 1 行だけにして、実 Herdr の画面・スクロールバックのクリアを模す。`pane.close` はスナップショットからペインを消して `pane.closed` を流す。`worktree.remove` は
linked worktree のスペースをスナップショットから取り除き、`workspace.closed` を流す（実際の
チェックアウトのフォルダには触らない）。`worktree.create` は起点スペースの worktree 情報、
または cwd と架空 git に登録したリポジトリから、リンクされたスペース・タブ・root pane をスナップショットに
足して `workspace.created` / `pane.created` を流す（実際の `git worktree add` はしない）。
起点に worktree 情報が無ければ補い、`workspace.updated` も流す。
`workspace.create` は `cwd` を作業ディレクトリにしたスペース・タブ・root pane を足して、`workspace.created` / `pane.created` を流す。worktree 情報は持たせない。
`pane.split` は
`target_pane_id` のタブにシェルペインを 1 枚足し、`pane_info` を返して `pane.created` を流す。
`pane.layout` はそのタブのセルを等幅のグリッドとして返す（E2E 用の固定形で、実際の分割方向は
BFF の unit で確かめる）。`pane.rename` はラベルを変えて `pane.updated` を流す。`agent.start` は
架空のエージェントをペインへ付け、`pane.updated` を流す。分割したペインでも既存のシェルペインでも
同じで、後者の場合はペインを増やさない。Codex は架空の thread id と空の会話を
用意し、既存の `review` ペインには架空の user / assistant の会話を入れる。`agent.focus` は
フォーカスを移して `pane.focused` を流す。実 Herdr と同じく seen も進むので、対象が `done` の
ときは `idle` に戻し、そのタブとスペースの集約状態を残りのペインから引き直して `pane.updated`
を流す。hwc の既読はこの遷移で完了から待機に変わる（行そのものは残る）。
`pane.send_keys` は `esc` を受けるとペインの `agent_status` を `idle` に戻し、`pane.updated` を流す。Claude のペインで応答待ちの sidecar（`<root>/claude/pending/<session uuid>.json`）に質問があれば、実機の Claude Code と同じく、assistant の tool_use と `is_error` の tool_result と user の `[Request interrupted by user for tool use]` を transcript へ書く（sidecar は残す。Esc は hook を呼ばないため）。`pane.send_input` は Claude のペインでは送信 text を transcript の user として追記し、sidecar を消す（`UserPromptSubmit` の hook に相当）。質問への回答（[ADR 0099](adr/0099-answer-ask-user-question.md)）は、この 2 つを通して確かめられる。
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

モデル選択では、`pane.get` が fixture の cwd を返す。Pi の一覧は架空 CLI から、OpenCode の一覧と新規セッションは `e2e/fake-opencode.ts` の loopback サービスから読み書きする。候補の正は `e2e/fixtures/scenario.ts` の `STARTUP_MODELS`。Claude の候補は hwc の固定リスト（エイリアスと effort の段階）で、サービスは起動しない。表示名は `<root>/bin/claude` の `list_models` から読む（[ADR 0117](adr/0117-claude-model-labels-from-cli.md)）。`agent.start` は受け取った引数を架空の端末出力にも残し、モデル指定した OpenCode には架空のセッション参照を付ける。

OpenCode のサービスの自動起動は、架空の `<root>/opencode/service.json` だけを一時退避してダイアログを開き、そのままモデル一覧が出ることで確かめる。PATH 上の架空の `opencode`（`e2e/fake-opencode-cli.ts`）が `service start` だけを受け、控えの `service.fixture.json` から接続情報を戻す（[ADR 0105](adr/0105-opencode-service-autostart.md)）。起動失敗の表示は、`service.json` と `service.fixture.json` の両方を退避して開き、「OpenCode サービスを起動できませんでした。再取得すると起動し直します。」と「再取得」が出ることを確認する。モデル欄は無効で、作成ボタンも押せない（[ADR 0104](adr/0104-launch-with-explicit-model.md)）。控えを戻して「再取得」を押すと、ダイアログを開き直さずにモデル一覧が復帰することも確かめる。設定画面の「エージェント」→「OpenCode」でも同じ表示と再取得になる。

effort は同 fixture のエージェント別候補を使う。モデルを選択したときだけ候補が読まれ、モデル・エージェント・シェルの切り替えで選択が解除されることを確かめる。effort に対応するモデルでは、effort も選ぶまで作成ボタンを押せない。`@demo/beam-small` は effort 非対応、長いモデル名は選択肢が異なるモデルを表す。`@demo/start-fails` は起動に失敗するモデルで、`agent.start` が `agent_spawn_failed` を返す。新しいペインとワークツリーの起動失敗（シェルを残してペイン内に行を出す）を、実 CLI に触れずに確かめるために使う。Pi は架空 RPC の `get_state` / `get_available_thinking_levels`、Codex は `model/list`、OpenCode は `variants` を通す。Pi は実物と同じく、最初のメッセージを送るまで架空セッションを作らない。起動したペインのチャットのモデル・effort 表示は、送信前は BFF が起動時の指定で補い（[ADR 0033](adr/0033-launch-model-before-first-message.md)）、送信後は架空セッションに記録された値になる。モデルを指定せずに起動した Pi は、チャット画面を開いたときに架空 RPC の `get_state` から既定を読み、解決中はスケルトンが出る（[ADR 0087](adr/0087-default-model-display.md)）。hwc の画面はモデルを指定して起動するので、この経路は起動 API を直接呼んだときだけ通る。既定は `DEFAULT_PI_MODEL` / `DEFAULT_PI_EFFORT` で、架空 Herdr が `agent.start` に記録する値と揃えてある。取得失敗・遅い応答によるモデル間の取り違えはブラウザのリクエスト差し替えで確かめる。

Claude の会話は `CLAUDE_CONFIG_DIR`（E2E では `<root>/claude`）配下の `projects/<project>/<session uuid>.jsonl` を読む（[ADR 0097](adr/0097-claude-chat-transcript.md)）。fixture が架空の transcript を 2 本書く。会話を表示する `quickstart`（`w2:t2` の `w2:p2`、待機）は、`w2:t1` に足すと分割セルになり読み幅が半分になるため別タブに置く。transcript は 248 往復の履歴（500 メッセージの上限を超え、`truncated` になる）と、そのあとの 6 行（同じ `message.id` の text 連結、tool_result、`isMeta`、添付チップ、書式の崩れた注記）で作る。添付付きの user の 1 行は、実機と同じく貼り付けの `<pasted_content>` で包んで書く。要対応の `writer`（`w2:p1`）には、待ちに入る前の会話で終わる transcript と、質問を持つ hook の sidecar を足し、`blocked` のまま応答待ちのカードを出す（[ADR 0112](adr/0112-claude-pending-in-chat.md)、下の「blocked + 応答待ちの作り方」）。tool_use と tool_result の突き合わせ、input の検証、上限は `src/server/chat/claude.test.ts` と `claude-sidecar.test.ts` で確かめる。実ホームの `~/.claude` は読まない。

Codex のモデル一覧と会話は架空 App Server の JSON-RPC を通す。初期化後の `config/read` / `model/list` / `thread/read` / `thread/turns/list` にだけ応答する。モデル指定した新規ペインは、そのモデルを架空の thread に記録する。入力は本番と同じ Herdr の `pane.send_input` 経由で受け、架空の user と assistant の item を追加する。チャット表示、送信後の確定、起動時のモデル引数を、実 Codex や実会話へ触れずに確認する。

`pane.process_info` は、エージェントのペインでは親シェルと別の前景グループ（エージェント自身）を返す。シェルのペインは、fixture の `foreground` にコマンドを持つときだけ別グループになり、それ以外はプロンプトで待っている形を返す。`pane.send_keys` が `C-c` を受けると、そのペインの前景コマンドを消して端末出力に `^C` を追記する。
`agent.prompt` は既知のエージェントへの `/quit` だけを受け付け、ペイン・タブ・スペースを残して
エージェントとセッション参照を外し、`pane.updated` を流す。実 Herdr と同じく、終了したエージェントの
画面は消さずに末尾へシェルのプロンプトを足す。要対応のペインは実 Herdr と同じく
`agent_blocked` で拒否する。最後のエージェントの終了要求、拒否、残ったシェルの削除禁止を確認する。

`frontend` の user メッセージの 1 通は `<attached_files>` 注記を持ち、`empty-state-reference.zip` が履歴のチップに出る。大きさは fixture が `<root>/attachments/w1:p1/` に置いた 2MB の実ファイルから BFF が `stat` で引くので、チップは `2.0MB` になる。

`pane.send_input` は送信 text を端末出力へ追記し、`agent_session`（`kind: "path"`）を持つペインでは架空セッションの JSONL にも追記する。`frontend` の架空セッションには末尾に `hwc-capabilities` を置き、`/hwc-rewind <entryId> <requestId>` は user メッセージではなく、対象メッセージの親を `leafId` にした `hwc-rewind` の marker を追記する。その後に送る編集後の本文は marker の子になる。追記するのは user メッセージ 1 行だけで、それまでの葉を `parentId` にする。確定後の送信カードを画面で確かめるために要る。セッションがまだ無いペインでは、この追記の前にヘッダと `model_change` / `thinking_level_change` を書く。

`frontend` の架空セッションは、最後のターンが失敗した状態（`stopReason: "error"` と `errorMessage`、本文は空）で終わる。同じ失敗をリトライの回数だけ並べてあり、Web では 1 行に畳まれて「3 回」と出る。その行が圧縮後の usage を変えないことも確かめる（[ADR 0039](adr/0039-chat-error-rows.md)）。

その手前の assistant メッセージは、チェックアウト内の `docs/preview/app-icon.png` を裸のパスで、`docs/preview/empty-state.png` と `docs/preview/empty-state-light.png` を画像記法で指す。どれも実在する PNG（`src/client/assets/apple-touch-icon.png`）を fixture がコピーしたもの。連続した画像記法は本文のその位置に 1 行で並び、押すとダイアログで拡大でき、背景・`Esc`・閉じるボタンで閉じる（[ADR 0071](adr/0071-inline-message-images.md) / [ADR 0042](adr/0042-image-preview-dialog.md)）。裸のパスのほうは位置が無いので、今までどおりメッセージの末尾にサムネイルの行が出る（[ADR 0041](adr/0041-agent-message-images.md)）。セッションの葉から `parentId` を遡る読み取りに乗せるため、失敗したターンの鎖もこのメッセージを親にする。

送信前の添付チップも同じように拡大できる。入力欄に画像を貼り付けるかドロップし、アップロードが終わってサムネイルが出てから押すとダイアログが開く。`Esc` で閉じるとサムネイルへフォーカスが戻り、チップは残ったままになる。チップは送信するまで残り、別のペインを開いて戻っても同じチップが出る（[ADR 0018](adr/0018-pasted-image-attachments.md)）。

画像以外のファイルも貼り付け・ドロップ・+ から添付できる。チップには元のファイル名と大きさが出て、押しても何も開かない。送信すると履歴にも名前と大きさのチップが並び、`GET /api/panes/:id/attachments/<name>` は 400 を返す（配信するのは画像 3 形式だけ。[ADR 0080](adr/0080-file-attachments.md)）。履歴の大きさは BFF が保存済みファイルを `stat` した実バイト数で、入力欄は選んだ `File.size`。消えたファイルは大きさだけ落ちて名前が残る。

入力欄の + からは、同じ経路でファイルを選べる。ファイル入力に `accept` は無く、`dropActionFrom` と `takeFiles` を通る。Playwright では「ファイルを追加」を押した後の File chooser に `upload` でファイルを渡す。名前は `X-HWC-Filename`（percent-encode）で送られ、保存名になる。

`+` の「プロジェクトを選ぶ」は、`<root>/bin/git` の `ls-files` が返すマニフェストから候補を作る。架空 Herdr の `pane.get` は `…/work/acme-dashboard` を cwd として返し、偽 git はその cwd に対して `package.json`、`packages/api/package.json`、`packages/web/pyproject.toml`、`apps/desktop/Cargo.toml` を返す。cwd 自身の `package.json` は候補から外れるので、`desktop`、`api`、`web` の 3 件になる。実ファイルは作らない。

pi のペインでは、あわせてセッションの隣に live の sidecar（`<session>.jsonl.thinking.json`）を書く。まず `waiting` で `working` にし、1.2 秒後に折り返す長さの `thinking` と `tokPerSecond: 42.3` を上書きし、6 秒後に消して `idle` に戻す。実物の pi 拡張はターン中に phase・thinking の末尾・生成速度を上書きし続ける（[ADR 0035](adr/0035-live-pi-activity.md)）。E2E ではこの 2 段階で、段階の行が会話のスクロール領域の外（入力欄の直上）に出て、スクロールしても残ること、生成速度が経過時間の左に出て右端の時間が動かないこと、thinking がまだ無い待機中も帯の高さが変わらず、末尾 2 行だけが出てターン終了で消えることを確かめる。入力欄を 1 行に畳むセルでは thinking と生成速度を出さず、段階と経過時間だけになる。停止ボタン（`esc`）でも sidecar を消す。

Claude のペインでは、フィクスチャ専用の入力 `/activity`（添付注記なし）が同じ役割を持つ。実物と同じく prompt・`api-request`・assistant・`tool_use`・`tool_result` を時間差で架空の transcript へ追記し、段階の切り替わりと 10 秒の保持を確かめられるようにする（[ADR 0100](adr/0100-claude-live-activity.md)）。架空の transcript の `version` は 2.1.328 に揃えてある。

`/done`（添付注記なし）はフィクスチャ専用の入力で、実 Herdr には無い。受け取ったペインを `done` にする。実 Herdr の `done` は既読でしか `idle` に戻らず、hwc からは作れないため、一覧の終了時刻と端末間の一致を確かめる入口として置く。

`/compact`（添付注記なし）を受け取ると、実 Herdr の pi 拡張と同じく `agent_status` は `working` にせず、1.2 秒後に架空の compaction をセッションへ追記して `idle` のままにする。hwc 側のローカルな「会話を圧縮しています」と、完了ログの位置・所要時間を E2E で確かめるため、最後の user メッセージを kept の先頭にする。

追記しない条件:

- `agent_session` を持たないペイン（シェルや、会話を読まないペイン）。端末出力にだけ追記する
- text が空、または空白だけの送信
- 添付注記（`<attached_files>`）の無い `/new` と `/compact`（`/compact <指示>` を含む）。会話を残さないか、履歴を置き換える
- 同じく添付注記の無い `/reload`。実 Pi と同じくセッションに何も書かず、`agent_status` も `working` にしない。hwc は控えを履歴に残す（[ADR 0045](adr/0045-pending-echo-turn-grace.md)）
- 添付注記の無い `/hwc-rewind <entryId> <requestId>`。専用の marker を追記し、本文としては残さない
- 同じく添付注記の無い `/activity`。Claude の transcript にだけ進行行を追記し、user メッセージとしては残さない

添付を持つペインで `Enter` が送信になるときは、常に本文の送信になる（[ADR 0018](adr/0018-pasted-image-attachments.md)）。タッチ端末では `Enter` が改行になる（[ADR 0037](adr/0037-enter-newline-on-touch.md)）。`/compact` と打っても添付と一緒に送れば本文として扱われるので、注記があるときはコマンドではなく通常本文として追記する。

## 入力の + メニュー

入力欄の下部左端の + から、会話のコマンドを実行し、定型文・ファイル・プロジェクトを追加する（[ADR 0055](adr/0055-composer-add-menu.md)、[ADR 0056](adr/0056-project-picker.md)、[ADR 0057](adr/0057-composer-conversation-commands.md)、[ADR 0110](adr/0110-composer-templates.md)）。

1. `review` を開き、+ を押す。+ の上に「新しい会話」「会話を圧縮」、区切り、「定型文を引用」「ファイルを追加」「プロジェクトを選ぶ」が開き、`Escape` か外側のタップで閉じる。`frontend`（実行中）では 2 つのコマンドが無効になり、補助文に「実行中は使えません」が出る。`new`（空の会話）では「会話が始まると使えます」になる。
2. `review` で「新しい会話」を選ぶと確認ダイアログが開く。「キャンセル」では会話が残り、「始める」では会話が空になる。チップや直接入力の `/new` は確認を挟まない。ペイン見出しの「…」メニューには 2 つのコマンドが出ない。
3. `review` で「会話を圧縮」を選ぶと `/compact` が送られ、履歴に控えと「会話を圧縮しています」が出る。`review` は Codex なので、架空 Herdr は完了の compaction を追記しない。進捗行の「中断」でローカルの表示を畳む。指示付きの圧縮はチップか直接入力で行う。
4. 「ファイルを追加」を選び、`src/client/assets/apple-touch-icon.png` をアップロードする。入力欄の上に添付チップが出て、書きかけの本文は残る。4 件添付すると「ファイルを追加」が無効になり、理由が補助文に出る。同じ手順で `report.zip`（Playwright の `setInputFiles` に buffer と名前を渡す）を選ぶと、画像と同じ枚数の枠で名前と大きさのチップになる。10MB を超える画像と 25MB を超えるファイルは、送信前に notice で断られる。
5. 「プロジェクトを選ぶ」を選ぶ。`desktop`、`api`、`web` が名前と相対パスで並ぶ。検索欄に `web` と入れると `web` だけに絞り込まれる。
6. `web` を選ぶとダイアログが閉じ、本文に `./packages/web/` が入り、入力欄にフォーカスが戻る。`Escape` で閉じた場合は + にフォーカスが戻り、本文は変わらない。
7. 会話を持つペインを選び、分割セルで入力欄が 1 行に畳まれる幅にすると + は出ない。2 つのコマンドは `/` と打ったときの候補だけになる。狭い画面でも送信ボタンは右端に残り、モデル名だけが省略される。
8. 空表示と取得失敗は、ブラウザのリクエスト差し替えで確かめる。`frontend` の `/api/panes/w1:p1/projects` を `{"projects":[],"truncated":false}` にすると「このディレクトリ配下に他のプロジェクトはありません。」、502 にすると再試行が出る。

## Claude の会話

Claude の transcript の射影は、`acme-dashboard (docs)` の `quickstart`（`w2:t2` の `w2:p2`、待機）で確かめる（[ADR 0097](adr/0097-claude-chat-transcript.md)）。

架空 Herdr の `agent.start` は Claude の session / transcript を作らないため、E2E で hwc から Claude を起動すると 10 秒後に `unknown`（起動を確認できません）へ落ちる。実機（Herdr 0.9.5 / Claude Code 2.1.327、2026-11-19）では `agent.start` の直後に `agent_session`（`kind: "id"`）が付き、`pane.chat` が true になる。fake に起動時のセッションを足すのは、起動直後の会話が要る E2E の拡張で行う。

1. `すべて` から `acme-dashboard (docs)` を開き、`quickstart` のペインを開く。会話の先頭に「古い会話は省略されています」が出て、本文は transcript の末尾 500 件になる。「クイックスタートの手順を、今のコマンドに合わせて見直してください。」の user 行、同じ `message.id` の text を連結した agent 行（「まず `bun install` …」「そのあと `bun run dev` …」が 1 行）、`quickstart-review.pdf` のチップが出る。`<pasted_content>` で包んだ行は「その 2 点でお願いします。」だけが本文になり、タグと前後の空行は出ない。tool_use / tool_result / thinking / 内部エントリの行は無い。
2. 「この行は注記の書式が崩れています。」の行は本文だけで、`<attached_files>` も絶対パスも残らない。チップも出ない。
3. 同じペインで 2 回目の取得が 304 になることを、DevTools のネットワークで `/api/panes/w2:p2/chat` の応答を見て確かめる。会話が変わらない間は 200 が返らない。
4. 端末出力へのフォールバックは、起動ログの `hwc e2e fixture: <root>` が示す `<root>/claude/projects/<project>/<session uuid>.jsonl` を消して確かめる。次の取得が 502 になり、本文が `claude · quickstart` の端末出力に切り替わる。ファイルを戻すと会話に戻るが、見つからなかった結果を 4 秒だけ覚えるので、戻した直後は端末出力のままになる（[ADR 0103](adr/0103-claude-transcript-miss-on-send.md)）。
5. `acme-dashboard (docs)` の `writer`（`w2:t1`）は `blocked` で、質問は hook の sidecar（`<root>/claude/pending/<session uuid>.json`）にあり、transcript には質問の tool_use が無い（実機の Claude Code は待ちの間これを書かない。[ADR 0112](adr/0112-claude-pending-in-chat.md)）。会話は端末出力へ切り替わらず、末尾に「Claude からの質問」のカードが出る。質問ごとにヘッダ・質問文・選択肢（label と description）が並び、複数選択の質問には「複数選べます」が付く。選択肢は押せない。入力欄・引用・添付・`/` の候補は出ず、代わりに「Claude の応答待ちです」の行が出る。transcript にある解決済みの Read の tool_use は、カードにならない。
6. カードの「端末出力を見る」を押すと body が `claude · docs` の端末出力に変わり、上に「端末で応答してください。」と「会話に戻る」が出る。「会話に戻る」で会話とカードに戻る。再読み込みすると会話に戻る（切替はローカルの状態）。
7. 解決は transcript の tool_result で知る（Esc は hook を呼ばない）。起動ログの `hwc e2e fixture: <root>` が示す `<root>/claude/projects/<project>/<session uuid>.jsonl` に、`pending-tool-2` の assistant の tool_use と、`tool_use_id` が同じ tool_result の user を 1 行ずつ追記すると、次の取得（5 秒以内）でカードが消える。架空 Herdr の `agent_status` は `blocked` のままなので、カードが消えたあとは端末出力になり、入力欄は閉じたまま（実機では Esc で `idle` に戻り、入力欄が戻る）。sidecar のファイルが残っていても、カードは戻らない。
8. 応答待ちが読めない `blocked` のペインは、今までどおり端末出力になる。sidecar のファイルを消すと、次の取得でカードが消えて端末出力になる。
9. 質問に答える（[ADR 0099](adr/0099-answer-ask-user-question.md)）。カードの選択肢は押せる。単一選択（見出し）は 1 つだけ、複数選択（範囲）は複数を選べ、選ぶと行の面・チェック・アクセント文字で示す。「その他（自由入力）」を押すと選択肢が外れて入力欄が開き、文字を入れるまで「この内容で答える」は無効のまま。全問に答えて押すと、押した間だけスピナーが出て、架空 Herdr が Esc で質問を閉じ、本文（1 行目が `質問への回答:`、続けて `質問: 選んだラベル` を質問ごとに 1 行）が user の発言として会話に出る。カードは消えて入力欄が戻り、`[Request interrupted by user for tool use]` の行は出ない。ダブルタップしても発言は 1 件。
10. 失敗の表示は、`/api/panes/<id>/answer-question` の応答を差し替えて確かめる（Playwright の `route`。URL の `:` はエンコードされるので `**/api/panes/*/answer-question` で一致させる）。502 は「回答できませんでした。端末で答えてください。」、413 は「回答が長すぎて送れません。短くしてください。」が出て、選択は残り、再度押せる。
11. 空の会話では `/new` `/compact` の候補が消える。fixture の Claude は会話を持つため、この判定は `src/client/commands.test.ts` で確かめる。

## Claude の実行中の段階

Claude の帯は transcript の進行行から導く（[ADR 0100](adr/0100-claude-live-activity.md)）。`quickstart`（`w2:p2`、待機）で確かめる。フィクスチャ専用の入力 `/activity` は実 Herdr には無い。送るとペインを `working` にし、架空の transcript へ 2 秒後に prompt と `api-request`、16 秒後に assistant の本文と `tool_use`、20 秒後に `tool_result` を追記する。prompt の 6 秒後から 500ms ごとに mod と同じ形の速度（`68.4`）を `<root>/claude/live/<session id>.json` へ上書きし、16 秒後に消す（[ADR 0102](adr/0102-claude-live-tok-rate.md)）。実在の `~/.claude` は読まない。

1. `quickstart` を開き、`/activity` を送る。すぐに帯が出て 3 点と経過時間だけになり、その下に thinking 用の 2 行の空きができる。ターンの最初の取得では新しい prompt がまだ書かれていないので、段階は出ない。
2. 2 秒ほどで「考えています」に変わり、続けて経過時間の左に `68.4 tok/s` が出る。応答本文がまだ無いので、2 行の空きは空のまま。16 秒ほどで「Read を実行中」に変わり、速度は消え、1 行目に `quickstart.md` が出る。会話の末尾に同じ「手順を確認しています。」が載るので、帯の 2 行目には重ねて出さない（会話に届くまでの数秒だけ出ることがある）。空きの高さはこの間ずっと同じで、会話の見える範囲が動かない。
3. 20 秒ほどで transcript に `tool_result` が書かれ、次の取得は `activity: null` になる。帯は直前の「Read を実行中」と対象の `quickstart.md` をそのまま保つ（最後に非 null を得てから 10 秒）。
4. 10 秒ほど待つと保持が切れ、段階が消えて 3 点と経過時間だけになる。2 行の空きは残る。
5. 停止ボタンで `idle` に戻すと帯が消える。もう一度 `/activity` を送ってから `/blocked` を送ると、本文が端末出力に変わり、入力欄と帯が消える。`/done` で戻すと会話表示に戻り、帯は出ない。
6. `/compact` を送る（+ のメニューか直接入力）。「会話を圧縮しています」の帯が出て、その下に thinking の 2 行の空きは出ない。`中断` を押すと帯が消えて元の表示に戻る。Claude は `compaction` を返さないので、この表示は中断するまで残る。
7. 分割セル（2 枚以上）では compact になり、Claude でも 2 行の空きを出さず、段階と経過時間だけになる。単体では `showActivityFrame` を `src/client/activity.test.ts` で確かめる。

## 過去の発言の編集

pi のセッションに `hwc-capabilities` があるときだけ、ユーザーメッセージのメタ行に鉛筆が出る（[ADR 0089](adr/0089-pi-message-edit.md)）。`frontend` の架空セッションには capability を置いてある。

1. `frontend` は最初 `working` なので、入力欄から短い本文（例: `あとで確認します`）を送り、6 秒ほどで待機に戻す。`編集の動作を確認します。` の吹き出しにホバーすると、コピーと並んで鉛筆が出る（触れる端末では常に表示）。入力欄に下書き（例: `下書き`）を入れてから鉛筆を押すと、入力欄がその本文に変わり、「編集中」のチップが出る。下書きは消えない。
2. チップの × を押すと入力欄が `下書き` に戻る。もう一度 `編集の動作を確認します。` の鉛筆を押し、本文を `編集後の本文` に書き換えて送信する。架空 Herdr が `/hwc-rewind` の marker を追記し、BFF が編集後の本文を送る。会話は対象の親まで戻り、編集後の本文が新しい枝として出る。`下書き` は入力欄に残る。
3. `review`（Codex）や `new`（空の会話）には鉛筆が出ない。添付付きの発言と最後の発言にも出ない。実行中は出ない。
4. 失敗は `/api/panes/w1:p1/edit-message` の応答を差し替えて確かめる。`{"error":"send_failed","rewound":true}` の 502 では「会話は戻りましたが、送信できませんでした。もう一度送信してください」が出て、編集チップと本文が残る。同じ `requestId` で再送すると成功する。`{"error":"edit_failed"}` の 502 では「編集を開始できませんでした。もう一度お試しください」が出る。

## 定型文

設定で登録した定型文を、入力欄の + から本文へ引用する（[ADR 0110](adr/0110-composer-templates.md)）。

1. 設定の「定型文」で「定型文を追加」を押し、名前と本文を入れて保存する。一覧に行が増え、名前と本文の 1 行目が出る。行を押すと編集フォームが開き、名前を変えて保存すると一覧に反映される。
2. `frontend` を開き、+ を押す。区切りの下の先頭に「定型文を引用」があり、補助文は「設定で登録した文から選ぶ」。押すとダイアログが開く。
3. 定型文のボタンを選ぶと本文プレビューと文字数が出て、「引用する」が押せる。ボタンのタップだけでは入力欄は変わらない。矢印キーでも移動できる。
4. 「引用する」を押すとダイアログが閉じ、入力欄に本文が入り、フォーカスとカーソルが本文の末尾へ移る。送信はしない。
5. 入力欄に書きかけを置いて同じ操作をすると、空行 1 つを挟んで後ろに入る。`/compact` のチップ中は「定型文を引用」が無効になり、補助文に「圧縮の指示には使えません」が出る。
6. 検索に一致しない語（例: `デプロイ`）を入れると「一致する定型文がありません。」が出て、「引用する」が無効になる。検索語を消すとボタンが戻る。`Escape` で閉じると + にフォーカスが戻り、本文は変わらない。
7. 0 件の状態（設定で最後の 1 件を削除）では、+ の「定型文を引用」が無効になり、補助文が「設定で登録できます」になる。
8. 保存の失敗は `PUT /api/templates` を 500 に差し替えて確かめる。設定のフォームは入力を残したまま「保存できませんでした。」を出す。読み込みの失敗は `GET /api/templates` を 502 にすると、設定は「定型文を読み込めませんでした。」と再試行、ダイアログも同じ理由と再試行を出す。

## コンテキスト使用量のパネル

入力欄の右下の割合から、直近の使用量と内訳を開く（[ADR 0036](adr/0036-input-hint-panel.md) / [ADR 0082](adr/0082-context-hint-note-toggle.md)）。

1. 390px で `frontend` を開き、`7.0%` を押す。パネルが開き、注記は出ない。タイトル行の右端に (i) がある。
2. (i) を押すとタイトル直下に注記が 3 行出て、下の 6 行が押し下がる。(i) の背景が `raised` に変わり、`aria-expanded` が `true` になる。もう一度押すと畳まれる。
3. 注記を開いたまま外側を押すとパネルが閉じる。`Escape` では閉じて `7.0%` の札へフォーカスが戻る。札を押し直すと注記は開いたままで、ペインを切り替えて戻ると畳まれている。
4. 高さ 320px では、注記を開いてもパネルの上端は画面から 8px 空き、注記は見えたまま下の行がパネル内でスクロールする。
5. モデル札のコピーボタンは、同じ `.hwc-hint-icon-button` で従来どおり動く。

## 選択ツールバー

PC 幅で会話本文を選ぶと、選択範囲の上に「返信」と「コピー」がアイコン付きで出る。

1. `frontend` の本文をマウスでドラッグする。ドラッグ中はメニューが出ず、ボタンを離すと選択範囲の横の真ん中・上端のすぐ上に出る。クリックだけで選択が消えたときは出ない。
2. 選択したまま本文をスクロールする。メニューは選択に付いて動き、選択が領域の外へ完全に出ると閉じる。窓の幅を変えたときも同じ。
3. `Escape` を押すと閉じ、選択を変えるまで出ない。メニューの外を押したときも閉じる。
4. 「返信」を押すと、選んだ文が `> ` 付きで入力欄の末尾に入り、引用の後ろの空行へカーソルが移る。コメントを書いてから別の箇所を引用すると、2 つの引用とコメントが 1 つの下書きに残る。
5. `EmptyState` のようなインラインコードを含む文を選び、「コピー」を押して入力欄へ貼り付けると、`` `EmptyState` `` のようにバッククォートが戻る。太字・リンク・項目の印・コードブロックのフェンスも同じ。ブロックの一部だけを選んだときは、そのブロックの印を付けない。
6. 押しても選択は外れず、コピーのアイコンが ✓ に変わる。返信の矢印アイコンは変わらない。Ctrl+C の通常のコピーは描画された文のまま。
7. シェルのログ（`shell` ペイン）では「コピー」だけが出て、選んだ字がそのままクリップボードに入る。
8. タッチ端末のエミュレーションでは、選択ツールバーを出さない。

## エージェントの終了

最後のエージェントを終了してもペインとスペースは残る（[ADR 0029](adr/0029-preserve-last-pane.md)）。
終了したエージェントの画面と会話は、シェルに戻った時点で hwc が捨てる（[ADR 0073](adr/0073-clear-exited-agent-screen.md)）。

1. `scratch` の `folder-trust-saved`（Codex、会話あり、待機）だけを残して他の 4 枚を閉じる。
   「…」メニューから 1 枚ずつ閉じてもよいし、`POST /api/panes/:id/close` を直接送ってもよい。
   最後の 1 枚になると、メニューの項目が「エージェントを終了」に変わる。
2. 終了する前に、入力欄に `/` と入れて候補から「会話を圧縮」を選び、チップを出しておく。
   そのまま「エージェントを終了」を押して確認する。ペインとスペースは残り、`agent` が消えて
   入力欄が `$ コマンドを入力` のシェルになる。会話のチップは持ち越さず、送信は無効のまま。
3. 2 秒ほど待つと、終了した Codex の画面が消えて、シェルのプロンプトの行だけになる。
   架空 Herdr の `pane.clear` は最後の 1 行（プロンプト）だけを残す。
4. 入力欄のモデル名とコンテキストが消える。会話ビューではなく端末出力が出ている。

## 新しいペインの作成

1. `frontend` のペイン見出しの「…」から「新しいペイン」を開く。既定が無ければ、モデルは「モデルを選択」のままで「作成して起動」を押せない。エージェント Pi のまま、モデルとエフォートを選んで「作成して起動」を押す。ダイアログはほどなく閉じ、新しいペインが開く（[ADR 0084](adr/0084-launch-after-create.md)、[ADR 0104](adr/0104-launch-with-explicit-model.md)）。
2. 開いた直後、本文はスケルトンで、入力欄はエージェント仕様（`$` が無く「メッセージを入力」）になっている。起動が終わるまで送信ボタンは無効でスピナーが出る。入力欄にはすぐ打てる。この間、添付の +、`/` の候補、引用、停止は出ない。
3. そのままプロンプトを打ち、起動が終わって送信ボタンが送信に戻ったら押す。打った本文が送られ、会話に user の行が出る。
4. モデルに `@demo/start-fails` を選んで作ると、ペインはシェルとして残り、入力欄はエージェント仕様のまま、上に起動失敗の行が出る。打った下書きは残る。「再試行」でもう一度起動でき、「シェルとして使う」で `$ コマンドを入力` に切り替わる。
5. 起動中に別のペインを開いて戻っても、待ちと下書きは残る。
6. 文字を打って 250ms 以内に別のペインへ切り替え、すぐ戻る。下書きは残っている（保存待ちのタイマーを捨てない）。
7. 起動したペインの `/chat` をブラウザのリクエスト差し替えで 502 にすると、会話ではなく端末出力に切り替わる。hwc から起動したペインは必ずモデルを指定しているので、入力欄にそのモデルと effort が残る（[ADR 0101](adr/0101-launch-model-while-chat-unavailable.md)）。Claude でも同じ。
8. 再読み込みすると起動意図は失われる。起動済みならエージェント、途中ならシェルの表示になる。

## 新しいペインの既定

新しいペインのモデルと effort の初期値は、設定画面でエージェントごとに決める（[ADR 0104](adr/0104-launch-with-explicit-model.md)）。既定は状態ディレクトリの `launch-defaults.json` にあり、E2E では起動のたびに空から始まる。

1. 設定を開く。「エージェント」のまとまりに Pi / Claude / Codex / OpenCode が並び、どの行も `未設定` になっている。
2. 「Claude」を開き、モデルに `Sonnet 5.5`、エフォートに `high` を選んで「保存」を押す。「現在の既定」と一覧の行が、モデル名 `Sonnet 5.5` の右に effort の札 `high` を並べた表示になる（Claude は表示名にし、Codex / OpenCode は provider を落としたモデル id にする。Pi だけ `provider/model` のまま。[ADR 0114](adr/0114-model-label-by-agent.md)）。同じ値のままでは「保存」を押せない。
3. 「新しいペイン」を開いてエージェントのカードで Claude を選ぶ。モデルは `Sonnet 5.5（既定）`、エフォートは `high（既定）` で選ばれており、すぐに「作成して起動」を押せる。選択肢も設定の行と同じラベルになる（Codex と OpenCode の選択肢は provider の無い id だけ。Pi だけ `provider/model` のまま。[ADR 0114](adr/0114-model-label-by-agent.md)）。Pi のカードに戻すと、Pi の既定（未設定なら「モデルを選択」）に切り替わる。
4. Claude のままモデルを `Opus 5.5` に変えると、エフォートは「エフォートを選択」に戻り、作成ボタンは押せない。`Sonnet 5.5（既定）` に戻すと `high（既定）` が選ばれる。
5. 既定のモデルが候補に無い場合は、ブラウザのリクエスト差し替えで `GET /api/launch-defaults` に `{"defaults":{"claude":{"model":{"provider":"claude","id":"missing"},"effort":"high"}}}` を返して開き直す。モデルは「モデルを選択」になる。エフォートだけが候補に無い場合（`"effort":"none"`）は、モデルが選ばれてエフォートは未選択になる。`GET /api/launch-defaults` を 500 にしても、既定なしとして開いて選べば起動できる。
6. Claude の既定で起動し、`/chat` を 502 にしても、入力欄に `Sonnet` と `high` が出る（[ADR 0101](adr/0101-launch-model-while-chat-unavailable.md)）。モデルのチップを開くと、パネルに `ⓘ`、識別子 `sonnet`、「起動時の指定。最初の応答で実際のモデルに確定します」が出る。コピーするのも `sonnet`（[ADR 0108](adr/0108-claude-model-display-name.md)）。会話が読める Claude ペイン（fixture の `quickstart`）では、チップが `Sonnet 5.5`、パネルが `claude-sonnet-5-5` で、`ⓘ` と注記は出ない。
7. 設定の「Claude」で「解除」を押すと、行が `未設定` に戻り、ダイアログも「モデルを選択」で開く。
8. `@demo/beam-small`（effort 非対応）を既定にすると、行はモデルだけになり、ダイアログはエフォート欄を「なし」で無効にしたまま作成ボタンを押せる。

## シェルペインからの起動

シェルのペインは、入力欄の左端の「エージェントを起動」から、分割せずその場でエージェントに変えられる（[ADR 0077](adr/0077-shell-pane-agent-start.md)）。

1. `scratch` の `notes`（シェル、待機）を開く。入力欄の下の左端（会話ペインの + と同じ位置）に「エージェントを起動」が出る。エージェントのペイン（`docs` の `writer`）には出ない。
2. 入力欄に `ls` と入れて送る。端末出力に `ls` が追記される。シェルには会話が無いので、控えは作られない。
3. 押すと「エージェントを起動」のダイアログが開く。ペイン名の欄と「エージェント / シェル」の切り替えは無く、説明にペイン ID と、作業ディレクトリと履歴が残ることが出る。
4. モデルとエフォートを選んで「起動」を押すと、ダイアログが閉じ、本文がスケルトン、入力欄はエージェント仕様（`$` なし）で送信ボタンがスピナーになる。この間も入力欄には打てる。シェルの起動コマンドや Pi の TUI の途中、空状態は出ない。数秒で Pi の会話ビューと入力欄になり、一覧の行もエージェントのペインになる。ペインは増えない。会話ビューに、手順 2 で送った `ls` は出ない。
5. `acme-dashboard` の `shell`（`bun --watch src/server.ts` が動いている）で同じ入口を押すと、ダイアログは開かず、入力欄の上に「コマンドが動いています。停止してから起動できます」が出る。停止ボタンでコマンドを止めてから押すと、ダイアログが開く。
6. 分割セル（広い画面で 2 枚以上）では、+ と同じ規則で入口が出ない。

## アクティブ一覧

1. `アクティブ` を開く。エージェントのいるペインが、待機中も含めて帯ごとに並ぶ。各帯の先頭は親ペインで、状態が変わっても動かない（王冠はそのスペースにエージェントが 2 枚以上いるときだけ出る）。残りは state の順（タブ → ペイン）のままで、状態では並べ替えない。`acme-dashboard` では `frontend`（親・実行中）、`review`、`new`、`api`（完了）の順で並ぶ。`scratch` では `notes`（エージェントなし）が出ず、`folder-trust-saved` などの待機が帯に並ぶ。
2. `acme-dashboard` の帯で `api`（完了）を開き、`一覧へ戻る` で戻る。`api` は `待機` になり、帯の件数から完了が消える。行の位置は動かず、最後に残る（[ADR 0050](adr/0050-active-lists-every-agent.md)）。
3. `すべて` に切り替えて、シェルだけのペインと待機のペインがツリーに出ることを確かめる。Herdr に worktree として登録されていない `plain-checkout` も、git 管理下ならシェルではなくリポジトリのアイコンで出る。
4. `すべて` で行の途中までスクロールしてから `アクティブ` に切り替え、`すべて` に戻る。位置はスコープごとに控えられ、上端は行の途中ではなく行の先頭から始まる。
5. `acme-dashboard (checks)` の帯は `review`（待機）1 行になり、`acme-dashboard` の帯とは別に並ぶ。`acme-dashboard (docs)` の `writer` と同じく、スペースごとに 1 つの帯になる。

### 帯からすべてへ移る

1. `すべて` で `acme-dashboard` のリポジトリ束を畳む。
2. `アクティブ` に切り替える。帯の名前・ブランチ・件数を押しても何も起きず、`すべて` に切り替わらない。`すべて` へ移れるのは右端の → だけ。
3. → にポインタを載せると、矢印の 32px の枠だけが塗られ、矢印が `accent` になる。名前とブランチは変わらない。
4. `acme-dashboard (docs)` の帯の → を押す。
5. `すべて` に切り替わり、リポジトリ束・`acme-dashboard (docs)` のスペース・代表タブが開き、`docs` の見出しが見える。見出し行には `accent` の枠が付く。一覧の終わりが近くて見出しを上端まで送れないときも、上端で行を半分に切らず、切れていた行の先頭から見せる。
6. 別の行を選ぶ、見出しを開閉する、`アクティブ` に切り替えると、枠が消える。

### 行のメニュー

各行の右端の「…」から、ツリーと同じペインのメニューを開く（[ADR 0081](adr/0081-active-row-pane-menu.md)）。メニューを開くだけでは、行の選択と既読は変えない。

1. `アクティブ` を開く。`scratch` の `folder-trust` 行の「…」を押す。メニューが開き、同じスペースに 5 枚（エージェント 4 枚 + `notes` のシェル）あるため最後の項目が「ペインを閉じる」になる。行は開かず、選択も変わらない。
2. 「ペインを閉じる」を選ぶと、要対応の確認ダイアログが出る。キャンセルでメニューも確認も閉じ、行は残る。
3. `acme-dashboard (docs)` の `writer` 行の「…」を押す。同じスペースに `quickstart`（`w2:t2`）がいるので「ペインを閉じる」になる。`quickstart` の行の「…」から先に閉じる（待機なので確認は出ない。Claude の会話の手順は閉じる前に済ませる）。`writer` が最後のペインになり、「エージェントを終了」と「最後のペインとスペースは残します」が出る。`writer` は要対応なので、確認すると Herdr が終了を拒否し、ダイアログに失敗が出る（失敗表示の経路）。
4. `scratch` の `folder-trust` 行の「…」からペインを閉じると、閉じた行だけが消え、帯は残りのエージェントで残る。完了した行を開いて離れたときの既読は、従来どおり行を開いた場合だけ進む。
5. 終了できる経路は「エージェントの終了」の手順で `scratch` の `folder-trust-saved` だけを残し、`アクティブ` のその行の「…」から「エージェントを終了」を選ぶ。確認すると、その帯が `アクティブ` から消え、`すべて` ではスペースとシェルが残る。
6. PC 幅では、ポインタを載せた行・選択中の行だけ「…」が出る。390px では常に出る。狭い行ではタブ名、次に時刻が省かれ、名前と 44px の操作領域が残る。

### 経過時間と終了時刻

時刻は BFF が持つ（[ADR 0017](adr/0017-active-agents-view.md)）。一覧の右端は、実行中が経過、完了と待機が終了時刻（時:分）になる。

1. `アクティブ` を開く。`acme-dashboard` の `frontend`（実行中）の右端が、開いた時点から増える経過（`3s`、`1m 4s` など）になる。
2. `frontend` の終了時刻を作る。終了時刻は `working` から `done` へ移ったときにだけ記録し、フィクスチャで `done` を作る入力は `/done` だけ。`frontend` を開いて入力欄に `/done` と入れると、停止ボタンではなく送信ボタンになる（停止は入力が空のときだけで、文字・添付・引用があれば実行中への追加指示の送信になる）。そのまま送って一覧に戻ると、`frontend` が `完了` になり、右端が経過から終了時刻（時:分）に変わる。入力欄を使わない場合は `POST /api/panes/w1:p1/input` に `{"text":"/done","submit":true}` を直接送っても同じになる。
3. 再読み込みしても同じ終了時刻が残る。起点と終了時刻は状態ディレクトリの `pane-times.json` にあり、BFF の再起動でも状態が一致する間は引き継がれる。
4. localStorage を共有しない別のブラウザ（シークレットウィンドウなど）で `アクティブ` を開くと、同じ終了時刻になる。経過は 1 秒の位相で揺れるので、比べるのは固定値の終了時刻にする。
5. `frontend` の行は比べ終わるまで開かない。開いて離れると既読が進んで `待機` に戻り、行の状態が変わる。

## ファビコンと親マーク

ファビコンは、スペースの左端にいる最初のエージェント（親）の完了と、全エージェントの要対応・作業中を見る（[ADR 0054](adr/0054-favicon-parent-status.md)）。タイトルは `HWC` のまま変えない。

1. `アクティブ` を開く。`acme-dashboard` の `frontend` と、`scratch` の `folder-trust` に王冠の親マークが付く。`acme-dashboard (checks)` はエージェントが 1 枚だけなので付かない。
2. `すべて` に切り替え、同じ王冠がツリーのペイン名の横に出ることを確かめる。
3. `frontend` を開く。詳細のペインタブの `frontend` に王冠が出る。同じタブの `shell` には出ない。`checks` タブの `review` にも出ない。
4. `link[rel="icon"]` を調べる。PNG のリンクが残り、SVG の `href` が `data:image/svg+xml,` で始まる。fixture では `writer` と `folder-trust` が `blocked` なので、点は赤になる。SVG favicon を持たないブラウザは PNG でアイコンを出す（[ADR 0054](adr/0054-favicon-parent-status.md)）。
5. `document.title` が `HWC` のままであることを確かめる。

## 一覧の並べ替え

`すべて` の束の並びは Herdr のワークスペース順で、ネイティブ Herdr と同じ（[ADR 0052](adr/0052-workspace-order-drag.md)）。

1. `すべて` を開く。`acme-dashboard`（リポジトリ束）、`scratch`、`sandbox`（重複した 2 スペースの束）が並ぶ。
2. `scratch` の見出しを長押しする（PC は見出しを少しドラッグする）。掴んだ束のカードが破線の青い枠で囲まれ、見出しは読める濃さのまま中身が淡くなり、指の近くに束の名前が出る。落とし先の境界に「ここに移動」の線が出る。破線はカードの角丸に沿う。ラベルは指の反対側に出て、追従するガイドと重なっても手前に残る。
3. `acme-dashboard` の上へ落とす。`scratch` が新しい位置へ動くアニメーションが見え、先頭へ移る。架空 Herdr の並びも変わる。
4. `acme-dashboard` の見出しにフォーカスし、`↓` を押すと 1 つ下がる。`↑` で戻る。
5. 同じ位置へ落としても通信しない。`アクティブ` に切り替えても、同じ Herdr の順で帯が並ぶ。
6. 失敗時は `/api/workspaces/move` に 502 を返して確かめる。一覧は Herdr の順のままで、上部に「並べ替えを保存できませんでした。」が出る。
7. 動きを減らす設定（`prefers-reduced-motion: reduce`）では、落とした後のアニメーションが出ないことを確かめる。

### メニューから先頭へ移動

1. `すべて` を開き、先頭以外の束の見出しメニューを開く。「先頭へ移動」があり、先頭の束のメニューには出ない。
2. 押すとメニューが閉じ、その束が先頭へ 220ms で滑り、動いた束はしばらく影で浮かぶ。`アクティブ` に切り替えても同じ先頭にある。
3. `アクティブ` の帯のアイコンから同じメニューを開いても同じ。`acme-dashboard (checks)` の帯で押すと、同じリポジトリの `acme-dashboard` と `acme-dashboard (docs)` も束ごと先頭へ上がる。
4. 一覧を下までスクロールしてから押すと、先頭へ寄せて移動先の帯が見える。
5. 失敗時は `/api/workspaces/move` に 502 を返して確かめる。「並べ替えを保存できませんでした。」が出て、並びは変わらない。
6. `prefers-reduced-motion: reduce` では滑らないが、位置は先頭へ変わる。
7. 移動の応答を保留したまま別のスペースを削除しても、解放後の移動で FLIP が出る。ブラウザのリクエスト差し替えで `/api/workspaces/move` の応答を遅らせ、その間に `POST /api/workspaces/w2/remove-worktree` を送り、`Element.animate` が削除時ではなく移動時に呼ばれることを確かめる。

## 重複したスペース

Herdr ネイティブの `workspace.create` は同じディレクトリでも新しいスペースを作る。hwc は同じ
パス・同じラベルのスペースを 1 つの場所に束ね、余分なスペースを閉じる入口を出す（[ADR 0060](adr/0060-duplicate-native-spaces.md)）。
fixture の `sandbox` は同じ場所を指す 2 スペースで、どちらもシェルだけ。

1. `すべて` を開く。`sandbox` が 1 行にまとまり、名前の横に `2` の札、副題が `シェルのみ`、右端にシェルの記号が出る。
2. `sandbox` の見出しを開く。代表スペースのシェルペインと、`スペース 2` の見出しが出る。
3. `スペース 2` の見出しの先頭アイコンからメニューを開く。「スペースを閉じる」を選び、確認で「実行中のエージェントも終了するが、チェックアウトのファイルは残る」ことを確かめる。
4. 閉じると `sandbox` の束が 1 スペースに解け、`2` の札が消える。残ったスペースは通常の 1 スペースとして見える。他にスペースがあるので、メニューの「スペースを閉じる」は残る（[ADR 0107](adr/0107-close-space.md)）。
5. 代表スペースを閉じた場合も、残ったスペースが代表になる。
6. `アクティブ` にはシェルだけなので `sandbox` は出ない。重複の整理は `すべて` で行う。

## スペースを閉じる

最後の 1 つを除いて、どのスペースもメニューの一番下から閉じられる（[ADR 0107](adr/0107-close-space.md)）。
フォルダは残るので、`ワークツリーを削除` とは別の項目として扱う。

1. `すべて` を開き、`acme-dashboard`（リポジトリ本体）の見出しメニューを開く。`新しいワークツリー` の下に、危険色の「スペースを閉じる」がある。
2. 選ぶと確認ダイアログが出て、スペースのパス、実行中のエージェントも終了すること、チェックアウトのファイルは残ることが分かる。取り消すと何も変わらない。
3. `scratch`（git 管理外）のメニューにも「スペースを閉じる」がある。
4. `acme-dashboard (docs)`（linked worktree）のメニューには「スペースを閉じる」が出ず、「ワークツリーを削除」だけが出る。
5. 最後の 1 つのスペースでは項目が出ない。fixture は常に複数のスペースを持つため、この規則は `src/client/select.test.ts` と `src/server/app.workspace-lifecycle.test.ts` で確かめる。

## ワークツリー作成

スペース見出しの先頭アイコンから開くメニューで作るワークツリーは、次の手順で確かめる。

1. `acme-dashboard`（リポジトリ本体）の見出しの先頭アイコンを押してメニューを開き、「新しいワークツリー」を選ぶ。
   ダイアログの見出しが「新しいワークツリー」で、ブランチ名と保存先が Herdr 任せである旨が出る。
2. モデルとエフォートを選んで「作成して起動」を押すと、架空 Herdr にリンクされたスペースが 1 つ増え、hwc が
   その root pane を開く。ダイアログはワークツリーと root pane ができるまでで閉じ、起動は裏で続く。
   開いた直後は本文がスケルトン、入力欄はエージェント仕様で送信ボタンがスピナーのまま、入力を待つ。
   シェルの起動コマンドや Pi の TUI の途中、空状態は出ない。数秒で入力欄と会話（空状態を含む）に
   一度で切り替わる（[ADR 0074](adr/0074-created-pane-starting.md)、[ADR 0078](adr/0078-starting-pane-mask.md)、[ADR 0084](adr/0084-launch-after-create.md)）。
   入力欄のモデル表示は起動時の指定で補われる（[ADR 0033](adr/0033-launch-model-before-first-message.md)）。
3. linked worktree（`acme-dashboard (docs)`）の見出しのメニューには「新しいワークツリー」が無い。
4. 4 ペインのタブを持つスペースでも、「新しいペイン」だけが無効で「新しいワークツリー」は押せる。
   4 枚のタブは既存のダイアログで 2 枚追加して用意してよい。
5. 起動失敗は、モデルに `@demo/start-fails` を選んで作成すると確かめられる。ワークツリーと
   root pane は残り、ペインの入力欄の上に起動失敗の行と「再試行」「シェルとして使う」が出る。
   下書きは残り、「シェルとして使う」で `$ コマンドを入力` のシェルに切り替わる。
6. `worktree_open_failed`（結果不明）はブラウザのリクエスト差し替えで
   `/api/workspaces/:id/create-worktree` に 502 を返して確かめる。再送のボタンは出ず、「閉じる」だけになる。
7. Herdr の worktree 情報を持たない `plain-checkout` でも、メニューに「新しいワークツリー」が出る。
   シェルを選んで作成すると root pane が開き、一覧には `plain-checkout` の配下に新しいワークツリーが増える。
   起点の登録情報は架空 Herdr が補い、BFF の状態では `managed: true` に変わる。事前登録の操作は挟まない。
   非 git の `scratch` と linked worktree のメニューには作成項目が出ない。

## 分割ビューとタブ履歴

PC の分割は、開いたペインのタブと方向つきの二分木で持つ（[ADR 0061](adr/0061-split-view-directional-tree.md) / [ADR 0063](adr/0063-tab-order-by-pane-layout.md)）。`hwc-split-view` に開いた順・MRU・current・木を保存する。

1. 1600px で `frontend` を開く。タブバーに `frontend` が 1 つ出て、その左端にスロット 1 の青いバーが付く。セルは 1 枚だけなのでセル枠は出ず、右端にも追加帯は出ない。詳細の幅を最後のセルがそのまま使う。
2. `checks` の `review` を一覧から開く。current のセルが `review` に置き換わり、タブは `frontend` と `review` の 2 つになる（セルは 1 枚のまま）。`review` のタブをそのセルの**右端**へドラッグする。ドラッグ中だけ、掴んだタブ名とグリップがポインタの近くに付いてくる。落としたあとの右半分がスロット色で塗られ「右に追加」と出る。落とすと空いた左のセルに `frontend`、右に `review` が入って 1x2 に並び、タブも左から `frontend`（青、スロット 1）、`review`（紫、スロット 2）になる。右端に追加帯は出ない。
3. `acme-dashboard (checks)` の `review` を開く（別スペースの同名ペイン）。右のセルがこの `review` に置き換わり、`w1` の `review` はタブに残って固定ゾーンの右（MRU の先頭）に出る。タブが 2 段になり、2 段目にスペース名が出る。1 スペースだけの間は 2 段目が出ないことを、1 の時点で確かめてある。セル見出しには作成元のスペース名と `›` でつないだ場所が付き、2 つの `review` を見分けられる（長いときは末尾を省略し、フルは `title`）。作成元を閉じている間はリポジトリ名に変わる。作成元が縮んで省略されると区切りも消え、0 幅になればスペース名だけになる。それでも入らない幅では、スペース名の末尾も省略する（`src/client/select.test.ts`）。
4. 一覧の行（ツリーと `アクティブ` の両方）は、グリッドに出ているペインなら現在行でなくてもスロット色になる。名前と 1px の枠がそのセルと同じ色になり、現在行だけは選択面と 2px の枠、太字の名前になる。スロット色は PC だけで、390px では出ないことを 13 で確かめる。
5. 木の外にある `review`（`w1:p3`）のタブを `frontend` のセルの**下半分**へドラッグする。1x2 の左右並びでは上下の端だけが分割先になり、左右の端ではプレビューが出ない。落とすと左のセルが上下 2 段になり、右はそのままの T 字になる。タブは読み順で左上 `frontend`（青）、右上の縦長 `review`（`acme-dashboard (checks)`、紫）、左下 `review`（`w1`、青緑）に並ぶ。3 枚のとき、左列の下の `review` を同じ列の `frontend` の右端へドラッグしても、同じ向きのネストになるのでプレビューが出ず、落としても何も起きない。
6. タブをセルの**中央**へドラッグする。セル全体が枠で囲まれ「ここで入れ替え」と出る。落とすと 2 つのセルが入れ替わり、落としたペインが current になる。入れ替えは前の位置から 200ms で滑り、分割で増えたセルは 160ms でフェードインする。`prefers-reduced-motion` では動かない。
7. グリッド内のタブの × を押す。確認は出ず、タブが幅を詰めながら淡く消え、そのペインがセルに出ていればセルも同じ 180ms で淡く消える。`prefers-reduced-motion` では即時に外れる。タブが外れるとその葉が畳まれて隣のセルが広がる。同じ向きの入れ子になる場合は、残りが T 字か 2x2 に組み直る。空きスロットと、空きを閉じる × は無い。ペインは一覧に残り、Herdr 側でも動き続ける。current を外したときは、PC の分割では表示順の次のタブ（無ければ手前）が木にあればそれが、無ければ最初の葉が選ばれる。モバイルと 1 枚表示では開いた順の次。実ペインが 1 枚だけになったら、残ったセルの枠は出ない。ペイン見出しのメニューから閉じた場合も、ペインが消えたスナップショットを待たずに同じアニメーションが出て、終わってから一覧が更新される。
8. 再読み込みする。開いた順・MRU・current・木が復元される。架空 Herdr でペインを閉じた場合は、そのペインがタブと葉から落ち、親の分割が畳まれる。
9. 4 枚まで並べられる。5 枚目のタブを端へドラッグしてもプレビューは出ず、落としても増えない。タブは 5 枚以上積めて、木の外のタブは固定ゾーンの右に MRU（左が新しい）で並ぶ。木の外のタブを選ぶと current の葉を置き換え、押し出されたペインは固定ゾーンのすぐ右へ出る。
10. 最後のペインのタブでも × は出る。`acme-dashboard (docs)` の `writer`（`w2:t1` 唯一のエージェント）で × を押すと、タブから外れるだけでペインとスペースは残り、一覧から開き直せる。`scratch` の `pi-trust` も同じ。単独シェルのスペースは fixture に無いため、`keep` の判定は `src/shared/pane-close.test.ts` で確認する。エージェントを終えるには、ペイン見出しの三点リーダーメニューから「エージェントを終了」を選ぶ。
11. プレビューを開いたままタブを切り替えると、プレビューは隠れてペインのセルに戻る。プレビューを選ぶと detail を占有し、グリッドは出ない。
12. 一覧の行からも同じように分割できる。1600px で `hwc-split-view` を消して開き、`frontend` が 1 枚だけの状態にする。`アクティブ` を下へスクロールし、`acme-dashboard (checks)` の `review` の行を、そのセルの右端へドラッグする。タブからのドラッグと同じく、掴んだ行の名前とグリップが付いてきて、右半分に「右に追加」が出る。落とすと `frontend | review` の 2 列になる。ドラッグ後の click で一覧の行が開き直らない。`すべて` のツリーのペイン行でも同じ。束の見出しのドラッグは並べ替えのままで、分割のプレビューは出ない。
13. 390px（モバイル）では、タブ履歴と 2 段目だけが出て、グリッド・4 色・ドラッグは出ない。タブは開いた順のままで、選んでも並びは変わらない（固定ゾーンは wide かつ 2 枚以上のときだけ）。タブ左端のスロット色バーと、一覧の行のスロット色も出ない（PC と同じ木を、色にだけ使わない）。タブの × は常に出て、タップで確認なしにタブから外れる。タブは縮みながら消え、本文も淡く消える。ペインは一覧に残る。`hwc-split-view` を消してから開くと、Herdr のフォーカス中ペインが 1 枚で開く。
14. 固定ゾーンのタブ同士を入れ替える（[ADR 0064](adr/0064-tab-strip-swap.md)）。1600px で `hwc-split-view` を消してから開き、`frontend` を開く。一覧の `shell` の行を `frontend` のセルの右端、`review` の行を `frontend` の下端、`new` の行を `shell` の下端へ順に落として 2x2 にする（`shell` / `review` / `new` はまだ開いていないので一覧の行から直接落とす。先に開くと current の葉が置き換わるだけで、改めてタブを端へ運ぶ必要がある）。`frontend` のタブを `review` のタブへドラッグする。ドラッグ中は `review` のタブにだけ枠が出て、セル側には出ない。落とすと左上と左下のセルの中身が入れ替わり、タブは読み順で `review`（スロット 1）、`shell`（2）、`frontend`（3）、`new`（4）になる。入れ替えたペインは相手のスロット色になり、current は `frontend`。タブを自分自身の上で離しても何も起きない。セル見出しから掴んでも、同じペインを同じタブへ落とせば同じく入れ替えになる。木の外のタブは落とし先にならない。一覧から `acme-dashboard-api` を開くと current の葉が置き換わり、押し出されたペインが木の外へ出る。続けて押し出されたタブを選ぶと `acme-dashboard-api` が木の外へ出るので、そのタブを固定タブへ運んでも枠が出ず、落としても何も起きない。プレビューを開いている間（11）も、固定タブへ運んでも枠が出ず、落としても何も起きない。1 枚だけ開いた状態では、タブをタブへ運んでも枠が出ない。再読み込みすると（8）、入れ替えた並びとセルがそのまま復元される。
15. 分割セルの入力欄は、1 行の間はモデル・コンテキスト・送信と同じ行に並ぶ。折り返して複数行になる文章を入れると、入力欄が読み幅いっぱいに広がり、モデル・コンテキスト・送信は次の行へ回る。入力を空にすると 1 行の並びに戻る。

## PR のチップ

PR のチップは、1 枚表示と分割セルのペイン見出し、アクティブ帯のワークツリー見出しに出る。1 枚表示では、狭い画面ではブランチの右、広い画面ではブランチを出さないのでエージェント記号の右に出る。分割セルは自分のスペースの PR を出すので、同じ PR が並ぶこともあれば、別の PR が並ぶこともある（[ADR 0058](adr/0058-split-view-tab-history.md)）。

1. `acme-dashboard` のペインを狭い画面で開く。見出しは `feat/empty-state` と `#481` になる。
2. `#481` をタップすると `https://github.com/example/acme-dashboard/pull/481` が新しいタブで開く。
3. `acme-dashboard (docs)` のペインは `docs/quickstart` だけで、チップは出ない（ペイン見出しに merged は出さない）。
4. 広い画面にすると、見出しはブランチを出さず、`#481` だけを出す（一覧がブランチを持っている）。
5. `acme-dashboard` のペインを 1 つ目のセルに、`acme-dashboard (checks)` の `review` を 2 つ目のセルに入れる。1 つ目のセルは `#481`、2 つ目は `#483` になり、それぞれの URL が開く。`checks` のチェックアウトはローカル名 `worktree/review-checks`、push 先は `feat/checks` で、PR は push 先の名前で引いている（ローカル名だけでは `#483` は出ない）。

## HTML のプレビュー

エージェントが本文で示した HTML は、メッセージの下のチップからプレビューのタブで開く（[ADR 0051](adr/0051-agent-html-preview.md)）。fixture は `docs/preview/` に HTML・CSS・JS を分けて置いている。

1. `frontend` ペインの最後のメッセージにある `mock.html HTML` のチップを押す。タブストリップに `mock.html のプレビュー` が増え、detail を占有する。グリッドは出ない。
2. iframe の `一覧` を押すと中身が切り替わる（`docs/preview/mock.js` が動いている）。枠・余白・色は `docs/preview/mock.css` が当たっている。
3. ペインのタブ（`frontend`）を選ぶと会話に戻り、プレビューのタブは残る。もう一度選ぶとプレビューに戻る。対象ペインをタブから外すと、プレビューのタブも消える。
4. プレビューのタブの ×（PC は hover / focus、モバイルは常時）と中クリックでも閉じられる。ヘッダーの `閉じる` と同じく、タブが消えてペインのタブが選ばれた状態に戻る。
5. モバイル幅でも同じ手順で全画面になり、ダイアログは出ない。

### 根のラベル

チップの種別欄は、チェックアウトのファイルでは `HTML` のまま、チェックアウト以外の根のファイルでは `HTML · /tmp` のように根を添える（[ADR 0067](adr/0067-preview-root-label-and-warning.md)）。既定の fixture の `mock.html` はチェックアウトにあるので、ラベルは付かない。同じベース名を `/tmp` 側にも置くときだけ、fixture に次を足す。

1. `frontend` の `mock.html HTML` のチップを押す。ヘッダーは `mock.html` で、根のラベルは付かない。
2. `e2e/fixtures/scenario.ts` の `createScenario` で、架空 Herdr の root（`e2e/fake-herdr.ts` の `mkdtemp`）の下、`work/` の外に `mock.html` をコピーする（例: `<root>/tmp-preview/mock.html`）。`work/*` の外に置くのは、他のペインのチェックアウトと解決先が紛れないようにするため。自ペインのチェックアウトの外なので、root 1（`/tmp`）で解決する。
3. fixture のセッションに、その絶対パスを本文に書いた `assistant` のメッセージを 1 通、最後に足す。
4. `bun run e2e:serve` で起動し、`frontend` を開くと、チップが `mock.html HTML` と `mock.html HTML · /tmp` の 2 つになる。ヘッダーは `mock.html · /tmp` になり、iframe の `title` も同じ文字列を含む。
5. 足したメッセージが最後になるので、「HTML のプレビュー」の手順 1 の「最後のメッセージにある」は、その `a7-preview` のメッセージを指すと読み替える。新しいメッセージを `a7-preview` より前に置くなら、この読み替えは要らない。
6. 確認したら fixture の変更は戻す。

### 描けない HTML の案内

HTML が配信できないスクリプトを読み込むと、iframe の上に 1 行の案内が出る（[ADR 0067](adr/0067-preview-root-label-and-warning.md)）。既定の `docs/preview/mock.html` は `./mock.js` だけを読むので出ない。

1. `frontend` の `mock.html` を開く。案内の行は出ず、iframe の `一覧` の切り替えが動く。
2. 案内を出すには、fixture の `docs/preview/mock.html` の script を配信できない参照に差し替える（例: `<script type="module" src="./mock.ts"></script>`）。開き直すと iframe の上に案内が出て、中身は白いままになる。`再読み込み` でもう一度 HEAD を送り、案内は残る。
3. `<script src="./mock.js"></script>` に戻すと、開き直しで案内が消える。CSS と JS の応答自体には案内を出さない。
4. 確認したら fixture の変更は戻す。案内の行が出たままの画面を、他の手順のスクリーンショットに使わない。

`/tmp` は追加根の既定なので、fixture に置いてもチップとプレビューになる（[ADR 0066](adr/0066-tmp-preview-root.md)）。`HWC_PREVIEW_ROOTS` はさらに別の場所を足す設定で、fixture では使わない。追加根の検出と配信は BFF の unit / API テストで確認する。

### 根の外にあるファイルの案内

チェックアウトと `/tmp` の外に書かれた HTML と画像はチップにならず、メッセージの下に 1 行の案内が出る（[ADR 0065](adr/0065-outside-preview-root.md)）。既定の fixture には置いていないので、確かめるときだけ足す。

1. `e2e/fixtures/scenario.ts` の `createScenario` で、チェックアウトと `/tmp` の外（例: `/var/tmp/hwc-demo/outside/shell-agent.html`）にファイルを作る。
2. fixture のセッションに、その絶対パスを本文に書いた `assistant` のメッセージを 1 通足す。
3. `bun run e2e:serve` で起動し、`frontend` ペインで案内の行を確認する。

確認したら fixture の変更は戻す。案内の行は全メッセージに出る振る舞いなので、既定の fixture に入れると他のスクリーンショットにも写る。

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

## 設定

設定の入口は一覧の足元の歯車 1 つ。開いている間も歯車のままで、面と色で現在地を示す（[ADR 0094](adr/0094-settings-close-in-content.md)）。

1. 900px 以上の幅で、一覧の足元の歯車を押す。設定の左上に「← 設定」のバーが出て、歯車が選択中の色になる。左の列に「設定」の見出しは重ねない。
2. `Esc` を押すと設定が閉じ、焦点が歯車へ戻る。バーの ← でも同じように閉じる。
3. 設定を開いたまま一覧のペインを押すと、設定は閉じてそのペインが開く。焦点は押した行に残る。
4. 900px 未満では、バーの ← も `Esc` も 詳細 → 一覧 → 元の画面の順に戻る。設定を閉じた後、焦点は一覧の足元の歯車へ戻る。
5. 一覧のメニューや、設定の中の確認ダイアログが開いている間の `Esc` は、そちらだけを閉じる。設定は開いたままになる。
6. 「定型文」でフォームを開いている間は、バーの名前が「定型文を追加」「定型文を編集」に変わる。
7. エージェントの行のマークは、Claude だけブランド色（オレンジ）になり、Pi / Codex / OpenCode は補助アイコンの色のまま。左の列で Claude を開いて現在地にしても、マークだけはブランド色のまま（面と名前は現在地の色）。同じマークが、一覧の行・ペイン見出し・入力欄のチップ・作成ダイアログのカードでも同じ色になる（[ADR 0116](adr/0116-agent-mark-brand-color.md)）。

## 読み幅

広い画面では、本文・ペインの見出し・入力欄・実行中や閲覧のみの行を読み幅の列に中央寄せする（[ADR 0070](adr/0070-wide-chat-measure.md)）。

1. 900px 以上の幅でペインを開く。本文・見出し・入力欄・実行中の段階の行の左端と右端が一致し、中央の 832px に収まる。
2. タブをセルの端へドロップして 2 枚にすると、各セルは 24px の余白に揃う。
3. 900px 未満では左右 16px のまま変わらない。

## 通知

設定画面の「通知」から、司令塔の完了と要対応を Discord Webhook へ送る（[ADR 0076](adr/0076-discord-done-notification.md)、[ADR 0068](adr/0068-discord-blocked-notification.md)）。E2E では `HWC_E2E_DISCORD_WEBHOOK_SINK` により、送信は実 Discord ではなく架空のファイルへ記録する。**実 Discord へは送らない。**

起動ログの `hwc e2e fixture: <root>` が示す `<root>/discord-webhook.jsonl` が sink。送信のたびに `{"content":"..."}` が 1 行追記される。

1. 設定を開く。「通知」は未登録で、Discord の欄に URL 入力と「登録」が出る。スイッチはオフ。
2. `https://discord.com/api/webhooks/1234567890/e2e-discord-token` を入れて「登録」を押す。「登録済み」と末尾 4 文字（`…oken`）だけが出て、URL 全文は画面にも応答にも出ない。
3. 再読み込みして設定を開く。登録済みのまま復元される（`<root>/notifications.json`）。
4. 「テスト通知」を押す。成功の文言が出て、`<root>/discord-webhook.jsonl` に「hwc のテスト通知です。このチャンネルに完了通知と要対応の通知が届きます。」が 1 行追記される。
5. スイッチと「完了通知の対象」を切り替える。「すべての作業」を選んで再読み込みすると、選んだ状態が残る。「要対応の通知は、この対象に関係なく送ります。」が出ている。
6. 「変更」は空の入力から始まり、「キャンセル」で元の登録済み表示に戻る。「削除」は確認のあと未登録になり、スイッチの状態は変わらない。
7. 読み込み失敗は、ブラウザのリクエスト差し替えで `/api/notifications` に 502 を返して確かめる。「通知の設定を読み込めませんでした。」と「再試行」が出て、「未登録」とは出さない。
8. 自動送信は、`acme-dashboard` で通知を有効にし、`/done` を送って親と子を `done` にする。山ごとに 1 回だけ sink に追記され、`done` のまま留まっても増えない。実 Herdr には `/done` が無いので、フィクスチャ専用の入力で確かめる。
9. 要対応は、`acme-dashboard` の `review` を開き、フィクスチャ専用の `/blocked` を送る。`hwc: acme-dashboard が対応を待っています\nペイン: review\nブランチ: feat/empty-state` が 1 行追記される。`/blocked` をもう一度送っても増えない。`/done` で解除してから `/blocked` を送ると、もう 1 行追記される。「完了通知の対象」が「PR がある作業だけ」でも送られる。

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

### Claude のコンテキスト使用量

fixture の `w2:p2`（`quickstart`）は、mod が書く live ファイル（`<root>/claude/live/<session uuid>.json`）に `context: { tokens: 122_600, window: 1_000_000 }` を持つ（[ADR 0106](adr/0106-claude-context-usage.md)）。速度は `null` のままで、メーターだけを確かめる。

1. `acme-dashboard (docs)` の `quickstart` を開く。入力欄の左下のモデル表示の横に `123k/1.0M (12.3%)` とバーが出る。390px では `12.3%` だけになる。
2. メーターを押す（PC はポインタを載せる）と、使用量 `122,600` と設定枠 `1,000,000` が出る。
3. live ファイルの `at` は起動時のままなので、表示までの時間が 2.5 秒を超えていてもメーターが出る。速度だけが鮮度で消える（[ADR 0106](adr/0106-claude-context-usage.md)）。
4. `<root>` の live ファイルを消す。5 秒以内の取得でメーターが消え、モデル表示だけになる。

### blocked + 応答待ちの作り方

応答待ちは、hook が書く sidecar `<root>/claude/pending/<session uuid>.json`（`<root>` は起動ログの `hwc e2e fixture: <root>`）に置く。実機の Claude Code は、待ちの間は transcript に質問の tool_use を書かない（[ADR 0112](adr/0112-claude-pending-in-chat.md)）ので、transcript は待ちに入る前の会話で終わらせる。fixture の `w2:p1` がこの形で、架空 Herdr のペインを `blocked` にし、`agent_session` は `CLAUDE_PENDING_SESSION`、sidecar は `e2e/fixtures/scenario.ts` の `claudePendingSidecar`、transcript は `claudePendingTranscript`。

1. 質問のカード: sidecar の `pending` を `kind: "question"`（`toolUseId`、`tool: "AskUserQuestion"`、`questions[].{question,header,multiSelect,options[].{label,description}}`）にする。外側の `sessionId`、`at`（24 時間以内）、`toolUseId`、`tool` も要る。読むときに 4 問、1 問 10 選択肢、質問文 2000 文字を超えた分を切り、制御文字を落として改行を空白にする。`questions` が配列でない、`options` が空、`label` が空の `pending` は、カードにならない。
2. 承認のカード: `pending` を `{ "kind": "tool", "toolUseId": "...", "tool": "Bash", "summary": "..." }` にする。要約は 1 行（200 文字まで）で、`Write` の `content` のような input 全体は sidecar にも画面にも載らない。要約を `null` にすると名前だけになる。
3. カードなし: sidecar のファイルを消す、`pending` を `null` にする、`at` を 24 時間より前にする、`sessionId` を別のものにする、のいずれか。解決済みは、transcript に `toolUseId` が同じ tool_result を持つ user entry を足す（Esc は hook を呼ばないので、sidecar が残っていてもカードは戻らない）。`blocked` のまま pending が無い（末尾が user の本文など）と、カードは出ずに端末出力になる。fixture の `w2:p2`（待機）はカードが出ない。
4. フォールバック（実機では使われない）: sidecar が無いときは、transcript の active branch の末尾が tool_result を持たない assistant の tool_use ならカードにする。CLI が待ちの間に tool_use を書く版が出たときのための経路で、E2E では `claudePendingTranscript` の末尾にその tool_use を一時的に足し、sidecar を消して確かめる。確認後に戻す。
5. 表示中に sidecar や transcript を書き換えると、5 秒間隔の取得で次のスナップショットに変わる。実 Herdr では `agent_status` と sidecar がずれる瞬間があるので、カードは `blocked` の間だけ出す。

## 禁止

- 実 Herdr につながった BFF（:30000）の画面をスクリーンショットに撮らない。
- 実 pi セッションを fixture にコピーしない。
- 架空環境の確認なしに、E2E の画像を PR へ貼らない。
