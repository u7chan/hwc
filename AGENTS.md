## Project

Herdr CLI（WSL2）を Web ブラウザから操作・閲覧するアプリ。TUI では扱いにくい操作と表示を補うためのもので、全機能の再現は目指さない。主な利用端末はスマホ（iOS Chrome）で、LAN 内の端末から接続する（待ち受けは `0.0.0.0`）。

## Tech Stack

- TypeScript
- Bun（runtime / package manager / bundler / dev server / test runner）
- Hono（BFF）
- Preact（client）
- SSE（BFF → client）、fetch（client → BFF）
- 素の CSS + CSS 変数 + 接頭辞付きクラス名
- oxlint / oxfmt / `tsc --noEmit`
- Playwright CLI（エージェント経由の E2E）

## Principles

- **Why / What / Constraints First**: Why（なぜ必要か）・What（何を満たすべきか）・Constraints（守るべき前提・制約）を簡潔に明確にしてから、How（設計・実装）に進む。How はここに書かず、設計とコードで表現する。
- **YAGNI**: 未確定の要件や将来の拡張を先回りして実装・記述しない。過度な後方互換性やマイグレーションも考慮しない。
- **Single Source of Truth**: 同じ情報を複数箇所に書かない。正となる場所を 1 つ決め、他はそこを参照する。

## Architecture Decisions

設計判断は `docs/adr/` に従う。

- `Accepted`: 現在有効。実装はこれに従う
- `Proposed`: 検討中。前提にしない
- `Superseded`: 過去の判断。従わない

Accepted ADR とタスクが衝突する場合は、迂回実装で無理に両立させない。作業を止めて衝突を報告し、タスクと ADR のどちらを見直すか判断を仰ぐ。Accepted ADR 同士が矛盾する場合も、勝手にどちらかを選ばず報告する。

## Where to Write What

- コミットログ: **Why**
- コード: **How**
- テストコード: **What**
- コードコメント: **Why not**（採らなかった選択肢と理由、コードから読み取れない前提・制約）

コメントについて:

- ドキュメントコメントは書かない。
- コードを読めば分かることはコメントせず、コードを直す。
- `// TODO:` は既知の改善点。何を見直すかを添える。
- `// TBD:` は YAGNI の例外。仕様や外部の前提が未確定で、現状の形を暫定実装にしている箇所にだけ使う。何が未決かを添え、将来の機能を先回りして実装するための口実にしない。

## State

- 導出できる値は state にしない。描画中に計算する。
- props・サーバー状態を state にコピーしない。識別子だけを持つ（例: 選択中ペインは id）。
- サーバー状態の正は BFF。クライアントは受け取ったスナップショットで丸ごと置き換える。
- 同じ状態を複数のコンポーネント・ref・モジュールに持たない。
- `useEffect` は外部との同期（購読・タイマー・入力）に限る。派生値の計算や状態の連鎖更新に使わない。

## Test Policy

テストケースは生きるドキュメント（仕様書）として設計する。

- unit: BFF（プロトコル・状態機械）を主対象とする。client は純関数（変換・selector、hooks から抽出したロジック）のみテストし、hooks 自体はテストしない。
- DOM を必要とするテスト（コンポーネント・CSS・アニメーション）は書かない。エージェント E2E と人間の目視に任せる。
- E2E は `bun run e2e:serve` の架空 Herdr に対して行い、実 Herdr につながった画面はスクリーンショットに撮らない。詳細は [docs/e2e.md](docs/e2e.md)。

## Verification

変更後は `bun run fmt:check` / `bun run lint` / `bun run typecheck` / `bun run test` を実行し、結果を報告する。整形が必要なら `bun run fmt` を使う。UI を変えた場合は Test Policy の E2E も行う。

## Git / PR

- main に直接コミット・push しない。必ずブランチを切る。
- `git push`・PR 作成（Draft を含む）・マージは、明示的な指示があるまで行わない。ブランチ上でコミットまでに留め、変更内容と検証結果を報告して指示を待つ。
- ブランチ / ワークツリー名: 小文字 kebab-case の `<type>/<topic>`（例: `feat/xxx-yyy`）。
- コミットメッセージ: `<type>(<scope>): <summary>`。
- `<type>` はブランチ名・コミットメッセージ共通で `feat` / `fix` / `chore` / `docs` / `refactor` / `test`。
- マージは squash のみ（main 上で 1 PR = 1 コミット。PR 内のコミット数は問わない）。PR タイトルがそのまま subject にならないよう、`gh pr merge <PR> --squash -t "<type>(<scope>): <summary>" -b "<Why>"` で明示する。マージ後は `git fetch origin && git log -1 --format=%s origin/main` で subject が `<type>(<scope>): <summary>` になっているか確認する。
- PR 本文には `## Issues` / `## Why` / `## Summary` / `## Changes` / `## Verification` を含める。`## Issues` は `- close: #123` 形式で書く（`- #123` だけでは自動クローズされない）。
- レビュー指摘には必ず返信する。インラインでない指摘には `Re: ` 付きの全体コメントで返信する。

## Language

- 日本語: Issue / PR 本文 / レビューコメント / ドキュメント / コードコメント
- 英語: コミットメッセージ（squash マージのタイトル・本文を含む）、PR タイトル

## Environment-specific Information

- コード・テスト・コミットメッセージ・Issue・PR・レビューコメント・ドキュメントに、ローカル IP や実ホスト名など環境固有のネットワーク情報を書かない。
- 例示には予約済みのものを使う: IPv4 は RFC 5737（`192.0.2.0/24` など）、IPv6 は RFC 3849（`2001:db8::/32`）、ドメインは RFC 2606（`example.com` など）。
- E2E の fixture とスクリーンショットでは、実ユーザー名・実リポジトリ名・実パス・実会話も使わない。詳細は [docs/e2e.md](docs/e2e.md)。

## References

タスクの目的や変更範囲に応じて、[docs/README.md](docs/README.md) を参照してください。
