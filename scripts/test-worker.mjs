import { spawn } from "node:child_process";
import { connect } from "node:net";
import { setTimeout as delay } from "node:timers/promises";

const port = 8797;
const remote = process.argv.includes("--remote");
const server = spawn("npx", ["wrangler", "dev", ...(remote ? ["--remote"] : ["--local"]), "--port", String(port), "--inspector-port", "0"], {
  stdio: ["ignore", "pipe", "pipe"],
  detached: true,
});
let output = "";
server.stdout.on("data", (chunk) => { output += chunk; });
server.stderr.on("data", (chunk) => { output += chunk; });

async function run(command, args, timeoutMs = 35000) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let result = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`Timed out: ${command} ${args.join(" ")}\n${result}`));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => { result += chunk; });
    child.stderr.on("data", (chunk) => { result += chunk; });
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("exit", (code) => {
      clearTimeout(timer);
      code === 0 ? resolve(result.trim()) : reject(new Error(`${command} exited ${code}:\n${result}`));
    });
  });
}

function openWebSocket() {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/derp`, "derp");
    socket.addEventListener("open", () => resolve(socket), { once: true });
    socket.addEventListener("error", () => reject(new Error("WebSocket failed before opening")), { once: true });
  });
}

function waitForClose(socket, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Timed out waiting for WebSocket close")), timeoutMs);
    socket.addEventListener("close", (event) => {
      clearTimeout(timer);
      resolve({ code: event.code, reason: event.reason });
    }, { once: true });
  });
}

function rawUpgradeStatus(protocol) {
  return new Promise((resolve, reject) => {
    const socket = connect(port, "127.0.0.1");
    let response = "";
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("Timed out waiting for raw WebSocket upgrade response"));
    }, 3000);
    socket.on("connect", () => socket.write([
      "GET /derp HTTP/1.1",
      `Host: 127.0.0.1:${port}`,
      "Upgrade: websocket",
      "Connection: Upgrade",
      "Sec-WebSocket-Version: 13",
      "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
      `Sec-WebSocket-Protocol: ${protocol}`,
      "",
      "",
    ].join("\r\n")));
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

try {
  let response;
  for (let attempt = 0; attempt < 60; attempt++) {
    if (server.exitCode !== null) throw new Error(`wrangler exited (${server.exitCode}):\n${output}`);
    try {
      response = await fetch(`http://127.0.0.1:${port}/derp/probe`);
      if (response.status !== 503) break;
    } catch {}
    await delay(500);
  }
  if (!response) throw new Error(`Worker did not start:\n${output}`);
  const responseText = await response.text();
  let probe;
  try { probe = JSON.parse(responseText); } catch {
    throw new Error(`Probe returned non-JSON (${response.status}): ${responseText.slice(0, 1000)}\n${output}`);
  }
  if (!response.ok || !probe.ready || !probe.serverKey || !Number.isFinite(probe.initializationMs)) {
    throw new Error(`Unexpected probe response (${response.status}): ${JSON.stringify(probe)}\n${output}`);
  }

  const badProtocolStatus = await rawUpgradeStatus("other");
  if (badProtocolStatus !== 400) throw new Error(`Expected bad-protocol 400, got ${badProtocolStatus}`);
  const unknownRoute = await fetch(`http://127.0.0.1:${port}/nope`);
  if (unknownRoute.status !== 404) throw new Error(`Expected unknown-route 404, got ${unknownRoute.status}`);

  const protocol = await new Promise((resolve, reject) => {
    const child = spawn("go", ["run", "./cmd/derp-client-test"], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, DERP_SERVER_KEY: probe.serverKey },
    });
    let result = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`Timed out running official DERP clients:\n${result}`));
    }, 35000);
    child.stdout.on("data", (chunk) => { result += chunk; });
    child.stderr.on("data", (chunk) => { result += chunk; });
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("exit", (code) => {
      clearTimeout(timer);
      code === 0 ? resolve(result.trim()) : reject(new Error(`Official DERP client test exited ${code}:\n${result}\n${output}`));
    });
  });
  const textSocket = await openWebSocket();
  const textClosePromise = waitForClose(textSocket, 3000);
  textSocket.send("DERP data must be a binary message");
  const textClose = await textClosePromise;
  if (textClose.code !== 1003) throw new Error(`Expected binary-only close 1003, got ${textClose.code}`);

  const oversizedSocket = await openWebSocket();
  const oversizedClosePromise = waitForClose(oversizedSocket, 3000);
  oversizedSocket.send(new Uint8Array(66561));
  const oversizedClose = await oversizedClosePromise;
  if (oversizedClose.code !== 1009) throw new Error(`Expected oversized-frame close 1009, got ${oversizedClose.code}`);

  const deadlineSocket = await openWebSocket();
  const deadlineStarted = performance.now();
  const deadlineClose = await waitForClose(deadlineSocket, 12000);
  const handshakeTimeoutMs = Number((performance.now() - deadlineStarted).toFixed(1));
  if (deadlineClose.code !== 1000) throw new Error(`Expected DERP handshake deadline close 1000, got ${deadlineClose.code}`);
  if (handshakeTimeoutMs < 9000 || handshakeTimeoutMs > 12000) throw new Error(`Unexpected DERP handshake timeout: ${handshakeTimeoutMs} ms`);

  for (let attempt = 0; attempt < 40; attempt++) {
    const statusResponse = await fetch(`http://127.0.0.1:${port}/derp/probe`);
    const status = await statusResponse.json();
    if (status.connections === 0) break;
    if (attempt === 39) throw new Error(`DERP connections did not drain: ${status.connections}`);
    await delay(50);
  }
  console.log(JSON.stringify({
    probeStatus: response.status,
    ready: probe.ready,
    initializationMs: probe.initializationMs,
    badSubprotocolStatus: badProtocolStatus,
    unknownRouteStatus: unknownRoute.status,
    textFrameCloseCode: textClose.code,
    oversizedFrameCloseCode: oversizedClose.code,
    idleHandshakeCloseCode: deadlineClose.code,
    handshakeTimeoutMs,
    derpProtocol: protocol,
  }));
} finally {
  try { process.kill(-server.pid, "SIGTERM"); } catch {}
  await Promise.race([new Promise((resolve) => server.once("exit", resolve)), delay(5000)]);
  try { process.kill(-server.pid, "SIGKILL"); } catch {}
}
