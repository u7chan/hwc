# ADR 0023: UI フォントは Noto Sans JP を同梱する

- Status: Accepted
- Date: 2026-11-04

## Context

hwc の画面は iOS Chrome と Windows のブラウザが主になる。日本語の UI フォントは OS 任せで、iOS は Hiragino Sans、Windows は Yu Gothic UI になり、字幅と字形が変わる。参照した Herdr Web クライアントは Noto Sans JP を先頭に置いていた。

## Decision

- Noto Sans JP の可変フォント（v2.004）を woff2 にして `src/client/assets/fonts/NotoSansJP-Variable.woff2` として同梱する（4.2MB）
- `@font-face` は `tokens.css` に置き、`--font-ui` の先頭に `"Noto Sans JP"` を置く。読み込めない環境は OS 標準へ落とす
- `font-weight: 100 900`、`font-display: swap`。UI の 400 / 600 / 700 を 1 本で賄う
- 等幅は変えない。日本語コードは Windows の BIZ UDGothic、iOS はシステムの等幅フォールバック
- 生成コマンドとライセンスは `src/client/assets/fonts/NOTICE.md` / `NotoSansJP-OFL.txt` に置く

## Consequences

- 初回表示で 4.2MB のフォントを取得する（LAN 内・ブラウザキャッシュ前提）。2 回目以降はキャッシュから読む
- 英数字も Noto Sans JP になる。システムフォントより字幅が変わるため、名前の省略位置などが変わる
- 日本語の見た目が OS に依存しなくなる
- フォントを更新するときは woff2 と NOTICE のバージョンを同時に更新する

## Alternatives

- **OS 標準フォントだけ**: 追加取得は無いが、iOS と Windows で字幅・字形が変わる
- **Google Fonts の CDN**: 同梱不要だが、LAN 外への通信と可用性に依存する
- **fontsource のサブセット**: 必要な文字の分だけ落とせるが、Bun の HTML バンドルが小さな woff2 を CSS に base64 で埋め込み、初回 CSS が 7MB になった。回避には配信経路の追加が要る
- **サブセットを自前で作る**: 初回取得は減るが、任意の日本語（珍しい漢字）が豆腐になる
