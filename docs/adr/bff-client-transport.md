# BFF は Hono で書き、JSON は hc、push は SSE、生バイトは素の fetch で運ぶ

- Status: Accepted

## Context

ブラウザから Herdr のソケットへ直接接続できないため BFF が要る。client と BFF の型を二重管理したくない。

Herdr の状態変化は画面へ即時反映したい。ポーリングでは再描画の整合性を保ちにくい。一方、操作は離散的なリクエストで足りる。

## Decision

- BFF に Hono を使う。Hono は依存を持たず、[依存の方針](dependency-policy.md)と衝突しない
- JSON エンドポイントは `hc`（Hono RPC）で呼び、BFF の型を client と共有する。`AppType` は `import type` で取り込み、サーバーコードを client バンドルへ混ぜない
- 状態の push は SSE（`EventSource`）にする。片方向の push で要件を満たし、WebSocket の接続管理を持ち込まずに済む
- 添付などの生バイトは `hc` の対象外にする。アップロードは要求 body が生バイトなので素の `fetch`、配信は URL 直参照。応答が JSON でも `hc` に寄せない
- 状態の正は BFF に置く。client は SSE で届いたスナップショットで丸ごと置き換え、再接続時も差分を再適用しない。状態の取り直しを頼む口があっても、その応答の本文を状態として適用しない（状態の転送経路を SSE の 1 本に保つ）

## Consequences

- 型共有は JSON エンドポイントに限られる。SSE と生バイトは別の規則で扱う
- `hc` は実行時検証をしない。BFF が受け取る Herdr などの JSON は手書きの型ガードで検証し、client も壊れた応答に備えるガードを必要に応じて残す
- `hc` は validator の無い query / body を入力型に含めない。route 内で手書きの検証をしているため、client は request の形をローカル型で補う
- `hc` は path param をエスケープしないため、ペイン id は client で `encodeURIComponent` してから渡す

## Alternatives

- **WebSocket**: 双方向にできるが、client から BFF への操作は離散的なリクエストで足り、接続管理だけが増える
- **すべてを素の fetch で呼ぶ**: 規則は 1 つになるが、JSON の path と応答の型を二重に管理することになる
