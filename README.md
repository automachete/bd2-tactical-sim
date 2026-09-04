# BrownDust2 Tactical Simulator

BrownDust2の戦闘を再現・検証するための戦術シミュレータです。Rust製の戦闘コアをブラウザGUI、AI対戦、再現可能な戦闘テスト、Gymnasium/TorchRLによる方策学習で共有しています。

> [!IMPORTANT]
> BrownDust2 Tactical Simulatorは非公式の開発中のプロジェクトです。不具合や破壊的変更に注意してください。

## 対応範囲

| モード | プレイヤー側 | 対戦相手 |
|---|---|---|
| 通常戦闘 | GUI操作または方策 | MCTS |
| 鏡戦争 | GUI操作または方策 | MCTS |
| ゴールデンコロシアム | 衣装編成・加護設定後に自動進行 | 衣装単位の交互行動AI |
| モンスターチェイサー | 2パーティを編成してGUI操作 | データ駆動のルールAI |

2026-09-03版のカタログには、★5プレイアブル61体、プレイヤー用155コスチューム、召喚4種、現行ボス用5スキル、剣闘士の加護47種を収録しています。全164コスチュームの強化、潜在力、バーストを展開すると、スキル派生は12,509件です。

主な機能は次のとおりです。

- シードと入力から同じ結果を再現できる整数演算ベースの戦闘コア
- 通常3×4／コロシアム可変盤面の配置、行動予約、対象範囲、戦闘再生を操作できるローカルGUI
- コスチューム、装備、成長値、バフをSQLiteで管理するデータ駆動構成
- 事前学習を必要としないMCTSと、モンスターチェイサー用の行動順序AI
- 合法手マスク付きのGymnasium/TorchRL環境とGPU対応PPO
- 戦闘スナップショット、イベント列、巻き戻しによる再現・診断機能

ゲームクライアントとの照合状況は[実機検証マトリクス](docs/research/browndust2-combat-verification-matrix.md)にまとめています。未検証の境界条件があるため、再現性はマトリクスに記載された検証範囲を基準にしてください。

## 必要環境

以下の手順はWindows PowerShell向けです。

- Python 3.13または3.14
- Rust 1.97以降
- Node.js 24以降
- 学習にGPUを使う場合は、CUDA 13.0に対応したNVIDIA GPU環境

GUIによるデバッグプレイだけであればGPUは不要です。

## セットアップ

### 1. Pythonと開発ツール

```powershell
py -3.13 -m venv .venv
.\.venv\Scripts\python.exe -m pip install torch==2.13.0 --index-url https://download.pytorch.org/whl/cu130
.\.venv\Scripts\python.exe -m pip install -e ".[test]"

cd tools
npm install --ignore-scripts
cd ..
```

### 2. ゲームデータの生成

外部データを同期し、検証後のカタログとシナリオをSQLiteへ格納します。生成物は`data/generated`に作成され、Gitの管理対象には含まれません。

```powershell
cd tools
npm run sync -- --out ../data/generated/catalog.json --equipment-oracle ../data/generated/equipment-oracle.json
node validate-catalog.mjs ../data/generated/catalog.json
node validate-bd2db-equipment.mjs ../data/generated/catalog.json ../data/generated/equipment-oracle.json
node build-current-scenarios.mjs 10072 6
cd ..

cargo run -p bd2-data --bin bd2-data -- import-catalog data/generated/catalog.json data/generated/bd2.sqlite
cargo run -p bd2-data --bin bd2-data -- import-scenario data/scenarios/normal-demo.json data/generated/bd2.sqlite
cargo run -p bd2-data --bin bd2-data -- import-scenario data/scenarios/mirror-war-demo.json data/generated/bd2.sqlite
cargo run -p bd2-data --bin bd2-data -- import-scenario data/scenarios/monster-chaser-current.json data/generated/bd2.sqlite
cargo run -p bd2-data --bin bd2-data -- import-scenario data/scenarios/golden-colosseum-reference.json data/generated/bd2.sqlite
cargo run -p bd2-data --bin bd2-data -- inspect data/generated/bd2.sqlite
```

## GUIでプレイする

```powershell
cd ui
npm ci
npm run build
cd ..
.\.venv\Scripts\bd2-play.exe
```

GUIはSvelte 5、TypeScript、Viteで実装されています。`bd2-play`と`bd2-gui`は`ui/dist`の本番成果物だけを配信し、成果物がない場合はビルド手順を示して停止します。既定では`http://127.0.0.1:8765/`を開きます。ブラウザを自動で開かない場合は`--no-open`、ポートを変更する場合は`--port`を指定できます。開発時はPython側を`bd2-play --no-open --port 8766`で起動し、別端末で`cd ui; npm run dev`を実行します。Viteは`/api`をそのPythonサーバーへ転送します。

### 戦闘操作

- 味方ユニットをドラッグして配置し、占有マスへ移動すると2体を入れ替えます。
- キーボードではSpaceでユニットを持ち上げ、矢印キーで移動先を選び、Enterで確定、Escで取り消します。
- 左側のユニットカードをドラッグして行動順を変更します。
- 選択ユニットの通常攻撃、ノックバック、使用可能なコスチュームスキルを予約します。
- バースト対応スキルは、スキルカード内の左右ボタンでバーストなし／1／2／3を切り替えます。
- 対象プレビューには、先行する予約行動を反映した主対象、効果範囲、範囲内ユニットが表示されます。
- 画面中央下のSP表示で、残量と予約済みの消費量を確認できます。
- 戦闘イベントは1～3倍速で順次再生でき、一時停止、再開、直前手番への巻き戻しに対応します。

利用できる操作は、選択したコンテンツと戦闘状況に応じて切り替わります。

### 編成と能力値

画面下部の「キャラクター設定」には、BD2DBの一覧に近い検索・属性絞り込み付きの★5キャラクターデータベースがあります。ここでキャラクターごとに次の固定要素を設定し、`data/profiles/characters.json`へ保存します。

- 全コスチュームの凸段階とバースト上限
- 女神の涙を使うスキル強化3ノード
- 覚醒の有無
- 5部位の装備、精錬スコア18～24、副能力、専用装備の主能力

設定はキャラクターごとに保存され、編成やコンテンツを切り替えても再適用されます。プロフィール文書は現行カタログの全61体を含む単一スキーマで検証されます。旧形式、部分的な文書、未知のフィールドを含む文書は読み込めません。

戦闘準備画面では、★5キャラクター、使用コスチューム、コスチュームリンク、配置、パーティ、刻印、コレクションボーナス、外部バフ、BD2DB準拠の計算条件を編成・コンテンツ単位で変更します。固定要素は参照専用で表示し、「固定設定を開く」から該当キャラクターの設定へ移動できます。

コスチューム設定を変更すると、範囲、SP、CT、日本語スキル説明が該当する派生値へ更新されます。
スキル潜在力は女神の涙を使う3ノードを個別にオン／オフできます。編成名を付けて保存すると、現在のプロフィールを反映したシナリオが`data/scenarios/saved`へ保存されます。保存したJSONはGUIと`bd2-train`の両方で読み込めます。

### AI設定

通常戦闘と鏡戦争の敵は、各手番で現在状態からUCT方式のMCTSを実行します。既定の探索回数は48回です。

```powershell
.\.venv\Scripts\bd2-play.exe --mcts-simulations 96
```

モンスターチェイサーとゴールデンコロシアムでは、各モード専用の行動制御を使用します。

## 強化学習

GPUの認識、学習、評価は個別のコマンドで実行します。

```powershell
.\.venv\Scripts\bd2-device-check.exe
.\.venv\Scripts\bd2-train.exe --database data/generated/bd2.sqlite --scenario data/scenarios/monster-chaser-current.json --output checkpoints/monster-chaser.pt
.\.venv\Scripts\bd2-evaluate.exe --database data/generated/bd2.sqlite --scenario data/scenarios/monster-chaser-current.json --checkpoint checkpoints/monster-chaser.pt
```

学習環境はRustの並列シミュレータを直接使用し、GUIやHTTPサーバーを介さずに動作します。WindowsではCUDA Graph、対応環境ではInductorを利用し、CUDA上でbf16またはfp16の混合精度を使用します。

観測と行動候補は固定形状のテンソルとして扱われます。詳細は[強化学習観測スキーマ](docs/rl-observation-schema.md)を参照してください。チェックポイントには観測スキーマとモデル構造IDが保存され、互換性のないモデルは読み込めません。

## プロジェクト構成

| パス | 内容 |
|---|---|
| `crates/bd2-core` | 戦闘状態、イベント、算術、モード別ルール |
| `crates/bd2-data` | SQLiteスキーマ、カタログ、シナリオ管理 |
| `crates/bd2-py` | RustコアのPython拡張 |
| `python/bd2rl` | Gymnasium環境、並列環境、PPO、評価、MCTS、GUIサーバー |
| `tools` | データ同期、検証、シナリオ生成、ブラウザテスト |
| `ui` | Svelte 5 / TypeScript製の戦闘GUI、Vite構成、UIテスト |
| `assets/character-icons` | キャラクタートークンの原寸データと識別性QA資料 |
| `docs` | 設計書、調査記録、検証資料 |

## データとアセット

外部カタログの同期処理では、取得したJavaScriptの構文木から必要な静的データを抽出します。各レコードには出典URL、取得日時、ダイジェスト、原文ペイロードが保存されます。戦闘で使用できるのは、型付きの操作列へ変換されたスキル派生のみです。

キャラクター名、コスチューム名、スキル名、スキル説明には公式の日本語表記を使用します。ゲーム公式または第三者サイトの画像、3Dモデル、音声、背景素材は同梱していません。GUIのキャラクタートークンはプロジェクト用に作成された透過PNGです。

- 原寸画像: `assets/character-icons/source`
- 識別性QA資料: `assets/character-icons/qa`
- GUI用64px画像: `ui/public/assets/character-icons/64`

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

Playwrightを初めて使う場合は、先にブラウザをインストールします。

```powershell
cd tools
npx playwright install chromium
cd ..

node --check tools/sync-bd2db.mjs
node --check tools/build-current-scenarios.mjs
node --check tools/validate-catalog.mjs
node --check tools/validate-character-icons.mjs
cd ui
npm ci
npm run verify
cd ..
node tools/validate-catalog.mjs data/generated/catalog.json
node tools/validate-bd2db-equipment.mjs data/generated/catalog.json data/generated/equipment-oracle.json
node tools/validate-character-icons.mjs

cd tools
npm run test:ui
cd ..
```

### 収束型品質検証

全モードを対象に、seed付き状態遷移、スナップショット復元、独立不変条件、全スキル派生の実行可能性をまとめて検証できます。

```powershell
cargo run --release -p bd2-data --bin bd2-quality -- --episodes 100000 --rounds 3 --output docs/validation/convergence-quality.json
.\.venv\Scripts\python.exe -m bd2rl.quality_benchmark --output docs/validation/convergence-performance.json

cd tools
$env:BD2_GUI_QUALITY_SEQUENCES = "1000"
npm run test:ui:quality
cd ..
```

GUI検証は`BD2_GUI_QUALITY_OFFSET`でseed範囲をずらし、`BD2_PLAYWRIGHT_PORT`で独立サーバーを指定できます。複数シャードの結果は`tools/aggregate-gui-quality.mjs`で、範囲の重複や欠落を拒否しながら集約します。

回帰テストは、全収録キャラクター、コスチューム、装備、対応モードの戦闘処理とGUI操作を対象とします。検証結果は`docs/validation`に保存されます。

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
