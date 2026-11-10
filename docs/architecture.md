# Architecture

One Durable Object hosts the entire relay. Everything else exists to hand the official Go server a `net.Conn` that isn't backed by a socket.

```
                     Cloudflare edge
  ┌─────────────────────────────────────────────────────────┐
  │ Worker (src/index.js, fetch handler)                    │
  │   /derp        → WebSocket upgrade → DO fetch           │
  │   /derp/probe  → DO fetch (JSON: server key, mem stats) │
  │                                                         │
  │ Durable Object "DerpRegion"                             │
  │   WebSocketPair ── message events ──▶ derpSocketRead(id)│
  │                     close/error     ──▶ derpSocketClose │
  │                                       send  ◀─ derpSocketSend
  │                                      ┌──────────────────┴─────────┐
  │                                      │ Go/WASM (cmd/derp-wasm)    │
  │                                      │ derpserver.New(key)        │
  │                                      │ server.Accept(conn)        │
  │                                      │ per-connection goroutines  │
  │                                      └────────────────────────────┘
  └─────────────────────────────────────────────────────────┘
```

## The three pieces

**Go/WASM server — `cmd/derp-wasm/`.** `derpserver.New` runs unmodified from `tailscale.com` v1.104.5. `main.go` registers four `syscall/js` functions (`derpSocketOpen`, `derpSocketRead`, `derpSocketSend`, `derpSocketClose`) that form the boundary between JS and Go. Each accepted connection runs the server's own read/write goroutines on a `workerConn`.

**The net.Conn adapter — `cmd/derp-wasm/conn_js_wasm.go`.** `derpserver.Accept` expects a `net.Conn`. `workerConn` implements it over JS callbacks instead of a socket: `Read` pulls from a 16-message channel fed by `enqueue`, `Write` calls `derpSocketSend` (which does `socket.send` on the DO side), deadlines and close are tracked with channels. This is the only substantial adaptation in the project — the protocol layer is untouched.

**The bridge — `src/index.js`.** The DO creates a `WebSocketPair` per client, forwards binary messages into `derpSocketRead` (enforcing DERP's framing rules: binary-only, ≤64 KiB+overhead, queue overflow → close 1011/1009/1003), and returns `derpSocketSend`'s output through the other half. The Go runtime is instantiated once per isolate and shared by all connections; `/derp/probe` reports its state.

**Regions.** Each name in `DERP_REGIONS` maps to its own Durable Object instance (own Go runtime and peer registry). Clients hit `/derp/regions` to list them and connect at `/derp/regions/<name>` — or the canonical `/derp`, which is `region-0`. Both peers of a conversation must use the same region, since a region's registry only knows its own clients.

## Why this shape

- **Durable Object, not plain Worker:** DERP needs connection state — two clients must land on the same process for the server's peer registry to forward between them. A single DO gives that for free.
- **Ordinary (non-hibernating) WebSockets:** hibernation would evict the Go runtime between events and drop the peer registry. The DO stays alive while any WebSocket is open, which is also what keeps CPU-warm behavior.
- **SQLite-backed DO class:** required for Free plan eligibility (the `new_sqlite_classes` migration).

## Test clients (not part of the deployed relay)

- `cmd/derp-client-test` — official `derp.Client` over a Node WebSocket, run natively.
- `cmd/derp-browser-test` — official `derphttp` stack (what tsconnect uses) compiled to `js/wasm`, driven from `probe.html` in headless Chromium.

## Deployment notes

The server key is compiled into the wasm from deterministic test data (`cmd/derp-wasm/main.go`). For real use, generate a `key.NodePrivate` hex string and inject it at build time (e.g. via `-ldflags` or a small generator that writes the constant) — never ship a known key.
