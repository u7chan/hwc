# UI の日本語フォントと Nerd Font の記号を同梱する

- Status: Accepted

## Context

hwc の画面は iOS Chrome と Windows のブラウザが主になる。日本語の UI フォントを OS 任せにすると、iOS は Hiragino Sans、Windows は Yu Gothic UI になり、字幅と字形が変わる。

Herdr のペイン出力は Nerd Font 由来のアイコンを PUA（`U+E000-F8FF` と `U+F0001-F1AF0`、ほかに `U+23FB` 付近の数点）で含む。ブラウザの等幅フォントはこれらを持たず、ペイン出力とラベルが `▯` になる。hwc は WSL2 で動き、画面は Windows 側のブラウザで開くので、WSL2 側にフォントを入れても参照できない。ブラウザには fontconfig 相当のフォールバック設定も無い。

## Decision

- Noto Sans JP の可変フォントを woff2 で同梱し、`--font-ui` の先頭に置く。`font-weight: 100 900` の 1 本で UI の太さを賄い、読み込めない環境は OS 標準へ落とす。等幅は変えない
- Nerd Fonts の `SymbolsNerdFontMono` を woff2 で同梱し、`--font-mono` の末尾（generic `monospace` の直前）に足す。先頭に置くと本文まで記号フォントで組まれる。`unicode-range` で PUA に限り、アイコンを含まない画面では取得しない。適用先は `--font-mono` だけ
- どちらも `@font-face` は `tokens.css` に置き、`font-display: swap` にする
- 生成コマンドとライセンスは `src/client/assets/fonts/` の `NOTICE.md` とライセンスファイルに置く

## Consequences

- 初回の取得が増える（Noto Sans JP は約 4.2MB、記号フォントは約 1.1MB）。LAN 内の配信とブラウザのキャッシュを前提に許容する
- 記号フォントは Mono 版で全グリフが 1em 幅になり、アイコン同士の幅は揃うが、本文の等幅（約 0.6em）とは揃わない
- `--font-ui` の面（利用者が付けたラベルなど）に PUA が入っても記号フォントでは描かない

## Alternatives

- **OS 標準フォントだけ**: 追加取得は無いが、iOS と Windows で字幅・字形が変わる
- **Google Fonts の CDN**: 同梱は要らないが、LAN 外への通信と可用性に依存する（[依存の方針](dependency-policy.md)）
- **fontsource のサブセット**: Bun の HTML バンドルが小さな woff2 を CSS に base64 で埋め込み、初回 CSS が 7MB になった
- **サブセットを自前で作る**: 初回取得は減るが、珍しい漢字や削った面のアイコンが豆腐になる
- **PUA を ASCII に置換する**: 環境に依存しないが、アイコンの意味が落ち、未マップのグリフは豆腐のまま
