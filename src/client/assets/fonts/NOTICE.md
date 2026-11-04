# Noto Sans JP

`NotoSansJP-Variable.woff2` は Google Fonts の `NotoSansJP[wght].ttf`（Noto Sans JP v2.004）を woff2 に変換したもの。UI の日本語を OS に依存させないため同梱する。可変フォント 1 本で 100〜900 を賄う。

## 再生成

```bash
curl -L -o NotoSansJP.ttf \
  'https://raw.githubusercontent.com/google/fonts/main/ofl/notosansjp/NotoSansJP%5Bwght%5D.ttf'
uv run --with fonttools --with brotli pyftsubset NotoSansJP.ttf \
  --unicodes='U+0-10FFFF' --flavor=woff2 --layout-features='*' --no-hinting \
  --output-file=src/client/assets/fonts/NotoSansJP-Variable.woff2
```

## ライセンス

SIL Open Font License 1.1。全文は [NotoSansJP-OFL.txt](NotoSansJP-OFL.txt)。

# Nerd Symbols Mono

`NerdSymbolsMono.woff2` は Nerd Fonts v3.5.1 の `SymbolsNerdFontMono-Regular.ttf` を woff2 に変換したもの。ペイン出力に含まれる PUA のアイコンを描くためだけに使う（ADR 0015）。

## 再生成

上流の `NerdFontsSymbolsOnly.zip` を展開し、fonttools で woff2 にする。`--unicodes` は CSS の `unicode-range` と同じ集合を渡す。

```bash
fonttools subset SymbolsNerdFontMono-Regular.ttf \
  --unicodes="U+23FB-23FE,U+2630,U+2665,U+26A1,U+276C-2771,U+2B58,U+E000-F8FF,U+F0001-F1AF0" \
  --flavor=woff2 --layout-features='' --no-hinting \
  --output-file=src/client/assets/fonts/NerdSymbolsMono.woff2
```

## ライセンス

フォント本体（Nerd Fonts のパッチ作業）は MIT。全文は [LICENSE](LICENSE)。

上流 `README.md` の記載に従い、同梱しているアイコンセットの出典とライセンスを以下に転記する。

| Icon set name          | upstream                                              | version         | license     |
| ---------------------- | ----------------------------------------------------- | --------------- | ----------- |
| Codicons               | https://github.com/microsoft/vscode-codicons          | 0.0.45          | CC BY 4.0   |
| Devicons               | https://github.com/devicons/devicon                   | 2.17.0          | MIT         |
| extraglyphs            | https://github.com/source-foundry/Hack                | -               | MIT         |
| Font Awesome           | https://github.com/FortAwesome/Font-Awesome           | 6.5.1           | CC BY 4.0   |
| Font Awesome Extension | https://github.com/AndreLZGava/font-awesome-extension | 0.0.3           | MIT         |
| Font Logos             | https://github.com/lukas-w/font-logos                 | 1.3.0           | unlicensed  |
| MaterialDesign         | https://github.com/Templarian/MaterialDesign-Font     | Oct 6, 2022     | Apache 2.0  |
| Octicons               | https://github.com/primer/octicons                    | 18.3.0          | MIT         |
| Seti and original      | https://github.com/jesseweed/seti-ui                  | 0.8.1           | MIT         |
| Pomicons               | https://github.com/gabrielelana/pomicons              | 1.001           | OFL 1.1 RFN |
| Powerline Extra        | https://github.com/ryanoasis/powerline-extra-symbols  | 1.200           | MIT         |
| Powerline Symbols      | https://github.com/powerline/powerline                | 1.000 (ca 2013) | MIT         |
| Power Symbols IEC      | https://github.com/jloughry/Unicode                   | Feb 2015        | MIT         |
| Weather Icons          | https://github.com/erikflowers/weather-icons          | 2.0.10 (1.100)  | OFL 1.1     |
