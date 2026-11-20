# ADR 0114: モデルのラベルは、どのエージェントでも provider を出さず、Pi だけ残す

- Status: Accepted
- Date: 2026-11-21
- Amends: [ADR 0108](0108-claude-model-display-name.md) の「作成ダイアログのモデルの選択肢と、設定画面のモデルの行は、Claude に限りエイリアスの表示名（`Opus`）にする」

## Context

ADR 0108 は Claude のモデルだけを表示名（`Opus`）にし、ほかのエージェントは `provider/id`（`openai/gpt-6.1-sol`、`opencode-go/beam-free`）のまま残した。そのため同じ「モデル」欄に、名前と識別子が混ざっていた。Claude のモデルで provider を落とした理由（行がエージェント名と並び、自分を二重に名乗る）は、Codex / OpenCode の provider にもそのまま当てはまる。`openai` は Codex、`opencode-go` は OpenCode のことで、狭いスマホの画面では provider の分だけモデル名が切れる。

社名を冠する案（`Claude Opus 5.5`）も検討したが、設定の一覧の行が「Claude Claude Sonnet」になり、入力欄のチップは幅が足りずに `Clau…` と切れる。アイコンのある行で社名を繰り返す利点も無い。

## Decision

- モデルのラベルは、Claude は表示名（`Opus`、`Opus 5.5`）、Codex / OpenCode は provider を落としたモデル id（`gpt-6.1-sol`、`beam-free`）にする
- Pi だけは `provider/id` のまま。provider がモデルの選択の一部で、id だけでは同じモデルを指せない
- 変えるのはラベルだけにする。選択肢の値（`provider/id`）、起動引数（`--model opus`）、パネルとコピーの識別子（`claude-opus-5-5`）は変えない
- ラベルは `shared` の `modelLabel` 1 か所で決め、作成ダイアログの選択肢と設定画面の行が同じものを見る

## Consequences

- 同じ「モデル」欄が、どのエージェントでも名前で埋まる。provider は画面のどこにも出なくなる
- provider が違っても id が同じモデルがあると、OpenCode の選択肢に同じ文字列が並ぶ。値は `provider/id` なので選び分けられるが、ラベルだけでは区別できない
- 設定の一覧の行は、カテゴリ名（`Claude`）の隣に `Sonnet` が出るようになり、社名は繰り返さない
- 入力欄のチップは `Opus 5.5` の長さに戻る

## Alternatives

- **識別子（`provider/id`）で統一する**: 一意で正確だが、選んだエージェント名を繰り返し、スマホの幅でモデル名が切れる
- **Claude のラベルに社名を冠する（`Claude Opus 5.5`）**: Anthropic の正式名に近づくが、設定の一覧の行で社名が重複し、チップでは入りきらない
- **Claude だけ provider を残す（`claude/claude-opus-5-5`）**: 二重に名乗り、[ADR 0108](0108-claude-model-display-name.md) の出発点に戻る
