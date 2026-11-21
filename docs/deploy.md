# 反映

PR をマージしたあと、常駐している開発サーバーへどう反映するか。シェルを持たない端末（スマホなど）からでも反映と復旧ができるように、再起動コマンドを設定画面に持たせる。あわせて、反映のときに起きやすい「古いバンドルが配られる」状態の判定をまとめる。

## 再起動コマンド

設定画面の「再起動」に、HWC を起動し直すコマンドの**絶対パス**を入れる。BFF はシェルを介さず、その実行ファイルを直接起動する。

作業機では `~/.local/bin/restart-hwc` に次を置いている。

```sh
#!/bin/sh
# HWC のチェックアウトを pull したときだけ、HWC を再起動する。
# コマンドは pull したチェックアウトを cwd として起動される（docs/adr/restart-command.md）。
[ "$(git rev-parse --show-toplevel 2>/dev/null)" = "$HOME/workspace/hwc" ] || exit 0
systemctl --user restart hwc
```

置いたら `chmod +x` で実行権限を付ける。無いと設定画面は 409 `command_not_executable` を返す。

どのリポジトリで実行するかを絞るのはコマンド側の責務。コマンドは **pull したチェックアウトをカレントディレクトリとして**起動する（設定画面の「今すぐ再起動」では、BFF が動いているチェックアウト）。上のガードが無いと、ほかのスペースで pull しても HWC が落ちる。

設定は状態ディレクトリ（`HWC_STATE_DIR`、既定は `~/.local/state/hwc`）に保存する。マシンを作り直したら入れ直す。方式の判断は [再起動コマンド](adr/restart-command.md) を参照する。

## 反映

「プル成功後に実行」をオンにしておくと、スペースメニューのプルで反映が終わる。pull は `--ff-only` で、成功したときだけコマンドを起動する。fetch では起動しない。

シェルがある端末なら、pull と再起動を直接叩いてもよい。

```bash
git fetch --prune
git pull --ff-only
systemctl --user restart hwc
```

再起動後の起動ログ `hwc ready: ... (<revision>)` の revision が `git rev-parse --short HEAD` と一致していれば、配信中のコードは `main` と同じ。

## シェルが無い端末からの復旧

設定画面の「今すぐ再起動」を押す。応答は再起動を起動する前に返るので、画面はエラーにならない。開いているページは BFF が戻ると HMR の再接続で読み直される。

押しても直らないときは、次を確かめる。

- 設定画面のエラー表示（コマンドが未設定・実行できない）
- そのコマンドを端末から直接叩いたときに通るか

## 古いバンドルが配られる

クライアントのバンドルは、Bun の開発サーバーがプロセス内で組み立ててキャッシュする。pull のように多数のファイルが一括で置き換わると、再ビルドと競合して 1 モジュールだけ古い本文のまま残ることがある。そのモジュールは以後の変更でも再ビルドされず、サーバーの再起動まで直らない。`touch` しても直らない。

症状は、ソースにはある（`tsc` も `bun test` も通る）export を呼ぶ行が、実行時にだけ失敗する。

```
PaneDetail.tsx:1832 Uncaught TypeError: import_scroll.isUserScrollDuringGrowth is not a function
```

ブラウザのキャッシュではないので、ハードリロードやキャッシュ削除では直らない。再起動コマンドを設定してあれば、設定画面の「今すぐ再起動」で戻せる。

### 判定

配信中のバンドルに、その名前の定義が入っているかを見る。モジュール一覧（manifest）とその呼び出しにしか名前が現れず、モジュール本体の `hmr.exports` に無ければ古い。

```bash
B=$(curl -s http://localhost:30000/ | grep -o '/_bun/client/[^"]*')
curl -s "http://localhost:30000$B" | grep -c isUserScrollDuringGrowth
# 6 = 定義・export・呼び出しが揃っている（正常）
# 2 = manifest と呼び出しだけ（古い）
```

数はその関数の呼び出し箇所で変わる。定義が無いのに名前だけが出てくる、が古いバンドルの目印。

## マシンを作り直すとき

次はリポジトリに無いので、新しい作業機では作り直す。

- `~/.local/bin/restart-hwc` — 上のスクリプト。`chmod +x` を忘れない
- `~/.config/systemd/user/hwc.service` — 常駐の unit。控えを下に置く
- `HWC_STATE_DIR/restart.json`（既定は `~/.local/state/hwc/restart.json`）— 設定画面の値。設定画面から入れ直す

unit の控え。mise で入れた bun を使う前提。

```ini
[Unit]
Description=hwc (Herdr web UI, LAN)
# 短時間の連続失敗で failed に落ち、再開されなくなるのを避ける。
StartLimitIntervalSec=0

[Service]
Type=simple
WorkingDirectory=%h/workspace/hwc
# HWC は pi / gh / git / codex を子プロセスで起動するので、対話シェルと同じ解決順を渡す。
Environment="PATH=%h/.local/share/mise/shims:%h/.local/bin:/usr/local/bin:/usr/bin:/bin"
ExecStart=%h/.local/share/mise/shims/bun --watch src/server.ts
Restart=always
RestartSec=3

[Install]
WantedBy=default.target
```

置いたら `systemctl --user daemon-reload` してから `systemctl --user enable --now hwc`。
