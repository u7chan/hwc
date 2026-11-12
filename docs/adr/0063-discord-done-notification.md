# ADR 0063: 司令塔の完了を Discord Webhook で通知する

- Status: Accepted
- Date: 2026-11-12
- Revises: [ADR 0054](0054-favicon-parent-status.md) の「プッシュ通知は持たない」
- Revises: 2026-11-12 に要対応（blocked）の通知と設定画面のラベルを追加（[ADR 0068](0068-discord-blocked-notification.md)）

## Context

hwc を開いていない間（スマホが別アプリ・画面ロック中など）は、エージェントの完了に気付けない。[ADR 0054](0054-favicon-parent-status.md) のファビコンはタブを見ている間しか効かず、スマホではタブが凍結される。

主な用途は、PR の作業が収束したときに、人間が Discord の通知から PR を開いてレビューすること。通知本文に PR の URL を入れる。

hwc は認証なしで LAN に公開している（[ADR 0010](0010-lan-access.md)）。Webhook URL はブラウザを閉じても送れるよう、サーバー側に保存する。

## Decision

### トリガー

- スペースの親ペイン（左端のタブから最初のエージェント。`parentPaneOf`）が `done`
- かつ、そのスペースの `agent !== null` のペインが全員 `done` または `idle`。`working` / `blocked` / `unknown` が 1 つでもいれば送らない。シェルのペインは数えない。親のいないシェルだけのスペースは対象外
- この状態に **入った瞬間** に 1 回だけ送る。`done` のまま留まっている間は再送しない
- 子の `done → idle`（人間が開いた）は条件に含むので、それだけでは再送しない。親が `done` を離れて戻った場合や、誰かが `working` / `blocked` に戻って再び全員 `done` / `idle` になった場合は、その山ごとに 1 回送る
- 起動直後・再接続直後（`StateStore.breakObservation` の後）は基準を作るだけで送らない。購読後の最初の publish は、`observed` の値に関係なく基準にする
- 前回の settled 集合は判定と同時に更新する。PR 取得・送信の完了は待たない
- 通知が無効・URL 未登録でも settled の追跡は続ける。有効化した時点で既に settled なら送らない（過去に遡らない）
- 送信直前に `store.get()` と設定を読み直し、スペースが settled でなくなった・通知が無効になった・URL が消えた場合は送らない

### 通知する対象

- `PR の作業だけ`（既定）: 既存の PR リーダーでブランチの最新 PR を `refresh: true` で引く。**最新** PR が `OPEN` のスペースだけ送る。古い open が残っていても、より新しい `MERGED` / `CLOSED` が最新なら送らない。PR が無い・最新が open でない・`gh` で確認できないときは送らない。本文に PR 番号・タイトル・URL を入れる
- `すべての作業`: PR を引かない。ワークスペース名とブランチだけで送る（ブランチが null ならブランチ行を出さない）。PR のない調査・雑務も、`done` の山ごとに送る

PR の作成そのものはトリガーにしない。トリガーは常に完了時だけ。

### 保存と API

- 保存先: `$HWC_STATE_DIR/notifications.json`（[ADR 0018](0018-pasted-image-attachments.md)）
- 0600 で書く。壊れた JSON は既定値に落とし、項目ごとに検証する（不正な URL は `null`、不正な scope は `"pull-request"`、不正な enabled は `false`）
- 書き込みは一意な tmp に `{ mode: 0o600 }` で書き、必要なら chmod してから rename する。固定名の tmp は使わない（[ADR 0018](0018-pasted-image-attachments.md) の `pane-times.json` とは別）。同期書き込みで直列化し、成功後にメモリ上の設定を更新する。失敗時は 500 と旧設定を返す
- API は全 URL を返さず、`{ enabled, scope, discord: { configured, hint } }` を返す。`hint` はトークン末尾 4 文字（例: `…a1b2`）
- エンドポイント: `GET` / `PUT /api/notifications`、`PUT` / `DELETE /api/notifications/discord`、`POST /api/notifications/discord/test`
- テスト通知は保存済み URL にだけ送る。未保存の URL を試す口は作らない。有効・無効と scope に関係なく送る。テストは送信完了まで await し、自動送信だけ fire-and-forget
- クライアントは HTTP status ではなく `error` コードで文言を決める。BFF の 404 と Discord の 404 を混同しない
- 自動送信は状態の publish を待たせない。失敗は URL を出さず、失敗が続く間だけ 1 回ログする

### Webhook URL の検証

Webhook URL は資格情報であり、同時に BFF が POST する先でもある。任意の URL を叩かせないため、次だけを受け付ける。

- `https` の `discord.com` だけ。サブドメイン・別ホスト・既定以外の port・認証情報は受けない
- パスは `/api/webhooks/<id>/<token>` だけ。`<id>` は数字、`<token>` は `[A-Za-z0-9_-]+`、URL は 512 文字まで。query / fragment は受けない
- `fetch` は `redirect: "manual"`。3xx は追わずに失敗にする。追うと、検証したホスト以外へ本文が渡りうる
- 保存前に BFF でも同じ検証を通す。クライアントの検証は入力の手助けで、正は BFF

### 送信

- `POST <url>?wait=true` に `{ content, allowed_mentions: { parse: [] } }` を送り、8 秒で打ち切る。`@everyone` / `@here` を無効化する
- 自動送信の再試行はしない。Discord の 429 も自動では再送しない（テスト通知は結果だけ返す）
- 応答: 200 / 204 は成功。401 / 403 / 404 は `discord_invalid_webhook`、429 は `discord_rate_limited`（`retryAfter` 付き）、3xx・その他の 4xx / 5xx・timeout・ネットワーク失敗は `discord_unavailable`

### 本文

PR の作業だけ:

```text
hwc: PR #228 の作業が完了しました
<PR title>
<PR URL>
```

すべての作業:

```text
hwc: <workspace label> が完了しました
ブランチ: <branch>
```

テスト:

```text
hwc のテスト通知です。このチャンネルに完了通知が届きます。
```

### 設定画面

既存の設定画面に「通知」セクションを足す。別画面は作らない。スイッチ（`role="switch"`）、scope のラジオ、Discord の登録・テスト・変更・削除を 1 か所に置く。

- Webhook URL は登録済みなら末尾 4 文字だけ出す。変更は空の入力から始め、登録済みの URL は返さない
- テスト送信中はボタンを無効化し、結果をその場に出す。クライアント側に 15 秒の期限を置き、BFF に届かないときに送信中のまま残らないようにする
- 変更中は操作を無効化し、成功した応答でスナップショットを丸ごと置き換える
- GET が失敗したときは「未登録」と表示しない。読み込み失敗と再試行を分け、既存 URL を意図せず上書きしない
- Discord のマークは SVG を `icons.tsx` に持つ。外部 CDN は読まない。色は `--color-discord` にまとめる

### E2E

`HWC_E2E_DISCORD_WEBHOOK_SINK` が設定されていれば、Webhook へ POST せずに送信内容をそのファイルへ追記する。`e2e/serve.ts` は一時ディレクトリの sink を指す。**本番では設定しない**（設定すると通知が届かず、本文がファイルに残る）。

## Consequences

- Herdr の `done` は未読状態。人間がペインを開いて `idle` にすると、その後の子の完了で通知されないケースがある（親を開いた時点で人間が気付いている扱い）
- PR の作業だけでも、レビューラウンドごとに settled になれば複数通知が飛ぶ。1 PR に 1 通にしたい場合は PR 番号での dedupe が別途必要
- `gh` が未認証・オフライン・タイムアウトのときは PR を確認できず、PR のみの scope では通知が飛ばない。通知を優先するなら「すべての作業」に切り替える
- fork 運用で upstream にだけ PR がある場合、`gh pr list --head <branch>` はチェックアウトの remote を見るため PR を見つけられない（[ADR 0043](0043-pane-head-pull-request.md) と同じ制約）
- **LAN に認証が無い**（[ADR 0010](0010-lan-access.md)）ため、LAN 内の誰でも Webhook URL を差し替えられる。以後の PR タイトル・URL を攻撃者の Discord へ流して作業内容を漏えいさせたり、削除して通知を止めたりできる
- 設定画面は平文 HTTP で Webhook URL を送るため、LAN 上では資格情報がそのまま見える。ADR 0010 の範囲で許容するが、信頼できないネットワークでは使わない
- hwc の複数タブ間で通知設定は自動同期しない。設定画面を開き直したときに BFF から読み直す
- ファビコン（ADR 0054）の挙動は変えない。通知は Discord だけに足す

## Alternatives

- **ブラウザの Notification API / Web Push**: スマホの画面ロック中に届かせるには Service Worker と購読の保存が要り、iOS の制約も大きい。Discord は既に通知の受け口として使っている
- **任意の Webhook URL を受け付ける**: Slack などへも送れるが、BFF が任意の URL へ POST できることになる。SSRF の入口を作らないため、Discord の正規形だけに限る
- **ペインが `done` になるたびに送る**: 子が終わるたびに鳴り、収束したかどうかが分からない。親と全エージェントの settled で 1 回に絞る
- **サーバーに再送キューを持つ**: 429 や一時的な失敗に強くなるが、重複送信と状態の永続化が増える。今回は送らない方向に倒し、必要なら「すべての作業」に切り替える
- **ワークスペースごとの設定**: 細かく制御できるが、設定の置き場所と UI が増える。まずは全体で 1 つ
