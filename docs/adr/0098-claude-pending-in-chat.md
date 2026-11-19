# ADR 0098: Claude の応答待ちは hook の sidecar から読み、チャットに出す。Web からは承認しない

- Status: Accepted
- Date: 2026-11-19
- Amends: [ADR 0097](0097-claude-chat-transcript.md)

## Context

Claude は AskUserQuestion と permission prompt で `agent_status: "blocked"` になる。hwc は `blocked` のとき本文を端末出力へ切り替えていた（[ADR 0013](0013-pi-session-chat.md) の「要対応の間は端末を見たい」）。Claude の会話を読めるようにしても、質問中は TUI の画面に戻り、Web では質問の内容が読めない。

質問文と選択肢は transcript の tool_use にある、と考えて最初は transcript だけから待ちを読む実装を作った（#333）。実機（Claude Code 2.1.328、Herdr 0.9.5）で確かめると成り立たなかった。待ちの間、assistant の `tool_use` は transcript に書かれない。ダイアログを閉じた瞬間に、`tool_use` と `tool_result` が同時に追記される。blocked の間、transcript の末尾は user の本文のままで、読み取る側からは何も待っていないように見える。

transcript の外で、待ちを教えてくれる口は CLI の hook にある。`--settings` で渡した hook は、ユーザーの `.claude` の設定へ足されて併存する（Herdr が session id を報告する SessionStart の hook もそのまま動く）。フォルダの信頼確認のあとなので、hook のための確認は増えない。実機で確かめたイベントの順序は次のとおり。

- AskUserQuestion: `PreToolUse`（`tool_use_id` を持つ）→ `PermissionRequest`（`tool_use_id` を持たない）→ 回答で `PostToolUse` → `Stop`
- 承認が要るツール（Bash など）: `PreToolUse` → `PermissionRequest` → 承認で `PostToolUse`。承認が要らないツールは `PermissionRequest` が来ない
- Esc で閉じたとき: **どの hook も発火しない**（`PostToolUse`・`PostToolUseFailure`・`PermissionDenied`・`Stop` のいずれも来ない）。transcript には、assistant の `tool_use` と、`is_error: true` の `tool_result` と、user の `[Request interrupted by user for tool use]` が 0.5 秒以内に書かれる
- `Notification`（`permission_prompt`）は待ちに入って数秒後に来る。待ちの合図には遅いので使わない

さらに Claude はフォルダ信頼確認の対象外なので `readOnly` にならない（[ADR 0032](0032-codex-folder-trust.md)、[ADR 0044](0044-pi-project-trust.md)）。要対応の間も入力欄が有効なままで、質問ダイアログに本文が流れ込む穴があった（#335 で入力欄を閉じる）。

## Decision

### hook が待ちを書く

- hwc から Claude を起動するとき、状態ディレクトリの `claude/settings.json`（hwc 所有）を `--settings` で渡す。ユーザーの `.claude` の設定は変更しない。起動のたびに内容を確かめ、違えば書き直す。書けなければ hook なしで起動を続ける（カードが出ないだけで、端末出力のままになる）
- hook は `PreToolUse` / `PermissionRequest` / `PostToolUse` / `PostToolUseFailure` / `UserPromptSubmit` / `Stop` / `SessionEnd` の 7 つで、すべて同じコマンド（`bun src/server/claude-hook.ts <sidecar の置き場>`）を呼ぶ。bun の実行ファイルは BFF の `process.execPath` を絶対パスで書く（`mise` のシムを経由すると起動が重い）。何も出力せず、失敗しても 0 で終わる。stdout に JSON を出すと `PreToolUse` の判定として解釈される
- 置き場は状態ディレクトリの `claude/pending/<session id>.json`。セッションごとに 1 件を、一時ファイル経由で置き換える。内容は `{ v, sessionId, at, toolUseId, tool, pending }`。`pending` は表示に必要な正規化済みの項目だけで、`tool_input` 全体は保存しない（Write の `content` などを残さない）。正規化と上限は BFF と hook で同じモジュール（`claude-pending.ts`）を使う
- 書き込みは次の規則による:
  - `PreToolUse` が AskUserQuestion なら、その場で質問の待ちとして書く。ダイアログが開くこと自体が人間待ちなので、`PermissionRequest` を待たない
  - `PreToolUse` が他のツールなら、`pending` なしで `toolUseId` と tool 名だけを書く。承認が要るかはまだ分からず、入力も保存しない
  - `PermissionRequest` は `tool_use_id` を持たないので、直前の `PreToolUse` が書いたものと、同じセッション・同じ tool 名のときだけ突き合わせて `toolUseId` を引き継ぎ、承認待ちとして要約（Bash の `command`、Read / Edit / Write の `file_path`、WebFetch の `url`）を足す。突き合わせられなければ書かない。並列呼び出しで別のツールの行になっているときに、誤った id を付けない（カードは出ず、端末出力のままになる）
  - `PostToolUse` / `PostToolUseFailure` は、書いてある `toolUseId` と同じときだけ消す。並列のツールが先に終わっても、別のツールの待ちを消さない
  - `UserPromptSubmit` / `Stop` / `SessionEnd` は消す。Esc で閉じた待ちは hook が何も呼ばないので、次の発言かターンの終わりまで残る
  - サブエージェントのイベント（`agent_id` を持つ）は無視する。本流の待ちを上書きしない
- 書くたびに、24 時間より古いファイルを消す。閉じ損ねたセッションの残骸を溜めない

### BFF は sidecar を重ねて pending にする

- `ChatSnapshot` に optional の `pending` を足す。`ChatPending` は `kind: "question"`（AskUserQuestion）と `kind: "tool"`（それ以外）の 2 種類で、`toolUseId` はどちらも 1 つだけ持つ。質問ごとには持たない
- Claude の reader は、transcript の射影（キャッシュあり）に、取得のたびに sidecar を読んで重ねる。sidecar は transcript の外なので、射影のキャッシュ（サイズと inode）に入れない。重ねたら etag も作り直す（`pending` は etag に含める）
- sidecar の待ちを採るのは、セッション id が一致し、24 時間以内で、`pending` が読めて、その `toolUseId` が transcript の active branch で解決されていない（`tool_result` が無い）ときだけ。**Esc は hook を呼ばないので、解決は transcript の `tool_result` で知る**。Esc の直後に sidecar が残っていても、次の取得で `tool_result` が現れてカードが消える
- 重ねる待ちが無いときは、transcript の active branch の末尾が `tool_result` を持たない assistant の `tool_use` かを見る。CLI が待ちの間に `tool_use` を書く版が出たときのための経路で、実機では使われない。複数あるときは AskUserQuestion を優先し、無ければ最後の 1 件を代表にする
- sidecar は読むときも検証する。形が合わない・256KB を超える・別のセッションのものは無いものとして扱い、`pending` は書き手と同じ上限（質問 4 件・選択肢 10 件・質問文 2000 文字・header 100 文字・label 500 文字・description 1000 文字・要約 200 文字）で正規化し直す。制御文字は落とし、改行は空白にする。Markdown / HTML としては解釈しない
- AskUserQuestion の `questions` が配列でない・空・`options` が空・`label` が空なら、待ちとして扱わない（カードを出さない）

### クライアントは blocked の間だけカードを出す

- クライアントは `blocked && pending` のときだけカードを出す。`agent_status` は Herdr の状態で、sidecar とずれる瞬間がある。カードは `blocked` の間だけ出し、解決後は次の取得で消す
- `blocked && pending` のときは body を会話のままにする。入力欄・引用・添付・コマンドは閉じる（`inputDisabled`。既存の `readOnly` は body を端末出力へ切り替えるので、別の条件にする）
- カードに「端末出力を見る / 会話に戻る」を置く。切り替えはどの待ちに対して開いたかだけをローカル state に持ち、待ちが変われば会話へ戻る。permission prompt は端末の画面を見ないと承認できないが、質問も同じ切り替えで読める
- `pending` が読めないときは今までどおり端末出力へ倒す。誤検知でペインを操作不能にしない（入力欄は #335 のとおり閉じたまま）
- `blocked` 中も Claude だけ会話を取得する。`chatPollDelay` は `blocked` を `idle` と同じ間隔にしてある（5 秒）
- `/new` の表示用スナップショット（`newSessionSnapshot`）は `pending` を落とす。`/new` の直後に古いカードを出さない
- 質問への回答と permission の承認は Web から送らない。回答は別の ADR で決める
- Codex / Pi の確認画面と、他のエージェントへの pending の展開は変えない

## Consequences

- hwc から起動した Claude だけがカードを出せる。既に起動している Claude や hwc 外で起動した Claude は hook を持たないので、今までどおり端末出力のまま（入力欄は閉じる）。設定を足しても、起動中のペインは再起動するまで hook を持たない
- hook の入力形（`tool_use_id` が `PreToolUse` にだけある、`PermissionRequest` の発火条件）は CLI の版で変わり得る。形が合わなければ待ちを書かないだけで、端末出力に戻る。理由は画面に出ない
- 承認待ちの代表 1 件は、並列呼び出しでは出ないことがある。誤った tool のカードを出すより、端末出力を選ぶ
- ツールを呼ぶたびに hook プロセスが数回起動する（`PreToolUse` と `PostToolUse`）。bun の起動は数 ms で、LLM の応答に比べて無視できる。書き込みは数 KB 未満
- 承認が要る tool の要約には、コマンドやパスが一時的にディスクへ残る（状態ディレクトリ、0600、解決で消える）。`tool_input` 全体は残さない
- 質問文と選択肢はモデルが書いた文字列である。長さと制御文字だけを正規化し、内容は検証しない
- `pending` を etag に入れるため、待ちの出入りで 304 が減る。待ちは稀なので許容する
- Claude 以外の `blocked` は今までどおり端末出力になる

## Alternatives

- **transcript の末尾の tool_use だけから読む**: 最初に作った案（#333）。実機では待ちの間に `tool_use` が書かれず、カードが出ない。フォールバックとしてだけ残す
- **端末出力を解釈してダイアログを読む**: TUI の描画から質問を拾う案。折り返しと再描画で選択肢の対応が崩れ、画面の文言に依存する。会話の正はセッションにある（ADR 0013）
- **ユーザーの `.claude/settings.json` に hook を足す**: hwc 以外から起動した Claude にも効くが、ユーザーの設定を書き換える。`--settings` で hwc 所有の設定だけを渡す
- **`Notification` の hook を待ちの合図にする**: 待ちに入って数秒後にしか来ない。`PermissionRequest` は即時に来る
- **`PreToolUse` の全ツールで待ちを書く**: 承認が要らないツールの入力（コマンド）まで毎回ディスクへ書く。`PermissionRequest` で承認待ちと分かったときだけ要約を足す
- **`agent_status` だけで人間待ちと決める**: 内容が出せない。sidecar と重ねる
- **pending があれば blocked でなくてもカードを出す**: ツール実行中にもカードが出て、人間待ちと誤解させる。`blocked` を条件にする
- **権限確認だけ専用ビューで承認する**: TUI の対話と同じ状態を保つ保証がなく、誤操作の影響も読めない。まず表示だけを出す
- **新しく one-shot の取得を足す**: `usePaneChat` の `enabled` を blocked でも true にすれば足りる。取得の経路を増やすと、打ち切り・可視状態・etag の扱いが二重になる
