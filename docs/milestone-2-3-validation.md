# Milestones 2–3: Durable Object WebSocket and DERP protocol

## Implemented path

The Worker validates `/derp` and the `derp` WebSocket subprotocol, then proxies to one named Durable Object (`region-0`). The DO uses ordinary `WebSocket.accept()` and event listeners; it does not use Hibernation. Go imports the upstream `derpserver`, constructs one `Server`, and calls `Server.Accept` for each upgraded socket with a custom `net.Conn` adapter. The adapter copies binary messages into a bounded Go channel, presents them as a byte stream to `bufio.Reader`, and writes DERP bytes back as binary WebSocket messages.

The first client messages are deliberately split into three-byte WebSocket messages by the official client-side adapter test. This verifies that Go reads across WebSocket message boundaries rather than assuming one message equals one DERP frame.

## Local `workerd` verification

Command: `npm run test:wasm-worker`.

The automated test starts Wrangler local mode with a SQLite-backed DO and runs two official Tailscale `derp.Client` instances over real WebSockets. It checks:

- ServerKey exactly matches the Go DERP server key.
- DERP ping/pong and packet forwarding in both normal and duplicate-key connection cases.
- An 8-packet transfer at the maximum DERP payload size (65,536 bytes each).
- A 3-byte-fragmented DERP client write across WebSocket binary message boundaries.
- Offline Disco-wrapper send returns the upstream server's `PeerGoneReasonNotHere`; reconnecting the same key restores delivery.
- Wrong subprotocol returns HTTP 400; unknown paths return 404.
- Text WebSocket messages close with code 1003; messages over the adapter's 66,560-byte limit close with 1009.
- A client that upgrades but never sends DERP ClientInfo is closed at the upstream server's 10-second handshake deadline; the connection registry drains afterward.

Local timing is a development-runtime measurement, not production CPU or latency.

## Real Cloudflare verification

Wrangler's deprecated `dev --remote` could not run the SQLite DO binding: it warned that SQLite Durable Objects are supported only in local mode. To verify the actual remote runtime, a temporary Worker named `derp-workers-validation-temp` was deployed to the authenticated account and then tested through its public `workers.dev` endpoint.

The remote test repeated the official DERP client suite, invalid subprotocol, unknown route, text and oversize frames, 10-second handshake timeout, and final connection drain. The successful run reported:

- Probe: HTTP 200; the Go WASM instance and DERP server initialized.
- Wrong subprotocol / unknown path: HTTP 400 / 404.
- Text / oversized binary message: close codes 1003 / 1009.
- Idle DERP handshake: close code 1000 after 9,984.9 ms.
- Two clients: exact ServerKey, DERP ping/pong, 64 KiB packet forwarding, duplicate key, Disco-triggered PeerGone, disconnect, and reconnect all passed.
- Sequential transfer: 8 × 65,536-byte payloads at 2.03 MiB/s for one remote run. This is a single small test, not a capacity benchmark.
- Wrangler reported 12 ms Worker startup time and 14,793.66 KiB uncompressed upload size.

The remote `performance.now()` measurement had millisecond-level resolution and reported 0 ms for WASM initialization after the isolate was already warm. Do not interpret that as zero-cost WASM startup. The account's plan tier was not exposed by Wrangler's account summary, so this does not independently prove the account was on Workers Free. The configured SQLite DO binding is compatible with Free; the deployed account's billing tier and actual CPU/billing metrics remain unverified.

The temporary Worker was removed after testing. Its published test key is deterministic and unsuitable for deployment. The Worker has no client authorization; it must not be left online as a public relay.

## Remaining scope and risks

- The tests use Tailscale's official Go DERP protocol client, not the full browser `cmd/tsconnect` WASM integration test. They establish the protocol handshake and relay frames, not a full Tailnet login or peer-to-peer browser session.
- No native TCP DERP, STUN/UDP, Hibernation, or multi-DO operation is implemented.
- The custom connection queue is bounded at 16 messages and closes on overflow. Production backpressure, slow-client handling, memory under many peers, and load have not been established.
- The DO uses ordinary non-hibernating WebSockets as required by this PoC. Cloudflare pricing assigns duration while these sockets keep the object active; at 128 MiB, a continuously active DO would consume about 10,800 GB-s/day, versus the documented 13,000 GB-s/day Free allowance. Public or sustained use therefore remains a poor fit without further cost measurements or an architectural change.
- Remote CPU time, 128 MiB memory headroom, account-level billing usage, and long-running reconnect behavior were not available in the deployment output and remain unverified.
