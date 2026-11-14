import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createServer } from 'node:net';
import { webcrypto } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

const host = '127.0.0.1';
const secretHex = '00112233445566778899aabbccddeeff';
const adminKey = 'proxy-gosha-e2e-admin-key';
const secret = Buffer.from(secretHex, 'hex');
const wranglerCli = resolve('node_modules', 'wrangler', 'bin', 'wrangler.js');
const basePort = Number(process.env.PROXY_GOSHA_E2E_PORT || 0);

if (!existsSync(wranglerCli)) {
  console.error(`Wrangler CLI not found at ${wranglerCli}. Run npm install first.`);
  process.exit(1);
}
if (typeof globalThis.WebSocket !== 'function') {
  console.error('This end-to-end test requires a Node.js runtime with the global WebSocket client (Node 22.6+).');
  process.exit(1);
}

async function reservePort() {
  if (basePort) return basePort;
  const server = createServer();
  await new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, host, resolveListen);
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  await new Promise((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
  return port;
}

async function bridgeCapability() {
  const key = await webcrypto.subtle.importKey('raw', secret, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const message = new TextEncoder().encode(`tdesktop-web-proxy-bridge-v1\n${host}`);
  const signature = await webcrypto.subtle.sign('HMAC', key, message);
  return Buffer.from(signature).toString('base64url');
}

function startWrangler(port, carrier) {
  const args = [
    wranglerCli, 'dev', 'src/index.ts', '--local', '--ip', host, '--port', String(port),
    '--var', `SECRET:${secretHex}`,
    '--var', `HOSTNAME:${host}`,
    '--var', `CARRIER:${carrier}`,
    '--var', `ADMIN_KEY:${adminKey}`,
  ];
  const child = spawn(process.execPath, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
    windowsHide: true,
  });
  let output = '';
  let exited = false;
  let exitCode = null;
  const collect = (chunk) => { output = `${output}${chunk}`.slice(-20_000); };
  child.stdout.setEncoding('utf8').on('data', collect);
  child.stderr.setEncoding('utf8').on('data', collect);
  child.on('error', (error) => {
    exited = true;
    exitCode = 1;
    output = `${output}\nFailed to start Wrangler: ${error.message}`.slice(-20_000);
  });
  child.on('exit', (code) => { exited = true; exitCode = code; });
  return { child, get output() { return output; }, get exited() { return exited; }, get exitCode() { return exitCode; } };
}

async function stopWrangler(processInfo) {
  if (processInfo.exited) return;
  processInfo.child.kill('SIGTERM');
  await Promise.race([
    new Promise((resolveExit) => processInfo.child.once('exit', resolveExit)),
    delay(5_000),
  ]);
  if (!processInfo.exited) processInfo.child.kill('SIGKILL');
}

async function waitForBridge(baseUrl, processInfo) {
  const capability = await bridgeCapability();
  const url = `${baseUrl}/?bridge=${encodeURIComponent(capability)}`;
  const deadline = Date.now() + 60_000;
  let lastError = 'not ready';
  while (Date.now() < deadline) {
    if (processInfo.exited) throw new Error(`Wrangler exited with code ${processInfo.exitCode}.\n${processInfo.output}`);
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(3_000) });
      const body = await response.text();
      if (response.status === 200 && body.includes('const relayBase=') && body.includes('bootstrap=')) return body;
      lastError = `HTTP ${response.status}: ${body.slice(0, 240)}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await delay(400);
  }
  throw new Error(`Wrangler did not serve the authenticated bridge: ${lastError}.\n${processInfo.output}`);
}

function extractBootstrap(html) {
  const match = /bootstrap=("([A-Za-z0-9_-]+)")/.exec(html);
  assert.ok(match, 'bridge page must contain an embedded bootstrap token');
  return match[2];
}

async function openWebSocket(url, protocol) {
  const socket = new WebSocket(url, protocol);
  socket.binaryType = 'arraybuffer';
  await new Promise((resolveOpen, reject) => {
    const timer = setTimeout(() => reject(new Error('WebSocket open timed out')), 8_000);
    socket.addEventListener('open', () => { clearTimeout(timer); resolveOpen(); }, { once: true });
    socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('WebSocket connection failed')); }, { once: true });
    socket.addEventListener('close', (event) => {
      clearTimeout(timer);
      reject(new Error(`WebSocket closed before open: ${event.code} ${event.reason}`));
    }, { once: true });
  });
  assert.equal(socket.protocol, protocol, 'server must select the authenticated subprotocol');
  return socket;
}

function nextMessage(socket, timeoutMs = 5_000) {
  return new Promise((resolveMessage, reject) => {
    const timer = setTimeout(() => reject(new Error('Timed out waiting for WebSocket frame')), timeoutMs);
    socket.addEventListener('message', (event) => { clearTimeout(timer); resolveMessage(event.data); }, { once: true });
    socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('WebSocket errored while waiting for a frame')); }, { once: true });
    socket.addEventListener('close', (event) => {
      clearTimeout(timer);
      reject(new Error(`WebSocket closed before frame: ${event.code} ${event.reason}`));
    }, { once: true });
  });
}

async function testCarrier(carrier, port) {
  const baseUrl = `http://${host}:${port}`;
  const processInfo = startWrangler(port, carrier);
  try {
    const bridgeHtml = await waitForBridge(baseUrl, processInfo);
    const bootstrap = extractBootstrap(bridgeHtml);

    const invalid = await fetch(`${baseUrl}/api/v1/session`, {
      method: 'POST',
      headers: { Authorization: 'Bearer invalid', 'Content-Type': 'application/octet-stream' },
      body: Uint8Array.of(0x10, 0, 0, 0, 0, 0, 0, 1, 1),
    });
    assert.equal(invalid.status, 404, 'invalid bootstrap token must be rejected');

    const sessionResponse = await fetch(`${baseUrl}/api/v1/session`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${bootstrap}`, 'Content-Type': 'application/octet-stream' },
      body: Uint8Array.of(0x10, 0, 0, 0, 0, 0, 0, 1, 1),
    });
    assert.equal(sessionResponse.status, 200, 'valid bootstrap handshake must issue a session');
    assert.equal(sessionResponse.headers.get('content-type'), 'application/octet-stream');
    assert.equal(sessionResponse.headers.get('cache-control'), 'no-store');
    assert.equal(sessionResponse.headers.get('x-carrier-mode'), carrier);
    assert.deepEqual([...new Uint8Array(await sessionResponse.arrayBuffer())], [0x11, 0, 0, 0, 0, 0, 0, 0]);
    const sessionToken = sessionResponse.headers.get('x-session-token');
    assert.ok(sessionToken, 'session response must include X-Session-Token');

    const health = await fetch(`${baseUrl}/health`);
    assert.equal(health.status, 200);
    assert.equal((await health.json()).status, 'operational');

    const panel = await fetch(`${baseUrl}/${adminKey}`);
    assert.equal(panel.status, 200, 'configured admin panel must be served');
    assert.match(await panel.text(), /Telegram/);

    const protocol = carrier === 'websocket'
      ? `tproxy-v1.${sessionToken}`
      : `tproxy-lane-v1.${sessionToken}.1`;
    const socket = await openWebSocket(`${baseUrl.replace(/^http:/, 'ws:')}/api/v1/ws`, protocol);
    try {
      if (carrier === 'websocket') {
        const pong = nextMessage(socket);
        socket.send(Uint8Array.of(5, 0, 0, 0, 0, 0, 0, 4, 0x11, 0x22, 0x33, 0x44));
        const response = await pong;
        assert.ok(response instanceof ArrayBuffer, 'binary WebSocket response must be an ArrayBuffer');
        assert.deepEqual([...new Uint8Array(response)], [6, 0, 0, 0, 0, 0, 0, 4, 0x11, 0x22, 0x33, 0x44]);
      } else {
        const closed = new Promise((resolveClose) => socket.addEventListener('close', resolveClose, { once: true }));
        socket.send(Uint8Array.of(1, 0, 0, 1, 0, 0, 0, 0)); // OPEN lane 1; no TCP data is sent.
        await delay(100);
        socket.send(Uint8Array.of(3, 0, 0, 1, 0, 0, 0, 0)); // CLOSE lane 1.
        const closeEvent = await Promise.race([closed, delay(5_000).then(() => null)]);
        assert.ok(closeEvent, 'closing the lane stream must close its dedicated WebSocket');
      }
    } finally {
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) socket.close(1000, 'e2e complete');
    }

    const deleted = await fetch(`${baseUrl}/api/v1/session`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${sessionToken}` },
    });
    assert.equal(deleted.status, 204, 'valid session token must pass DELETE authentication');

    console.log(`PASS ${carrier}: bridge bootstrap, session issue/delete, health/admin routes, authenticated WebSocket upgrade and frame lifecycle`);
  } finally {
    await stopWrangler(processInfo);
  }
}

try {
  const firstPort = await reservePort();
  await testCarrier('websocket', firstPort);
  const secondPort = basePort ? basePort + 1 : await reservePort();
  await testCarrier('websocket-lanes', secondPort);
  console.log('Cloudflare workerd end-to-end tests passed for both carrier modes.');
} catch (error) {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
}
