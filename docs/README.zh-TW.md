# derp-workers

一個完全跑在 **Cloudflare Workers 免費方案**上的 Tailscale 相容 DERP 中繼——沒有伺服器,零成本。

它把 Tailscale 官方 DERP 伺服器實作([`tailscale.com/derp/derpserver`](https://pkg.go.dev/tailscale.com/derp/derpserver))原封不動編譯成 WebAssembly,嵌入 Durable Object。原生與瀏覽器版 Tailscale 用戶端透過 WebSocket 連線並經由它轉送封包,走的是真實協定堆疊——不是重新實作。

```
Tailscale 用戶端 ──WebSocket──▶ Worker ──▶ Durable Object ──▶ Go/WASM derpserver(未修改)
    (原生或 tsconnect)                                                  │
Tailscale 用戶端 ──WebSocket────────────────────────────── 封包 ──┘
```

## 狀態

| 能力 | 狀態 | 詳情 |
|---|---|---|
| 官方 DERP 伺服器(`tailscale.com/derp/derpserver`)跑在 Workers Free 上 | 原樣運行,編譯為 `js/wasm`,約 200 ms 完成初始化 | [M1](milestone-1.md) |
| 完整協定——交握、ping/pong、轉送、PeerGone、重連 | 可用 | [M2–3](milestone-2-3-validation.md) |
| 瀏覽器(tsconnect)用戶端走真實 `derphttp` 協定堆疊 | 可用 | [M4](milestone-4.md) |
| 免費方案下的生產 CPU | 前端中位數 0.7 ms / DO 中位數 5.2 ms,零終止 | [測量數據](measurements.md) |
| CI 中的部署端到端驗證 | 每次 push | [validate.yml](../.github/workflows/validate.yml) |

## 快速開始

```sh
npm install
npm run test:wasm-worker   # 本地 workerd 上的官方原生 DERP 用戶端套件
npm run test:browser       # 無頭 Chromium 中的官方瀏覽器 WASM 用戶端套件
```

測試你自己部署的 worker:

```sh
npm run deploy        # 建置 wasm 後 cf deploy(或:npx wrangler deploy)
CF_DERP_BASE_URL=https://<your-worker>.<your-subdomain>.workers.dev \
  BROWSER_BIN=/path/to/chromium npm run test:browser
```

CI 需要 `CLOUDFLARE_API_TOKEN`(secret)和 `CLOUDFLARE_ACCOUNT_ID`(變數)。

## 儲存庫結構

```
cmd/derp-wasm/         Go/WASM DERP 伺服器(syscall/js 橋接、net.Conn 轉接器)
cmd/derp-client-test/  原生用戶端套件(官方 derp.Client 走 Node WebSocket)
cmd/derp-browser-test/ 瀏覽器用戶端套件(官方 derphttp,js/wasm,probe.html)
src/index.js           Worker 入口 + Durable Object WebSocket 橋接
scripts/               建置與測試驅動腳本
docs/                  里程碑報告與測量數據
```

## 已知限制

- **瀏覽器用戶端收不了超過 32 KiB 的幀。** 這是 `tailscale.com` WebSocket 包裝層的上游 bug([tailscale/tailscale#22293](https://github.com/tailscale/tailscale/pull/22293) 已修復該問題);在合入之前,真實 tailnet 流量(約 1.5 KB 的封包)不受影響。詳見 [M4](milestone-4.md)。
- **沒有 `DERP_SERVER_KEY`(64 位 hex 的節點私鑰,以 Worker secret 設定——`cf workers secrets update DERP_SERVER_KEY`)時中繼拒絕運行。** 本地開發會自動把確定性公開測試金鑰寫進 `.dev.vars`;部署那個金鑰會讓任何人都能冒充該中繼。probe 的 `testKey` 欄位會如實回報。
- 各區域相互獨立:每個區域有自己的 peer 註冊表,一次通訊的兩個 peer 必須使用同一區域。暫無跨區域轉發。

## 文件

- [architecture.md](architecture.md) —— Go 伺服器、`syscall/js` 橋接與 WebSocket 轉接器如何組合
- [measurements.md](measurements.md) —— 吞吐、記憶體與生產 CPU 時間
- [milestone-1.md](milestone-1.md) · [milestone-2-3-validation.md](milestone-2-3-validation.md) · [milestone-4.md](milestone-4.md) —— 驗證報告
