# ADR 0029: モデルは新しいペインの起動時に選ぶ

- Status: Accepted
- Date: 2026-11-05

## Context

新しい作業を別のモデルで始めるたびに、CLI のモデル選択画面を開く必要がある。既存セッションの途中変更では、実行中の状態や認証待ちとの競合を扱うことになるが、新しいペインの起動時に指定するだけなら不要になる。各 CLI の既定モデル設定は変更したくない。

Herdr の `agent.start` は追加の起動引数を `args` 配列で受ける。Pi は `--model provider/id` を受ける。OpenCode 2.2.5 の通常 TUI は `--model` を受けないが、サービスの `POST /api/session` でモデルを指定した新規セッションを作り、`--session id` で開ける。

## Decision

- ADR 0027 のダイアログで、エージェントのカードの下に「モデル」のプルダウンを置く。初期値は「デフォルトモデル」
- Pi / OpenCode はモデルを選べる。Claude / Codex は「デフォルトモデル」のまま選択不可。シェルにはモデル欄を出さない。エージェントを変えたときはモデル指定を解除する
- 未指定なら起動引数を追加せず、従来どおり CLI の既定に任せる。既定モデルの保存、既存セッションの変更、effort の選択はしない
- 候補は `GET /api/panes/:id/models?agent=pi|opencode` で取得し、`{ models: [{ provider, id }] }` を返す。cwd とサービス認証は BFF の中だけで扱う
  - 対象ペインの cwd は Herdr の `pane.get` から読む
  - Pi はその cwd で `pi --offline --list-models` を実行し、利用可能一覧を読む。候補取得用プロセスから `HERDR_*` を外し、呼び出し元のペインの状態を報告させない
  - OpenCode は ADR 0028 と同じローカルサービスの `GET /api/model?location[directory]=...` から `enabled: true` のモデルだけを読む
  - 取得中・取得失敗・候補なしではプルダウンを無効にして理由を示す。「デフォルトモデル」での作成は妨げない
- モデル指定時だけ、分割後の新しいペインの実際の cwd でも候補を確認する。選択が無効になっていたら別モデルへ黙って置き換えず、ADR 0027 の起動失敗として名前付きシェルを残す
  - Pi は `agent.start` に `args: ["--model", "provider/id"]` を渡す
  - OpenCode は `POST /api/session` に `{ model: { providerID, id }, location: { directory } }` を送り、返された新規セッションを `args: ["--session", "id"]` で開く。プロンプト送信には引き続き Herdr を使う
- モデル指定時のクライアント期限は、候補の確認とセッション作成を含めて 100 秒にする。未指定時は ADR 0027 の 65 秒のまま。作成中・部分成功・再送抑止も同 ADR に従う

## Consequences

- Pi 本体の変更や、実行中ペインとのモデル変更 IPC は不要になる
- Pi の候補は新規プロセスの利用可能一覧であり、既存ペイン固有の `--models` や実行中に拡張が変えた scope は引き継がない。`--list-models` は `enabledModels` による巡回対象だけの一覧でもない
- Pi の一覧表示形式と OpenCode 2 の API に依存する。読めなくなってもデフォルト起動は残す
- OpenCode のサービスが止まっている場合、選択肢は取得できない。デフォルト起動による通常の CLI のサービス起動に任せる
- OpenCode の新規セッション作成後にエージェント起動が失敗すると、未使用の空セッションが残ることがある。既存セッションを消す危険を避けるため、自動削除しない
