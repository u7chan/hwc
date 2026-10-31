# ADR 0012: workflow の action は lockfile で固定する

- Status: Accepted
- Date: 2026-10-31

## Context

workflow の action はタグ参照（`@v4` / `@v2`）で、上流がタグを書き換えても、上流が侵害されても、この repo の差分なしに CI で実行される。`oven-sh/setup-bun` は第三者 action で更新頻度も高く、`allowed_actions` は `all`、`sha_pinning_required` も無効で、allowlist による防御は無い。

SHA pin 方式（`@<40桁SHA> # vX.Y.Z`）でもタグ参照は消せるが、action を追加したときの固定漏れは規律でしか防げず、実行時に検出できない。

## Decision

`.github/workflows/actions.lock` を action 固定の正とし、workflow の `uses:` は `gh actions-lock` が生成する lockfile の commit SHA で解決する。`ci.yml` の `actions-lock` job が `gh actions-lock --verify` で stale な lockfile を fail させる。Dependabot に `github-actions` を登録し、更新 PR では lockfile も同じ PR で更新する。手順と対象外は [docs/ci.md](../ci.md) を参照する。

## Consequences

- workflow や `uses:` を追加・変更するたびに lockfile の再生成が必要になる。忘れれば `--verify` が fail する
- ref は narrow される（`@v4` → `@v4.4.0`）。更新は Dependabot の PR 経由になり、`gh actions-lock` の再生成だけでは追従しない
- 検出は PR 時点。lockfile に未登録の新しい workflow は、リポジトリの Require lockfile ポリシーが Active でない限り実行時には止まらない
- lockfile の差分 review が前提になる。floating ref が過去の commit に巻き戻る変更は `gh actions-lock` では検出されない
- `open-pull-requests-limit: 1` のため、major 更新の PR が枠を占有している間は minor / patch の group PR が作られない
- `gh actions-lock` 自体は lockfile の保護外で、`gh extension install --pin` はリリースタグ指定になる
- container image、runner image、`run:` や action の入力で取得するツール、reusable workflow の呼び出しは固定対象外（詳細は [docs/ci.md](../ci.md)）
