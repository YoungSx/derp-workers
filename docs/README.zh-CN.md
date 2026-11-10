# derp-workers

一个完全跑在 **Cloudflare Workers 免费套餐**上的 Tailscale 兼容 DERP 中继——没有服务器,零成本。

它把 Tailscale 官方 DERP 服务端实现([`tailscale.com/derp/derpserver`](https://pkg.go.dev/tailscale.com/derp/derpserver))原封不动编译成 WebAssembly,嵌入 Durable Object。原生和浏览器版 Tailscale 客户端通过 WebSocket 连接并经由它转发数据包,走的是真实协议栈——不是重新实现。

```
Tailscale 客户端 ──WebSocket──▶ Worker ──▶ Durable Object ──▶ Go/WASM derpserver(未修改)
    (原生或 tsconnect)                                                  │
Tailscale 客户端 ──WebSocket────────────────────────────── 数据包 ──┘
```

## 状态

| 能力 | 状态 | 详情 |
|---|---|---|
| 官方 DERP 服务端(`tailscale.com/derp/derpserver`)跑在 Workers Free 上 | 原样运行,编译为 `js/wasm`,约 200 ms 完成初始化 | [M1](milestone-1.md) |
| 完整协议——握手、ping/pong、转发、PeerGone、重连 | 可用 | [M2–3](milestone-2-3-validation.md) |
| 浏览器(tsconnect)客户端走真实 `derphttp` 协议栈 | 可用 | [M4](milestone-4.md) |
| 免费套餐下的生产 CPU | 前端中位 0.7 ms / DO 中位 5.2 ms,零终止 | [测量数据](measurements.md) |
| CI 验证(本地 workerd,零账号访问) | 每次 push | [validate.yml](../.github/workflows/validate.yml) |

## 快速开始

```sh
npm install
npm run test:wasm-worker   # 本地 workerd 上的官方原生 DERP 客户端套件
npm run test:browser       # 无头 Chromium 中的官方浏览器 WASM 客户端套件
```

测试你自己部署的 worker:

```sh
npm run deploy        # 构建 wasm 后 cf deploy(或:npx wrangler deploy)
CF_DERP_BASE_URL=https://<your-worker>.<your-subdomain>.workers.dev \
  BROWSER_BIN=/path/to/chromium npm run test:browser
```

Push CI 纯本地验证,零 Cloudflare 账号访问。生产部署走手动工作流 [deploy.yml](../.github/workflows/deploy.yml):需要 `CLOUDFLARE_API_TOKEN`(secret)、`CLOUDFLARE_ACCOUNT_ID`(变量)和真实的 `DERP_SERVER_KEY` secret(拒绝公开测试密钥),部署后对生产中继跑只读全套件。

## 仓库结构

```
cmd/derp-wasm/         Go/WASM DERP 服务端(syscall/js 桥接、net.Conn 适配器)
cmd/derp-client-test/  原生客户端套件(官方 derp.Client 走 Node WebSocket)
cmd/derp-browser-test/ 浏览器客户端套件(官方 derphttp,js/wasm,probe.html)
src/index.js           Worker 入口 + Durable Object WebSocket 桥接
scripts/               构建与测试驱动脚本
docs/                  里程碑报告与测量数据
```

## 已知限制

- **浏览器客户端收不了超过 32 KiB 的帧。** 这是 `tailscale.com` WebSocket 包装层的上游 bug([tailscale/tailscale#22293](https://github.com/tailscale/tailscale/pull/22293) 已修复该问题);在合入之前,真实 tailnet 流量(约 1.5 KB 的包)不受影响。详见 [M4](milestone-4.md)。
- **没有 `DERP_SERVER_KEY`(64 位 hex 的节点私钥,以 Worker secret 设置——`cf workers secrets update DERP_SERVER_KEY`)时中继拒绝运行。** 本地开发会自动把确定性公开测试密钥写进 `.dev.vars`;部署那个密钥会让任何人都能冒充该中继。probe 的 `testKey` 字段会如实报告。
- 各区域相互独立:每个区域有自己的 peer 注册表,一次通信的两个 peer 必须使用同一区域。暂无跨区域转发。

## 文档

- [architecture.md](architecture.md) —— Go 服务端、`syscall/js` 桥接与 WebSocket 适配器如何组合
- [measurements.md](measurements.md) —— 吞吐、内存与生产 CPU 时间
- [milestone-1.md](milestone-1.md) · [milestone-2-3-validation.md](milestone-2-3-validation.md) · [milestone-4.md](milestone-4.md) —— 验证报告
