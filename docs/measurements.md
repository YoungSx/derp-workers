# Measurements

## Production CPU time (the Free-plan question)

The core feasibility question was whether the Go/WASM DERP server stays inside the Workers Free plan's CPU budget on real Cloudflare infrastructure. Measured by running six full client suites (3 native, 2 browser, plus earlier runs) against a deployed worker and reading the GraphQL analytics API (`workersInvocationsAdaptive` for the Worker frontend, `durableObjectsInvocationsAdaptiveGroups` for the Durable Object where the Go server actually runs), over a 40-minute window. Times are per invocation in **microseconds**; a Durable Object invocation covers the WebSocket connection's traffic, so it bundles the DERP handshake plus all packet forwarding for that connection.

| Scope | Status | Requests | CPU P50 | CPU P75 | CPU P90 | CPU P99 | Errors |
|---|---|---|---|---|---|---|---|
| Worker frontend | success | 84 | 722 µs | — | — | 2,948 µs | 0 |
| Worker frontend | client/stream disconnected | 26 | ~630 µs | — | — | 1,534–2,199 µs | 0 |
| Durable Object | success | 90 | 5,224 µs | 7,138 µs | 36,755 µs | 270,198 µs | 0 |
| Durable Object | stream disconnected (idle-timeout tests) | 7 | 4,119 µs | — | — | 6,247 µs | 7 expected¹ |

¹ These are the suite's deliberate idle-handshake-timeout and text-frame/oversized-frame disconnect scenarios, not failures.

**Findings:**

- The Worker frontend sits at **0.7 ms median / 2.9 ms P99** CPU — far inside the 10 ms/invitation Workers Free budget.
- The Durable Object pays the real cost: **5.2 ms median**, climbing to **270 ms P99**, which matches the ~200–260 ms cold-start measured locally (WASM instantiate + `derpserver.New`). The P90 of 36.8 ms reflects connections that carried the full forwarding suite.
- **Zero hard errors across all 98 DO invocations**, including the 270 ms cold-start ones: the Free plan does not terminate these requests. A single DO fetch invocation absorbs its connection's entire traffic, so per-message CPU is amortized — steady-state connections never re-pay the startup cost.
- Conclusion: the architecture **survives the Free plan** at PoC scale. The residual risk is sustained multi-client load concentrating CPU inside one DO invocation; that, not the plan limit, would be the scaling ceiling.

## Throughput and memory (local workerd, from [milestone 4](milestone-4.md))

| Metric | Value |
|---|---|
| Native client forwarding (loopback) | 29.9 MiB/s |
| Browser client forwarding (102 × 16 KiB, acked) | ~4.2 MiB/s |
| Server WASM bundle | 9.3 MiB gzipped upload (14.8 MiB raw) |
| Server init (instantiate + `derpserver.New`) | 203–262 ms wall, local; ~270 ms CPU, production |
| Go heap after full dual-client suite | 226–356 KiB (`Sys` 2.3–7.2 MiB) |
| Client wasm memory | 6.5 MiB boot → 10.5 MiB after throughput run |

## Cost envelope (analysis, not measured)

With one always-on 128 MiB Durable Object, Duration is ~10,800 GB-s/day against the Free plan's 13,000 GB-s/day — viable for a single-region relay, with ~20% headroom. Worker requests are 100k/day on Free; at the PoC's traffic profile (connection setups, not per-packet requests) this is not the binding constraint.
