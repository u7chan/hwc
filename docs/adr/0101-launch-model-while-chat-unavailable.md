# ADR 0101: 会話が読めない間も、hwc から起動したときのモデルを入力欄に出す

- Status: Accepted
- Date: 2026-11-20
- Amended by: [ADR 0108](0108-claude-model-display-name.md)（Claude のモデルは表示名で出す）
- Amends: [ADR 0033](0033-launch-model-before-first-message.md) の「`GET /api/panes/:id/chat` が預かりで補う」、[ADR 0097](0097-claude-chat-transcript.md) の「起動時にモデルを指定したペインは、assistant がまだ無いときだけ預かりで補う」

## Context

[ADR 0097](0097-claude-chat-transcript.md) で、Claude の会話は transcript から読む。transcript は最初のメッセージを送るまで作られないため、hwc から起動した直後の Claude ペインは `GET /api/panes/:id/chat` が失敗し、端末出力の表示になる。

入力欄のモデルと effort は、チャットのスナップショットを正にする。モデルを指定して起動したペインでは、スナップショットにモデルが無い間を `launchModels` の預かりで補う（[ADR 0033](0033-launch-model-before-first-message.md)）。しかし会話自体が読めない間はこの補いが届かない。クライアントが持つ起動の記録も、起動の完了で捨てる（[ADR 0078](0078-starting-pane-mask.md)）。そのため、起動直後に入力欄へ出ていたモデルと effort が消え、最初のメッセージを送るまで戻らない。モデルを指定して起動しても、TUI の status line にしか出ていない状態になる。

デフォルトモデルで起動した Claude は、transcript にモデルが載るまで値を出す口が無い。[ADR 0087](0087-default-model-display.md) の pi のような既定を解決する方法も、Claude には無い。

## Decision

- `launchModels` に、ペイン id の預かりを読む口を足す。`close` / `exit` で捨てる規則は変えない
- `GET /api/panes/:id/launch-model` を足す。ペインが存在し、エージェントを持つときだけ預かっている `{ model, effort }` を返す。シェル、hwc 以外から起動したペイン、預かりの無いペインは `{ model: null, effort: null }` を返す。値が頻繁に変わる表示用の値なので `cache-control: no-store` を付ける
- クライアントは、チャット画面を開いていて、スナップショットにモデルも effort も無く、クライアント自身の起動の記録も無く、pi の既定モデルの解決も無いときに、この口を開いている間だけ 1 回読む。読んでいる間と失敗は何も出さない
- 表示は、スナップショット、クライアントの起動の記録、pi の既定、この口の順に優先する。会話にモデルが載ればスナップショットが勝つ
- 出す値は起動時に選んだモデル id（Claude では `sonnet` などのエイリアス）と effort にする。TUI の status line が解決した表示名（`Sonnet 5.5` など）は読まない
- デフォルトモデルで起動した Claude には広げない。値を推測して、実際と違うモデルを出さない

## Consequences

- hwc からモデルを指定して起動したペインは、会話がまだ読めない間も入力欄にモデルと effort が出る。ペインを開き直しても同じ値が出る（BFF が預かりを持っている間）
- 会話が読めるようになると、値はスナップショットのもの（Claude は最後の assistant のモデル id）に置き換わる。エイリアスと版付きの id で表記が変わることはある
- 最初のメッセージの前に TUI でモデルを切り替えても、表示は起動時の指定のままになる（[ADR 0033](0033-launch-model-before-first-message.md) と同じ制約）
- デフォルトモデルで起動した Claude、hwc 以外から起動したペイン、BFF の再起動を挟んだペインは、最初の応答までモデルが出ない（[ADR 0097](0097-claude-chat-transcript.md) のまま）
- ペインを開くたびに表示用の取得が 1 回増える。預かりの無いペインでは何も返さない

## Alternatives

- **クライアントの起動の記録を、会話にモデルが載るまで残す**: サーバーの変更は要らないが、再読み込みで失われ、起動の記録が起動待ちの表示と混ざる。預かりは BFF に置く（[ADR 0033](0033-launch-model-before-first-message.md)）
- **transcript が無いときは空の会話として返す**: 会話ビューに切り替わり、モデルの補いも届くが、セッション参照はあるのに読めない状態を空の会話と取り違える（[ADR 0097](0097-claude-chat-transcript.md)）
- **TUI の status line のモデル名を読む**: 解決済みの表示名を出せるが、折り返しと再描画に依存し、版で字が変わる（[ADR 0096](0096-claude-model-effort.md)）
- **Claude の既定モデルを設定ファイルから読む**: 設定の `model` は CLI が解決する前の値で、未指定なら実際の既定は分からない。推測した値を出すより出さない
