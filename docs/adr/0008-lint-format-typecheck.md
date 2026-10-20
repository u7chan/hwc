# ADR 0008: lint・format・型検査は oxlint・oxfmt・tsc で行う

- Status: Accepted
- Date: 2026-10-20

## Context

eslint と prettier は設定と依存が重い。Bun は型検査を行わないため、別途ツールが必要になる。

## Decision

lint は oxlint、format は oxfmt、型検査は `tsc --noEmit` で行う。oxlint と oxfmt は Rust 製で実行が速く、eslint/prettier より依存が少ないため。

## Consequences

- oxfmt は 0.x で、破壊的な変更を受ける可能性がある
- oxlint の type-aware なルールは限定的で、型に依存する検査は tsc に任せる
