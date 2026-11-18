# ADR 0096: Claude のモデルと effort は起動時にエイリアスと段階で選ぶ

- Status: Accepted
- Date: 2026-11-18
- Revises: [ADR 0030](0030-new-pane-model.md) の Claude に関する記述

## Context

[ADR 0030](0030-new-pane-model.md) は、モデルと effort を新しいペインの起動時に選べるようにしたが、候補を読む口が無い Claude は対象外にした。Claude Code 2.1.327 は `--model <model>` と `--effort <level>` を受け付ける。`--model` は family のエイリアス（`fable` / `opus` / `sonnet`、および CLI 同梱の alias 一覧にある `haiku`）をその時点の最新モデルへ解決し、`--effort` は `low` / `medium` / `high` / `xhigh` / `max` を受ける。

Pi の `--list-models`、Codex の `model/list`、OpenCode の `/api/model` に当たる一覧 API は無い。CLI は署名付きのモデルカタログを取得して `~/.claude/cache/model-catalog` に置くが、hwc が読む前提の公開形式ではなく、キャッシュが無い・古い・形式が変わる場合がある。

Claude はまだ会話を読めないため、起動後に選んだモデルを表示する経路も無い。

## Decision

- 作成ダイアログのモデル候補に Claude を加える。候補は CLI のエイリアス `opus` / `sonnet` / `fable` / `haiku` とし、`provider` は `claude`、`id` はエイリアスにする。版を含むモデル id は候補にしない
- 初期値はこれまでどおり「デフォルトモデル」で、未指定なら `--model` を渡さない。CLI の既定設定は変更しない
- モデルを明示したときだけ effort を選べる。候補は `--effort` が受ける 5 段階とし、モデルによる差は設けない。エイリアスの解決先はすべてこの 5 段階に対応する。未指定なら `--effort` を渡さない
- 起動引数は `["--model", "<alias>", ...(effort === null ? [] : ["--effort", effort])]` とし、Herdr の `agent.start` に渡す
- `GET /api/panes/:id/models?agent=claude` と `GET /api/panes/:id/efforts?agent=claude&...` は固定の候補を返す。CLI の起動も `~/.claude` の読み取りもしない。ペインの cwd は候補に使わない
- 分割と既存シェルでの起動の `model` / `effort` の形の検証は他エージェントと同じにする。候補に無いモデル・effort は起動準備で確認し、[ADR 0027](0027-new-pane-agent.md) の部分成功（ペインとシェルを残す）に従う
- Claude の会話表示、起動後のモデル・effort 表示、usage、圧縮の区切りは対象外のままとする

## Consequences

- ダイアログの表示は `claude/opus` のようになり、`Opus 5.5` のような版付きの名前は出ない。エイリアスは最新モデルへ解決されるので、選んだ family の最新版で起動する
- CLI がエイリアスや effort の段階を変えたら hwc も更新する。一覧 API が無いので、起動前に CLI の対応可否は確かめない。フラグを受けない古い CLI では起動が失敗し、ADR 0027 の失敗表示になる
- provider をまたぐとエイリアスの解決先が変わる（Bedrock / Vertex など）。hwc は解決先を表示しないので版の取り違えは起きないが、どの版で起動したかは端末の TUI で確認する
- Claude の候補取得はネットワークも CLI も使わないため、他のエージェントより速く、BFF のスナップショットとペインが読める限り失敗しない
- 将来、会話からモデル・effort を読めるようにするときは、この起動時の指定ではなく CLI のセッションを正にする（[ADR 0013](0013-pi-session-chat.md)、[ADR 0033](0033-launch-model-before-first-message.md)）

## Alternatives

- CLI のモデルカタログキャッシュを読む: 版付きの表示名とモデルごとの effort 段階が得られるが、公開形式ではなく、キャッシュの有無・鮮度・形式変更に依存する。起動時の `--model` はエイリアスで足りるため採らない
- 版付きのモデル id を hwc に固定する: 表示名は良くなるが、CLI のリリースごとに hwc を更新する必要があり、provider ごとの解決も再現できない
- モデル名を自由入力にする: 一覧 API が無くても任意の id を渡せるが、スマホで正しい id を入力するのは現実的でなく、候補の検証もできない
