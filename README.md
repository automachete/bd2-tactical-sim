# BrownDust2 Tactical Simulator

BrownDust2の戦闘を、決定論的なRustコア、SQLiteカタログ、ブラウザGUI、Gymnasium/TorchRL環境で扱う戦術シミュレータです。ゲームプレイの確認、AI対戦、再現可能な戦闘テスト、GPUを使った方策学習を同じ戦闘コア上で実行できます。

## 対応範囲

| モード | プレイヤー側 | 対戦相手 |
|---|---|---|
| 通常戦闘 | GUI操作または方策 | MCTS |
| 鏡戦争 | GUI操作または方策 | MCTS |
| ゴールデンコロシアム | 衣装編成・加護設定後に自動進行 | 衣装単位の交互行動AI |
| 魔物追跡者 | 2パーティを編成してGUI操作 | データ駆動のルールAI |

2026-09-03版のデータには、★5プレイアブル61体、プレイヤー用155コスチューム、召喚4種、現行ボス用5スキル、剣闘士の加護47種を収録しています。これら全164コスチュームについて、強化、潜在力、バーストを展開したスキル派生は12,509件です。

主な機能は次のとおりです。

- シードと入力から同じ結果を再現できる整数演算ベースの戦闘コア
- 通常3×4／コロシアム可変盤面の配置、行動予約、対象範囲、戦闘再生を操作できるローカルGUI
- コスチューム、装備、成長値、バフをSQLiteから読み込むデータ駆動構成
- 事前学習を必要としないMCTSと、魔物追跡者用の行動順序AI
- 合法手マスク付きのGymnasium/TorchRL環境とGPU対応PPO
- 戦闘スナップショット、イベント列、巻き戻しによる再現・診断機能

ゲームクライアントとの照合状況は[実機検証マトリクス](docs/research/browndust2-combat-verification-matrix.md)で管理しています。未検証の境界条件を含め、検証済みの範囲を越えて完全一致とは扱いません。

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
.\.venv\Scripts\bd2-play.exe
```

既定では`http://127.0.0.1:8765/`を開きます。ブラウザを自動で開かない場合は`--no-open`、ポートを変更する場合は`--port`を指定できます。`bd2-gui.exe`も同じ画面を起動します。

### 戦闘操作

- 味方ユニットをドラッグして配置し、占有マスへ移動すると2体を入れ替えます。
- キーボードではSpaceでユニットを持ち上げ、矢印キーで移動先を選び、Enterで確定、Escで取り消します。
- 左側のユニットカードをドラッグして行動順を変更します。
- 選択ユニットの通常攻撃、ノックバック、使用可能なコスチュームスキルを予約します。
- バースト対応スキルは、スキルカード内の左右ボタンでバーストなし／1／2／3を切り替えます。
- 対象プレビューには、先行する予約行動を反映した主対象、効果範囲、範囲内ユニットが表示されます。
- 画面中央下のひし形SP表示は、残りSP、通常消費分、バースト追加消費分を色分けします。
- 戦闘イベントは1～3倍速で順次再生でき、一時停止、再開、直前手番への巻き戻しに対応します。

鏡戦争など配置が固定される場面では、盤面上の移動操作も無効になります。

ゴールデンコロシアムでは、同一キャラクターの別衣装を独立した駒として最大3体編成し、先攻用・後攻用の加護をポイント内で設定します。戦闘開始後はランダムに決まった先攻側から1衣装ずつ交互に自動行動するため、手動の行動予約は表示しません。現行体験シーズン40の4×4盤面、配置不可6セル、無限SP、CT無効、戦闘中チェイン維持、ALLターン5からのデスタイムをセットアップから読み込みます。

### 編成と能力値

画面下部の「キャラクター設定」には、BD2DBの一覧に近い検索・属性絞り込み付きの★5キャラクターデータベースがあります。ここでキャラクターごとに次の固定要素を設定し、`data/profiles/characters.json`へ保存します。

- 全コスチュームの凸段階とバースト上限
- 女神の涙を使うスキル強化3ノード
- 覚醒の有無
- 5部位の装備、精錬スコア18～24、副能力、専用装備の主能力

固定要素は編成スロットではなくキャラクター本人に属します。通常戦闘、鏡戦争、魔物追跡者、ゴールデンコロシアムの編成を切り替えたり、編成から外して再追加したりしても、保存済みプロフィールが味方へ再適用されます。プロフィール文書は現行カタログ全61体を含む厳格な単一スキーマだけを受け付け、旧形式、部分文書、未知フィールドを移行・補完せず拒否します。

戦闘準備画面では、★5キャラクター、使用コスチューム、コスチュームリンク、配置、パーティ、刻印、コレクションボーナス、外部バフ、BD2DB準拠の計算条件を編成・コンテンツ単位で変更します。固定要素は参照専用で表示し、「固定設定を開く」から該当キャラクターの設定へ移動できます。

コスチューム設定を変更すると、範囲、SP、CT、日本語スキル説明が該当する派生値へ更新されます。
スキル潜在力は女神の涙を使う3ノードを個別にオン／オフできます。涙を使わない能力値ノードは強化済みで固定され、GUIを迂回した入力で無効化しても戦闘コアが拒否します。編成名を付けて保存すると、現在のプロフィールを反映した検証済みシナリオが`data/scenarios/saved`へ保存され、そのJSONをGUIと`bd2-train`のどちらからでも読み込めます。

### AI設定

通常戦闘と鏡戦争の敵は、各手番で現在状態からUCT方式のMCTSを実行します。既定の探索回数は48回です。

```powershell
.\.venv\Scripts\bd2-play.exe --mcts-simulations 96
```

魔物追跡者では魔物のスキル順序、CT、発動条件をSQLiteの定義から読み込みます。ゴールデンコロシアムでは双方とも専用の衣装交互スケジューラを使い、MCTSによる手動選択は行いません。

## 強化学習

GPUの認識、学習、評価は個別のコマンドで実行します。

```powershell
.\.venv\Scripts\bd2-device-check.exe
.\.venv\Scripts\bd2-train.exe --database data/generated/bd2.sqlite --scenario data/scenarios/monster-chaser-current.json --output checkpoints/monster-chaser.pt
.\.venv\Scripts\bd2-evaluate.exe --database data/generated/bd2.sqlite --scenario data/scenarios/monster-chaser-current.json --checkpoint checkpoints/monster-chaser.pt
```

学習環境はRustの並列シミュレータを直接使用します。GUIを起動しない学習経路には、HTTP配信、画面描画、MCTSは含まれません。WindowsではCUDA Graph、対応環境ではInductorを選択し、CUDA上でbf16またはfp16の混合精度を使用します。

観測はユニット、装備・成長を反映した能力値、コスチューム別CTと使用回数、全状態効果、両陣営のSP・チェイン・行動順、盤面占有、合法手の意味情報、魔物追跡者の全HP区間とパーティ進行、ゴールデンコロシアムのALLターン・デスタイム・加護発動順を独立テンソルとして保持します。方策は最大80候補の意味特徴を採点し、行動順に共有SPを予約するため、個別には合法でも同一ターン内でSPを超過する組合せを生成しません。固定形状の上限を超えた状態は切り捨てず例外で停止します。詳細は[強化学習観測スキーマ](docs/rl-observation-schema.md)を参照してください。チェックポイントには観測スキーマとモデル構造IDが保存され、互換性のないモデルは読み込み時に拒否されます。

## プロジェクト構成

| パス | 内容 |
|---|---|
| `crates/bd2-core` | 戦闘状態、イベント、算術、モード別ルール |
| `crates/bd2-data` | SQLiteスキーマ、カタログ、シナリオ管理 |
| `crates/bd2-py` | RustコアのPython拡張 |
| `python/bd2rl` | Gymnasium環境、並列環境、PPO、評価、MCTS、GUIサーバー |
| `tools` | データ同期、検証、シナリオ生成、ブラウザテスト |
| `ui` | 戦闘GUIとUIテスト |
| `assets/character-icons` | キャラクタートークンの原寸データと識別性QA資料 |
| `docs` | 設計書、調査記録、検証資料 |

## データとアセット

外部カタログの同期処理は、取得したJavaScriptを実行せず、構文木から許可された静的データだけを読み取ります。各レコードには出典URL、取得日時、ダイジェスト、原文ペイロードを保存します。スキルは型付きの操作列へ変換できた派生だけが戦闘で使用されます。

キャラクター名、コスチューム名、スキル名、スキル説明には公式の日本語表記を使用します。ゲーム公式または第三者サイトの画像、3Dモデル、音声、背景素材は同梱していません。GUIのキャラクタートークンはプロジェクト用に作成された透過PNGです。

- 原寸画像: `assets/character-icons/source`
- 識別性QA資料: `assets/character-icons/qa`
- GUI用64px画像: `ui/assets/character-icons/64`

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
node --check ui/app.js
node --test ui/tests/*.test.mjs
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

回帰テストには次の検証が含まれます。

- 全★5キャラクターの通常攻撃、ノックバック、合法スキルについて、対象ロックと効果範囲を独立した戦闘実行と照合
- 伝説装備30種と専用装備61種について、全3,626精錬／主能力ケースを本番能力値計算へ入力
- 配置、行動順、複数予約、召喚、チェイン、衝突、編成交替、終局表示を実ブラウザで操作
- 連続した対象プレビュー、装備所有者制約、成長設定、外部バフ、魔物レベルと共有HPを検証
- 現行コロシアムの4×4盤面、配置不可数、衣装交互順、先後別加護、47加護の全段階、無限SP、CT無効、チェイン維持、デスタイムを検証
- 全12,509スキル派生の実行、復元後の同一入力によるビット単位一致、未知・破損状態のfail-closed検証

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
