# derp-workers

一個完全跑在 **Cloudflare Workers 免費方案**上的 Tailscale 相容 DERP 中繼——沒有伺服器,零成本。

它把 Tailscale 官方 DERP 伺服器實作([`tailscale.com/derp/derpserver`](https://pkg.go.dev/tailscale.com/derp/derpserver))原封不動編譯成 WebAssembly,嵌入 Durable Object。原生與瀏覽器版 Tailscale 用戶端透過 WebSocket 連線並經由它轉送封包,走的是真實協定堆疊——不是重新實作。

```
Tailscale 用戶端 ──WebSocket──▶ Worker ──▶ Durable Object ──▶ Go/WASM derpserver(未修改)
    (原生或 tsconnect)                                                  │
Tailscale 用戶端 ──WebSocket────────────────────────────── 封包 ──┘
```

## 它證明了什麼

| 問題 | 答案 | 證據 |
|---|---|---|
| 官方 DERP 伺服器能在 `workerd` 裡跑嗎? | 能——編譯為 `js/wasm`,約 200 ms 完成初始化 | [M1](milestone-1.md) |
| 真實用戶端能走完協定嗎? | 能——交握、ping/pong、轉送、PeerGone、重連 | [M2–3](milestone-2-3-validation.md) |
| 瀏覽器(tsconnect)協定堆疊能用嗎? | 能——正是 tsconnect 所用的 `derphttp` + WebSocket 路徑 | [M4](milestone-4.md) |
| 免費方案撐得住嗎? | 撐得住——每請求中位數 CPU 0.6–0.8 ms,限額 10 ms | [測量數據](measurements.md) |
| 可重複地部署端到端驗證? | 可以——CI 部署全新 worker、跑兩套測試、再刪除 | [validate.yml](../.github/workflows/validate.yml) |

## 快速開始

```sh
npm install
npm run test:wasm-worker   # 本地 workerd 上的官方原生 DERP 用戶端套件
npm run test:browser       # 無頭 Chromium 中的官方瀏覽器 WASM 用戶端套件
```

測試你自己部署的 worker:

```sh
npx wrangler deploy
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
- **儲存庫裡的伺服器金鑰是確定性測試資料。** 直接部署會讓任何人都能冒充該中繼。任何真實用途前請產生自己的金鑰。
- 單區域、單 Durable Object;不是生產級 mesh。

## 文件

- [architecture.md](architecture.md) —— Go 伺服器、`syscall/js` 橋接與 WebSocket 轉接器如何組合
- [measurements.md](measurements.md) —— 吞吐、記憶體與生產 CPU 時間
- [milestone-1.md](milestone-1.md) · [milestone-2-3-validation.md](milestone-2-3-validation.md) · [milestone-4.md](milestone-4.md) —— 驗證報告
