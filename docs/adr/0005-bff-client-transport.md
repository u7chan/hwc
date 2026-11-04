# ADR 0005: BFF から client へは SSE、client から BFF へは fetch

- Status: Accepted
- Date: 2026-10-20

## Context

Herdr の状態変化を画面へ即時反映したい。ポーリングは再描画の整合性を保ちにくい。操作は離散的なリクエストで足りる。

## Decision

状態の push は SSE、JSON の操作は `hc`（Hono RPC）、生バイトは `hc` の対象外とする（[ADR 0024](0024-json-hc-streaming-raw.md)）。片方向の push で要件を満たし、WebSocket の接続管理を持ち込まずに済むため。

## Consequences

- 再接続時はスナップショットで状態を丸ごと置き換える（差分の再適用はしない）
- 状態の正は BFF に置き、client はスナップショットと差分から描画する
- SSE と添付画像などの生バイトは Hono RPC の型共有対象外になる
