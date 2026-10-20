# ADR 0011: スタイルは素の CSS と接頭辞付きクラス名で書く

- Status: Accepted
- Date: 2026-10-20
- Supersedes: [ADR 0006](0006-styling-css-modules.md)

## Context

ADR 0006 は Bun の CSS Modules 対応を前提にしていた。Bun 1.3.14 の HTML バンドル経由では、CSS Modules の import が未定義参照（`import_App_module is not defined`）となり実行時に壊れることを確認した。

## Decision

コンポーネントのスタイルは素の CSS に書き、クラス名はコンポーネント接頭辞（例: `hwc-`）で衝突を避ける。色は CSS 変数のトークンから参照する。

## Consequences

- CSS Modules によるスコープは得られないため、命名で衝突を避ける必要がある
- バンドラの挙動に依存せず、開発サーバーとビルドで同じ見た目になる
