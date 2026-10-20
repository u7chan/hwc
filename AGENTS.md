## Project

Herdr CLI（WSL2）を Web ブラウザから操作・閲覧するアプリ。TUI では扱いにくい操作と表示を補うためのもので、全機能の再現は目指さない。主な利用端末はスマホ（iOS Chrome）で、LAN 内の端末から接続する（待ち受けは `0.0.0.0`）。

## Tech Stack

- TypeScript
- Bun（runtime / package manager / bundler / dev server / test runner）
- Hono（BFF、`hc` による RPC 型共有）
- Preact（client）
- SSE（BFF → client）、fetch（client → BFF）
- 素の CSS + CSS 変数 + CSS Modules
- oxlint / oxfmt / `tsc --noEmit`
- Playwright CLI（エージェント経由の E2E）

## Architecture Decisions

設計判断は `docs/adr/` を参照する。

- `Accepted`: 現在有効
- `Proposed`: 検討中
- `Superseded`: 過去の判断

Accepted ADRとタスクが衝突する場合、迂回実装で無理に両立させず、衝突を明示してタスクまたはADRの見直しを判断する。

## Why / What / Constraints First

実装前に Why / What / Constraints を簡潔に明確にする。How はここに書かず、設計とコードで表現する。

- **Why**: なぜ必要か
- **What**: 何を満たすべきか
- **Constraints**: 守るべき前提・制約

## YAGNI

未来のことや決まっていないことは書かない・実装しない。過度な後方互換性やマイグレーションの考慮もしない。

## Git / PR

- main へ直 push しない。必ずブランチを切り PR を出す。
- ワークツリー / ブランチ: 小文字 kebab-case（例: `feat/xxx-yyy`）、prefix は `feat` / `fix` / `chore` / `docs` / `refactor` / `test`。
- マージ: squash のみ（1 PR = 1 コミット、PR 内のコミット数は問わない）。`gh pr merge <PR> --squash -t "feat(<scope>): ..." -b "<Why>"` でメッセージを英語・プレフィックス付きで明示。
- 確認: マージ後 `git log -1 --format=%s` で main の subject が英語か確認。
- レビュー対応: 指摘には必ず返信する。インラインでない指摘は `Re: ` 付きの全体コメントで返信する。
- PR 本文: 日本語で `## Issues` / `## Why` / `## Summary` / `## Changes` / `## Verification` を含める。
- `## Issues`: `- close: #123` 形式で書く（`- #123` のみでは自動クローズされない）。

## Commit Message

- プレフィックス付きの英語（例: `feat(<scope>): add custom field`）。

## Single Source of Truth

同じ情報を複数箇所に書かない。正となる場所を 1 つ決め、他はそこを参照する。

## Where to Write What

- コミットログ: **Why**
- コード: **How**
- テストコード: **What**
- コードコメント: **Why not**

## Language and Environment

- Issue / PR / レビューコメント / ドキュメント: 日本語で書く。
- Issue / PR / ドキュメント / コミットメッセージ: ローカル IP や実ホスト名など環境固有のネットワーク情報を書かない。例示には RFC 5737 / RFC 3849 の予約アドレスを使う。

## Test Policy

テストケースは生きるドキュメント（仕様書）として設計する。

- unit: BFF（プロトコル・状態機械）を主対象。client は純粋な変換・selector のみ。
- hooks はロジックを純関数に抽出してテストする。フック自体はテストしない。
- DOM を必要とするテスト（コンポーネント・CSS・アニメーション）は書かない。エージェント E2E と人間の目視に任せる。

## Comment Policy

- ドキュメントコメントは書かない。
- コードコメント: **Why not**（採らなかった選択肢と理由、コードから読み取れない前提・制約）に限る。
- コードを読めば分かることはコメントせず、コードを直す。
- 将来の改善: `// TODO:` / `// TBD:`。

## References

タスクの目的や変更範囲に応じて、[docs/README.md](docs/README.md) を参照してください。
