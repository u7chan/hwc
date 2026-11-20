# ADR 0103: Claude の transcript が見つからない記憶は、送信と 4 秒の期限で捨てる

- Status: Accepted
- Date: 2026-11-20
- Amends: [ADR 0097](0097-claude-chat-transcript.md) の「見つからなかった結果は 30 秒だけ覚え」

## Context

Claude の会話は transcript から読む（[ADR 0097](0097-claude-chat-transcript.md)）。transcript は最初のメッセージを送るまで存在しないため、起動直後の `GET /api/panes/:id/chat` は失敗し、端末出力へフォールバックする。このミスは探索のたびに `projects/*` を readdir しないよう 30 秒覚えていた。

そのため、最初のメッセージで transcript ができても、ミスを覚えてから 30 秒は 502 のままで、TUI が残る。実測では、起動 → 約 17 秒後に最初の送信 → transcript 作成 → 約 5 秒で返答完了だったが、会話ビューに切り替わったのは起動から約 31 秒後だった。返答は TUI に出ており、hwc の会話ビューには出ていない。

hwc から起動した Claude は、transcript ができる前から `agent_session`（`kind: "id"`）を持つ。送信した時点で、どの transcript を探し直せばよいかは分かっている。

## Decision

- `MISSING_TTL_MS` を 30 秒から 4 秒にする。poll は実行中 2 秒・待機中 5 秒なので、探索の間隔は実行中 4 秒・待機中 5 秒になり、5 秒を超えない。poll のたびに readdir することには戻らない
- `POST /api/panes/:id/input` が ENTER 付きの送信を Herdr へ通したら、ペインの `chatSource` から Claude の session id を引き、見つからない記憶を捨てる。次の poll が transcript を探し直し、会話ビューへ切り替わる
- 会話の読み取り口 `SessionChatClient` に optional な `forgetMissing` を足す。id からセッションを探してミスを覚える Claude だけが実装する。pi・opencode・codex は持たない
- 検索の途中で送信があった場合、そのミスは送信前の結果なので覚えない。送信のたびに進める世代を検索の開始時に控え、ミスを書く前に比べる
- ENTER を送らない入力、送信に失敗した要求、Claude 以外のペインでは何もしない。hwc 外で起動したペインのように session id がまだ状態に無い経路は、期限の 4 秒だけで解ける
- transcript の探索方法、射影と etag のキャッシュ、304 の弱比較は変えない

## Consequences

- 最初の送信で transcript ができたあと、送信直後にミスを覚え直した場合を除き、次の poll（実行中 2 秒 / 待機 5 秒）で会話ビューに切り替わる
- 送信の直後、transcript ができる前の poll がミスを覚え直すと、そのミスが切れる次の探索（実行中は 4 秒後）まで端末出力のままになる。30 秒には戻らない
- transcript が無い間の `projects/*` の readdir は、実行中 4 秒・待機中 5 秒に 1 回になる。30 秒より増えるが、poll ごとには戻らない
- hwc の送信を通らずに transcript ができた場合（hwc 外で起動し、TUI から送った等）も、最大 5 秒で会話ビューに切り替わる
- hwc 外で起動したペインは、Herdr が `agent_session` を返すまで `chatSource` が無い。送信しても捨てる記憶が無く、期限と待機中の poll で最大 5 秒かかる
- ミス以外の失敗（同じ id が複数のプロジェクトにある、transcript を解釈できない）は覚えないので、この期限の対象ではない（[ADR 0097](0097-claude-chat-transcript.md) のまま）

## Alternatives

- **30 秒のまま送信時だけ捨てる**: 検索中の競合と、hwc の送信を通らない経路で最大 30 秒残る。送信の経路だけを速くしても、症状の一部しか直らない
- **ミスの期限を 5 秒にする**: 待機中の poll と同じ長さになり覚える期間は延びるが、実行中の 2 秒 poll では次の探索が 6 秒後になり、送信後に transcript ができてから切り替わるまでが 5 秒を超えることがある。4 秒なら 2 秒 poll でも 4 秒後、5 秒 poll でも 5 秒後に探索する
- **ミスの期限を 1 秒にする**: 送信後はさらに速くなるが、transcript を待つ間の readdir が増える。2 秒 poll の 2 回に 1 回までなら、poll ごとには戻らない
- **poll のたびに readdir する**: ミスを覚えないので常に最新だが、transcript が無いペインを開いている間ずっと探索することになる（[ADR 0097](0097-claude-chat-transcript.md) で退けた）
- **送信した本文を即座に会話へ出す**: 切り替えは速くなるが、transcript に載る前の暫定表示を持つことになる。対象外
