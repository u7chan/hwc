# ADR 0097: Claude の会話は transcript を射影して読む

- Status: Accepted
- Date: 2026-11-19
- Amends: [ADR 0078](0078-starting-pane-mask.md)
- Revises: [ADR 0013](0013-pi-session-chat.md)、[ADR 0027](0027-new-pane-agent.md)、[ADR 0096](0096-claude-model-effort.md) の Claude に関する記述

## Context

Claude のペインは起動・名前・送信・停止・`/new` `/compact` の送信だけを Web から行え、会話は端末出力で読んでいた（[ADR 0027](0027-new-pane-agent.md)、[ADR 0096](0096-claude-model-effort.md)）。スマホでは TUI の折り返しと再描画が残り、長い回答ほど読みにくい。

Herdr 0.9.5 は Claude のセッションを `agent_session: { source: "herdr:claude", agent: "claude", kind: "id", value: "<session uuid>" }` として返す。会話の取得口は、この id から transcript を引けば足りる。

Claude Code 2.1.327 は `CLAUDE_CONFIG_DIR`（既定 `~/.claude`）配下の `projects/<project>/<session uuid>.jsonl` に transcript を書く。ローカルの transcript 14 本で確認した形は次のとおり。

- `user` の `message.content` は文字列（利用者の発言）。tool_result は配列で入る
- `assistant` は 1 つの API メッセージを block ごとに複数 entry へ分けて書く。同じ `message.id` の組は 25 組あり、すべて block 構成が異なる（text / thinking / tool_use が別 entry）
- `message.model` と `perTurnEffort` を持つ。後者は実測で `xhigh` 82 / `low` 3 / `medium` 1 / `high` 1 / null 8
- `uuid` / `parentUuid` を持つのは `user` / `assistant` / `attachment` / `system` だけ。`mode` / `api-request` / `file-history-snapshot` などは持たない
- `isApiErrorMessage: true` の assistant が 1 件ある。`model: "<synthetic>"`、`error: "authentication_failed"`、本文は短い案内
- `isMeta: true` の user が 16 件ある。`isCompactSummary` / `compact_boundary` は手元に無く、圧縮済みの形は確認できていない
- user の文字列には、TUI の `/model` や `/theme` の実行記録（`<command-name>` と `<local-command-stdout>`）が 26 件入っていた。利用者の発言ではない

制約は次のとおり。

- BFF は Herdr と同じユーザーで動くため、transcript を直接読める
- transcript は追記型で、1 行 1 entry。書き込み途中の行が末尾に現れる
- セッションは大きくなり得る。既存の 500 メッセージ / 1MB の上限は変えない
- 表示できるのは user の本文と assistant の text だけ。usage の形と圧縮の形は別 Issue で扱う

## Decision

- 会話は transcript の JSONL を読み取り専用で射影する。端末出力は使わない。Herdr の送信・停止・コマンドは変えない
- `ChatSource` に `{ agent: "claude", sessionId }` を足し、`chatSourceOf` は `kind === "id"` のときだけ返す。path 形の claude は対象外のまま。`src/server/chat/claude.ts` が `SessionChatClient` を実装し、BFF の client map に繋ぐ。`AppContext.claude` は optional にして、読めない構成でもペイン一覧と端末出力を保つ
- `CLAUDE_CONFIG_DIR` は要求のたびに読む（既定 `~/.claude`）。絶対パスでない値は既定に落とす。`projects/*/<session uuid>.jsonl` を id で探し、プロジェクト名（cwd のエンコード）は再実装しない
- 見つかった path はプロセス内で session id ごとに覚える。キーには `CLAUDE_CONFIG_DIR` を含める。見つからなかった結果は 30 秒だけ覚え、poll のたびに `projects/*` を readdir しない。同じ id が複数のプロジェクトにあるときは、どれが会話か決められないので `ChatUnavailableError` にする
- ファイルは全読みする。16MB を超えるときは末尾 16MB を読み、最初に現れた entry を branch の起点にして `truncated` を立てる。書き込み途中の行は捨てて次回読む。増分読みと索引キャッシュは、大きなセッションで問題が出たときに別 Issue で足す
- 射影は path + size + inode が変わらなければ使い回す。`etag` は session id と射影のハッシュから作り、既存の弱比較で 304 を返す
- 分岐（`/rewind` や resume）で古い枝を混ぜない。最後の entry から `parentUuid` を辿って active branch を作る。`attachment` / `system` は parent を辿るためだけに通し、行にはしない。`isSidechain === true` の entry は行にせず、葉にも起点にもしない
- assistant は `message.id` ごとに束ね、text block をファイル順に連結する。`id` と `at` は最初の entry の `uuid` と `timestamp`。text が空の組は行にしない。`thinking` と `tool_use` は捨てる
- user は文字列を本文にする。配列のときは text ブロックだけを拾い、tool_result だけの entry と画像だけの entry は行にしない。`isMeta === true` と `isCompactSummary === true` は出さない。TUI のローカルコマンドの記録（`<command-name>` / `<local-command-stdout>` などで始まる本文）も出さない
- `<attached_files>` は既存の `stripAttachedFiles` で落とし、名前だけを `attachments` に残す。名前を取り出せない注記は、絶対パスを画面に出さないため注記ブロックごと落とす。本文が空になったら行にしない
- `isApiErrorMessage: true` の assistant は `role: "error"` にして、`error` と本文を並べる（[ADR 0039](0039-chat-error-rows.md) と同じ見え方）。中断・拒否の tool_result は error 行にしない
- `model` は branch の最後の assistant の `message.model`（`<synthetic>` は採らない）。`effort` は最後の非 null の `perTurnEffort`。起動時にモデルを指定したペインは、assistant がまだ無いときだけ `launchModels` の預かりで補う（[ADR 0033](0033-launch-model-before-first-message.md)）。デフォルト起動では最初の応答まで null のまま
- `context` と `compaction` は `null`、`usage` は持たない。コンテキスト量・圧縮の区切り・モデル別の window は別 Issue で扱う
- 取得の上限は既存の `limitMessages`（500 メッセージ / 1MB）に従い、切ったら `truncated` を立てる
- transcript が見つからない・読めない・1 行も解釈できない・id がファイル名として不正なときは `ChatUnavailableError` を投げ、既存の 502 から端末出力へフォールバックさせる。pi と違い ENOENT を空の会話にしない（セッション参照はあるのにファイルが無い状態を、空の会話と取り違えない）
- `ChatAgentKind` に `claude` を足す。4 つの CLI がすべて会話を読めるようになるため、`ModelAgentKind` は `ChatAgentKind` の別名にし、`supportsChat` と `supportsModelSelection` は用途別に残す
- 起動待ちは [ADR 0078](0078-starting-pane-mask.md) の規則をそのまま適用する。Claude も `pane.chat` が true になるまで待つ
- [ADR 0013](0013-pi-session-chat.md) の「pi 以外は端末出力」のうち Claude をこの ADR で置き換える。モデル・effort の表示は [ADR 0096](0096-claude-model-effort.md) の「起動時の指定ではなくセッションを正にする」に従う

## Consequences

- 会話の表示は transcript の内部形式に依存する。CLI の版で形が変われば読めなくなり、端末出力へ戻る。画面には理由が出ないので、会話が出ないことに気づきにくい
- ツール実行と thinking は会話に出ない。ツールだけのターンは `working` の表示で補う
- 16MB を超えるセッションは先頭が切れる。切ったことは `truncated` で分かるが、古い会話は Web からは読めない。増分読みは別 Issue
- 圧縮済みセッションの形は実物で確認できていない。`isCompactSummary` は本文に出さないところまでを暫定にし、区切りと要約は別 Issue で扱う。要約を出さないぶん、圧縮前の会話がそのまま並んで表示と実体がずれる
- 画像は v1 では出さない。画像だけを送った発言は本文が空になるため行にしない
- サブエージェント（`isSidechain`）の会話は出ない。本流の会話だけを映す
- TUI のローカルコマンド実行は会話に残らない。`/model` や `/theme` の結果は端末で読む
- 添付は本文の `<attached_files>` 注記のままで、実体は CLI へ渡していない。保存先はチェックアウトの外なので、Claude がそのパスを読むときに権限確認が出たら端末で承認する
- `isCompactSummary` を持つセッションでは、要約の行が出ないまま前後の会話が並ぶ。区切りの設計は別 Issue に寄せる
- 会話を読むエージェントが 4 つ揃ったので、hwc から起動したペインはどれも `pane.chat` を待つ。チャットを持たないのは未知のエージェントだけになる（[ADR 0078](0078-starting-pane-mask.md)）
- hwc から起動した Claude が最初の送信まで `agent_session` を持たない場合、起動待ちが最大 10 秒続く。実機でのタイミングは未確認で、3 秒の settle に戻すかは確認してから決める
- transcript は BFF と CLI が同じユーザー・同じホストで動いている前提。リモートや別ユーザーの Claude は端末出力のままになる

## Alternatives

- **端末出力を解釈する**: TUI の描画結果から本文を拾う案。折り返し・全画面 UI・再描画の残骸で user と assistant の区別もモデルも安定しない（[ADR 0013](0013-pi-session-chat.md) と同じ理由）
- **増分リーダーを持つ**: pi と同じく追記分だけを読む案。transcript は 1 行が巨大な tool_result になり得て、行の途中から読み直す設計が要る。まず全読み + 16MB 上限で足りるかを見て、必要になったら足す
- **プロジェクト名から path を組み立てる**: `projects/<cwd のエンコード>/<uuid>.jsonl` を cwd から計算する案。エンコードは CLI の内部形式で、版で変わる可能性がある。id で探せば同じ結果が得られる
- **同じ id が複数あるときは新しい方を選ぶ**: mtime の新しい方を採る案。どれが会話か決められない状態を推測で埋めると、別の会話を見せることになる
- **`/new` のあとの空セッションを空の会話として返す**: pi と同じ扱いにする案。Claude はセッション参照が先にあり、transcript が消えた場合と区別できないため、読めないときは端末出力へ倒す
- **起動時に選んだモデル・effort を表示し続ける**: CLI の設定と食い違うことがある。セッションに載ったらセッションの値にする（[ADR 0096](0096-claude-model-effort.md)）
- **usage と圧縮の区切りも同時に出す**: transcript の `usage` は API 呼び出しごとの値で、コンテキスト量の意味づけが pi と違う。圧縮の形も実物が無い。別 Issue で扱う
