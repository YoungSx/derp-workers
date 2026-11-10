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

**Server key.** The relay's long-term identity (a `key.NodePrivate`, 64 hex chars) is a runtime input, not compiled in: the Durable Object reads `env.DERP_SERVER_KEY` and passes it into the wasm before any connection, and refuses to serve without it. A serverless relay cannot regenerate its key per isolate, and a silent default would be impersonatable, so failure is loud. Local dev: the test scripts bootstrap the deterministic public test key into `.dev.vars` (gitignored). Production: generate a random key (`openssl rand -hex 32`), then set it with `cf workers secrets update DERP_SERVER_KEY` — the probe's `testKey` field reports whether the public test key is in use.

Two CLIs are supported: the unified `cf` CLI is the primary one (config in `cloudflare.config.ts`; still in beta — `cf deploy`, `cf dev`, CI deploy/delete, and the local test suites all use it), with `wrangler` (`wrangler.jsonc`) as the fallback — it's still needed for `wrangler dev --remote`. They bind the Durable Object differently — `wrangler.jsonc` exposes it as `env.DERP_REGION`, while the `cf` config's `exports` model exposes it as `ctx.exports.DerpRegion` — so `src/index.js` resolves whichever is present. The DO class also extends `DurableObject` from `cloudflare:workers`, which the `cf` config model requires. `DERP_WORKER_NAME` overrides the worker name at deploy time (CI uses it to deploy an isolated copy).
