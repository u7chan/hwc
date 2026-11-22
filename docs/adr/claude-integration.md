# Claude の会話は transcript を射影し、hwc が起動したペインには hook と mod を渡す

- Status: Accepted

## Context

Herdr 0.9.5 は Claude のセッションを `agent_session: { source: "herdr:claude", agent: "claude", kind: "id", value: "<session uuid>" }` として返す。Claude Code は `CLAUDE_CONFIG_DIR`（既定 `~/.claude`）配下の `projects/<project>/<session uuid>.jsonl` に transcript を書く。transcript は追記型の 1 行 1 entry で、書き込み途中の行が末尾に現れる。assistant は 1 つの API メッセージを block ごとに複数 entry へ分けて書き、`uuid` / `parentUuid` で枝を持つ。

transcript だけでは足りないものがある。

- 待ち: AskUserQuestion と承認の待ちの間、assistant の `tool_use` は transcript に書かれない。ダイアログを閉じた瞬間に `tool_use` と `tool_result` が同時に追記される
- 速度と使用量: transcript は API の応答が終わるまで本文を書かず、`usage` も API 呼び出しごとの値で、現在の文脈量ではない。context window を返す API も無い
- モデル候補: pi の `--list-models` に当たる一覧 API が無い。CLI のモデルカタログのキャッシュ（`~/.claude/cache/model-catalog`）は公開形式ではない

一方、hwc が起動する Claude には `--settings`（hook を足せる。ユーザーの設定と併存する）と `--plugin-dir`（mod を読ませる）を渡せる。mod API には応答のチャンクを流す `turn.step` と、`/context` と同じ計算の `$.session.usage()` がある。どちらも early access で、形は版で変わり得る。

実行中のモデルと effort の切り替えには、次の事情がある（Claude Code 2.1.330 の実機で確かめた）。

- `/model <alias>` と `/effort <level>` は入力欄から打てるが、選んだ値をユーザー設定（`~/.claude/settings.json` の `model` と `modelSettings.<モデル>.effortLevel`）へ既定として保存する。セッション限定にできるのはピッカーの `s` キーだけで、キー操作になる
- キャッシュが温かく、現在のモデルが直前の応答を返したときは、`/model` が確認ダイアログ（「Switch model?」）を開いて `blocked` になる。キャッシュはモデルごとなので、切り替えた次の応答は会話全体を読み直す。`/effort` は 5.5 系ではキャッシュが残るので、ダイアログは出ない
- CLI は `PreModelSwitch` と `PostModelSwitch` の hook を呼ぶ。`PreModelSwitch` は `allow` を返すとダイアログを開かずに切り替わる。1 回の `/model` で 2 回呼ばれ、`to_model` は違うが `requested_model` は同じ。`source` は `command` / `picker` / `sdk` / `auto` / `resume`
- effort を明示していないセッションでモデルを切り替えると、effort はそのモデルの保存値へ動く。明示済みなら引き継がれる
- 結果は transcript の user 行（`<local-command-stdout>`）に残る。`/model` は `Set model to ...` か、取り消しなら `Kept model as ...`

ここに書いた形は Claude Code 2.1.327〜2.1.330 と Herdr 0.9.5 の実機で確かめた。

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

### モデルと effort の切り替え

- 会話を読める、待機中（`idle` / `done`）の Claude のペインだけ。hook を持つのは hwc から起動したペインだけで、それ以外（hwc 外で起動した Claude など）にも項目は出るが、キャッシュが温かいと確認ダイアログで止まり、確かめられずに失敗する（Consequences）。`POST /api/panes/:id/switch-model` が `{ model, effort }` を受け、BFF は起動のときと同じ候補（エイリアスと 5 段階）にあることを確かめてから、入力欄へ `/model <alias>` と `/effort <level>` を通常の送信として送る。コマンドに混ぜる値は候補にあるものだけで、キーは送らない
- 現在のモデルと同じ系統なら `/model` は送らない。モデルを変えるときは、effort が保存値へ動かないよう、画面に見えていた値でも必ず `/effort` を送る。順序はモデルが先
- モデルの確認ダイアログは、hwc の画面で確かめたものだけ hook が許可する。BFF が `claude/model-switch/<session id>.allow.json` に頼むエイリアスと期限（15 秒）を置いてから送り、`PreModelSwitch` の hook が `source` が `command` で `requested_model` が印と一致するときだけ `allow` を返す。印の無い切り替え（端末で打った `/model`、ピッカー、自動）は何も返さず、CLI の確認に任せる。ダイアログを閉じるために Enter は送らない
- モデルの完了は `PostModelSwitch` の hook が `<session id>.done.json` に解決済みのモデル id を書いて知らせる。すでにそのモデルのセッション（BFF の再起動や端末での切り替えで、transcript の画面とセッションのモデルがずれたとき）では、CLI は切り替えず hook も呼ばないが、`Set model to ...` は書くので、transcript のローカルコマンドの結果でも確かめる（取り消しの `Kept model as ...` は成功にしない）。effort の完了は同じく `Set effort level to <level>` で確かめる。どちらも 100ms 間隔で、モデルは 8 秒、effort は 5 秒まで待つ。確かめられなければ成功にしない
- 確かめられず、`agent_status` が `blocked` のままなら、BFF が開いたままの確認ダイアログを Esc で閉じる（hwc からは答えられないため）。ただし頼んでから新しい発言や応答待ちが transcript に現れていれば、確認ダイアログとは限らない（別のクライアントが発言して権限確認に入ったかもしれない）ので送らない。会話を読めないときも送らない。`blocked` でなければ何も送らない
- 切り替えた値は、次の応答が transcript に載るまでの間だけ、会話のスナップショットの `model` / `effort` を補い、etag も変える。応答が載ったら transcript の値が正になる。`/new` の後に備えて、起動時の指定の預かり（[起動](agent-launch.md)）も切り替えた値にする
- ペインごとに 1 本。重ねた要求は 409
- Claude は選んだ値をユーザー設定の既定にも保存する。hwc は止められず、UI に注記する（hwc の画面から起動するときは起動時に値を指定するので、hwc の起動には及ばない）

### 実行中の様子と使用量

- 段階（考えている・ツール実行中）は transcript から導く。現在のターンの起点（最後の prompt）より後ろの `api-request` と assistant の `requestRef`、`tool_use` と `tool_result` の `tool_use_id` を突き合わせる。ターンはファイルの位置で切り、時刻では切らない
- 生成速度と使用量は、同梱の mod が状態ディレクトリの `claude/live/<session id>.json` に書く。速度は `turn.step` の差分から推定した見えている出力の tok/s（pi の sidecar と同じ意味）、使用量は `$.session.usage()` の `{ tokens, window }`。速度は 2.5 秒より古ければ捨て、使用量は鮮度で捨てない
- 読めない版・形の違うファイルは無いものとして扱い、会話・段階・端末出力は止めない

### プロンプトキャッシュの期限

- 1h プロンプトキャッシュの期限は、CLI の statusline や mod ではなく、transcript の完了応答から導く。active branch の assistant のうち、`requestRef` が `repl_main_thread` の `api-request.id` に対応し、`message.stop_reason` があるものだけを使う。`<synthetic>` と `isApiErrorMessage: true` の行は、`stop_reason` があっても失敗として除く。起点は応答の `timestamp` ではなく、対応する要求の `timestamp`
- 応答の block が複数行に分かれていても、完了した要求ごとに 1 回だけ扱う。`message.usage.cache_creation_input_tokens` が正で、`cache_creation` がすべて 1h（`ephemeral_1h_input_tokens` が総数と一致し、`ephemeral_5m_input_tokens` が 0）なら、要求の `timestamp` から 1 時間を期限にする
- 書き込みが 0 で `cache_read_input_tokens` が正のときは、同じ会話・モデル・エフォートを追跡中で、要求の送信時点で期限内だったときだけ延長する。読取だけではどのキャッシュに当たったか分からないので、未確認・失効済みを 1h 扱いにしない
- 5m を含む書き込み、無キャッシュ、時刻や使用量を確かめられない完了応答、対応する `api-request` が読めない完了応答では、前の期限を取り下げる。失敗・中断・サブエージェント・別の枝は前の期限を変えない
- active branch の圧縮境界（`system` の `subtype: "compact_boundary"`）と圧縮要約（`isCompactSummary`）、`Set model to …` / `Set effort level to …` のローカルコマンド結果より前の期限は使わない。取り消し（`Kept model as …`）は変更にしない。応答で初めて分かったモデル・エフォートの変更でも、それ以前の 1h は延長しない。hwc の切り替えの補い（上の「モデルと effort の切り替え」）が有効な間も旧期限を返さない
- 期限はチャットのスナップショットに絶対時刻（Unix ミリ秒）だけを載せる。設定・更新・取り下げは etag に反映し、時間が進むだけでは etag を変えない。`/new` の画面リセット中と取得失敗時は出さず、セッションが変われば別の transcript から導き直す
- クライアントは入力欄のモデル・エフォートの隣に残り時間を出す。狭い幅では分（1 分未満は秒）に縮め、入力欄を 1 行に畳むセルではモデル詳細パネルだけに出す。時間はサーバー同期の時計から描画のたびに計算し、通信は増やさない

## Consequences

- 会話・段階・待ちの表示は transcript と hook の内部形式に依存する。版で形が変われば読めなくなり、端末出力や段階なしの表示へ戻る。理由は画面に出ない
- 待ちのカード・速度・使用量は hwc から起動したペインだけで出る。hwc の外で起動した Claude は会話だけになる
- ツール実行・thinking・サブエージェントは会話に出ない。圧縮済みセッションは要約の行が出ないまま前後が並ぶ
- Web からの回答は「質問を拒否したうえで、選んだ内容を次の発言として送る」ことになる。Esc と本文の送信は 1 つの操作ではない
- エイリアスは CLI が最新モデルへ解決するので、hwc はリリースごとの対応表を持たない。CLI がエイリアスや段階を変えたら hwc も更新する
- `--plugin-dir` を知らない古い CLI（2.1.265 未満）では hwc からの起動が失敗する。段階の導出は 2.1.327 以降を前提にする
- transcript は BFF と CLI が同じユーザー・同じホストで動いている前提
- モデルと effort の切り替えは、端末から素で起動する `claude` の既定のモデルと effort も書き換える。hwc の画面から起動するペインは起動時に値を指定するので、影響を受けない
- 切り替えの許可と記録は、hwc が `--settings` で渡す hook に依る。hook を持たないペイン（`PreModelSwitch` / `PostModelSwitch` を足す前に起動したペイン、hwc 外で起動した Claude）では、キャッシュが温かいと `/model` が確認ダイアログで止まり、8 秒待って確かめられずに失敗する（Esc で閉じる）。キャッシュが冷えていればダイアログが出ず、transcript の結果で確かめられて通る。hwc から作り直したペインから確実に使える
- `/effort` の結果の文言は CLI の版で変わり得る。変わると、切り替えは通るが hwc は確かめられず、端末で確かめるよう案内する
- 5.5 系以外のモデルでは `/effort` もキャッシュを切るので、確認ダイアログが開き得る。hook は `/effort` を許可しないため、確かめられずに失敗して Esc で閉じる
- 1h キャッシュの残り時間は、transcript に載った完了応答から導く目安で、次の要求がヒットする保証ではない。補助リクエストや transcript に結果が残らない操作は、次の応答まで反映しない。そのため実際より短くも長くも出得る。表示の更新も既存のチャット取得間隔に従う

## Alternatives

- **端末出力やスピナー行を解釈する**: TUI は自前で折り返し、ペイン幅と版に依存する。スマホの表示幅と端末幅も違う
- **ユーザーの `~/.claude/settings.json` に hook を足す**: hwc 外で起動した Claude にも効くが、ユーザーの設定を書き換える
- **CLI のモデルカタログのキャッシュを読む**: 版付きの名前が得られるが、公開形式ではなく、有無・鮮度・形式に依存する
- **版付きのモデル id や表示名の対応表を hwc に持つ**: リリースごとに更新が要り、既定が最新に追従しなくなる
- **transcript の `usage` とエイリアスから window を出す**: 呼び出しごとの値で文脈量と意味が違い、window も名前から決まらない（`--model haiku` の応答が 1M だった）
- **TUI のフォームをキー操作で再現して答える**: 汎用のキー入力を持たない方針に反し、タブの状態も読めない
- **確認ダイアログに Enter を送る**: 新しいキーを足し、ダイアログの文言を画面から照合する必要がある。hook の許可なら、hwc の確認を通った切り替えだけを許可でき、画面を解釈しない
- **ピッカーの `s` キーでセッション限定にする**: 既定を書き換えずに済むが、ピッカーのキー操作になる。スマホには矢印キーも無い
- **切り替えの後に、書き換わった既定を元へ戻す**: hwc がユーザーの `~/.claude` の設定を書き換えることになる。ユーザーの設定は書き換えない
- **`ConfigChange` の hook で既定の保存を止める**: `/model` の保存では呼ばれなかった
- **statusline や mod が書くキャッシュ情報を読む**: 端末の設定と CLI の版に依存し、hwc 外で起動した Claude では読めない。transcript には要求の時刻と `usage` が残るので、同じ記録から導ける
