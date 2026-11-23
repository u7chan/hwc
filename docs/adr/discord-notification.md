# 完了と要対応を Discord Webhook で通知し、送り先は Discord の正規形だけに限る

- Status: Accepted

## Context

hwc を開いていない間（スマホが別アプリ・画面ロック中など）は、エージェントの完了にも、許可待ちや質問で止まったことにも気付けない。ブラウザのタブのファビコンは見ている間しか効かず、スマホではタブが凍結される。主な用途は、PR の作業が収束したときに Discord の通知から PR を開いてレビューすること。

Webhook URL はブラウザを閉じても送れるよう、サーバー側に置く必要がある。Webhook URL は資格情報であり、同時に BFF が POST する先でもある。hwc は認証なしで LAN に公開している（[LAN 公開](lan-access.md)）。

## Decision

### トリガー

- 完了: スペースの親ペインが `done` で、そのスペースのエージェントが全員 `done` か `idle` になった瞬間に 1 回送る。対象は「PR がある作業だけ」（最新 PR が open のときだけ。本文に PR を入れる）か「すべての作業」から選ぶ
- 要対応: エージェントのペインが `blocked` に入った瞬間に 1 回送る。完了の対象設定に関係なく送り、PR は引かない（`gh` の待ちや失敗で通知を遅らせたり落としたりしない）。同じスペースで同時に止まったペインは 1 通にまとめる。pi の `ask_user` は mypi が `blocked` を報告するので同じトリガーで届く（[pi 連携](pi-integration.md)）
- 状態に留まっている間は再送しない。起動直後・再接続直後は基準を作るだけで送らない。有効にした時点で既に該当していても遡らない。送る直前に状態と設定を読み直す

### 保存と API

- 設定は状態ディレクトリの `notifications.json` に 0600 で書く（[状態の置き場所](state-storage.md)）
- API は Webhook URL 全体を返さず、末尾 4 文字のヒントだけを返す。テスト通知は保存済みの URL にだけ送り、未保存の URL を試す口は作らない

### 送り先の検証と送信

- 受け付けるのは `https://discord.com/api/webhooks/<数字>/<[A-Za-z0-9_-]+>` だけ。サブドメイン・別ホスト・既定以外の port・認証情報・query・fragment は受けない。正は BFF の検証で、client の検証は入力の手助け
- `fetch` は `redirect: "manual"` にし、3xx は追わずに失敗にする。追うと、検証したホスト以外へ本文が渡り得る
- 本文に `allowed_mentions: { parse: [] }` を付け、`@everyone` / `@here` を無効にする
- 自動送信は再試行しない。429 も再送しない。失敗は URL を出さずにログする

## Consequences

- LAN 内の誰でも Webhook URL を差し替えられる。以後の PR タイトル・URL を攻撃者の Discord へ流したり、削除して通知を止めたりできる。設定画面は平文 HTTP で URL を送る。LAN 公開の範囲で許容し、信頼できないネットワークでは使わない
- Herdr が `blocked` にしない確認（pi のフォルダ信頼確認）は届かない。pi の `ask_user` は blocked なので届く
- `gh` が使えないと、「PR がある作業だけ」では完了通知が飛ばない
- レビューのラウンドごとに収束すれば、同じ PR で複数回届く

## Alternatives

- **Notification API / Web Push**: 画面ロック中に届かせるには Service Worker と購読の保存が要り、iOS の制約も大きい
- **任意の Webhook URL を受け付ける**: Slack などへも送れるが、BFF が任意の URL へ POST できる SSRF の入口になる
- **サーバーに再送キューを持つ**: 一時的な失敗に強くなるが、重複送信と状態の永続化が増える
