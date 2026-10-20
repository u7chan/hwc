# ADR 0006: スタイルは素の CSS と CSS Modules で書く

- Status: Superseded
- Date: 2026-10-20

## Context

画面数が少なく、デザインは自前で組む。CSS フレームワークは依存とツール統合のコストを伴う。

## Decision

素の CSS + CSS 変数（トークン）+ CSS Modules を使う。Bun が `*.module.css` をネイティブに扱うため、追加依存なしでスコープを確保できる。

## Consequences

- ユーティリティクラスは無く、スタイルは各コンポーネントの CSS に書く
- デザイントークンは CSS 変数として自前で管理する

## Alternatives

- Tailwind CSS: 依存が増え、Bun のバンドラではプラグインが必要
- StyleX: `@stylexjs/unplugin` が必要で、この規模では利点を回収できない

## Superseded by

- [ADR 0011](0011-styling-plain-css.md)
