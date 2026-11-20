# ADR 0102: Claude の生成中の tok/s は同梱 mod のファイルから出す

- Status: Accepted
- Date: 2026-11-20
- Amends: [ADR 0100](0100-claude-live-activity.md) の「Claude の activity に `tokPerSecond` を入れない」という前提

## Context

[ADR 0100](0100-claude-live-activity.md) は Claude の段階を transcript から導いたが、速度は対象外にした。transcript は API の応答が終わるまで assistant の本文を書かないため、1 つの要求の中の進み（トークン数）が分からないからである。TUI のスピナーはトークン数と経過時間を出すが、折り返しと版への依存があり、読む経路として採らなかった。

一方、Claude Code 2.1.328 の mod API には `turn.step` があり、モデルの応答をチャンクごとに流す async generator としてフックできる。`stop` のチャンクは `usage.output_tokens` を持つ。hwc が起動する Claude には `--plugin-dir` を足せるので、hwc 専用の mod が速度だけを書けば、transcript の段階と組み合わせて帯に出せる。

2026-11-20 に Haiku 5.5（high）でスパイクし、次を実測した。

- `--plugin-dir` で mod は読み込まれ、`session.start` で `$.session.id()` が transcript のファイル名（UUID）と一致した
- `turn.step` のチャンクは `engine` / `text` / `thinking` / `input` / `tool` / `stop`。`stop.usage` に `output_tokens` と `model` がある
- first-party の thinking は本文が流れない。`thinking` のチャンクは約 1.2 秒ごとに空文字で来るため、到着回数だけでは計測可能と判定できない
- 本文の文字数から出した推定は、`usage.output_tokens` の 0.5〜0.65 倍だった（thinking 分が usage にしか載らないため）
- `$.fs.write` は原子的でないが、500ms 間隔・50ms の読み取り 398 回で途中の JSON は 0 回だった
- `session.end` は `/exit` で `reason: "prompt_input_exit"` として発火した

制約は次のとおり。

- mod API は early access。イベントと形は版で変わり得る。読めない版では速度を出さず、段階だけを出す
- fs には delete / rename が無い。片付けは上書きか `$.process.run` になる。ファイルの鮮度で無視する方が軽い
- hwc が起動していないペイン（TUI から起動、hwc の再起動前から動いている）には mod が無い。速度は出せない

## Decision

### mod は hwc が同梱し、起動時だけ渡す

- `claude-mod/` に 1 つの mod を置く。manifest、`hooks/hooks.json`、`hooks/register.mjs`。ビルドは無く、Claude Code が `.mjs` を直接読む
- hwc は Claude を起動するとき、`--settings` の次に `--plugin-dir <リポジトリ>/claude-mod` を渡す。mod のディレクトリが無いときは渡さない（パッケージ形態で同梱されない場合に起動を壊さない）
- mod は `HWC_CLAUDE_LIVE_DIR` が無ければ何もしない。hwc は `--settings` で渡す設定ファイルの `env` にこの値を入れる。ユーザーの `~/.claude/settings.json` は触らない
- mod が使うのは `session.start`、`turn.step`、`turn.complete` だけ。UI（`ui.render`）は触らない。速度の表示は hwc の帯に一本化する

### 書き手（mod）

- `session.start` で `$.env.get("HWC_CLAUDE_LIVE_DIR")` と `$.session.id()` を読み、セッション id がファイル名に使える形（`SESSION_ID`）のときだけ有効にする
- `turn.step` はサブエージェント（`e.agentId` がある）を素通しする。段階と同じく本流だけを映す（[ADR 0100](0100-claude-live-activity.md)）
- 速度は「見えている出力」の推定にする。`text` / `thinking` / `input` の差分の文字数を、ASCII は 0.25、それ以外は 1 トークンとして足す。first-party の thinking は本文が流れないので、この推定には入らない
- 計測可能の条件は、トークンが増えたチャンクが 8 個以上、最初の増加から 400ms 以上。空の `thinking` チャンクは数えない。短い応答を数ミリ秒で割って数千 tok/s にする事故を防ぐ
- 500ms 間隔で上書きする。値は小数 1 桁に丸め、1 未満は書かない
- `turn.step` の開始時、`stop` のチャンク、`turn.complete`（サブエージェントを除く）で `tokPerSecond: null` を書く。要求の待ち時間に前の応答の速度を残さない
- 書き込み失敗は握りつぶす。速度は表示のためだけであり、ターンを止めない

### ファイル

- 置き場は `<stateRoot>/claude/live/<session id>.json`。hwc が `ensureClaudeSettings` のときに 0700 で作る。transcript の隣ではない（mod は transcript の path を知らない。session id だけで引ける方が単純）
- 中身は 1 行 JSON で `{ v: 1, sessionId, at, tokPerSecond }`。`tokPerSecond` は数値または null。phase・本文・ツールは持たない。段階の正は transcript のままにする
- 1 件は数百バイト。読み手は 4KB を超えるファイルを読まない

### 読み手（BFF）

- `createClaudeChatClient` に `liveRoot` を足す。`activity(sessionId)` は transcript から導いた段階に、次の条件を満たすときだけ速度を重ねる
  - 段階が `thinking` / `writing` / `tool-call`（`ACTIVITY_RATE_PHASES`）
  - `at` が取得時刻から `LIVE_TTL_MS`（2.5 秒）以内
  - `tokPerSecond` が 1 以上の有限値。上限は `ACTIVITY_TOK_PER_SECOND_LIMIT`（10,000）
- `v` / `sessionId` の不一致、読めない JSON、古いファイル、`null` の速度は「無い」ものとして扱い、段階だけを返す
- 速度の取得に失敗しても段階は返す。会話・端末出力も止めない

### 数字の意味

- 帯の `tok/s` は画面に流れている出力の推定で、API の `usage.output_tokens` を時間で割った値ではない。thinking が隠れているモデル・設定では、請求上の output より小さく出る
- これは pi の sidecar と同じ意味（流れてこない reasoning は速度に含めない）。両者を同じ帯に並べても、数字の種類は揃う

## Why not

- **transcript の要求開始と応答終了から平均を出す**: 応答が終わってからしか出せず、「生成中」の帯に出せない
- **TUI のスピナーを読む**: 折り返し・再描画・版依存。スマホの表示幅と端末幅も違う（[ADR 0100](0100-claude-live-activity.md) と同じ理由）
- **statusline の JSON を使う**: イベント駆動で応答途中の更新が来ない。transcript の平均と同じく、事後の値になる
- **settings hook で書く**: `PreToolUse` などはターンの途中のチャンクを渡さない。速度には `turn.step` が要る
- **transcript の隣に書く**: mod から transcript の path は取れない。session id から引ける state 配下の方が単純で、hwc の既存の sidecar と同じ扱いにできる
- **`--plugin-dir` を知らない版でも起動できるようにする**: `--plugin-dir` は 2.1.265 以降にあり、2.1.265〜2.1.286 は起動できるが mod の hooks module が動かないため速度だけ出ない。それより古い版は未知の long option で終了する。起動のたびに版を確かめる処理は足さない
- **hwc の state に phase も書く**: 段階の正が transcript と mod の 2 つになる。段階は [ADR 0100](0100-claude-live-activity.md) のまま、速度だけを重ねる
- **停止時にファイルを消す**: fs に delete が無い。鮮度（2.5 秒）で無視すれば足りる

## Consequences

- hwc から起動した Claude だけ、生成中に `tok/s` が出る。TUI から起動したペインや、hwc が `--plugin-dir` を渡さないペインでは、段階と経過時間だけになる（[ADR 0100](0100-claude-live-activity.md) の表示に戻る）
- `--plugin-dir` は 2.1.265 以降、`turn.step` を提供する mod API は 2.1.287 以降。2.1.265〜2.1.286 では起動できて速度だけが出ない。2.1.265 未満では hwc からの起動が `agent_start_failed` になる。段階の導出も 2.1.327 以降を前提にしている（[ADR 0100](0100-claude-live-activity.md)）ため、古い版は対象外とする
- mod API の変更で速度が出なくなることがある。その場合も起動・会話・段階は壊れない。`claude plugin validate` と実機の Haiku で確認する
- 生成中は 500ms ごとに小さなファイルを書く。セッションごとに 1 ファイルで、履歴は持たない
- 書き込みは原子的でない。BFF は parse できないファイルを「無い」として扱い、次のポーリング（1 秒後）で取り直す
- 数字は見えている出力の推定で、請求上の output とは一致しない。thinking が隠れるモデルでは低く出る
- `HWC_CLAUDE_LIVE_DIR` を設定していない Claude（hwc 外）では、mod はファイルを作らない
- `claude-mod/` は `tsconfig` の `include`（`src` / `e2e`）の外に置く。mod は Claude Code が直接読み、hwc の型チェックやテストの対象にしない。契約は BFF 側の `claude-live.ts` とテストで固定する

## テスト

- unit（BFF）: 新しい速度を読む、古い・別セッション・壊れた JSON・大きすぎるファイル・`null` の速度を無視する、上限で丸める、`../` を含む session id を弾く
- unit（BFF）: 段階が `thinking` のときだけ速度を重ねる、`tool` の待ちには重ねない、`liveRoot` が無いときは従来表示のまま
- unit（起動）: Claude の起動引数に `--settings` と `--plugin-dir` が入る、mod が無いときは `--settings` だけ、設定を書けないときは引数なしで起動する
- unit（設定）: 設定の `env` に `HWC_CLAUDE_LIVE_DIR` が入る、live ディレクトリが 0700 で作られる
- E2E（架空 Herdr）: `/activity` のターンで、要求中に速度が出て、assistant が書かれた時点で消えること（[docs/e2e.md](../e2e.md)）
- 実機: hwc から Haiku のペインを起動し、生成中に `/api/panes/:id/activity` が `tokPerSecond` を返すこと
