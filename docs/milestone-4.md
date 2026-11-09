# Milestone 4: browser WASM client, throughput, and resource measurements

## Result

**Pass.** Two official Tailscale clients compiled as browser Go/WASM (`derphttp` over `wsconn` and `coder/websocket`'s js backend, the exact stack `cmd/tsconnect` uses) completed the full DERP suite against the local Cloudflare `workerd` deployment through the Go/WASM DERP server in the Durable Object.

## What the browser client proves beyond the native-protocol client

Milestones 2–3 used Tailscale's `derp.Client` driven by a native Go test process over a Node WebSocket. Milestone 4 runs the same official protocol stack *inside the browser*:

- `derphttp.NewClient` with `netmon.NewStatic()` (the real `netmon.New` panics under js/wasm; `NewStatic` is the documented browser path).
- `derphttp/websocket.go`'s `dialWebsocket` with the `derp` subprotocol, i.e. the browser client's actual WebSocket transport, not a test-only adapter.
- `net/wsconn.NetConn` message-boundary handling in the browser runtime.

Suite results (all local `workerd` via `wrangler dev --local`):

- Handshake and expected ServerKey match.
- Ping/pong.
- Bidirectional packet forwarding (A→B and B→A).
- 102 × 16,384-byte packets forwarded in 373.5 ms (4.3 MiB/s round-trip-acknowledged, i.e. each packet individually awaited).
- PeerGone with `PeerGoneReasonNotHere` after sending a disco message to a disconnected peer.
- Disconnect, reconnect with the same key, and resumed delivery.

Run with `npm run test:browser` (headless Chromium; `BROWSER_BIN` overrides the executable path).

## Upstream finding: browser clients cannot receive frames over 32,768 bytes

`coder/websocket`'s js backend defaults to a 32,768-byte message read limit (`ws_js.go`), and neither `derphttp` nor `net/wsconn` raises it on the js path. A browser DERP client therefore dies with `websocket: message too big` on any single WebSocket message above 32,768 bytes. Native (non-browser) clients are unaffected: `coder/websocket`'s own `netconn.go` calls `SetReadLimit(-1)` on the non-js path.

The fix is one line in `tailscale.com/derp/derphttp/websocket.go`, verified against a deployed worker (64 KiB frames deliver with it; `message too big: read limited at 32768 bytes` without it):

```diff
 	log.Printf("websocket: connected to %v", urlStr)
+	c.SetReadLimit(-1)
 	netConn := wsconn.NetConn(context.Background(), c, websocket.MessageBinary, urlStr)
```

Until it lands upstream, real WireGuard packets (~1.5 KB) stay far below the limit; the browser benchmark uses 16 KiB packets. A deployment intending browser clients should cap outgoing frames at 32 KiB or carry this patch.

## Resource measurements (local dev runtime, not production CPU billing)

All numbers are from local `wrangler dev --local` (workerd) on the test machine; they establish orders of magnitude, not Cloudflare production costs.

### Server (Go/WASM DERP server inside the Durable Object)

- WASM bundle: 9.3 MiB (14.8 MiB uncompressed as reported by wrangler upload; below the 64 MiB limit).
- Instantiation + `derpserver.New`: 203–262 ms wall time per isolate start (10 samples: 209, 214, 213, 216, 262…). This is wall time, not CPU time; Workers Free allows 10 ms CPU per request, so startup remains the largest production risk. It happens once per isolate lifetime, and the isolate stays alive while the DO holds WebSocket connections.
- Go heap after full dual-client suite: `heapAlloc` 226–356 KiB, `Sys` ~2.3–7.2 MiB, 2 goroutines idle. After 102-packet throughput: `heapAlloc` ~2.9 MiB, `Sys` ~7.2 MiB.
- The WASM memory floor is roughly 6.8 MiB initial linear memory; the isolate's 128 MiB limit leaves large headroom for the connection registry.

### Client (browser WASM probe)

- Instantiation: 52–262 ms in Chromium.
- Linear memory: 6.5 MiB at boot, growing to 10.5 MiB after the 102-packet run (GC returns to ~7 MiB baseline).

### Throughput

- 102 × 16 KiB packets, sender waiting for each delivery: 360–410 ms per run (~4.2 MiB/s end-to-end, browser→workerd→Go→workerd→browser).
- The earlier native-client benchmark reached 29.9 MiB/s over loopback; the browser path is roughly 7× slower, dominated by per-message `syscall/js` copying and round-trip acknowledgment.

## Remaining unverified for production

- Production CPU time per request and per WebSocket message (Free plan 10 ms/request) — needs a deployed account's metrics.
- Real deployed throughput and latency from browsers over the internet.
- Durable Object Duration billing under sustained connections (still ~10,800 GB-s/day at 128 MiB always-on vs. 13,000 free).
- Cloudflare's WebSocket message size limits in production (local `workerd` accepted the 64 KiB frames the browser stack then rejected client-side).

## Deployed end-to-end validation (CI)

`.github/workflows/validate.yml` runs on every push to `main`: it deploys a temporary worker to a real Cloudflare account (`wrangler deploy --name derp-workers-validate`), runs the native official-client suite and the browser WASM client suite against the deployed `workers.dev` URL, then deletes the worker. This repeats the deployed-worker validation on a clean deployment each run.

## Artifacts

- `cmd/derp-browser-test/` — browser WASM client suite (Go source + `probe.html`).
- `scripts/test-browser.mjs` — headless-Chromium driver; prints the suite log and metrics JSON.
