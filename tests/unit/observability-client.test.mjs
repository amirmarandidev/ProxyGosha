import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { ProxyGoshaControlPlane } from '../../src/observability/control-plane.ts';
import { enforceDistributedRateLimit, getControlSettings, updateControlSettings, reserveGlobalSession, reportGlobalSessionUsage, renewGlobalSession, reportGlobalDcHealth, getGlobalDcHealth, getGlobalMetrics, manageSubscriptions, verifySubscription, recordGlobalMetrics } from '../../src/observability/client.ts';

globalThis.crypto ??= webcrypto;

class MemoryStorage {
  values = new Map();
  async get(key) { return this.values.get(key); }
  async put(key, value) { this.values.set(key, structuredClone(value)); }
  async delete(key) { return this.values.delete(key); }
  async list({ prefix = '' } = {}) { return new Map([...this.values.entries()].filter(([key]) => key.startsWith(prefix))); }
  async setAlarm(value) { this.alarmAt = Number(value); }
  async transaction(callback) { return callback(this); }
}

function makeNamespace(adminKey) {
  const objects = new Map();
  return {
    idFromName(name) { return name; },
    get(id) {
      if (!objects.has(id)) {
        const plane = new ProxyGoshaControlPlane({ storage: new MemoryStorage() }, { ADMIN_KEY: adminKey });
        objects.set(id, { fetch(input, init) { return plane.fetch(input instanceof Request ? input : new Request(input, init)); } });
      }
      return objects.get(id);
    },
  };
}

test('control-plane client loads and updates persisted settings', async () => {
  const namespace = makeNamespace('admin-secret-0123456789');
  const env = { ADMIN_KEY: 'admin-secret-0123456789', CONTROL_PLANE: namespace };
  const initial = await getControlSettings(env);
  assert.equal(initial.rateLimitPerMinute, 120);
  const response = await updateControlSettings(env, env.ADMIN_KEY, {
    rateLimitPerMinute: 7, adaptiveDcSelection: false, dcHealthCooldownMs: 25_000, dcConnectTimeoutMs: 3_000, maxDcConnectAttempts: 4, streamIdleTimeoutMs: 180_000, maxSessionBytes: 250_000_000,
    maxConcurrentSessionsPerIp: 0, dailyBytesPerIp: 0, monthlyBytesPerIp: 0, historyHours: 168, alertDcFailureThreshold: 5, alertWebhookUrl: "", requireSubscription: false,
  });
  assert.equal(response.status, 200);
  const updated = await getControlSettings(env);
  assert.deepEqual(updated, {
    rateLimitPerMinute: 7, adaptiveDcSelection: false, dcHealthCooldownMs: 25_000, dcConnectTimeoutMs: 3_000, maxDcConnectAttempts: 4, streamIdleTimeoutMs: 180_000, maxSessionBytes: 250_000_000,
    maxConcurrentSessionsPerIp: 0, dailyBytesPerIp: 0, monthlyBytesPerIp: 0, historyHours: 168, alertDcFailureThreshold: 5, alertWebhookUrl: "", requireSubscription: false,
  });
});

test('rate limiting uses sharded Durable Object IDs and blocks over-limit requests', async () => {
  const env = { CONTROL_PLANE: makeNamespace('admin-secret-0123456789') };
  const request = new Request('https://proxy.example/api/v1/session', { headers: { 'cf-connecting-ip': '203.0.113.5' } });
  const first = await enforceDistributedRateLimit(env, request, 1);
  const second = await enforceDistributedRateLimit(env, request, 1);
  assert.equal(first.allowed, true);
  assert.equal(second.allowed, false);
});


test('session traffic accounting uses a per-client shard and enforces quota decisions', async () => {
  const namespace = makeNamespace('admin-secret-0123456789');
  const env = { ADMIN_KEY: 'admin-secret-0123456789', CONTROL_PLANE: namespace };
  const updated = await updateControlSettings(env, env.ADMIN_KEY, { dailyBytesPerIp: 50, monthlyBytesPerIp: 100 });
  assert.equal(updated.status, 200);
  const reservation = await reserveGlobalSession(env, new Request('https://proxy.example/api/v1/ws', { headers: { 'cf-connecting-ip': '203.0.113.7' } }));
  assert.equal(reservation.allowed, true);
  assert.equal(await reportGlobalSessionUsage(env, reservation, 20, 20, true), true);
  assert.equal(await reportGlobalSessionUsage(env, reservation, 30, 30, true), false);
});

test('quota accounting fails closed when a configured control plane is unavailable', async () => {
  const env = { CONTROL_PLANE: { idFromName: () => 'broken', get: () => ({ fetch: async () => { throw new Error('unavailable'); } }) } };
  const reservation = { allowed: true, id: 'session-identifier-0001', key: '0123456789abcdef0123456789abcdef', shard: 'shard' };
  assert.equal(await reportGlobalSessionUsage(env, reservation, 1, 1, true), false);
  assert.equal(await reportGlobalSessionUsage(env, reservation, 1, 1, false), true);
});


test('Cloudflare Access identity separates per-user quotas behind a shared IP', async () => {
  const request = new Request('https://proxy.example/api/v1/ws', { headers: { 'cf-connecting-ip': '203.0.113.9' } });
  const first = await reserveGlobalSession({}, request, 'Alice@example.com');
  const second = await reserveGlobalSession({}, request, 'bob@example.com');
  const fallback = await reserveGlobalSession({}, request);
  assert.notEqual(first.key, second.key);
  assert.notEqual(first.key, fallback.key);
  assert.equal(first.key.length, 32);
});


test('configured control-plane outage does not silently disable policy or allow a session', async () => {
  const broken = { idFromName: () => 'broken', get: () => ({ fetch: async () => { throw new Error('offline'); } }) };
  const env = { CONTROL_PLANE: broken };
  await assert.rejects(() => getControlSettings(env), /control_plane_unavailable/);
  const reservation = await reserveGlobalSession(env, new Request('https://proxy.example/api/v1/ws', { headers: { 'cf-connecting-ip': '203.0.113.77' } }));
  assert.equal(reservation.allowed, false);
  assert.equal(reservation.reason, 'control_plane_unavailable');
});

test('subscription records are sharded, aggregated for administration, and revocable', async () => {
  const namespace = makeNamespace('admin-secret-0123456789');
  const env = { ADMIN_KEY: 'admin-secret-0123456789', CONTROL_PLANE: namespace };
  const token = 'a'.repeat(64);
  const tokenHash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token)))].map((b) => b.toString(16).padStart(2, '0')).join('');
  const created = await manageSubscriptions(env, env.ADMIN_KEY, 'POST', { tokenHash, expiresAt: Date.now() + 60_000, limits: { maxConcurrentSessionsPerIp: 1 } });
  assert.equal(created.status, 201);
  const verified = await verifySubscription(env, token);
  assert.equal(verified?.limits.maxConcurrentSessionsPerIp, 1);
  const listed = await manageSubscriptions(env, env.ADMIN_KEY, 'GET');
  const entries = await listed.json();
  assert.equal(entries.length, 1);
  const deleted = await manageSubscriptions(env, env.ADMIN_KEY, 'DELETE', { id: entries[0].id });
  assert.equal(deleted.status, 200);
  assert.equal(await verifySubscription(env, token), null);
});

test('metrics and DC health writes use sharded objects and aggregate across shards', async () => {
  const namespace = makeNamespace('admin-secret-0123456789');
  const env = { ADMIN_KEY: 'admin-secret-0123456789', CONTROL_PLANE: namespace };
  await Promise.all([
    recordGlobalMetrics(env, { sessions: 2, sessionsActive: 1 }, 'test_a'),
    recordGlobalMetrics(env, { sessions: 3, sessionsActive: 1 }, 'test_b'),
  ]);
  await reportGlobalDcHealth(env, '[2001:db8::1]:443', true, 17);
  const metrics = await getGlobalMetrics(env);
  assert.equal(metrics.sessions, 5);
  assert.equal(metrics.sessionsActive, 2);
  const health = await getGlobalDcHealth(env);
  assert.deepEqual(health.map((entry) => [entry.hostname, entry.port]), [['[2001:db8::1]', 443]]);
});

test('active session renewal fails closed when the lease shard is unavailable', async () => {
  const env = { CONTROL_PLANE: { idFromName: () => 'broken', get: () => ({ fetch: async () => { throw new Error('offline'); } }) } };
  const reservation = { allowed: true, id: 'session-identifier-0001', key: '0123456789abcdef0123456789abcdef', shard: 'shard' };
  assert.equal(await renewGlobalSession(env, reservation), false);
  assert.equal(await renewGlobalSession({}, reservation), true);
});

test('distributed rate limiting fails closed when a configured control-plane shard is unavailable', async () => {
  const env = { CONTROL_PLANE: { idFromName: () => 'offline', get: () => ({ fetch: async () => { throw new Error('offline'); } }) } };
  const result = await enforceDistributedRateLimit(env, new Request('https://proxy.example/api/v1/ws', { headers: { 'cf-connecting-ip': '203.0.113.8' } }), 100);
  assert.equal(result.allowed, false);
  assert.equal(result.remaining, 0);
});

test('cached quota policy is retained during a temporary settings outage', async () => {
  let online = true;
  const objects = new Map();
  const namespace = {
    idFromName(name) { return name; },
    get(id) {
      if (!objects.has(id)) {
        const plane = new ProxyGoshaControlPlane({ storage: new MemoryStorage() }, { ADMIN_KEY: 'admin-secret-0123456789' });
        objects.set(id, { fetch(input, init) { if (!online) throw new Error('offline'); return plane.fetch(input instanceof Request ? input : new Request(input, init)); } });
      }
      return objects.get(id);
    },
  };
  const env = { ADMIN_KEY: 'admin-secret-0123456789', CONTROL_PLANE: namespace };
  await updateControlSettings(env, env.ADMIN_KEY, { dailyBytesPerIp: 12345 });
  assert.equal((await getControlSettings(env)).dailyBytesPerIp, 12345);
  online = false;
  assert.equal((await getControlSettings(env)).dailyBytesPerIp, 12345);
  const reservation = await reserveGlobalSession(env, new Request('https://proxy.example/api/v1/ws', { headers: { 'cf-connecting-ip': '203.0.113.45' } }));
  assert.equal(reservation.allowed, false);
});

test('sharded active-session metric deltas aggregate without per-shard underflow loss', async () => {
  const namespace = makeNamespace('admin-secret-0123456789');
  const env = { CONTROL_PLANE: namespace };
  await recordGlobalMetrics(env, { sessionsActive: 1 }, 'session_open');
  await recordGlobalMetrics(env, { sessionsActive: -1 }, 'session_close');
  const metrics = await getGlobalMetrics(env);
  assert.equal(metrics.sessionsActive, 0);
});
