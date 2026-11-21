# Claude の会話は transcript を射影し、hwc が起動したペインには hook と mod を渡す

- Status: Accepted

## Context

Herdr 0.9.5 は Claude のセッションを `agent_session: { source: "herdr:claude", agent: "claude", kind: "id", value: "<session uuid>" }` として返す。Claude Code は `CLAUDE_CONFIG_DIR`（既定 `~/.claude`）配下の `projects/<project>/<session uuid>.jsonl` に transcript を書く。transcript は追記型の 1 行 1 entry で、書き込み途中の行が末尾に現れる。assistant は 1 つの API メッセージを block ごとに複数 entry へ分けて書き、`uuid` / `parentUuid` で枝を持つ。

transcript だけでは足りないものがある。

- 待ち: AskUserQuestion と承認の待ちの間、assistant の `tool_use` は transcript に書かれない。ダイアログを閉じた瞬間に `tool_use` と `tool_result` が同時に追記される
- 速度と使用量: transcript は API の応答が終わるまで本文を書かず、`usage` も API 呼び出しごとの値で、現在の文脈量ではない。context window を返す API も無い
- モデル候補: pi の `--list-models` に当たる一覧 API が無い。CLI のモデルカタログのキャッシュ（`~/.claude/cache/model-catalog`）は公開形式ではない

一方、hwc が起動する Claude には `--settings`（hook を足せる。ユーザーの設定と併存する）と `--plugin-dir`（mod を読ませる）を渡せる。mod API には応答のチャンクを流す `turn.step` と、`/context` と同じ計算の `$.session.usage()` がある。どちらも early access で、形は版で変わり得る。

ここに書いた形は Claude Code 2.1.327〜2.1.328 と Herdr 0.9.5 の実機で確かめた。

## Decision

### 会話

- 会話は transcript の JSONL を読み取り専用で射影する。`projects/*/<session uuid>.jsonl` を id で探し、cwd からプロジェクト名を組み立てない（エンコードは CLI の内部形式）。同じ id が複数のプロジェクトにあれば、どれが会話か決められないので `chat_unavailable` にする
- 最後の entry から `parentUuid` を辿って active branch を作る。assistant は `message.id` ごとに束ねて text block を連結し、`thinking` と `tool_use` は捨てる。サブエージェント（`isSidechain`）、`isMeta`、圧縮の要約、TUI のローカルコマンドの記録は行にしない
- `model` は branch の最後の assistant の `message.model`、`effort` は最後の非 null の `perTurnEffort`
- transcript が見つからない・読めないときは端末出力へフォールバックする。pi と違い、ENOENT を空の会話にしない（セッション参照はあるのにファイルが無い状態と取り違えない）。見つからなかった結果は短い期限（4 秒）だけ覚え、ENTER 付きの送信を通したら捨てる。最初の送信まで transcript は存在しないため
- ファイルは全読みし、16MB を超えるときは末尾 16MB だけ読んで `truncated` を立てる

### 起動

- モデル候補は CLI のエイリアス（`fable` / `opus` / `sonnet` / `haiku`）に固定し、effort は `--effort` が受ける 5 段階に固定する。候補の取得では CLI を起動しない。起動引数は `--model <alias>` と、effort を選んだときだけ `--effort <level>`
- 候補の表示名だけは、CLI の control protocol の `list_models` から読む（`--safe-mode --print --verbose --input-format stream-json --output-format stream-json --no-session-persistence` の一時プロセス。推論リクエストは送らず、transcript も残らない。cwd はホームで、`HERDR_*` は継がない）。BFF のメモリに短く持ち、CLI の realpath / mtime / size が変わったら捨てる。読めなくても候補と起動は止めない
- hwc から起動するときは、状態ディレクトリの `claude/settings.json`（hwc 所有）を `--settings` で、同梱の `claude-mod/` を `--plugin-dir` で渡す。ユーザーの `~/.claude` の設定は書き換えない。どちらも用意できなければ、渡さずに起動を続ける

### 待ち（hook の sidecar）

- `--settings` の hook が、待ちを状態ディレクトリの `claude/pending/<session id>.json` に書く。AskUserQuestion は `PreToolUse` で、承認待ちは `PermissionRequest` で書き、`PostToolUse` などで消す。表示に要る項目だけを正規化して保存し、`tool_input` 全体は残さない。hook は何も出力せず、失敗しても 0 で終わる（stdout の JSON は `PreToolUse` の判定として解釈されるため）
- BFF は sidecar を transcript の射影に重ねて `pending` にする。待ちが解けたかは transcript の `tool_result` で知る。Esc で閉じたときはどの hook も呼ばれないため
- 質問には Web から答えられる。Esc でダイアログを閉じ、`tool_result` が現れてから、選んだ内容を `質問への回答:` で始まる本文として送る（[入力](agent-input.md)）。先頭の行を固定するのは、モデルが書いた質問文が `/` や `!` で始まるとコマンドとして解釈され得るため
- 承認は Web から送らない。Esc は拒否として働き、本文は承認の返事にならない

### 実行中の様子と使用量

- 段階（考えている・ツール実行中）は transcript から導く。現在のターンの起点（最後の prompt）より後ろの `api-request` と assistant の `requestRef`、`tool_use` と `tool_result` の `tool_use_id` を突き合わせる。ターンはファイルの位置で切り、時刻では切らない
- 生成速度と使用量は、同梱の mod が状態ディレクトリの `claude/live/<session id>.json` に書く。速度は `turn.step` の差分から推定した見えている出力の tok/s（pi の sidecar と同じ意味）、使用量は `$.session.usage()` の `{ tokens, window }`。速度は 2.5 秒より古ければ捨て、使用量は鮮度で捨てない
- 読めない版・形の違うファイルは無いものとして扱い、会話・段階・端末出力は止めない

## Consequences

- 会話・段階・待ちの表示は transcript と hook の内部形式に依存する。版で形が変われば読めなくなり、端末出力や段階なしの表示へ戻る。理由は画面に出ない
- 待ちのカード・速度・使用量は hwc から起動したペインだけで出る。hwc の外で起動した Claude は会話だけになる
- ツール実行・thinking・サブエージェントは会話に出ない。圧縮済みセッションは要約の行が出ないまま前後が並ぶ
- Web からの回答は「質問を拒否したうえで、選んだ内容を次の発言として送る」ことになる。Esc と本文の送信は 1 つの操作ではない
- エイリアスは CLI が最新モデルへ解決するので、hwc はリリースごとの対応表を持たない。CLI がエイリアスや段階を変えたら hwc も更新する
- `--plugin-dir` を知らない古い CLI（2.1.265 未満）では hwc からの起動が失敗する。段階の導出は 2.1.327 以降を前提にする
- transcript は BFF と CLI が同じユーザー・同じホストで動いている前提

## Alternatives

- **端末出力やスピナー行を解釈する**: TUI は自前で折り返し、ペイン幅と版に依存する。スマホの表示幅と端末幅も違う
- **ユーザーの `~/.claude/settings.json` に hook を足す**: hwc 外で起動した Claude にも効くが、ユーザーの設定を書き換える
- **CLI のモデルカタログのキャッシュを読む**: 版付きの名前が得られるが、公開形式ではなく、有無・鮮度・形式に依存する
- **版付きのモデル id や表示名の対応表を hwc に持つ**: リリースごとに更新が要り、既定が最新に追従しなくなる
- **transcript の `usage` とエイリアスから window を出す**: 呼び出しごとの値で文脈量と意味が違い、window も名前から決まらない（`--model haiku` の応答が 1M だった）
- **TUI のフォームをキー操作で再現して答える**: 汎用のキー入力を持たない方針に反し、タブの状態も読めない
