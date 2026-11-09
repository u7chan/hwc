# ADR 0035: 実行中の段階と thinking の末尾は pi 拡張の sidecar から一時表示する

- Status: Accepted
- Date: 2026-11-07（2026-11-08、2026-11-09 改訂）

## Context

会話は [ADR 0013](0013-pi-session-chat.md) のとおり pi のセッション JSONL を正としている。しかし pi は assistant メッセージを `message_end` でしか JSONL に書かない。ストリーミング中の thinking はディスク上に存在せず、JSONL を正とする限り、hwc は「今なにをしているか」を出せない。ターンの途中で確定したメッセージの thinking だけでは、1 回の長い応答の間ずっと止まって見える。

TUI には thinking が出るが、常用環境では `hideThinkingBlock` で意図的に隠している。画面を読む案は、折り返し・再描画・色への依存になり、ADR 0013 が会話の取得で却下した経路でもある。

hwc 側に独自の実行状態は持たない。会話のスナップショット（`GET /api/panes/:id/chat`）に混ぜると、差分のたびに `etag` が動いて 304 の意味が壊れ、バックグラウンド監視も増える。

## Decision

### 拡張が sidecar を書く

- pi 拡張（pi-lab の PoC、本番は mypi）が、セッションの隣に `<session>.jsonl.thinking.json` を書く。読む側はセッション path だけで場所を導ける
- 中身は v1 の 1 行 JSON で `{ v, at, phase, text?, tool?, tools?, tokPerSecond? }`。追記せず上書きし、履歴は持たない。`agent_settled` と `session_shutdown` で削除し、`session_start` で残骸を掃除する
- `phase` は `waiting` / `thinking` / `writing` / `tool-call` / `tool` / `compacting` / `waiting-user`。`thinking_start/delta`、`text_start/delta`、`toolcall_start/delta`、`tool_execution_start/end`、`session_before_compact` / `session_compact(_failed)`、`ui_prompt_start/end`、`agent_start` / `turn_start` / `agent_end` から決める
- `text` は `thinking` のときだけ、現在のブロックの末尾 1200 文字。`tool` のときだけ、実行中のツール名と並列数を入れる
- `tokPerSecond` は現在の assistant 応答の生成速度（tok/s）で、`thinking` / `writing` / `tool-call` のときだけ入れる。差分の文字数から推定し、最初の差分から 400ms 以上・受信時刻が 8 個以上あるときだけ出す。計測できないときは省略する（0 や `--` は入れない）。TUI の `tok-rate` と同じ sampler を使い、同じ応答では両者の数字を一致させる
- 書き込みは 500ms でまとめ、phase が変わったときはその場で書く。`tokPerSecond` の変化も同じ間隔にまとめる。書き込み失敗は握りつぶし、セッションを止めない

### BFF は使い捨ての取得口を足す

- `GET /api/panes/:id/activity` を足し、`{ activity: PaneActivity | null }` を返す。`etag` は付けず `cache-control: no-store`
- ペイン id からセッション path を引き、sidecar の path はクライアントへ渡さない。クライアントから path も受け取らない
- pi 以外のペイン、拡張が無い、ファイルが壊れている・大きすぎる・30 分より古いときは `activity: null`。会話の取得も表示も止めない
- 検証は書き手と読み手で同じ関数（`src/shared/activity.ts` の `parsePaneActivity`）を使い、phase と合わないフィールドを捨てる

### クライアントは入力欄の直上に固定して出す

- `working` かつ画面が表示中のときだけ 1 秒間隔で取得する。隠れている間と idle の間は取得しない
- 段階は返答待ちの行ではなく、会話のスクロール領域の外、入力欄の直上に出す。返答待ちの 3 点の横に phase のラベル（「考えています」「bash を実行中」など）を並べ、`thinking` のときだけ末尾 2 行を下に出す。ターンが終わると消え、トランスクリプトには残さない。読み返してスクロールしている間も何が起きているかが見え、thinking の高さが会話のスクロールに影響しないため（2026-11-08 改訂）
- 経過時間は行の右端に固定する。左に並べると、ラベルの文言と秒数の桁が変わるたびに時間の位置が動くため
- 生成速度は経過時間の左に置く。速度の有無で右端の時間が動かないため
- thinking の表示領域は、出している間 2 行分の高さを確保する。中身は下端に寄せ、折り返しであふれた上側を切る。差分のたびに行が伸び縮みすると、上に載る会話の見える範囲が動くため
- 低いセルと積まれたセル（入力欄を 1 行に畳む状態）では thinking を出さず、段階と経過時間だけにする。会話へ高さを回すため。生成速度も同じ行に足さず、段階と経過時間に絞る
- `tool-call` は引数の生成中で一瞬しか続かないためラベルを出さない
- hwc 自身の `/compact` 中は、既存のローカルな圧縮表示（文言・経過時間・中断）を同じ位置に優先して出し、sidecar の段階は重ねない

### 会話の正は変えない

- 会話・トランスクリプトの正は従来どおりセッション JSONL とし、ADR 0013 の「thinking を会話として表示しない」は維持する。この ADR が足すのは、ターン中だけの一時的な activity に限る

## Consequences

- 拡張が未導入・停止中・読み込み前のペインでは 3 点と経過時間だけになり、段階のラベルと thinking は出ない。hwc だけでは機能しない
- 入力欄を 1 行に畳むセルでは thinking を出さないので、何を考えているかは見えない。段階と経過時間だけになる
- thinking は pi の `hideThinkingBlock` 設定に影響されない（拡張イベントから取る）。TUI の表示設定は変えない
- 自動リトライの backoff には拡張イベントが無いため `waiting` と区別できない。並列ツールは 1 つの `tool` にまとめ、名前と件数だけを出す
- `at` は状態が変わらない間は更新しない。長いツール実行中は古い値のままなので、鮮度の判定に使わず、残骸を弾く上限（30 分）だけに使う
- 拡張は hwc が見ていないすべての pi セッションでも書く。1 回数 KB を 500ms 間隔で書き、ターン終了で消す
- TUI から `/compact` したときは Herdr の `agent_status` が `working` にならないため、hwc は表示しない。hwc の外で起動した pi のセッションでも、hwc で開いて `working` なら表示される
- sidecar の契約が変わるときは、拡張（pi-lab / mypi）と hwc の両方を直す。`v` で弾くので、読み手は古い形式を無視して従来表示に戻るだけ。`tokPerSecond` は v1 のまま足した optional field なので、古い hwc は速度を出さずに従来表示を続ける
- 生成速度は差分からの推定で、プロバイダの `usage` に基づく確定値ではない。短い応答やまとめて届く応答では出ない。ターン終了後の確定値や `avg` は出さない
- 拡張の読み込みは pi の起動時なので、設定を足しても起動中のペインは再起動するまで書かない
