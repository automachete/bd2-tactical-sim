# Svelte 5完全置換の非回帰検証

## 対象

Vanilla JavaScriptの直接配信を廃止し、TypeScript + Svelte 5 + Viteの本番成果物だけをPythonのデバッグプレイヤーから配信する。Rust戦闘コア、HTTP API、DOMの操作契約、CSSおよびローカル画像は変更しない。

旧`app.js`、`battle-ui-model.mjs`、`i18n.mjs`、ルート`styles.css`は残さず、ビルド成果物が欠けていれば起動時に異常終了する。後方互換フォールバックは設けない。

## UI/UX照合

- 移行前後に同じシード42、通常戦闘、1440×900、読込後1.5秒で全画面を撮影した。
- 両PNGのSHA-256は`AEE22D85AFEBC71F87512CAFEC87E0BDB332BE14FC6135B2F83578FDB6B6D3A1`で一致した。
- Svelteの`#app`境界で高さ継承が切れる初回差分を検出し、`html`、`body`、`#app`を100%高に統一して解消した。
- Playwrightの全83既存シナリオは移行後のVite本番ビルド経由で成功した。さらにSvelteマウント境界が1440×900全域を保持する回帰テストを追加した。

## 学習経路の隔離と性能

`bd2rl.train`は`bd2rl.gui`または`http.server`を読み込まず、Node.jsプロセスも起動しない。学習経路は従来どおり`NativeBatchEnv`からRust拡張、NumPyテンソル、PyTorch GPUへ直接進む。

同一PC、RTX 5070 Ti、batch 64、12,800環境stepで移行後に3回独立測定した中央値は次のとおり。

| 指標 | 移行前 | 移行後中央値 | 差 |
|---|---:|---:|---:|
| Rust→NumPy環境step/秒 | 2,810.0 | 2,790.7 | -0.69% |
| GPU転送frame/秒 | 59,010.4 | 52,920.1 | -10.32% |
| 方策forward frame/秒 | 16,904.8 | 17,277.3 | +2.20% |

環境stepと方策forwardに大幅な劣化はない。GPU転送は単発処理時間が短く分散が大きく、移行後3回は48,973.3～65,358.0 frame/秒で移行前値を包含する。UIコードはこの測定経路へimportされないため、差は測定揺らぎとして扱う。

## 実行した検証

```powershell
cd ui
npm run check
npm run test
npm run build

cd ..\tools
npm run test:ui

cd ..
.\.venv\Scripts\python.exe -m pytest -q
```
