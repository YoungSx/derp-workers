import { spawn } from "node:child_process";
import { connect } from "node:net";
import { connect as tlsConnect } from "node:tls";
import { setTimeout as delay } from "node:timers/promises";

const baseURL = process.env.CF_DERP_BASE_URL;
if (!baseURL) throw new Error("CF_DERP_BASE_URL is required");
const base = new URL(baseURL);
const wsBase = new URL(baseURL);
wsBase.protocol = base.protocol === "https:" ? "wss:" : "ws:";
const httpProbe = new URL("/derp/probe", base).toString();
const wsDerp = new URL("/derp", wsBase).toString();

function rawUpgradeStatus(protocol) {
  return new Promise((resolve, reject) => {
    const socket = base.protocol === "https:"
      ? tlsConnect({ host: base.hostname, port: Number(base.port || 443), servername: base.hostname, ALPNProtocols: ["http/1.1"] })
      : connect(Number(base.port || 80), base.hostname);
    let response = "";
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("Timed out waiting for raw WebSocket upgrade response"));
    }, 5000);
    socket.on("secureConnect", writeRequest);
    socket.on("connect", writeRequest);
    function writeRequest() {
      socket.write([
        `GET /derp HTTP/1.1`,
        `Host: ${base.host}`,
        "Upgrade: websocket",
        "Connection: Upgrade",
        "Sec-WebSocket-Version: 13",
        "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
        `Sec-WebSocket-Protocol: ${protocol}`,
        "",
        "",
      ].join("\r\n"));
    }
    socket.on("data", (chunk) => {
      response += chunk.toString("latin1");
      const status = response.match(/^HTTP\/1\.1 (\d{3})/);
      if (status) {
        clearTimeout(timer);
        socket.destroy();
        resolve(Number(status[1]));
      }
    });
    socket.on("error", (error) => { clearTimeout(timer); reject(error); });
  });
}

function openWebSocket() {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(wsDerp, "derp");
    socket.addEventListener("open", () => resolve(socket), { once: true });
    socket.addEventListener("error", () => reject(new Error("Cloudflare WebSocket failed before opening")), { once: true });
  });
}

function waitForClose(socket, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Timed out waiting for Cloudflare WebSocket close")), timeoutMs);
    socket.addEventListener("close", (event) => {
      clearTimeout(timer);
      resolve({ code: event.code, reason: event.reason });
    }, { once: true });
  });
}

function runOfficialClients(serverKey) {
  return new Promise((resolve, reject) => {
    const child = spawn("go", ["run", "./cmd/derp-client-test"], {
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        DERP_SERVER_KEY: serverKey,
        DERP_WS_URL: wsDerp,
        DERP_HTTP_URL: httpProbe,
      },
    });
    let result = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`Official Cloudflare DERP clients timed out:\n${result}`));
    }, 45000);
    child.stdout.on("data", (chunk) => { result += chunk; });
    child.stderr.on("data", (chunk) => { result += chunk; });
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("exit", (code) => {
      clearTimeout(timer);
      code === 0 ? resolve(result.trim()) : reject(new Error(`Official Cloudflare DERP clients exited ${code}:\n${result}`));
    });
  });
}

async function getProbe() {
  const response = await fetch(httpProbe);
  const text = await response.text();
  let body;
  try { body = JSON.parse(text); } catch { throw new Error(`Probe HTTP ${response.status}: ${text.slice(0, 1000)}`); }
  if (!response.ok || !body.ready || !body.serverKey || !Number.isFinite(body.initializationMs)) {
    throw new Error(`Cloudflare probe failed (${response.status}): ${JSON.stringify(body)}`);
  }
  return body;
}

// A just-deployed worker's workers.dev route can 404 for a few seconds
// while it propagates; retry until it is live.
const deadline = Date.now() + 60000;
let probe;
for (;;) {
  try { probe = await getProbe(); break; } catch (error) {
    if (Date.now() > deadline) throw error;
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
}
const badSubprotocolStatus = await rawUpgradeStatus("other");
if (badSubprotocolStatus !== 400) throw new Error(`Expected bad subprotocol 400, got ${badSubprotocolStatus}`);
const unknownRoute = await fetch(new URL("/nope", base));
if (unknownRoute.status !== 404) throw new Error(`Expected unknown route 404, got ${unknownRoute.status}`);
const officialProtocol = await runOfficialClients(probe.serverKey);

const textSocket = await openWebSocket();
const textClosePromise = waitForClose(textSocket, 5000);
textSocket.send("DERP requires binary");
const textClose = await textClosePromise;
if (textClose.code !== 1003) throw new Error(`Expected text close 1003, got ${textClose.code}`);

const oversizedSocket = await openWebSocket();
const oversizedClosePromise = waitForClose(oversizedSocket, 5000);
oversizedSocket.send(new Uint8Array(66561));
const oversizedClose = await oversizedClosePromise;
if (oversizedClose.code !== 1009) throw new Error(`Expected oversized close 1009, got ${oversizedClose.code}`);

const idleSocket = await openWebSocket();
const deadlineStarted = performance.now();
const idleClose = await waitForClose(idleSocket, 15000);
const handshakeTimeoutMs = Number((performance.now() - deadlineStarted).toFixed(1));
if (idleClose.code !== 1000 || handshakeTimeoutMs < 9000 || handshakeTimeoutMs > 15000) {
  throw new Error(`Unexpected remote handshake timeout: ${idleClose.code} in ${handshakeTimeoutMs} ms`);
}

for (let attempt = 0; attempt < 80; attempt++) {
  if ((await getProbe()).connections === 0) break;
  if (attempt === 79) throw new Error("Cloudflare DERP connections did not drain after test close");
  await delay(100);
}
console.log(JSON.stringify({
  probeStatus: 200,
  serverKey: probe.serverKey,
  wasmInitializationMs: probe.initializationMs,
  badSubprotocolStatus,
  unknownRouteStatus: unknownRoute.status,
  textFrameCloseCode: textClose.code,
  oversizedFrameCloseCode: oversizedClose.code,
  idleHandshakeCloseCode: idleClose.code,
  handshakeTimeoutMs,
  officialProtocol,
}));
