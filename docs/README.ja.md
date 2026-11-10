# derp-workers

**Cloudflare Workers の無料プラン**だけで動く Tailscale 互換 DERP リレー——サーバー不要、コストゼロ。

Tailscale 公式の DERP サーバー実装([`tailscale.com/derp/derpserver`](https://pkg.go.dev/tailscale.com/derp/derpserver))をそのまま WebAssembly にコンパイルし、Durable Object 内に組み込んでいます。ブラウザ版 Tailscale クライアント(tsconnect)が WebSocket で接続し、パケットを中継します。使われるのは本物のプロトコルスタックであり、再実装ではありません。

```
Tailscale クライアント ──WebSocket──▶ Worker ──▶ Durable Object ──▶ Go/WASM derpserver(未変更)
   (ブラウザ tsconnect)                                              │
Tailscale クライアント ──WebSocket──────────────────────────── パケット ──┘
```

## ステータス

| 機能 | 状態 | 詳細 |
|---|---|---|
| 公式 DERP サーバー(`tailscale.com/derp/derpserver`)を Workers Free で実行 | そのまま動作——`js/wasm` にコンパイル、初期化は約 200 ms | [M1](milestone-1.md) |
| フルプロトコル——ハンドシェイク、ping/pong、転送、PeerGone、再接続 | 動作中 | [M2–3](milestone-2-3-validation.md) |
| ブラウザ(tsconnect)クライアントが実際の `derphttp` スタックを利用 | 動作中 | [M4](milestone-4.md) |
| 無料プランでの本番 CPU | フロントエンド中央値 0.7 ms / DO 中央値 5.2 ms、強制終了ゼロ | [計測データ](measurements.md) |
| CI 検証(ローカル workerd、アカウントへのアクセスなし) | プッシュごとに実行 | [validate.yml](../.github/workflows/validate.yml) |

## クイックスタート

```sh
npm install
npm run test:wasm-worker   # ローカル workerd 上の公式ネイティブ DERP クライアントスイート
npm run test:browser       # ヘッドレス Chromium 上の公式ブラウザ WASM クライアントスイート
```

自分でデプロイした worker に対してテストするには:

```sh
npm run deploy        # wasm をビルドして cf deploy(または:npx wrangler deploy)
CF_DERP_BASE_URL=https://<your-worker>.<your-subdomain>.workers.dev \
  BROWSER_BIN=/path/to/chromium npm run test:browser
```

Push の CI はローカルのみで検証し、Cloudflare アカウントにはアクセスしない。本番デプロイは手動ワークフロー [deploy.yml](../.github/workflows/deploy.yml) で行う:`CLOUDFLARE_API_TOKEN`(secret)、`CLOUDFLARE_ACCOUNT_ID`(変数)、本物の `DERP_SERVER_KEY` secret(公開テスト鍵は拒否)が必要で、デプロイ後に本番リレーへ読み取り専用のフルスイートを実行する。

## リポジトリ構成

```
cmd/derp-wasm/         Go/WASM DERP サーバー(syscall/js ブリッジ、net.Conn アダプター)
cmd/derp-client-test/  ネイティブクライアントスイート(公式 derp.Client を Node WebSocket 経由で)
cmd/derp-browser-test/ ブラウザクライアントスイート(公式 derphttp、js/wasm、probe.html)
src/index.js           Worker エントリ + Durable Object WebSocket ブリッジ
scripts/               ビルドとテストのドライバー
docs/                  マイルストーン報告と計測データ
```

## 既知の制限

- **ブラウザクライアントは 32 KiB を超えるフレームを受信できない。** `tailscale.com` の WebSocket ラッパーにおけるアップストリームのバグです([tailscale/tailscale#22293](https://github.com/tailscale/tailscale/pull/22293) で修正済み)。マージされるまでの間も、実際の tailnet トラフィック(約 1.5 KB のパケット)には影響しません。詳細は [M4](milestone-4.md)。
- **公式のネイティブ `tailscaled` クライアントは接続できない。** ネイティブクライアントは `/derp` へ素の HTTPS ストリームで接続するが、Worker は WebSocket アップグレードしか受け付けない——カスタム DERPMap エントリが有効なのはブラウザ/WASM(tsconnect)クライアント、または `ts_debug_websockets` タグ + `TS_DEBUG_DERP_WS_CLIENT` 環境変数でビルドした tailscaled のみ。リポジトリの「ネイティブスイート」は公式 Go `derp.Client` を Node WebSocket で動かすもので、tailscaled ではない。
- **`DERP_SERVER_KEY`(64 桁 hex のノード秘密鍵。Worker シークレットとして設定——`cf workers secrets update DERP_SERVER_KEY`)なしではリレーは起動を拒否する。** ローカル開発では決定論的な公開テスト鍵が `.dev.vars` に自動書き込みされる。その鍵のままデプロイすると誰でもリレーになりすませてしまう。probe の `testKey` フィールドが如実に報告する。
- 各リージョンは独立:それぞれが独自の peer レジストリを持ち、1 つの通信の両 peer は同じリージョンを使う必要がある。リージョン間転送は未対応。

## ドキュメント

- [architecture.md](architecture.md) —— Go サーバー、`syscall/js` ブリッジ、WebSocket アダプターの構成
- [measurements.md](measurements.md) —— スループット、メモリ、本番 CPU 時間
- [milestone-1.md](milestone-1.md) · [milestone-2-3-validation.md](milestone-2-3-validation.md) · [milestone-4.md](milestone-4.md) —— 検証報告
