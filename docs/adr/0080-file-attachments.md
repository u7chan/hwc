# ADR 0080: 画像以外のファイルも添付できるようにする

- Status: Proposed
- Date: 2026-11-13
- Revises: [ADR 0018](0018-pasted-image-attachments.md) の添付を画像 3 形式に限る判断、[ADR 0055](0055-composer-add-menu.md) の「画像を追加」の受け付け

## Context

添付の受け口は paste / drop / + メニューのファイル選択の 3 つで、いずれも `image/*` に絞っている（[ADR 0018](0018-pasted-image-attachments.md)、[ADR 0055](0055-composer-add-menu.md)）。`image/*` 以外のファイルは、ドロップしても既定動作を止めるだけで何も起きない。

欲しいのは画像以外のファイルで、主な用途は Windows のダウンロードフォルダやデスクトップにある zip、xlsx / docx、csv。スマホでは写真ピッカーではなくファイル選択から選ぶ。

既存の制約:

- エージェントへの渡し方は本文末尾の `<attached_files>` 注記に絶対パスを並べるだけで、モデルへ実体を注入しない（[ADR 0018](0018-pasted-image-attachments.md)）。BFF とエージェントは同じユーザーで動くので、パスを渡せば読める
- `MAX_ATTACHMENT_BYTES`（10MB）は添付の受け付けと、エージェントが本文に書いたファイルのプレビュー配信（`src/server/message-files.ts` の実在確認と読み込み）で共有している
- `isAttachmentName` は保存名の検証、配信してよい名前の allowlist、送信 body の名前検証、クライアントの応答検証を兼ねている
- アップロードは生バイトを全量 `arrayBuffer()` で受けてから書き出す。クライアントは最大 4 件を並列に投げる
- `read` で開けるのはテキストと画像だけ。この環境には `unzip` / `7z` / `libreoffice` / `openpyxl` が無く、zip は `python3 -m zipfile`、xlsx / docx は zip の中の XML を手で扱うことになる。CSV はそのまま読める

上限は 25MB とする。zip の主用途をカバーしつつ、全量バッファ + 4 並列の同時保持（最大 100MB）を許容範囲に収めるため。100MB にすると同時保持が 400MB になり、読み込み中の複製も含めると常駐プロセスの余裕が無くなる。

## Decision

- 保存先は画像と同じ `$HWC_STATE_DIR/attachments/<pane-id>/`（[ADR 0018](0018-pasted-image-attachments.md) の規則を変えない）。種別で木を分けない
- 保存名は画像も非画像も **元のファイル名** を残す（パス区切りを落とした後の 1 セグメント）。`pasted-<timestamp>.<ext>` の新規発行はやめる。既存の名前はそのまま配ってよい
- 名前の sanitize は `src/shared/attachments.ts` の 1 か所に集約する。パス区切り（`/` `\`）と注記の区切り（`<` `>`）、制御文字（C0 / DEL / C1）を落とし、NFC に正規化し、先頭の `.` と `-` を落とし、末尾の空白と `.` を落とす。拡張子を残したままコードポイントの境界で UTF-8 200 バイトへ切り詰め、切り詰めで戻った末尾の空白と `.` をもう一度落とす。空になったら拒否する。検証は「sanitize しても名前が変わらないこと」で行い、`attachmentFilePath` はこの検証を通った名前だけを連結する。衝突は拡張子の前に `-1`、`-2` と連番を足し、上書きしない
- 保存名の検証を 2 つに分ける。`isStoredAttachmentName` は保存・`attachmentFilePath`・履歴の strip・送信 body の名前に使い、`isImageAttachmentName: isStoredAttachmentName && 拡張子が画像 3 形式` を配信と `Content-Type` の決定に使う。配信 allowlist は広げない。非画像の名前は配信で 400 にする（保存名として正しいかは見ない）
- アップロードは生バイトのまま、元のファイル名を `X-HWC-Filename`（UTF-8 を percent-encode）で受ける。ヘッダが無い、decode できない、長すぎる、sanitize すると空になる要求は body を読む前に 400。型と上限は拡張子で決め、`Content-Type` は見ない（zip や Office 文書は `application/octet-stream` や空文字で来る）。`Content-Type` の allowlist による 415 は無くなる
- 上限は種類別に分ける。`MAX_IMAGE_ATTACHMENT_BYTES` = 10MB、`MAX_FILE_ATTACHMENT_BYTES` = 25MB。種別は受け取った名前の拡張子で決める。`MAX_ATTACHMENTS` は 4 件のまま、画像と非画像の合計で数える。413 は `attachment_too_large` だけを返し、クライアントが種別ごとの上限を文言にする
- クライアントは送る前に `file.size` を拡張子から決めた上限と比べ、超えていればアップロードしない。25MB を LAN 越しに送り切ってから 413 を出すのは遅い。BFF の 413 は同じ文言の防御として残す
- プレビュー配信（`src/server/message-files.ts`）の上限は `MAX_PREVIEW_FILE_BYTES` = 10MB として別の定数にする。添付の上限を上げても、会話を開くたびに読む量は変えない
- 非画像は配信しない。`GET /api/panes/:id/attachments/:name` は画像 3 形式だけを返す。ダウンロード導線も作らない。入力欄のチップも履歴も、非画像は名前だけのチップにしてリンクにしない
- 受け口は paste / drop / + メニューの 3 つとも `image/*` の絞り込みを外す。+ メニューの項目名を「ファイルを追加」にし、`accept` を付けない。形式による拒否は無くすので、未対応形式の notice は消す
- 注記はパスだけのまま、種別やサイズを書き足さない。hwc はエージェントが読める形式を知らない

## Consequences

- 25MB の添付 4 件で最大 100MB が同時にメモリへ載る。`arrayBuffer()` の結果を `Uint8Array` に移し、`writeFile` へ渡す間は複製が残るので、瞬間的にはこれより増える。ストリーム保存はしない
- zip / xlsx / docx / pdf は、パスだけ渡されてエージェントが `read` で開けずに止まり得る。hwc は展開も変換もしない。注記にヒントを足すかは、実際に詰まってから決める
- 掃除の手段は持たないまま（[ADR 0018](0018-pasted-image-attachments.md)）。25MB の孤児が残り得る
- 名前が利用者由来になるぶん、sanitizer が履歴・注記・URL の公開面に直結する。固定書式（`pasted-...`）に比べて検証コードが増え、`pasted-` 前提の正規表現は使えなくなる
- strip は保存名の検証だけを見るので、利用者が本文に `<attached_files>` と同じ形の注記を自分で書くと、その basename が添付として並び得る（画像なら配信 URL が 404 になるだけ、非画像なら名前だけのチップ）。[ADR 0018](0018-pasted-image-attachments.md) の「自分で書いた注記も strip の対象になり得る」と同じ性質
- 拡張子で型を決めるので、拡張子と中身が食い違うファイルもそのまま保存される。配信しないので害はない
- `.html` や `.svg` も保存対象になる。配信 allowlist を画像 3 形式に固定している限り、同一オリジンでスクリプトは動かない。将来配信を広げるときは、保存名の検証とは別に allowlist を決め直す必要がある
- 古いバンドルを掴んだクライアントは `X-HWC-Filename` を送らないので、リロードするまでアップロードが 400 になる
- 非画像はブラウザから取り出せない。ファイルそのものが要る場面は、ホストの保存先を直接開くことになる

## Alternatives

- **`attachments/` と別の `files/` に分ける**: 上限や保持期間を種別で分けやすいが、保存・検証・注記・strip の経路が 2 系統になる。上限は種類別の定数で足りるので採らない
- **ペインの cwd（チェックアウト）配下に置く**: エージェントが相対パスで開けて `git` にも乗るが、作業ツリーを汚し、ペインの作り直しでパスが変わる（[ADR 0018](0018-pasted-image-attachments.md) で却下済み）
- **上限を 100MB にする**: 全量バッファ + 4 並列で同時保持が 400MB になる。ストリーム保存と `maxRequestBodySize` の明示が前提になる
- **保存をストリーム化する**: 大きな上限に耐えるが、中断時の部分ファイル削除と、書きながらのバイト数検査が要る。25MB なら不要
- **`Content-Type` で型を決める**: 画像では成立していたが、zip と Office 文書は `application/octet-stream` や空で来る。拡張子の方が実態に合う
- **ファイル名を query で送る**: ヘッダを増やさずに済むが、名前がアクセスログと Referer に残り、URL の長さ上限にも当たる。multipart にすると、生バイトの `Content-Length` 事前検査が境界とオーバーヘッド込みの値になり、今の受け口を作り直すことになる。`Content-Disposition: filename*` は応答用の規格で、要求での解釈が実装依存になる。ASCII に閉じた独自ヘッダを採る
- **BFF で zip を展開し、xlsx を CSV に変換する**: エージェントが中身に届きやすくなるが、失敗時の扱いと変換ツールの有無という前提が hwc に増える。まずパスを渡すだけにする
- **画像だけ `pasted-<timestamp>` のまま残す（名前規則を 2 つ持つ）**: 画像の配信 allowlist をそのまま使えるが、保存名の生成と検証が種別で分岐する。採らない
