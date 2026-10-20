# ADR 0001: Bun を runtime・bundler・test runner に採用する

- Status: Accepted
- Date: 2026-10-20

## Context

BFF と client の両方を扱うローカル Web アプリで、npm サプライチェーンへの懸念から依存を最小にしたい。開発サーバー、バンドラ、テストランナーを個別に揃えると依存が増える。

## Decision

Bun を runtime、package manager、bundler、開発サーバー、test runner として使う。開発からビルドまでが単一ツールで完結し、追加依存を最小にできるため。

## Consequences

- コンポーネント単位の Fast Refresh は使えず、開発中の編集はフルリロードになる
- Node.js との互換性は部分的で、Bun 固有 API に寄る箇所ができる
- `bun install` は未信頼の依存の postinstall を既定で実行せず、サプライチェーン上は有利（ただし Bun が許可する組み込みのパッケージは例外）

## Alternatives

- Node.js + Vite + vitest: HMR と Fast Refresh は得られるが、推移依存が大きく増える

## References

- [ADR 0009](0009-dependency-policy.md)
