# Markdown・シンタックスハイライト・端末出力は自前実装で、HTML 文字列を経由せずに描く

- Status: Accepted

## Context

エージェントの本文は Markdown を含み、記号のままではスマホで読みにくい。ファイルプレビューのソースも、色が無いと構造を追いにくい。ペインの端末出力は ANSI の色と制御シーケンスを含む。

`marked` や `markdown-it` は HTML 文字列を返すためサニタイザも要り、highlight.js / Prism / Shiki も HTML 文字列を組み立てる。エージェント本文とファイルの中身は、リポジトリの内容やツール結果を経由して外部由来の文字列を含み得る。端末出力は任意のプログラムが出した文字列で、もっとも信用できない入力になる。認証の無い LAN 公開（[LAN 公開](lan-access.md)）なので、同じオリジンで script が動けば BFF の API をそのまま叩ける。

u7agent（`u7chan/monorepo` の `projects/u7agent`）には、DOM / React に依存しない自前の Markdown パーサとトークナイザがテストつきである。

## Decision

- Markdown とシンタックスハイライトのために外部ライブラリを足さない（[依存の方針](dependency-policy.md)）。u7agent のパーサを `src/client/markdown/` に、トークナイザを `src/client/pane/highlight.ts` に移植し、各ファイルの先頭に移植元を 1 行残す
- HTML 文字列を経由せず、Preact の VNode を組んで描く。`innerHTML` / `dangerouslySetInnerHTML` / `DOMParser` を使わない（Markdown とハイライトは `src/client/markdown/safety.test.ts` が検査する。端末出力は対象外）
- パーサとトークナイザは DOM / Preact に依存させず、純関数としてテストする（[テスト方針](test-strategy.md)）
- 生 HTML は描かず、タグは文字として出す。リンクにするのは `http` / `https` / `mailto` と、BFF が実在を確かめたファイルのパスだけ（[ファイルの配信](file-serving.md)）
- Markdown として描くのはエージェントの本文だけ。利用者の本文は送った文字列をそのまま出す
- ペインの端末出力は、BFF が ANSI を残したまま返し、client が SGR だけを `span` に変えて描く。SGR 以外の制御シーケンス（CSI・OSC・C0 / C1）は描かず、改行とタブだけを残す。リンクにするのは裸の `http` / `https` の URL だけで、OSC 8 などのハイパーリンクは解釈しない
- 入力の大きさに上限を置き、超えたら素のテキストに落とす（Markdown は本文 200KB、ハイライトは 20,000 トークン）。区切りの無い塊で走査が二次関数的に伸びないよう、規則の量化子を有限にする

## Consequences

- 対応する記法はパーサのテストが契約になる。数式・図・脚注・参照リンクなどは原文のまま出る
- 移植元の更新は自動では取り込まれない。必要になったら手で追従する
- 色付けの上限を超えたファイルは全体が素のテキストになる。主な利用端末のスマホで、トークンごとの要素が描画時間に効くため

## Alternatives

- **marked / markdown-it + サニタイザ**: 記法の網羅は広いが、HTML 文字列とサニタイザの両方を信頼することになる
- **サーバーでハイライトして HTML を返す**: client が HTML 文字列を挿入することになり、XSS の面が増える。BFF に表示の都合も持ち込む
