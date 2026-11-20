# hwc-live-rate

hwc が Claude Code のペンに出す「生成中の tok/s」を書くための mod。hwc だけが使う。

hwc は起動時に `--plugin-dir` でこのディレクトリを渡し、設定ファイルの `env` で
`HWC_CLAUDE_LIVE_DIR` を渡す。mod は `turn.step` のストリームから見えている出力の
トークン数を推定し、500ms ごとに `<dir>/<session id>.json` を上書きする。phase や本文は
transcript から導くので、このファイルは速度だけを持つ。環境変数が無い（hwc 以外が起動した）
ときは何もしない。

数値は「画面に流れている出力」の推定で、API の `usage.output_tokens` とは一致しない。
first-party の thinking は本文が流れないため、請求上の output より小さくなる。
