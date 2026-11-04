# ADR 0028: opencode の会話はローカルサービスの HTTP API から読む

- Status: Accepted
- Date: 2026-11-05

## Context

ADR 0013 は会話履歴の正を pi のセッション JSONL とし、pi 以外のエージェントは端末出力へフォールバックすると決めた。ADR 0027 で OpenCode のペインを起動できるようになったが、hwc は OpenCode の TUI をそのまま表示し、Web の入力欄から送ったメッセージへの返答も TUI の中でしか読めなかった。

Herdr は OpenCode のペインに `agent_session` を返す。この環境の 0.9.5 では `{ agent: "opencode", source: "herdr:opencode", kind: "id", value: "ses_..." }` で、pi の `kind: "path"` とは形が違う。

OpenCode 2.2.5 は TUI とバックグラウンドサービスを分け、会話はサービスが持つ。サービスは `$XDG_STATE_HOME/opencode/service.json`（既定は `~/.local/state/opencode/service.json`）に `url` と `password` を書き、`opencode:<password>` の Basic 認証で HTTP API を提供する。`GET /api/session/:id/context` は最後の compaction 以降のメッセージを、`GET /api/model` はモデルごとの `limit.context` を返す。

会話の保存先には SQLite（`opencode.db`）もあるが、サイズが 1GB を超え、スキーマは OpenCode の内部実装で、実行中セッションの読み出し経路としても安定していない。サービス API は TUI が見ているものと同じ射影を返すため、こちらを正にする。

## Decision

- ペインから会話の読み取り口への対応を `ChatSource`（`pi` の path / `opencode` の session id）で表し、BFF の state store がペイン id から解決する。path と session id はクライアントへ渡さない
- OpenCode はローカルサービスの HTTP API から読む。`service.json` は要求のたびに読み、`url` が `http` かつ loopback のときだけ使う。パスワードは BFF の中だけに置き、クライアントへ返さない
- セッションの選択モデルは `GET /api/session/:id`、表示する会話は `GET /api/session/:id/context` から取る。`context` は最後の compaction 以降に限られるため、pi の active branch と同じく圧縮前の会話は返さない
- 会話として出すのは user の `text` と assistant の `text` パートだけにする。reasoning・tool・shell・system・synthetic・idle は出さない。assistant の複数の text パートは空行で区切る。user の hwc 添付注記は `stripAttachedFiles` で本文から外し、`attachments` にファイル名だけを残す
- 完了した compaction だけを窓の先頭にする。失敗・実行中の compaction は区切りにしない。`summary` を表示し、`tokensBefore` は API から取れないため `null` にする
- コンテキスト量は、compaction 以降で最後に `output > 0` を持つ assistant の `input + output + reasoning + cache.read + cache.write` とする。opencode の TUI の sidebar と同じ条件で、ツールだけの中間応答では上書きしない。compaction の後は次の usage まで `null`
- コンテキストの window は `GET /api/model` の `limit.context` から、セッションの選択モデルの `providerID` と `id` で引く。選択モデルが無いときは usage を出した assistant のモデルを使う。モデル一覧はサービス URL とディレクトリごとにプロセス内で 1 回だけ読み、引けないときは `window` を `null` にする。失敗は固定せず、次の要求で読み直す
- 応答の上限は pi と同じ 500 メッセージ / 1MB とし、切ったら `truncated` を立てる。`etag` は session id とスナップショットの内容から作り、`If-None-Match` の弱比較で 304 を返す
- 入力の送信は今まで通り Herdr の `pane.send_input` を使う。OpenCode の API からメッセージを送ると、TUI と hwc のどちらが正か曖昧になるため使わない
- `service.json` が無い・読めない・loopback 以外・API が失敗したときは `502 chat_unavailable` を返し、クライアントは端末出力へフォールバックする
- ADR 0013 の「pi 以外は端末出力へフォールバックする」のうち、OpenCode についてだけこの判断で置き換える

## Consequences

- OpenCode の会話表示は `/api` と `service.json` の形に依存する。`/api` は experimental と明記されており、どちらも OpenCode 2.2.5 で確認したが、将来の版で変わる可能性がある。変わった場合は端末出力に戻る
- BFF と OpenCode が同じユーザー・同じマシンで動いている必要がある。リモートや別ユーザーの OpenCode は TUI のままになる
- モデル一覧はプロセス内で固定する。起動後にプロバイダやモデルを追加しても、BFF を再起動するまで window は出ない
- reasoning とツール実行は表示しない。ツールだけのターンは会話に出ないため、`working` の表示で補う
- compaction 前のトークン数は分からないため、圧縮の表示は「圧縮」になる
- hwc の添付画像は本文の `<attached_files>` 注記にパスを書く。OpenCode がそのパスを読めれば機能するが、hwc は添付の実体を API で渡してはいない。OpenCode の TUI から直接付けたファイルは `files` に入るが、hwc は表示も配信もしない
- サービスが起動していてもセッションが見つからないときは端末出力へフォールバックする。新しいセッションが作られるまでの短い間も同じ
