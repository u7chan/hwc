# エージェント対応状況

hwc が各エージェント CLI のどこまでを Web から扱えるかを 1 ページで把握するための表。仕様の正は実装と ADR で、この表は俯瞰用。実装や ADR を変えたら、同じ変更でこの表も更新する。

最終確認: 2026-11-22（Herdr 0.9.5、`bun run e2e:serve` の架空 Herdr）

凡例:

- ○: Web から使える
- △: 条件付き、または一部だけ
- ×: 非対応（端末出力で操作する）
- –: そのエージェントに概念がない

| 機能                                     | Pi             | Claude                  | Codex         | OpenCode        |
| ---------------------------------------- | -------------- | ----------------------- | ------------- | --------------- |
| 起動（新規ペイン / ワークツリー / 名前） | ○              | ○                       | ○             | ○               |
| 起動時のモデル指定                       | ○              | ○                       | ○             | ○（hwc が起動） |
| 起動時の effort 指定                     | ○              | ○                       | ○             | ○（hwc が起動） |
| Web での会話表示                         | ○              | ○                       | ○（hwc 起動） | ○               |
| 送信・停止                               | ○              | ○                       | ○             | ○               |
| モデル・effort の表示                    | ○              | ○                       | ○             | ○               |
| 実行中のモデル・effort の切り替え        | ×              | ○（hwc 起動）           | ×             | ×               |
| コンテキスト使用量・usage                | ○              | △（hwc 起動）           | ×             | ○               |
| 1h プロンプトキャッシュの残り時間        | –              | △（transcript）         | –             | –               |
| 圧縮の区切り                             | ○              | ×                       | ×             | ○               |
| 添付ファイル（画像以外も可）             | ○              | △                       | △             | △               |
| メッセージ内の画像プレビュー             | ○              | ○                       | ○             | ○               |
| 引用返信                                 | ○              | ○                       | ○             | ○               |
| 過去の発言の編集                         | ○（mypi 拡張） | ×                       | ×             | ×               |
| `/new` `/compact` の候補                 | ○              | △                       | △             | △               |
| 起動時の信頼確認                         | ○              | ×                       | ○             | –               |
| 応答待ち（質問・承認）の表示             | ×              | ○（hwc 起動）           | ×             | ×               |
| 質問への回答（AskUserQuestion）          | ×              | ○（hwc 起動）           | ×             | ×               |
| ライブ activity                          | △（pi 拡張）   | △（hwc 起動は速度付き） | ×             | ×               |

- 添付ファイルの UI 自体は会話を持つペインで使えるが、hwc は実体を CLI へ渡さず、本文に `<attached_files>` のパス注記を足すだけ。Pi はこの経路を前提にしている（[添付](adr/attachments.md)）。Codex と OpenCode は、それぞれの CLI がそのパスを読めるか次第（[OpenCode 連携](adr/opencode-integration.md)、[Codex 連携](adr/codex-integration.md)）。Claude の注記は `$HWC_STATE_DIR/attachments/<pane-id>/` を指し、チェックアウトの外なので、CLI が読むときに権限確認が出たら端末で承認する（[添付](adr/attachments.md)）。
- Pi と Codex のフォルダ信頼確認は、専用ビューで「信頼して続行」だけを回答できる（[Codex 連携](adr/codex-integration.md)、[pi 連携](adr/pi-integration.md)）。それ以外の選択肢は端末で行う。
- Claude の `blocked` 中（起動時の信頼確認・質問・権限確認の待ち）は、hwc の入力欄を閉じる。待ちが読めないとき（起動時の信頼確認、hwc 外で起動した Claude など）は、本文は端末出力のままで、応答は Herdr のターミナルで行う。hwc から起動した Claude の質問は、待ちが読めればカードから答えられ（下）、権限確認（承認）は端末で行う。入力欄が戻れば `blocked` は解けている。Pi と Codex の信頼確認は、これまでどおり専用ビューで「信頼して続行」を答える。
- Claude の質問・承認の応答待ちは、hwc から起動したペインだけ、`blocked` の間に会話の末尾へカードを出す（[Claude 連携](adr/claude-integration.md)）。hwc が起動時に渡す hook が待ちを状態ディレクトリへ書き、会話を読むときに重ねる。待ちが読めれば会話を維持し、入力欄・引用・添付・コマンドを閉じる。質問は、カードの選択肢か「その他（自由入力）」で全問に答えて「この内容で答える」を押す。hwc は Esc でダイアログを閉じ、transcript に tool_result が現れてから、選んだ内容を通常の発言として送る（[Claude 連携](adr/claude-integration.md)）。閉じたと確かめられなければ本文は送らず、「端末で答えてください」を出す。承認は hwc からは送らない。カードの「端末出力を見る」で端末の画面を見て、「会話に戻る」で戻る。待ちが読めないとき（hwc 外で起動した Claude など）は今までどおり端末出力になり、応答は端末で行う。
- Claude のモデルと effort は、入力欄の + メニューの「モデルとエフォートを変更」から、会話を読める待機中のペインで切り替えられる。確認ダイアログを許可する hook を持つのは hwc 起動のペインだけで、hwc 外で起動した Claude は、キャッシュが温かいと確認ダイアログで止まり、8 秒待って失敗する。選んだ値を BFF が `/model` と `/effort` にして送り、確認ダイアログは hwc の確認を通ったものだけ hook が許可する（[Claude 連携](adr/claude-integration.md)）。モデルを変えるときは「次の応答は会話全体を読み直すため、遅く、使用量も増える」を出す。Claude は選んだ値を自分の既定にも保存するので、端末から起動する `claude` の既定も変わる（hwc から起動するペインは起動時に指定するので影響を受けない）。`PreModelSwitch` の hook を足す前に起動したペインも同じで、作り直すまで失敗し得る。
- Codex の会話表示は、hwc が `--no-daemon` で起動し、SessionStart フックが session id を報告できたペインだけ。既に起動している Codex や hwc 外で起動した Codex は端末出力になる（[Codex 連携](adr/codex-integration.md)）。
- ライブ activity は、pi は拡張がセッションの隣に sidecar を書く場合だけ（[pi 連携](adr/pi-integration.md)）、Claude は transcript の進行行から導く（[Claude 連携](adr/claude-integration.md)）。pi は拡張が無いペイン、Claude は形式が読めない版のペインでは表示されない。Claude の生成中の `tok/s` は、hwc が `--plugin-dir` で渡す mod が状態ディレクトリへ書いた速度を重ねる（hwc 起動のペインだけ。[Claude 連携](adr/claude-integration.md)）。
- Claude のコンテキスト使用量は、同じ mod が書く `{ tokens, window }` を会話のスナップショットに重ねる（hwc 起動のペインだけ。usage の内訳は出さない。[Claude 連携](adr/claude-integration.md)）。1h プロンプトキャッシュの残り時間は、transcript の完了応答から導く（hwc 起動・hwc 外を問わない。[Claude 連携](adr/claude-integration.md)）。入力欄のモデル・エフォートの隣に出し、狭い幅では時計と分に縮め、入力を 1 行に畳む分割セルではモデル詳細パネルだけに出す。判断できなければ出さない
- 過去の発言の編集は、mypi がセッションに `hwc-capabilities` を残した pi ペインだけ。対象はテキストだけの発言で、添付付き・最後の発言は編集できない（[pi 連携](adr/pi-integration.md)）。
- コマンド候補のガードは会話スナップショットに依存する。Codex は context と compaction が無いため、履歴の小ささと圧縮済みの判定が効かない。Claude は hwc 起動時だけ context があるので履歴の小ささは効くが、compaction が無いので圧縮済みの判定は効かない。空の会話では `/new` と `/compact` の候補が消える。OpenCode は圧縮済みの判定がほぼ効かない（[pi 連携](adr/pi-integration.md)、[Claude 連携](adr/claude-integration.md)）。

## エージェント別の要点

### Claude

- 会話は `CLAUDE_CONFIG_DIR`（既定 `~/.claude`）配下の `projects/<project>/<session uuid>.jsonl` を読む（[Claude 連携](adr/claude-integration.md)）。Herdr が返す `agent_session` の id から transcript を引き、`parentUuid` を辿った active branch を射影する。hwc 外で起動した Claude も、同じユーザー・同じホストなら履歴が出る
- 出すのは user の本文と assistant の text だけ。tool_use / tool_result / thinking / 内部エントリ / サブエージェントは出さない。`<attached_files>` の注記は strip して名前だけのチップにする。Claude Code が貼り付けに付ける `<pasted_content>` の包みは、開きと閉じの id が揃った組だけを外す（[Claude 連携](adr/claude-integration.md)）
- 実行中の段階（「考えています」「Read を実行中」など）と方向は、transcript の `api-request` / `tool_use` / `tool_result` から導く（[Claude 連携](adr/claude-integration.md)）。要求と応答の対応が取れない版・形のときは出さない。方向はターン内の最後の assistant 本文（無ければ thinking の末尾）で、ツールのときは対象を 1 行目、方向を 2 行目に置く。方向は会話に載っても帯から外さず、次の本文が来るかターンが終わるまで残す。`input.command` は出さない
- 生成中の `tok/s` は、hwc が `claude-mod/` を `--plugin-dir` で渡して起動したペインだけ。`--plugin-dir` は 2.1.265 以降、mod は 2.1.287 以降。2.1.265〜2.1.286 は起動できるが速度だけ出ない。2.1.265 未満では起動自体が失敗する。mod が `turn.step` の差分から見えている出力の速度を推定し、`<state root>/claude/live/<session id>.json` に書く。段階が `thinking` / `writing` / `tool-call` で、書き込みが 2.5 秒以内のときだけ BFF が段階に重ねる（[Claude 連携](adr/claude-integration.md)）。数字は画面に流れている出力の推定で、`usage.output_tokens` とは一致しない。thinking が隠れるモデル・設定では請求上の output より小さく出る
- コンテキスト使用量は、同じ mod が `$.session.usage()` から `{ tokens, window }` を読んで live ファイルへ書き、BFF が会話のスナップショットに重ねる（[Claude 連携](adr/claude-integration.md)）。`window` は CLI が解決した値（1M など）で、hwc はモデル別の表を持たない。速度の鮮度（2.5 秒）が切れても使用量は残る。hwc 外で起動したペインでは出ない。usage の内訳と圧縮の区切りは `null` のまま
- 1h プロンプトキャッシュの残り時間は、transcript の完了応答の `usage` と、対応する `api-request` の送信時刻から導く（[Claude 連携](adr/claude-integration.md)）。入力欄に `キャッシュ 42:18`、満了後は `キャッシュ切れ` と出し、狭い幅では時計と `42m` / `切れ` に縮める。入力を 1 行に畳む分割セルでは、入力欄に出さずモデル詳細パネルにだけ残す。1h の全量書き込みを確かめられない場合、圧縮やモデル・エフォートの変更より前、未確認・失効済みのときは出さない。hwc 外で起動した Claude でも transcript を読めれば対象。表示は残り時間の目安で、次の要求がヒットする保証ではない
- 質問（AskUserQuestion）と権限確認の応答待ちは、`blocked` の間だけ会話の末尾にカードで出す。実機の Claude Code 2.1.328 は待ちの間 transcript に tool_use を書かないので、hwc が `--settings` で渡す hook（`PreToolUse` / `PermissionRequest` など）が `claude/pending/<session id>.json` へ書いた質問・選択肢・複数選択を読む。それ以外のツールは名前と 1 行の要約だけにする。Esc で閉じても hook は呼ばれないので、解決は transcript の `tool_result` で知る。質問にはカードから答え、承認は端末で行う（[Claude 連携](adr/claude-integration.md)）。hook は hwc から起動したペインにだけ入る
- モデルと effort は transcript の `model` と `perTurnEffort` から出す。hwc から起動したペインは必ずモデルを指定しているので、最初の assistant が現れるまで起動時の指定で補う（[起動](adr/agent-launch.md)）。hwc 以外から起動したペインは、最初の応答まで出ない。入力欄は `Opus` / `Opus 5.5` のように表示名で出し、パネルに識別子（エイリアスまたは `claude-opus-5-5`）を出す。エイリアスの間は「起動時の指定」と注記する（[Claude 連携](adr/claude-integration.md)）。モデルは CLI のエイリアス（`fable` / `opus` / `sonnet` / `haiku`）、effort は `low` / `medium` / `high` / `xhigh` / `max` から選ぶ（[Claude 連携](adr/claude-integration.md)）
- 作成ダイアログと設定画面の静的なモデル表示は、BFF が CLI の `list_models` から alias の解決先（`opus` → `Opus 5.5`）を読み、プロセスメモリに 5 分だけキャッシュする（[Claude 連携](adr/claude-integration.md)）。候補はエイリアスのままで、ラベルを読めなければ family 名に戻る。走行中ペインのチップは、transcript にモデルが載るまでエイリアスのまま
- 初回の trust prompt などで `agent_not_ready` が返っても、起動成功としてペインを残す（[起動](adr/agent-launch.md)）。応答は端末で行う（上の注意）
- 画像は v1 では出さない。画像だけを送った発言は本文が空になるため行にしない

### Codex

- 会話は App Server の `thread/read` と `thread/turns/list` から読む（[Codex 連携](adr/codex-integration.md)）。hwc から `--no-daemon` で起動し、SessionStart フックが session id を報告できたペインが対象。既存の Codex や hwc 外で起動した Codex は端末出力になる
- 読み取り API が context と compaction を返さないため、使用量と圧縮の区切りは `null`。モデルと effort は表示できる
- フォルダ信頼確認だけ専用ビューへ切り替える（[Codex 連携](adr/codex-integration.md)）

### OpenCode

- 会話はローカルサービスの HTTP API から読む（[OpenCode 連携](adr/opencode-integration.md)）。`service.json` が無い、loopback でない、API が失敗するときは端末出力へフォールバックする
- モデルと effort はサービス API の model と variants から選ぶ。サービスが未起動なら、候補を読むときに hwc が `opencode service start` で起動する。起動できなければ候補が出ず、再取得で起動し直す（[起動](adr/agent-launch.md)、[OpenCode 連携](adr/opencode-integration.md)）
- 添付ファイルの実体は渡さず、本文のパス注記だけを送る
- 圧縮は完了したものだけを区切りにし、`tokensBefore` は `null`

### Pi

- 会話はセッション JSONL の active branch から読む（[pi 連携](adr/pi-integration.md)）
- モデル・effort・context・usage・圧縮・添付ファイル・引用の基準実装
- デフォルトモデルで起動したペインは、チャット画面を開いたときと `/new` で会話が空に戻ったときに pi の既定モデルと effort を読む。hwc の画面はモデルを指定して起動するので（[起動](adr/agent-launch.md)）、これはモデル未指定の起動 API を直接呼んだ場合だけ。モデルを指定して起動したペインは起動時の指定で補う。どちらも会話にモデルが載っている間はセッションの値を使う。hwc 以外から起動したペインは対象外（[起動](adr/agent-launch.md)）
- プロジェクトの `Trust project folder?` は、既定の `Trust` だけを専用ビューで回答する。`.pi` や `.agents/skills` など信頼対象のリソースがあるフォルダでは、起動がこの確認で止まる。他の選択肢は端末で行う（[pi 連携](adr/pi-integration.md)）。hwc は `--approve` を渡さない
- Herdr は Pi の信頼確認を `blocked` としないため、一覧の行は `idle` のまま。確認ビューは、開いているペインの画面から出す
- ライブ activity は pi 拡張の sidecar がある場合だけ（[pi 連携](adr/pi-integration.md)）。Claude は transcript の段階に、hwc 起動時だけ mod の速度を重ねる（[Claude 連携](adr/claude-integration.md)）
- 過去の自分の発言は、mypi の `/hwc-rewind` と `hwc-capabilities` があるセッションだけ鉛筆で編集できる。押した時点では戻さず、送信時に会話を対象の親へ戻して本文を送り直す（[pi 連携](adr/pi-integration.md)）

## 実装の入口

| 項目                                    | 場所                                                                                                                               |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| エージェント種別、モデル・effort の対応 | `src/shared/agents.ts`                                                                                                             |
| 会話の読み取り口の解決                  | `src/server/herdr/state.ts` の `ChatSource`                                                                                        |
| 質問への回答（Esc → 本文）              | `src/server/answer-question.ts`、`src/shared/answer.ts`、`src/client/answer.ts`                                                    |
| モデル・effort の切り替え               | `src/server/model-switch.ts`、`src/server/chat/claude-switch.ts`、`src/shared/model-switch.ts`、`src/client/ModelSwitchDialog.tsx` |
| 応答待ちの hook・sidecar・カード        | `src/server/claude-hook.ts`、`claude-settings.ts`、`src/server/chat/claude-sidecar.ts`、`src/client/pane/pending.tsx`              |
| 各 CLI の会話 reader                    | `src/server/chat/pi.ts`、`claude.ts`、`codex.ts`、`opencode.ts`                                                                    |
| 起動引数と部分成功                      | `src/server/create-pane.ts`、`src/server/agent-models.ts`                                                                          |
| Claude のモデルラベル                   | `src/server/claude-model-labels.ts`、`src/client/launch-candidates.ts`                                                             |
| 新しいペインの既定と初期選択            | `src/server/launch-defaults.ts`、`src/client/launch-choice.ts`、`src/client/settings/AgentSettings.tsx`                            |
| 既定モデル・effort の遅延表示           | `src/server/pi-defaults.ts`、`src/client/pane/use-default-model.ts`                                                                |
| コマンド候補とガード                    | `src/client/commands.ts`                                                                                                           |
| ライブ activity                         | `src/server/chat/activity.ts`（pi）、`src/server/chat/claude.ts`、`src/server/chat/claude-live.ts`（Claude）                       |
| フォルダ信頼確認（Codex / Pi）          | `src/client/confirmation.ts`、`src/server/folder-trust.ts`                                                                         |
| 過去の発言の編集                        | `src/server/routes/edit-message.ts`、`src/client/edit.ts`、`src/shared/rewind.ts`                                                  |
| 添付・引用・activity の UI 分岐         | `src/client/PaneDetail.tsx`                                                                                                        |
| E2E の架空データ                        | `e2e/fixtures/scenario.ts`、`e2e/fake-*.ts`、[docs/e2e.md](e2e.md)                                                                 |

## 更新のしかた

1. 表を直す前に、実装と ADR のどちらが正かを確認する。連携の方式や前提を変える場合は ADR を更新し、この表はその結果として直す
2. エージェントを追加するときは、`AGENT_KINDS`、アイコン、`supportsModelSelection`、`ChatSource`、会話 reader、起動引数、UI の分岐、E2E fixture を同じ変更で揃える
3. 会話表示を追加するときは、`ChatSource` と `SessionChatClient`、`GET /api/panes/:id/chat`、`pane.chat` を前提にしたクライアントの分岐（添付・引用・画像プレビュー・activity・コマンド）を確認する
4. 表を更新したら、`bun run e2e:serve` で該当エージェントのペインを作り、起動・会話・送信・停止・モデル表示・コマンド候補・添付・要対応の表示を確認する。実 Herdr は使わない
5. 変更後は `bun run fmt:check`、`bun run lint`、`bun run typecheck`、`bun run test` を通す

## 関連 ADR

- [Herdr 連携](adr/herdr-socket.md)
- [起動](adr/agent-launch.md)
- [入力](adr/agent-input.md)
- [添付](adr/attachments.md)
- [ファイルの配信](adr/file-serving.md)
- [pi 連携](adr/pi-integration.md)
- [Claude 連携](adr/claude-integration.md)
- [Codex 連携](adr/codex-integration.md)
- [OpenCode 連携](adr/opencode-integration.md)
