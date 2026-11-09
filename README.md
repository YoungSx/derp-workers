# derp-workers

PoC for running Tailscale's official DERP server as Go `js/wasm` inside a Cloudflare Durable Object, relayed over WebSockets, and tested against both native and browser WASM Tailscale clients.

```sh
npm install
npm run test:wasm-worker   # official native Go DERP client suite over local workerd
npm run test:browser       # official browser Go/WASM client suite in headless Chromium
```

Status by milestone:

- [Milestone 1](docs/milestone-1.md) — `derpserver` compiles to `js/wasm` and initializes in `workerd`.
- [Milestones 2–3](docs/milestone-2-3-validation.md) — DO + WebSocket bridge, native-client protocol suite (local and deployed), dual-client forwarding.
- [Milestone 4](docs/milestone-4.md) — browser WASM client suite, throughput, and resource measurements.

The server key in this repo is deterministic test data and is not suitable for deployment.
