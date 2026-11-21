# Herdr へはソケット API を主経路にし、構造と名前の正は Herdr に置く

- Status: Accepted

## Context

Herdr は WSL2 上で動作し、BFF も同じ環境で動く。CLI のプロセス起動では状態変化を購読できず、ポーリングになる。

hwc は Herdr TUI を補う Web 画面で、同じワークスペースを TUI でも操作する。hwc が並びや名前を別に持つと、TUI と食い違う。

Herdr はシェルの `cd` やブランチの切り替えをイベントで知らせない。エージェントのいないシェルのペインでは、Herdr のイベントが起きるまで hwc の表示が古いまま残る。

## Decision

- Herdr のローカルソケット API を主経路とし、CLI は `herdr api schema` による型取得とデバッグに限定する
- 購読を張った接続はイベント専用にする。`session.snapshot` などのリクエストを同じ接続へ送るとサーバーが接続を閉じるため、購読用と通常リクエスト用で接続を分ける
- ワークスペース・タブ・ペインの構造、並び、名前の正は Herdr に置き、hwc は複製を保存しない。並べ替えなどの変更は Herdr へ書き（`workspace.move_block` など）、TUI の並びも同じく変わることを受け入れる。表示だけの差し替え（シェルで動いているコマンドをタブ名に出すなど）は、Herdr のラベルを書き換えない
- イベントの無い変化は、画面が可視の間だけ client が一定間隔で `POST /api/state/refresh` を呼び、BFF が状態を取り直して追う。変化の無い状態は SSE に流さない。非表示の間は止め、可視に戻った時点で 1 回呼ぶ。git のネットワーク操作（fetch / pull）は自動では行わない
- Herdr が管理しないスペースの重複などを、hwc が自動で閉じたり作成を止めたりしない。束ねて見せるのは client の派生ビューに限る
- 完了（`done`）の既読は hwc に持たず、`agent.focus` で Herdr の seen を進める。Herdr は `idle` と `done` をサーバー側の seen で区別し、seen は明示的な focus でしか進まない。`agent.focus` は TUI のフォーカスも動かすことを受け入れ、送るのはアクティブ一覧から開いた `done` のペインを見終えて離れたときだけにする。分割などの他の操作では focus を指定せず、TUI を見ている人のフォーカスを奪わない

## Consequences

- 再接続、`events_lost` 時の再購読とスナップショット再取得を、別接続の組み合わせで実装する必要がある
- Herdr が BFF と同じマシンで動いていることが前提になる
- ソケットにファイル転送は無いため、画像などは BFF がファイルへ書き出してパスを送る（[添付](attachments.md)）
- 既読は Herdr の seen なので、どの端末で開いても既読になる。端末ごとに既読を分けられない
- 送信は Herdr の受理までしか保証されない。入力がエージェントに届いたかは、エージェントのセッションか `agent_status` で知る
- 取り直しの間隔は端末ごとの設定で、オフにすると Herdr のイベントが起きるまで cwd とブランチを追わない（[状態の置き場所](state-storage.md)）

## References

- [Herdr Socket API](https://herdr.dev/ja/docs/socket-api/)
