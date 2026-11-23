# pi の会話はセッション JSONL を正とし、実行中の様子と編集は mypi 拡張との契約で扱う

- Status: Accepted

## Context

ペインの会話を Web に出したい。Herdr の `pane.read` / `agent.read` が返す端末出力は TUI の描画結果で、折り返し・全画面 UI・再描画の残骸を含む。本文を取り出すには画面を解釈するしかなく、user と assistant の区別もモデル名も安定して取れない。

pi は会話を v3 の JSONL で保存する。`user` / `assistant` のメッセージ、`id` / `parentId` の木、`model` / `thinkingLevel` が構造として入り、追記型で 1 行 1 エントリになっている。Herdr は `session.snapshot` のペインに `agent_session`（`{ agent, source, kind, value }`）を返し、`kind: "path"` ならそのファイルを読める。BFF は Herdr と同じユーザーで動くので直接読める。セッションは 40MB の実績がある。

一方、pi は assistant メッセージを `message_end` でしか JSONL に書かない。ストリーミング中の thinking はディスク上に無く、セッションだけでは「今なにをしているか」を出せない。過去の発言の編集（分岐）も pi の TUI の機能で、Herdr に分岐操作の API は無い。

## Decision

### 会話

- 会話の正は pi のセッション JSONL とし、二次ストアを持たない。ペインとセッションは 1:1 とみなし、Web は現在のセッションの active branch だけを映す
- BFF がペイン id からセッション path を解決する。path は client へ渡さず、client から受け取らない
- path ごとに増分リーダーを持ち、要求時にスナップショットを返す。バックグラウンド監視はしない。読み取りは追記分だけを対象にし、ヘッダの `id` の変化・`size` の減少・inode の変化・ファイルの消失で全リセットする。パースできない行はその行だけ捨てる。v3 以外のヘッダは `chat_unavailable` にする
- 返すのは最新の compaction の `firstKeptEntryId` 以降に限る。モデルの実際の文脈（要約 + 残した分）と表示を一致させる。窓が成立しないときは branch 全体を返し、古い compaction へは遡らない
- 応答は直近 500 メッセージ / 1MB の小さい方を上限にし、切ったら `truncated` を立てる。この上限は他のエージェントの会話にも使う
- ツールコール・thinking・ツール結果は会話として出さない。セッションが無い・読めないときは端末出力にフォールバックする
- コンテキストの上限は pi のモデルカタログ（`models-store.json` に `models.json` の `modelOverrides` を重ねたもの）から引き、無いモデルは同じ agent dir の `pi --offline --mode rpc --no-session --no-extensions` の `get_available_models` で引く。agent dir はセッション path から導く。カタログや RPC の失敗は会話の取得を止めず、引けない値だけ `null` にする

### 起動

- モデル候補は、そのペインの cwd で `pi --offline --list-models` を実行して読む。effort 候補は `pi --offline --mode rpc --no-session --model provider/id` の `get_available_thinking_levels` を読み、対応段階の規則を hwc にコピーしない。どちらも `HERDR_*` を外し、時間と出力量に上限を置いて必ず回収する
- 起動引数は `--model provider/id` と、effort を選んだときだけ `--thinking value`（[起動](agent-launch.md)）

### 実行中の様子（sidecar）

- pi 拡張（mypi）がセッションの隣に `<session>.jsonl.thinking.json` を書き、BFF が `GET /api/panes/:id/activity` で読む。中身は v1 の 1 行 JSON で、段階（`phase`）、thinking の末尾、実行中のツール、生成速度を持つ。追記せず上書きし、ターンの終わりとセッションの終了で消す
- 契約の正は `src/shared/activity.ts` の `parsePaneActivity` で、書き手と読み手が同じ関数で検証する。`v` が合わない・壊れた・大きすぎる・30 分より古いファイルは無いものとして扱い、会話の取得も表示も止めない
- 会話のスナップショットには混ぜない。差分のたびに etag が動いて 304 の意味が壊れるため

### 質問と回答（ask_user）

- mypi の `ask_user` は、モデルが利用者へ 1 問だけ質問し、回答を待つ。hwc はセッションの隣に置かれた pending をカードにし、answer を書いて答える。TUI のキー操作は使わない
- 契約は mypi と共有する。pending は `<session path>.ask.json`、answer は `<session path>.ask.answer.json`。セッション path に接尾辞を足すだけで、設定は持たない。BFF がペイン id から path を導き、クライアントからは受け取らない
- pending は `{ v: 1, id, question, options, recommended, freeText }`。`id` は UUID で、pending とツール呼び出しは 1 対 1。`options` は自由入力のとき必ず `null`。`recommended` は `options` の 1 つで、表示だけに使う。`freeText` は選択肢があっても text 回答を受け付けるかの可否で、`options` が `null` なら常に true。古い pending にこの 2 つが無い場合は、`recommended: null` / `freeText: false`（`options` が `null` なら true）として読む。answer は `{ v: 1, id, answer: { kind: "option", label } }` または `{ v: 1, id, answer: { kind: "text", text } }` で、`id` は pending と完全一致させる。option の label は pending の選択肢と完全一致させ、前後の空白を付けない。text は `freeText` が true のときだけ使う
- 制限値は `src/shared/ask-user.ts` に置く。question は CRLF / CR を LF に直して trim 後 1〜500 コードポイントで、`\n` 以外の制御文字を拒否する。options は 2〜6 個、各 trim 後 1〜120 コードポイントで、制御文字・改行を含まず、trim 後の重複を拒否する。text は trim 後 1〜2000 コードポイントで、`\n` と `\t` 以外の制御文字を拒否する。読み取りは JSON を parse する前にサイズを見る（pending は 8KB、answer は 16KB）。`v` が違う・壊れた・形が合わないファイルは無いものとして扱い、会話の取得を止めない
- answer は tmp に書いて rename する atomic write で、権限 0600、1 行 JSON + 末尾の改行 1 つ。失敗した tmp は消す。既存の answer は置き換える
- 会話のスナップショットは pending を `kind: "question"` / `tool: "ask_user"` の 1 問として載せる。`toolUseId` は pending の `id`、`header` は `null`、`multiSelect` は `false`、`freeText` は pending の値をそのまま載せる。選択肢は `{ label, description }` の配列で、推奨を先頭に移し、その description だけ `推奨💡` にする。options が `null` なら空配列にする。etag には実際に返す pending から `ask-<id>` または `ask-none` を足す。JSONL が不変でも、pending の出現・差し替え・削除で 200 を返し、変化が無いときだけ 304 にする
- カードを出すかは Herdr の `blocked` と重ねる。pending は TUI のダイアログが開いている間も存在するので、pending だけでは人間待ちと決めない。`blocked` で pending があるときだけ会話の末尾にカードを出し、入力欄と過去発言の編集を閉じる。pending が消えたらカードを閉じ、`blocked` が解けたら会話表示と入力欄に戻る。pending が消えても `blocked` のままなら端末出力に倒し、入力欄は戻らない
- 回答は `POST /api/panes/:id/answer-question` の pi 分岐だけで受ける。`blocked` と pending の `id`・`question`・回答の形を確かめ、既存 answer が同じ質問への有効な回答でないことと pending を書き込み直前に再照合してから answer を書く。壊れた answer は無いものとして扱う。受理は最初の 1 回だけで、キーも本文も送らない。書き込みの失敗は 502 にし、成功に見せない。200 は「answer に書いた」の意味で、pi が採用した意味ではない
- mypi は pending を書けたときだけ Herdr に `blocked` を報告し、TUI の回答・Esc・中断・Web の回答のいずれかで pending を消す。hwc は pending が消えたらカードを閉じる。`blocked` が解けたら会話表示に戻り、pending が残っていてもカードは出さない

### 過去の発言の編集

- mypi が `/hwc-rewind <entryId> <requestId>` を提供し、hwc はそれを通常の入力として送る（[入力](agent-input.md)）。mypi は対象の親へ戻り、`customType: "hwc-rewind"` の marker を追記する。BFF は marker を確かめてから、編集後の本文を通常の入力で送る（2 相）
- mypi は `HERDR_PANE_ID` を持つセッションの開始時に `hwc-capabilities`（`{ v: 1, rewind: true }`）を追記する。BFF はこれがあるセッションだけ編集を許す
- 契約の型と ID の形は `src/shared/rewind.ts` と mypi の実装で揃える。marker は LLM の文脈に入らない custom entry にする

### フォルダ信頼確認

- pi の `Trust project folder?` には、既定の `Trust` だけを Web から答える。判定は `pane.read` の `detection` で、最後に現れたタイトルより下だけを読み、タイトル・信頼対象の完全なパス・注意文・選択肢・フッターが揃い `→ Trust` が選択中のときだけ答える。注意文と選択肢は端末幅で折り返されるので、空白を畳んだ 1 行で照合する。答え方は [入力](agent-input.md) に従う

## Consequences

- 会話の表示は pi のセッション形式に依存する。形式が変わると追従が必要になる
- ツール実行だけのターンは会話に出ない。`working` の表示と sidecar で補う
- 500 件 / 1MB より古い会話は Web から読めない。窓が成立しないときは、圧縮済みでも古い会話が並ぶ
- 拡張が無いペインでは段階・thinking・生成速度が出ず、編集もできない。capability はセッション開始時に 1 回だけ書くので、拡張を入れる前に始めたセッションは `/new` するまで編集できない
- sidecar と rewind の契約を変えるときは、mypi と hwc の両方を直す。`v` で弾くので、読み手は古い形式を無視して従来表示に戻るだけ
- 編集で戻すのは会話だけで、ファイル変更・ツール実行・シェルの状態は戻らない。元の枝はファイルに残るが表示されない
- Herdr 0.9.5 の pi 検出は信頼確認の画面を `blocked` にしないため、一覧は `idle` のまま。確認が要ることは、開いているペインの確認ビューだけが知らせる。Discord の要対応通知も届かない
- `ask_user` が入っていない mypi のペインでは pending が無く、今までどおり端末出力になる。`v` と形を弾くので、古い拡張でも会話の取得は壊れない
- `blocked` は Herdr の pi integration（v9）が拡張のイベントを受けて報告する。integration が無い・古い・イベント名が変わるとカードは出ない（会話と入力欄は通常どおり）
- hwc は ask_user の tool call / tool result から、質問を agent、回答を user のメッセージとして会話に合成する。dismissed / aborted / invalid は合成しない。合成した user メッセージは編集対象にしない。回答直後はクライアントが同じ本文を控えとして先に表示し、mypi の tool result details の `askId` が pending の `id` と一致する合成回答が届いたら畳む。古い mypi は askId が無いので、pending が外れた後に質問文と、合成 ID で対応づけた回答でフォールバックする
- TUI と Web がほぼ同時に答えると、mypi が先に読んだ方が勝つ。ack は無く、後から書いた answer は残骸になる。次の質問の開始前に mypi が消す。二重回答の調停はしない
- pending は pi の強制終了で残ることがある。Herdr の状態は `blocked` でなくなるのでカードは出ず、次の質問の開始前に mypi が消す。鮮度のための TTL は契約に無い
- pending が残っていても `blocked` でなければカードを出さず、会話表示に戻る。逆に、pending だけ消えてまだ `blocked` なら、カードは閉じても端末出力のままで入力欄は戻らない
- answer を書けない場合（agent dir が読み取り専用など）は 502 になり、カードは残る。端末で答える案内が必要

## Alternatives

- **端末出力を解釈する**: 上の Context のとおり、本文も話者もモデルも安定して取れない
- **SQLite などに会話を取り込む**: 正が 2 つになり、同期と移行を持つことになる
- **sidecar の代わりに TUI の thinking を読む**: 常用環境では `hideThinkingBlock` で隠しており、画面の解釈にも戻る
- **編集で TUI のキー操作（`/tree`）を送る**: ピッカーを閉じる保証が無く、汎用のキー入力を持たない方針に反する
- **pi に HTTP エンドポイントを立てる**: BFF から pi のプロセスへ直接要求する経路が増え、Herdr のペインとの対応が二重になる
- **拡張の `project_trust` イベントから BFF へ問い合わせる**: 拡張の注入と起動時の待ち合わせが要り、既知の 1 画面には過剰
- **`ask_user` の受け渡しに HTTP / socket を立てる**: BFF から pi のプロセスへ直接要求する経路が増え、Herdr のペインとの対応が二重になる。ファイルなら pi のクラッシュ後も残骸を次の質問で消せる
- **`blocked` だけで質問カードを出す**: 承認・権限確認・フォルダ信頼など、質問以外の `blocked` と区別できない。pending を正本にする
- **TUI のキー操作で質問に答える**: 選択肢を画面から読む必要があり、スマホに矢印キーも無い
