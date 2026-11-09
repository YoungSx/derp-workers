# Milestone 1: official DERP server on Go/WASM

## Result

**Pass for compilation and local Cloudflare Workers runtime initialization.** The upstream `tailscale.com/derp/derpserver` package compiles to `js/wasm`. Its real `derpserver.New` constructor ran under Wrangler's local `workerd` runtime. The Go main goroutine remained blocked on a channel and resumed on two later Worker requests through `syscall/js` callbacks; the same server key was returned across requests.

This does not yet prove DERP handshakes or forwarding. The probe does not call `Server.Accept`, provide a WebSocket-backed `net.Conn`, or run in a deployed Cloudflare account.

## Reproduction

The verified toolchain and upstream revision were:

- Local Go launcher: `go1.22.2 linux/arm64`; automatic toolchain selection downloaded and used `go1.27.3 linux/arm64`, as required by the pinned Tailscale module.
- Tailscale tag: [`v1.104.5`](https://github.com/tailscale/tailscale/tree/v1.104.5)
- Tailscale commit: `73a48057aaf5f60e4f770b398e9b7af576b01dbe`
- Wrangler: `4.158.0`
- Build command: `GOOS=js GOARCH=wasm go build -trimpath -o artifacts/derp.wasm ./cmd/derp-wasm`

Run:

```sh
npm install
npm run test:wasm-worker
```

`npm run build:wasm` writes the compiler version, exact command, and complete compiler output to `artifacts/wasm-build.log` (local build output, not committed). A successful Go build is silent after the recorded command. The generated `artifacts/derp.wasm` is about 9.3 MiB.

The local Worker test instantiates Go using the matching `wasm_exec.js` from `go env GOROOT`, constructs an actual official DERP server, then checks server-key stability and two JS-to-Go wakeups across requests. The observed local initialization was `203 ms`; this is wall time under local `workerd`, not Cloudflare CPU time. The successful test prints a JSON record containing initialization time and both wake counts. Wrangler's deploy dry run reports `9,530.13 KiB` uncompressed (`2,590.30 KiB` gzip), below the 64 MiB uncompressed bundle limit.

## Compatibility findings

- No unsupported system call blocked the `js/wasm` build or the exercised server constructor. This is evidence only for the imported package's compile-time dependency graph and the code paths reached by `derpserver.New`; it does not validate connection I/O paths.
- Go's standard WASM runtime can stay active in local `workerd` when the Go main goroutine waits on a channel and JavaScript events resume it. A bare `select {}` did not work: it caused the Worker request to be treated as hung. Keep the server event loop event-driven.
- The module currently uses a fixed, deterministic key solely for reproducible local testing. It is public test material and must never be used by a deployed server.
- Wrangler local mode is an actual `workerd` runtime test, but it does not establish production-account behavior, free-plan CPU headroom, memory usage, pricing, or network WebSocket compatibility.

## Cloudflare free-plan context

As of the Cloudflare docs consulted on 2026-11-09, Workers Free includes 100,000 requests/day, 10 ms CPU per HTTP request, 128 MB isolate memory, and a 64 MiB uncompressed bundle. The bundle fits, but the local 208 ms initialization measurement is wall time and gives no evidence that first-request CPU fits the 10 ms Free limit. The Durable Objects pricing docs list 13,000 GB-s/day free duration and charge duration while an accepted ordinary WebSocket keeps an object active. At the full 128 MiB allocation, one continuously active object uses `0.125 × 86,400 = 10,800 GB-s/day` (about 83% of that daily allowance). This makes an always-on, non-hibernating single-region DO a narrow free-plan fit even before testing real traffic. The project handoff explicitly defers Hibernation, so that cost constraint remains unresolved.

Sources: [Workers limits](https://developers.cloudflare.com/workers/platform/limits/), [Workers Wasm](https://developers.cloudflare.com/workers/runtime-apis/webassembly/), [Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/), and [Durable Objects limits](https://developers.cloudflare.com/durable-objects/platform/limits/).

## Next proof

Implement the smallest real WebSocket bridge to an official `Server.Accept`, then test a single official DERP handshake. The key risk is not compilation; it is making `net.Conn` reads, writes, deadlines, closure, and Worker event lifetime cooperate with the Go WASM scheduler and the Durable Object's WebSocket lifecycle.
