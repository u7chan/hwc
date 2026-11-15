# ADR 0089: Web からの過去の発言の編集は pi の rewind を 2 相で送る

- Status: Accepted
- Date: 2026-11-16

## Context

hwc の会話は読み取り専用で、過去の自分の発言を直すには TUI の `/tree` で戻り、入力し直す必要がある。スマホではこの操作が難しい。一方、hwc は TUI のキー操作を汎用には送らない。ピッカーを開いてしまった場合に、GUI から選べず取消もできないため（[ADR 0016](0016-composer-command-chips.md)）。

pi のセッションは `id` / `parentId` の木で、`ctx.navigateTree(targetId, { summarize: false })` は現在の葉を対象の親へ移す。pi 1.5.2 では移動後に TUI を再描画するため、Web から戻しても TUI が古いまま残ることはない。ただし Herdr のソケット API に分岐操作はなく、hwc から pi のプロセスを直接呼ぶ経路も無い。

そこで mypi 側に `/hwc-rewind <entryId> <requestId>` を置き、hwc は通常の入力としてこのコマンドを送る。戻すのは会話だけで、ファイルの変更は戻さない。対象は pi のテキスト発言に限り、添付付きの発言は対象外にする。利用者に見せる語は「戻す」ではなく「編集」とする。

## Decision

### capability と `canRewind`

- mypi は `HERDR_PANE_ID` を持つセッションの開始時に、`pi.appendEntry("hwc-capabilities", { v: 1, rewind: true })` を 1 回だけ追記する。追記に失敗してもセッションは止めない
- BFF はセッション中に `customType: "hwc-capabilities"` かつ `data.v === 1 && data.rewind === true` のエントリがあれば `ChatSnapshot.canRewind = true` を返す。存在だけでは判定しない。`canRewind` は省略可能なフィールドとし、pi 以外の reader は設定しない
- capability の探索は active branch に限らない。reader はファイル全体を読むため、過去の枝に capability があっても true にする。これは編集の途中で rewind して capability が active branch から外れる場合に必要になる。reader のリセット時に false へ戻す
- capability が無いセッション（mypi が未導入、古いセッション）は、クライアントに鉛筆を出さない。BFF も `not_editable` にする

### クライアント

- 鉛筆はユーザーメッセージのメタ行（コピーの隣）に置く。`aria-label` は「このメッセージを編集」とし、押してもまだ rewind しない。発言の本文を入力欄へ移すだけにして、誤タップで会話を失わないようにする
- 鉛筆を出す条件は、pi のチャットペインで `canRewind === true`、`agentStatus !== "working"`、通常送信中でない、編集中でない、セッション由来の user 行（送信控えでない）、本文が空でない、添付が無い、最後のセッション行でない、のすべてを満たすこと。最後の行は葉のことがあり、`navigateTree` が no-op になるため除く。葉の判定は表示中の `messages` の末尾で近似する（後述）
- 編集状態は対象の entry id・`requestId`・本文だけを持つ。下書き（`draft`）と添付は触らない。入力欄には編集中だけ編集本文を表示し、× で編集状態と編集本文だけを捨てる。編集中は + メニュー・コマンド候補・添付・停止を出さず、引用は編集本文へ足す
- 送信はフォームの submit を編集用に分岐する。成功したら編集状態を閉じ、会話を再取得する。下書き・添付は消さず、送信控え（echo）も積まない。失敗したら編集状態と本文を残す。`send_failed` かつ `rewound: true` のときは「会話は戻りましたが、送信できませんでした。もう一度送信してください」と出し、同じ `requestId` で再送できるようにする
- `requestId` は `^[A-Za-z0-9_-]{1,64}$`。`crypto.randomUUID()` は secure context に限られ、LAN の HTTP では使えないため、時刻と乱数から `newRequestId()` で作る

### BFF

- `POST /api/panes/:id/edit-message` の body は `{ messageId, requestId, text }`。`messageId` / `requestId` は同じ ID の形、`text` は空でない文字列に限る。`text` は通常入力と同じ上限を使う
- ペインが pi のチャットを持ち、`agentStatus !== "working"`、フォルダ信頼確認が無いことを確かめる。同じペインで同時に走る編集は 1 つだけ。対象が snapshot の user メッセージで、添付が無く、末尾でないことを確かめる。ただし同じ `requestId` の marker を既に知っている再送では、対象が active branch から外れているためこの検証を飛ばす
- 第 1 相: `panes.send({ paneId, text: "/hwc-rewind <entryId> <requestId>", submit: true })` を送る。mypi は対象の親へ戻り、`customType: "hwc-rewind"` のエントリ `{ v: 1, requestId, targetId, leafId }` を追記する。`leafId` は移動後の葉（対象の親、先頭なら null）で、marker の `parentId` と一致する
- 第 2 相: marker を確認してから、編集後の本文を通常の `panes.send({ submit: true })` で送る。marker は chat reader と共有せず、独立したハンドルでコマンド送信前のファイルサイズから追記分だけを読む。100ms 間隔で最大 10 秒待つ。未完行は消費せず、次回に持ち越す。ファイルが縮んだり置き換わったりしたときは末尾 256KB を読み直し、それでも無ければ `edit_failed` にする
- marker を既に知っているとき（同一プロセスの再送）は、`sentText` が今回の本文と一致すれば成功、一致しなければ本文だけを送る。プロセス再起動後の再送に備え、初回はセッション末尾 256KB も走査する。`sentText` は marker の後に現れた最初の user メッセージの本文
- ペインごとに `Map<requestId, { marker, sentText }>` を持ち、末尾走査で見つけた marker も登録する。Map はペインごとに 64 件までとし、古い要求から落とす。marker はコマンド送信前のサイズから読むため、通常の chat 取得と offset を競合しない
- 本文を送る直前にペインの状態を取り直し、`agentStatus === "working"` なら送らない。marker まで進んで本文を送れなかった場合は `502 { error: "send_failed", rewound: true }`、marker を確認できなければ `502 { error: "edit_failed" }`、対象外は `409 { error: "not_editable" }`、同時実行は `409 { error: "edit_in_flight" }`、フォルダ信頼確認中は `409 { error: "confirmation_pending" }` を返す

### 契約の正

`hwc-capabilities` / `hwc-rewind` の型と ID の形は hwc の `src/shared/rewind.ts` と mypi の実装で同じにする。ADR と Issue が契約の説明を持ち、コードはそこを参照する。marker は LLM の文脈に入らない custom entry とし、会話の本文を汚さない。

## Consequences

- Web から過去の自分の発言を編集すると、pi のセッションに新しい枝ができ、元の枝はファイルに残るが表示されない。TUI も新しい枝を表示する（pi 1.5.2 で再描画を確認）
- 戻すのは会話だけ。ファイル変更・ツール実行・シェルの状態は戻らない。利用者には「編集」と見せるが、実体は会話の分岐である
- mypi の `/hwc-rewind` が無いセッションでは鉛筆が出ない。capability はセッション開始時に 1 回だけ書くため、拡張を入れる前に始めたセッションは `/new` するまで編集できない
- 添付付きの発言は編集できない。ファイルを送り直す経路が別に必要になるため、対象外にした。最後のセッション行も編集できない。エージェントがまだ応答を書いていない user 発言は葉であり、戻す先が無い
- 最後の行の判定は表示中の `messages` で近似する。実際の葉が表示に無いカスタム entry のときは、末尾の user 発言を編集できることがある。その場合 `navigateTree` は対象の親へ戻るので、結果は正しい。ただし応答待ちの短い間は、押しても何も起きない可能性がある
- `send_failed` で `rewound: true` を受け取った後、編集を × でやめると、会話は戻した先（対象の親）に残る。編集前の枝はファイルにあるが、hwc の会話には戻らない。元の枝へ戻す操作は hwc には無い
- `sentText` は marker の直後の user メッセージだけを見る。本文を送った後にセッションが 256KB 以上育つと、再起動後の再送で sentText を見つけられず、対象が active branch に無いため `not_editable` になることがある。requestId は編集ごとに作り直すので、通常の操作では起きにくい
- marker の走査は requestId だけで照合する。同じ requestId を別の対象に再利用すると、別の枝の marker を拾う可能性がある。クライアントは編集を始めるたびに新しい requestId を作る
- BFF の Map はペイン id ごとで、セッションの差し替え（`/new`）を跨ぐ。同じ requestId を新しいセッションで再利用すると、古い marker を成功と誤認する可能性がある。クライアントは編集状態をセッション差し替えで持ち越さない
- marker は custom entry なので、LLM の文脈と会話表示には出ない。TUI の `/tree` には見える
- コマンド文字列は ID の形を検証してから組み立てるため、改行や空白を注入できない。`requestId` はクライアントが作るが、BFF が形を検証する

## Alternatives

- **TUI のキー操作を送る**: `/tree` を開いて矢印で選ぶ経路は、ピッカーを閉じる保証が無く、スマホからは押しにくい。汎用キー入力を持たない方針（[ADR 0016](0016-composer-command-chips.md)）にも反する
- **pi に HTTP エンドポイントを立てる**: hwc の BFF から pi のプロセスへ直接要求する経路が新たに必要になり、Herdr のペインとの対応も二重になる。既存の入力経路で済ませる
- **クライアントが marker を直接書く**: セッションファイルの場所をクライアントへ渡すことになり、[ADR 0013](0013-pi-session-chat.md) の「path はクライアントへ渡さない」に反する。BFF が 2 相を管理する
- **選んだ時点で rewind する**: 誤タップで会話が消える。入力欄へ移すだけにして、送信時に戻す
- **モーダルで編集する**: 下書き・添付・引用の状態が分かれ、入力欄の既存の操作（引用・テンプレート）も使えない。入力欄を編集用に切り替える
- **添付付きも対象にする**: 再送時に添付をどう扱うか（再アップロード、パスの再利用、失敗時の復旧）が別の設計になる。今回はテキストだけに絞る

## References

- hwc #305: pi の過去の自分の発言を Web から編集して分岐し直せるようにする
- mypi #12: hwc 連携: pi のセッションを過去の発言の直前まで戻すコマンドを追加する
- [ADR 0013: 会話履歴は pi のセッション JSONL を正とする](0013-pi-session-chat.md)
- [ADR 0016: 入力欄は文字列をそのまま送り、コマンドは 2 つだけ候補に持つ](0016-composer-command-chips.md)
