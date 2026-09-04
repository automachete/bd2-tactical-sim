# BrownDust2 Tactical Simulator

BrownDust2の戦闘を再現し、編成や行動を検証するための非公式戦術シミュレータです。決定論的なRust製戦闘コアを、ローカルGUI、AI対戦、自動テスト、Gymnasium／TorchRLによる方策学習から利用できます。

> [!IMPORTANT]
> このプロジェクトは開発中です。不具合や破壊的変更が含まれる可能性があります。

## 主な機能

- シードと入力から同じ結果を再現できる、整数演算ベースの戦闘処理
- 通常3×4／コロシアム可変盤面の配置、行動予約、対象範囲、SP、戦闘再生を操作できるブラウザGUI
- コスチューム、装備、成長値、バフをSQLiteで管理するデータ駆動構成
- 通常戦闘・鏡戦争向けのMCTSと、各コンテンツに合わせたルールベースAI
- 合法手マスク付きのGymnasium／TorchRL環境とGPU対応PPO
- スナップショット、イベント列、巻き戻しを使った戦闘の再現と診断

## 対応コンテンツ

| コンテンツ | プレイヤー操作 | 対戦相手の制御 |
|---|---|---|
| 通常戦闘 | GUIまたは方策 | MCTS |
| 鏡戦争 | GUIまたは方策 | MCTS |
| ゴールデンコロシアム | 衣装編成・加護設定後に自動進行 | 衣装単位の交互行動AI |
| モンスターチェイサー | 2パーティを編成してGUI操作 | データ駆動のルールAI |

収録データは2026年9月3日時点のものです。

| 種別 | 収録数 |
|---|---:|
| ★5プレイアブルキャラクター | 61 |
| プレイヤー用コスチューム | 155 |
| 召喚 | 4 |
| 現行ボス用スキル | 5 |
| 剣闘士の加護 | 47 |
| スキル派生 | 12,509 |

スキル派生数は、収録された全164コスチュームについて強化、潜在力、バーストの組み合わせを展開した件数です。ゲームクライアントとの照合範囲と未検証項目は、[実機検証マトリクス](docs/research/browndust2-combat-verification-matrix.md)を参照してください。

## 動作環境

以下の手順はWindows PowerShell向けです。

- Python 3.13または3.14
- Rust 1.97以降
- Node.js 24以降
- GPU学習を行う場合のみ、CUDA 13.0に対応したNVIDIA GPU環境

GUIとCPU上のシミュレーションにはGPUは不要です。

## セットアップ

リポジトリのルートでセットアップスクリプトを実行します。

```powershell
.\setup.ps1
```

このスクリプトはPython環境とNode.js依存関係を準備し、ゲームデータの同期・検証、SQLiteデータベースの生成、GUIのビルドまで実行します。

CUDA 13.0でGPU学習を行う場合は、`-Cuda`を付けて実行します。

```powershell
.\setup.ps1 -Cuda
```

Python 3.14を使用する場合は`-PythonVersion 3.14`も指定できます。生成されたカタログとSQLiteデータベースは`data/generated`に保存され、Gitの管理対象には含まれません。

## GUIを起動する

```powershell
.\.venv\Scripts\bd2-play.exe
```

既定では`http://127.0.0.1:8765/`が自動的に開きます。ブラウザを開かない場合は`--no-open`、ポートを変更する場合は`--port`を指定します。

UIの開発時は、PythonサーバーとViteを別々のPowerShellで起動してください。Viteは`/api`へのリクエストをPythonサーバーへ転送します。

```powershell
.\.venv\Scripts\bd2-play.exe --no-open --port 8766
```

```powershell
npm --prefix ui run dev
```

### 戦闘操作

- 味方ユニットをドラッグして配置します。占有済みのマスへ移動すると、2体の位置が入れ替わります。
- キーボードではSpaceでユニットを選択し、矢印キーで移動先を選び、Enterで確定、Escで取り消します。
- 左側のユニットカードをドラッグして行動順を変更します。
- 選択ユニットの通常攻撃、ノックバック、使用可能なコスチュームスキルを予約します。
- バースト対応スキルは、スキルカード内の左右ボタンでバースト段階を切り替えます。
- 対象プレビューでは、先行する予約行動を反映した主対象、効果範囲、範囲内ユニットを確認できます。
- 画面中央下のSP表示には、現在値と予約済みの消費量が表示されます。
- 戦闘イベントは1～3倍速で再生でき、一時停止、再開、直前手番への巻き戻しに対応します。

利用できる操作は、選択中のコンテンツと戦闘状況に応じて変わります。

### キャラクター設定

画面下部の「キャラクター設定」では、★5キャラクターを検索し、属性で絞り込めます。キャラクターごとに次の項目を設定できます。

- 全コスチュームの凸段階とバースト上限
- 女神の涙を使う3つのスキル強化ノード
- 覚醒の有無
- 5部位の装備、精錬スコア18～24、副能力、専用装備の主能力

設定は`data/profiles/characters.json`へ保存され、編成やコンテンツを切り替えても再適用されます。プロフィールファイルは現行カタログの全61体を含む必要があり、旧形式、部分的なデータ、未知のフィールドを含むデータは読み込めません。

### 編成設定

戦闘準備画面では、コンテンツと編成ごとに次の項目を変更できます。

- キャラクター、使用コスチューム、コスチュームリンク
- 配置とパーティ
- 刻印とコレクションボーナス
- 外部バフ
- 装備計算条件

キャラクター設定で管理する固定項目は参照専用で表示され、「固定設定を開く」から該当キャラクターの設定へ移動できます。

コスチューム設定に応じて、範囲、SP、CT、日本語スキル説明が更新されます。スキル潜在力は、女神の涙を使う3ノードを個別に切り替えられます。

編成名を付けて保存すると、現在のプロフィールを反映したシナリオが`data/scenarios/saved`へ作成されます。保存したJSONはGUIと`bd2-train`の両方で利用できます。

### AI設定

通常戦闘と鏡戦争の敵は、各手番で現在の状態からUCT方式のMCTSを実行します。既定の探索回数は48回です。

```powershell
.\.venv\Scripts\bd2-play.exe --mcts-simulations 96
```

モンスターチェイサーとゴールデンコロシアムでは、各コンテンツ専用の行動制御を使用します。

## 強化学習

GPUの認識確認、学習、評価はそれぞれ個別に実行できます。

```powershell
.\.venv\Scripts\bd2-device-check.exe
.\.venv\Scripts\bd2-train.exe --database data/generated/bd2.sqlite --scenario data/scenarios/monster-chaser-current.json --output checkpoints/monster-chaser.pt
.\.venv\Scripts\bd2-evaluate.exe --database data/generated/bd2.sqlite --scenario data/scenarios/monster-chaser-current.json --checkpoint checkpoints/monster-chaser.pt
```

学習環境はRustの並列シミュレータを直接使用し、GUIやHTTPサーバーを介さずに動作します。WindowsではCUDA Graph、対応環境ではInductorを利用し、CUDA上でbf16またはfp16の混合精度を使用します。

観測と行動候補は固定形状のテンソルです。詳細は[強化学習観測スキーマ](docs/rl-observation-schema.md)を参照してください。チェックポイントには観測スキーマとモデル構造IDが保存され、互換性のないモデルは読み込まれません。

## テスト

### Rust

```powershell
cargo fmt --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
```

### Python

```powershell
.\.venv\Scripts\ruff.exe format --check python
.\.venv\Scripts\ruff.exe check python
.\.venv\Scripts\pytest.exe -q
```

### データとUI

Playwrightを初めて使う場合は、先にChromiumをインストールします。

```powershell
npm --prefix tools exec -- playwright install chromium

node --check tools/sync-bd2db.mjs
node --check tools/build-current-scenarios.mjs
node --check tools/validate-catalog.mjs
node --check tools/validate-character-icons.mjs

npm --prefix ui ci
npm --prefix ui run verify

node tools/validate-catalog.mjs data/generated/catalog.json
node tools/validate-bd2db-equipment.mjs data/generated/catalog.json data/generated/equipment-oracle.json
node tools/validate-character-icons.mjs

npm --prefix tools run test:ui
```

### 収束型品質検証

次のコマンドは、全モードのシード付き状態遷移、スナップショット復元、独立不変条件、全スキル派生の実行可能性を検証します。

```powershell
cargo run --release -p bd2-data --bin bd2-quality -- --episodes 100000 --rounds 3 --output docs/validation/convergence-quality.json
.\.venv\Scripts\python.exe -m bd2rl.quality_benchmark --output docs/validation/convergence-performance.json

$env:BD2_GUI_QUALITY_SEQUENCES = "1000"
npm --prefix tools run test:ui:quality
```

GUI検証は`BD2_GUI_QUALITY_OFFSET`でシード範囲をずらし、`BD2_PLAYWRIGHT_PORT`で独立したサーバーポートを指定できます。複数シャードの結果は`tools/aggregate-gui-quality.mjs`で集約でき、範囲の重複や欠落はエラーになります。

回帰テストは、収録されているすべてのキャラクター、コスチューム、装備、対応コンテンツの戦闘処理とGUI操作を対象とします。検証結果は`docs/validation`に保存されます。

## データとアセット

外部カタログの同期処理は、取得したJavaScriptの構文木から必要な静的データを抽出します。各レコードには出典URL、取得日時、ダイジェスト、原文ペイロードが保存されます。戦闘で利用できるのは、型付きの操作列へ変換されたスキル派生だけです。

キャラクター名、コスチューム名、スキル名、スキル説明には公式の日本語表記を使用しています。ゲーム公式または第三者サイトの画像、3Dモデル、音声、背景素材は同梱していません。GUIのキャラクタートークンは、このプロジェクト用に作成された透過PNGです。

| パス | 内容 |
|---|---|
| `assets/character-icons/source` | 原寸画像 |
| `assets/character-icons/qa` | 識別性の確認資料 |
| `ui/public/assets/character-icons/64` | GUI用64px画像 |

## プロジェクト構成

| パス | 内容 |
|---|---|
| `crates/bd2-core` | 戦闘状態、イベント、算術、コンテンツ別ルール |
| `crates/bd2-data` | SQLiteスキーマ、カタログ、シナリオ管理 |
| `crates/bd2-py` | RustコアのPython拡張 |
| `python/bd2rl` | Gymnasium環境、並列環境、PPO、評価、MCTS、GUIサーバー |
| `tools` | データ同期、検証、シナリオ生成、ブラウザテスト |
| `ui` | Svelte 5／TypeScript製GUI、Vite構成、UIテスト |
| `assets/character-icons` | キャラクタートークンと識別性の確認資料 |
| `docs` | 設計書、調査記録、検証資料 |

## 関連資料

- [戦闘シミュレータ概念設計](docs/rpg-simulator-conceptual-design.md)
- [強化学習観測スキーマ](docs/rl-observation-schema.md)
- [情報源台帳](docs/research/browndust2-combat-source-ledger.md)
- [戦闘UIリファレンス](docs/research/browndust2-combat-ui-reference.md)
- [実機検証マトリクス](docs/research/browndust2-combat-verification-matrix.md)
- [UIゲームプレイ検証記録](docs/validation/ui-gameplay-bug-hunt-2026-09-01.md)
- [ゴールデンコロシアム現行仕様](docs/research/golden-colosseum-specification.md)
- [BD2DB装備照合データ](docs/validation/bd2db-current-equipment-oracle.json)
- [収束型品質検証記録](docs/validation/convergence-quality-2026-09-03.md)

## ライセンス

[MIT License](LICENSE)
