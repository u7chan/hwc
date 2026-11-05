# ADR 0031: Codex の会話は App Server の読み取り API から読む

- Status: Accepted
- Date: 2026-11-05

## Context

Codex CLI が起動できるようになり、Herdr の SessionStart 連携は `agent_session` に `{ agent: "codex", source: "herdr:codex", kind: "id", value: "..." }` を返す。端末出力ではなく、Web から会話を読んで次の指示を送りたい。

Codex CLI 0.166.0 は App Server に読み取り専用の `thread/read` と `thread/turns/list` を持つ。保存形式は legacy と paginated があり、JSONL だけを読むと paginated の本文を取りこぼす。App Server の読み取り API は両方を扱い、resume・購読・既読更新をせずに履歴を取得できる。

## Decision

- `ChatSource` に Codex の session id を加える。Herdr が返した id を BFF 内で解決し、クライアントから session id や path を受け取らず、返さない
- 取得ごとに `codex app-server --stdio` を起動し、`initialize` / `initialized` の後に読み取り API だけを呼ぶ。保存済み履歴を正とし、稼働中の TUI のスレッドを resume しない。同じ session id の同時取得は 1 回にまとめる
- `thread/read` の `model` と `reasoningEffort` を表示する。会話は `thread/turns/list` を新しい順・20 ターンずつ取得し、時系列へ並べ直す。`itemsView: "summary"` は assistant 本文を省くため `full` を使う
- 表示対象は `userMessage` の text と `agentMessage` の本文だけ。ツール、reasoning、system、圧縮内部の item は出さない。user の hwc 添付注記は既存の `stripAttachedFiles` で除き、ファイル名だけを返す。Codex 自身の画像添付は画像があったことだけを表示する
- メッセージ ID はターン ID と item ID の組で安定させる。時刻は item の開始時刻、完了時刻、ターンの開始時刻の順に採る。取得できない時刻は 0 にする
- 応答の上限は既存の 500 メッセージ / 1MB とし、古い側を切ったら `truncated` を立てる。ツールだけの履歴を無限に辿らないよう、最大 25 ページ（500 ターン）で打ち切り、未取得のページがあれば同じフラグで知らせる
- 読み取り API はコンテキスト使用量と圧縮要約を返さないため、`context` と `compaction` は `null`。会話はモデルの圧縮後の文脈ではなく、保存された会話履歴を表示する。圧縮前を取り除いたり、要約を推測したりしない
- `etag` は session id と表示するスナップショットのハッシュから作り、既存の弱比較による 304 を使う
- 読み取り用プロセスから `HERDR_*` と `CODEX_THREAD_ID` を外す。1 回の取得は初期化を含め 20 秒、stdout は合計 32MB で打ち切り、終了時は必ずプロセスを回収する。新しい常駐サービスや外部依存は追加しない
- CLI が無い・API が失敗した・形式が読めない場合は `502 chat_unavailable` とし、既存の端末出力へフォールバックする
- 入力・停止・コマンドは既存の Herdr 経由のまま。App Server からプロンプト送信やスレッドの変更は行わない
- ADR 0013 の pi 以外を端末出力にする判断のうち、Codex をこの ADR で置き換える。起動時のモデル選択は ADR 0030 に従う

## Consequences

- Codex と BFF が同じユーザー・同じホスト・同じ `CODEX_HOME` を使うことが前提になる。リモートの Codex は対象外
- 読み取り API とフィールドは Codex CLI 0.166.0 で確認した。今後形式が変わった場合は端末表示へ戻る
- ストリーミングの delta は購読しない。保存済み item への反映と既存のポーリング間隔だけ表示が遅れる
- 取得ごとのプロセス起動と、`full` に含まれるツール結果の読み出しコストを負う。上限に達した履歴は全体を Web へ出さず、端末出力を使う
- 圧縮は既存のコマンドとして送れるが、Codex の圧縮完了を会話の区切りとして検出しない。進捗表示の期限や中断は既存の規則に従う

## References

- [Codex App Server](https://developers.openai.com/codex/app-server/)
- [ADR 0013](0013-pi-session-chat.md)
- [ADR 0030](0030-new-pane-model.md)
