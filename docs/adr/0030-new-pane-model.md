# ADR 0030: モデルと effort は新しいペインの起動時に選ぶ

- Status: Accepted
- Date: 2026-11-05

## Context

新しい作業を別のモデルで始めるたびに、CLI のモデル選択画面を開く必要がある。既存セッションの途中変更では、実行中の状態や認証待ちとの競合を扱うことになるが、新しいペインの起動時に指定するだけなら不要になる。各 CLI の既定モデル設定は変更したくない。

Herdr の `agent.start` は追加の起動引数を `args` 配列で受ける。Pi は `--model provider/id`、Codex CLI 0.166.0 は `--model id` を受ける。OpenCode 2.2.5 の通常 TUI は `--model` を受けないが、サービスの `POST /api/session` でモデルを指定した新規セッションを作り、`--session id` で開ける。

同じモデルでも作業に応じて推論の深さを変えたい。対応する段階はエージェント・provider・モデルで異なり、OpenCode はカスタム名を含む variant として扱う。共通の「低・中・高」へ変換せず、各 CLI の受け付ける値を選びたい。

## Decision

- ADR 0027 のダイアログで、エージェントのカードの下に「モデル」のプルダウンを置く。初期値は「デフォルトモデル」
- Pi / Codex / OpenCode はモデルを選べる。Claude は「デフォルトモデル」のまま選択不可。シェルにはモデル欄を出さない。エージェントを変えたときはモデル指定を解除する
- 未指定ならモデルの起動引数を追加せず、CLI の既定に任せる。Codex のモデル・effort 以外の起動引数は [ADR 0031](0031-codex-chat.md) に従う。既定設定の保存と既存セッションの変更はしない
- 候補は `GET /api/panes/:id/models?agent=pi|codex|opencode` で取得し、`{ models: [{ provider, id }] }` を返す。cwd とサービス認証は BFF の中だけで扱う
  - 対象ペインの cwd は Herdr の `pane.get` から読む
  - Pi はその cwd で `pi --offline --list-models` を実行し、利用可能一覧を読む。候補取得用プロセスから `HERDR_*` を外し、呼び出し元のペインの状態を報告させない
  - Codex はその cwd で ADR 0031 の読み取り用 App Server を起動し、`config/read` の `model_provider`（未指定は `openai`）と `model/list` の表示対象モデルを読む。`id` はピッカーの ID ではなく API の `model` を使う。候補はカーソルで最後まで取得し、上限 10 ページを超えた場合は取得失敗とする
  - OpenCode は ADR 0028 と同じローカルサービスの `GET /api/model?location[directory]=...` から `enabled: true` のモデルだけを読む
  - 取得中・取得失敗・候補なしではプルダウンを無効にして理由を示す。「デフォルトモデル」での作成は妨げない
- Pi / Codex / OpenCode はモデル欄の下に「エフォート」を置き、モデルを明示選択した場合だけ指定できる。デフォルトモデルでは無効にして「モデルを選択すると指定できます」と示す。Claude とシェルには出さない
  - 初期値は「デフォルト（CLI に任せる）」。未指定を意味し、`off` / `none` や特定の段階へ置き換えない
  - 候補は各 CLI の返す値と順序を保ち、共通の段階へ変換しない。エージェント・モデルの変更とシェルへの切り替えで指定を解除する
  - 取得中・取得失敗・非対応はそれぞれ理由を示して無効にする。モデルを明示選択していても、effort 未指定での起動は妨げない
- effort 候補は `GET /api/panes/:id/efforts?agent=pi|codex|opencode&provider=...&model=...` で取得し、`{ efforts: string[] }` を返す。cwd はモデル一覧と同じく BFF が読む。非対応は空配列、取得失敗や形式不明は `502 efforts_unavailable` とし、上流のエラーやパスは返さない
  - Pi はその cwd で `pi --offline --mode rpc --no-session --model provider/id` を起動し、`get_state` と `get_available_thinking_levels` だけを読む。実際の選択モデルの provider / id が要求と一致することを確認し、reasoning 非対応なら空配列にする。対応段階の規則を hwc にコピーせず、モデル一覧と同じく拡張を読み込む。プロセスから `HERDR_*` を外し、20 秒 / stdout 16MB で打ち切って必ず回収する。セッションは保存しない
  - Codex はモデル一覧と同じ cwd・実効 provider の `model/list` から、選択モデルの `supportedReasoningEfforts[].reasoningEffort` を読む
  - OpenCode はモデル一覧と同じ API から、選択した enabled モデルの `variants[].id` を読む。カスタム名もそのまま扱う
- `POST /api/panes/:id/split` は `effort?: string | null` を受ける。モデル未指定・非対応エージェントへの effort 指定と、不正な文字列は分割前に 400 で拒否する
- モデル指定時だけ、分割後の新しいペインの実際の cwd でも候補を確認する。選択が無効になっていたら別モデルへ黙って置き換えず、ADR 0027 の起動失敗として名前付きシェルを残す
  - effort 指定時は対応段階も再取得して検証する。指定値が使えない・確認できない場合は、別の値やデフォルトへ黙って置き換えず、同じ起動失敗として扱う
  - Pi は `agent.start` に `args: ["--model", "provider/id"]` を渡し、effort 指定時だけ `--thinking value` を追加する
  - Codex は `--model id` を追加する。再取得した cwd の provider と候補の組が一致することを確認し、effort 指定時だけ `--config 'model_reasoning_effort="value"'` を追加する。既定の provider・モデル・effort 設定は保存しない
  - OpenCode は `POST /api/session` に `{ model: { providerID, id, variant? }, location: { directory } }` を送り、返された新規セッションを `args: ["--session", "id"]` で開く。`variant` は effort 指定時だけ含める。プロンプト送信には引き続き Herdr を使う
- モデル指定時のクライアント期限は、候補の確認・effort の再検証・セッション作成を含めて 120 秒にする。未指定時は ADR 0027 の 65 秒のまま。作成中・部分成功・再送抑止も同 ADR に従う

## Consequences

- Pi 本体の変更や、実行中ペインとのモデル変更 IPC は不要になる
- Pi の候補は新規プロセスの利用可能一覧であり、既存ペイン固有の `--models` や実行中に拡張が変えた scope は引き継がない。`--list-models` は `enabledModels` による巡回対象だけの一覧でもない
- Pi の一覧表示形式と RPC、Codex App Server の API、OpenCode 2 の API に依存する。読めなくなってもデフォルト起動は残す。モデル一覧が読めて effort だけ取得できない場合は、選んだモデルを CLI の既定 effort で起動できる
- 同じ `high` でもモデル間で計算量や品質が等しいとは扱わない。OpenCode の variant は推論以外の設定も含み得るが、hwc で内容を解釈しない
- OpenCode のサービスが止まっている場合、選択肢は取得できない。デフォルト起動による通常の CLI のサービス起動に任せる
- OpenCode の新規セッション作成後にエージェント起動が失敗すると、未使用の空セッションが残ることがある。既存セッションを消す危険を避けるため、自動削除しない
