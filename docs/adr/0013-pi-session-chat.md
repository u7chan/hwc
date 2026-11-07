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
- path ごとに増分リーダーを持ち、要求時にスナップショット（`etag` / `messages` / `model` / `effort` / `truncated` / `context` / `usage` / `compaction`）を返す。バックグラウンド監視はしない。`messages` の user は `attachments?: string[]`（ペイン配下のファイル名のみ）を持ち、本文へ貼った `<attached_files>` 注記は BFF が strip して返す（[ADR 0018](0018-pasted-image-attachments.md)）
- スナップショットに直近の compaction（`at` / `tokensBefore` / `summary` / `index`）を含める。`messages` はその compaction の `firstKeptEntryId` 以降に限り、圧縮より前の会話は返さない。モデルの実際の文脈（要約 + kept 分）と表示を一致させるため
- `index` は返す `messages` のうち compaction エントリより前にある件数。クライアントはその位置に区切りを挿む。`limitMessages` で古い側を切ったときは切った分だけ手前へずらし、`0..messages.length` に clamp する。opencode は圧縮後の会話しか返さないため常に `0` になる
- 評価するのは最新の compaction エントリだけ。それに `firstKeptEntryId` が無い・`summary` が空・`firstKeptEntryId` が active branch に無い・compaction が無いときは、`compaction` を `null` にして branch 全体を返す。古い compaction へは遡らない。要約だけ出して窓がずれる状態を作らない
- 入れ子の compaction は最新のみを採る。compaction エントリは `message` を持たないため、窓に入っていても会話としては描画されない
- コンテキスト使用量は pi のモデルカタログを第二の情報源にする。`tokens` はセッション中の usage から、`window` は `models-store.json` の `contextWindow` に `models.json` の `providers[].modelOverrides` を重ねたカタログから引く。store に無いモデルは同じ agent dir の `pi --offline --mode rpc --no-session --no-extensions` の `get_available_models` から正確な `contextWindow` を引く。agent dir はセッション path（`<agent-dir>/sessions/<slug>/<file>.jsonl`）から導き、同じ agent dir のセッションでカタログを共有し、別の agent dir と混ぜない
- 有効な最新 usage の入力・出力・キャッシュ読取・書込をスナップショットに含める。値のない項目は不明とし、以前の usage から補わない。コンテキスト表示のホバー・フォーカス・タップで正確な使用量と内訳を表示する。内訳は会話全体の累積ではない
- カタログの追加・変更・削除と読み取り失敗からの復旧は、次のチャットスナップショット取得時に反映する。会話の追記・ブラウザのリロード・BFF の再起動を条件にせず、既存の取得契機（表示中は working 2 秒 / idle 5 秒、非表示中は停止し可視復帰時に取得）を維持する。バックグラウンド監視は加えず、変化のないカタログ全体を取得のたびにパースしない
- カタログの欠損・不正 JSON・読み取り失敗や Pi の起動・RPC 失敗は会話取得を止めない。上記の優先順位で解決し、引けない上限だけ `null` にする。RPC はセッションを保存せず `HERDR_*` を引き継がない。結果は agent dir と store・config の組ごとに共有し、失敗時は次の取得で再試行する。`tokens` と `window` の両方が `null` なら `context` を `null` に畳む
- 読み取りは追記分だけを対象にし、ヘッダの `id` の変化・`size` の減少・inode の変化・ファイルの消失で全リセットする。パースできない行はその行だけ捨てる
- 応答は直近 500 メッセージ / 1MB の小さい方を上限にし、切ったら `truncated` を立てる。上限は窓に絞ったあとの `messages` に効く
- `etag` は path のハッシュ・リーダー生成時のランダム id・読み取り世代・表示中モデルの `window` から作り、`If-None-Match` の弱比較で 304 を返す。世代は追記を消費したときとリセットしたときだけ進め、ENOENT が続く間は同じ `etag` を返す。同じ BFF プロセスで同一リーダーを保持し、セッションに変化がない間は、カタログの再評価で `window` が変われば `etag` を変え、変わらなければ維持する。他モデルだけの変更では変えない

## Consequences

- 会話の表示は pi のセッション形式に依存する。形式が変わると追従が必要になる
- ツールコール・thinking・ツール結果のエントリは会話として表示しない。ツール実行だけのターンは会話に出ないため、`working` の表示で補う。ターン中の thinking の末尾と実行段階だけは [ADR 0035](0035-live-pi-activity.md) の一時表示で補う
- compaction は履歴の区切りとして 1 行（要約の展開付き）で表示し、それ以前の会話は返さない。区切りは窓の先頭ではなく compaction エントリの位置（アクション時点）に置く。圧縮直後は直近の末尾に出て、その後の発話で自然に上へ流れる。要約はその行で展開する
- 圧縮の所要時間は、クライアントが `/compact` の送信時刻を観測できたときだけログに添える。リロードやペイン切り替えで失われ、その場合は tokens とホバー時の時刻だけになる。永続化は別スコープ
- 窓が成立しない（`firstKeptEntryId` が branch に無い等）ときは全体を返すため、圧縮済みなのに古い会話が並ぶことがある。要約だけを出して窓とずらすより、表示と実体が一致する側を選ぶ
- `/tree` で分岐先を選んだだけ（送信前）はファイルに追記が無く、次の送信まで前の枝を表示する
- セッションが無い・対応外の agent・読み取りに失敗したときは端末出力にフォールバックする。ENOENT は空の会話として扱う。OpenCode は [ADR 0028](0028-opencode-chat.md) のローカルサービス API、Codex は [ADR 0031](0031-codex-chat.md) の App Server API から読む
- セッション形式は v3 を前提にする。v3 以外のヘッダはリセットではなく 502 `chat_unavailable` として扱うため、書き換えの検出はヘッダ `id` で行う
- キャッシュから追い出されたセッションは次の要求で全読みになる。上限は path あたり 8 件
- 送信直後は pi がメッセージを書くまで遅れる。ローカルの pending を「送信中」として表示し、送信時点の最後の user 発話より後に新しい user 発話が現れたら置き換える。ターン終了または一定時間で打ち切る。正はセッションのまま
- 500 件 / 1MB より古い会話は Web からは読めない
- モデル設定の変更は次のチャット取得で反映され、BFF の再起動は不要になる。設定の更新途中には一時的に store の値や不明表示になることがあるが、正常なファイルへ戻った後は追従する。Pi プロセス内部の設定再読込タイミングとは独立しており、実効値との完全同期は保証しない
- `ETag` の安定性は同一リーダー・セッション不変・`window` 不変の間に限る。再起動、リーダーの追い出し・再生成、セッションの追記・リセットに伴う変更は許容する
- Pi の RPC は拡張を起動しないため、拡張だけが登録したモデルや利用可能一覧に出ないモデルの上限は不明になる。RPC 結果は store・config が変わるまで保持するため、Pi 本体だけの更新は BFF 再起動まで反映されない。数値と window の片方だけ分かればその片方を出す
- 未応答メッセージ分の推定はせず、`compaction` と `context_edit` の後は次の usage まで `tokens` を `null` にする。pi の TUI より小さく出るか早く `?` になるが、hwc の reader では pi と完全一致にできない
