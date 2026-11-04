# ADR 0024: JSON は hc、SSE と生バイトは素の fetch

- Status: Accepted
- Date: 2026-11-04

## Context

ADR 0003 は BFF の JSON エンドポイントの型を `hc` で client と共有すると決めた。ADR 0017 は当時の client 実装に合わせて `hc` を使わないと書いたため、現在の `src/client/api.ts` は JSON も含めて素の fetch を使い、`AppType` は未使用のまま残っている。SSE と添付画像の生バイトは `hc` の対象外であり、すべての通信を同じ方法にする必要はない。

## Decision

- JSON エンドポイントは `hc` を使い、BFF の型を client と共有する
- SSE は `EventSource` を使う
- 添付画像などの生バイトは素の `fetch` を使う
- `hc` は実行時検証をしない。BFF が受け取る Herdr の JSON などは、今まで通り手書きの型ガードで検証する
- `src/client/api.ts` の JSON 呼び出しは `hc` へ移行し、SSE と生バイトだけを素の経路として残す

## Consequences

- JSON の path / query / body / response の型がコンパイル時に効く
- `hc` の型は実行時の値を保証しないため、壊れた応答に備えるガードは必要に応じて残す
- SSE と生バイトは `hc` の外にあり、別の規則で扱う
- 実装の移行は #92 で追う
