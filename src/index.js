import "./wasm_exec.js";
import wasmModule from "../artifacts/derp.wasm";

const socketAdapters = new Map();
let goRuntimePromise;

globalThis.derpSocketSend = (id, data) => {
  const socket = socketAdapters.get(id);
  if (!socket) throw new Error("DERP WebSocket is closed");
  socket.send(data);
  return true;
};
globalThis.derpSocketTerminate = (id) => socketAdapters.get(id)?.close(1000, "DERP connection closed");

function startDerpServer() {
  if (!goRuntimePromise) {
    goRuntimePromise = new Promise((resolve, reject) => {
      const go = new Go();
      const startedAt = performance.now();
      const timer = setTimeout(() => reject(new Error("Go DERP initialization timed out")), 10000);
      globalThis.derpWasmNotify = () => {
        clearTimeout(timer);
        resolve({
          serverKey: globalThis.derpServerKey,
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

export class DerpRegion {
  constructor(state) {
    this.state = state;
    this.sockets = new Map();
  }

  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/derp/probe") {
      try {
        const { serverKey, initializationMs } = await startDerpServer();
        return Response.json({
          ready: true,
          serverKey,
          testKey: globalThis.derpServerKeyIsTestKey,
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
    try {
      await startDerpServer();
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
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    if (path === "/derp/regions") {
      return Response.json({ regions: DERP_REGIONS });
    }
    const route = routeToRegion(path);
    if (route.error) return new Response("Not found", { status: 404 });
    const id = env.DERP_REGION.idFromName(route.region);
    return env.DERP_REGION.get(id).fetch(new URL(route.path, request.url), request);
  },
};
