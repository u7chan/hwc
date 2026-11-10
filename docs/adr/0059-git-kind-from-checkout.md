# ADR 0058: git 種別の表示はチェックアウトから導く

- Status: Accepted
- Date: 2026-11-10

## Context

[ADR 0057](0057-github-remote-link.md) は、スペース見出しの先頭アイコンを「非 git / リポジトリ / linked worktree」の種類を表すものと決めた。実装は Herdr の `workspace.worktree` をそのまま使っている。

Herdr は `herdr worktree open` で開いたスペースにしか `worktree` を付けない。`herdr workspace create` で作ったスペースは、作業ディレクトリが git 管理下でも `worktree: null` になる。そのため、ブランチ・上流との差・GitHub のリポジトリ URL は `checkoutPaths` がペインの cwd にフォールバックして読めている（[ADR 0048](0048-git-remote-sync.md)）のに、アイコンだけは「非 git」のシェルになる。同じ画面で git の事実とアイコンが食い違う。

`worktree` は Herdr のワークツリー作成・削除（[ADR 0034](0034-remove-worktree.md) / [ADR 0038](0038-create-worktree.md)）の前提でもある。Herdr に登録されていないスペースでは、これらの API は失敗する。

## Decision

- 表示に使う git の種別（`repoName` / `repoRoot` / `isLinkedWorktree`）は、チェックアウトから導く。Herdr が `worktree` を返すスペースはその値を優先し、返さないスペースだけ git で判定する
- 判定は `git rev-parse --show-toplevel --absolute-git-dir --git-common-dir` で行う。git dir と common dir が違えば linked worktree。サブモジュールは同じなので linked にしない。linked worktree の `repoName` は common dir の親から取る
- 結果はチェックアウトごとに 10 秒キャッシュする。git の失敗・期限切れ・リポジトリ外では `null` にし、状態そのものは流す
- `WorktreeState` に `managed` を足す。Herdr の `worktree` は `true`、git で補ったものは `false`
- アイコン・リポジトリ束ね・チャット見出しの `repoName` は `managed` に関係なく `worktree` の事実を使う
- ワークツリーの作成・削除のメニューと API は `managed: true` のスペースだけに許す。Herdr に登録されていない git リポジトリは、表示はリポジトリでも操作はできない
- Herdr が `worktree` を返すスペースの値は変えない

## Consequences

- `herdr workspace create` で開いただけの git リポジトリも、リポジトリのアイコンになり、同じリポジトリのスペースは束ねられる
- Herdr に登録されていない linked worktree のパスを plain なスペースとして開くと、アイコンは linked worktree になるが、削除メニューは出ない。`herdr worktree open` で登録すると操作もできるようになる
- Herdr が worktree を返さないスペースでは、10 秒に 1 回だけ `git rev-parse` が走る。非 git のスペースも含むが、結果はキャッシュされる
- ブランチ・上流・PR・リポジトリ URL とアイコンが同じチェックアウトを見るようになる
- Herdr 管理下のスペースの表示と操作は今までどおり

## Alternatives

- **データ修復だけで済ませる**: `herdr worktree open` で既存スペースは直せるが、plain なスペースを作るたびに再発する
- **常に git で判定する**: Herdr が既に持っている値を読み直すことになり、両者が食い違ったときの優先順位が増える。Herdr の値があるスペースはそのまま使えば足りる
- **`managed` を足さずに `worktree` を埋める**: 表示は直るが、Herdr が拒否するワークツリー操作のメニューが出る
- **Herdr の `workspace create` を直す**: 上流の判断を待つことになり、hwc の表示は変わらない。git はローカルで読めるので、hwc 側で補う
