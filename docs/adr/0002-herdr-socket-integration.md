# ADR 0002: Herdr へはソケット API を主経路にする

- Status: Accepted
- Date: 2026-10-20

## Context

Herdr は WSL2 上で動作し、BFF も同じ環境で動く。CLI のプロセス起動では状態変化を購読できず、ポーリングになる。

## Decision

Herdr のローカルソケット API を主経路とし、CLI は `herdr api schema` による型取得とデバッグに限定する。購読を張った接続はイベント専用になる。`session.snapshot` などのリクエストを同じ接続へ送るとサーバーが接続を閉じるため、購読用と通常リクエスト用で接続を分ける。

## Consequences

- 再接続、`events_lost` 時の再購読とスナップショット再取得を、別接続の組み合わせで実装する必要がある
- 購読接続ではリクエストを送れない（送ると切断される）
- Herdr が BFF と同じマシンで動いていることが前提になる
- ソケットにファイル転送は無いため、画像は一時ファイルへ書き出してパスを送る

## References

- https://herdr.dev/ja/docs/socket-api/
