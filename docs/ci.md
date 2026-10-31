# CI

GitHub Actions の workflow は `.github/workflows/ci.yml` に集約する。`pull_request` と `push`（`main`）で、静的検査・テスト・action 固定の検証を回す。

## action の固定

workflow が使う action は `.github/workflows/actions.lock` で commit SHA に固定する。lockfile は `gh actions-lock` が生成するもので、手で編集しない。

```bash
gh extension install github/gh-actions-lock --pin v0.4.0
gh actions-lock          # ref を narrow して lockfile を再生成する
gh actions-lock --verify # CI と同じ検証
```

- action / workflow を追加・変更したら、同じ PR で lockfile も更新する。lockfile に pin が無い `uses:` は実行時に `lockfile missing pin for ...` で落ちる
- `ci.yml` の `actions-lock` job が `--verify` で stale な lockfile を fail させる
- Dependabot（`.github/dependabot.yml`）が action 更新の PR で lockfile も同じ PR で更新する
- ref は narrow される（`@v6` → `@v6.1.0`）。narrow 後の ref は action 側の新しい patch / minor を自動では追わない
- lockfile の差分は依存更新として review する。`commit` は実際に実行されるコード、`owner_id` / `repo_id` は参照先リポジトリの同一性を表す

## 対象外

- runner image（`runs-on`）
- container image（`container:` / `docker://`）
- `run:` 内で install するツール
- reusable workflow の呼び出し（lockfile では固定されない。呼び出し元でフル SHA に固定する）
