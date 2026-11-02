# ADR 0011: スタイルは素の CSS と接頭辞付きクラス名で書く

- Status: Accepted
- Date: 2026-10-20
- Supersedes: [ADR 0006](0006-styling-css-modules.md)

## Context

ADR 0006 は Bun の CSS Modules 対応を前提にしていた。Bun 1.3.14 の HTML バンドル経由では、CSS Modules の import が未定義参照（`import_App_module is not defined`）となり実行時に壊れることを確認した。

## Decision

コンポーネントのスタイルは素の CSS に書き、クラス名はコンポーネント接頭辞（例: `hwc-`）で衝突を避ける。色は CSS 変数のトークンから参照する。

### ファイルの配置

- `src/client/styles/tokens.css`: トークン宣言。`:root`、テーマ別の `:root[data-theme="..."]`、画面幅で上書きする `--text-*` を置く。色リテラルを書いてよい唯一の場所。
- `src/client/styles/app.css`: リセット・レイアウト・コンポーネント。`:root` ブロックは置かない。

`src/client/main.tsx` は tokens.css → app.css の順に import する。

## Consequences

- CSS Modules によるスコープは得られないため、命名で衝突を避ける必要がある
- バンドラの挙動に依存せず、開発サーバーとビルドで同じ見た目になる
- トークンは tokens.css、画面は app.css を見る。2 ファイルの読み込み順に依存する規則は置かない
