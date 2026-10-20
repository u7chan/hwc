# ADR 0004: client に Preact を使う

- Status: Accepted
- Date: 2026-10-20

## Context

画面数は少なく、UI はコンポーネントとして書く。ランタイムは軽いほどよい。

## Decision

client は Preact + TSX で書く。軽量で React 互換の API を持ち、Hono RPC と組み合わせやすいため。

## Consequences

- Fast Refresh が使えず、開発中の編集はフルリロードになる
- React 向けのライブラリの一部はそのままでは使えない
