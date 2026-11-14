import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import test from 'node:test';
import { resolveConfig } from '../../src/config/resolve.ts';
import { buildRuntimeCrypto, unsealBuildIdentity } from '../../src/crypto/derive.ts';
import { issueToken } from '../../src/crypto/token.ts';
import { BUILD_SEAL, createWorker } from '../../src/worker.ts';

globalThis.crypto ??= webcrypto;

const NOW = 1_800_000_000;
const SECRET = '0123456789abcdef0123456789abcdef';
const HANDSHAKE = Uint8Array.of(0x10, 0, 0, 0, 0, 0, 0, 1, 1);

class MockWebSocket {
  readyState = 1;
  binaryType = '';
  accepted = false;
  listeners = new Map();
  sent = [];
  closed = [];
  accept() { this.accepted = true; }
  send(data) { this.sent.push(data); }
  close(code, reason) { this.closed.push({ code, reason }); this.readyState = 3; }
  addEventListener(type, listener) {
    const entries = this.listeners.get(type) ?? [];
    entries.push(listener);
    this.listeners.set(type, entries);
  }
  emit(type, event = {}) {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

async function makeTokens(env = { SECRET }) {
  const resolved = resolveConfig(env);
  const seal = await unsealBuildIdentity(BUILD_SEAL);
  const runtimeCrypto = await buildRuntimeCrypto(resolved, seal.bytes);
  assert.ok(runtimeCrypto);
  return {
    bootstrap: await issueToken(runtimeCrypto.tokenKey, 1, 3600, 0, NOW),
    session: await issueToken(runtimeCrypto.tokenKey, 2, 3600, 0, NOW),
  };
}

function makePlatform() {
  const server = new MockWebSocket();
  let pairCount = 0;
  let upgradeProtocol = '';
  const platform = {
    connect() { throw new Error('TCP connect is not expected in this route test'); },
    createWebSocketPair() { pairCount++; return [{ client: true }, server]; },
    createUpgradeResponse(client, protocol) {
      assert.deepEqual(client, { client: true });
      upgradeProtocol = protocol;
      return new Response(null, { status: 200, headers: { 'Sec-WebSocket-Protocol': protocol } });
    },
    nowSeconds: () => NOW,
  };
  return { platform, server, pairCount: () => pairCount, upgradeProtocol: () => upgradeProtocol };
}

test('Worker entry returns 404 when no usable secret is configured', async () => {
  const { platform } = makePlatform();
  const worker = createWorker(platform);
  const response = await worker.fetch(new Request('https://proxy.example/api/v1/session'), {});
  assert.equal(response.status, 404);
});

test('Worker entry routes the session handshake and issues a session token', async () => {
  const env = { SECRET };
  const tokens = await makeTokens(env);
  const { platform } = makePlatform();
  const worker = createWorker(platform);
  const request = new Request('https://proxy.example/api/v1/session', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${tokens.bootstrap}`,
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(HANDSHAKE.length),
    },
    body: HANDSHAKE,
  });
  const response = await worker.fetch(request, env);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('X-Carrier-Mode'), 'websocket-lanes');
  assert.equal(response.headers.get('X-Session-Token')?.length, 64);
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), Uint8Array.of(0x11, 0, 0, 0, 0, 0, 0, 0));
});

test('Worker entry authenticates and upgrades a WebSocket through the transport adapter', async () => {
  const env = { SECRET };
  const tokens = await makeTokens(env);
  const { platform, server, pairCount, upgradeProtocol } = makePlatform();
  const worker = createWorker(platform);
  const protocol = `tproxy-v1.${tokens.session}`;
  const response = await worker.fetch(new Request('https://proxy.example/api/v1/ws', {
    headers: { Upgrade: 'websocket', 'Sec-WebSocket-Protocol': protocol },
  }), env);
  assert.equal(response.status, 200, 'test platform substitutes a normal Response for Cloudflare status 101');
  assert.equal(pairCount(), 1);
  assert.equal(upgradeProtocol(), protocol);
  assert.equal(server.accepted, true);
  assert.equal(server.binaryType, 'arraybuffer');
  server.emit('close');
});

test('Worker entry enforces configured host allow-list before serving API routes', async () => {
  const { platform } = makePlatform();
  const worker = createWorker(platform);
  const response = await worker.fetch(new Request('https://other.example/api/v1/session', {
    headers: { Host: 'other.example' },
  }), { SECRET, HOSTNAME: 'allowed.example' });
  assert.equal(response.status, 200);
  assert.match(await response.text(), /LUXVEIL/);
});

test('unconfigured root serves the bilingual setup page', async () => {
  const { platform } = makePlatform();
  const worker = createWorker(platform);
  const response = await worker.fetch(new Request('https://proxy.example/'), {});
  const html = await response.text();
  assert.equal(response.status, 200);
  assert.match(html, /Proxy setup/);
  assert.match(html, /ADMIN_KEY/);
  assert.match(html, /فارسی/);
});

test('configured worker serves authentic static camouflage routes', async () => {
  const { platform } = makePlatform();
  const worker = createWorker(platform);
  const env = { SECRET };
  const robots = await worker.fetch(new Request('https://proxy.example/robots.txt'), env);
  assert.equal(robots.status, 200);
  assert.match(await robots.text(), /Disallow: \/api\//);
  const favicon = await worker.fetch(new Request('https://proxy.example/favicon.ico'), env);
  assert.equal(favicon.headers.get('Content-Type'), 'image/svg+xml');
  assert.match(await favicon.text(), /<svg/);
  const health = await worker.fetch(new Request('https://proxy.example/health'), env);
  assert.equal(health.status, 200);
  assert.equal((await health.json()).store, 'LUXVEIL');
});

test('configured unknown paths return the embedded LUXVEIL decoy storefront', async () => {
  const { platform } = makePlatform();
  const worker = createWorker(platform);
  const response = await worker.fetch(new Request('https://proxy.example/unrecognized'), { SECRET });
  assert.equal(response.status, 200);
  assert.match(await response.text(), /LUXVEIL/);
});

test('admin panel and status routes are authenticated by the configured path key', async () => {
  const { platform } = makePlatform();
  const worker = createWorker(platform);
  const env = { SECRET, ADMIN_KEY: '0123456789abcdef0123456789abcdef' };
  const panel = await worker.fetch(new Request(`https://proxy.example/${env.ADMIN_KEY}`), env);
  assert.equal(panel.status, 200);
  assert.match(await panel.text(), /Proxy panel/);
  const status = await worker.fetch(new Request(`https://proxy.example/${env.ADMIN_KEY}/status`), env);
  assert.equal(status.status, 200);
  const html = await status.text();
  assert.match(html, /Live statistics/);
  assert.match(html, /Recent events/);
});

test('browser bridge capability serves the original embedded bridge client', async () => {
  const env = { SECRET };
  const resolved = resolveConfig(env);
  const seal = await unsealBuildIdentity(BUILD_SEAL);
  const runtimeCrypto = await buildRuntimeCrypto(resolved, seal.bytes);
  assert.ok(runtimeCrypto);
  const signingKey = await webcrypto.subtle.importKey('raw', runtimeCrypto.base, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const capability = new Uint8Array(await webcrypto.subtle.sign(
    'HMAC', signingKey, new TextEncoder().encode('tdesktop-web-proxy-bridge-v1\nproxy.example'),
  ));
  const encoded = Buffer.from(capability).toString('base64url');
  const { platform } = makePlatform();
  const worker = createWorker(platform);
  const response = await worker.fetch(new Request(`https://proxy.example/?bridge=${encoded}`), env);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('Content-Security-Policy'), /script-src 'nonce-/);
  const html = await response.text();
  assert.match(html, /const relayBase=location.origin/);
  assert.doesNotMatch(html, /__BOOTSTRAP__|__NONCE__|__SESSION_PATH__/);
});

test('legacy secret generator remains gated by ADMIN_KEY and GENERATOR_ENABLED', async () => {
  const { platform } = makePlatform();
  const worker = createWorker(platform);
  const env = { SECRET, ADMIN_KEY: '0123456789abcdef0123456789abcdef', GENERATOR_ENABLED: 'true' };
  const denied = await worker.fetch(new Request('https://proxy.example/?create-secret=example.org'), env);
  assert.equal(denied.status, 200);
  assert.match(await denied.text(), /LUXVEIL/);
  const allowed = await worker.fetch(new Request(`https://proxy.example/?create-secret=example.org&key=${env.ADMIN_KEY}`), env);
  assert.equal(allowed.status, 200);
  const body = await allowed.text();
  assert.match(body, /DOMAIN-DERIVED SECRET/);
  assert.match(body, /tg:\/\/webproxy/);
});

test('admin DC probe uses injected sockets and reports per-DC results', async () => {
  const env = { SECRET, ADMIN_KEY: '0123456789abcdef0123456789abcdef' };
  const sockets = [];
  const platform = {
    connect(address) {
      sockets.push(address);
      return {
        opened: Promise.resolve(),
        closed: Promise.resolve(),
        close: async () => {},
      };
    },
    createWebSocketPair() { throw new Error('not used'); },
    createUpgradeResponse() { throw new Error('not used'); },
    nowSeconds: () => NOW,
  };
  const worker = createWorker(platform);
  const response = await worker.fetch(new Request(`https://proxy.example/${env.ADMIN_KEY}/status?probe=1`), env);
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /DC reachability probe/);
  assert.match(html, /149\.154\./);
  assert.equal(sockets.length, 6);
});

test('admin runtime settings API reads and updates Durable Object settings', async () => {
  const { ProxyGoshaControlPlane } = await import('../../src/observability/control-plane.ts');
  const values = new Map();
  const storage = {
    async get(key) { return values.get(key); },
    async put(key, value) { values.set(key, structuredClone(value)); },
    async delete(key) { return values.delete(key); },
    async list({ prefix = '' } = {}) { return new Map([...values.entries()].filter(([key]) => key.startsWith(prefix))); },
    async setAlarm(value) { this.alarmAt = Number(value); },
    async transaction(callback) { return callback(this); },
  };
  const plane = new ProxyGoshaControlPlane({ storage }, { ADMIN_KEY: '0123456789abcdef0123456789abcdef' });
  const namespace = {
    idFromName(name) { return name; },
    get() { return { fetch(input, init) { return plane.fetch(input instanceof Request ? input : new Request(input, init)); } }; },
  };
  const env = { SECRET, ADMIN_KEY: '0123456789abcdef0123456789abcdef', CONTROL_PLANE: namespace };
  const { platform } = makePlatform();
  const worker = createWorker(platform);
  const endpoint = `https://proxy.example/${env.ADMIN_KEY}/api/config`;
  const before = await worker.fetch(new Request(endpoint), env);
  assert.equal(before.status, 200);
  assert.equal((await before.json()).rateLimitPerMinute, 120);
  const updated = await worker.fetch(new Request(endpoint, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ rateLimitPerMinute: 45, adaptiveDcSelection: false, dcHealthCooldownMs: 45_000, streamIdleTimeoutMs: 240_000, maxSessionBytes: 500_000_000, maxSessionBytes: 500_000_000 }),
  }), env);
  assert.equal(updated.status, 200);
  assert.deepEqual(await updated.json(), {
    rateLimitPerMinute: 45, adaptiveDcSelection: false, dcHealthCooldownMs: 45_000, dcConnectTimeoutMs: 3_000, maxDcConnectAttempts: 4, streamIdleTimeoutMs: 240_000, maxSessionBytes: 500_000_000,
    maxConcurrentSessionsPerIp: 0, dailyBytesPerIp: 0, monthlyBytesPerIp: 0, historyHours: 168, alertDcFailureThreshold: 5, requireSubscription: false,
  });
});

test('scheduled DC health probes every configured IP and port with bounded batches', async () => {
  const env = { SECRET };
  const resolved = resolveConfig(env);
  const expected = new Set();
  for (const ips of Object.values(resolved.dc)) {
    for (const ip of ips) {
      for (const port of resolved.dcPorts) expected.add(`${ip}:${port}`);
    }
  }
  const seen = [];
  const platform = {
    connect(address) {
      seen.push(`${address.hostname}:${address.port}`);
      return { opened: Promise.resolve(), closed: Promise.resolve(), close: async () => {} };
    },
    createWebSocketPair() { throw new Error('not used'); },
    createUpgradeResponse() { throw new Error('not used'); },
    nowSeconds: () => NOW,
  };
  const worker = createWorker(platform);
  await worker.scheduled({ scheduledTime: NOW * 1000, cron: '*/5 * * * *' }, env);
  assert.deepEqual(new Set(seen), expected);
  assert.equal(seen.length, expected.size, 'duplicate endpoint probes must be removed');
});

test('subscription admin API issues one-time credentials and required subscriptions gate session creation', async () => {
  const { ProxyGoshaControlPlane } = await import('../../src/observability/control-plane.ts');
  const values = new Map();
  const storage = {
    async get(key) { return values.get(key); },
    async put(key, value) { values.set(key, structuredClone(value)); },
    async delete(key) { return values.delete(key); },
    async list({ prefix = '' } = {}) { return new Map([...values.entries()].filter(([key]) => key.startsWith(prefix))); },
    async setAlarm(value) { this.alarmAt = Number(value); },
    async transaction(callback) { return callback(this); },
  };
  const adminKey = '0123456789abcdef0123456789abcdef';
  const plane = new ProxyGoshaControlPlane({ storage }, { ADMIN_KEY: adminKey });
  const namespace = { idFromName(name) { return name; }, get() { return { fetch(input, init) { return plane.fetch(input instanceof Request ? input : new Request(input, init)); } }; } };
  const env = { SECRET, ADMIN_KEY: adminKey, CONTROL_PLANE: namespace };
  const platformFixture = makePlatform();
  const worker = createWorker(platformFixture.platform);
  const created = await worker.fetch(new Request(`https://proxy.example/${adminKey}/api/subscriptions`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ expiresAt: Date.now() + 86_400_000, limits: { dailyBytesPerIp: 100_000 } }),
  }), env);
  assert.equal(created.status, 201);
  const credential = await created.json();
  assert.equal(typeof credential.token, 'string');
  assert.equal(credential.token.length, 64);
  assert.equal(JSON.stringify([...values.keys()]).includes(credential.token), false);

  const settings = await worker.fetch(new Request(`https://proxy.example/${adminKey}/api/config`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ requireSubscription: true }),
  }), env);
  assert.equal(settings.status, 200);
  const tokens = await makeTokens(env);
  const makeSessionRequest = (subscription) => new Request('https://proxy.example/api/v1/session', {
    method: 'POST', headers: {
      Authorization: `Bearer ${tokens.bootstrap}`,
      'Content-Type': 'application/octet-stream',
      ...(subscription ? { 'X-Proxy-Gosha-Subscription': subscription } : {}),
    }, body: HANDSHAKE,
  });
  assert.equal((await worker.fetch(makeSessionRequest(), env)).status, 403);
  assert.equal((await worker.fetch(makeSessionRequest('invalid-subscription-token-xxxxxxxx'), env)).status, 403);
  const sessionResponse = await worker.fetch(makeSessionRequest(credential.token), env);
  assert.equal(sessionResponse.status, 200);
  const sessionToken = sessionResponse.headers.get('X-Session-Token');
  const wsRequest = (subscription) => new Request('https://proxy.example/api/v1/ws', {
    headers: { Upgrade: 'websocket', 'Sec-WebSocket-Protocol': `tproxy-v1.${sessionToken}`, 'X-Proxy-Gosha-Subscription': subscription },
  });
  assert.equal((await worker.fetch(wsRequest(credential.token), env)).status, 200);

  const second = await worker.fetch(new Request(`https://proxy.example/${adminKey}/api/subscriptions`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ expiresAt: Date.now() + 86_400_000 }),
  }), env);
  const secondCredential = await second.json();
  assert.equal((await worker.fetch(wsRequest(secondCredential.token), env)).status, 404);
  platformFixture.server.emit('close');
});
