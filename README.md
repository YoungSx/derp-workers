# derp-workers

A Tailscale-compatible DERP relay that runs entirely on the **Cloudflare Workers Free plan** — no servers, no cost.

[简体中文](docs/README.zh-CN.md) · [繁體中文](docs/README.zh-TW.md) · [日本語](docs/README.ja.md)

It embeds Tailscale's official DERP server implementation ([`tailscale.com/derp/derpserver`](https://pkg.go.dev/tailscale.com/derp/derpserver)) unchanged, compiled to WebAssembly, inside a Durable Object. Native and browser Tailscale clients connect to it over WebSocket and exchange packets through it, using the real protocol stack — not a reimplementation.

```
Tailscale client ──WebSocket──▶ Worker ──▶ Durable Object ──▶ Go/WASM derpserver (unmodified)
      (native or tsconnect)                                              │
Tailscale client ──WebSocket────────────────────────────────── packets ──┘
```

## Status

| Capability | Status | Details |
|---|---|---|
| Official DERP server (`tailscale.com/derp/derpserver`) on Workers Free | Runs unmodified, compiles to `js/wasm`, inits in ~200 ms | [M1](docs/milestone-1.md) |
| Full protocol — handshake, ping/pong, forwarding, PeerGone, reconnect | Working | [M2–3](docs/milestone-2-3-validation.md) |
| Browser (tsconnect) clients over the real `derphttp` stack | Working | [M4](docs/milestone-4.md) |
| Production CPU on the Free plan | 0.7 ms frontend / 5.2 ms DO median, zero terminations | [Measurements](docs/measurements.md) |
| Deployed end-to-end validation in CI | Every push | [validate.yml](.github/workflows/validate.yml) |

## Quick start

```sh
npm install
npm run test:wasm-worker   # official native DERP client suite over local workerd
npm run test:browser       # official browser WASM client suite in headless Chromium
```

To test against your own deployed worker:

```sh
npx wrangler deploy
CF_DERP_BASE_URL=https://<your-worker>.<your-subdomain>.workers.dev \
  BROWSER_BIN=/path/to/chromium npm run test:browser
```

CI needs `CLOUDFLARE_API_TOKEN` (secret) and `CLOUDFLARE_ACCOUNT_ID` (variable).

## Repository layout

```
cmd/derp-wasm/         the Go/WASM DERP server (syscall/js bridge, net.Conn adapter)
cmd/derp-client-test/  native client suite (official derp.Client over Node WebSocket)
cmd/derp-browser-test/ browser client suite (official derphttp, js/wasm, probe.html)
src/index.js           Worker entry + Durable Object WebSocket bridge
scripts/               build + test drivers
docs/                  milestone reports and measurements
```

## Known limitations

- **Browser clients cannot receive frames over 32 KiB.** An upstream bug in `tailscale.com`'s WebSocket wrapper ([tailscale/tailscale#22293](https://github.com/tailscale/tailscale/pull/22293) fixes it); until it lands, real tailnet traffic (~1.5 KB packets) is unaffected. Details in [M4](docs/milestone-4.md).
- **The server key in this repo is deterministic test data.** Deploying it as-is would let anyone impersonate the relay. Generate your own before any real use.
- Single region, single Durable Object; not a production mesh.

## Documentation

- [docs/architecture.md](docs/architecture.md) — how the Go server, `syscall/js` bridge, and WebSocket adapter fit together
- [docs/measurements.md](docs/measurements.md) — throughput, memory, and production CPU time
- [docs/milestone-1.md](docs/milestone-1.md) · [docs/milestone-2-3-validation.md](docs/milestone-2-3-validation.md) · [docs/milestone-4.md](docs/milestone-4.md) — validation reports
