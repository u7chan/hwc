# ADR 0012: workflow の action は lockfile で固定する

- Status: Accepted
- Date: 2026-10-31

## Context

workflow の action はタグ参照（`@v4` / `@v2`）で、上流がタグを書き換えても、上流が侵害されても、この repo の差分なしに CI で実行される。`oven-sh/setup-bun` は第三者 action で更新頻度も高く、`allowed_actions` は `all`、`sha_pinning_required` も無効で、allowlist による防御は無い。

SHA pin 方式（`@<40桁SHA> # vX.Y.Z`）でもタグ参照は消せて、`sha_pinning_required` を有効化すれば実行時の強制もできる。lockfile は推移依存まで対象にでき、`uses:` を部分 ref（`@v4`）で書いたまま Dependabot に更新させられる点で勝る。

## Decision

`.github/workflows/actions.lock` を action 固定の正とし、workflow の `uses:` は `gh actions-lock` が生成する lockfile の commit SHA で解決する。`ci.yml` の `actions-lock` job が `gh actions-lock --verify` で stale な lockfile を fail させる。Dependabot に `github-actions` を登録し、更新 PR では lockfile も同じ PR で更新する。手順、固定しない範囲、実行時の挙動は [docs/ci.md](../ci.md) を正とする。

## Consequences

- workflow や `uses:` を追加・変更するたびに lockfile の再生成が必要になる。忘れれば `--verify` が fail する
- 更新は Dependabot の PR 経由になる
- 検出は PR 時点の job で、`actions-lock` は required status check ではないため fail しても merge はできる。実行時の強制はリポジトリのポリシー設定に依存する
- lockfile の差分 review が前提になる。floating ref を使う場合、過去の commit に巻き戻る変更は `gh actions-lock` では検出されない
- `open-pull-requests-limit: 1` のため、major 更新の PR が枠を占有している間は minor / patch の group PR が作られない
- lockfile が固定しない範囲（runner image、container image、`run:` や action の入力で取得するツール、reusable workflow、`gh actions-lock` 自体）は [docs/ci.md](../ci.md) を正とする

## References

- [Workflow dependency lockfiles](https://docs.github.com/en/actions/concepts/security/workflow-dependency-lockfiles)
- [Enforce workflow lockfiles](https://docs.github.com/en/actions/how-tos/administer/enforce-workflow-lockfiles)
- [gh-actions-lock](https://github.com/github/gh-actions-lock)
