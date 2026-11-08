# エージェント対応状況

hwc が各エージェント CLI のどこまでを Web から扱えるかを 1 ページで把握するための表。仕様の正は実装と ADR で、この表は俯瞰用。実装や ADR を変えたら、同じ変更でこの表も更新する。

最終確認: 2026-11-08（Herdr 0.9.5、`bun run e2e:serve` の架空 Herdr）

凡例:

- ○: Web から使える
- △: 条件付き、または一部だけ
- ×: 非対応（端末出力で操作する）
- –: そのエージェントに概念がない

| 機能                                     | Pi  | Claude | Codex | OpenCode          |
| ---------------------------------------- | --- | ------ | ----- | ----------------- |
| 起動（新規ペイン / ワークツリー / 名前） | ○   | ○      | ○     | ○                 |
| 起動時のモデル指定                       | ○   | ×      | ○     | ○（サービス必要） |
| 起動時の effort 指定                     | ○   | ×      | ○     | ○（サービス必要） |
| Web での会話表示                         | ○   | ×      | ○     | ○                 |
| 送信・停止                               | ○   | ○      | ○     | ○                 |
| モデル・effort の表示                    | ○   | ×      | ○     | ○                 |
| コンテキスト使用量・usage                | ○   | ×      | ×     | ○                 |
| 圧縮の区切り                             | ○   | ×      | ×     | ○                 |
| 添付画像                                 | ○   | ×      | △     | △                 |
| メッセージ内の画像プレビュー             | ○   | ×      | ○     | ○                 |
| 引用返信                                 | ○   | ×      | ○     | ○                 |
| `/new` `/compact` の候補                 | ○   | △      | △     | △                 |
| フォルダ信頼確認                         | –   | ×      | ○     | –                 |
| ライブ activity                          | ○   | ×      | ×     | ×                 |

- 添付画像の UI 自体は会話を持つペインで使えるが、hwc は画像の実体を CLI へ渡さず、本文に `<attached_files>` のパス注記を足すだけ。Pi はこの経路を前提にしている（[ADR 0018](adr/0018-pasted-image-attachments.md)）。Codex と OpenCode は、それぞれの CLI がそのパスを読めるか次第（[ADR 0028](adr/0028-opencode-chat.md)、[ADR 0031](adr/0031-codex-chat.md)）。
- コマンド候補のガードは会話スナップショットに依存する。Claude はスナップショットが無いため会話状態のガードが効かず、実行中以外は候補になる。Codex は context と compaction が無いため、履歴の小ささと圧縮済みの判定が効かない。OpenCode は圧縮済みの判定がほぼ効かない（[ADR 0013](adr/0013-pi-session-chat.md)）。

## エージェント別の要点

### Claude

- 起動・名前・送信・停止・`/new` `/compact` の送信だけ。会話は読まないため端末出力にフォールバックする（`chatSourceOf` が Claude を返さない）
- モデルと effort は起動時に選べず、デフォルトのみ（[ADR 0030](adr/0030-new-pane-model.md)）
- 初回の trust prompt などで `agent_not_ready` が返っても、起動成功としてペインを残す（[ADR 0027](adr/0027-new-pane-agent.md)）。ただし `blocked` でも入力欄は有効なので、確認画面へ Enter を送らないよう注意する
- 会話を持たないため、添付・引用・画像プレビュー・usage/context・圧縮の区切り・ライブ activity はない

### Codex

- 会話は App Server の `thread/read` と `thread/turns/list` から読む（[ADR 0031](adr/0031-codex-chat.md)）。hwc から起動するときは `--no-daemon` を付ける
- 読み取り API が context と compaction を返さないため、使用量と圧縮の区切りは `null`。モデルと effort は表示できる
- フォルダ信頼確認だけ専用ビューへ切り替える（[ADR 0032](adr/0032-codex-folder-trust.md)）

### OpenCode

- 会話はローカルサービスの HTTP API から読む（[ADR 0028](adr/0028-opencode-chat.md)）。`service.json` が無い、loopback でない、API が失敗するときは端末出力へフォールバックする
- モデルと effort はサービス API の model と variants から選ぶ。サービス未起動ではモデル候補が出ないが、デフォルト起動はできる（[ADR 0030](adr/0030-new-pane-model.md)）
- 添付画像の実体は渡さず、本文のパス注記だけを送る
- 圧縮は完了したものだけを区切りにし、`tokensBefore` は `null`

### Pi

- 会話はセッション JSONL の active branch から読む（[ADR 0013](adr/0013-pi-session-chat.md)）
- モデル・effort・context・usage・圧縮・添付・引用・live activity の基準実装

## 実装の入口

| 項目                                    | 場所                                                               |
| --------------------------------------- | ------------------------------------------------------------------ |
| エージェント種別、モデル・effort の対応 | `src/shared/agents.ts`                                             |
| 会話の読み取り口の解決                  | `src/server/herdr/state.ts` の `ChatSource`                        |
| 各 CLI の会話 reader                    | `src/server/chat/pi.ts`、`codex.ts`、`opencode.ts`                 |
| 起動引数と部分成功                      | `src/server/create-pane.ts`、`src/server/agent-models.ts`          |
| コマンド候補とガード                    | `src/client/commands.ts`                                           |
| フォルダ信頼確認                        | `src/client/confirmation.ts`、`src/server/folder-trust.ts`         |
| 添付・引用・activity の UI 分岐         | `src/client/PaneDetail.tsx`                                        |
| E2E の架空データ                        | `e2e/fixtures/scenario.ts`、`e2e/fake-*.ts`、[docs/e2e.md](e2e.md) |

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
- [ADR 0041: エージェントが書いた画像をメッセージ内でプレビューする](adr/0041-agent-message-images.md)
