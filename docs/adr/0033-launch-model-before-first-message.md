# ADR 0033: 起動直後のモデル表示は起動時の指定で補う

- Status: Accepted
- Date: 2026-11-06

## Context

入力欄の右下には、ペインのモデルと effort を出す。値は会話スナップショットの `model` / `effort` で、[ADR 0013](0013-pi-session-chat.md) のとおりセッションから読んでいる。

pi は最初の user / assistant メッセージまでセッション JSONL を作らない（`SessionManager` の `_hasConversation()` ガード）。起動時に積まれる `model_change` と `thinking_level_change` も、そのときまでファイルに出ない。Herdr の `agent.get` / `session.snapshot` は `agent.start` の `args` を返さないため、起動時の `--model` を後から問い合わせる手立ても無い。

[ADR 0030](0030-new-pane-model.md) のダイアログでモデルと effort を選んで作っても、最初のメッセージを送るまで入力欄にモデル名が出ない。

## Decision

- BFF は `POST /api/panes/:id/split` でエージェントの起動に成功したとき、選ばれたモデル id と effort をペイン id と組にしてプロセス内に預かる。起動に失敗した場合と、モデル未指定の場合は預からない
- `GET /api/panes/:id/chat` は、スナップショットの `model` が `null` の間だけ預かった値で補う。`effort` はセッションに値があればそちらを使う
- スナップショットに `model` が載ったら預かりを捨て、以後はセッションの値だけを出す。`close` / `exit` が成功したときも捨てる
- 補った値は表示にだけ使い、`etag` と `If-None-Match` の判定に関与させない
- 預かりは永続化しない。BFF を再起動すると失い、最初のメッセージまでモデル名が出ない状態に戻る

## Consequences

- pi 以外（Codex など）にも同じ補いが効く。エージェントごとの分岐は持たない
- 最初のメッセージを送る前に TUI でモデルを切り替えても、セッションにはまだ記録が無いため切り替え前の値が出る。送信後はセッションの値に置き換わる
- Web を開き直しても、BFF が動いていれば同じ値が出る
- Herdr の TUI 側でペインを閉じた場合は預かりが残る。会話にモデルが載るか BFF を再起動するまで消えないが、ペイン id ごとに 1 件で表示以外には使わない
