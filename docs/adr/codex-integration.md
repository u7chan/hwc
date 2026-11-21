# Codex の会話は App Server の読み取り API から読み、hwc からは --no-daemon で起動する

- Status: Accepted

## Context

Herdr の SessionStart 連携は Codex に `agent_session: { agent: "codex", source: "herdr:codex", kind: "id", value: "..." }` を返す。Codex CLI 0.166.0 の保存形式には legacy と paginated があり、JSONL だけを読むと paginated の本文を取りこぼす。App Server の読み取り専用 API（`thread/read`、`thread/turns/list`）は両方を扱い、resume・購読・既読更新をせずに履歴を取れる。

共有 App Server の SessionStart フックは、接続元のペインではなくデーモンの環境変数で動く。そのため会話 ID が別のペインに報告されるか、報告されない。

Codex は未登録のフォルダを開くと `Folder access` の確認で止まる。この間に文字や停止キーを送ると別の操作として解釈され得る。確認は、フォルダ内の設定や hooks による自動実行を許可する判断でもある。

## Decision

- hwc から新規起動する Codex には `--no-daemon` を渡し、SessionStart フックを起動元のペインの環境で動かす。モデルは `--model id`、effort を選んだときだけ `--config 'model_reasoning_effort="value"'` を足す。既定の provider・モデル・effort の設定は保存しない
- 会話は取得ごとに `codex app-server --stdio` を起動し、`initialize` / `initialized` の後に読み取り API だけを呼ぶ。保存済みの履歴を正とし、稼働中のスレッドを resume しない。`itemsView` は assistant 本文を省かない `full` を使う
- 出すのは `userMessage` の text と `agentMessage` の本文だけ。ツール・reasoning・system・圧縮内部の item は出さない
- 読み取り API はコンテキスト使用量と圧縮要約を返さないので、`context` と `compaction` は `null` にする。推測しない
- 読み取り用プロセスから `HERDR_*` と `CODEX_THREAD_ID` を外す。時間と出力量に上限を置き、終了時は必ず回収する。新しい常駐サービスは足さない
- モデル候補は同じ App Server の `config/read`（`model_provider`）と `model/list`、effort 候補は選んだモデルの `supportedReasoningEfforts` から読む
- 入力・停止・コマンドは Herdr 経由のまま。App Server からプロンプトを送ったりスレッドを変更したりしない
- `Folder access` には「Trust and continue」だけを Web から答える。既知の注意文・選択肢・フッターが揃い、「Trust and continue」が選択中で、信頼対象の完全なパスを読めるときだけ答える。答え方は [入力](agent-input.md) に従う

## Consequences

- Codex と BFF が同じユーザー・同じホスト・同じ `CODEX_HOME` を使う前提になる
- hwc の外で起動した Codex や、`--no-daemon` 以前から動いているペインは、会話 ID が報告されず端末出力のままになる
- 取得のたびにプロセスを起動するコストを負う。ストリーミングの delta は購読しないので、保存済み item への反映とポーリングの間隔だけ表示が遅れる
- 読み取り API と画面の文言は CLI の版で変わり得る。読めなければ端末出力へ戻り、確認画面は推測で答えない

## Alternatives

- **JSONL を直接読む**: プロセスを起動しないが、paginated の本文を取りこぼす
- **共有 App Server に接続し続ける**: 起動コストは減るが、常駐の管理が増え、会話 ID の報告の問題も残る
- **App Server からプロンプトを送る**: TUI と hwc のどちらが正か曖昧になる
