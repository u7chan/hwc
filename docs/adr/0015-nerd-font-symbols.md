# ADR 0015: Nerd Font のアイコンは記号専用フォントを同梱して描く

- Status: Accepted
- Date: 2026-11-03

## Context

Herdr のペイン出力は Nerd Font 由来のアイコンを PUA（`U+E000-F8FF` と `U+F0001-F1AF0`、ほかに `U+23FB` 付近の数点）で含む。ブラウザの等幅フォントはこれらを持たないため、ペイン出力とペインのラベルは `▯` になる。確認した例は `U+E60B` / `U+E672` / `U+F418`。

hwc は WSL2 で動き、画面は Windows 側のブラウザで開く。WSL2 側でフォントを導入しても Windows のブラウザからは参照できず、ブラウザには fontconfig 相当のフォールバック設定も無い。そのため `font-family` に Nerd Font を足すだけでは解決しない。

## Decision

- Nerd Fonts v3.5.1 の `SymbolsNerdFontMono-Regular.ttf` を woff2 にして `src/client/assets/fonts/NerdSymbolsMono.woff2` として同梱する（1.1MB）。生成コマンドとライセンスは同じディレクトリの [NOTICE.md](../../src/client/assets/fonts/NOTICE.md) / [LICENSE](../../src/client/assets/fonts/LICENSE) に置く
- フォントは Mono 版を使う。全グリフが 1em 幅で、等幅の桁揃えを崩さない
- `@font-face` は `tokens.css` に置き、family 名を `--font-mono` の末尾（generic `monospace` の直前）に足す。先頭に置くと本文まで記号フォントで組まれる
- `unicode-range` で PUA の範囲に限定する。PUA を描くまで取得しないので、アイコンを含まない画面では 1.1MB を落とさない
- `font-display: swap`。アイコンは本文の意味を持たないので、読み込み待ちで止めない
- 適用先は `--font-mono` だけ。ペインのラベルなど `--font-ui` の面は Herdr の利用者が付けた文字で、TUI の出力ではない

## Consequences

- ペイン出力のアイコンが豆腐にならず、端末で見た形に近づく。フォント未導入の Windows でも同じ
- 記号フォントの 1 グリフは 1em 幅で、等幅本文の 1 文字（約 0.6em）より広い。アイコンを含む行は端末より横に伸びる。Powerline の帯（`U+E0B0` など）が連続する行は、その行だけ幅が変わる
- アイコンの色は `currentColor` になる。ANSI の色付けは #5 の範囲
- 初回にアイコンを描いた時点で 1.1MB を取得する（LAN 内・ブラウザキャッシュ前提）
- Nerd Fonts を上げるときは woff2 と `unicode-range` を同じ集合で作り直す。`styles.test.ts` が family・範囲・ファイルの存在を見張る
- 未対応の記号はどのフォントにも無いので、そのときだけ `▯` が残る

## Alternatives

- **既存の Nerd Font を `font-family` に足す**: Windows 側にフォントが無い環境では解決しない。同梱するなら結局この案に戻る
- **PUA を ASCII に置換して表示**: 環境に依存しないが、アイコンの意味（状態・種別）が落ち、未マップのグリフは豆腐のまま
- **サブセット生成で小さくする**: MDI 面（`U+F0001-F1AF0`）を削ると約 0.5MB 減るが、その面のアイコンを使う TUI で豆腐が戻る。LAN 内の配信とキャッシュを前提に、全グリフを残す
- **`unicode-range` を書かずに常時読み込む**: 実装は 3 行減るが、アイコンを含まない画面でも 1.1MB を落とす
