# derp-workers

**Cloudflare Workers の無料プラン**だけで動く Tailscale 互換 DERP リレー——サーバー不要、コストゼロ。

Tailscale 公式の DERP サーバー実装([`tailscale.com/derp/derpserver`](https://pkg.go.dev/tailscale.com/derp/derpserver))をそのまま WebAssembly にコンパイルし、Durable Object 内に組み込んでいます。ネイティブおよびブラウザ版 Tailscale クライアントが WebSocket で接続し、パケットを中継します。使われるのは本物のプロトコルスタックであり、再実装ではありません。

```
Tailscale クライアント ──WebSocket──▶ Worker ──▶ Durable Object ──▶ Go/WASM derpserver(未変更)
   (ネイティブまたは tsconnect)                                              │
Tailscale クライアント ──WebSocket──────────────────────────── パケット ──┘
```

## 何を証明するか

| 問題 | 答え | 証拠 |
|---|---|---|
| 公式 DERP サーバーは `workerd` で動くか? | 動く——`js/wasm` にコンパイルされ、初期化は約 200 ms | [M1](milestone-1.md) |
| 本物のクライアントでプロトコル完走できるか? | できる——ハンドシェイク、ping/pong、転送、PeerGone、再接続 | [M2–3](milestone-2-3-validation.md) |
| ブラウザ(tsconnect)スタックは動くか? | 動く——tsconnect が使うのと同じ `derphttp` + WebSocket 経路 | [M4](milestone-4.md) |
| 無料プランで持つか? | 持つ——リクエストあたり中央値 CPU 0.6–0.8 ms、制限は 10 ms | [計測データ](measurements.md) |
| デプロイ済みでの E2E 検証は再現可能か? | 可能——CI が毎回新しい worker をデプロイし、両スイートを実行して削除 | [validate.yml](../.github/workflows/validate.yml) |

## クイックスタート

```sh
npm install
npm run test:wasm-worker   # ローカル workerd 上の公式ネイティブ DERP クライアントスイート
npm run test:browser       # ヘッドレス Chromium 上の公式ブラウザ WASM クライアントスイート
```

自分でデプロイした worker に対してテストするには:

```sh
npx wrangler deploy
CF_DERP_BASE_URL=https://<your-worker>.<your-subdomain>.workers.dev \
  BROWSER_BIN=/path/to/chromium npm run test:browser
```

CI には `CLOUDFLARE_API_TOKEN`(secret)と `CLOUDFLARE_ACCOUNT_ID`(変数)が必要です。

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
- **リポジトリ内のサーバー鍵は決定論的なテストデータ。** このままデプロイすると誰でもリレーになりすませてしまいます。実運用の前に必ず自分の鍵を生成してください。
- 単一リージョン・単一 Durable Object。本番用メッシュではありません。

## ドキュメント

- [architecture.md](architecture.md) —— Go サーバー、`syscall/js` ブリッジ、WebSocket アダプターの構成
- [measurements.md](measurements.md) —— スループット、メモリ、本番 CPU 時間
- [milestone-1.md](milestone-1.md) · [milestone-2-3-validation.md](milestone-2-3-validation.md) · [milestone-4.md](milestone-4.md) —— 検証報告
