import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createServer } from 'node:net';
import { webcrypto } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { concatBytes } from '../src/crypto/bytes.ts';
import { aesCtrAt, importAesCtrKey, sha256 } from '../src/crypto/webcrypto.ts';

const host = '127.0.0.1';
const secretHex = '00112233445566778899aabbccddeeff';
const secret = Uint8Array.from(Buffer.from(secretHex, 'hex'));
const adminKey = 'proxy-gosha-workerd-tcp-test-key';
const wranglerCli = resolve('node_modules', 'wrangler', 'bin', 'wrangler.js');
const payload = Uint8Array.from([0x50, 0x72, 0x6f, 0x78, 0x79, 0x47, 0x6f, 0x73, 0x68, 0x61, 0x2d, 0x74, 0x63, 0x70]);
const responsePayload = Uint8Array.from([0xde, 0xad, 0xbe, 0xef, 0x10, 0x20, 0x30]);

if (!existsSync(wranglerCli)) {
  console.error(`Wrangler CLI not found at ${wranglerCli}. Run npm install first.`);
  process.exit(1);
}
if (typeof globalThis.WebSocket !== 'function') {
  console.error('This test requires Node.js 22.6+ with the global WebSocket client.');
  process.exit(1);
}

async function listen(server, address = { host, port: 0 }) {
  await new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(address.port, address.host, resolveListen);
  });
  const bound = server.address();
  assert.ok(bound && typeof bound === 'object');
  return bound.port;
}

async function reservePort() {
  const server = createServer();
  const port = await listen(server);
  await new Promise((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
  return port;
}

async function bridgeCapability() {
  const key = await webcrypto.subtle.importKey('raw', secret, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = await webcrypto.subtle.sign('HMAC', key, new TextEncoder().encode(`tdesktop-web-proxy-bridge-v1\n${host}`));
  return Buffer.from(signature).toString('base64url');
}

async function makeClientHeader() {
  const header = new Uint8Array(64);
  for (let index = 8; index < 56; index++) header[index] = (index * 13 + 7) & 0xff;
  const readKey = await importAesCtrKey(await sha256(concatBytes(header.subarray(8, 40), secret)));
  const tail = new Uint8Array(8);
  tail.set([0xef, 0xef, 0xef, 0xef]);
  new DataView(tail.buffer).setInt16(4, 2, true);
  header.set(await aesCtrAt(readKey, header.subarray(40, 56), 56, tail), 56);
  return header;
}

function frame(type, streamId, data = new Uint8Array()) {
  const out = new Uint8Array(8 + data.length);
  out[0] = type;
  out[1] = streamId >>> 16 & 0xff;
  out[2] = streamId >>> 8 & 0xff;
  out[3] = streamId & 0xff;
  new DataView(out.buffer).setUint32(4, data.length, false);
  out.set(data, 8);
  return out;
}

function decodeFrames(data) {
  const bytes = new Uint8Array(data);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const frames = [];
  let offset = 0;
  while (offset < bytes.length) {
    assert.ok(bytes.length - offset >= 8, 'frame header must be complete');
    const length = view.getUint32(offset + 4, false);
    assert.ok(offset + 8 + length <= bytes.length, 'frame payload must be complete');
    frames.push({ type: bytes[offset], streamId: bytes[offset + 1] << 16 | bytes[offset + 2] << 8 | bytes[offset + 3], payload: bytes.slice(offset + 8, offset + 8 + length) });
    offset += 8 + length;
  }
  return frames;
}

function startWrangler(httpPort, tcpPort) {
  const args = [
    wranglerCli, 'dev', 'src/index.ts', '--local', '--ip', host, '--port', String(httpPort),
    '--var', `SECRET:${secretHex}`,
    '--var', `HOSTNAME:${host}`,
    '--var', 'CARRIER:websocket-lanes',
    '--var', `ADMIN_KEY:${adminKey}`,
    '--var', 'E2E_TEST_MODE:true',
    '--var', `E2E_DC_HOST:${host}`,
    '--var', `E2E_DC_PORT:${tcpPort}`,
  ];
  const child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'], env: process.env, windowsHide: true });
  let output = '';
  let exited = false;
  let exitCode = null;
  const collect = (chunk) => { output = `${output}${chunk}`.slice(-24_000); };
  child.stdout.setEncoding('utf8').on('data', collect);
  child.stderr.setEncoding('utf8').on('data', collect);
  child.on('error', (error) => { exited = true; exitCode = 1; output += `\n${error.message}`; });
  child.on('exit', (code) => { exited = true; exitCode = code; });
  return { child, get output() { return output; }, get exited() { return exited; }, get exitCode() { return exitCode; } };
}

async function stopWrangler(info) {
  if (info.exited) return;
  info.child.kill('SIGTERM');
  await Promise.race([new Promise((resolveExit) => info.child.once('exit', resolveExit)), delay(5000)]);
  if (!info.exited) info.child.kill('SIGKILL');
}

async function waitForBridge(baseUrl, info) {
  const capability = await bridgeCapability();
  const url = `${baseUrl}/?bridge=${encodeURIComponent(capability)}`;
  const deadline = Date.now() + 60_000;
  let lastError = 'not ready';
  while (Date.now() < deadline) {
    if (info.exited) throw new Error(`Wrangler exited (${info.exitCode}).\n${info.output}`);
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(3000) });
      const body = await response.text();
      if (response.status === 200 && body.includes('bootstrap=')) return body;
      lastError = `HTTP ${response.status}: ${body.slice(0, 180)}`;
    } catch (error) { lastError = error instanceof Error ? error.message : String(error); }
    await delay(300);
  }
  throw new Error(`Worker did not start: ${lastError}\n${info.output}`);
}

function extractBootstrap(html) {
  const match = /bootstrap=("([A-Za-z0-9_-]+)")/.exec(html);
  assert.ok(match, 'bridge must contain the bootstrap token');
  return match[2];
}

function nextDataFrame(socket, timeoutMs = 10_000) {
  return new Promise((resolveFrame, reject) => {
    const timer = setTimeout(() => reject(new Error('Timed out waiting for downstream DATA frame')), timeoutMs);
    const onMessage = (event) => {
      try {
        for (const item of decodeFrames(event.data)) {
          if (item.type === 2 && item.streamId === 1) {
            clearTimeout(timer);
            socket.removeEventListener('message', onMessage);
            resolveFrame(item);
            return;
          }
        }
      } catch (error) {
        clearTimeout(timer);
        socket.removeEventListener('message', onMessage);
        reject(error);
      }
    };
    socket.addEventListener('message', onMessage);
    socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('WebSocket failed')); }, { once: true });
    socket.addEventListener('close', (event) => { clearTimeout(timer); reject(new Error(`WebSocket closed: ${event.code} ${event.reason}`)); }, { once: true });
  });
}

async function waitUntil(predicate, description, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await delay(15);
  }
  assert.fail(`Timed out waiting for ${description}`);
}

const tcpServer = createServer();
let tcpReceived = Buffer.alloc(0);
let acceptedSocket;
let resolveAccepted;
const accepted = new Promise((resolveAccept) => { resolveAccepted = resolveAccept; });
tcpServer.on('connection', (socket) => {
  acceptedSocket = socket;
  resolveAccepted(socket);
  socket.on('data', (chunk) => {
    tcpReceived = Buffer.concat([tcpReceived, chunk]);
    if (tcpReceived.length >= 64 + payload.length && !socket.__responseSent) {
      socket.__responseSent = true;
      socket.write(Buffer.from(responsePayload));
    }
  });
});

let wrangler;
let ws;
try {
  const tcpPort = await listen(tcpServer);
  const httpPort = await reservePort();
  const baseUrl = `http://${host}:${httpPort}`;
  wrangler = startWrangler(httpPort, tcpPort);
  const html = await waitForBridge(baseUrl, wrangler);
  const bootstrap = extractBootstrap(html);
  const sessionResponse = await fetch(`${baseUrl}/api/v1/session`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${bootstrap}`, 'Content-Type': 'application/octet-stream' },
    body: Uint8Array.of(0x10, 0, 0, 0, 0, 0, 0, 1, 1),
  });
  assert.equal(sessionResponse.status, 200, 'session handshake must succeed');
  const sessionToken = sessionResponse.headers.get('x-session-token');
  assert.ok(sessionToken, 'session token must be issued');

  ws = new WebSocket(`${baseUrl.replace(/^http:/, 'ws:')}/api/v1/ws`, `tproxy-lane-v1.${sessionToken}.1`);
  ws.binaryType = 'arraybuffer';
  await new Promise((resolveOpen, reject) => {
    const timer = setTimeout(() => reject(new Error('WebSocket open timed out')), 10_000);
    ws.addEventListener('open', () => { clearTimeout(timer); resolveOpen(); }, { once: true });
    ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error(`WebSocket failed to open.\n${wrangler.output}`)); }, { once: true });
  });
  assert.equal(ws.protocol, `tproxy-lane-v1.${sessionToken}.1`);

  const downstream = nextDataFrame(ws);
  ws.send(frame(1, 1));
  ws.send(frame(2, 1, concatBytes(await makeClientHeader(), payload)));

  const socket = await Promise.race([accepted, delay(10_000).then(() => null)]);
  assert.ok(socket, `workerd cloudflare:sockets should connect to the local controlled endpoint.\n${wrangler.output}`);
  await waitUntil(() => tcpReceived.length >= 64 + payload.length, 'workerd TCP endpoint to receive outbound header and transformed payload');
  assert.equal(tcpReceived.length, 64 + payload.length);
  assert.notDeepEqual([...tcpReceived.subarray(64)], [...payload], 'the client payload must be transformed before reaching the TCP endpoint');

  const responseFrame = await downstream;
  assert.deepEqual([...responseFrame.payload], [...responsePayload], 'TCP response must return through a WebSocket DATA frame');
  console.log('PASS workerd TCP lanes: authenticated session, lane-authenticated WebSocket OPEN/DATA, cloudflare:sockets loopback connect, outbound obfuscation, transformed upload, downstream DATA response');
} catch (error) {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  if (wrangler?.output) console.error(`\nWrangler output:\n${wrangler.output}`);
  process.exitCode = 1;
} finally {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) ws.close(1000, 'workerd TCP test complete');
  if (acceptedSocket && !acceptedSocket.destroyed) acceptedSocket.destroy();
  await stopWrangler(wrangler).catch(() => {});
  await new Promise((resolveClose) => tcpServer.close(() => resolveClose()));
}
