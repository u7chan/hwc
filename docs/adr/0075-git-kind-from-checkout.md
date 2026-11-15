# ADR 0075: git 種別の表示はチェックアウトから導く

- Status: Accepted
- Date: 2026-11-10
- Amended: 2026-11-15

## Context

[ADR 0072](0072-github-remote-link.md) は、スペース見出しの先頭アイコンを「非 git / リポジトリ / linked worktree」の種類を表すものと決めた。実装は Herdr の `workspace.worktree` をそのまま使っている。

Herdr はワークツリーの作成・オープンでスペースに `worktree` を付ける。`herdr workspace create` で作ったスペースは、作業ディレクトリが git 管理下でも `worktree: null` になる。そのため、ブランチ・上流との差・GitHub のリポジトリ URL は `checkoutPaths` がペインの cwd にフォールバックして読めている（[ADR 0048](0048-git-remote-sync.md)）のに、アイコンだけは「非 git」のシェルになる。同じ画面で git の事実とアイコンが食い違う。

当初は `worktree` がワークツリー作成・削除の両方に必要だと考え、Herdr に登録されていないスペースでは操作を出さなかった。その結果、git リポジトリ本体として表示されているスペースからワークツリーを作れなくなった。

Herdr 0.9.5 の [`worktree.create` の実装](https://github.com/herdrdev/herdr/blob/v0.9.5/src/app/api/worktrees.rs)は、登録情報が無い場合も作業ディレクトリから git を判定し、作成時に起点スペースの登録情報を補う。一方、[`worktree.remove` の実装](https://github.com/herdrdev/herdr/blob/v0.9.5/src/app/api/worktrees/deferred.rs)は Herdr に登録された linked worktree だけを受け付ける。作成にも登録を要求する前提は誤りだった。

## Decision

- 表示に使う git の種別（`repoName` / `repoRoot` / `isLinkedWorktree`）は、チェックアウトから導く。Herdr が `worktree` を返すスペースはその値を優先し、返さないスペースだけ git で判定する
- 判定は `git rev-parse --show-toplevel --absolute-git-dir --git-common-dir` で行う。git dir と common dir が違えば linked worktree。サブモジュールは同じなので linked にしない。linked worktree の `repoName` は common dir の親から取る
- 結果はチェックアウトごとに 10 秒キャッシュする。git の失敗・期限切れ・リポジトリ外では `null` にし、状態そのものは流す
- `WorktreeState` に `managed` を足す。Herdr の `worktree` は `true`、git で補ったものは `false`
- アイコン・リポジトリ束ね・チャット見出しの `repoName` は `managed` に関係なく `worktree` の事実を使う
- ワークツリー作成のメニューと API は、`worktree` があり `isLinkedWorktree === false` のスペースで使える。`managed` は作成条件にせず、Herdr に登録されていないリポジトリ本体からも作れる。事前の登録や開き直しは求めない（[ADR 0038](0038-create-worktree.md)）
- ワークツリー削除は、Herdr の API に合わせて `managed: true` の linked worktree だけに許す（[ADR 0034](0034-remove-worktree.md)）。重複スペースの識別・close における `managed` の扱いは [ADR 0060](0060-duplicate-native-spaces.md) のままにする
- Herdr が `worktree` を返すスペースの値は変えない

## Consequences

- `herdr workspace create` で開いただけの git リポジトリも、リポジトリのアイコンになり、同じリポジトリのスペースは束ねられる
- 未登録のリポジトリ本体でも、メニューから新しいワークツリーを作れる。作成後は Herdr の `workspace.updated` で起点スペースの登録情報も反映される
- Herdr に登録されていない linked worktree のパスを plain なスペースとして開くと、アイコンは linked worktree になるが、削除メニューは出ない。`herdr worktree open` で登録すると操作もできるようになる
- Herdr が worktree を返さないスペースでは、10 秒に 1 回だけ `git rev-parse` が走る。非 git のスペースも含むが、結果はキャッシュされる
- ブランチ・上流・PR・リポジトリ URL とアイコンが同じチェックアウトを見るようになる
- Herdr 管理下のスペースの表示と操作は今までどおり

## Alternatives

- **データ修復だけで済ませる**: `herdr worktree open` で既存スペースは直せるが、plain なスペースを作るたびに再発する
- **常に git で判定する**: Herdr が既に持っている値を読み直すことになり、両者が食い違ったときの優先順位が増える。Herdr の値があるスペースはそのまま使えば足りる
- **`managed` を足さずに `worktree` を埋める**: 表示と作成には足りるが、Herdr が拒否する削除メニューが出る。重複スペースの識別にも登録情報の区別が必要になる
- **作成にも `managed: true` を求める**: Herdr が受け付けるリポジトリ本体からの作成を hwc だけが拒否する。利用者に不要な事前登録を求めるため採らない
- **Herdr の `workspace create` を直す**: 上流の判断を待つことになり、hwc の表示は変わらない。git はローカルで読めるので、hwc 側で補う
