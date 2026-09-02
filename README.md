# BrownDust2 Tactical Simulator

BrownDust2 の現行戦闘ルールを、決定論的なRustコア、版管理されたSQLiteデータ、Gymnasium/TorchRL環境、GPU学習器、任意起動のローカルGUIとして再現するプロジェクトです。

対象モードは通常戦闘、鏡戦争、魔物追跡者です。2026-09-02スナップショットには★5プレイアブル61体、プレイヤー用155コスチューム、召喚4種、現行ボス用5スキル、強化・潜在力・バーストを展開した合計12,509派生を収録します。公開情報から変換した仕様と、現行クライアントで実測済みの仕様は検証台帳で区別します。

## 構成

- `crates/bd2-core`: OSやGUIから独立した戦闘状態・イベント・算術・モード処理
- `crates/bd2-data`: SQLiteスキーマ、現行スナップショット、シナリオ管理
- `crates/bd2-py`: PyO3によるPythonネイティブ拡張
- `python/bd2rl`: Gymnasium環境、GPU PPO、評価、MCTS、シミュレータ専用GUIサーバー
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
npx playwright install chromium
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

シミュレータだけをデバッグプレイする場合は、学習やチェックポイント作成を行わず次の1コマンドで起動します。ブラウザ上で通常戦闘、鏡戦争、モンスターチェイサーを切り替え、★5キャラクター、配置、全コスチュームの凸・バースト・潜在力、コスチュームリンク、伝説UR IV／★5専用URの5部位装備、精錬18～24、副能力、専用主能力、刻印・覚醒、コレクション、外部バフ、BD2DB装備計算条件を編集できます。

```powershell
.\.venv\Scripts\bd2-play.exe
```

通常戦闘と鏡戦争ではPLAYERのスキルと行動順を手動操作し、ENEMYは現在状態から毎手番UCT方式のMCTSを実行します。事前学習済みモデルは使用しません。モンスターチェイサーでは2つのPLAYERパーティを別々に編成でき、魔物側は外部DBにあるスキル順序、CT、条件発動を使うルールAIで自動進行します。既定のMCTS探索回数は48回で、画面または `--mcts-simulations` から変更できます。`bd2-gui.exe` は同じシミュレータ専用画面の別名です。

戦闘画面は見下ろし専用の3×4盤面と予約操作を採用します。左側は「縦の行動順」と「選択ユニットの縦の行動候補」を隣接させ、ユニット選択、予約、順番確認を一か所で完結させます。味方駒はマウス／タッチのドラッグで移動でき、占有マスへ落とすと2体を入れ替えます。Spaceで駒を持ち上げ、矢印で移動先、Enterで確定、Escで取消するキーボード操作も同じ結果になります。行動順カード自体をマウス／タッチでドラッグして任意の挿入位置へ変更し、独立した順番編集モードはありません。コスチューム／基本行動を予約し、戦闘開始で順番・行動・予定配置をRustコアへ一括送信します。対象確認は予定済みの先行行動まで一時シミュレーションし、確定主対象、盤端で切り詰めた効果範囲、実際に範囲内にいるユニットを表示します。予測専用シミュレーターは本番状態を毎回復元して再利用し、連続操作は短く集約して旧要求を中断するため、予約や順番を素早く変えても古い範囲で詰まりません。応答イベントは攻撃者、対象マス、ダメージ、防壁、回復、チェイン、衝突、移動、召喚、チーム交替、魔物レベルと総HP、戦闘不能の順に再生され、1～3倍速と停止は実際の再生時間へ反映されます。戦闘履歴は内部JSONではなく日本語の意味表現で表示し、終局画面からも確認できます。SP不足は予約時に拒否し、クールタイム中のコスチュームは消さずに使用不可状態で残します。敵の検査、自動スキル予約、自動ターン開始、直前手番への巻戻し、リセットも同じ画面から操作できます。鏡戦争で配置が固定される場合はドラッグとキーボード移動の双方を無効化します。

UIは公式または第三者ミラーの画像、3Dモデル、音声、背景素材を読み込みません。★5キャラクター61体は、ユーザー作成の透過トークン画像、公式日本語名、属性、数値で識別します。生成画像の原寸とQA資料は`assets/character-icons`、GUI用64pxサムネイルは`ui/assets/character-icons/64`で分離管理し、実行時は64px画像だけをローカル配信します。画面はFluent 2を参考にしたフラットな中立面と、火・水・風・光・闇の5属性カラーで統一します。画面文言は`ja-JP`言語資源から取得します。コスチュームの凸・潜在力・バーストを変えた場合、範囲・SP・CT表示と、派生値を展開した現行の日本語スキル説明も該当派生へ即座に切り替わります。プレイヤーが予約できる行動は通常攻撃、ノックバック、使用可能なコスチュームスキルだけで、待機はコアAPIにも存在しません。

GPU確認、学習、評価は独立した次のエントリーポイントを使用します。

```powershell
.\.venv\Scripts\bd2-device-check.exe
.\.venv\Scripts\bd2-train.exe --database data/generated/bd2.sqlite --scenario data/scenarios/monster-chaser-current.json --output checkpoints/monster-chaser.pt
.\.venv\Scripts\bd2-evaluate.exe --database data/generated/bd2.sqlite --scenario data/scenarios/monster-chaser-current.json --checkpoint checkpoints/monster-chaser.pt
```

GUIはRust戦闘コアを直接呼び出し、Gymnasium、PPO、学習済み方策を経由しません。GUI自体を起動しなければ学習経路にはHTTP・描画・MCTS処理が入りません。WindowsでTritonが利用できない場合はGPU CUDA Graph、利用可能な環境ではInductorを自動選択し、CUDA上でbf16/fp16混合精度を使います。

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
node --check tools/validate-character-icons.mjs
node --check ui/app.js
node --test ui/tests/*.test.mjs
cd tools
npm run test:ui
cd ..
node tools/validate-catalog.mjs data/generated/catalog.json
node tools/validate-character-icons.mjs
```

データ同期で「未コンパイル」と判定されたスキルは、意味を推測して合法手へ混入させません。原文と出典ハッシュをSQLiteへ保存し、型付きDSLへの完全な変換が済んだものだけを戦闘で使用します。意味検査器は全12,509派生に加え、各衣装の攻略タグが直接命令、入れ子トリガー、オーラ、召喚先スキルのいずれかへ型付きで対応することも確認します。

現在の回帰には、全61体の★5キャラクターを実編成へ順番に投入し、通常攻撃・ノックバック・全合法コスチューム技の対象ロック、基準マス、盤端クリップ、範囲内生存ユニットを別の実戦エンジン実行と照合する常設試験を含みます。装備はBD2DB原表から独立再計算した伝説30種・専用61種、全3,626精錬／主能力ケースをRustの本番リゾルバへ通し、91種すべてを所有者の実戦セットアップでも初期化します。UIはさらに、複数予約・配置・順番を同時に変える手番、連打時の最新予測への収束、召喚後の次手番、専用装備の所有者制約と主能力、成長・外部バフ設定、チェイン、衝突、魔物レベル・編成交替・HP追従、終局後履歴を実ブラウザで検証します。

戦闘コアが再現可能であることと、ゲームクライアントとの完全一致は別の検証段階です。未取得の実機境界ケースは [実機検証マトリクス](docs/research/browndust2-combat-verification-matrix.md) に残し、通過していない項目を「完全再現済み」とは扱いません。
