# ADR 0007: unit は BFF と純関数に絞り、UI はエージェント E2E で確認する

- Status: Accepted
- Date: 2026-10-20

## Context

コンポーネント・CSS・アニメーションのテストは壊れやすく、書く量に対して得られる情報が少ない。壊れたときは人間が GUI で見る方が速い。

## Decision

`bun test` は BFF のプロトコル・状態機械と、client の純粋な変換・selector に限定する。DOM を必要とするテストは書かない。E2E は Playwright CLI をエージェントが自然文の手順で実行し、正常系とエッジケースを確認する。

## Consequences

- UI の見た目やアニメーションの回帰は自動検知されない
- hooks はロジックを純関数へ抽出してテストする対象になり、フック自体はテストしない
- DOM 環境（`happy-dom` など）を依存に加えない
