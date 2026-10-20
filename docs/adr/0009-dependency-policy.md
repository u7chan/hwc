# ADR 0009: 外部依存は最小限に保つ

- Status: Accepted
- Date: 2026-10-20

## Context

npm のサプライチェーン経由の攻撃を避けたい。依存が増えるほど、監査・更新・脆弱性対応のコストも増える。

## Decision

新しい依存は、標準機能か自前実装で代替できない場合だけ追加する。lockfile をコミットし、`trustedDependencies` は安易に増やさない。

## Consequences

- 便利なライブラリを避けるため、実装量が増えることがある
- Markdown 描画や端末表示のような領域は、自前実装か依存追加かを都度判断する
