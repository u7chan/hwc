# ADR 0100: Claude の実行中の段階は transcript の進行行から出す

- Status: Accepted
- Date: 2026-11-19
- Amends: [ADR 0035](0035-live-pi-activity.md) の「実行中の段階は pi 拡張の sidecar からだけ読む」という前提
- Amended by: [ADR 0102](0102-claude-live-tok-rate.md)（生成中の `tokPerSecond`）

## Context

Claude の会話は [ADR 0097](0097-claude-chat-transcript.md) のとおり transcript の JSONL を射影して読む。しかしターン中は `working` と経過時間しか出せず、分単位で終わらないターンで「止まっているのか」「方向が違うのか」がスマホから分からない。TUI を見れば分かるが、スマホで TUI を読むのはつらい。

transcript は API の応答が終わるまで assistant の本文を書かない。ただし進行の手掛かりは、応答の前後に別の行として書かれる。ローカルの transcript 21 本（entry の `version` は 2.1.314〜2.1.328 が混在）で確認した形は次のとおり。

- `api-request` は API の要求を出した時点で書かれる。`id`、`timestamp`、`querySource`（`repl_main_thread` / `sdk`）を持つ。応答の assistant entry は `requestRef` に同じ id を持つ。`api-request` 326 件のうち 325 件に一致する assistant があり、残る 1 件は応答の無い要求だった
- assistant の `tool_use` は応答の終了時に、`user` の `tool_result` はツールの終了時に書かれる。`tool_use.id` と `tool_result.tool_use_id` が対応する。`tool_result` は失敗のとき `is_error` を持つ
- assistant は `isSidechain` を持つ。手元の 21 本では true は無かったが、形式としてはサブエージェントの分が同じファイルに混ざり得る
- 応答の無い `api-request`、結果の無い `tool_use`、`requestRef` を持たない `isApiErrorMessage` の assistant が残ることがある（中断・失敗）
- 同じ assistant message の `tool_use` が複数 entry に分かれて並ぶことがある（並列ツール）
- thinking は 240 件のうち本文があるのは 24 件（10%）だけ。first-party の API は生の thinking を返さない。`showThinkingSummaries` が true のときだけ要約が返り、thinking ブロックの終了時に書かれる
- TUI は thinking の本文を描かない。作業中はスピナー行（`✻ Working… (7s · ↓ 960 tokens · thinking with high effort)`）と、終わったあとの `Thought for 9s` だけ（TUI の見え方は実機で確認した）

制約は次のとおり。

- hwc の主な利用端末はスマホ（iOS Chrome）で、ペインの端末幅は hwc の表示幅と関係がない
- Claude Code の TUI は自前で折り返して描く。ペインを 45 桁にすると同じ文が 3 行に折り返され、`pane.read` の `recent-unwrapped` で読んでも戻らない。TUI の字は版で変わる
- 会話のスナップショット（`GET /api/panes/:id/chat`）に進行を混ぜると、差分のたびに `etag` が動いて 304 の意味が壊れる（[ADR 0035](0035-live-pi-activity.md)）
- first-party の生の推論は取れない。方向として使えるのは、直近の assistant 本文と、transcript に載っている thinking の本文（要約、または 3P の provider が残す生の thinking）だけ

## Decision

### 現在のターンと枝

- 現在のターンの起点は、[ADR 0097](0097-claude-chat-transcript.md) の active branch にある最後の prompt（利用者の発言になる `user` entry。`tool_result` だけの entry、`isMeta`、圧縮要約、ローカルコマンドの記録を除く）のファイル位置とする。画像だけの発言も prompt に含める（会話の行にならなくても、ターンの起点にはなる）
- 段階は Herdr が `working` の間だけ返す。rewind の直後は `idle` なので、新しい prompt がまだ書かれていなくても、旧枝の未完了イベントは表示されない
- BFF はペインごとに、`turnObserved`（このターンの prompt を見たか）と `lastPrompt`（直近に観測したターンの起点 prompt の uuid）を持つ。ペインとセッションをキーにし、永続化しない
- 遷移の規則: idle / done / unknown → working で `turnObserved = false`、`lastPrompt` は保つ。blocked → working は同じターンなので `turnObserved` を保つ。初回観測・新規ペイン・BFF 再起動は `turnObserved = false`、`lastPrompt = null`。idle / done / unknown へ移ったら `turnObserved` を false に戻す（blocked では戻さない）
- ターンの最初の取得（`turnObserved = false`）で、transcript の最後の prompt の uuid が `lastPrompt` と同じなら、新しい prompt がまだ書かれていないとみなして `null` を返す。違えば `turnObserved = true` にし、`lastPrompt` をその uuid に更新して段階を返す。`lastPrompt` が null のときは比較だけ飛ばし、`turnObserved = true` と `lastPrompt = uuid` にして進める（途中から観測）
- `turnObserved = true` の後の取得は、時刻を見ずにそのまま段階を返す。blocked を挟んでも同じターンとして扱う
- prompt の識別には uuid を使う。同じ文を送り直しても新しい entry になるので、文面では比べない
- prompt を書かないターン（TUI の `/compact`）は、最後の prompt が前のターンのままなので `null` になる。hwc の `/compact` は既存の圧縮表示があるが、TUI から打った場合は帯が空になる（既知の制限）
- 段階に使う `tool_use` と `api-request` は、起点より後ろの行をファイル順に全部見る。枝では絞らない
- 枝で絞らないのは、並列ツールの `tool_use` が一時的に親鎖の外へ出るため（片方の結果が書かれた時点の葉から辿ると、まだ実行中のツールの行が外れる）。`tool_result` も枝に載らないことがある。対応は `tool_use_id` と `requestRef` の一致だけで取る
- 方向に使う assistant の text / thinking は、active branch 上で起点より後ろの行だけを使う。rewind で捨てた枝の文章を混ぜないため
- 起点より前の要求・ツールは、現在のターンのものではないので使わない
- 時刻ではなくファイルの位置で切る。rewind は捨てた枝を書き終えてから新しい prompt を追記するので、起点より後ろに旧枝の要求・ツールは現れない（追記型の前提）

### 段階

- `tool`: 起点より後ろの `tool_use`（`isSidechain` を除く）のうち、`tool_use_id` が一致する `tool_result` がまだ無いものがある。`tool` はそのうち最後のものの名前、`tools` は件数（1〜99）。`at` は取得時刻
- `thinking`: 未完了のツールが無く、起点より後ろの最後の `api-request`（`querySource === "repl_main_thread"`）に、`requestRef` が一致する assistant entry がまだ無い。`at` は取得時刻。[ADR 0035](0035-live-pi-activity.md) の `waiting` ではなく `thinking` にするのは、hwc の利用者に見せる字を「考えています」に揃えるため。要求中は考えている最中と回答の生成中を区別できないので、まとめて `thinking` とする
- 最後の `api-request` のあとに `isApiErrorMessage` の assistant があれば、その要求は終わったものとして扱う。エラー行は `requestRef` を持たないため
- 結果側の形も確かめる。未完了と判定したツールのあとに `tool_use_id` を持たない `tool_result` があれば、それが対応する結果かもしれないので判定不能にする。未応答と判定した要求のあとに `requestRef` を持たない assistant（`isApiErrorMessage` を除く）があれば、同じく判定不能にする
- 応答がまだ無い要求・結果がまだ無いツールは、判定不能ではなく未完了として出す。未完了と判定不能の区別は次のとおり
  - 開始側（`api-request` / `tool_use`）に ID があり、その entry の `version` が 2.1.327 以降なら、応答が無いのは未完了（[ADR 0097](0097-claude-chat-transcript.md) と同じ版の前提）
  - ID が空、`version` が 2.1.327 より前、または行が読めないなら判定不能として `null`
- どちらでもなければ activity を返さない（`null`）。ターンが終わると Herdr の状態が `idle` になり、クライアントは読まない
- `at` は取得のたびに作る値なので、取得時刻（`now`）を入れる。段階の開始時刻は出さない。古い未完了イベントはターンの起点で除くので、[ADR 0035](0035-live-pi-activity.md) の 30 分の上限は derived な値には効かせない（`at = now` なのでクライアントの 30 分の検証は常に通る）
- 未完了のツールと未応答の要求が同時に成立したときは `tool` を優先する。CLI はすべての結果が揃うまで次の要求を出さないので通常は起きない。起きたら具体的な作業を出す
- サブエージェント（`isSidechain`）の行と `querySource !== "repl_main_thread"` の要求は、段階の判定に使わない

### 方向

- `text` に、active branch 上で起点より後ろの最後の assistant の text（`isApiErrorMessage` と sidechain を除く）の先頭 1 行を入れる。90 文字を超えたら末尾を落とす。text が無ければ、同じ範囲の最後の thinking の本文の末尾を入れる
- thinking の本文は、設定による要約のことも、3P の provider が残す生の thinking のこともある。区別せず、transcript に載っている文をそのまま使う。first-party の生の thinking は取れない。`showThinkingSummaries` を有効にするかはこの ADR で決めない（下の「Why not」）
- `tool` のときは、1 行目にツールの対象、2 行目に方向を入れる。狭い画面では上側が切られるので、方向を 2 行目に置く。折り返しで 2 行に収まらないときは、CSS が上を切るので方向の末尾が残る（先頭が切れることは許容する）。対象は Bash なら `input.description`、Read / Edit / Write / Grep / Glob なら `input.file_path` の basename、Task なら `input.description` にする（サブエージェントの待ちが最も長いため）。Grep / Glob は手元に実例が無いので、`file_path` が無ければ対象を出さない。それ以外のツールも対象を出さない。ツール名の大文字小文字は無視して照合する
- 対象は 60 文字、方向は 90 文字を上限にする。改行と制御文字は 1 行に畳む。`input.description` と thinking の本文はモデルが書いた文なので、会話の本文と同じ扱いで出す。コマンドの本文（`input.command`）は出さない。ツール名は `TOOL_NAME_LIMIT`（64 文字）で切る
- 対象が空なら方向だけ、方向が空なら対象だけを入れる
- 既存の `activitySnippet` は末尾 2 行・160 文字を採る。上限を 60 + 90 にしておけば、2 行が切られずに収まる

### 取得口

- `GET /api/panes/:id/activity` を Claude にも返す。pi は従来どおり sidecar、Claude は transcript から導出した値を返す
- 形は `PaneActivity` のままにする。`phase`、`text`、`tool`、`tools`、`at` を使い、`tokPerSecond` は入れない
- `src/shared/activity.ts` の `text` の条件を `thinking` と `tool` に広げる。pi の書き手は `tool` のとき `text` を書かないので、pi の表示は変わらない
- クライアントは `pane.agent === "pi" || pane.agent === "claude"` かつ `pane.chat` の間、取得の effect を生かしたままにする。見えていて `working` の間だけ 1 秒ごとに読み、`blocked` の間は読まずに保持値を捨てる。blocked で effect を外すと、同じターンに戻ったときに古い段階が最初の取得まで残るため
- 経過時間は既存の帯の値（Herdr が `working` を観測した起点）をそのまま使う。段階ごとの秒は出さない
- transcript はチャットの射影と同じ読み取りに相乗りし、path + size + inode が同じなら使い回す。ターン中は行が増えるたびに読み直すが、ポーリングのたびには読まない
- 現行の `claude.ts` は `uuid` を持たない `api-request` を捨て、`requestRef` も保持していない。射影に `api-request`（id / querySource / timestamp / version）、assistant の `requestRef`、`tool_use` の id・name・input、`tool_result` の `tool_use_id`・`is_error` を残し、`SessionChatClient` に activity を引く口（例: `activity(sessionId)`）を足す。`ctx.claude` が optional のときは `activity: null`
- `GET /api/panes/:id/activity` の応答に `session`（ペインが指す会話の id。path は渡さない。pi は null）を足す。クライアントは保持している値の `session` と比べ、変わっていれば捨てる。BFF の状態取得は `working → idle → working` をまとめることがあるため、状態の遷移だけではセッションの切り替えを検知できない
- ターン中に `activity: null` が返っても、クライアントは Claude のときだけ直前の `PaneActivity` をそのまま保つ。pi の契約（sidecar が無い・壊れた・古いときは出さない）は変えない
- 保つのはターンが終わる（`working` を離れる）、ペインを離れる、blocked になる、`session` が変わる、最後に非 null を得てから 10 秒経つ、まで。同じペインで新しいターンが始まれば、最初の取得で置き換わる
- 帯の thinking の枠は、Claude の通常セルではターン中ずっと確保する。最初の activity が届く前も 2 行分を空け、届いた時点で高さが動かないようにする。compact のセルは [ADR 0035](0035-live-pi-activity.md) のまま枠を出さない。hwc 自身の `/compact` の表示中も枠を出さない。圧縮は段階ではなく、方向の空きを残しても埋まらないため

### 読めないとき

- 16MB の窓の外に落ちた行は参照できない。ターンの起点が窓の外なら、判定不能として `null` を返す。推測しない
- 開始側の ID が空、`version` が 2.1.327 より前、結果側の ID が無い形式、その他の形式変更のときも `null`
- 末尾の書きかけの行は捨てるだけで、`null` にはしない（[ADR 0097](0097-claude-chat-transcript.md) と同じ）
- `null` でも会話と端末出力は止めない。`activity` が無いペインは、pi は従来どおり 3 点と経過時間だけ、Claude の通常セルは空の 2 行枠を保つ

## Why not

- **TUI の画面を読む**: 折り返しで崩れ、ペイン幅と CLI の版に依存する。スマホの表示幅と端末幅は違う
- **hooks で sidecar を書く**: `--settings` でフックを足せばツールの開始・終了は取れるが、hwc が起動していないペインでは動かず、フックの実行環境に依存する。transcript だけで段階は足りる
- **会話のスナップショットに混ぜる**: `etag` が差分のたびに動き、304 の意味が壊れる（[ADR 0035](0035-live-pi-activity.md)）
- **`/live` の型と取得口を新しく足す**: 段階・方向・ツール名は `PaneActivity` に収まる。ポーリング・検証・中断の扱いを二重に持たない
- **時刻でターンを切る**: 時計のずれや rewind の枝を混ぜる。ファイルの位置で切る。`workingSince` は blocked で消えるので、ターンの判定には使わない
- **`last-prompt` を使う**: transcript の `last-prompt` は葉の uuid を記録する行で、prompt そのものではない。ターンの起点は active branch の prompt を使う
- **BFF がターン中の最後の値を返す**: 保持のためだけに BFF にターン状態を増やし、`null` の理由（読めない・形式変更）を隠す。クライアントの短い保持で足りる
- **現在のターンの外の未完了イベントを使う**: 中断した前のターンの要求やツールが、次のターンに「考えています」として残る
- **経過時間で「止まっている」と判定する**: 思考もツールも分単位が正常で、誤警報になる。段階の切り替わりと方向を見せるだけにする
- **スピナー行からトークン数を取る**: 狭いペインで折り返す。まず段階と方向で足りるか見る
- **`showThinkingSummaries` をこの ADR で有効にする**: 起動引数とユーザーの CLI の表示を変える別の判断。この ADR は、transcript に thinking の本文が載っているときだけ方向に使う

## Consequences

- 段階の切り替わりは、transcript の書き込みと同じ遅れ（実測 1〜2 秒）にポーリングの 1 秒が加わる。1 つの API 呼び出しの中の進み（トークン数）は分からない
- 応答本文は応答の終了後にしか書かれないので `writing` は出せない。要求中の段階は `thinking` にまとめる
- ターンの最初の要求中は、まだ assistant の text も thinking も書かれていないので方向は空になる。その間は段階と経過時間だけを出し、通常セルの 2 行の枠は空けたままにする
- thinking の本文は thinking ブロックの終了時に書かれるので、それを方向に使うときは 1 ステップ遅れる。本文が無いペインでは、方向は最後の assistant 本文だけになる
- thinking の本文は要約とは限らない。3P の provider が生の thinking を残すことがある。どちらも「transcript に載っている文」として出す
- `tool_use` の `timestamp` は応答の終了時に書かれた時刻で、ツールの開始時刻そのものではない。段階の開始は出さないので、表示には使わない
- `api-request` などの行は CLI の内部形式。版が変わって読めなくなると段階は出なくなる（開始側の ID と `version` で判定不能にする）。会話は [ADR 0097](0097-claude-chat-transcript.md) の範囲で読める限り続く
- サブエージェントの動きは出ない。本流だけを映す
- ターン中は 1 秒ごとに `stat` し、行が増えたときだけ transcript を読み直す。大きなセッションでは、チャットの射影と同じ読み直しのコストがかかる
- 帯の thinking は、Claude だけ、ターン中に段階が一瞬取れない間も直前の `PaneActivity` 全体（段階・方向・ツール名・件数）を保つ。最後に非 null を得てから 10 秒経ったら捨てる。pi は変えない
- Claude の帯は、最初の activity が届く前も thinking の 2 行分を空ける。狭い画面では対象の行が切られ得るが、方向は 2 行目に置くので末尾が残る
- hwc がターンの途中から観測を始めたペイン（BFF の再起動、あとから開いたペイン、`lastPrompt` が無いペイン）は、比べる相手が無いので観測済みとして進める。前のターンの未完了イベントが残っている場合は、それが数百 ms 出ることがある
- スナップショットが `idle → working` をまとめて観測すると `turnObserved` が true のままになり、比較は走らない。そのターンは前のターンの起点のまま段階を出す（新しい prompt は起点にならない）。最後の未完了イベントが古い場合は、それが数百 ms〜数秒出ることがある
- 画像だけの発言でもターンの起点になる。会話の行にはならないが、段階の判定には使う
- thinking の本文があるのはローカルの 240 件のうち 24 件（10%）で、その多くは `showThinkingSummaries` が有効な環境の要約だった。既定の first-party では方向が最後の assistant 本文だけになる
- `showThinkingSummaries` は変えない。hwc から起動したペインでも、thinking の本文はユーザーの設定と provider に従う
- 実装と同じ変更で、`docs/agents.md` の activity の表と Claude の要点を直す。ADR 0035 には `Amended by: 0100` を足した
- 帯の文言は 0035 の `waiting`（「応答を待っています」）ではなく `thinking`（「考えています」）を使う。要求中の思考と生成は区別できないため、まとめて `thinking` とする

## テスト

- unit（BFF の状態）: idle / done / unknown → working で `turnObserved = false`、blocked → working で保つ、初回観測・新規ペイン・再起動で `lastPrompt = null`、idle / done / unknown へ移ったら `turnObserved = false`（blocked では戻さない）。最後の prompt が `lastPrompt` と同じ間は `null`、変わったら進む。`lastPrompt = null` から進んだ次のターンは比較される
- unit（BFF）: 要求と応答の対応、`isApiErrorMessage` での打ち切り、並列ツールの代表と件数、片方の結果だけが書かれた時点でも未完了のツールを落とさない、枝の外にある並列 `tool_result` との対応、結果側に ID が無い形式での `null`、sidechain の除外、ターンの起点（rewind・中断した前のターン・画像だけの発言）、`version` が古い / ID が空のときの `null`、16MB の窓で切れたときの `null`、`text` の 60 / 90 文字と 1 行化、`tool` の `text` を通す正規化
- unit（client の純関数）: Claude だけ直前の `PaneActivity` を保つ判定（null を挟んでもターン中は保ち、終了・移動・blocked・`session` の変更・10 秒の経過で捨てる）、2 行の組み立てと優先順位、compact のセルと `/compact` 中は枠を出さない
- E2E: 架空 Herdr の Claude fixture で、まず `working` にして新しいターンの null の窓（帯の空枠）を確かめ、次に prompt → `api-request` → `tool_use` を追記して段階と方向が帯に出ることを確かめる。`null` を挟んだ後は 10 秒の保持で確かめる。blocked と終了で消えること、`/compact` の表示中は枠が出ないことも見る（[docs/e2e.md](../e2e.md)）
