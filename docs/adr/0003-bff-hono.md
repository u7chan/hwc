# ADR 0003: BFF に Hono を使い、RPC で型を共有する

- Status: Accepted
- Date: 2026-10-20

## Context

ブラウザから Herdr のソケットへ直接接続できないため BFF が要る。client と BFF の型を二重管理したくない。

## Decision

BFF に Hono を使い、`hc` による RPC で JSON エンドポイントの型を client と共有する。Hono は依存を持たず、依存最小化の方針と衝突しないため。

## Consequences

- 型共有は JSON エンドポイントに限られ、SSE と WebSocket は対象外になる
- RPC はランタイム検証をしないため、Herdr から届く JSON は手書きの型ガードで検証する
- `AppType` は `import type` で取り込み、サーバーコードを client バンドルへ混入させない
