# CI

GitHub Actions の workflow は `.github/workflows/ci.yml` に集約する。`pull_request` と `push`（`main`）で、静的検査・テスト・action 固定の検証を回す。方式の判断は [ADR 0012](adr/0012-actions-lockfile.md) を参照する。

## action の固定

workflow が使う action は `.github/workflows/actions.lock` で commit SHA に固定する。lockfile は `gh actions-lock` が生成するもので、手で編集しない。

```bash
# 版は ci.yml の actions-lock job と揃える
gh extension install github/gh-actions-lock --pin vX.Y.Z
gh actions-lock          # ref を narrow して lockfile を再生成する
gh actions-lock --verify # CI と同じ検証
```

- action / workflow を追加・変更したら、同じ PR で lockfile も更新する
- `ci.yml` の `actions-lock` job が `--verify` で stale な lockfile を fail させる。固定漏れは PR 時点でここが検出する
- `actions-lock` は required status check のため、fail すると merge はブロックされる
- lockfile に載っている workflow では、lockfile に pin が無い `uses:` は実行時に落ちる。未 pin の `uses:` を足すと workflow は起動時点で失敗し、job が走らないため `actions-lock` の check も報告されない（PR は BLOCKED のままになる）。lockfile に未登録の新しい workflow は、リポジトリの Require lockfile ポリシーが Active でない限り実行時には止まらない
- Dependabot（`.github/dependabot.yml`）が action 更新の PR で lockfile も同じ PR で更新する。lockfile に未登録の workflow は Dependabot では onboard されない
- ref は narrow される（`@v4` → `@v4.4.0`）。再生成だけでは新しい patch / minor を追わない。追従は Dependabot の更新 PR で行う
- lockfile の差分は依存更新として review する。`commit` は実際に実行されるコード、`owner_id` / `repo_id` は参照先リポジトリの同一性を表す

## 対象外

- runner image（`runs-on`）
- container image（`container:` / `docker://`）
- action の入力や `run:` で取得するツール（例: `bun-version`）。Bun の依存は `bun.lock` で固定する
- reusable workflow の呼び出し（lockfile では固定されない。呼び出し元でフル SHA に固定する）
- `gh actions-lock` 自体（`gh extension install --pin` はリリースタグ指定で SHA 固定できない）
