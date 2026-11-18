# ADR 0098: Claude の応答待ちはチャットに出す。Web からは承認しない

- Status: Accepted
- Date: 2026-11-19
- Amends: [ADR 0097](0097-claude-chat-transcript.md)

## Context

Claude は AskUserQuestion と permission prompt で `agent_status: "blocked"` になる。実機の Claude ペインは質問の待ちで `blocked` になり、transcript の末尾は tool_result を持たない assistant の tool_use だった。

hwc は `blocked` のとき本文を端末出力へ切り替えていた（[ADR 0013](0013-pi-session-chat.md) の「要対応の間は端末を見たい」）。Claude の会話を読めるようにしても、質問中は TUI の画面に戻り、Web では質問の内容が読めない。

さらに Claude はフォルダ信頼確認の対象外なので `readOnly` にならない（[ADR 0032](adr/0032-codex-folder-trust.md)、[ADR 0044](adr/0044-pi-project-trust.md)）。要対応の間も入力欄が有効なままで、質問ダイアログに本文が流れ込む。Codex と Pi の信頼確認で起きたのと同じ穴になる。

質問文と選択肢は transcript の tool_use にある。会話の一部として読めるが、回答は TUI の対話でしか送れない。

## Decision

- `ChatSnapshot` に optional の `pending` を足す。`ChatPending` は `kind: "question"`（AskUserQuestion）と `kind: "tool"`（それ以外）の 2 種類で、`toolUseId` はどちらも 1 つだけ持つ。質問ごとには持たない（回答 API の body も 1 つ）
- 射影は active branch の assistant の tool_use と user の tool_result を、tool_use の `id` と `tool_result.tool_use_id` で突き合わせる。`pending` は、会話の末尾（sidechain と行にならない entry を除いた最後の user / assistant）が tool_result を持たない assistant の tool_use のときだけ入れる。解決するか末尾が変われば消える
- 未解決が複数あるときは AskUserQuestion を優先し、無ければ最後の 1 件を代表にする。どの tool_use が人間待ちか transcript だけでは決められないため
- AskUserQuestion の `input.questions` を検証する。配列でない、空、`options` が空、`label` が空なら pending にしない（カードを出さない）。上限は質問 4 件・選択肢 10 件・質問文 2000 文字・header 100 文字・label 500 文字・description 1000 文字・要約 200 文字。超えた分は切り、制御文字を落として改行を空白にする。Markdown / HTML としては解釈しない
- ツールの要約は既知の入力欄だけから作る（Bash の `command`、Read / Edit / Write の `file_path`、WebFetch の `url`）。input 全体は出さない。権限確認の input は巨大になり得るし、Write の `content` を画面と通信に乗せたくない
- クライアントは `blocked && pending` のときだけカードを出す。ツールが実行中の間も transcript の末尾は tool_use なので、pending だけでは人間待ちと決められない。`agent_status` は Herdr の状態で、transcript とずれる瞬間がある。カードは `blocked` の間だけ出し、解決後は次の取得で消す
- `blocked && pending` のときは body を会話のままにする。入力欄・引用・添付・コマンドは閉じる。既存の `readOnly` は body を端末出力へ切り替えるので、入力の停止は別の `inputDisabled`（`readOnly || pending`）にして、既存の `readOnly` のガードをすべてそこへ揃える
- カードに「端末出力を見る / 会話に戻る」を置く。切り替えはどの tool_use に対して開いたかだけをローカル state に持ち、pending が変われば会話へ戻る。permission prompt は端末の画面を見ないと承認できないが、質問も同じ切り替えで読める
- pending が読めないときは今までどおり端末出力へ倒す。誤検知でペインを操作不能にしない
- `blocked` 中も Claude だけ会話を取得する。`chatPollDelay` は `blocked` を `idle` と同じ間隔にしてあり、`usePaneChat` の `enabled` を false にすると `refresh()` も止まるため、5 秒間隔の取得をそのまま使う。他のエージェントの `blocked` は信頼確認などで、会話を読む理由がない
- `pending` は etag に含める。ツールの開始・終了で本文が変わるので 304 は減る。1 ターンあたりの取得回数と本文量が問題になったら、blocked の間だけに絞る
- `/new` の表示用スナップショット（`newSessionSnapshot`）は literal で作り直すので、`pending` は落ちる。`/new` の直後に古いカードを出さない
- 質問への回答（#331）と permission の承認は Web から送らない。回答 API を足すときも、端末の対話と競合しない形を別に決める
- Codex / Pi の確認画面と、他のエージェントへの pending の展開は変えない

## Consequences

- 会話の表示は transcript の内部形式に依存する。AskUserQuestion の input の形が版で変わればカードが出なくなり、端末出力へ戻る。画面に理由は出ない
- 承認待ちの代表 1 件が、実際に承認待ちの tool と違うことがある。同じターンに複数の tool_use があると、transcript からはどれが人間待ちか決められない
- permission prompt はカードだけでは承認できない。端末出力へ切り替えて操作するので、`blocked` 中の操作が会話と端末の 2 画面になる。スマホでは切り替えの往復が増える
- `pending` を etag に入れるため、ツールの開始・終了で 304 が減る。working 中はもともと本文が変わるので許容し、取得量は実測してから絞る
- 質問文と選択肢はモデルが書いた文字列である。長さと制御文字だけを正規化し、内容は検証しない
- Claude 以外の `blocked` は今までどおり端末出力になる。pending の展開は別の Issue とする

## Alternatives

- **端末出力を解釈してダイアログを読む**: TUI の描画から質問を拾う案。折り返しと再描画で選択肢の対応が崩れ、transcript にあるはずの内容を二重に実装することになる
- **`agent_status` だけで人間待ちと決める**: tool_use が実行中の間も `working` と `blocked` の区別だけでは内容が出せない。transcript の pending と重ねる
- **pending があれば blocked でなくてもカードを出す**: ツール実行中にもカードが出て、人間待ちと誤解させる。`blocked` を条件にする
- **blocked の間は今までどおり端末出力にする**: 質問の内容が Web で読めない。Issue の目的そのもの
- **権限確認だけ専用ビューで承認する**: Claude の permission prompt を Web から答える案。TUI の対話と同じ状態を保つ保証がなく、誤操作の影響も読めない。まず表示だけを出す
- **新しく one-shot の取得を足す**: `usePaneChat` の `enabled` を blocked でも true にすれば足りる。取得の経路を増やすと、打ち切り・可視状態・etag の扱いが二重になる
