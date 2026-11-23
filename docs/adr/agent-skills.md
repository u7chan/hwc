# グローバルスキルは BFF が読み取り専用で見せる

- Status: Accepted

## Context

スキルは各 CLI のホーム配下の設定で、どのスキルが読み込まれるかは CLI ごとに違う。同じスキル群を共有していても、`~/.claude/settings.local.json` の `skillOverrides` のように、ある CLI だけが無効にしていることがある。ペインが意図したスキルを使わないとき、原因が hwc からは見えない。

## Decision

- 設定画面のエージェント詳細に、その CLI がグローバルに認識するスキルを読み取り専用で並べる。有効・無効は CLI の設定に従って表示し、hwc からは書き換えない。ユーザーの `~/.claude` や `~/.agents` を変更しない（[Claude 連携](claude-integration.md)の方針と同じ）
- 対象はグローバルのみ。ペインの cwd に依存するプロジェクトのスキルは含めない。設定画面に cwd が無いため
- 名前・由来・有効無効に加えて、`SKILL.md` の frontmatter の `description` を返す。何のスキルかの見当を付けるためなので、長いものは BFF で 240 文字に切る。frontmatter は YAML 全体を解釈せず、最上位の `name` と `description` だけを、1 行・引用・折り返し（plain / `>` / `|`）のスカラーとして読む
- 探索先と規則は各 CLI のドキュメントに従い、BFF がファイルを直接読む。CLI のプロセスは起動しない（Pi の RPC は数秒かかり、セッションの副作用もあるため）
  - Pi: `~/.pi/agent/skills`、`~/.agents/skills`、`settings.json` の `packages` が持つ `skills/`・`.agents/skills/`・manifest の `pi.skills`
  - Claude: `~/.claude/skills`（バンドルは `skillOverrides` の名前空間で引く）、`settings.json` と `settings.local.json` の `skillOverrides`
  - Codex: `~/.agents/skills`、`/etc/codex/skills`、`config.toml` の `[[skills.config]]`
  - OpenCode: `~/.config/opencode/skills`、`~/.claude/skills`、`~/.agents/skills`、`opencode.json` の `skills`（ローカルパスのみ）
- 設定ルートは CLI 自身の環境変数を優先する（`PI_CODING_AGENT_DIR`、`CLAUDE_CONFIG_DIR`、`CODEX_HOME`）。hwc が起動するペインと同じ設定を見るため
- 同名スキルの扱いは CLI に合わせる
  - OpenCode: パス由来の ID で選び、登録順の後勝ち（弱い順に `~/.claude/skills` → `~/.agents/skills` → `~/.config/opencode/skills` → 設定 `skills`）。一覧も勝った方だけを残す
  - Pi: 宣言した `name` が衝突したら、先に見つかった置き場だけを残す
  - Codex: 同名を併記する（公式にマージしない）。Claude も実体パスの重複だけを消し、同名は併記する
- 次のものは対象外にする。CLI 側の解決規則が未文書か、hwc から正否を確かめられないため
  - Claude のプラグイン（有効・無効が別管理）、Codex の同梱 system スキル
  - Pi の `settings.json` の `skills`（glob・除外記法を解釈しないと、載せないスキルを載せてしまう）
  - OpenCode の相対パス（cwd 基準）、HTTP カタログ、`opencode.jsonc`（コメントの解釈を持たない）

## Consequences

- CLI が探索規則を変えると、表示が実際の読み込みとずれる。ずれた場合は ADR を直すのではなく、その CLI のドキュメントを正として BFF を直す
- ホーム配下を毎回走査する。一覧は件数で打ち切り、切ったことを画面に返す
- 読み取り専用なので、無効になっているスキルを hwc から有効にはできない
- アンカー・タグ・引用内のエスケープなど、上の範囲を外れる YAML は解釈しない。説明が記号のまま出るか、欠けて見える

## Alternatives

- **各 CLI に一覧を出させる**: 正は CLI になるが、一覧を返す口が Pi の RPC にしか無く、他の CLI では取得にセッションを起動する必要がある
- **書き換えも hwc から行う**: on/off を画面で直せるが、ユーザーの設定ファイルを書き換えることになり、CLI の版で形式が変わると壊す
