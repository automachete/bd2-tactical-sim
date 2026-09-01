# Character icon assets

このディレクトリは、★5プレイアブル61体の生成済みトークン画像について、実行時ファイルとは別に原寸データと検証資料を版管理する場所です。公式またはBD2DBの画像は含みません。

- `source/`: ユーザーが作成した原寸・透過PNG。サムネイル再生成時の正本です。
- `qa/reports/`: 特徴、デフォルメ、縮小時の識別性を確認した台帳と再生成スクリプトです。
- `qa/thumbnails/32/`: 32pxでの識別性確認用サムネイルです。
- `../../ui/assets/character-icons/64/`: GUIが直接配信する64pxトークン画像です。

`qa/reports/rebuild-recognizability-assets.py` はPillowが利用できるQA環境で、原寸データから32px／64pxサムネイルとQA用コンタクトシートを再生成します。GUIは64px画像だけを読み込むため、原寸画像とQA資料は起動時や学習時にロードされません。
