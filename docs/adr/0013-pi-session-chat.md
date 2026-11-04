# ADR 0013: 会話履歴は pi のセッション JSONL を正とする

- Status: Accepted
- Date: 2026-11-02

## Context

ペインの会話を Web に出す必要がある。取得元の候補は 2 つある。

1. Herdr の `pane.read` / `agent.read` が返す端末出力
2. pi が保存するセッション JSONL

端末出力は TUI の描画結果で、折り返し・全画面 UI・再描画の残骸を含む。会話の本文だけを取り出すには画面を解釈するしかなく、`user` と `assistant` の区別もモデル名も安定して取れない。

pi は会話を v3 の JSONL で保存している。`user` / `assistant` のメッセージ、`id` / `parentId` の木、`model` / `thinkingLevel` が構造として入っており、追記型で 1 行 1 エントリになっている。Herdr は `session.snapshot` のペインに `agent_session`（`{ agent, source, kind, value }`）を返し、`kind: "path"` ならそのファイルを読める。

制約は次のとおり。

- BFF は Herdr と同じユーザーで動くため、セッションファイルを直接読める
- セッションは 40MB の実績があり、要求のたびに全読みはできない
- ペインとセッションは 1:1。分岐（`/tree`）は pi の TUI の機能で、Herdr に分岐操作の API は無い
- クライアントはスマホが主で、必要なのは直近の会話だけ

## Decision

- 会話履歴の正は pi のセッション JSONL とし、SQLite などの二次ストアを持たない
- ペインとセッションは 1:1 とみなす。Web は現在のセッションの active branch を映すだけで、セッション選択・分岐・過去セッション一覧は持たない
- BFF がペイン id からセッション path を解決し、path はクライアントへ渡さない。クライアントから path も受け取らない
- path ごとに増分リーダーを持ち、要求時にスナップショット（`etag` / `messages` / `model` / `effort` / `truncated` / `context` / `compaction`）を返す。バックグラウンド監視はしない。`messages` の user は `attachments?: string[]`（ペイン配下のファイル名のみ）を持ち、本文へ貼った `<attached_files>` 注記は BFF が strip して返す（[ADR 0018](0018-pasted-image-attachments.md)）
- スナップショットに直近の compaction（`at` / `tokensBefore` / `summary`）を含める。`messages` はその compaction の `firstKeptEntryId` 以降に限り、圧縮より前の会話は返さない。モデルの実際の文脈（要約 + kept 分）と表示を一致させるため
- 評価するのは最新の compaction エントリだけ。それに `firstKeptEntryId` が無い・`summary` が空・`firstKeptEntryId` が active branch に無い・compaction が無いときは、`compaction` を `null` にして branch 全体を返す。古い compaction へは遡らない。要約だけ出して窓がずれる状態を作らない
- 入れ子の compaction は最新のみを採る。compaction エントリは `message` を持たないため、窓に入っていても会話としては描画されない
- コンテキスト使用量は pi のモデルカタログを第二の情報源にする。`tokens` はセッション中の usage から、`window` は `models-store.json` の `contextWindow` に `models.json` の `providers[].modelOverrides` を重ねたカタログから引く。agent dir はセッション path（`<agent-dir>/sessions/<slug>/<file>.jsonl`）から導き、カタログは agent dir ごとにプロセス内で 1 回だけ解決する。引けないときは `null` を返し、`tokens` と `window` の両方が `null` なら `context` を `null` に畳む
- 読み取りは追記分だけを対象にし、ヘッダの `id` の変化・`size` の減少・inode の変化・ファイルの消失で全リセットする。パースできない行はその行だけ捨てる
- 応答は直近 500 メッセージ / 1MB の小さい方を上限にし、切ったら `truncated` を立てる。上限は窓に絞ったあとの `messages` に効く
- `etag` は path のハッシュ・リーダー生成時のランダム id・読み取り世代から作り、`If-None-Match` の弱比較で 304 を返す。世代は追記を消費したときとリセットしたときだけ進め、ENOENT が続く間は同じ `etag` を返す

## Consequences

- 会話の表示は pi のセッション形式に依存する。形式が変わると追従が必要になる
- ツールコール・thinking・ツール結果のエントリは表示しない。ツール実行だけのターンは会話に出ないため、`working` の表示で補う
- compaction は履歴の区切りとして 1 行（要約の展開付き）で表示し、それ以前の会話は返さない。pi の TUI が `[compaction]` の 1 行に置き換えるのと同じ見え方になり、古いメッセージの描画も減る
- 窓が成立しない（`firstKeptEntryId` が branch に無い等）ときは全体を返すため、圧縮済みなのに古い会話が並ぶことがある。要約だけを出して窓とずらすより、表示と実体が一致する側を選ぶ
- `/tree` で分岐先を選んだだけ（送信前）はファイルに追記が無く、次の送信まで前の枝を表示する
- セッションが無い・pi 以外・読み取りに失敗したときは端末出力にフォールバックする。ENOENT は空の会話として扱う。OpenCode は [ADR 0028](0028-opencode-chat.md) でローカルサービス API から読む
- セッション形式は v3 を前提にする。v3 以外のヘッダはリセットではなく 502 `chat_unavailable` として扱うため、書き換えの検出はヘッダ `id` で行う
- キャッシュから追い出されたセッションは次の要求で全読みになる。上限は path あたり 8 件
- 送信直後は pi がメッセージを書くまで遅れる。ローカルの pending を「送信中」として表示し、送信時点の最後の user 発話より後に新しい user 発話が現れたら置き換える。ターン終了または一定時間で打ち切る。正はセッションのまま
- 500 件 / 1MB より古い会話は Web からは読めない
- モデルカタログは起動時に固定する。プロバイダの追加や override の変更は BFF の再起動まで反映されない。`window` がプロセス内で定数になるため、応答の `ETag` はセッションの generation だけで整合する
- `models-store.json` に無いモデル（組み込みのみのプロバイダ、拡張が足したモデル）は `window` が `null` になり割合を出さない。数値と window の片方だけ分かればその片方を出す
- 未応答メッセージ分の推定はせず、`compaction` と `context_edit` の後は次の usage まで `tokens` を `null` にする。pi の TUI より小さく出るか早く `?` になるが、hwc の reader では pi と完全一致にできない
