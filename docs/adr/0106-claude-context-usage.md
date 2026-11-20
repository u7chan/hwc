# ADR 0106: Claude のコンテキスト使用量は同梱 mod の `session.usage` から出す

- Status: Accepted
- Date: 2026-11-20
- Amends: [ADR 0097](0097-claude-chat-transcript.md) の「`context` を `null` にする」、[ADR 0102](0102-claude-live-tok-rate.md) の「live ファイルは速度だけを持つ」

## Context

Claude のペインは、入力欄にモデルと effort を出すが、コンテキスト使用量のメーターを出していない。`context` を `null` のままにしていたためで、理由は 2 つある（[ADR 0097](0097-claude-chat-transcript.md)）。

- transcript の assistant 行は `message.usage` を持つが、これは API 呼び出しごとの値で、現在の文脈量を表す総数ではない
- モデルの context window が hwc 側に無い。Claude のモデル一覧は `--model` のエイリアスだけで、window を返す API は無い

一方、Claude Code 2.1.328 の mod API には `$.session.usage()` がある。2026-11-20 に次を確認した。

- 同梱の `/context` と同じ計算で、`context: { tokens, window, percent }` を返す。`tokens` は投影済みのメッセージ列の `total_input_tokens`、`window` は表示中モデルの `context_window_size`
- 要求がまだ無いセッションでは `{ window }` だけを返す
- `window` はモデルと設定で変わる。実測では `--model haiku` の応答が 1,000,000 で、エイリアスから 200,000 を決め打ちできない
- mod の `session.start` と `turn.complete` から呼べる。実機で `--plugin-dir` を渡した `claude -p` が `{"v":1,…,"context":{"tokens":23329,"window":1000000}}` を live ファイルへ書いた

制約は次のとおり。

- mod API は early access。イベントと形は版で変わり得る。読めない版では使用量を出さず、会話・段階・速度はそのまま動く
- mod は hwc が起動したペインにしか無い。hwc 外で起動した Claude の window を知る手段は無い
- 使用量は API 呼び出しの後にしか動かない。ターンの途中で細かく増える値ではない
- 既存の live ファイルは速度の鮮度（2.5 秒）で古いものを捨てている（[ADR 0102](0102-claude-live-tok-rate.md)）。使用量はターンをまたいで保つ必要がある

## Decision

### 書き手（mod）

- `session.start` と `turn.complete` で `$.session.usage()` を読み、`context` を `{ tokens, window }` に絞って live ファイルへ書く
- `session.start` でも書く。再開したセッションは、次のターンまで使用量が動かないため
- `tokens` は 0 以上の有限数、`window` は 1 以上の有限数だけを受け、整数に丸める。片方だけ無いときはそのまま `null` を持つ。両方読めなければ `context: null`
- 読めない版・失敗・形の不一致は `context: null` とし、速度の書き込みは止めない
- ファイルは `{ v: 1, sessionId, at, tokPerSecond, context }` の 1 行 JSON のまま。速度と使用量で同じファイルを使う

### 読み手（BFF）

- `parseLive` は `context` を速度とは別に読む。`at` が `LIVE_TTL_MS`（2.5 秒）を超えたファイルでも、`context` があれば返し、速度だけを `null` にする
- 古いファイルに `context` も無ければ、従来どおり「無い」ものとして扱う
- `context` の形が壊れているときは `context: null` にする。速度が壊れているファイルは、従来どおり丸ごと無いものとして扱う
- `createClaudeChatClient.snapshot` は、射影したスナップショットに `context` を重ね、`pending` と同じように `etag` を作り直す。射影のキャッシュは変えない
- クライアントは変えない。`snapshot.context` があれば、既存の `ContextMeter` が入力欄に出す
- hwc はモデル別の window 表を持たない。window の解決は CLI に任せる

## Why not

- **transcript の `usage` を足して使用量にする**: 呼び出しごとの入力・キャッシュ・出力の合計で、CLI が `/context` に出す文脈量とは意味が違う。window も無い
- **transcript の使用量と、エイリアスから引く window を組み合わせる**: 1M のモデル・`CLAUDE_CODE_MAX_CONTEXT_TOKENS`・ゲートウェイの独自名でずれる。CLI が解決した値を読む方が正確で、版に追従する表も要らない
- **モデル名から 200k / 1M を決め打ちする**: 実測で `--model haiku` の window は 1M だった。名前と window は一致しない
- **`/context` の出力や TUI を読む**: 折り返し・再描画・版依存で、スマホの表示幅とも違う（[ADR 0100](0100-claude-live-activity.md) と同じ理由）
- **`--settings` の hook で書く**: hook の入力に window が無い。mod の `$.session.usage()` が要る
- **使用量を別ファイルにする**: 速度と同じセッションの状態で、書き手も読み手も 1 か所にまとまる。鮮度の扱いだけを分ければ足りる
- **`tokens` が無いセッションでは何も出さない**: 枠だけ分かるなら `?/1.0M` を出す。pi と同じく、材料がある分だけ出す
- **使用量が古いファイルを捨てる**: ターンの終わりにしか動かないので、捨てると次のターンまで消える。session id は使い回されない

## Consequences

- hwc から起動した Claude のペインだけ、入力欄に `123k/1.0M (12.3%)` が出る。hwc 外で起動したペインは、従来どおりメーターが出ない
- 更新はターンの終わり。生成中に増えていく表示ではない
- 空のセッションでは `?/1.0M` のように枠だけが出る
- `context.tokens` が入るため、`/compact` の「会話が小さいうちは圧縮できません」のガードが Claude にも効く（[commands.ts](../../src/client/commands.ts)）。圧縮済みの判定は transcript に印が無いため、引き続き効かない
- mod が無い・読めない版では、`context` が無いだけで会話・段階・速度は変わらない
- mod API の変更で使用量が出なくなることがある。`claude plugin validate` と実機の確認は [docs/agents.md](../agents.md) の手順に従う

## テスト

- unit（BFF）: `context` を速度と一緒に読む、古いファイルでも `context` を保つ、片方だけの `context` を読む、壊れた `context` を無視する、壊れた速度は従来どおり丸ごと無視する
- unit（BFF）: スナップショットに `context` を重ね、`etag` が変わる。`liveRoot` が無いときは `null` のまま
- 実機: `claude -p --plugin-dir claude-mod` で live ファイルに `context` が書かれること（2026-11-20 に確認）
- E2E（架空 Herdr）: Claude のペインで、live ファイルの `context` がメーターとして出ること
