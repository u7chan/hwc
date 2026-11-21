# OpenCode の会話はローカルサービスの HTTP API から読み、候補を読むときだけ hwc がサービスを起動する

- Status: Accepted

## Context

Herdr は OpenCode のペインに `agent_session: { agent: "opencode", source: "herdr:opencode", kind: "id", value: "ses_..." }` を返す。OpenCode は TUI とバックグラウンドサービスを分け、会話はサービスが持つ。サービスは `$XDG_STATE_HOME/opencode/service.json`（既定は `~/.local/state/opencode/service.json`）に `url` と `password` を書き、`opencode:<password>` の Basic 認証で HTTP API を提供する。

会話の保存先には SQLite（`opencode.db`）もあるが、1GB を超え、スキーマは内部実装で、実行中セッションの読み出し経路としても安定していない。サービス API は TUI が見ているものと同じ射影を返す。

モデルと effort の候補もサービスの API から読む。サービスが止まっていると候補を読めず、hwc から OpenCode を起動できない。サービスを起動するには端末で `opencode service start` を打つしかなく、スマホからは操作できない。

## Decision

- 会話はサービスの HTTP API から読む。`service.json` は要求のたびに読み、`url` が `http` かつ loopback のときだけ使う。パスワードは BFF の中だけに置く
- 会話は `GET /api/session/:id/context`（最後の compaction 以降）、選択モデルは `GET /api/session/:id`、context window は `GET /api/model` の `limit.context` から取る
- 出すのは user と assistant の `text` パートだけ。reasoning・tool・shell・system・synthetic は出さない
- 入力の送信は Herdr の `pane.send_input` を使う。サービスの API からメッセージを送らない
- モデル候補は `GET /api/model?location[directory]=...` の `enabled: true` のモデル、effort 候補はそのモデルの `variants[].id` から読む。モデルを指定した起動は `POST /api/session` で新しいセッションを作り、`--session <id>` で開く
- 候補を読む操作でサービスが未起動と分かったら（`service.json` が無い、または接続が拒否された）、BFF が `opencode service start` を 1 回実行して読み直す。同時に来た読み取りは 1 回の起動を待ち合わせる。起動はホームディレクトリで、`HERDR_*` を除いて行う。会話の読み取りからは起動しない
- hwc はサービスを止めない

## Consequences

- 会話の表示は `/api` と `service.json` の形に依存する。`/api` は experimental と明記されている。変わったら端末出力に戻る
- BFF と OpenCode が同じユーザー・同じマシンで動く前提になる
- 圧縮前のトークン数は API から取れないので、圧縮の区切りに数字は出ない
- OpenCode を開かない限りサービスは起動しない。起動したサービスは hwc を止めても残る

## Alternatives

- **SQLite を直接読む**: サービスが要らないが、内部スキーマと巨大なファイルに依存する
- **「サービスを起動」ボタンを出す**: 起動を利用者の操作に限れるが、OpenCode を開いた時点で使う意図ははっきりしており、毎回 1 回多く押させるだけになる
- **hwc の起動時にサービスも起動する**: 候補をすぐ読めるが、OpenCode を使わないときもサービスが常駐する
