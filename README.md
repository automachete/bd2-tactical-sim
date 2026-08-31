# BrownDust2 Tactical Simulator

BrownDust2 の現行戦闘ルールを、決定論的なRustコア、版管理されたSQLiteデータ、Gymnasium/TorchRL環境、GPU学習器、任意起動のローカルGUIとして再現するプロジェクトです。

対象モードは通常戦闘、鏡戦争、魔物追跡者です。2026-09-01スナップショットには★5プレイアブル61体、プレイヤー用155コスチューム、召喚4種、現行ボス用5スキル、強化・潜在力・バーストを展開した合計12,509派生を収録します。公開情報から変換した仕様と、現行クライアントで実測済みの仕様は検証台帳で区別します。

## 構成

- `crates/bd2-core`: OSやGUIから独立した戦闘状態・イベント・算術・モード処理
- `crates/bd2-data`: SQLiteスキーマ、現行スナップショット、シナリオ管理
- `crates/bd2-py`: PyO3によるPythonネイティブ拡張
- `python/bd2rl`: Gymnasium環境、GPU PPO、評価、GUIサーバー
- `tools`: 実行コードを評価しないASTベースの外部データ同期
- `ui`: 学習から分離された観戦・対戦画面
- `docs`: 概念設計、出典台帳、実機検証マトリクス

## セットアップ

PowerShellで次を実行します。

```powershell
py -3.13 -m venv .venv
.\.venv\Scripts\python.exe -m pip install torch==2.13.0 --index-url https://download.pytorch.org/whl/cu130
.\.venv\Scripts\python.exe -m pip install -e ".[test]"
cd tools
npm install --ignore-scripts
npm run sync -- --out ../data/generated/catalog.json
node validate-catalog.mjs ../data/generated/catalog.json
node build-current-scenarios.mjs 10072 6
cd ..
cargo run -p bd2-data --bin bd2-data -- import-catalog data/generated/catalog.json data/generated/bd2.sqlite
cargo run -p bd2-data --bin bd2-data -- import-scenario data/scenarios/normal-demo.json data/generated/bd2.sqlite
cargo run -p bd2-data --bin bd2-data -- import-scenario data/scenarios/mirror-war-demo.json data/generated/bd2.sqlite
cargo run -p bd2-data --bin bd2-data -- import-scenario data/scenarios/monster-chaser-current.json data/generated/bd2.sqlite
cargo run -p bd2-data --bin bd2-data -- inspect data/generated/bd2.sqlite
```

GPU確認、学習、GUIは次のエントリーポイントを使用します。

```powershell
.\.venv\Scripts\bd2-device-check.exe
.\.venv\Scripts\bd2-train.exe --database data/generated/bd2.sqlite --scenario data/scenarios/monster-chaser-current.json --output checkpoints/monster-chaser.pt
.\.venv\Scripts\bd2-evaluate.exe --database data/generated/bd2.sqlite --scenario data/scenarios/monster-chaser-current.json --checkpoint checkpoints/monster-chaser.pt
.\.venv\Scripts\bd2-gui.exe --database data/generated/bd2.sqlite --scenario data/scenarios/monster-chaser-current.json --checkpoint checkpoints/monster-chaser.pt --policy-side ENEMY
```

`--policy-side PLAYER` または `ENEMY` で学習済み方策の担当陣営を選べます。チェックポイントを省略すれば双方を手動操作でき、GUI自体を起動しなければ学習経路にはHTTP・描画処理が入りません。WindowsでTritonが利用できない場合はGPU CUDA Graph、利用可能な環境ではInductorを自動選択し、CUDA上でbf16/fp16混合精度を使います。

方策観測は最大32ユニット×56特徴、16個の戦闘全体特徴、5つの行動スロットから実ユニットへの索引、5×32の合法手マスクで構成します。HP・位置・実効能力、軽減・被ダメージ補正、回避、バリア、効果極性と主要状態タグ、CT、チェイン、召喚/部位、魔物追跡者のLv・残HP・編成を含みます。Pythonの単体環境とRustの並列環境は同じネイティブ観測生成器を使い、両者の一致を回帰テストします。チェックポイントには観測スキーマとモデル構造IDを保存し、不一致の古いモデルは読み込み時に拒否します。

## テスト

```powershell
cargo fmt --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
.\.venv\Scripts\ruff.exe format --check python
.\.venv\Scripts\ruff.exe check python
.\.venv\Scripts\pytest.exe -q
node --check tools/sync-bd2db.mjs
node --check tools/build-current-scenarios.mjs
node --check tools/validate-catalog.mjs
node tools/validate-catalog.mjs data/generated/catalog.json
```

データ同期で「未コンパイル」と判定されたスキルは、意味を推測して合法手へ混入させません。原文と出典ハッシュをSQLiteへ保存し、型付きDSLへの完全な変換が済んだものだけを戦闘で使用します。意味検査器は全12,509派生に加え、各衣装の攻略タグが直接命令、入れ子トリガー、オーラ、召喚先スキルのいずれかへ型付きで対応することも確認します。

戦闘コアが再現可能であることと、ゲームクライアントとの完全一致は別の検証段階です。未取得の実機境界ケースは [実機検証マトリクス](docs/research/browndust2-combat-verification-matrix.md) に残し、通過していない項目を「完全再現済み」とは扱いません。
