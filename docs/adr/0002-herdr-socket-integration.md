# ADR 0002: Herdr へはソケット API を主経路にする

- Status: Accepted
- Date: 2026-10-20

## Context

Herdr は WSL2 上で動作し、BFF も同じ環境で動く。CLI のプロセス起動では状態変化を購読できず、ポーリングになる。

## Decision

Herdr のローカルソケット API を主経路とし、CLI は `herdr api schema` による型取得とデバッグに限定する。1本の接続でリクエストとイベント購読を扱えるため。

## Consequences

- 再接続、`events_lost` 時の再購読とスナップショット再取得を実装する必要がある
- Herdr が BFF と同じマシンで動いていることが前提になる
- ソケットにファイル転送は無いため、画像は一時ファイルへ書き出してパスを送る

## References

- https://herdr.dev/ja/docs/socket-api/
