# docs

参照ドキュメントのインデックス。タスクの目的や変更範囲に応じて、ここから辿る。

## 内部

- [ADR](adr/) - 重要な技術判断の記録
- [エージェント対応状況](agents.md) - 各 CLI の対応範囲と更新手順
- [CI](ci.md) - GitHub Actions の workflow、action の固定、Dependabot
- [E2E](e2e.md) - 架空 Herdr で実データを混ぜずに画面を確認する
- [反映](deploy.md) - 常駐サーバーへの main の取り込みと、古いバンドルを配ったときの判定・復旧
- [DESIGN スキル](../.agents/skills/design/SKILL.md) - 再利用可能な UI デザイン仕様

## 外部

- [Herdr Socket API](https://herdr.dev/ja/docs/socket-api/) - ローカルソケット API の仕様（メソッド一覧、イベント、プロトコル、ソケット解決順）
