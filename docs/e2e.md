# E2E

E2E のスクリーンショットを PR に貼るため、実 Herdr のワークスペース名・ブランチ・ユーザー名・パス・会話を画面に出さない。開発用の BFF（:30000）は実 Herdr につながっているので、E2E には使わない。

## 起動

```bash
bun run e2e:serve
```

`http://127.0.0.1:31000/` を Playwright CLI で開く。ポートは `PORT` で変えられる。`HOST` は `127.0.0.1` に固定する。

起動ログの `hwc ready: ... (e2e)` と、設定画面の revision `e2e` で、架空環境であることを確認できる。

## 実環境との分離

| 対象           | 実環境                       | E2E                                                 |
| -------------- | ---------------------------- | --------------------------------------------------- |
| Herdr ソケット | `~/.config/herdr/herdr.sock` | `HERDR_SOCKET_PATH` を一時ディレクトリへ向ける      |
| pi セッション  | 実セッションの JSONL         | `e2e/fixtures/scenario.ts` が一時ディレクトリへ書く |
| ブランチ       | 実リポジトリの `.git/HEAD`   | 一時ディレクトリの `.git/HEAD`                      |
| 添付の保存先   | `~/.local/state/hwc`         | `HWC_STATE_DIR` を一時ディレクトリへ向ける          |
| ポート         | 30000                        | 31000                                               |

`e2e/serve.ts` が架空 Herdr を起動してから `src/server.ts` を読み込む。BFF とクライアントは本番コードのままで、ソケット経路・状態同期・チャット読み取りを通る。実 Herdr のソケットには接続しない。

## 架空 Herdr

`e2e/fake-herdr.ts` が Unix ソケットで次のメソッドに応答する。

- `session.snapshot`
- `events.subscribe`
- `pane.read`
- `pane.send_input`
- `pane.send_keys`
- `agent.focus`
- `pane.close`

`pane.close` はスナップショットからペインを消して `pane.closed` を流す。`agent.focus` はフォーカスを移して `pane.focused` を流す。`pane.send_keys` は `esc` を受けるとペインの `agent_status` を `idle` に戻し、`pane.updated` を流す。BFF は実 Herdr と同じようにイベントで状態を取り直す。

`pane.send_input` は送信 text を端末出力へ追記し、`agent_session`（`kind: "path"`）を持つペインでは架空セッションの JSONL にも追記する。追記するのは user メッセージ 1 行だけで、それまでの葉を `parentId` にする。確定後の送信カードを画面で確かめるために要る。

追記しない条件:

- `agent_session` を持たないペイン（シェルや、会話を読まないペイン）。端末出力にだけ追記する
- text が空、または空白だけの送信
- 添付注記（`<attached_files>`）の無い `/new` と `/compact`（`/compact <指示>` を含む）。会話を残さないか、履歴を置き換える

添付を持つペインの `Enter` は常に本文の送信になる（[ADR 0018](adr/0018-pasted-image-attachments.md)）。`/compact` と打っても添付と一緒に送れば本文として扱われるので、注記があるときはコマンドではなく通常本文として追記する。

## データを変える

`e2e/fixtures/scenario.ts` を編集する。ワークスペース、タブ、ペイン、端末出力、pi セッション、ブランチはすべてここで作る。

実在のユーザー名・ホスト名・リポジトリ名・パスを書かない。スクリーンショットに写る値はすべて架空にする。

## 禁止

- 実 Herdr につながった BFF（:30000）の画面をスクリーンショットに撮らない。
- 実 pi セッションを fixture にコピーしない。
- 架空環境の確認なしに、E2E の画像を PR へ貼らない。
