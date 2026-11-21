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

## Alternatives

- **端末出力を解釈する**: 上の Context のとおり、本文も話者もモデルも安定して取れない
- **SQLite などに会話を取り込む**: 正が 2 つになり、同期と移行を持つことになる
- **sidecar の代わりに TUI の thinking を読む**: 常用環境では `hideThinkingBlock` で隠しており、画面の解釈にも戻る
- **編集で TUI のキー操作（`/tree`）を送る**: ピッカーを閉じる保証が無く、汎用のキー入力を持たない方針に反する
- **pi に HTTP エンドポイントを立てる**: BFF から pi のプロセスへ直接要求する経路が増え、Herdr のペインとの対応が二重になる
- **拡張の `project_trust` イベントから BFF へ問い合わせる**: 拡張の注入と起動時の待ち合わせが要り、既知の 1 画面には過剰
