import { DurableObject } from "cloudflare:workers";
import "./wasm_exec.js";
import wasmModule from "../artifacts/derp.wasm";

const socketAdapters = new Map();
let goRuntimePromise;

// The key-less build default: documented, deterministic test data. Deploying a
// relay with it lets anyone impersonate it — set the DERP_SERVER_KEY secret.
const TEST_KEY_HEX = "0101010101010101010101010101010101010101010101010101010101010101";

globalThis.derpSocketSend = (id, data) => {
  const socket = socketAdapters.get(id);
  if (!socket) throw new Error("DERP WebSocket is closed");
  socket.send(data);
  return true;
};
globalThis.derpSocketTerminate = (id) => socketAdapters.get(id)?.close(1000, "DERP connection closed");

function startDerpServer(keyHex) {
  if (!goRuntimePromise) {
    goRuntimePromise = new Promise((resolve, reject) => {
      const go = new Go();
      const startedAt = performance.now();
      const timer = setTimeout(() => reject(new Error("Go DERP initialization timed out")), 10000);
      globalThis.derpWasmNotify = () => {
        // The wasm registers its callbacks before notifying; the server key is
        // a runtime input, so install it now, before any connection.
        if (!globalThis.derpSetServerKey(keyHex)) {
          clearTimeout(timer);
          reject(new Error("DERP_SERVER_KEY must be 64 hex chars (node private key)"));
          return;
        }
        clearTimeout(timer);
        resolve({
          serverKey: globalThis.derpServerKey,
          testKey: keyHex === TEST_KEY_HEX,
          initializationMs: Number((performance.now() - startedAt).toFixed(2)),
        });
      };
      WebAssembly.instantiate(wasmModule, go.importObject)
        .then((instance) => go.run(instance))
        .catch((error) => {
          clearTimeout(timer);
          reject(error);
        });
    });
  }
  return goRuntimePromise;
}

export class DerpRegion extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.env = env;
    this.sockets = new Map();
  }

  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/derp/probe") {
      try {
        const keyHex = this.env.DERP_SERVER_KEY;
        // No silent test-key fallback: an unset key must fail loudly, not
        // deploy an impersonatable relay.
        if (!/^[0-9a-fA-F]{64}$/.test(keyHex ?? "")) {
          throw new Error("DERP_SERVER_KEY is not set; provide a 64-hex-char node private key (Worker secret, or .dev.vars for local dev)");
        }
        const { serverKey, testKey, initializationMs } = await startDerpServer(keyHex);
        return Response.json({
          ready: true,
          serverKey,
          testKey,
          initializationMs,
          connections: globalThis.derpServerConnectionCount(),
          goMem: globalThis.derpServerMemStats(),
        });
      } catch (error) {
        return Response.json({ ready: false, error: String(error) }, { status: 500 });
      }
    }
    if (path !== "/derp" || request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("Not found", { status: 404 });
    }

    const protocols = (request.headers.get("Sec-WebSocket-Protocol") ?? "").split(",").map((p) => p.trim());
    if (!protocols.includes("derp")) return new Response("DERP subprotocol required", { status: 400 });
    const keyHex = this.env.DERP_SERVER_KEY;
    if (!/^[0-9a-fA-F]{64}$/.test(keyHex ?? "")) {
      return new Response("DERP server unavailable: DERP_SERVER_KEY is not set", { status: 503 });
    }
    try {
      await startDerpServer(keyHex);
    } catch (error) {
      return new Response(`DERP server unavailable: ${error}`, { status: 503 });
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    const id = crypto.randomUUID();
    this.sockets.set(id, server);
    socketAdapters.set(id, server);
    server.binaryType = "arraybuffer";
    server.accept();
    server.addEventListener("message", (event) => {
      if (typeof event.data === "string" || !(event.data instanceof ArrayBuffer)) {
        server.close(1003, "DERP requires binary WebSocket messages");
      } else if (event.data.byteLength > 66_560) {
        server.close(1009, "DERP WebSocket message too large");
      } else if (!globalThis.derpSocketRead(id, event.data)) {
        server.close(1013, "DERP receive queue is full");
      }
    });
    const remove = () => {
      globalThis.derpSocketClose(id);
      this.sockets.delete(id);
      socketAdapters.delete(id);
    };
    server.addEventListener("close", remove);
    server.addEventListener("error", remove);
    if (!globalThis.derpSocketOpen(id, "0.0.0.0:0")) {
      remove();
      server.close(1011, "could not start DERP connection");
      return new Response("could not start DERP connection", { status: 500 });
    }

    return new Response(null, {
      status: 101,
      headers: { "Sec-WebSocket-Protocol": "derp" },
      webSocket: client,
    });
  }
}

// DERP regions exposed by this deployment. Each region is its own Durable
// Object instance (own Go/WASM server, own peer registry); clients pick the
// closest one and both peers of a conversation must use the same region.
const DERP_REGIONS = ["region-0"];

function routeToRegion(path) {
  if (path === "/derp" || path === "/derp/probe") return { region: "region-0", path };
  const match = path.match(/^\/derp\/regions\/([^/]+)(\/.*)?$/);
  if (match) {
    const [, region, rest = ""] = match;
    if (!DERP_REGIONS.includes(region)) return { error: 404 };
    // region-0 keeps the canonical /derp paths so existing clients are unchanged
    const suffix = rest === "/probe" ? "/derp/probe" : "/derp";
    return { region, path: suffix };
  }
  return { error: 404 };
}

export default {
  async fetch(request, env, ctx) {
    const path = new URL(request.url).pathname;
    if (path === "/derp/regions") {
      return Response.json({ regions: DERP_REGIONS });
    }
    const route = routeToRegion(path);
    if (route.error) return new Response("Not found", { status: 404 });
    // wrangler.jsonc binds the DO namespace as env.DERP_REGION; the cf CLI's
    // cloudflare.config.ts exposes it as a loopback export instead.
    const region = env.DERP_REGION ?? ctx?.exports?.DerpRegion;
    const id = region.idFromName(route.region);
    return region.get(id).fetch(new URL(route.path, request.url), request);
  },
};
