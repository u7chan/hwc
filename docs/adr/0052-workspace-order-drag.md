# ADR 0052: 「すべて」の並び替えは Herdr のワークスペース順を動かす

- Status: Accepted
- Date: 2026-11-09

## Context

`すべて` のツリーは `groupWorkspaces` が Herdr のワークスペース順で束ねる。ワークツリーが増えると、よく使う束が下に埋もれる。束の並びを手で決めたいという要求がある。一方、`アクティブ` は状態順（[ADR 0050](0050-active-lists-every-agent.md)）で、動的な「自分が動く番」の順であり、地図としての `すべて` とは役割が違う。

並びの保存先として、BFF に JSON を持つ案と、Herdr の順序を動かす案を比べた。Herdr は `workspace.move` と `workspace.move_block`（複数 id を `before_workspace_id` の前へアトミックに移動）を持ち、BFF は `workspace.moved` / `workspace.reordered` を既に購読して状態を取り直している。BFF に別の順序を持つと、ネイティブ Herdr と Web で順序が 2 つになり、新規・消滅時の規則と、`アクティブ` の同順位（ADR 0050 の state の並び）との不一致を抱える。

## Decision

### 正とする順序

- 並びの正は Herdr のワークスペース順。HWC は保存も移行もしない。
- ネイティブ Herdr のワークスペース番号・移動キーも同じ順を使う。HWC から並べ替えるとネイティブ側も変わる。これは受け入れる（利用者は TUI でも同じ並びを期待している）。
- `すべて` の束の位置は、束に属するワークスペースのうち最も早いものの位置。束を動かすときは、束の全 id を現在の相対順のまま `workspace.move_block` に渡す。単一の `workspace.move`（`insert_index`）は使わない。linked worktree が束から離れるため。
- `アクティブ` の並びは変えない。同順位の tie-break は state の並びなので、結果として手で決めた順が効く（ADR 0050 のまま）。

### 操作

- 動かせる単位は `すべて` の最上位ブロック（リポジトリ束、またはワークツリーを持たない単独スペース）。
- 見出しの長押し（タッチ）／わずかな移動（マウス）で掴む。ドラッグ中は、掴んだ束のカードを破線の青い枠で囲み、見出しは読める濃さのまま中身を淡くし、指の近くに束の名前を浮かせ、落とし先の境界に「ここに移動」の線を出す。カードの角丸に枠も沿わせる。落とした後は、束と周囲のブロックを新しい位置へ短く動かして入れ替わりを見せる（`prefers-reduced-motion` では動かさない）。一覧の上端・下端では自動スクロールする。
- キーボードは、フォーカス中の見出しの ↑ / ↓ で 1 つ動かす。移動結果は visually hidden の status で読み上げる。
- 掴むための専用ハンドルは置かない。常設の列を増やさず、既存の見出しの操作（開閉）と競合しないよう、タッチは長押し、マウスは移動量で見分ける。
- 落としても意味が変わらない位置（現在地と同じ）なら送らない。

### BFF

- `POST /api/workspaces/move`。body は `{ workspaceIds: string[], beforeWorkspaceId: string | null }`。`beforeWorkspaceId` が null なら末尾。
- `application/json` 以外は 415。空・非文字列・重複・アンカーがブロック内は 400。状態に無い id は 404 `workspace_not_found`。Herdr の `workspace_not_found` は 404、`invalid_params` / `invalid_request` は 400、それ以外は 502 `herdr_unavailable`。
- 成功したら応答前に `store.refresh()` で状態を取り直す。イベントでも取り直すが、応答と SSE の前後で古い順に戻って見えるのを避ける。応答は `{ ok: true }`。
- 状態は保存しない。再起動後も Herdr のセッションに残る。

### 失敗時

- 一覧は Herdr の順のまま。一覧の上に「並べ替えを保存できませんでした。」を `role="alert"` で出し、次の移動で消す。
- 楽観的な並びは持たない。応答が返る時点で BFF の状態は更新済みで、SSE が全クライアントへ配る。

### E2E

- `e2e/fake-herdr.ts` に `workspace.move_block` を足し、`workspace.reordered` を流す。実 Herdr には触れない。

## Consequences

- HWC の並べ替えはネイティブ Herdr の並びと番号を変える。HWC だけ別の並びにすることはできない。
- 新規スペースは Herdr が決めた位置（通常は末尾）に付く。よく使う束は、また動かすまでその位置に残る。
- 束の中の linked worktree は、動かしても束から離れない（`move_block` でまとめて動かすため）。
- `アクティブ` の同順位は手で決めた順に従う。状態の優先（blocked → done → working → idle → unknown）は変わらない。
- 保存ファイル、掃除、移行、id の再利用対策は要らない。
- 並べ替えの入口は `すべて` だけ。`アクティブ` の帯は状態順のまま。
- ドラッグはポインタ操作。タッチの長押しは実機で確認する（E2E はマウス経路）。
- 入れ替えのアニメーションは、新しい順序がサーバーから届いてから始まる。応答が遅い場合はその分だけ待つ。

## Alternatives

- **BFF に並びを JSON で持つ**: 二重管理。キーを workspace id にすると束の単位と合わず、repo 名にしても `アクティブ` の tie-break と `すべて` で順序が割れる。新規・消滅時の規則と掃除も要る。
- **お気に入り / ピン留め**: 順序と同じ大きさの状態に、解除の操作が増える。「任意の位置」が要件なので、順序そのものを動かす方が小さい。
- **メニューの「上へ / 先頭へ」だけ**: 実装は小さいが、任意の位置には届かない。同じコマンドの上に後からドラッグを足せるので、ドラッグを先に作る。
- **単一の `workspace.move` を繰り返す**: 束の移動が複数リクエストになり、途中で失敗すると束が割れる。`move_block` はアトミック。
- **HTML5 Drag and Drop**: iOS で動かない。主端末が iOS なので採らない。

## References

- [ADR 0050](0050-active-lists-every-agent.md) — `アクティブ` の並びと同順位
- [Herdr Socket API](https://herdr.dev/ja/docs/socket-api/) — `workspace.move` / `workspace.move_block`
