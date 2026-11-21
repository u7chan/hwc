# 外部依存は最小限に保つ

- Status: Accepted

## Context

npm サプライチェーン経由の攻撃を避けたい。依存が増えるほど、監査・更新・脆弱性対応のコストも増える。

## Decision

新しい依存は、標準機能か自前実装で代替できない場合だけ追加する。lockfile をコミットし、`trustedDependencies` は安易に増やさない。外部 CDN からも読み込まない（フォントやアイコンは同梱する）。

## Consequences

- 便利なライブラリを避けるため、実装量が増えることがある
- Markdown 描画や端末表示のような領域は、自前実装か依存追加かを都度判断する。判断の例は [client の描画](client-rendering.md) と [同梱フォント](bundled-fonts.md)
