# ADR 0038: 失敗したターンは会話の error 行として出す

- Status: Accepted
- Date: 2026-11-07

## Context

会話の正は pi のセッション JSONL で、hwc は assistant の `text` ブロックだけを会話として出している（[ADR 0013](0013-pi-session-chat.md)）。本文が空の assistant は行にしない。

pi は失敗したターンを、`stopReason: "error"` と `errorMessage` を持ち `content` が空の assistant エントリとして書く。429 やタイムアウトで起きる。本文が空なので、hwc はこれまで丸ごと捨てていた。結果、Web では送ったメッセージの後に何も現れず、`agent_status` が `idle` に戻るだけになる。送信が届いていないのか、届いて失敗したのかを画面から区別できず、TUI を開くまで原因が分からなかった。

自動リトライの各試行も、同じ形で 1 エントリずつ残る。`Retry failed after 3 attempts` のようなリトライ層の総括は JSONL に書かれず、TUI にだけ出る。backoff 中の状態も拡張のイベントに無い（[ADR 0035](0035-live-pi-activity.md)）。

## Decision

- assistant エントリが `stopReason: "error"` で、本文のある `errorMessage` を持つときは `role: "error"` のメッセージとして `messages` に含める。失敗の文言は加工せずそのまま返し、`ChatSnapshot` に別枠のフィールドは足さない
- 中断（`stopReason: "aborted"`）は利用者の操作なので error 行にしない
- 失敗しても、そこまでに書けた本文は `agent` 行として残す。その場合 1 エントリが 2 行になり、error 行の id は `<entry id>:error` にする
- usage は従来どおり error / aborted のターンから採らない（[ADR 0013](0013-pi-session-chat.md)）
- クライアントは user / agent と同じ並びに error 行を置く。吹き出しは使わず、`attention` の記号と「応答に失敗しました」、生の文言、時刻、コピーを出す。文言は Markdown として解釈しない
- 同一文言の失敗が連続する間は 1 行に畳み、試行回数を `count` に残す。クライアントは 2 回以上のときだけ回数を添える。文言が違う失敗や、間に本文のある応答が挟まったものは別の行にする
- 畳む範囲は compaction をまたがない。区切りの行位置が試行回数で動かないようにするため

## Consequences

- 失敗したターンが会話の流れの中で分かり、原因の文言はそのままコピーして報告できる
- 自動リトライが長引いても会話がエラー行で埋まらない。試行回数は行に残るので、何回試したかは読める
- 一度だけ起きた失敗も、リトライで回復した失敗も、そのまま履歴に残る。TUI のスクロールバックと同じ扱いになる
- 畳んだ行の時刻は最初の試行のものになる。試行ごとの時刻は API からは見えない
- リトライ層の総括（`Retry failed after N attempts`）と、リトライ待ちの状態は引き続き出ない。最終的に諦めたことは最後の error 行から読み取る
- error 行も会話の一部なので、500 メッセージ / 1MB の上限と compaction の窓の対象になる
- opencode と codex はそれぞれの読み取り口（[ADR 0028](0028-opencode-chat.md) / [ADR 0031](0031-codex-chat.md)）の射影に従う。この判断は pi のセッション形式に対するもの
