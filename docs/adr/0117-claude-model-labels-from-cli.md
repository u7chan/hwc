# ADR 0117: Claude のモデルラベルは CLI に問い合わせ、BFF で短時間キャッシュする

- Status: Accepted
- Date: 2026-11-21
- Amends: [ADR 0108](0108-claude-model-display-name.md) の「エイリアスは family 名だけにする（`opus` は `Opus`）。解決先の版は起動するまで分からないので、推測しない」

## Context

[ADR 0108](0108-claude-model-display-name.md) は、入力欄のチップを最初の応答まではエイリアス（`Opus`）、応答後は transcript のモデル id（`Opus 5.5`）で出し、作成ダイアログと設定画面もエイリアスの表示名にした。解決先の版は起動するまで分からないという前提だった。

しかし、作成ダイアログや設定画面で版を出すには、hwc 側に別の情報が要る。版付きの対応表は CLI のリリースごとに古くなり、起動結果から学習すると初回は版が出ず状態ファイルが増え、版付き id を候補にすると「既定は最新に追従する」という [ADR 0096](0096-claude-model-effort.md) の候補の決め方と衝突する。CLI のモデルカタログのキャッシュを読むのも、公開形式ではなく鮮度にも依存する。

Claude Code 2.1.328 の control protocol には `list_models` があり、Agent SDK の `supportedModels()` に相当する情報を返す。`--print --input-format stream-json` の一時プロセスに 1 行送るだけで、alias の `value`、解決先の `resolvedModel`、公式の `displayName` が得られる。推論リクエストは送らず、`--no-session-persistence` で transcript も残らない。この環境では約 1.5 秒だった。

## Decision

- 作成ダイアログと設定画面の静的なモデル表示に限り、CLI が解決した alias の表示名を使う。候補そのものは `CLAUDE_MODEL_ALIASES` のままで、[ADR 0096](0096-claude-model-effort.md) の候補取得は変えない
- BFF に `GET /api/model-labels?agent=claude` を置く。既存の `/api/models` とは分け、ラベルを読めなくても候補の取得と起動は止めない
- CLI には `--safe-mode --print --verbose --input-format stream-json --output-format stream-json --no-session-persistence` で `list_models` を送る。cwd はホーム、期限は 5 秒、`HERDR_` は継がない。`--bare` は通常の picker と候補が変わるため使わない
- 返すのは hwc が候補に持つ alias だけにする。`displayName` が版を含むときはそれを、含まないときは `resolvedModel` から導いた表示名を使う。読めない名前は出さず、その alias は family 名にフォールバックする
- ラベルは BFF のプロセスメモリだけに持つ。ファイルには保存しない。TTL は 5 分とし、`claude` の realpath / mtime / size が変わったら即座に捨てる。失敗は 30 秒だけ負キャッシュし、同時に来た取得は 1 回にまとめる
- 保存する既定は今まで通り `{ provider, id }` の alias のままで、ラベルは保存しない。ラベルは描画のたびに受け取った写しを使う
- 走行中ペインのチップとパネルは変えない。transcript にモデルが載るまでは起動時の alias で、`ⓘ` の注記も維持する。静的な選択 UI の版は「その時点の CLI の解決結果」で、セッションの確定値ではない
- CLI が更新された場合は次の取得で新しい版になる。モデルカタログだけが更新された場合は TTL で追従する。CLI がまだ知らないモデルは hwc も出さない

## Consequences

- 最初のメッセージの前に、作成ダイアログと設定画面で `Opus 5.5` のような版付きの名前を出せる。保存済みの既定も、いま起動すると解決される版で表示される
- 版は CLI の解決結果なので、hwc にリリースごとの表を持たない。CLI の更新で realpath / mtime が変われば、設定画面を開かなくても次の取得で新しくなる
- CLI のモデルカタログが古い間は、CLI の picker と同じく古い版が出る。hwc が先取りすることはない
- BFF の起動後と TTL 切れの最初の取得だけ約 1.5 秒かかる。ラベルは候補と別に読むため、選択肢は先に alias で描画でき、届いた時点で表示だけが変わる
- `list_models` を返さない古い CLI、`--safe-mode` を受けない版、出力形式が変わった版では、ラベルだけが出ない。候補・起動・会話は今まで通り動く
- キャッシュはプロセスメモリなので、BFF を再起動すると最初の取得だけ再び CLI を起動する。保存ファイルや移行は要らない
- `/api/models` は CLI を起動しないままなので、[ADR 0096](0096-claude-model-effort.md) の候補取得の性質は保たれる

## Alternatives

- **hwc にエイリアスと版の対応表を持つ**: 実装は 1 か所で済むが、CLI のリリースごとに更新が要り、実際に起動する版とずれる。[ADR 0108](0108-claude-model-display-name.md) で却下した案
- **起動したセッションから alias の解決先を学習する**: 初回は版が出ず、状態ファイルが増える。CLI を更新しても、次に起動するまで古い値が残る
- **版付きのモデル id を候補にする**: 版は固定されるが、既定が最新に追従しなくなり、[ADR 0096](0096-claude-model-effort.md) と衝突する
- **CLI のモデルカタログのキャッシュを読む**: 表示名は得られるが、公開形式ではなく、有無・鮮度・形式変更に依存する。[ADR 0108](0108-claude-model-display-name.md) で却下した案
- **`/api/models` の応答にラベルを混ぜる**: 往復は 1 回で済むが、候補の取得が CLI の起動に待たされ、[ADR 0096](0096-claude-model-effort.md) の「models エンドポイントは CLI を起動しない」も変える必要がある。表示だけの別口にした
- **設定画面を開いたときやボタンで手動更新する**: 設定を開かないと作成ダイアログが古いままになり、押すまで更新されない。CLI の realpath / mtime と TTL で自動的に更新する方が、ユーザーが CLI の更新を知らなくても済む
- **ラベルが届くまで候補の描画を待たせる**: 1.5 秒の間、選択肢が出ない。alias はそのまま選べるので、待たせない
