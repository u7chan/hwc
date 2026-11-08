# ADR 0045: ターンが始まらない送信の echo は短い猶予で畳む

- Status: Accepted
- Date: 2026-11-08

## Context

[ADR 0013](0013-pi-session-chat.md) は、送信直後からセッションに user 発話が現れるまでの間、ローカルの pending を「送信中」として chat に出す。確定は「送信時点の最後の user 発話より後に新しい user 発話が現れたか」で判定し、ターン終了または 60 秒で打ち切る。[ADR 0016](0016-composer-command-chips.md) の `/new` と `/compact` は user 発話を残さないため、そもそも pending を積まない。

pi の TUI には、モデルへ渡さず TUI 内だけで処理する入力がある。`/reload`、`/model`、`/settings` などのスラッシュコマンドと、`!` で始まる bash がそれにあたる。これらはセッションに user 発話を書かず、Herdr の `agent_status` も `working` にしない。Web から `/reload` を送ると、TUI では再読み込みが走るのに、hwc は確定しない「送信中」を 60 秒間出し続けていた。

hwc は各 CLI の TUI コマンドの一覧を持たない（ADR 0016）。スラッシュで始まる文字列をコマンドとみなす判定は、pi が未知の `/...` を本文としてモデルへ渡す場合と、prompt template の `/name` を誤る。`!` も取りこぼす。

## Decision

- 送信が成功したあと、送信時に idle だった pending について、Herdr の `agent_status` が `working` にならないまま 3 秒経ったら畳む
- 送信時に `working` だった pending は対象外とする。従来どおりターン終了で畳む
- `working` を 1 度でも観測した pending は、セッションに user 発話が現れて確定するまで残す。60 秒の上限も維持する
- 猶予は pending を積んだ時刻（送信が通った後）から測る。POST が遅いときに、入力が届く前の echo を畳まない
- 判定は `PendingMessage` と現在時刻を受け取る純関数 `idleEchoExpired` にし、component の外でテストする
- コマンドの一覧・スラッシュの構文・`!` の有無は見ない。TUI がどう解釈したかは `agent_status` だけを材料にする
- 畳んだことを notice では知らせない。コマンドの実行結果は端末にあり、hwc は観測しない（ADR 0016 と同じ）

## Consequences

- `/reload`、`/model`、`!ls` など、user 発話を残さない入力は、送信直後の数秒だけ「送信中」に見え、その後 chat から消える。`/new` のように最初から何も出さないコマンドとは、この一瞬だけが違う
- Herdr の `working` 反映が 3 秒を超えると、確定前に echo が消え、セッションの取得が追いついた時点で本人の発話として現れる。表示が一瞬欠けるが、正はセッションのまま
- 3 秒は `agent_status` がエージェントのイベントで動く前提の値。状態の報告が遅いエージェントを足すときは見直す
- 入力が TUI に届かなかった場合も同じ猶予で消える。送信は Herdr の受理までしか保証しない（[ADR 0002](0002-herdr-socket-integration.md)）
- TUI のコマンド実行結果（`Reloaded ...` など）は Web に出ない。端末出力を会話に混ぜない ADR 0013 の判断を変えない

## Verification

- unit で、猶予の境界（直前は残り、到達で消える）と、実行中に送った pending が猶予では消えないことを確かめる
- 架空 Herdr の E2E で、`/reload` を送ってもセッションに user 発話が増えず、「送信中」が猶予後に消えることを確かめる
