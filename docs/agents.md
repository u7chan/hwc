# エージェント対応状況

hwc が各エージェント CLI のどこまでを Web から扱えるかを 1 ページで把握するための表。仕様の正は実装と ADR で、この表は俯瞰用。実装や ADR を変えたら、同じ変更でこの表も更新する。

最終確認: 2026-11-21（Herdr 0.9.5、`bun run e2e:serve` の架空 Herdr）

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
| コンテキスト使用量・usage                | ○              | △（hwc 起動）           | ×             | ○               |
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

- 添付ファイルの UI 自体は会話を持つペインで使えるが、hwc は実体を CLI へ渡さず、本文に `<attached_files>` のパス注記を足すだけ。Pi はこの経路を前提にしている（[ADR 0018](adr/0018-pasted-image-attachments.md)、[ADR 0080](adr/0080-file-attachments.md)）。Codex と OpenCode は、それぞれの CLI がそのパスを読めるか次第（[ADR 0028](adr/0028-opencode-chat.md)、[ADR 0031](adr/0031-codex-chat.md)）。Claude の注記は `$HWC_STATE_DIR/attachments/<pane-id>/` を指し、チェックアウトの外なので、CLI が読むときに権限確認が出たら端末で承認する（[ADR 0097](adr/0097-claude-chat-transcript.md)）。
- Pi と Codex のフォルダ信頼確認は、専用ビューで「信頼して続行」だけを回答できる（[ADR 0032](adr/0032-codex-folder-trust.md)、[ADR 0044](adr/0044-pi-project-trust.md)）。それ以外の選択肢は端末で行う。
- Claude の `blocked` 中（起動時の信頼確認・質問・権限確認の待ち）は、hwc の入力欄を閉じる。待ちが読めないとき（起動時の信頼確認、hwc 外で起動した Claude など）は、本文は端末出力のままで、応答は Herdr のターミナルで行う。hwc から起動した Claude の質問は、待ちが読めればカードから答えられ（下）、権限確認（承認）は端末で行う。入力欄が戻れば `blocked` は解けている。Pi と Codex の信頼確認は、これまでどおり専用ビューで「信頼して続行」を答える。
- Claude の質問・承認の応答待ちは、hwc から起動したペインだけ、`blocked` の間に会話の末尾へカードを出す（[ADR 0112](adr/0112-claude-pending-in-chat.md)）。hwc が起動時に渡す hook が待ちを状態ディレクトリへ書き、会話を読むときに重ねる。待ちが読めれば会話を維持し、入力欄・引用・添付・コマンドを閉じる。質問は、カードの選択肢か「その他（自由入力）」で全問に答えて「この内容で答える」を押す。hwc は Esc でダイアログを閉じ、transcript に tool_result が現れてから、選んだ内容を通常の発言として送る（[ADR 0099](adr/0099-answer-ask-user-question.md)）。閉じたと確かめられなければ本文は送らず、「端末で答えてください」を出す。承認は hwc からは送らない。カードの「端末出力を見る」で端末の画面を見て、「会話に戻る」で戻る。待ちが読めないとき（hwc 外で起動した Claude など）は今までどおり端末出力になり、応答は端末で行う。
- Codex の会話表示は、hwc が `--no-daemon` で起動し、SessionStart フックが session id を報告できたペインだけ。既に起動している Codex や hwc 外で起動した Codex は端末出力になる（[ADR 0031](adr/0031-codex-chat.md)）。
- ライブ activity は、pi は拡張がセッションの隣に sidecar を書く場合だけ（[ADR 0035](adr/0035-live-pi-activity.md)）、Claude は transcript の進行行から導く（[ADR 0100](adr/0100-claude-live-activity.md)）。pi は拡張が無いペイン、Claude は形式が読めない版のペインでは表示されない。Claude の生成中の `tok/s` は、hwc が `--plugin-dir` で渡す mod が状態ディレクトリへ書いた速度を重ねる（hwc 起動のペインだけ。[ADR 0102](adr/0102-claude-live-tok-rate.md)）。
- Claude のコンテキスト使用量は、同じ mod が書く `{ tokens, window }` を会話のスナップショットに重ねる（hwc 起動のペインだけ。usage の内訳は出さない。[ADR 0106](adr/0106-claude-context-usage.md)）。
- 過去の発言の編集は、mypi がセッションに `hwc-capabilities` を残した pi ペインだけ。対象はテキストだけの発言で、添付付き・最後の発言は編集できない（[ADR 0089](adr/0089-pi-message-edit.md)）。
- コマンド候補のガードは会話スナップショットに依存する。Codex は context と compaction が無いため、履歴の小ささと圧縮済みの判定が効かない。Claude は hwc 起動時だけ context があるので履歴の小ささは効くが、compaction が無いので圧縮済みの判定は効かない。空の会話では `/new` と `/compact` の候補が消える。OpenCode は圧縮済みの判定がほぼ効かない（[ADR 0013](adr/0013-pi-session-chat.md)、[ADR 0097](adr/0097-claude-chat-transcript.md)、[ADR 0106](adr/0106-claude-context-usage.md)）。

## エージェント別の要点

### Claude

- 会話は `CLAUDE_CONFIG_DIR`（既定 `~/.claude`）配下の `projects/<project>/<session uuid>.jsonl` を読む（[ADR 0097](adr/0097-claude-chat-transcript.md)）。Herdr が返す `agent_session` の id から transcript を引き、`parentUuid` を辿った active branch を射影する。hwc 外で起動した Claude も、同じユーザー・同じホストなら履歴が出る
- 出すのは user の本文と assistant の text だけ。tool_use / tool_result / thinking / 内部エントリ / サブエージェントは出さない。`<attached_files>` の注記は strip して名前だけのチップにする。Claude Code が貼り付けに付ける `<pasted_content>` の包みは、開きと閉じの id が揃った組だけを外す（[ADR 0097](adr/0097-claude-chat-transcript.md)）
- 実行中の段階（「考えています」「Read を実行中」など）と方向は、transcript の `api-request` / `tool_use` / `tool_result` から導く（[ADR 0100](adr/0100-claude-live-activity.md)）。要求と応答の対応が取れない版・形のときは出さない。方向はターン内の最後の assistant 本文（無ければ thinking の末尾）で、ツールのときは対象を 1 行目、方向を 2 行目に置く。会話にもう出ている本文の行は帯から外す。`input.command` は出さない
- 生成中の `tok/s` は、hwc が `claude-mod/` を `--plugin-dir` で渡して起動したペインだけ。`--plugin-dir` は 2.1.265 以降、mod は 2.1.287 以降。2.1.265〜2.1.286 は起動できるが速度だけ出ない。2.1.265 未満では起動自体が失敗する。mod が `turn.step` の差分から見えている出力の速度を推定し、`<state root>/claude/live/<session id>.json` に書く。段階が `thinking` / `writing` / `tool-call` で、書き込みが 2.5 秒以内のときだけ BFF が段階に重ねる（[ADR 0102](adr/0102-claude-live-tok-rate.md)）。数字は画面に流れている出力の推定で、`usage.output_tokens` とは一致しない。thinking が隠れるモデル・設定では請求上の output より小さく出る
- コンテキスト使用量は、同じ mod が `$.session.usage()` から `{ tokens, window }` を読んで live ファイルへ書き、BFF が会話のスナップショットに重ねる（[ADR 0106](adr/0106-claude-context-usage.md)）。`window` は CLI が解決した値（1M など）で、hwc はモデル別の表を持たない。速度の鮮度（2.5 秒）が切れても使用量は残る。hwc 外で起動したペインでは出ない。usage の内訳と圧縮の区切りは `null` のまま
- 質問（AskUserQuestion）と権限確認の応答待ちは、`blocked` の間だけ会話の末尾にカードで出す。実機の Claude Code 2.1.328 は待ちの間 transcript に tool_use を書かないので、hwc が `--settings` で渡す hook（`PreToolUse` / `PermissionRequest` など）が `claude/pending/<session id>.json` へ書いた質問・選択肢・複数選択を読む。それ以外のツールは名前と 1 行の要約だけにする。Esc で閉じても hook は呼ばれないので、解決は transcript の `tool_result` で知る。質問にはカードから答え、承認は端末で行う（[ADR 0112](adr/0112-claude-pending-in-chat.md)、[ADR 0099](adr/0099-answer-ask-user-question.md)）。hook は hwc から起動したペインにだけ入る
- モデルと effort は transcript の `model` と `perTurnEffort` から出す。hwc から起動したペインは必ずモデルを指定しているので、最初の assistant が現れるまで起動時の指定で補う（[ADR 0033](adr/0033-launch-model-before-first-message.md)、[ADR 0104](adr/0104-launch-with-explicit-model.md)）。hwc 以外から起動したペインは、最初の応答まで出ない。入力欄は `Opus` / `Opus 5.5` のように表示名で出し、パネルに識別子（エイリアスまたは `claude-opus-5-5`）を出す。エイリアスの間は「起動時の指定」と注記する（[ADR 0108](adr/0108-claude-model-display-name.md)）。モデルは CLI のエイリアス（`fable` / `opus` / `sonnet` / `haiku`）、effort は `low` / `medium` / `high` / `xhigh` / `max` から選ぶ（[ADR 0096](adr/0096-claude-model-effort.md)）
- 作成ダイアログと設定画面の静的なモデル表示は、BFF が CLI の `list_models` から alias の解決先（`opus` → `Opus 5.5`）を読み、プロセスメモリに 5 分だけキャッシュする（[ADR 0117](adr/0117-claude-model-labels-from-cli.md)）。候補はエイリアスのままで、ラベルを読めなければ family 名に戻る。走行中ペインのチップは、transcript にモデルが載るまでエイリアスのまま
- 初回の trust prompt などで `agent_not_ready` が返っても、起動成功としてペインを残す（[ADR 0027](adr/0027-new-pane-agent.md)）。応答は端末で行う（上の注意）
- 画像は v1 では出さない。画像だけを送った発言は本文が空になるため行にしない

### Codex

- 会話は App Server の `thread/read` と `thread/turns/list` から読む（[ADR 0031](adr/0031-codex-chat.md)）。hwc から `--no-daemon` で起動し、SessionStart フックが session id を報告できたペインが対象。既存の Codex や hwc 外で起動した Codex は端末出力になる
- 読み取り API が context と compaction を返さないため、使用量と圧縮の区切りは `null`。モデルと effort は表示できる
- フォルダ信頼確認だけ専用ビューへ切り替える（[ADR 0032](adr/0032-codex-folder-trust.md)）

### OpenCode

- 会話はローカルサービスの HTTP API から読む（[ADR 0028](adr/0028-opencode-chat.md)）。`service.json` が無い、loopback でない、API が失敗するときは端末出力へフォールバックする
- モデルと effort はサービス API の model と variants から選ぶ。サービスが未起動なら、候補を読むときに hwc が `opencode service start` で起動する。起動できなければ候補が出ず、再取得で起動し直す（[ADR 0030](adr/0030-new-pane-model.md)、[ADR 0104](adr/0104-launch-with-explicit-model.md)、[ADR 0105](adr/0105-opencode-service-autostart.md)）
- 添付ファイルの実体は渡さず、本文のパス注記だけを送る
- 圧縮は完了したものだけを区切りにし、`tokensBefore` は `null`

### Pi

- 会話はセッション JSONL の active branch から読む（[ADR 0013](adr/0013-pi-session-chat.md)）
- モデル・effort・context・usage・圧縮・添付ファイル・引用の基準実装
- デフォルトモデルで起動したペインは、チャット画面を開いたときと `/new` で会話が空に戻ったときに pi の既定モデルと effort を読む。hwc の画面はモデルを指定して起動するので（[ADR 0104](adr/0104-launch-with-explicit-model.md)）、これはモデル未指定の起動 API を直接呼んだ場合だけ。モデルを指定して起動したペインは起動時の指定で補う。どちらも会話にモデルが載っている間はセッションの値を使う。hwc 以外から起動したペインは対象外（[ADR 0033](adr/0033-launch-model-before-first-message.md)、[ADR 0087](adr/0087-default-model-display.md)、[ADR 0091](adr/0091-empty-session-model-display.md)）
- プロジェクトの `Trust project folder?` は、既定の `Trust` だけを専用ビューで回答する。`.pi` や `.agents/skills` など信頼対象のリソースがあるフォルダでは、起動がこの確認で止まる。他の選択肢は端末で行う（[ADR 0044](adr/0044-pi-project-trust.md)）。hwc は `--approve` を渡さない
- Herdr は Pi の信頼確認を `blocked` としないため、一覧の行は `idle` のまま。確認ビューは、開いているペインの画面から出す
- ライブ activity は pi 拡張の sidecar がある場合だけ（[ADR 0035](adr/0035-live-pi-activity.md)）。Claude は transcript の段階に、hwc 起動時だけ mod の速度を重ねる（[ADR 0102](adr/0102-claude-live-tok-rate.md)）
- 過去の自分の発言は、mypi の `/hwc-rewind` と `hwc-capabilities` があるセッションだけ鉛筆で編集できる。押した時点では戻さず、送信時に会話を対象の親へ戻して本文を送り直す（[ADR 0089](adr/0089-pi-message-edit.md)）

## 実装の入口

| 項目                                    | 場所                                                                                                                  |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| エージェント種別、モデル・effort の対応 | `src/shared/agents.ts`                                                                                                |
| 会話の読み取り口の解決                  | `src/server/herdr/state.ts` の `ChatSource`                                                                           |
| 質問への回答（Esc → 本文）              | `src/server/answer-question.ts`、`src/shared/answer.ts`、`src/client/answer.ts`                                       |
| 応答待ちの hook・sidecar・カード        | `src/server/claude-hook.ts`、`claude-settings.ts`、`src/server/chat/claude-sidecar.ts`、`src/client/pane/pending.tsx` |
| 各 CLI の会話 reader                    | `src/server/chat/pi.ts`、`claude.ts`、`codex.ts`、`opencode.ts`                                                       |
| 起動引数と部分成功                      | `src/server/create-pane.ts`、`src/server/agent-models.ts`                                                             |
| Claude のモデルラベル                   | `src/server/claude-model-labels.ts`、`src/client/launch-candidates.ts`                                                |
| 新しいペインの既定と初期選択            | `src/server/launch-defaults.ts`、`src/client/launch-choice.ts`、`src/client/settings/AgentSettings.tsx`               |
| 既定モデル・effort の遅延表示           | `src/server/pi-defaults.ts`、`src/client/pane/use-default-model.ts`                                                   |
| コマンド候補とガード                    | `src/client/commands.ts`                                                                                              |
| ライブ activity                         | `src/server/chat/activity.ts`（pi）、`src/server/chat/claude.ts`、`src/server/chat/claude-live.ts`（Claude）          |
| フォルダ信頼確認（Codex / Pi）          | `src/client/confirmation.ts`、`src/server/folder-trust.ts`                                                            |
| 過去の発言の編集                        | `src/server/routes/edit-message.ts`、`src/client/edit.ts`、`src/shared/rewind.ts`                                     |
| 添付・引用・activity の UI 分岐         | `src/client/PaneDetail.tsx`                                                                                           |
| E2E の架空データ                        | `e2e/fixtures/scenario.ts`、`e2e/fake-*.ts`、[docs/e2e.md](e2e.md)                                                    |

## 更新のしかた

1. 表を直す前に、実装と ADR のどちらが正かを確認する。仕様を変える場合は ADR を追加または更新し、この表はその結果として直す
2. エージェントを追加するときは、`AGENT_KINDS`、アイコン、`supportsModelSelection`、`ChatSource`、会話 reader、起動引数、UI の分岐、E2E fixture を同じ変更で揃える
3. 会話表示を追加するときは、`ChatSource` と `SessionChatClient`、`GET /api/panes/:id/chat`、`pane.chat` を前提にしたクライアントの分岐（添付・引用・画像プレビュー・activity・コマンド）を確認する
4. 表を更新したら、`bun run e2e:serve` で該当エージェントのペインを作り、起動・会話・送信・停止・モデル表示・コマンド候補・添付・要対応の表示を確認する。実 Herdr は使わない
5. 変更後は `bun run fmt:check`、`bun run lint`、`bun run typecheck`、`bun run test` を通す

## 関連 ADR

- [ADR 0013: 会話履歴は pi のセッション JSONL を正とする](adr/0013-pi-session-chat.md)
- [ADR 0027: 新しいペインは名前と起動エージェントをダイアログで選ぶ](adr/0027-new-pane-agent.md)
- [ADR 0028: opencode の会話はローカルサービスの HTTP API から読む](adr/0028-opencode-chat.md)
- [ADR 0030: モデルと effort は新しいペインの起動時に選ぶ](adr/0030-new-pane-model.md)
- [ADR 0031: Codex の会話は App Server の読み取り API から読む](adr/0031-codex-chat.md)
- [ADR 0032: Codex のフォルダ信頼確認はチャットを確認ビューへ切り替えて回答する](adr/0032-codex-folder-trust.md)
- [ADR 0033: 起動直後のモデル表示は起動時の指定で補う](adr/0033-launch-model-before-first-message.md)
- [ADR 0035: 実行中の段階と thinking の末尾は pi 拡張の sidecar から一時表示する](adr/0035-live-pi-activity.md)
- [ADR 0041: エージェントが書いた画像をメッセージ内でプレビューする](adr/0041-agent-message-images.md)
- [ADR 0044: Pi のプロジェクト信頼確認も確認ビューで回答する](adr/0044-pi-project-trust.md)
- [ADR 0096: Claude のモデルと effort は起動時にエイリアスと段階で選ぶ](adr/0096-claude-model-effort.md)
- [ADR 0097: Claude の会話は transcript を射影して読む](adr/0097-claude-chat-transcript.md)
- [ADR 0099: AskUserQuestion は Esc で閉じ、選んだ内容を本文で答える](adr/0099-answer-ask-user-question.md)
- [ADR 0100: Claude の実行中の段階は transcript の進行行から出す](adr/0100-claude-live-activity.md)
- [ADR 0102: Claude の生成中の tok/s は同梱 mod のファイルから出す](adr/0102-claude-live-tok-rate.md)
- [ADR 0104: 新しいペインは、hwc の既定から選んだモデルと effort で必ず起動する](adr/0104-launch-with-explicit-model.md)
- [ADR 0105: OpenCode のサービスは、候補を読むときに hwc が起動する](adr/0105-opencode-service-autostart.md)
- [ADR 0106: Claude のコンテキスト使用量は同梱 mod の `session.usage` から出す](adr/0106-claude-context-usage.md)
- [ADR 0108: Claude のモデルは表示名で出し、起動時の指定と実際のモデルを区別する](adr/0108-claude-model-display-name.md)
- [ADR 0112: Claude の応答待ちは hook の sidecar から読み、チャットに出す。Web からは承認しない](adr/0112-claude-pending-in-chat.md)
- [ADR 0114: モデルのラベルは、どのエージェントでも provider を出さず、Pi だけ残す](adr/0114-model-label-by-agent.md)
- [ADR 0117: Claude のモデルラベルは CLI に問い合わせ、BFF で短時間キャッシュする](adr/0117-claude-model-labels-from-cli.md)
- [ADR 0118: エージェントのマークは本家の配色で描く](adr/0118-agent-brand-colors.md)
