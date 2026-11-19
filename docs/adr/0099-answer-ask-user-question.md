# ADR 0099: AskUserQuestion は Esc で閉じ、選んだ内容を本文で答える

- Status: Accepted
- Date: 2026-11-19
- Amends: [ADR 0016](0016-composer-command-chips.md)、[ADR 0098](0098-claude-pending-in-chat.md)

## Context

Claude の AskUserQuestion は TUI のフォームで、質問ごとのタブ・選択肢・複数選択・Submit を持つ。応答待ちのカード（[ADR 0098](0098-claude-pending-in-chat.md)）で質問と選択肢は Web に出るが、答えられないので端末へ戻るしかなかった。hwc は汎用のキー入力を持たず、スマホには矢印キーも無い（[ADR 0016](0016-composer-command-chips.md)）ので、TUI のフォームをキー操作で再現する方法は採れない。

Herdr は `pane.send_keys` で Esc を送れる（停止ボタンと同じ経路。[ADR 0025](0025-stop-working-agent.md)）。そこで「Esc で質問を閉じ、選んだ内容を通常のユーザー発言として送る」案を、実機（Claude Code 2.1.328、Herdr 0.9.5）で確かめた。

- Esc でダイアログは閉じる。transcript には 0.5 秒以内に、assistant の `tool_use`、`is_error: true` の `tool_result`（本文は "The user doesn't want to proceed with this tool use. …"、`toolUseResult` は `"User rejected tool use"`）、user の `[Request interrupted by user for tool use]` が書かれる
- 閉じたあと Claude は応答を始めず、入力待ちの `idle` に戻る。steering としてキューされる状況は起きなかった
- そのあとに本文を送ると、普通の `UserPromptSubmit` として処理され、Claude は本文を回答として受け取った（「好きな色は？: 青」に「青」と答えた）
- Esc は `PostToolUse` / `PostToolUseFailure` / `Stop` のどの hook も呼ばない（[ADR 0098](0098-claude-pending-in-chat.md)）。閉じたことは transcript の `tool_result` で知る

停止ボタンは `working` のときだけ Esc を送る（`routes/panes.ts` の `stop`）ので、`blocked` 中のこの経路とは競合しない。

## Decision

- 回答は `POST /api/panes/:id/answer-question` に `{ toolUseId, answers }` で送る。`answers` は質問ごとに `{ question, labels }`（選んだ選択肢）か `{ question, text }`（自由入力）のどちらか一方で、全質問を覆う。両方を同時には受け付けない
- Claude のペインだけが対象。他のエージェントは 400。permission prompt（承認）には使わない。Esc は承認の拒否として働き、本文は承認の返事にならない。誤承認・誤拒否を避けるため、承認は端末で行う（[ADR 0098](0098-claude-pending-in-chat.md)）
- BFF はクライアントの主張を信じず、そのたびに確かめる。`agent_status === "blocked"`、会話の読み取り口から再読みした `pending` が AskUserQuestion で `toolUseId` が一致、質問文が pending のものと一致、`labels` が選択肢の部分集合（空・重複・単一選択に複数は不可）、`text` が制御文字と空白を落として空でない、全質問に答えがある。形が合わない・空は 400、待ちが無い・別の質問は 409
- 本文は、固定の 1 行目 `質問への回答:` と、質問ごとの 1 行からなる。質問の行は `質問: ラベル, ラベル`、自由入力は `質問: 本文`。質問文は pending のものを使い、クライアントの文言は使わない。1 行目を固定で置くのは、本文の先頭の文字がそのまま CLI の入力欄に届くため。質問文はモデルが書くので、`/` で始まると回答が `Unknown command:` で届かないか `/clear` などのコマンドが走り、`!` や `#` で始まるとシェルやメモとして扱われ得る。どの文字が危ないかを hwc が知っている前提を置かず、条件を付けずに常に置く（[ADR 0016](0016-composer-command-chips.md)）。ラベルと本文は 1 行に揃える（制御文字を落とし、改行を空白にして trim）。ラベルに `,` `:` `"` が入るときは JSON 文字列として引用し、選んだ数と境界を読み違えさせない
- 組み立てた本文が `MAX_TEXT_BYTES`（16,384 バイト）を超えるときは 413 とし、Esc も送らない（ダイアログを閉じてから失敗にしない）
- 送信手順は次のとおり。いずれかが失敗したら、そこで止める
  1. `panes.sendKeys({ paneId, keys: ["esc"] })`
  2. 会話の読み取り口を 100ms 間隔で最大 3 秒読み、`pending` から `toolUseId` が消えるのを待つ。消えたかは `tool_result` の有無（pending の消滅）で判定し、`tool_result` の中身（拒否かどうか）は見ない。別の質問に変わったら 409、読めなければ 502、時間内に消えなければ 502
  3. `panes.send({ paneId, text, submit: true })`
- 画面のテキストは解析しない。会話の正はセッションで、閉じたことは transcript で知る（[ADR 0013](0013-pi-session-chat.md)）。`tool_result` が現れないときは本文を送らない。本文が TUI のダイアログに流れ込むのを避けるため
- 二重送信しない。ペインごとに処理中は 1 本だけとし、同じ `toolUseId` の再送は同じ結果を待つ。別の `toolUseId` は 409。完了した要求は 30 秒だけ覚え、同じ `toolUseId` の再送を 200 にする（完了後は blocked でも pending でもないので、この記録が無いと再送が 409 になる）。失敗は覚えない。自動再試行しない
- 失敗時の UI は、400・409・502・通信失敗を「回答できませんでした。端末で答えてください。」、413 を「回答が長すぎて送れません。短くしてください。」とする。入力は残す
- カードは、選択肢をタップする行にする。単一選択は 1 つ、複数選択は複数を選べる。自由入力は選択肢と同じ列の「その他（自由入力）」の行にして、選択肢とは排他にする（契約が `labels` か `text` の一方だけのため）。CLI が `Other` を選択肢として返す版でも、同名の項目が 2 つ見えないよう、`Other` は特別扱いしない。全質問に答えるまで「この内容で答える」は無効。送信中はスピナーと無効化で、送信後は質問が消える（pending が解ける）までカードを残す
- Esc で書かれる `tool_result` は user entry の配列なので、会話には出ない。中断の記録は error 行にしない（[ADR 0039](0039-chat-error-rows.md) の「中断は error 行にしない」と同じ）。Esc が書く user の `[Request interrupted by user for tool use]` も、利用者の発言ではなく CLI の固定の記録なので、会話の行にしない（`[Request interrupted by user]` も同じ）
- [ADR 0016](0016-composer-command-chips.md) の例外（hwc が任意のキーを送らない）に、停止の Esc と既知のフォルダ信頼確認への回答に続く 3 つ目として「AskUserQuestion の Esc と本文送信」を足す。任意のキーを送る機能には広げない

## Consequences

- 回答は「質問を拒否したうえで、選んだ内容を次の発言として送る」ことになる。transcript には拒否の `tool_result` が残り、Claude は拒否の文言と回答の本文を両方見る。実機では本文を回答として受け取ったが、モデルや CLI の版で拒否として扱うことは起こり得る。その場合は Claude が質問し直すだけで、誤った回答にはならない
- Esc と本文の送信は 1 つの操作ではない。Esc のあと、本文を送る前に失敗すると、質問は閉じたまま本文が届かない。`idle` に戻り、入力欄が戻るので、続きは入力欄から送る
- 検証から Esc までの間に、利用者が端末で先に答える競合が起き得る。そのとき Claude は `working` になっており、Esc が停止として働く。窓は検証の直後から送るまでの数十ミリ秒で、検証を Esc の直前に置いて狭めている
- 複数質問の順序・タブの状態は Web では見えない。Web は全質問に答えてから 1 回で送る
- Esc の挙動は CLI の版で変わり得る。閉じなければ `tool_result` が現れず、本文は送られない（502）。そのときはキー操作方式を再検討する
- 待ち時間の 3 秒は、実機の書き込み（0.5 秒以内）の 6 倍。遅い環境では 502 になり、端末で答えることになる
- 本文は通常の発言と同じ経路なので、履歴・コマンド候補・添付の扱いは通常の送信と同じ。回答の取り消しはできない

## Alternatives

- **TUI のフォームをキー操作で再現する**: Tab・矢印・Space・Enter を送る案。スマホに矢印が無い前提で、hwc は汎用のキー入力を持たない。タブの状態（どの質問を開いているか）も読めず、ずれたときに誤った選択肢を確定する
- **Esc を送らず本文だけを送る**: ダイアログが入力を受け取るため、本文が選択肢の検索や自由入力に流れ込む。閉じてから送る必要がある
- **Esc のあと idle を待ってから送る**: 実機では Esc のあと応答は始まらず、`idle` になる。ただし `agent_status` は Herdr の状態で、transcript とずれる瞬間がある。会話の正は transcript なので、`tool_result` の出現（pending の消滅）を待つ。応答が始まる版が出たら、この判定を見直す
- **画面のテキストでダイアログが閉じたかを判定する**: 折り返しと再描画で崩れ、画面の文言に依存する
- **permission prompt にも同じ経路を使う**: Esc は拒否として働き、本文を承認の返事にできない。承認は Web から送らない（[ADR 0098](0098-claude-pending-in-chat.md)）
- **`labels` と `text` を同時に受け付ける**: 自由入力を選択肢と併用できるが、本文の形と検証が増える。TUI の `Other` も 1 つの答えとして扱われるので、排他にする
