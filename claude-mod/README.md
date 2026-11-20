# hwc-live-rate

hwc が Claude Code のペインに出す「生成中の tok/s」と、入力欄に出すコンテキスト使用量を書くための mod。hwc だけが使う。

hwc は起動時に `--plugin-dir` でこのディレクトリを渡し、設定ファイルの `env` で
`HWC_CLAUDE_LIVE_DIR` を渡す。mod は `turn.step` のストリームから見えている出力の
トークン数を推定し、500ms ごとに `<dir>/<session id>.json` を上書きする。phase や本文は
transcript から導くので、このファイルは速度と使用量だけを持つ。環境変数が無い（hwc 以外が
起動した）ときは何もしない。

使用量は `session.start` と `turn.complete` で `$.session.usage()` から読む。値は CLI の
`/context` と同じ計算で、`window` は CLI が解決したモデルの context window（200k のモデルも
1M のモデルもある）。hwc はモデル別の表を持たない。読めない版では使用量を書かないだけで、
速度と会話はそのまま動く。

速度の数値は「画面に流れている出力」の推定で、API の `usage.output_tokens` とは一致しない。
first-party の thinking は本文が流れないため、請求上の output より小さくなる。
