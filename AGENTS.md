## Tech Stack

- TBD

## Why / What / Constraints First

実装前に、必要に応じて以下を簡潔に明確にすること。

- **Why**: なぜ必要か
- **What**: 何を満たすべきか
- **Constraints**: 守るべき前提・制約

**How** は実装方法そのものを指すため、ここには含めない。
How は設計とコードで表現すること。

## YAGNI

未来のことや決まっていないことは書かない・実装しない。過度な後方互換性やマイグレーションの考慮もしない。

## Git / PR

- main への直 push は禁止。必ずブランチを作成して PR を出す。
- ワークツリー、ブランチ名は小文字の kebab-case（例: `feat/xxx-yyy`）。prefix は `feat` / `fix` / `chore` / `docs` / `refactor` / `test` から選ぶ。
- マージ: squash のみ（1 PR = 1 コミット、PR 内のコミット数は問わない）。`gh pr merge <PR> --squash -t "feat(<scope>): ..." -b "<Why>"` でメッセージを英語・プレフィックス付きで明示。
- 確認: マージ後 `git log -1 --format=%s` で main の subject が英語か確認。
- PR のフィードバックに対応したら、必ず当該コメントに返信する。インラインコメントでない場合は `Re: ` をつけて全体コメントで返信する。
- PR は日本語で書き、以下のセクションを含める。
  - `## Issues`
  - `## Why`
  - `## Summary`
  - `## Changes`
  - `## Verification`
- `## Issues` セクションには `- close: #123` のように close キーワードを付け、マージ時に Issue が自動クローズされるようにする（`- #123` のみでは自動クローズされない）。

## Commit Message

- プレフィックスをつけて英語で記述する（例: `feat(<scope>): add custom field`）。

## Single Source of Truth

同じ情報を複数箇所に書かない。正となる場所を 1 つ決め、他はそこを参照する。

## Where to Write What

書くべき情報の置き場所を分ける。

- コミットログ: **Why**
- コード: **How**
- テストコード: **What**
- コードコメント: **Why not**

## Language and Environment

- Issue / PR / レビューコメント / ドキュメントは日本語で書く。
- Issue / PR / ドキュメント / コミットメッセージに、ローカル IP アドレスや、その環境でしか通用しない実ホスト名など、環境固有のネットワーク情報を書かない（例示には RFC 5737 / RFC 3849 の予約アドレスなどを使う）。

## Test Policy

テストケースは生きるドキュメント（仕様書）として設計する。

## Comment Policy

- ドキュメントコメントは書かない（膨らみ、コードと矛盾するため）。
- コードコメントには **Why not**（採らなかった選択肢とその理由）を書く。コードから読み取れない前提・制約もここに含める。
- コードを読めば分かる内容はコメントせず、コード自体を分かりやすくする。
- 将来の改善は `// TODO:` / `// TBD:` で残す。

## References

タスクの目的や変更範囲に応じて、[docs/README.md](docs/README.md) を参照してください。
